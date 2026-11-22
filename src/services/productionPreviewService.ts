import { createHash } from 'node:crypto';
import { sendDocument, sendMessage } from '../telegram/telegramApi.js';
import type { PreviewCursor } from './productionJobStore.js';
import { assertJobLease, ProductionJobLeaseLostError } from './productionJobStore.js';
import {
  extractOrderNumbers,
  fetchProductionBatch,
  productionSourceFingerprint,
  type ProductionAgentResponse,
  type ProductionEntry,
} from './productionAgentClient.js';
import { PermanentProductionError, SoftDeadlineError } from './productionPipelineErrors.js';
import { manualRunConfig } from './productionPreviewOnly.js';
import { bindManualShipment, assertManualShipmentBindings, assertManualShipmentUnchanged, manualShipmentBindingsHash } from './manualShipmentBinding.js';
import {
  assertPreviewFinancialSource, assertPreviewPrimaryShipmentExclusion,
  previewShipmentScope, PreviewShipmentExclusionError, type PreviewShipmentScope,
} from './previewShipmentExclusion.js';

/** Read-time migration for the SAME uploaded-file capability; never mutate the
 * customer's source URL, query/key, order, image bytes or customization data. */
export function currentPreviewPhotoUrl(value: string): string {
  try {
    const u = new URL(value), old = new Set(['viola-customization-admin.vercel.app',
      'viola-customization-admin-violaaa.vercel.app', 'viola-customization-admin.netlify.app',
      'viola-customization-recovery.netlify.app']);
    const key = u.searchParams.get('key');
    if (!old.has(u.hostname) || u.username || u.password || u.pathname !== '/app/uploaded-file' ||
        !key?.startsWith('uploads/') || key.includes('..')) return value;
    return `https://app.violaleather.com${u.pathname}${u.search}${u.hash}`;
  } catch { return value; }
}

type Checkpoint = (progressMade?: boolean) => Promise<void>;
type LeaseCheck = () => Promise<void>;

const DEFAULT_MAX_PHOTOS_PER_INVOCATION = 6;

class PermanentPhotoUnavailableError extends Error {
  constructor(
    readonly url: string,
    readonly status: number
  ) {
    super(`Photo HTTP ${status}: ${url.slice(0, 160)}`);
    this.name = 'PermanentPhotoUnavailableError';
  }
}

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
  assertLease: LeaseCheck;
}): Promise<void> {
  const sent = new Set(options.cursor.sentArtifactKeys);
  for (const recipient of options.cursor.recipientChatIds) {
    const stateKey = artifactStateKey(recipient, options.artifactKey);
    if (sent.has(stateKey)) continue;
    assertTime(options.deadline, `باقي إرسال ${options.filename}`);
    await options.assertLease();
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
  assertLease: LeaseCheck;
}): Promise<void> {
  const sent = new Set(options.cursor.sentArtifactKeys);
  for (const recipient of options.cursor.recipientChatIds) {
    const stateKey = artifactStateKey(recipient, options.artifactKey);
    if (sent.has(stateKey)) continue;
    assertTime(options.deadline, 'باقي إرسال ملخص التجميعة');
    await options.assertLease();
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

async function fetchBinary(url: string, deadline: number, assertLease: LeaseCheck): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // Check outside the retry catch, including after every backoff. Lease loss
    // is cancellation, never a transient image failure or a 404 review marker.
    await assertLease();
    assertTime(deadline, 'باقي تحميل صورة');
    const remaining = deadline - Date.now();
    const timeoutMs = Math.min(45_000, Math.max(1_000, remaining - 2_000));
    try {
      const response = await fetch(currentPreviewPhotoUrl(url), { signal: AbortSignal.timeout(timeoutMs) });
      await assertLease();
      if (response.ok) {
        const bytes = await response.arrayBuffer();
        await assertLease();
        return Buffer.from(bytes);
      }
      if (response.status === 404 || response.status === 410) {
        throw new PermanentPhotoUnavailableError(url, response.status);
      }
      const error = new Error(`Photo HTTP ${response.status}: ${url.slice(0, 160)}`);
      if (response.status !== 429 && response.status < 500) throw error;
      lastError = error;
    } catch (error) {
      if (error instanceof ProductionJobLeaseLostError || error instanceof SoftDeadlineError) throw error;
      if (error instanceof PermanentPhotoUnavailableError) throw error;
      lastError = error;
      if (attempt === 2) throw error;
    }
    if (attempt < 2) {
      await assertLease();
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
  const assertLease = async (): Promise<void> => {
    await assertJobLease(chatId, cursor.batchId, cursor.executionToken);
    assertTime(deadline, 'باقي استكمال Preview');
  };
  let shipmentScope: PreviewShipmentScope | undefined;
  let currentOrders: import('../types/shopify.js').ShopifyOrder[] | undefined;
  const assertArtifactAllowed = async (): Promise<void> => {
    await assertLease();
    if (!shipmentScope || !currentOrders) throw new PreviewShipmentExclusionError([
      { orderName: 'Batch', reason: 'لم يكتمل فحص مصدر الشحن الحالي' },
    ]);
    await assertPreviewPrimaryShipmentExclusion(shipmentScope);
    await assertLease();
    assertPreviewFinancialSource(shipmentScope, currentOrders);
  };
  // This fences the next operation, not a provider request already in flight.
  await assertLease();
  assertTime(deadline, 'لم يبدأ جلب التجميعة بعد');

  const hadOrderNumbers = cursor.orderNumbers.length > 0;
  const hadFingerprint = Boolean(cursor.sourceFingerprint);
  const manual = manualRunConfig();
  if (manual && hadFingerprint && !cursor.manualShipmentBindings) {
    throw new PermanentProductionError('A NEW Preview is required to capture manual shipment bindings');
  }
  // Bracket the production-source read with independent Shopify reads. Never
  // bind newer shipping data to older product/customization artifacts.
  let beforeOrders: import('../types/shopify.js').ShopifyOrder[] | undefined;
  if (manual && !cursor.manualShipmentBindings) {
    const { shopifyOrdersClient } = await import('../shopify/shopifyOrdersClient.js');
    await assertLease();
    beforeOrders = await shopifyOrdersClient.listAllMatchingOrders('status:any tag:confirmed', { pageSize: 250, maxOrders: 2000 });
    await assertLease();
  }
  if (!hadOrderNumbers) {
    await sendMessage(chatId, `📦 جاري تثبيت أوردرات التجميعة ${cursor.batchId}...`);
  }

  await assertLease();
  const savedSnapshot = await sourceSnapshot?.load() ?? null;
  await assertLease();
  let data = savedSnapshot;
  if (!data) {
    data = await fetchProductionBatch({
      orderId: cursor.orderId,
      orderNumbers: cursor.orderNumbers.length ? cursor.orderNumbers : undefined,
    });
    await assertLease();
  }

  if (!Array.isArray(data.ordersDetail) || data.ordersDetail.some(order =>
      !order || typeof order.order_name !== 'string' || !/^#[1-9]\d*$/.test(order.order_name)) ||
      new Set(data.ordersDetail.map(order => order.order_name)).size !== data.ordersDetail.length) {
    throw new PreviewShipmentExclusionError([{ orderName: 'Batch', reason: 'قائمة أوردرات الملف غير صالحة أو مكررة' }]);
  }
  if (!cursor.orderNumbers.length) {
    cursor.orderNumbers = extractOrderNumbers(data);
    // The explicit single-order path must never silently return a different order.
    if (cursor.orderId && !cursor.orderNumbers.includes(`#${cursor.orderId}`)) {
      throw new PermanentProductionError(`Ayman Agent لم يرجع الأوردر المطلوب #${cursor.orderId}`);
    }
  }
  validateSource(cursor, data);
  const sourceOrderNumbers = extractOrderNumbers(data);
  if (sourceOrderNumbers.length !== cursor.orderNumbers.length ||
      sourceOrderNumbers.some((name, index) => name !== cursor.orderNumbers[index])) {
    throw new PreviewShipmentExclusionError([{ orderName: 'Batch', reason: 'قائمة مصدر الملفات لا تطابق التجميعة الثابتة' }]);
  }
  const hints: Array<{ orderName: unknown; shopifyOrderId: unknown }> = [
    ...(cursor.manualShipmentBindings ?? []),
    ...(beforeOrders ?? []).filter(o => sourceOrderNumbers.includes(o.name))
      .map(o => ({ orderName: o.name, shopifyOrderId: String(o.id) })),
  ];
  for (const entry of data.productionEntries) {
    if (!Array.isArray(entry.source_orders)) throw new PreviewShipmentExclusionError([
      { orderName: 'Batch', reason: 'هويات أوردرات مصدر ملفات الإنتاج غير مكتملة' },
    ]);
    for (const raw of entry.source_orders) {
      const source = raw as { order_name?: unknown; order_id?: unknown } | null;
      hints.push({ orderName: source?.order_name, shopifyOrderId: source?.order_id });
    }
  }
  shipmentScope = previewShipmentScope(sourceOrderNumbers, hints);
  // Cheap primary/claim fence FIRST, even for an old immutable snapshot. Never
  // filter productionEntries alone: wordBase64 already contains the full batch.
  await assertPreviewPrimaryShipmentExclusion(shipmentScope);
  await assertLease();
  if (manual) {
    if (!cursor.manualShipmentBindings) {
      const { shopifyOrdersClient } = await import('../shopify/shopifyOrdersClient.js');
      await assertLease();
      const afterOrders = await shopifyOrdersClient.listAllMatchingOrders('status:any tag:confirmed', { pageSize: 250, maxOrders: 2000 });
      await assertLease();
      currentOrders = afterOrders;
      assertPreviewFinancialSource(shipmentScope, currentOrders);
      cursor.manualShipmentBindings = cursor.orderNumbers.map(name => {
        const before = beforeOrders?.filter(order => order.name === name) ?? [];
        const after = afterOrders.filter(order => order.name === name);
        if (before.length !== 1 || after.length !== 1) throw new PermanentProductionError(`Ambiguous Shopify identity for Preview ${name}`);
        const binding = bindManualShipment(before[0]);
        assertManualShipmentUnchanged(binding, after[0]);
        return binding;
      });
      cursor.manualShipmentBindingHash = manualShipmentBindingsHash(cursor.manualShipmentBindings);
    }
    assertManualShipmentBindings(cursor);
  }
  if (!currentOrders) {
    const { shopifyOrdersClient } = await import('../shopify/shopifyOrdersClient.js');
    await assertLease();
    currentOrders = await shopifyOrdersClient.listAllMatchingOrders('status:any tag:confirmed', { pageSize: 250, maxOrders: 2000 });
    await assertLease();
  }
  assertPreviewFinancialSource(shipmentScope, currentOrders);
  if (sourceSnapshot && !savedSnapshot) {
    // Capture the complete source before the first externally-visible send.
    // Every continuation then regenerates artifacts from these exact bytes.
    await assertArtifactAllowed();
    await sourceSnapshot.save(data);
    await assertLease();
  }
  // Loading a previously-saved snapshot is not forward progress and must not
  // erase a consecutive retry count. Capturing the source for the first time is.
  await assertArtifactAllowed();
  await checkpoint(!hadOrderNumbers || !hadFingerprint);

  const count = cursor.orderNumbers.length;
  const photos = uniquePhotos(data);
  const batchName = safeBatchName(cursor.batchId);
  const date = new Date().toISOString().slice(0, 10);
  if (!hadOrderNumbers) {
    await assertLease();
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
      assertLease: assertArtifactAllowed,
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
  let laserFiles: Array<{ buffer: Buffer; kind: string; label: string }> | null = null;
  let boxFiles: Buffer[] | null = null;

  if (!laserAlreadyComplete || !boxAlreadyComplete) {
    await assertLease();
    const { buildBoxGridBuffers } = await import('./aiWriter.js');
    const { buildLaserArtifacts, laserPhotoUrls } = await import('./laser/laserFiles.js');
    const { printPhotoSourceUrl } = await import('./printSheet.js');
    const entries = data.productionEntries as unknown as import('./laser/laserRouting.js').LaserEntry[];
    const laserPhotos = new Map<string, Buffer>();
    for (const url of laserPhotoUrls(entries)) {
      assertTime(deadline, 'باقي تحميل صور ملفات الليزر');
      await assertLease();
      try { laserPhotos.set(url, await fetchBinary(printPhotoSourceUrl(url), deadline, assertLease)); }
      catch (error) {
        if (error instanceof SoftDeadlineError || error instanceof ProductionJobLeaseLostError) throw error;
        console.warn(`[laser] photo not placed, marker kept: ${url.slice(0, 120)} (${String(error)})`);
      }
    }
    await assertLease();
    if (!laserAlreadyComplete) {
      laserFiles = await buildLaserArtifacts(entries, laserPhotos, { maxBytes: 1_500_000 });
      await assertLease();
    }
    if (!boxAlreadyComplete) {
      boxFiles = data.productionEntries.some(isBoxEntry)
        ? await buildBoxGridBuffers(data.productionEntries as never, laserPhotos)
        : [];
      await assertLease();
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
    await assertArtifactAllowed();
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
      const { buffer, kind, label } = laserFiles[index]!;
      const ofKind = laserFiles.filter((f) => f.kind === kind);
      const n = ofKind.indexOf(laserFiles[index]!) + 1;
      await sendArtifactToAll({
        cursor,
        artifactKey: `laser:${index + 1}:${cursor.sourceFingerprint}`,
        buffer,
        filename: `${kind}_${date}_${batchName}_${n}.ai`,
        caption: `${label} ${n}/${ofKind.length} 🔪`,
        deadline,
        checkpoint,
        assertLease: assertArtifactAllowed,
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
        assertLease: assertArtifactAllowed,
      });
    }
  }

  // 3) Print-ready photo sheet. Any failed source image blocks completion.
  assertTime(deadline, 'باقي ورق طباعة الصور والصور المنفردة');
  const printSheetArtifactKey = `print-sheet:${cursor.sourceFingerprint}`;
  if (!artifactConfirmedForAll(cursor, printSheetArtifactKey)) {
    await assertLease();
    const { buildPrintSheetPdf, kindForProduct, printPhotoSourceUrl } = await import('./printSheet.js');
    await assertLease();
    const printSources: Array<{ url: string; kind: 'wallet' | 'keychain';
      source: { orderName: string; product: string; photoNumber: number } }> = [];
    const seenPrint = new Set<string>();
    for (const entry of data.productionEntries) {
      const kind = kindForProduct(entry.display_product);
      for (const photo of entry.photo_attachments ?? []) {
        if ((photo.position_label ?? '').trim()) continue;
        if (!photo.attachment_url || seenPrint.has(photo.attachment_url)) continue;
        seenPrint.add(photo.attachment_url);
        printSources.push({ url: photo.attachment_url, kind, source: {
          orderName: photo.order_name,
          product: `${entry.display_product}${entry.display_color ? ` ${entry.display_color}` : ''}`.trim(),
          photoNumber: printSources.length + 1,
        } });
      }
    }
    if (printSources.length) {
      const printPhotos: Array<{ buffer: Buffer; kind: 'wallet' | 'keychain';
        source: { orderName: string; product: string; photoNumber: number } }> = [];
      for (const source of printSources) {
        assertTime(deadline, 'باقي تحميل صور ورق الطباعة');
        try {
          printPhotos.push({
            buffer: await fetchBinary(printPhotoSourceUrl(source.url), deadline, assertLease),
            kind: source.kind,
            source: source.source,
          });
        } catch (error) {
          // Only confirmed permanent HTTP absence is reclassified. Transport,
          // quota, deadline and lease-loss errors retain their existing guards.
          if (!(error instanceof PermanentPhotoUnavailableError)) throw error;
          throw new PermanentProductionError(
            `صورة الطباعة رقم ${source.source.photoNumber} للأوردر ${source.source.orderName} ` +
            `(${source.source.product}) غير متاحة (HTTP ${error.status}). مطلوب نسخة سليمة؛ لن نتخطّى الصورة.`
          );
        }
      }
      await assertLease();
      const pdfBytes = await buildPrintSheetPdf(printPhotos);
      await assertLease();
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
        assertLease: assertArtifactAllowed,
      });
    }
  }

  // 4) Every source photo, with progress keyed by recipient + URL.
  const sentPhotoKeys = new Set(cursor.sentPhotoKeys);
  const unavailablePhotoUrls = new Set(cursor.unavailablePhotoUrls ?? []);
  cursor.unavailablePhotoUrls = [...unavailablePhotoUrls];
  const maxPhotos = photoLimit(options.maxPhotosPerInvocation);
  let photosCompletedThisInvocation = 0;
  for (let index = 0; index < photos.length; index += 1) {
    const photo = photos[index]!;
    if (unavailablePhotoUrls.has(photo.url)) continue;
    const pendingRecipients = cursor.recipientChatIds.filter(
      (recipient) => !sentPhotoKeys.has(artifactStateKey(recipient, photo.url))
    );
    if (!pendingRecipients.length) continue;
    assertTime(deadline, `اتبعت ${index} صورة — باقي ${photos.length - index}`);
    let buffer: Buffer;
    try {
      buffer = await fetchBinary(photo.url, deadline, assertLease);
    } catch (error) {
      if (!(error instanceof PermanentPhotoUnavailableError)) throw error;
      unavailablePhotoUrls.add(photo.url);
      cursor.unavailablePhotoUrls = [...unavailablePhotoUrls];
      // This is a durable review marker, not a confirmed external send.
      await checkpoint(false);
      continue;
    }
    let extension = 'jpg';
    try {
      const raw = new URL(photo.url).pathname.split('.').pop() ?? 'jpg';
      if (/^[a-z0-9]{2,5}$/i.test(raw)) extension = raw;
    } catch {
      // Keep jpg for unusual but fetchable attachment URLs.
    }
    const order = photo.orderName.replace(/[^a-zA-Z0-9_-]/g, '_');
    for (const recipient of pendingRecipients) {
      await assertArtifactAllowed();
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
      await assertLease();
      const { buildOrdersSummaryBuffer } = await import('./orderSummaryWriter.js');
      await assertLease();
      const ordersDocument = await buildOrdersSummaryBuffer(data.ordersDetail as never);
      await assertLease();
      await sendArtifactToAll({
        cursor,
        artifactKey: ordersSummaryArtifactKey,
        buffer: ordersDocument,
        filename: `orders_${date}_${batchName}_${count}.docx`,
        caption: `التجميعة بالأوردر — ${count} أوردر 📋`,
        deadline,
        checkpoint,
        assertLease: assertArtifactAllowed,
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
    `الصور المطلوبة: ${photos.length}`,
    `الصور غير المتاحة: ${unavailablePhotoUrls.size}`,
    `التحذيرات: ${data.warnings.length}`,
  ];
  for (const warning of data.warnings.slice(0, 5)) {
    summaryLines.push(`⚠️ ${String(warning).slice(0, 180)}`);
  }
  const unavailablePhotos = photos.filter((photo) => unavailablePhotoUrls.has(photo.url));
  for (const photo of unavailablePhotos.slice(0, 10)) {
    summaryLines.push(`⛔ صورة غير متاحة: ${photo.orderName} — ${photo.product}`);
  }
  const reviewDigest = createHash('sha256')
    .update([...unavailablePhotoUrls].sort().join('\n'))
    .digest('hex')
    .slice(0, 12);
  await sendTextToAll({
    cursor,
    artifactKey: `summary:${productionSourceFingerprint(data)}:${reviewDigest}`,
    text: summaryLines.join('\n'),
    deadline,
    checkpoint,
    assertLease: assertArtifactAllowed,
  });
  await assertLease();

  if (unavailablePhotos.length) {
    const affected = unavailablePhotos
      .slice(0, 5)
      .map((photo) => `${photo.orderName} (${photo.product})`)
      .join(', ');
    throw new PermanentProductionError(
      `${unavailablePhotos.length} صورة مصدرها غير متاح نهائيًا (404/410): ${affected}. ` +
      'تم إرسال كل الملفات والصور الأخرى، لكن الـBatch لن يتحول إلى Run قبل المراجعة.'
    );
  }
}
