import { sendDocument, sendMessage } from '../telegram/telegramApi.js';
import { assertProductionRunAllowed, previewOnlyConfig } from './productionPreviewOnly.js';
import { assertManualShipmentBindings, assertManualShipmentUnchanged } from './manualShipmentBinding.js';
import type { ShopifyOrder } from '../types/shopify.js';
import type { RunCursor } from './productionJobStore.js';
import { assertJobLease, normalizeOrderName, ProductionJobLeaseLostError } from './productionJobStore.js';
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
  for (const result of cursor.results.filter((item) => item.category === 'needs_review' || item.reason?.startsWith('fulfillment-error:'))) {
    lines.push([
      csvCell(cursor.batchId),
      csvCell(result.orderName),
      csvCell(result.reason?.startsWith('fulfillment-error:') ? 'shipment-created-fulfillment-review' : 'needs_review'),
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
  assertLease: Checkpoint;
  deadline: number;
}): Promise<void> {
  const sent = new Set(options.cursor.sentFinalArtifactKeys);
  for (const recipient of options.cursor.recipientChatIds) {
    const key = `${recipient}|${options.artifactKey}`;
    if (sent.has(key)) continue;
    assertTime(options.deadline, 'باقي إرسال تقرير الشحن النهائي');
    await options.assertLease();
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
  assertLease: Checkpoint;
  deadline: number;
}): Promise<void> {
  if (!options.cursor.needsReviewOrderNames.length) return;
  const sent = new Set(options.cursor.sentFinalArtifactKeys);
  const buffer = recoveryCsv(options.cursor);
  for (const recipient of options.cursor.recipientChatIds) {
    const key = `${recipient}|recovery-csv`;
    if (sent.has(key)) continue;
    assertTime(options.deadline, 'باقي إرسال ملف الأوردرات التي تحتاج مراجعة');
    await options.assertLease();
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
    accurateShipmentCode?: string;
    fulfillment?: { skipped: boolean; reason?: string };
  }>,
  deadline: number,
  assertLease: Checkpoint
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // Outside the retry catch: cancellation/lease loss is never an order error.
    // Recheck AFTER every backoff and immediately before the processor boundary.
    await assertLease();
    assertTime(deadline, `باقي شحن ${order.name}`);
    try {
      return await process(order);
    } catch (error) {
      lastError = error;
      if (!isTransientProductionError(error) || attempt === 2) throw error;
      await assertLease();
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
  /** Supplied only by the durable human-authorized pipeline. */
  manualContext?: { chatId: number; cursor: RunCursor };
}): Promise<void> {
  assertProductionRunAllowed(options.manualContext);
  const { chatId, cursor, deadline, checkpoint } = options;
  const manual = Boolean(previewOnlyConfig());
  if (manual && (options.manualContext?.chatId !== chatId || options.manualContext.cursor !== cursor)) {
    throw new Error('Manual Run context does not match the leased batch');
  }
  if (manual) assertManualShipmentBindings(cursor);
  const assertLease = async (): Promise<void> => {
    await assertJobLease(chatId, cursor.batchId, cursor.executionToken);
    assertProductionRunAllowed(options.manualContext);
    assertTime(deadline, 'باقي استكمال Batch الشحن');
  };

  if (process.env.TELEGRAPH_ENABLED?.trim().toLowerCase() !== 'true') {
    throw new Error('TELEGRAPH_ENABLED is not true');
  }

  if (cursor.phase === 'shipping') {
    await assertLease();
    await sendMessage(
      chatId,
      cursor.processedOrderNames.length
        ? `🚚 بكمل شحن Batch ${cursor.batchId} تلقائيًا — اتعاملت مع ${cursor.processedOrderNames.length}/${cursor.orderNumbers.length}.`
        : `🚚 بدأ شحن Batch ${cursor.batchId} — ${cursor.orderNumbers.length} أوردر ثابت.`
    );

    assertTime(deadline, 'باقي جلب أوردرات الشحن');
    const { shopifyOrdersClient } = await import('../shopify/shopifyOrdersClient.js');
    await assertLease();
    const allOrders = await shopifyOrdersClient.listAllMatchingOrders(
      'status:any tag:confirmed',
      { pageSize: 250, maxOrders: 2000 }
    );
    // The source load can outlive a cancellation or a replacement lease.
    await assertLease();
    const byName = new Map(
      allOrders
        .filter((order) => !order.test)
        .map((order) => [normalizeOrderName(order.name), order] as const)
    );

    const { createAppServices } = await import('../app.js');
    await assertLease();
    const { shopifyOrderProcessor } = createAppServices();
    const processed = new Set(cursor.processedOrderNames.map(normalizeOrderName));

    for (const rawName of cursor.orderNumbers) {
      const orderName = normalizeOrderName(rawName);
      if (!orderName || processed.has(orderName)) continue;
      await assertLease();
      assertTime(
        deadline,
        `اتعاملت مع ${cursor.processedOrderNames.length} أوردر — باقي ${cursor.orderNumbers.length - cursor.processedOrderNames.length}`
      );

      const order = byName.get(orderName);
      if (!order) {
        appendNeedsReview(cursor, orderName, 'Order is no longer available in the confirmed Shopify batch');
        processed.add(orderName);
        await checkpoint();
        await assertLease();
        await sendMessage(chatId, `⚠️ ${orderName} — محتاج مراجعة: الأوردر لم يعد ضمن confirmed في Shopify.`);
        continue;
      }

      try {
        const binding = manual ? cursor.manualShipmentBindings!.find(item => item.orderName === orderName) : undefined;
        if (manual && !binding) throw new Error('Order is outside the immutable manual Preview scope');
        const assertSourceUnchanged = async (): Promise<void> => {
          await assertLease();
          if (binding) {
            const fresh = await shopifyOrdersClient.getOrderByLegacyId(binding.shopifyOrderId);
            await assertLease();
            assertManualShipmentUnchanged(binding, fresh);
          }
        };
        if (binding) {
          assertManualShipmentUnchanged(binding, order);
          await assertLease();
          const fresh = await shopifyOrdersClient.getOrderByLegacyId(binding.shopifyOrderId);
          await assertLease();
          assertManualShipmentUnchanged(binding, fresh);
          if (fresh.fulfillment_status === 'fulfilled') throw new Error('Order became fulfilled before manual shipment creation; review existing shipment');
        }
        const result = await processOrderWithTransientRetries(
          order,
          async (candidate) => await shopifyOrderProcessor.process(candidate, {
            source: 'telegram-bot-automatic-batch',
            batchId: cursor.batchId,
            skipEligibility: false,
            requireTelegraphLocation: true,
            operationDeadline: deadline,
            ...(manual ? { assertOperationAllowed: assertLease, assertSourceUnchanged,
              manualRunAuthorization: { chatId, batchId: cursor.batchId,
                epoch: cursor.manualRunEpoch, updateId: cursor.manualRunApprovedUpdateId } } : {}),
          }),
          deadline,
          assertLease
        );

        if (result.accurateShipmentId && !cursor.createdShipmentIds.includes(result.accurateShipmentId)) {
          cursor.createdShipmentIds.push(result.accurateShipmentId);
        }
        cursor.results.push({
          orderName,
          ok: true,
          ...(result.fulfillment?.reason?.startsWith('fulfillment-error:')
            ? { reason: result.fulfillment.reason }
            : result.reason ? { reason: result.reason } : {}),
          category: result.skipped ? 'skipped' : 'shipped',
        });
        if (result.fulfillment?.reason?.startsWith('fulfillment-error:') && !cursor.needsReviewOrderNames.includes(orderName)) {
          cursor.needsReviewOrderNames.push(orderName);
        }
        cursor.processedOrderNames.push(orderName);
        processed.add(orderName);
        // Persist the shipment result before sending the cosmetic progress line.
        await checkpoint();
        await assertLease();
        await sendMessage(
          chatId,
          result.fulfillment?.reason?.startsWith('fulfillment-error:')
            ? `⚠️ ${orderName} — هوية الشحنة محفوظة لكن Shopify fulfillment يحتاج مراجعة؛ لن أكرر الشحنة.`
            : result.reason === 'existing-shipment-fulfillment-repaired'
            ? `✅ ${orderName} — تم ربط Shopify بالبوليصة الموجودة ${result.accurateShipmentCode ?? ''} بدون شحنة جديدة.`
            : result.skipped
            ? `⏭️ ${orderName} — تم تخطيه بأمان: ${result.reason ?? 'skipped'}`
            : `✅ ${orderName} — تم الشحن بنجاح`
        );
      } catch (error) {
        if (error instanceof ProductionJobLeaseLostError || error instanceof SoftDeadlineError) throw error;
        if (isTransientProductionError(error)) throw error;
        await assertLease();
        const reason = String(error).slice(0, 300);
        appendNeedsReview(cursor, orderName, reason);
        processed.add(orderName);
        await checkpoint();
        await assertLease();
        await sendMessage(
          chatId,
          isOrderDataReviewError(error)
            ? `⚠️ ${orderName} — محتاج مراجعة بيانات، ولم يتم تخمين المحافظة أو المنطقة.`
            : `❌ ${orderName} — فشل دائم واتضاف لقائمة المراجعة: ${reason.slice(0, 160)}`
        );
      }
    }

    await assertLease();
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
      assertLease,
      deadline,
    });
  }

  const shipped = cursor.results.filter((result) => result.category === 'shipped').length;
  const skipped = cursor.results.filter((result) => result.category === 'skipped').length;
  const review = cursor.results.filter((result) => result.category === 'needs_review');
  const fulfillmentReview = cursor.results.filter((result) => result.reason?.startsWith('fulfillment-error:'));
  const report = [
    `📊 التقرير النهائي — Batch ${cursor.batchId}`,
    `إجمالي الـBatch: ${cursor.orderNumbers.length}`,
    `✅ اتشحن: ${shipped}`,
    `⏭️ متشحن قبل كده/متخطي بأمان: ${skipped}`,
    `⚠️ يحتاج مراجعة ولم يُشحن: ${review.length}`,
    ...(fulfillmentReview.length ? [`⚠️ شحنات محفوظة وShopify fulfillment يحتاج مراجعة: ${fulfillmentReview.length}`] : []),
    ...(manual ? ['⏳ Odoo: مهام الإنتاج الجديدة مسجلة فقط ولم تُنفّذ؛ المحاسبة والطوابير العامة ما زالت مقفولة. أي خطأ fulfillment يحتاج مراجعة منفصلة.'] : []),
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
    assertLease,
    deadline,
  });
  await sendRecoveryFile({ cursor, checkpoint, assertLease, deadline });
}
