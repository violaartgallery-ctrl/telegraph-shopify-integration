import { createHash } from 'node:crypto';
import {
  AccurateClient,
  type AccuratePaymentShipmentEntry,
  type AccurateShipmentSummary
} from '../accurate/accurateClient.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { UnauthorizedError } from '../lib/errors.js';
import { shopifyStatusSyncClient } from '../shopify/shopifyStatusSyncClient.js';
import { projectAccurateStatusToShopify } from './accurateStatusMapper.js';
import { failedPayloadService } from './failedPayloadService.js';
import { shipmentRepository } from './shipmentRepository.js';
import { calculateTelegraphReturnCharge, OdooSyncService } from '../odoo/odooSyncService.js';
import type { AccurateSnapshotData } from './shipmentRepository.js';
import type { MetaDeliveryService, MetaDeliverySource } from '../meta/metaDeliveryService.js';

const RETURNED_STATUS_CODES = new Set(['RTRN', 'RTS', 'RJCT']);

const normalizedNumber = (value?: number | null): string | null => {
  if (value === undefined || value === null || !Number.isFinite(Number(value))) return null;
  return Number(value).toFixed(2);
};

const fingerprint = (parts: unknown[]): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex');

export const buildReturnSyncFingerprint = (shipment: Pick<AccurateShipmentSummary,
  'code' | 'deliveredOrReturnedDate' | 'paidToCustomer' | 'customerDue' |
  'returnFees' | 'returningDueFees' | 'returnedValue' | 'status' | 'returnStatus'
>): string => fingerprint([
  'return-v1',
  shipment.code,
  shipment.status?.code?.trim().toUpperCase() ?? null,
  shipment.returnStatus?.code?.trim().toUpperCase() ?? null,
  shipment.deliveredOrReturnedDate ?? null,
  Boolean(shipment.paidToCustomer),
  normalizedNumber(shipment.customerDue),
  normalizedNumber(shipment.returnFees),
  normalizedNumber(shipment.returningDueFees),
  normalizedNumber(shipment.returnedValue)
]);

export const buildShopifyPaymentFingerprint = (collectedAmount: number): string =>
  fingerprint(['shopify-payment-v1', normalizedNumber(collectedAmount)]);

const sleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, ms));

const actualShipmentDates = (shipment: {
  deliveredOrReturnedDate?: string | null;
  status?: { code?: string | null } | null;
  returnStatus?: { code?: string | null } | null;
}): Pick<AccurateSnapshotData, 'deliveredAt' | 'returnedAt'> => {
  if (!shipment.deliveredOrReturnedDate) return {};
  const actualAt = new Date(shipment.deliveredOrReturnedDate);
  if (Number.isNaN(actualAt.getTime())) return {};
  const statusCode = shipment.status?.code?.trim().toUpperCase() ?? '';
  const returnStatusCode = shipment.returnStatus?.code?.trim().toUpperCase() ?? '';
  if (RETURNED_STATUS_CODES.has(statusCode) || RETURNED_STATUS_CODES.has(returnStatusCode)) {
    return { returnedAt: actualAt };
  }
  return statusCode === 'DTR' ? { deliveredAt: actualAt } : {};
};

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
    private readonly odooSyncService?: OdooSyncService,
    private readonly metaDeliveryService?: MetaDeliveryService
  ) {}

  private async persistAccurateSnapshot(
    recordId: number,
    data: AccurateSnapshotData,
    source: Exclude<MetaDeliverySource, 'reconciliation'>
  ): Promise<void> {
    if (this.metaDeliveryService) {
      await this.metaDeliveryService.observeSnapshot(recordId, data, source);
      return;
    }
    await shipmentRepository.updateAccurateSnapshot(recordId, data);
  }

  /**
   * PERMANENT FIX (C): detect collections via the working `listShipments` API
   * instead of the unauthorized `getShipment`. For each delivered+collected
   * shipment that has a DB record but no Odoo invoice/payment yet, write the
   * collection snapshot, create the Odoo invoice+payment, and mark Shopify paid.
   *
   * Time-budgeted for Netlify; processes up to `maxActions` per run. Returns a
   * summary. Designed to run on a cron — keeps collections recorded going forward.
   */
  async syncCollectionsFromReports(opts: { maxActions?: number; budgetMs?: number } = {}): Promise<{
    scanned: number;
    recorded: number;
    shopifyPaid: number;
    shopifyQueued: number;
    skipped: number;
    notInDb: number;
    failed: number;
  }> {
    const maxActions = opts.maxActions ?? 6;
    const budgetMs = opts.budgetMs ?? 23_000;
    const start = Date.now();
    const DELIVERED = new Set(['DTR']);
    const summary = { scanned: 0, recorded: 0, shopifyPaid: 0, shopifyQueued: 0, skipped: 0, notInDb: 0, failed: 0 };
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
        const reportStatusCode = (sh.status?.code ?? '').toUpperCase();
        const reportReturnCode = (sh.returnStatus?.code ?? '').toUpperCase();
        const reportProjection = projectAccurateStatusToShopify({
          statusCode: sh.status?.code,
          statusName: sh.status?.name,
          returnStatusCode: sh.returnStatus?.code,
          returnStatusName: sh.returnStatus?.name,
          collected: true,
          paidToCustomer: sh.paidToCustomer,
          cancelled: sh.cancelled,
          customerDue: sh.customerDue
        });
        if (
          !DELIVERED.has(reportStatusCode) ||
          RETURNED_STATUS_CODES.has(reportReturnCode) ||
          reportProjection.collectionStatus !== 'collected' ||
          Number(sh.collectedAmount ?? 0) <= 0
        ) continue;

        // Find DB record by code, then by refNumber → order number.
        let rec = await shipmentRepository.findByReference(code);
        if (!rec && ref) {
          const m = ref.match(/(\d{3,})\s*$/);
          if (m) rec = await shipmentRepository.findByShopifyOrderName('#' + m[1]);
        }
        if (!rec) { summary.notInDb++; continue; }
        if (actions >= maxActions || Date.now() - start >= budgetMs) break;

        try {
          await this.persistAccurateSnapshot(rec.id, {
            accurateStatus: 'تم التسليم', accurateStatusCode: sh.status?.code ?? 'DTR',
            accurateReturnStatus: sh.returnStatus?.name ?? sh.returnStatus?.code ?? null,
            accurateReturnStatusCode: sh.returnStatus?.code ?? null,
            accurateIsTerminal: reportProjection.isTerminal,
            collectionStatus: reportProjection.collectionStatus,
            collectedAmount: Number(sh.collectedAmount ?? 0),
            pendingCollectionAmount: Number(sh.pendingCollectionAmount ?? 0),
            returnedValue: Number(sh.returnedValue ?? 0),
            deliveryFees: Number(sh.deliveryFees ?? 0),
            customerDue: Number(sh.customerDue ?? 0),
            ...actualShipmentDates(sh)
          }, 'accurate-report');
          await shipmentRepository.supersedeReturnSync(
            rec.id,
            'Superseded because Telegraph currently reports a collected delivery'
          );
          if (await shipmentRepository.queueShopifyPaymentSync(
            rec.id,
            buildShopifyPaymentFingerprint(Number(sh.collectedAmount ?? 0))
          )) {
            summary.shopifyQueued++;
          }
          // Meta must observe carrier truth even when accounting already finished.
          if (rec.odooInvoiceId && (rec.odooPaymentId || rec.odooSalePaymentId)) {
            summary.skipped++;
            continue;
          }
          if (!this.odooSyncService) {
            summary.skipped++;
            continue;
          }
          await this.odooSyncService.syncCollectedShipment(rec.id);
          summary.recorded++;
          actions++;
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

    await this.persistAccurateSnapshot(record.id, {
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
      ...actualShipmentDates(shipment)
    }, 'accurate-status');

    const isReturn = projection.collectionStatus === 'returned' ||
      projection.collectionStatus === 'returned-settled';
    if (isReturn) {
      await shipmentRepository.supersedeShopifyPaymentSync(
        record.id,
        'Superseded because Telegraph now reports an explicit return'
      );
    } else {
      await shipmentRepository.supersedeReturnSync(
        record.id,
        `Superseded because Telegraph now reports ${projection.collectionStatus}`
      );
      if (projection.collectionStatus !== 'collected') {
        await shipmentRepository.supersedeShopifyPaymentSync(
          record.id,
          `Superseded because Telegraph now reports ${projection.collectionStatus}`
        );
      }
    }

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
      await shipmentRepository.queueShopifyPaymentSync(
        record.id,
        buildShopifyPaymentFingerprint(Number(shipment.collectedAmount ?? 0))
      );
    }

    if (isReturn) {
      await shipmentRepository.queueReturnSync(record.id, buildReturnSyncFingerprint(shipment));
    }

    if (projection.collectionStatus === 'delivered-not-collected') {
      await this.flagShopifyOrderNotCollected(record);
    }
  }

  /** Execute one idempotent Shopify payment action and let the durable queue own retries. */
  private async performShopifyPayment(
    record: { id: number; shopifyOrderId: string },
    collectedAmount: number
  ): Promise<{ transactionId?: string; reason?: string }> {
    const first = await shopifyStatusSyncClient.recordCustomerPayment({
      orderId: record.shopifyOrderId,
      amount: collectedAmount
    });
    if (!first.skipped) {
      return { transactionId: first.transactionId };
    }
    if (first.reason === 'needs-discount' && first.needsDiscountFor && first.total && first.currencyCode) {
      const result = await shopifyStatusSyncClient.applyOrderDiscountAndPay({
        orderId: record.shopifyOrderId,
        discountAmount: first.needsDiscountFor,
        paymentAmount: collectedAmount,
        currencyCode: first.currencyCode,
        discountDescription: 'Telegraph collection adjustment'
      });
      logger.info('Shopify discount applied + payment recorded', {
        shopifyOrderId: record.shopifyOrderId,
        total: first.total,
        discount: first.needsDiscountFor,
        paid: collectedAmount
      });
      return { transactionId: result.transactionId };
    }
    if (first.reason === 'already-paid' || first.reason === 'order-cancelled') {
      return { reason: first.reason };
    }
    throw new Error(`Shopify payment was not recorded: ${first.reason ?? 'unknown reason'}`);
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

    // For payment-entry-driven sync the actual collected amount lives on the DB
    // record. Queue the Shopify side separately so a Shopify outage never rolls
    // back or delays the Odoo accounting result.
    const dbRec = await shipmentRepository.findById(record.id);
    const collectedAmount = Number(dbRec?.collectedAmount ?? 0);
    if (collectedAmount > 0) {
      await shipmentRepository.supersedeReturnSync(
        record.id,
        'Superseded because an approved Telegraph collection was received'
      );
      await shipmentRepository.queueShopifyPaymentSync(
        record.id,
        buildShopifyPaymentFingerprint(collectedAmount)
      );
      return;
    }
    logger.info('Shopify payment queue skipped from financials path (no collectedAmount)', {
      shopifyOrderId: record.shopifyOrderId
    });
  }

  /**
   * Scan Telegraph report pages for explicit returns. Matching is deliberately
   * by the exact shipment code stored in our DB; order-number/ref fallbacks are
   * not allowed in a financial recovery path.
   */
  async discoverReturnedShipmentsFromReports(options: {
    startPage?: number;
    pages?: number;
    first?: number;
    budgetMs?: number;
    apply?: boolean;
  } = {}): Promise<{
    apply: boolean;
    scanned: number;
    carrierReturns: number;
    exactMatches: number;
    needsSync: number;
    queued: number;
    alreadyComplete: number;
    notInDb: number;
    ambiguous: number;
    failed: number;
    nextPage: number | null;
    lastPage: number;
    scanComplete: boolean;
    elapsedMs: number;
  }> {
    const apply = options.apply ?? false;
    const startPage = Math.max(1, options.startPage ?? 1);
    const pages = Math.max(1, Math.min(options.pages ?? 1, 3));
    const first = Math.max(10, Math.min(options.first ?? 100, 100));
    const budgetMs = Math.max(10_000, Math.min(options.budgetMs ?? 70_000, 100_000));
    const startedAt = Date.now();
    const summary = {
      apply,
      scanned: 0,
      carrierReturns: 0,
      exactMatches: 0,
      needsSync: 0,
      queued: 0,
      alreadyComplete: 0,
      notInDb: 0,
      ambiguous: 0,
      failed: 0,
      nextPage: startPage as number | null,
      lastPage: startPage,
      scanComplete: false,
      elapsedMs: 0
    };

    for (let offset = 0; offset < pages; offset += 1) {
      if (offset > 0 && Date.now() - startedAt >= budgetMs) break;
      const page = startPage + offset;
      const result = await this.accurateClient.listShipments({}, first, page);
      summary.lastPage = result.paginatorInfo.lastPage;
      summary.scanned += result.data.length;
      const returned = result.data.filter((shipment) => {
        const statusCode = shipment.status?.code?.trim().toUpperCase() ?? '';
        const returnStatusCode = shipment.returnStatus?.code?.trim().toUpperCase() ?? '';
        return RETURNED_STATUS_CODES.has(statusCode) || RETURNED_STATUS_CODES.has(returnStatusCode);
      });
      summary.carrierReturns += returned.length;

      const codes = [...new Set(returned.map((shipment) => shipment.code).filter(Boolean))];
      const records = codes.length > 0 ? await shipmentRepository.findByShipmentCodes(codes) : [];
      const byCode = new Map<string, typeof records>();
      for (const record of records) {
        if (!record.accurateShipmentCode) continue;
        const matches = byCode.get(record.accurateShipmentCode) ?? [];
        matches.push(record);
        byCode.set(record.accurateShipmentCode, matches);
      }

      for (const shipment of returned) {
        const matches = byCode.get(shipment.code) ?? [];
        if (matches.length === 0) {
          summary.notInDb++;
          continue;
        }
        if (matches.length !== 1) {
          summary.ambiguous++;
          continue;
        }
        const record = matches[0]!;
        summary.exactMatches++;
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
        if (!['returned', 'returned-settled'].includes(projection.collectionStatus)) {
          summary.failed++;
          continue;
        }
        const returnFingerprint = buildReturnSyncFingerprint(shipment);
        const needsSync =
          !['returned', 'returned-settled'].includes(record.collectionStatus ?? '') ||
          record.returnSyncStatus !== 'completed' ||
          record.returnSyncFingerprint !== returnFingerprint;
        if (!needsSync) {
          summary.alreadyComplete++;
          continue;
        }
        summary.needsSync++;
        if (!apply) continue;

        try {
          await this.persistAccurateSnapshot(record.id, {
            accurateStatus: projection.shipmentStatus,
            accurateStatusCode: shipment.status?.code ?? null,
            accurateReturnStatus: shipment.returnStatus?.name ?? shipment.returnStatus?.code ?? null,
            accurateReturnStatusCode: shipment.returnStatus?.code ?? null,
            accurateIsTerminal: true,
            collectionStatus: projection.collectionStatus,
            trackingUrl: shipment.trackingUrl,
            collectedAmount: shipment.collectedAmount,
            pendingCollectionAmount: shipment.pendingCollectionAmount,
            returnedValue: shipment.returnedValue,
            deliveryFees: shipment.deliveryFees,
            returnFees: shipment.returnFees,
            returningDueFees: shipment.returningDueFees,
            customerDue: shipment.customerDue,
            ...actualShipmentDates(shipment)
          }, 'accurate-report');
          await shipmentRepository.supersedeShopifyPaymentSync(
            record.id,
            'Superseded because Telegraph report discovery confirmed an explicit return'
          );
          if (await shipmentRepository.queueReturnSync(record.id, returnFingerprint)) {
            summary.queued++;
          }
        } catch (error) {
          summary.failed++;
          await failedPayloadService.save({
            source: 'accurate-return-discovery',
            externalId: shipment.code,
            reason: error instanceof Error ? error.message : String(error),
            payload: { shipmentCode: shipment.code, recordId: record.id }
          });
        }
      }

      if (!result.paginatorInfo.hasMorePages) {
        summary.nextPage = null;
        summary.scanComplete = true;
        break;
      }
      summary.nextPage = page + 1;
    }

    summary.elapsedMs = Date.now() - startedAt;
    return summary;
  }

  /** Process claimed return actions. Odoo billing and Shopify cancellation are independently idempotent. */
  async processReturnQueue(options: { limit?: number; budgetMs?: number; apply?: boolean } = {}): Promise<{
    apply: boolean;
    found: number;
    processed: number;
    skipped: number;
    failed: number;
    recovered: number;
    remaining: number;
    hasMore: boolean;
    actions: Array<{ order: string; shipmentCode?: string | null; charge: number; status: string }>;
    elapsedMs: number;
  }> {
    const apply = options.apply ?? false;
    const limit = Math.max(1, Math.min(options.limit ?? 4, 10));
    const budgetMs = Math.max(10_000, Math.min(options.budgetMs ?? 70_000, 100_000));
    const startedAt = Date.now();
    const recovered = apply ? await shipmentRepository.recoverStuckReturnSync(10) : 0;
    const records = await shipmentRepository.findPendingReturnSync(limit);
    let processed = 0;
    let skipped = 0;
    let failed = 0;
    const actions: Array<{ order: string; shipmentCode?: string | null; charge: number; status: string }> = [];

    for (const candidate of records) {
      if (Date.now() - startedAt >= budgetMs) break;
      const charge = calculateTelegraphReturnCharge(candidate);
      const action = {
        order: candidate.shopifyOrderName ?? candidate.shopifyOrderId,
        shipmentCode: candidate.accurateShipmentCode,
        charge,
        status: apply ? 'pending' : 'preview'
      };
      actions.push(action);
      if (!apply) continue;
      if (!await shipmentRepository.claimReturnSync(candidate.id)) {
        skipped++;
        action.status = 'claimed-by-other';
        continue;
      }

      const record = await shipmentRepository.findById(candidate.id);
      if (!record || !['returned', 'returned-settled'].includes(record.collectionStatus ?? '')) {
        await shipmentRepository.supersedeReturnSync(
          candidate.id,
          'Superseded because the record no longer has an explicit returned collection status'
        );
        skipped++;
        action.status = 'superseded';
        continue;
      }

      const errors: string[] = [];
      const projection = projectAccurateStatusToShopify({
        statusCode: record.accurateStatusCode,
        statusName: record.accurateStatus,
        returnStatusCode: record.accurateReturnStatusCode,
        returnStatusName: record.accurateReturnStatus,
        paidToCustomer: record.collectionStatus === 'returned-settled',
        customerDue: record.customerDue
      });

      try {
        await shopifyStatusSyncClient.syncShipmentState({
          orderId: record.shopifyOrderId,
          shipmentStatus: projection.shipmentStatus,
          collectionStatus: record.collectionStatus!,
          collectedAmount: record.collectedAmount,
          returnedValue: record.returnedValue,
          trackingUrl: record.trackingUrl,
          tags: projection.tags,
          syncSummary: buildStatusNote({
            shipmentCode: record.accurateShipmentCode,
            shipmentStatus: projection.shipmentStatus,
            collectionStatus: record.collectionStatus!,
            collectedAmount: record.collectedAmount,
            pendingCollectionAmount: record.pendingCollectionAmount,
            returnedValue: record.returnedValue,
            deliveryFees: record.deliveryFees,
            returnFees: record.returnFees,
            returningDueFees: record.returningDueFees,
            customerDue: record.customerDue,
            trackingUrl: record.trackingUrl
          })
        });
      } catch (error) {
        errors.push(`Shopify status: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (charge > 0) {
        if (!this.odooSyncService) {
          errors.push('Odoo return-charge service is unavailable');
        } else {
          try {
            await this.odooSyncService.syncReturnedShipmentCharge(record.id);
          } catch (error) {
            errors.push(`Odoo return bill: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }

      try {
        await shopifyStatusSyncClient.cancelOrder({
          orderId: record.shopifyOrderId,
          reason: 'OTHER',
          refund: false,
          restock: true,
          notifyCustomer: false,
          staffNote: `Telegraph returned shipment (${record.collectionStatus})`
        });
        let state = await shopifyStatusSyncClient.fetchOrderPaymentState(record.shopifyOrderId);
        for (const delay of [500, 1_500, 2_500]) {
          if (state?.cancelledAt) break;
          await sleep(delay);
          state = await shopifyStatusSyncClient.fetchOrderPaymentState(record.shopifyOrderId);
        }
        if (!state?.cancelledAt) errors.push('Shopify cancellation was not confirmed');
      } catch (error) {
        errors.push(`Shopify cancel: ${error instanceof Error ? error.message : String(error)}`);
      }

      const after = await shipmentRepository.findById(record.id);
      if (charge > 0 && !after?.odooReturnBillId) {
        errors.push('Odoo return bill id was not persisted after billing');
      }

      if (errors.length > 0) {
        const reason = errors.join(' | ');
        await shipmentRepository.failReturnSync(record.id, reason);
        await failedPayloadService.save({
          source: 'return-sync-worker',
          externalId: record.accurateShipmentCode ?? record.shopifyOrderId,
          reason,
          payload: { recordId: record.id, shopifyOrderName: record.shopifyOrderName, charge }
        });
        failed++;
        action.status = 'retry-scheduled';
      } else {
        await shipmentRepository.completeReturnSync(record.id);
        processed++;
        action.status = 'completed';
      }
    }

    const remaining = await shipmentRepository.countDueReturnSync();
    return {
      apply,
      found: records.length,
      processed,
      skipped,
      failed,
      recovered,
      remaining,
      hasMore: remaining > 0,
      actions,
      elapsedMs: Date.now() - startedAt
    };
  }

  async processShopifyPaymentQueue(options: { limit?: number; budgetMs?: number; apply?: boolean } = {}): Promise<{
    apply: boolean;
    found: number;
    processed: number;
    skipped: number;
    failed: number;
    recovered: number;
    remaining: number;
    hasMore: boolean;
    actions: Array<{ order: string; amount: number; status: string }>;
    elapsedMs: number;
  }> {
    const apply = options.apply ?? false;
    const limit = Math.max(1, Math.min(options.limit ?? 6, 12));
    const budgetMs = Math.max(10_000, Math.min(options.budgetMs ?? 70_000, 100_000));
    const startedAt = Date.now();
    const recovered = apply ? await shipmentRepository.recoverStuckShopifyPaymentSync(10) : 0;
    const records = await shipmentRepository.findPendingShopifyPaymentSync(limit);
    let processed = 0;
    let skipped = 0;
    let failed = 0;
    const actions: Array<{ order: string; amount: number; status: string }> = [];

    for (const candidate of records) {
      if (Date.now() - startedAt >= budgetMs) break;
      const amount = Number(candidate.collectedAmount ?? 0);
      const action = {
        order: candidate.shopifyOrderName ?? candidate.shopifyOrderId,
        amount,
        status: apply ? 'pending' : 'preview'
      };
      actions.push(action);
      if (!apply) continue;
      if (!await shipmentRepository.claimShopifyPaymentSync(candidate.id)) {
        skipped++;
        action.status = 'claimed-by-other';
        continue;
      }

      const current = await shipmentRepository.findById(candidate.id);
      const currentAmount = Number(current?.collectedAmount ?? 0);
      const currentFingerprint = buildShopifyPaymentFingerprint(currentAmount);
      const explicitReturn = RETURNED_STATUS_CODES.has(current?.accurateStatusCode?.trim().toUpperCase() ?? '') ||
        RETURNED_STATUS_CODES.has(current?.accurateReturnStatusCode?.trim().toUpperCase() ?? '');
      if (!current || current.collectionStatus !== 'collected' || currentAmount <= 0 || explicitReturn) {
        await shipmentRepository.supersedeShopifyPaymentSync(
          candidate.id,
          'Superseded because the latest carrier snapshot is not a payable collection'
        );
        skipped++;
        action.status = 'superseded';
        continue;
      }
      if (current.shopifyPaymentFingerprint !== currentFingerprint) {
        await shipmentRepository.replaceClaimedShopifyPaymentSync(candidate.id, currentFingerprint);
        skipped++;
        action.amount = currentAmount;
        action.status = 'requeued-new-amount';
        continue;
      }
      action.amount = currentAmount;

      try {
        const result = await this.performShopifyPayment(current, currentAmount);
        const state = await shopifyStatusSyncClient.fetchOrderPaymentState(current.shopifyOrderId);
        const complete = Boolean(
          state?.cancelledAt ||
          (state?.displayFinancialStatus && /paid/i.test(state.displayFinancialStatus) && state.totalOutstanding <= 0.01)
        );
        if (!complete) {
          throw new Error(`Shopify payment not confirmed (status=${state?.displayFinancialStatus ?? 'missing'}, outstanding=${state?.totalOutstanding ?? 'n/a'})`);
        }
        await shipmentRepository.completeShopifyPaymentSync(candidate.id, result.transactionId);
        processed++;
        action.status = result.reason ?? 'completed';
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await shipmentRepository.failShopifyPaymentSync(candidate.id, reason);
        await failedPayloadService.save({
          source: 'shopify-payment-worker',
          externalId: current.shopifyOrderId,
          reason,
          payload: { recordId: current.id, shopifyOrderName: current.shopifyOrderName, amount: currentAmount }
        });
        failed++;
        action.status = 'retry-scheduled';
      }
    }

    const remaining = await shipmentRepository.countDueShopifyPaymentSync();
    return {
      apply,
      found: records.length,
      processed,
      skipped,
      failed,
      recovered,
      remaining,
      hasMore: remaining > 0,
      actions,
      elapsedMs: Date.now() - startedAt
    };
  }

  async getFinancialQueueHealth() {
    return await shipmentRepository.getFinancialQueueHealth();
  }

  private async syncApprovedPaymentEntry(entry: AccuratePaymentShipmentEntry): Promise<'processed' | 'skipped'> {
    const shipment = entry.shipment;
    if (!shipment?.code) return 'skipped';

    const entryAmount = Number(entry.amount ?? 0);
    const customerDue = Number(shipment.customerDue ?? 0);
    const isPositiveDeliveredPayment =
      entryAmount > 0 &&
      customerDue > 0 &&
      shipment.status?.code?.toUpperCase() === 'DTR' &&
      !shipment.cancelled &&
      !RETURNED_STATUS_CODES.has(shipment.returnStatus?.code?.toUpperCase() ?? '');

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

    await this.persistAccurateSnapshot(record.id, {
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
      ...actualShipmentDates(shipment)
    }, 'accurate-payment');

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

  async syncOpenShipments(options: { budgetMs?: number; batchSize?: number } = {}): Promise<{ processed: number; failed: number; skipped: number }> {
    // Time-budget guard: stop well before the hosting request is cut off.
    // Records not reached this run remain open and retry next scheduled run.
    const budgetMs = Math.max(10_000, Math.min(options.budgetMs ?? env.syncTimeBudgetMs, 100_000));
    const startTime = Date.now();

    // Concurrency: process up to 5 shipments in parallel per batch.
    // Each syncRecord is independent (separate SO / invoice / payment) so parallel is safe.
    // Running in parallel means 5 shipments complete in the time of the slowest one (~4s)
    // instead of ~20s sequentially — safely within the 23s budget.
    const CONCURRENCY = 5;

    const batchSize = Math.max(1, Math.min(options.batchSize ?? env.syncOpenShipmentsBatchSize, 100));
    const openShipments = await shipmentRepository.findOpenShipments(batchSize);
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
