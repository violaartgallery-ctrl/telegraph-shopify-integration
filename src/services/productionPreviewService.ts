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

type Checkpoint = (progressMade?: boolean) => Promise<void>;

const DEFAULT_MAX_PHOTOS_PER_INVOCATION = 6;

interface ProductionSourceSnapshotStore {
  load: () => Promise<ProductionAgentResponse | null>;
  save: (data: ProductionAgentResponse) => Promise<void>;
}

function assertTime(deadline: number, progress: string): void {
  if (Date.now() >= deadline) throw new SoftDeadlineError(progress);
}

function safeBatchName(batchId: string): string {
  return batchId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function artifactStateKey(recipient: string, artifact: string): string {
  return `${recipient}|${artifact}`;
}

function artifactConfirmedForAll(cursor: PreviewCursor, artifactKey: string): boolean {
  const sent = new Set(cursor.sentArtifactKeys);
  return cursor.recipientChatIds.every((recipient) => sent.has(artifactStateKey(recipient, artifactKey)));
}

function indexedArtifactsConfirmedForAll(
  cursor: PreviewCursor,
  prefix: string,
  count: number
): boolean {
  for (let index = 1; index <= count; index += 1) {
    if (!artifactConfirmedForAll(cursor, `${prefix}:${index}:${cursor.sourceFingerprint}`)) return false;
  }
  return true;
}

function photoLimit(explicit?: number): number {
  const parsed = Number(explicit ?? process.env.PRODUCTION_PHOTOS_PER_INVOCATION);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_PHOTOS_PER_INVOCATION;
  return Math.min(50, Math.max(1, Math.floor(parsed)));
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchBinary(url: string, deadline: number): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assertTime(deadline, 'باقي تحميل صورة');
    const remaining = deadline - Date.now();
    const timeoutMs = Math.min(45_000, Math.max(1_000, remaining - 2_000));
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      const error = new Error(`Photo HTTP ${response.status}: ${url.slice(0, 160)}`);
      if (response.status !== 429 && response.status < 500) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (attempt === 2) throw error;
    }
    if (attempt < 2) {
      assertTime(deadline, 'إعادة محاولة تحميل صورة');
      await sleep(500 * (2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
  sourceSnapshot?: ProductionSourceSnapshotStore;
  maxPhotosPerInvocation?: number;
}): Promise<void> {
  const { chatId, cursor, deadline, checkpoint, sourceSnapshot } = options;
  assertTime(deadline, 'لم يبدأ جلب التجميعة بعد');

  const hadOrderNumbers = cursor.orderNumbers.length > 0;
  const hadFingerprint = Boolean(cursor.sourceFingerprint);
  if (!hadOrderNumbers) {
    await sendMessage(chatId, `📦 جاري تثبيت أوردرات التجميعة ${cursor.batchId}...`);
  }

  const savedSnapshot = await sourceSnapshot?.load() ?? null;
  let data = savedSnapshot;
  if (!data) {
    data = await fetchProductionBatch({
      orderId: cursor.orderId,
      orderNumbers: cursor.orderNumbers.length ? cursor.orderNumbers : undefined,
    });
  }

  if (!cursor.orderNumbers.length) {
    cursor.orderNumbers = extractOrderNumbers(data);
    // The explicit single-order path must never silently return a different order.
    if (cursor.orderId && !cursor.orderNumbers.includes(`#${cursor.orderId}`)) {
      throw new PermanentProductionError(`Ayman Agent لم يرجع الأوردر المطلوب #${cursor.orderId}`);
    }
  }
  validateSource(cursor, data);
  if (sourceSnapshot && !savedSnapshot) {
    // Capture the complete source before the first externally-visible send.
    // Every continuation then regenerates artifacts from these exact bytes.
    await sourceSnapshot.save(data);
  }
  // Loading a previously-saved snapshot is not forward progress and must not
  // erase a consecutive retry count. Capturing the source for the first time is.
  await checkpoint(!hadOrderNumbers || !hadFingerprint);

  const count = cursor.orderNumbers.length;
  const photos = uniquePhotos(data);
  const batchName = safeBatchName(cursor.batchId);
  const date = new Date().toISOString().slice(0, 10);
  if (!hadOrderNumbers) {
    await sendMessage(chatId, `✅ تم تثبيت ${count} أوردر في Batch واحد. جاري إرسال كل الملفات والصور...`);
  }

  // 1) Main production Word document.
  const wordArtifactKey = `word:${cursor.sourceFingerprint}`;
  if (!artifactConfirmedForAll(cursor, wordArtifactKey)) {
    const word = Buffer.from(data.wordBase64, 'base64');
    if (!word.length) throw new PermanentProductionError('ملف Word من Ayman Agent فارغ');
    await sendArtifactToAll({
      cursor,
      artifactKey: wordArtifactKey,
      buffer: word,
      filename: `production_${date}_${batchName}_${count}_orders.docx`,
      caption: `قائمة الإنتاج الكاملة — ${count} أوردر ✅`,
      deadline,
      checkpoint,
    });
  }

  // 2) Laser and box-grid files. Every file is checkpointed independently.
  assertTime(deadline, 'باقي ملفات الليزر والبوكسات والصور');
  const savedManifest = cursor.artifactManifest;
  const laserAlreadyComplete = Boolean(
    savedManifest && indexedArtifactsConfirmedForAll(cursor, 'laser', savedManifest.laserFileCount)
  );
  const boxAlreadyComplete = Boolean(
    savedManifest && indexedArtifactsConfirmedForAll(cursor, 'box', savedManifest.boxFileCount)
  );
  let laserFiles: Buffer[] | null = null;
  let boxFiles: Buffer[] | null = null;

  if (!laserAlreadyComplete || !boxAlreadyComplete) {
    const { buildAiBuffers, buildBoxGridBuffers } = await import('./aiWriter.js');
    if (!laserAlreadyComplete) {
      const linearEntries = data.productionEntries.filter((entry) => !isBoxEntry(entry));
      laserFiles = linearEntries.length
        ? await buildAiBuffers(linearEntries as never, { maxBytes: 1_500_000 })
        : [];
    }
    if (!boxAlreadyComplete) {
      const boxEntries = data.productionEntries.filter(isBoxEntry);
      boxFiles = boxEntries.length ? await buildBoxGridBuffers(boxEntries as never) : [];
    }
  }

  const laserFileCount = laserFiles?.length ?? savedManifest?.laserFileCount ?? 0;
  const boxFileCount = boxFiles?.length ?? savedManifest?.boxFileCount ?? 0;
  if (
    !savedManifest ||
    savedManifest.laserFileCount !== laserFileCount ||
    savedManifest.boxFileCount !== boxFileCount ||
    savedManifest.uniquePhotoCount !== photos.length
  ) {
    cursor.artifactManifest = {
      laserFileCount,
      boxFileCount,
      uniquePhotoCount: photos.length,
    };
    // This metadata avoids future regeneration, but it is not an externally
    // visible success and therefore must not reset consecutive failures.
    await checkpoint(false);
  }

  if (laserFiles) {
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
  }
  if (boxFiles) {
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
  }

  // 3) Print-ready photo sheet. Any failed source image blocks completion.
  assertTime(deadline, 'باقي ورق طباعة الصور والصور المنفردة');
  const printSheetArtifactKey = `print-sheet:${cursor.sourceFingerprint}`;
  if (!artifactConfirmedForAll(cursor, printSheetArtifactKey)) {
    const { buildPrintSheetPdf, kindForProduct, printPhotoSourceUrl } = await import('./printSheet.js');
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
      const printPhotos: Array<{ buffer: Buffer; kind: 'wallet' | 'keychain' }> = [];
      for (const source of printSources) {
        assertTime(deadline, 'باقي تحميل صور ورق الطباعة');
        printPhotos.push({
          buffer: await fetchBinary(printPhotoSourceUrl(source.url), deadline),
          kind: source.kind,
        });
      }
      const pdfBytes = await buildPrintSheetPdf(printPhotos);
      if (!pdfBytes) throw new Error('Print-sheet builder returned no PDF');
      const pdf = Buffer.from(pdfBytes);
      await sendArtifactToAll({
        cursor,
        artifactKey: printSheetArtifactKey,
        buffer: pdf,
        filename: `print_sheets_${date}_${batchName}.pdf`,
        caption: 'ورق طباعة الصور 🖨️',
        deadline,
        checkpoint,
      });
    }
  }

  // 4) Every source photo, with progress keyed by recipient + URL.
  const sentPhotoKeys = new Set(cursor.sentPhotoKeys);
  const maxPhotos = photoLimit(options.maxPhotosPerInvocation);
  let photosCompletedThisInvocation = 0;
  for (let index = 0; index < photos.length; index += 1) {
    const photo = photos[index]!;
    const pendingRecipients = cursor.recipientChatIds.filter(
      (recipient) => !sentPhotoKeys.has(artifactStateKey(recipient, photo.url))
    );
    if (!pendingRecipients.length) continue;
    assertTime(deadline, `اتبعت ${index} صورة — باقي ${photos.length - index}`);
    const buffer = await fetchBinary(photo.url, deadline);
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
    photosCompletedThisInvocation += 1;
    if (photosCompletedThisInvocation >= maxPhotos && index < photos.length - 1) {
      throw new SoftDeadlineError(
        `تم إرسال ${photosCompletedThisInvocation} صور في الجزء الحالي — باقي صور التجميعة`
      );
    }
  }

  // 5) Per-order summary document.
  if (count && data.ordersDetail.length !== count) {
    throw new PermanentProductionError(
      `ملف ملخص الأوردرات ناقص: ${data.ordersDetail.length} من ${count}`
    );
  }
  if (data.ordersDetail.length) {
    const ordersSummaryArtifactKey = `orders-summary:${cursor.sourceFingerprint}`;
    if (!artifactConfirmedForAll(cursor, ordersSummaryArtifactKey)) {
      assertTime(deadline, 'باقي ملف التجميعة بالأوردر والملخص النهائي');
      const { buildOrdersSummaryBuffer } = await import('./orderSummaryWriter.js');
      const ordersDocument = await buildOrdersSummaryBuffer(data.ordersDetail as never);
      await sendArtifactToAll({
        cursor,
        artifactKey: ordersSummaryArtifactKey,
        buffer: ordersDocument,
        filename: `orders_${date}_${batchName}_${count}.docx`,
        caption: `التجميعة بالأوردر — ${count} أوردر 📋`,
        deadline,
        checkpoint,
      });
    }
  }

  // 6) Plain UTF-8 summary. No Markdown, so product punctuation cannot break it.
  const summaryLines = [
    `📋 ملخص التجميعة ${cursor.batchId}`,
    `الأوردرات: ${count}`,
    `منتجات الإنتاج: ${data.productionEntries.length}`,
    `ملفات الليزر: ${laserFileCount}`,
    `شبكات البوكسات: ${boxFileCount}`,
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
