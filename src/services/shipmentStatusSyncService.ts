import { AccurateClient, type AccuratePaymentShipmentEntry } from '../accurate/accurateClient.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { UnauthorizedError } from '../lib/errors.js';
import { shopifyStatusSyncClient } from '../shopify/shopifyStatusSyncClient.js';
import { projectAccurateStatusToShopify } from './accurateStatusMapper.js';
import { failedPayloadService } from './failedPayloadService.js';
import { shipmentRepository } from './shipmentRepository.js';
import { OdooSyncService } from '../odoo/odooSyncService.js';

const buildStatusNote = (params: {
  shipmentCode?: string | null;
  shipmentStatus: string;
  collectionStatus: string;
  collectedAmount?: number | null;
  pendingCollectionAmount?: number | null;
  returnedValue?: number | null;
  deliveryFees?: number | null;
  returnFees?: number | null;
  returningDueFees?: number | null;
  customerDue?: number | null;
  trackingUrl?: string | null;
}): string =>
  [
    `Accurate shipment sync`,
    `Shipment code: ${params.shipmentCode ?? 'n/a'}`,
    `Shipment status: ${params.shipmentStatus}`,
    `Collection status: ${params.collectionStatus}`,
    `Collected amount: ${params.collectedAmount ?? 0}`,
    `Pending collection amount: ${params.pendingCollectionAmount ?? 0}`,
    `Returned value: ${params.returnedValue ?? 0}`,
    `Delivery fees: ${params.deliveryFees ?? 0}`,
    `Return fees: ${params.returnFees ?? 0}`,
    `Returning due fees: ${params.returningDueFees ?? 0}`,
    `Customer due: ${params.customerDue ?? 0}`,
    params.trackingUrl ? `Tracking URL: ${params.trackingUrl}` : undefined
  ]
    .filter(Boolean)
    .join('\n');

export class ShipmentStatusSyncService {
  constructor(
    private readonly accurateClient: AccurateClient,
    private readonly odooSyncService?: OdooSyncService
  ) {}

  /**
   * PERMANENT FIX (C): detect collections via the working `listShipments` API
   * instead of the unauthorized `getShipment`. For each delivered+collected
   * shipment that has a DB record but no Odoo invoice/payment yet, write the
   * collection snapshot, create the Odoo invoice+payment, and mark Shopify paid.
   *
   * Time-budgeted for Netlify; processes up to `maxActions` per run. Returns a
   * summary. Designed to run on a cron — keeps collections recorded going forward.
   */
  async syncCollectionsFromReports(opts: { maxActions?: number; budgetMs?: number } = {}): Promise<{ scanned: number; recorded: number; shopifyPaid: number; skipped: number; notInDb: number; failed: number }> {
    const maxActions = opts.maxActions ?? 6;
    const budgetMs = opts.budgetMs ?? 23_000;
    const start = Date.now();
    const DELIVERED = new Set(['DTR']);
    const summary = { scanned: 0, recorded: 0, shopifyPaid: 0, skipped: 0, notInDb: 0, failed: 0 };
    if (!this.odooSyncService) return summary;

    let page = 1;
    let actions = 0;
    while (actions < maxActions && Date.now() - start < budgetMs) {
      const res = await this.accurateClient.listShipments({}, 100, page);
      const rows = res.data ?? [];
      if (rows.length === 0) break;

      for (const sh of rows) {
        summary.scanned++;
        const code = sh.code;
        const ref = sh.refNumber ?? null;
        const isOurs = /^VI\d/i.test(code) || (ref ? /viola/i.test(ref) : false);
        if (!isOurs) continue;
        if (!DELIVERED.has((sh.status?.code ?? '').toUpperCase()) || Number(sh.collectedAmount ?? 0) <= 0) continue;

        // Find DB record by code, then by refNumber → order number.
        let rec = await shipmentRepository.findByReference(code);
        if (!rec && ref) {
          const m = ref.match(/(\d{3,})\s*$/);
          if (m) rec = await shipmentRepository.findByShopifyOrderName('#' + m[1]);
        }
        if (!rec) { summary.notInDb++; continue; }
        if (rec.odooInvoiceId && (rec.odooPaymentId || rec.odooSalePaymentId)) { summary.skipped++; continue; }
        if (actions >= maxActions || Date.now() - start >= budgetMs) break;

        try {
          await shipmentRepository.updateAccurateSnapshot(rec.id, {
            accurateStatus: 'تم التسليم', accurateStatusCode: sh.status?.code ?? 'DTR',
            collectionStatus: 'collected',
            collectedAmount: Number(sh.collectedAmount ?? 0),
            pendingCollectionAmount: Number(sh.pendingCollectionAmount ?? 0),
            returnedValue: Number(sh.returnedValue ?? 0),
            deliveryFees: Number(sh.deliveryFees ?? 0),
            customerDue: Number(sh.customerDue ?? 0),
            deliveredAt: sh.deliveredOrReturnedDate ? new Date(sh.deliveredOrReturnedDate) : null
          });
          await this.odooSyncService.syncCollectedShipment(rec.id);
          summary.recorded++;
          actions++;
          try {
            await this.recordShopifyPayment({ id: rec.id, shopifyOrderId: rec.shopifyOrderId }, Number(sh.collectedAmount ?? 0));
            summary.shopifyPaid++;
          } catch { /* shopify discount scope etc. — Odoo already recorded */ }
        } catch (e) {
          summary.failed++;
          logger.error('syncCollectionsFromReports: failed', { code, reason: e instanceof Error ? e.message : String(e) });
        }
      }
      if (!res.paginatorInfo?.hasMorePages) break;
      page++;
    }
    logger.info('syncCollectionsFromReports: done', summary);
    return summary;
  }

  async syncRecord(record: {
    id: number;
    shopifyOrderId: string;
    accurateShipmentId?: number | null;
    accurateShipmentCode?: string | null;
  }): Promise<void> {
    if (!record.accurateShipmentId && !record.accurateShipmentCode) {
      return;
    }

    let shipment: Awaited<ReturnType<typeof this.accurateClient.getShipment>>;
    try {
      shipment = await this.accurateClient.getShipment({
        id: record.accurateShipmentId ?? undefined,
        code: record.accurateShipmentCode ?? undefined
      });
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        // This Telegraph account is write/list-only: getShipment (single read) is
        // unauthorized. Fall back to the AUTHORIZED listShipments(search) API to
        // fetch this one shipment, so the webhook (event-driven) and cron paths
        // both still work instead of silently skipping.
        const searchKey = record.accurateShipmentCode ?? String(record.accurateShipmentId ?? '');
        const list = await this.accurateClient.listShipments({ search: searchKey }, 20, 1);
        const match = (list.data ?? []).find((s) =>
          (record.accurateShipmentCode != null && s.code === record.accurateShipmentCode) ||
          (record.accurateShipmentId != null && Number(s.id) === Number(record.accurateShipmentId))
        );
        if (!match) {
          logger.warn('syncRecord: shipment not found via listShipments fallback — skipping this run', {
            recordId: record.id,
            shipmentCode: record.accurateShipmentCode,
            shipmentId: record.accurateShipmentId
          });
          return;
        }
        shipment = match;
      } else {
        throw error;
      }
    }

    if (!shipment) {
      throw new Error(`Accurate shipment not found for record ${record.id}`);
    }

    const projection = projectAccurateStatusToShopify({
      statusCode: shipment.status?.code,
      statusName: shipment.status?.name,
      returnStatusCode: shipment.returnStatus?.code,
      returnStatusName: shipment.returnStatus?.name,
      collected: shipment.collected,
      paidToCustomer: shipment.paidToCustomer,
      cancelled: shipment.cancelled,
      customerDue: shipment.customerDue
    });

    await shipmentRepository.updateAccurateSnapshot(record.id, {
      accurateStatus: projection.shipmentStatus,
      accurateStatusCode: shipment.status?.code ?? null,
      accurateReturnStatus: shipment.returnStatus?.name ?? shipment.returnStatus?.code ?? null,
      accurateReturnStatusCode: shipment.returnStatus?.code ?? null,
      accurateIsTerminal: projection.isTerminal,
      collectionStatus: projection.collectionStatus,
      trackingUrl: shipment.trackingUrl,
      collectedAmount: shipment.collectedAmount,
      pendingCollectionAmount: shipment.pendingCollectionAmount,
      returnedValue: shipment.returnedValue,
      deliveryFees: shipment.deliveryFees,
      returnFees: shipment.returnFees,
      returningDueFees: shipment.returningDueFees,
      customerDue: shipment.customerDue,
      deliveredAt: shipment.deliveredOrReturnedDate ? new Date(shipment.deliveredOrReturnedDate) : null
    });

    await shopifyStatusSyncClient.syncShipmentState({
      orderId: record.shopifyOrderId,
      shipmentStatus: projection.shipmentStatus,
      collectionStatus: projection.collectionStatus,
      collectedAmount: shipment.collectedAmount,
      returnedValue: shipment.returnedValue,
      trackingUrl: shipment.trackingUrl,
      tags: projection.tags,
      syncSummary: buildStatusNote({
        shipmentCode: shipment.code,
        shipmentStatus: projection.shipmentStatus,
        collectionStatus: projection.collectionStatus,
        collectedAmount: shipment.collectedAmount,
        pendingCollectionAmount: shipment.pendingCollectionAmount,
        returnedValue: shipment.returnedValue,
        deliveryFees: shipment.deliveryFees,
        returnFees: shipment.returnFees,
        returningDueFees: shipment.returningDueFees,
        customerDue: shipment.customerDue,
        trackingUrl: shipment.trackingUrl
      })
    });

    if (projection.collectionStatus === 'payment-review') {
      await failedPayloadService.save({
        source: 'payment-review',
        externalId: record.shopifyOrderId,
        reason: 'Telegraph delivered shipment needs manual payment review',
        payload: {
          record,
          shipment: {
            code: shipment.code,
            statusCode: shipment.status?.code,
            customerDue: shipment.customerDue,
            collectedAmount: shipment.collectedAmount,
            deliveryFees: shipment.deliveryFees,
            returnFees: shipment.returnFees,
            returningDueFees: shipment.returningDueFees
          }
        }
      });
      return;
    }

    if (projection.collectionStatus === 'collected' && this.odooSyncService) {
      try {
        await this.odooSyncService.syncCollectedShipment(record.id);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Unknown Odoo sync error';
        logger.error('Failed to sync collected shipment to Odoo', {
          recordId: record.id,
          shopifyOrderId: record.shopifyOrderId,
          reason
        });
        await failedPayloadService.save({
          source: 'odoo-collected-sync',
          externalId: record.shopifyOrderId,
          reason,
          payload: record
        });
      }
    }

    if (projection.collectionStatus === 'collected') {
      await this.recordShopifyPayment(record, Number(shipment.collectedAmount ?? 0));
    }

    if (projection.collectionStatus === 'returned' || projection.collectionStatus === 'returned-settled') {
      if (this.odooSyncService) {
        try {
          await this.odooSyncService.syncReturnedShipmentCharge(record.id);
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'Unknown Odoo return charge sync error';
          logger.error('Failed to sync returned shipment charge to Odoo', {
            recordId: record.id, shopifyOrderId: record.shopifyOrderId, reason
          });
          await failedPayloadService.save({
            source: 'odoo-return-charge-sync', externalId: record.shopifyOrderId, reason, payload: record
          });
        }
      }
      await this.cancelShopifyOrderForReturn(record, projection.collectionStatus);
    }

    if (projection.collectionStatus === 'delivered-not-collected') {
      await this.flagShopifyOrderNotCollected(record);
    }
  }

  /**
   * Phase 1 + discount-aware Shopify payment recording.
   * - Compares the actual collected amount with the Shopify order total.
   * - Equal (or higher) → straight SALE transaction for the total.
   * - Lower → add a line-item discount for the gap, then SALE for collected.
   * - Idempotent: fetchOrderPaymentState skips already-paid orders.
   */
  private async recordShopifyPayment(record: { id: number; shopifyOrderId: string }, collectedAmount: number): Promise<void> {
    try {
      const first = await shopifyStatusSyncClient.recordCustomerPayment({
        orderId: record.shopifyOrderId,
        amount: collectedAmount
      });
      if (first.skipped) {
        if (first.reason === 'needs-discount' && first.needsDiscountFor && first.total) {
          // Phase 1 (Case B): collected < shopifyTotal → apply discount + pay collected
          try {
            await shopifyStatusSyncClient.applyOrderDiscountAndPay({
              orderId: record.shopifyOrderId,
              discountAmount: first.needsDiscountFor,
              paymentAmount: collectedAmount,
              discountDescription: 'Telegraph collection adjustment'
            });
            logger.info('Shopify discount applied + payment recorded', {
              shopifyOrderId: record.shopifyOrderId,
              total: first.total,
              discount: first.needsDiscountFor,
              paid: collectedAmount
            });
          } catch (discountError) {
            const reason = discountError instanceof Error ? discountError.message : 'Unknown discount error';
            logger.error('Failed to apply Shopify discount before payment', {
              recordId: record.id, shopifyOrderId: record.shopifyOrderId, reason
            });
            await failedPayloadService.save({
              source: 'shopify-mark-as-paid', externalId: record.shopifyOrderId, reason, payload: record
            });
          }
        } else {
          logger.info('Shopify payment skipped', { shopifyOrderId: record.shopifyOrderId, reason: first.reason });
        }
      } else {
        logger.info('Shopify payment recorded', {
          shopifyOrderId: record.shopifyOrderId, transactionId: first.transactionId, amount: collectedAmount
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown Shopify payment recording error';
      logger.error('Failed to record Shopify customer payment', {
        recordId: record.id, shopifyOrderId: record.shopifyOrderId, reason
      });
      await failedPayloadService.save({
        source: 'shopify-mark-as-paid', externalId: record.shopifyOrderId, reason, payload: record
      });
    }
  }

  /** Phase 2: cancel a Shopify order when Telegraph returns it. Idempotent. */
  private async cancelShopifyOrderForReturn(
    record: { id: number; shopifyOrderId: string },
    collectionStatus: string
  ): Promise<void> {
    try {
      const result = await shopifyStatusSyncClient.cancelOrder({
        orderId: record.shopifyOrderId,
        reason: 'OTHER',
        refund: false,
        restock: true,
        notifyCustomer: false,
        staffNote: 'Telegraph returned shipment (' + collectionStatus + ')'
      });
      if (result.skipped) {
        logger.info('Shopify cancel skipped', { shopifyOrderId: record.shopifyOrderId, reason: result.reason });
      } else {
        logger.info('Shopify order cancelled for return', { shopifyOrderId: record.shopifyOrderId, collectionStatus });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown Shopify cancel error';
      logger.error('Failed to cancel Shopify order for return', {
        recordId: record.id, shopifyOrderId: record.shopifyOrderId, reason
      });
      await failedPayloadService.save({
        source: 'shopify-order-cancel', externalId: record.shopifyOrderId, reason, payload: record
      });
    }
  }

  /** Phase 2: flag a delivered-but-not-collected order for human follow-up. */
  private async flagShopifyOrderNotCollected(record: { id: number; shopifyOrderId: string }): Promise<void> {
    try {
      await shopifyStatusSyncClient.flagOrderForFollowUp({
        orderId: record.shopifyOrderId,
        note: '⚠️ Telegraph delivered but customer did not pay. Business follow-up required.',
        tag: 'needs-collection-followup'
      });
      logger.warn('Shopify order flagged for not-collected', { shopifyOrderId: record.shopifyOrderId });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown Shopify flag error';
      logger.error('Failed to flag Shopify order as not-collected', {
        recordId: record.id, shopifyOrderId: record.shopifyOrderId, reason
      });
      await failedPayloadService.save({
        source: 'shopify-order-flag', externalId: record.shopifyOrderId, reason, payload: record
      });
    }
  }

  private async syncCollectedFinancials(record: {
    id: number;
    shopifyOrderId: string;
  }): Promise<void> {
    if (this.odooSyncService) {
      try {
        await this.odooSyncService.syncCollectedShipment(record.id);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Unknown Odoo sync error';
        logger.error('Failed to sync collected payment entry to Odoo', {
          recordId: record.id,
          shopifyOrderId: record.shopifyOrderId,
          reason
        });
        await failedPayloadService.save({
          source: 'odoo-collected-sync',
          externalId: record.shopifyOrderId,
          reason,
          payload: record
        });
      }
    }

    try {
      // For payment-entry-driven sync the actual collected amount lives on the DB record.
      const dbRec = await shipmentRepository.findById(record.id);
      const collectedAmount = Number(dbRec?.collectedAmount ?? 0);
      if (collectedAmount > 0) {
        await this.recordShopifyPayment({ id: record.id, shopifyOrderId: record.shopifyOrderId }, collectedAmount);
        return;
      }
      logger.info('Shopify payment skipped from financials path (no collectedAmount)', {
        shopifyOrderId: record.shopifyOrderId
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown Shopify mark-as-paid error';
      logger.error('Failed to mark Shopify order as paid from payment entry', {
        recordId: record.id,
        shopifyOrderId: record.shopifyOrderId,
        reason
      });
      await failedPayloadService.save({
        source: 'shopify-mark-as-paid',
        externalId: record.shopifyOrderId,
        reason,
        payload: record
      });
    }
  }

  private async syncApprovedPaymentEntry(entry: AccuratePaymentShipmentEntry): Promise<'processed' | 'skipped'> {
    const shipment = entry.shipment;
    if (!shipment?.code) return 'skipped';

    const entryAmount = Number(entry.amount ?? 0);
    const customerDue = Number(shipment.customerDue ?? 0);
    const isPositiveDeliveredPayment =
      entryAmount > 0 &&
      customerDue > 0 &&
      shipment.status?.code?.toUpperCase() === 'DTR';

    if (!isPositiveDeliveredPayment) {
      return 'skipped';
    }

    const [record] = await shipmentRepository.findByShipmentCodes([shipment.code]);
    if (!record) {
      return 'skipped';
    }

    const projection = projectAccurateStatusToShopify({
      statusCode: shipment.status?.code,
      statusName: shipment.status?.name,
      returnStatusCode: shipment.returnStatus?.code,
      returnStatusName: shipment.returnStatus?.name,
      collected: true,
      paidToCustomer: shipment.paidToCustomer,
      cancelled: shipment.cancelled,
      customerDue: shipment.customerDue
    });

    await shipmentRepository.updateAccurateSnapshot(record.id, {
      accurateStatus: projection.shipmentStatus,
      accurateStatusCode: shipment.status?.code ?? null,
      accurateReturnStatus: shipment.returnStatus?.name ?? shipment.returnStatus?.code ?? null,
      accurateReturnStatusCode: shipment.returnStatus?.code ?? null,
      accurateIsTerminal: projection.isTerminal,
      collectionStatus: 'collected',
      trackingUrl: shipment.trackingUrl,
      collectedAmount: shipment.collectedAmount,
      pendingCollectionAmount: shipment.pendingCollectionAmount,
      returnedValue: shipment.returnedValue,
      deliveryFees: shipment.deliveryFees,
      returnFees: shipment.returnFees,
      returningDueFees: shipment.returningDueFees,
      customerDue: shipment.customerDue,
      deliveredAt: shipment.deliveredOrReturnedDate ? new Date(shipment.deliveredOrReturnedDate) : null
    });

    try {
      await shopifyStatusSyncClient.syncShipmentState({
        orderId: record.shopifyOrderId,
        shipmentStatus: projection.shipmentStatus,
        collectionStatus: 'collected',
        collectedAmount: shipment.collectedAmount,
        returnedValue: shipment.returnedValue,
        trackingUrl: shipment.trackingUrl,
        tags: projection.tags,
        syncSummary: buildStatusNote({
          shipmentCode: shipment.code,
          shipmentStatus: projection.shipmentStatus,
          collectionStatus: 'collected',
          collectedAmount: shipment.collectedAmount,
          pendingCollectionAmount: shipment.pendingCollectionAmount,
          returnedValue: shipment.returnedValue,
          deliveryFees: shipment.deliveryFees,
          returnFees: shipment.returnFees,
          returningDueFees: shipment.returningDueFees,
          customerDue: shipment.customerDue,
          trackingUrl: shipment.trackingUrl
        })
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown Shopify status sync error';
      logger.error('Failed to update Shopify shipment state from payment entry; continuing Odoo financial sync', {
        recordId: record.id,
        shopifyOrderId: record.shopifyOrderId,
        shipmentCode: shipment.code,
        reason
      });
      await failedPayloadService.save({
        source: 'shopify-status-from-payment-entry',
        externalId: record.shopifyOrderId,
        reason,
        payload: { record, shipment }
      });
    }

    const refreshedRecord = await shipmentRepository.findById(record.id);
    await this.syncCollectedFinancials(refreshedRecord ?? record);
    return 'processed';
  }

  async syncApprovedPayment(paymentId: number, options?: {
    startedAt?: number;
    budgetMs?: number;
    maxEntries?: number;
  }): Promise<{ paymentId: number; processed: number; skipped: number; failed: number }> {
    const startedAt = options?.startedAt ?? Date.now();
    const budgetMs = options?.budgetMs ?? env.syncTimeBudgetMs;
    const maxEntries = options?.maxEntries ?? 250;
    let page = 1;
    let seen = 0;
    let processed = 0;
    let skipped = 0;
    let failed = 0;

    while (seen < maxEntries && Date.now() - startedAt < budgetMs) {
      const result = await this.accurateClient.listShipmentsForPayment(paymentId, 100, page);
      for (const entry of result.data) {
        if (seen >= maxEntries || Date.now() - startedAt >= budgetMs) break;
        seen += 1;
        try {
          const status = await this.syncApprovedPaymentEntry(entry);
          if (status === 'processed') processed += 1;
          else skipped += 1;
        } catch (error) {
          failed += 1;
          const reason = error instanceof Error ? error.message : 'Unknown payment entry sync error';
          logger.error('Failed to sync Telegraph payment entry', {
            paymentId,
            shipmentCode: entry.shipment?.code,
            reason
          });
          await failedPayloadService.save({
            source: 'accurate-payment-entry-sync',
            externalId: entry.shipment?.code ?? String(paymentId),
            reason,
            payload: { paymentId, entry }
          });
        }
      }
      if (!result.paginatorInfo.hasMorePages) break;
      page += 1;
    }

    return { paymentId, processed, skipped, failed };
  }

  async syncRecentApprovedPayments(options?: {
    startedAt?: number;
    budgetMs?: number;
    maxPayments?: number;
  }): Promise<{ paymentsChecked: number; processed: number; skipped: number; failed: number }> {
    const startedAt = options?.startedAt ?? Date.now();
    const budgetMs = options?.budgetMs ?? env.syncTimeBudgetMs;
    const maxPayments = options?.maxPayments ?? 3;
    const fromDate = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString().slice(0, 10);
    const toDate = new Date().toISOString().slice(0, 10);
    const payments = await this.accurateClient.listPayments({
      typeCode: 'CUSTM',
      approved: true,
      glApproved: true,
      fromDate,
      toDate
    }, maxPayments, 1);

    let paymentsChecked = 0;
    let processed = 0;
    let skipped = 0;
    let failed = 0;
    for (const payment of payments.data.slice(0, maxPayments)) {
      if (Date.now() - startedAt >= budgetMs) break;
      paymentsChecked += 1;
      const result = await this.syncApprovedPayment(payment.id, {
        startedAt,
        budgetMs,
        maxEntries: 250
      });
      processed += result.processed;
      skipped += result.skipped;
      failed += result.failed;
    }

    return { paymentsChecked, processed, skipped, failed };
  }

  async syncOpenShipments(): Promise<{ processed: number; failed: number; skipped: number }> {
    // Time-budget guard: stop before Netlify cuts us off.
    // Records not reached this run remain open and retry next scheduled run.
    const budgetMs = env.syncTimeBudgetMs;
    const startTime = Date.now();

    // Concurrency: process up to 5 shipments in parallel per batch.
    // Each syncRecord is independent (separate SO / invoice / payment) so parallel is safe.
    // Running in parallel means 5 shipments complete in the time of the slowest one (~4s)
    // instead of ~20s sequentially — safely within the 23s budget.
    const CONCURRENCY = 5;

    const openShipments = await shipmentRepository.findOpenShipments(env.syncOpenShipmentsBatchSize);
    let processed = 0;
    let failed = 0;
    let skipped = 0;

    for (let i = 0; i < openShipments.length; i += CONCURRENCY) {
      const elapsedMs = Date.now() - startTime;
      if (elapsedMs >= budgetMs) {
        skipped = openShipments.length - processed - failed;
        logger.warn('syncOpenShipments time budget exhausted — stopping early; skipped records will retry next run', {
          processed,
          failed,
          skipped,
          elapsedMs,
          budgetMs
        });
        break;
      }

      const batch = openShipments.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map((record) => this.syncRecord(record)));

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        const record = batch[j];
        if (result.status === 'fulfilled') {
          processed += 1;
        } else {
          failed += 1;
          const reason = result.reason instanceof Error ? result.reason.message : 'Unknown sync error';
          logger.error('Failed to sync shipment record', { recordId: record.id, reason });
          if (/shipment not found/i.test(reason)) {
            await shipmentRepository.clearDeletedShipment(record.shopifyOrderId, reason);
          }
          await failedPayloadService.save({
            source: 'accurate-polling-sync',
            externalId: record.accurateShipmentCode ?? String(record.accurateShipmentId ?? record.id),
            reason,
            payload: record
          });
        }
      }
    }

    if (Date.now() - startTime < budgetMs) {
      const paymentSync = await this.syncRecentApprovedPayments({
        startedAt: startTime,
        budgetMs
      });
      logger.info('Approved Telegraph payment sync completed', paymentSync);
      processed += paymentSync.processed;
      skipped += paymentSync.skipped;
      failed += paymentSync.failed;
    }

    logger.info('syncOpenShipments complete', { processed, failed, skipped, elapsedMs: Date.now() - startTime });
    return { processed, failed, skipped };
  }
}
