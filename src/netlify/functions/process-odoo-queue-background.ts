/**
 * Netlify Background Function — runs up to 15 minutes.
 * Triggered by the lightweight scheduled `process-odoo-queue` function every
 * 30 minutes (and on-demand by the local test script).
 *
 * Drains the ENTIRE Odoo queue in one wake instead of one order per run. This
 * removes the old 1-order-per-run ceiling (which capped throughput at ~16–32
 * orders/day) so 30–80 orders/day is handled comfortably, while keeping Neon
 * compute woken only once per 30-min tick.
 *
 * Stages per order (one stage advanced per pass; a record re-appears in the
 * next fetch for its next stage, so the loop carries each order through all 3):
 *   Stage 1 (odoo-so-pending)       → ensureSalesOrder()
 *   Stage 2 (odoo-stock-pending)    → prepareSalesOrderStock()
 *   Stage 3 (odoo-delivery-pending) → confirmSalesOrderDelivery()
 *
 * Does NOT create invoices or payments — those are handled by the shipping
 * status sync (sync-open-shipments cron).
 */
import { createAppServices } from '../../app.js';
import { shipmentRepository } from '../../services/shipmentRepository.js';
import { logger } from '../../lib/logger.js';
import type { ShopifyOrder } from '../../types/shopify.js';

// Fetch a small batch per pass; the outer loop keeps fetching until the queue is
// empty or the time budget runs out. Small batches keep each DB read cheap.
const BATCH_SIZE = 10;
// 13 min — comfortably inside Netlify's 15-min background-function limit.
const BUDGET_MS = 13 * 60 * 1000;

// ─── Types ────────────────────────────────────────────────────────────────────

type QueueRecord = Awaited<ReturnType<typeof shipmentRepository.findPendingOdooQueue>>[number];
type OdooSvc = NonNullable<ReturnType<typeof createAppServices>['odooSyncService']>;

interface StageResult {
  id: number;
  status: string;
  error?: string;
}

interface LambdaResult {
  statusCode: number;
  body: string;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export const handler = async (): Promise<LambdaResult> => {
  const { odooSyncService } = createAppServices();
  if (!odooSyncService) {
    logger.warn('process-odoo-queue-background: Odoo not configured, skipping');
    return { statusCode: 503, body: JSON.stringify({ ok: false, message: 'Odoo not configured' }) };
  }

  const startTime = Date.now();
  const results: StageResult[] = [];
  let budgetHit = false;

  try {
    // Stuck-processing recovery: roll back records left in a "…-creating /
    // …-preparing / …-confirming" status for >10 min (a previous run was killed
    // mid-flight). 10 min >> any single Odoo call, so we never disturb a record
    // that is legitimately still being processed by a concurrent run.
    const recovered = await shipmentRepository.recoverStuckProcessingRecords(10);
    if (recovered > 0) {
      logger.warn('process-odoo-queue-background: recovered stuck records', { recovered });
    }

    // Drain loop: keep pulling batches until the queue is empty or the time
    // budget is exhausted. A record advanced one stage this pass re-appears in
    // the next fetch (its new pending status) and is carried forward, so an
    // order can complete all 3 stages within a single wake. Records that fail
    // get an odooRetryAt in the future, so they drop out of the queue and the
    // loop terminates instead of spinning.
    while (true) {
      if (Date.now() - startTime >= BUDGET_MS) {
        budgetHit = true;
        logger.info('process-odoo-queue-background: budget reached, remaining records retry next tick');
        break;
      }

      const queue = await shipmentRepository.findPendingOdooQueue(BATCH_SIZE);
      if (queue.length === 0) break;

      for (const record of queue) {
        if (Date.now() - startTime >= BUDGET_MS) {
          budgetHit = true;
          break;
        }
        results.push(await processOne(record, odooSyncService));
      }
      if (budgetHit) break;
    }

    logger.info('process-odoo-queue-background: done', { processed: results.length, budgetHit });
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, processed: results.length, budgetHit, results })
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('process-odoo-queue-background: top-level failure', { reason: message });
    return { statusCode: 500, body: JSON.stringify({ ok: false, message }) };
  }
};

// ─── processOne ───────────────────────────────────────────────────────────────

async function processOne(record: QueueRecord, odooSyncService: OdooSvc): Promise<StageResult> {
  const currentDbStatus = record.odooSyncStatus ?? 'odoo-so-pending';

  // ── Determine which stage to run and what DB status to claim from ──────────
  let stageToRun: string;
  let claimFromStatus: string;

  if (currentDbStatus === 'odoo-failed-retryable') {
    // Format: "RETRY_FROM:<stage>|<error message>"
    const match = record.odooLastError?.match(/^RETRY_FROM:([^|]+)\|/);
    stageToRun = match?.[1] ?? 'odoo-so-pending';
    claimFromStatus = 'odoo-failed-retryable';
  } else {
    stageToRun = currentDbStatus;
    claimFromStatus = currentDbStatus;
  }

  // ── Map stage → processing status ─────────────────────────────────────────
  const processingStatusMap: Record<string, string> = {
    'odoo-so-pending':       'odoo-so-creating',
    'odoo-stock-pending':    'odoo-stock-preparing',
    'odoo-delivery-pending': 'odoo-delivery-confirming'
  };
  const toStatus = processingStatusMap[stageToRun];
  if (!toStatus) {
    logger.warn('process-odoo-queue-background: unknown stage, skipping', { id: record.id, stageToRun, currentDbStatus });
    return { id: record.id, status: 'unknown-stage' };
  }

  // ── Safety guard: already at max attempts ─────────────────────────────────
  if ((record.odooAttemptCount ?? 0) >= 5) {
    logger.warn('process-odoo-queue-background: max attempts exceeded, marking failed', { id: record.id });
    await shipmentRepository.markOdooQueueFailed(record.shopifyOrderId, 'Max 5 attempts exceeded');
    return { id: record.id, status: 'max-attempts-exceeded' };
  }

  // ── Atomic claim ──────────────────────────────────────────────────────────
  const claimed = await shipmentRepository.claimOdooStage(record.id, claimFromStatus, toStatus);
  if (!claimed) {
    // Another worker (overlapping run) already claimed it — leave it.
    logger.info('process-odoo-queue-background: claimed by another worker, skipping', { id: record.id });
    return { id: record.id, status: 'claimed-by-other' };
  }

  // ── Run the stage ─────────────────────────────────────────────────────────
  try {
    return await runStage(record, stageToRun, odooSyncService);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('process-odoo-queue-background: stage failed', { id: record.id, stageToRun, error: message });
    await shipmentRepository.markOdooStageFailure(record.id, stageToRun, message);
    return { id: record.id, status: 'stage-failed', error: message };
  }
}

// ─── runStage ─────────────────────────────────────────────────────────────────

async function runStage(record: QueueRecord, stageToRun: string, odooSyncService: OdooSvc): Promise<StageResult> {
  // ── Stage 1: Create Sales Order ───────────────────────────────────────────
  if (stageToRun === 'odoo-so-pending') {
    const order = JSON.parse(record.rawOrderJson!) as ShopifyOrder;
    const saleOrder = await odooSyncService.ensureSalesOrder(
      order,
      { accurateShipmentCode: record.accurateShipmentCode, trackingUrl: null },
      { prepareStock: false, skipDbStatusUpdate: true }
    );
    await shipmentRepository.markOdooStageSuccess(record.id, 'odoo-stock-pending', {
      saleOrderId: saleOrder.id,
      saleOrderName: saleOrder.name
    });
    logger.info('process-odoo-queue-background: stage1 complete', {
      id: record.id,
      saleOrderId: saleOrder.id,
      saleOrderName: saleOrder.name,
      created: saleOrder.created
    });
    return { id: record.id, status: 'stage1-complete' };
  }

  // ── Stage 2: Prepare stock (manufacturing + internal pickings) ────────────
  if (stageToRun === 'odoo-stock-pending') {
    let saleOrderId = record.odooSaleOrderId;
    if (!saleOrderId) {
      // Crash recovery: SO created in Odoo but DB not updated. ensureSalesOrder
      // is idempotent — returns the existing SO.
      const order = JSON.parse(record.rawOrderJson!) as ShopifyOrder;
      const saleOrder = await odooSyncService.ensureSalesOrder(
        order,
        { accurateShipmentCode: record.accurateShipmentCode, trackingUrl: null },
        { prepareStock: false, skipDbStatusUpdate: true }
      );
      saleOrderId = saleOrder.id;
      await shipmentRepository.updateOdooSaleOrderLink(record.id, {
        saleOrderId: saleOrder.id,
        saleOrderName: saleOrder.name
      });
    }
    await odooSyncService.prepareSalesOrderStock(saleOrderId);
    await shipmentRepository.markOdooStageSuccess(record.id, 'odoo-delivery-pending');
    logger.info('process-odoo-queue-background: stage2 complete', { id: record.id, saleOrderId });
    return { id: record.id, status: 'stage2-complete' };
  }

  // ── Stage 3: Confirm customer delivery ────────────────────────────────────
  if (stageToRun === 'odoo-delivery-pending') {
    let saleOrderId = record.odooSaleOrderId;
    if (!saleOrderId) {
      const order = JSON.parse(record.rawOrderJson!) as ShopifyOrder;
      const saleOrder = await odooSyncService.ensureSalesOrder(
        order,
        { accurateShipmentCode: record.accurateShipmentCode, trackingUrl: null },
        { prepareStock: false, skipDbStatusUpdate: true }
      );
      saleOrderId = saleOrder.id;
      await shipmentRepository.updateOdooSaleOrderLink(record.id, {
        saleOrderId: saleOrder.id,
        saleOrderName: saleOrder.name
      });
    }
    await odooSyncService.confirmSalesOrderDelivery(saleOrderId);
    await shipmentRepository.markOdooStageSuccess(record.id, 'delivery-confirmed');
    logger.info('process-odoo-queue-background: stage3 complete — delivery confirmed', { id: record.id, saleOrderId });
    return { id: record.id, status: 'stage3-complete' };
  }

  logger.error('process-odoo-queue-background: unexpected stageToRun after validation', { id: record.id, stageToRun });
  return { id: record.id, status: 'unknown-stage' };
}
