/**
 * Netlify Scheduled Function — runs every 5 minutes.
 * Processes up to 5 queued Odoo Sales Order creation jobs per run.
 * Budget: 23s total (3s buffer from the 26s Netlify sync function limit).
 *
 * Stages per order:
 *   Stage 1 (odoo-so-pending)       → ensureSalesOrder()
 *   Stage 2 (odoo-stock-pending)    → prepareSalesOrderStock()
 *   Stage 3 (odoo-delivery-pending) → confirmSalesOrderDelivery()
 *
 * Each run processes ONE stage per order. If a record needs Stage 2,
 * Stage 1 was already done in a previous run (or is idempotent on retry).
 *
 * Does NOT create invoices or payments — those are handled by the
 * shipping status sync (sync-open-shipments cron).
 */
import { createAppServices } from '../../app.js';
import { shipmentRepository } from '../../services/shipmentRepository.js';
import { logger } from '../../lib/logger.js';
import type { ShopifyOrder } from '../../types/shopify.js';

const MAX_ORDERS = 5;
const BUDGET_MS = 23_000;

// ─── Types ────────────────────────────────────────────────────────────────────

type QueueRecord = Awaited<ReturnType<typeof shipmentRepository.findPendingOdooQueue>>[number];
type OdooSvc = NonNullable<ReturnType<typeof createAppServices>['odooSyncService']>;

interface StageResult {
  id: number;
  status: string;
  error?: string;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export const handler = async () => {
  const { odooSyncService } = createAppServices();
  if (!odooSyncService) {
    logger.warn('process-odoo-queue: Odoo not configured, skipping');
    return { statusCode: 503, body: JSON.stringify({ ok: false, message: 'Odoo not configured' }) };
  }

  const startTime = Date.now();
  const results: StageResult[] = [];

  try {
    // ── Stuck-processing recovery ─────────────────────────────────────────────
    // If a previous cron run was hard-killed by Netlify's 26s timeout while an
    // Odoo API call was in-flight, the record was left in a "…-creating /
    // …-preparing / …-confirming" status with no worker to finish it.
    // Those statuses are NOT in findPendingOdooQueue's filter, so the record
    // would be stuck forever without this recovery step.
    //
    // Any record that has been in a processing status for >10 minutes is
    // rolled back to the corresponding pending stage so this run (or the next)
    // can pick it up cleanly.  10 minutes >> 26s (Netlify kill) so we never
    // recover a record that is legitimately still running.
    const recovered = await shipmentRepository.recoverStuckProcessingRecords(10);
    if (recovered > 0) {
      logger.warn('process-odoo-queue: recovered stuck records', { recovered });
    }

    const queue = await shipmentRepository.findPendingOdooQueue(MAX_ORDERS);
    logger.info('process-odoo-queue: starting', { queued: queue.length });

    for (const record of queue) {
      if (Date.now() - startTime >= BUDGET_MS) {
        logger.info('process-odoo-queue: budget reached, deferring remaining records');
        break;
      }
      results.push(await processOne(record, odooSyncService));
    }

    logger.info('process-odoo-queue: done', { processed: results.length, results });
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, processed: results.length, results })
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('process-odoo-queue: top-level failure', { reason: message });
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
    // Parse the stage we need to retry from the error field.
    // Format: "RETRY_FROM:<stage>|<error message>"
    const match = record.odooLastError?.match(/^RETRY_FROM:([^|]+)\|/);
    stageToRun = match?.[1] ?? 'odoo-so-pending';
    claimFromStatus = 'odoo-failed-retryable'; // claim FROM the DB status, not the stage
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
    logger.warn('process-odoo-queue: unknown stage, skipping', { id: record.id, stageToRun, currentDbStatus });
    return { id: record.id, status: 'unknown-stage' };
  }

  // ── Safety guard: already at max attempts ─────────────────────────────────
  // markOdooStageFailure handles this on attempt 5, but guard here too in case
  // a record slipped through (e.g. manually set).
  if ((record.odooAttemptCount ?? 0) >= 5) {
    logger.warn('process-odoo-queue: max attempts exceeded, marking failed', { id: record.id });
    await shipmentRepository.markOdooQueueFailed(record.shopifyOrderId, 'Max 5 attempts exceeded');
    return { id: record.id, status: 'max-attempts-exceeded' };
  }

  // ── Atomic claim ──────────────────────────────────────────────────────────
  const claimed = await shipmentRepository.claimOdooStage(record.id, claimFromStatus, toStatus);
  if (!claimed) {
    // Another cron run or manual trigger already claimed this record
    logger.info('process-odoo-queue: claimed by another worker, skipping', { id: record.id });
    return { id: record.id, status: 'claimed-by-other' };
  }

  // ── Run the stage ─────────────────────────────────────────────────────────
  try {
    return await runStage(record, stageToRun, odooSyncService);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('process-odoo-queue: stage failed', { id: record.id, stageToRun, error: message });
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
      { prepareStock: false }
    );
    await shipmentRepository.markOdooStageSuccess(record.id, 'odoo-stock-pending', {
      saleOrderId: saleOrder.id,
      saleOrderName: saleOrder.name
    });
    logger.info('process-odoo-queue: stage1 complete', {
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
      // Crash recovery: SO was created in Odoo but DB wasn't updated.
      // ensureSalesOrder is idempotent — returns the existing SO.
      const order = JSON.parse(record.rawOrderJson!) as ShopifyOrder;
      const saleOrder = await odooSyncService.ensureSalesOrder(
        order,
        { accurateShipmentCode: record.accurateShipmentCode, trackingUrl: null },
        { prepareStock: false }
      );
      saleOrderId = saleOrder.id;
      await shipmentRepository.updateOdooSaleOrderLink(record.id, {
        saleOrderId: saleOrder.id,
        saleOrderName: saleOrder.name
      });
    }
    await odooSyncService.prepareSalesOrderStock(saleOrderId);
    await shipmentRepository.markOdooStageSuccess(record.id, 'odoo-delivery-pending');
    logger.info('process-odoo-queue: stage2 complete', { id: record.id, saleOrderId });
    return { id: record.id, status: 'stage2-complete' };
  }

  // ── Stage 3: Confirm customer delivery ────────────────────────────────────
  if (stageToRun === 'odoo-delivery-pending') {
    let saleOrderId = record.odooSaleOrderId;
    if (!saleOrderId) {
      // Same crash-recovery as Stage 2
      const order = JSON.parse(record.rawOrderJson!) as ShopifyOrder;
      const saleOrder = await odooSyncService.ensureSalesOrder(
        order,
        { accurateShipmentCode: record.accurateShipmentCode, trackingUrl: null },
        { prepareStock: false }
      );
      saleOrderId = saleOrder.id;
      await shipmentRepository.updateOdooSaleOrderLink(record.id, {
        saleOrderId: saleOrder.id,
        saleOrderName: saleOrder.name
      });
    }
    await odooSyncService.confirmSalesOrderDelivery(saleOrderId);
    await shipmentRepository.markOdooStageSuccess(record.id, 'delivery-confirmed');
    logger.info('process-odoo-queue: stage3 complete — delivery confirmed', { id: record.id, saleOrderId });
    return { id: record.id, status: 'stage3-complete' };
  }

  // Should never reach here — stageToRun was validated above
  logger.error('process-odoo-queue: unexpected stageToRun after validation', { id: record.id, stageToRun });
  return { id: record.id, status: 'unknown-stage' };
}
