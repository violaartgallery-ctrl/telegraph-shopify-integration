import { sendDocument, sendMessage } from '../telegram/telegramApi.js';
import type { PreviewCursor } from './productionJobStore.js';
import {
  extractOrderNumbers,
  fetchProductionBatch,
  productionSourceFingerprint,
  type ProductionAgentResponse,
  type ProductionEntry,
} from './productionAgentClient.js';
import { PermanentProductionError, SoftDeadlineError } from './productionPipelineErrors.js';

type Checkpoint = () => Promise<void>;

function assertTime(deadline: number, progress: string): void {
  if (Date.now() >= deadline) throw new SoftDeadlineError(progress);
}

function safeBatchName(batchId: string): string {
  return batchId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function artifactStateKey(recipient: string, artifact: string): string {
  return `${recipient}|${artifact}`;
}

async function sendArtifactToAll(options: {
  cursor: PreviewCursor;
  artifactKey: string;
  buffer: Buffer;
  filename: string;
  caption: string;
  deadline: number;
  checkpoint: Checkpoint;
}): Promise<void> {
  const sent = new Set(options.cursor.sentArtifactKeys);
  for (const recipient of options.cursor.recipientChatIds) {
    const stateKey = artifactStateKey(recipient, options.artifactKey);
    if (sent.has(stateKey)) continue;
    assertTime(options.deadline, `باقي إرسال ${options.filename}`);
    const ok = await sendDocument(recipient, options.buffer, options.filename, options.caption);
    if (!ok) throw new Error(`Telegram failed to confirm ${options.filename} for recipient ${recipient}`);
    options.cursor.sentArtifactKeys.push(stateKey);
    sent.add(stateKey);
    await options.checkpoint();
  }
}

async function sendTextToAll(options: {
  cursor: PreviewCursor;
  artifactKey: string;
  text: string;
  deadline: number;
  checkpoint: Checkpoint;
}): Promise<void> {
  const sent = new Set(options.cursor.sentArtifactKeys);
  for (const recipient of options.cursor.recipientChatIds) {
    const stateKey = artifactStateKey(recipient, options.artifactKey);
    if (sent.has(stateKey)) continue;
    assertTime(options.deadline, 'باقي إرسال ملخص التجميعة');
    const ok = await sendMessage(recipient, options.text);
    if (!ok) throw new Error(`Telegram failed to confirm preview summary for recipient ${recipient}`);
    options.cursor.sentArtifactKeys.push(stateKey);
    sent.add(stateKey);
    await options.checkpoint();
  }
}

function isBoxEntry(entry: ProductionEntry): boolean {
  const product = String(entry.display_product ?? '').toLowerCase();
  return product.includes('box') || product.includes('بوكس');
}

function uniquePhotos(data: ProductionAgentResponse): Array<{
  url: string;
  orderName: string;
  product: string;
}> {
  const seen = new Set<string>();
  const result: Array<{ url: string; orderName: string; product: string }> = [];
  for (const entry of data.productionEntries) {
    const product = `${entry.display_product}${entry.display_color ? ` ${entry.display_color}` : ''}`.trim();
    for (const photo of entry.photo_attachments ?? []) {
      if (!photo.attachment_url || seen.has(photo.attachment_url)) continue;
      seen.add(photo.attachment_url);
      result.push({
        url: photo.attachment_url,
        orderName: photo.order_name,
        product,
      });
    }
  }
  return result;
}

async function fetchBinary(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`Photo HTTP ${response.status}: ${url.slice(0, 160)}`);
  return Buffer.from(await response.arrayBuffer());
}

function validateSource(cursor: PreviewCursor, data: ProductionAgentResponse): void {
  const currentFingerprint = productionSourceFingerprint(data);
  if (cursor.sourceFingerprint && cursor.sourceFingerprint !== currentFingerprint) {
    throw new PermanentProductionError(
      'بيانات الأوردرات اتغيرت أثناء إرسال نفس التجميعة؛ تم إيقافها للمراجعة حتى لا تختلط نسختان من الملفات.'
    );
  }
  cursor.sourceFingerprint = currentFingerprint;
}

export async function sendCompleteProductionPreview(options: {
  chatId: number;
  cursor: PreviewCursor;
  deadline: number;
  checkpoint: Checkpoint;
}): Promise<void> {
  const { chatId, cursor, deadline, checkpoint } = options;
  assertTime(deadline, 'لم يبدأ جلب التجميعة بعد');

  await sendMessage(
    chatId,
    cursor.orderNumbers.length
      ? `📦 بكمل التجميعة ${cursor.batchId} تلقائيًا من مكان الوقوف...`
      : `📦 جاري تثبيت أوردرات التجميعة ${cursor.batchId}...`
  );

  const data = await fetchProductionBatch({
    orderId: cursor.orderId,
    orderNumbers: cursor.orderNumbers.length ? cursor.orderNumbers : undefined,
  });

  if (!cursor.orderNumbers.length) {
    cursor.orderNumbers = extractOrderNumbers(data);
    // The explicit single-order path must never silently return a different order.
    if (cursor.orderId && !cursor.orderNumbers.includes(`#${cursor.orderId}`)) {
      throw new PermanentProductionError(`Ayman Agent لم يرجع الأوردر المطلوب #${cursor.orderId}`);
    }
  }
  validateSource(cursor, data);
  await checkpoint();

  const count = cursor.orderNumbers.length;
  const batchName = safeBatchName(cursor.batchId);
  const date = new Date().toISOString().slice(0, 10);
  await sendMessage(chatId, `✅ تم تثبيت ${count} أوردر في Batch واحد. جاري إرسال كل الملفات والصور...`);

  // 1) Main production Word document.
  const word = Buffer.from(data.wordBase64, 'base64');
  if (!word.length) throw new PermanentProductionError('ملف Word من Ayman Agent فارغ');
  await sendArtifactToAll({
    cursor,
    artifactKey: `word:${cursor.sourceFingerprint}`,
    buffer: word,
    filename: `production_${date}_${batchName}_${count}_orders.docx`,
    caption: `قائمة الإنتاج الكاملة — ${count} أوردر ✅`,
    deadline,
    checkpoint,
  });

  // 2) Laser and box-grid files. Every file is checkpointed independently.
  assertTime(deadline, 'باقي ملفات الليزر والبوكسات والصور');
  const { buildAiBuffers, buildBoxGridBuffers } = await import('./aiWriter.js');
  const linearEntries = data.productionEntries.filter((entry) => !isBoxEntry(entry));
  const boxEntries = data.productionEntries.filter(isBoxEntry);
  const laserFiles = linearEntries.length
    ? await buildAiBuffers(linearEntries as never, { maxBytes: 1_500_000 })
    : [];
  const boxFiles = boxEntries.length ? await buildBoxGridBuffers(boxEntries as never) : [];

  for (let index = 0; index < laserFiles.length; index += 1) {
    const buffer = laserFiles[index]!;
    await sendArtifactToAll({
      cursor,
      artifactKey: `laser:${index + 1}:${cursor.sourceFingerprint}`,
      buffer,
      filename: `laser_${date}_${batchName}_${index + 1}.ai`,
      caption: `ملف الليزر ${index + 1}/${laserFiles.length} 🔪`,
      deadline,
      checkpoint,
    });
  }
  for (let index = 0; index < boxFiles.length; index += 1) {
    const buffer = boxFiles[index]!;
    await sendArtifactToAll({
      cursor,
      artifactKey: `box:${index + 1}:${cursor.sourceFingerprint}`,
      buffer,
      filename: `box_grid_${date}_${batchName}_${index + 1}.ai`,
      caption: `شبكة البوكسات ${index + 1}/${boxFiles.length} 📦`,
      deadline,
      checkpoint,
    });
  }

  // 3) Print-ready photo sheet. Any failed source image blocks completion.
  assertTime(deadline, 'باقي ورق طباعة الصور والصور المنفردة');
  const { buildPrintSheetPdf, kindForProduct } = await import('./printSheet.js');
  const printSources: Array<{ url: string; kind: 'wallet' | 'keychain' }> = [];
  const seenPrint = new Set<string>();
  for (const entry of data.productionEntries) {
    const kind = kindForProduct(entry.display_product);
    for (const photo of entry.photo_attachments ?? []) {
      if ((photo.position_label ?? '').trim()) continue;
      if (!photo.attachment_url || seenPrint.has(photo.attachment_url)) continue;
      seenPrint.add(photo.attachment_url);
      printSources.push({ url: photo.attachment_url, kind });
    }
  }
  if (printSources.length) {
    const photos: Array<{ buffer: Buffer; kind: 'wallet' | 'keychain' }> = [];
    for (const source of printSources) {
      assertTime(deadline, 'باقي تحميل صور ورق الطباعة');
      photos.push({ buffer: await fetchBinary(source.url), kind: source.kind });
    }
    const pdfBytes = await buildPrintSheetPdf(photos);
    if (!pdfBytes) throw new Error('Print-sheet builder returned no PDF');
    const pdf = Buffer.from(pdfBytes);
    await sendArtifactToAll({
      cursor,
      artifactKey: `print-sheet:${cursor.sourceFingerprint}`,
      buffer: pdf,
      filename: `print_sheets_${date}_${batchName}.pdf`,
      caption: 'ورق طباعة الصور 🖨️',
      deadline,
      checkpoint,
    });
  }

  // 4) Every source photo, with progress keyed by recipient + URL.
  const photos = uniquePhotos(data);
  const sentPhotoKeys = new Set(cursor.sentPhotoKeys);
  for (let index = 0; index < photos.length; index += 1) {
    const photo = photos[index]!;
    const pendingRecipients = cursor.recipientChatIds.filter(
      (recipient) => !sentPhotoKeys.has(artifactStateKey(recipient, photo.url))
    );
    if (!pendingRecipients.length) continue;
    assertTime(deadline, `اتبعت ${index} صورة — باقي ${photos.length - index}`);
    const buffer = await fetchBinary(photo.url);
    let extension = 'jpg';
    try {
      const raw = new URL(photo.url).pathname.split('.').pop() ?? 'jpg';
      if (/^[a-z0-9]{2,5}$/i.test(raw)) extension = raw;
    } catch {
      // Keep jpg for unusual but fetchable attachment URLs.
    }
    const order = photo.orderName.replace(/[^a-zA-Z0-9_-]/g, '_');
    for (const recipient of pendingRecipients) {
      const ok = await sendDocument(
        recipient,
        buffer,
        `${order}_photo_${index + 1}.${extension}`,
        `${photo.orderName} — ${photo.product}`
      );
      if (!ok) throw new Error(`Telegram failed to confirm photo ${index + 1} for recipient ${recipient}`);
      const stateKey = artifactStateKey(recipient, photo.url);
      cursor.sentPhotoKeys.push(stateKey);
      sentPhotoKeys.add(stateKey);
      await checkpoint();
    }
  }

  // 5) Per-order summary document.
  if (count && data.ordersDetail.length !== count) {
    throw new PermanentProductionError(
      `ملف ملخص الأوردرات ناقص: ${data.ordersDetail.length} من ${count}`
    );
  }
  if (data.ordersDetail.length) {
    assertTime(deadline, 'باقي ملف التجميعة بالأوردر والملخص النهائي');
    const { buildOrdersSummaryBuffer } = await import('./orderSummaryWriter.js');
    const ordersDocument = await buildOrdersSummaryBuffer(data.ordersDetail as never);
    await sendArtifactToAll({
      cursor,
      artifactKey: `orders-summary:${cursor.sourceFingerprint}`,
      buffer: ordersDocument,
      filename: `orders_${date}_${batchName}_${count}.docx`,
      caption: `التجميعة بالأوردر — ${count} أوردر 📋`,
      deadline,
      checkpoint,
    });
  }

  // 6) Plain UTF-8 summary. No Markdown, so product punctuation cannot break it.
  const summaryLines = [
    `📋 ملخص التجميعة ${cursor.batchId}`,
    `الأوردرات: ${count}`,
    `منتجات الإنتاج: ${data.productionEntries.length}`,
    `ملفات الليزر: ${laserFiles.length}`,
    `شبكات البوكسات: ${boxFiles.length}`,
    `الصور: ${photos.length}`,
    `التحذيرات: ${data.warnings.length}`,
  ];
  for (const warning of data.warnings.slice(0, 5)) {
    summaryLines.push(`⚠️ ${String(warning).slice(0, 180)}`);
  }
  await sendTextToAll({
    cursor,
    artifactKey: `summary:${productionSourceFingerprint(data)}`,
    text: summaryLines.join('\n'),
    deadline,
    checkpoint,
  });
}
