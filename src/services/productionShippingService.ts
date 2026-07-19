import { sendDocument, sendMessage } from '../telegram/telegramApi.js';
import type { ShopifyOrder } from '../types/shopify.js';
import type { RunCursor } from './productionJobStore.js';
import { normalizeOrderName } from './productionJobStore.js';
import {
  isOrderDataReviewError,
  isTransientProductionError,
  SoftDeadlineError,
} from './productionPipelineErrors.js';

type Checkpoint = () => Promise<void>;

function assertTime(deadline: number, progress: string): void {
  if (Date.now() >= deadline) throw new SoftDeadlineError(progress);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resultExists(cursor: RunCursor, orderName: string): boolean {
  return cursor.results.some((result) => normalizeOrderName(result.orderName) === orderName);
}

function appendNeedsReview(cursor: RunCursor, orderName: string, reason: string): void {
  if (!resultExists(cursor, orderName)) {
    cursor.results.push({ orderName, ok: false, reason, category: 'needs_review' });
  }
  if (!cursor.needsReviewOrderNames.includes(orderName)) cursor.needsReviewOrderNames.push(orderName);
  if (!cursor.processedOrderNames.includes(orderName)) cursor.processedOrderNames.push(orderName);
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function recoveryCsv(cursor: RunCursor): Buffer {
  const lines = ['batch_id,order_name,status,reason'];
  for (const result of cursor.results.filter((item) => item.category === 'needs_review')) {
    lines.push([
      csvCell(cursor.batchId),
      csvCell(result.orderName),
      csvCell('needs_review'),
      csvCell(result.reason ?? ''),
    ].join(','));
  }
  // UTF-8 BOM keeps Arabic readable when the CSV is opened directly in Excel.
  return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}

async function sendFinalMessage(options: {
  cursor: RunCursor;
  artifactKey: string;
  text: string;
  checkpoint: Checkpoint;
  deadline: number;
}): Promise<void> {
  const sent = new Set(options.cursor.sentFinalArtifactKeys);
  for (const recipient of options.cursor.recipientChatIds) {
    const key = `${recipient}|${options.artifactKey}`;
    if (sent.has(key)) continue;
    assertTime(options.deadline, 'باقي إرسال تقرير الشحن النهائي');
    if (!(await sendMessage(recipient, options.text))) {
      throw new Error(`Telegram failed to confirm final message for recipient ${recipient}`);
    }
    options.cursor.sentFinalArtifactKeys.push(key);
    sent.add(key);
    await options.checkpoint();
  }
}

async function sendRecoveryFile(options: {
  cursor: RunCursor;
  checkpoint: Checkpoint;
  deadline: number;
}): Promise<void> {
  if (!options.cursor.needsReviewOrderNames.length) return;
  const sent = new Set(options.cursor.sentFinalArtifactKeys);
  const buffer = recoveryCsv(options.cursor);
  for (const recipient of options.cursor.recipientChatIds) {
    const key = `${recipient}|recovery-csv`;
    if (sent.has(key)) continue;
    assertTime(options.deadline, 'باقي إرسال ملف الأوردرات التي تحتاج مراجعة');
    const ok = await sendDocument(
      recipient,
      buffer,
      `recovery_${options.cursor.batchId}.csv`,
      `أوردرات تحتاج مراجعة: ${options.cursor.needsReviewOrderNames.length} — بدون تخمين محافظة أو منطقة`
    );
    if (!ok) throw new Error(`Telegram failed to confirm recovery CSV for recipient ${recipient}`);
    options.cursor.sentFinalArtifactKeys.push(key);
    sent.add(key);
    await options.checkpoint();
  }
}

async function processOrderWithTransientRetries(
  order: ShopifyOrder,
  process: (order: ShopifyOrder) => Promise<{
    skipped: boolean;
    reason?: string;
    accurateShipmentId?: number;
  }>,
  deadline: number
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await process(order);
    } catch (error) {
      lastError = error;
      if (!isTransientProductionError(error) || attempt === 2) throw error;
      assertTime(deadline, `إعادة محاولة شحن ${order.name}`);
      await sleep(1000 * (2 ** attempt));
    }
  }
  throw lastError;
}

export async function createExactBatchShipments(options: {
  chatId: number;
  cursor: RunCursor;
  deadline: number;
  checkpoint: Checkpoint;
}): Promise<void> {
  const { chatId, cursor, deadline, checkpoint } = options;

  if (process.env.TELEGRAPH_ENABLED?.trim().toLowerCase() !== 'true') {
    throw new Error('TELEGRAPH_ENABLED is not true');
  }

  if (cursor.phase === 'shipping') {
    await sendMessage(
      chatId,
      cursor.processedOrderNames.length
        ? `🚚 بكمل شحن Batch ${cursor.batchId} تلقائيًا — اتعاملت مع ${cursor.processedOrderNames.length}/${cursor.orderNumbers.length}.`
        : `🚚 بدأ شحن Batch ${cursor.batchId} — ${cursor.orderNumbers.length} أوردر ثابت.`
    );

    assertTime(deadline, 'باقي جلب أوردرات الشحن');
    const { shopifyOrdersClient } = await import('../shopify/shopifyOrdersClient.js');
    const allOrders = await shopifyOrdersClient.listAllMatchingOrders(
      'status:any tag:confirmed',
      { pageSize: 250, maxOrders: 2000 }
    );
    const byName = new Map(
      allOrders
        .filter((order) => !order.test)
        .map((order) => [normalizeOrderName(order.name), order] as const)
    );

    const { createAppServices } = await import('../app.js');
    const { shopifyOrderProcessor } = createAppServices();
    const processed = new Set(cursor.processedOrderNames.map(normalizeOrderName));

    for (const rawName of cursor.orderNumbers) {
      const orderName = normalizeOrderName(rawName);
      if (!orderName || processed.has(orderName)) continue;
      assertTime(
        deadline,
        `اتعاملت مع ${cursor.processedOrderNames.length} أوردر — باقي ${cursor.orderNumbers.length - cursor.processedOrderNames.length}`
      );

      const order = byName.get(orderName);
      if (!order) {
        appendNeedsReview(cursor, orderName, 'Order is no longer available in the confirmed Shopify batch');
        processed.add(orderName);
        await checkpoint();
        await sendMessage(chatId, `⚠️ ${orderName} — محتاج مراجعة: الأوردر لم يعد ضمن confirmed في Shopify.`);
        continue;
      }

      try {
        const result = await processOrderWithTransientRetries(
          order,
          async (candidate) => await shopifyOrderProcessor.process(candidate, {
            source: 'telegram-bot-automatic-batch',
            batchId: cursor.batchId,
            skipEligibility: false,
            requireTelegraphLocation: true,
          }),
          deadline
        );

        if (result.accurateShipmentId && !cursor.createdShipmentIds.includes(result.accurateShipmentId)) {
          cursor.createdShipmentIds.push(result.accurateShipmentId);
        }
        cursor.results.push({
          orderName,
          ok: true,
          ...(result.reason ? { reason: result.reason } : {}),
          category: result.skipped ? 'skipped' : 'shipped',
        });
        cursor.processedOrderNames.push(orderName);
        processed.add(orderName);
        // Persist the shipment result before sending the cosmetic progress line.
        await checkpoint();
        await sendMessage(
          chatId,
          result.skipped
            ? `⏭️ ${orderName} — تم تخطيه بأمان: ${result.reason ?? 'skipped'}`
            : `✅ ${orderName} — تم الشحن بنجاح`
        );
      } catch (error) {
        if (isTransientProductionError(error)) throw error;
        const reason = String(error).slice(0, 300);
        appendNeedsReview(cursor, orderName, reason);
        processed.add(orderName);
        await checkpoint();
        await sendMessage(
          chatId,
          isOrderDataReviewError(error)
            ? `⚠️ ${orderName} — محتاج مراجعة بيانات، ولم يتم تخمين المحافظة أو المنطقة.`
            : `❌ ${orderName} — فشل دائم واتضاف لقائمة المراجعة: ${reason.slice(0, 160)}`
        );
      }
    }

    cursor.phase = 'finalize';
    await checkpoint();
  }

  const uniqueShipmentIds = [...new Set(cursor.createdShipmentIds)];
  if (uniqueShipmentIds.length) {
    const printUrl = `https://system.telegraphex.com/print/waybill/shipment/A4/3d/${uniqueShipmentIds.join(',')}`;
    await sendFinalMessage({
      cursor,
      artifactKey: 'waybill-link',
      text: `🖨️ بوالص Batch ${cursor.batchId} (${uniqueShipmentIds.length})\n${printUrl}`,
      checkpoint,
      deadline,
    });
  }

  const shipped = cursor.results.filter((result) => result.category === 'shipped').length;
  const skipped = cursor.results.filter((result) => result.category === 'skipped').length;
  const review = cursor.results.filter((result) => result.category === 'needs_review');
  const report = [
    `📊 التقرير النهائي — Batch ${cursor.batchId}`,
    `إجمالي الـBatch: ${cursor.orderNumbers.length}`,
    `✅ اتشحن: ${shipped}`,
    `⏭️ متشحن قبل كده/متخطي بأمان: ${skipped}`,
    `⚠️ يحتاج مراجعة ولم يُشحن: ${review.length}`,
  ];
  if (review.length) {
    report.push('', 'الأوردرات التي تحتاج مراجعة:');
    report.push(review.slice(0, 30).map((item) => item.orderName).join(', '));
    if (review.length > 30) report.push(`... والباقي موجود في ملف Recovery (${review.length - 30})`);
  }
  await sendFinalMessage({
    cursor,
    artifactKey: 'final-report',
    text: report.join('\n'),
    checkpoint,
    deadline,
  });
  await sendRecoveryFile({ cursor, checkpoint, deadline });
}
