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
const RETURN_DISCOVERY_CURSOR = 'ops-return-discovery-page-v1';
const COLLECTION_DISCOVERY_CURSOR = 'ops-collection-discovery-page-v1';
const FIRST_HISTORICAL_PAGE = 2;

export const isLegacyNonShopifyShipmentCode = (code?: string | null): boolean =>
  /^VI0{5}\d+$/i.test(code?.trim() ?? '');

export const planHistoricalDiscoveryPages = (
  cursor: number,
  lastPage: number,
  maxPages: number
): { pages: number[]; nextPage: number; scanComplete: boolean } => {
  if (lastPage < FIRST_HISTORICAL_PAGE) {
    return { pages: [], nextPage: FIRST_HISTORICAL_PAGE, scanComplete: true };
  }
  if (maxPages <= 0) {
    return {
      pages: [],
      nextPage: cursor >= FIRST_HISTORICAL_PAGE && cursor <= lastPage
        ? cursor
        : FIRST_HISTORICAL_PAGE,
      scanComplete: false
    };
  }
  let page = cursor >= FIRST_HISTORICAL_PAGE && cursor <= lastPage
    ? cursor
    : FIRST_HISTORICAL_PAGE;
  const pages: number[] = [];
  let scanComplete = false;
  while (pages.length < maxPages && !scanComplete) {
    pages.push(page);
    if (page >= lastPage) {
      page = FIRST_HISTORICAL_PAGE;
      scanComplete = true;
    } else {
      page += 1;
    }
  }
  return { pages, nextPage: page, scanComplete };
};

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

export const buildOdooCollectionFingerprint = (input: {
  code?: string | null;
  collectedAmount?: number | null;
  deliveryFees?: number | null;
  customerDue?: number | null;
}): string => fingerprint([
  'odoo-collection-v1',
  input.code?.trim().toUpperCase() ?? null,
  normalizedNumber(input.collectedAmount),
  normalizedNumber(input.deliveryFees),
  normalizedNumber(input.customerDue)
]);

export const isCompletedCollectedDiscoveryReplay = (input: {
  record: {
    accurateStatus?: string | null;
    accurateStatusCode?: string | null;
    accurateReturnStatus?: string | null;
    accurateReturnStatusCode?: string | null;
    accurateIsTerminal?: boolean | null;
    collectionStatus?: string | null;
    trackingUrl?: string | null;
    collectedAmount?: number | null;
    pendingCollectionAmount?: number | null;
    returnedValue?: number | null;
    deliveryFees?: number | null;
    returnFees?: number | null;
    returningDueFees?: number | null;
    customerDue?: number | null;
    deliveredAt?: Date | null;
    returnSyncStatus?: string | null;
    shopifyPaymentSyncStatus?: string | null;
    shopifyPaymentFingerprint?: string | null;
    odooSyncStatus?: string | null;
    odooCollectionSyncStatus?: string | null;
    odooCollectionFingerprint?: string | null;
  };
  snapshot: AccurateSnapshotData;
  shopifyFingerprint: string;
  odooFingerprint: string;
}): boolean => {
  const { record, snapshot } = input;
  const sameNumber = (left?: number | null, right?: number | null) =>
    normalizedNumber(left) === normalizedNumber(right);
  const sameDate = (left?: Date | null, right?: Date | null) =>
    !right || Boolean(left && left.getTime() === right.getTime());
  const returnQueueIsInactive = !['pending', 'retryable', 'processing', 'failed']
    .includes(record.returnSyncStatus ?? '');
  const productionQueueIsReady =
    Boolean(record.odooSyncStatus) &&
    !['sales-order-created', 'sales-order-existing'].includes(record.odooSyncStatus ?? '');

  return (
    record.accurateStatus === snapshot.accurateStatus &&
    record.accurateStatusCode === snapshot.accurateStatusCode &&
    record.accurateReturnStatus === snapshot.accurateReturnStatus &&
    record.accurateReturnStatusCode === snapshot.accurateReturnStatusCode &&
    record.accurateIsTerminal === snapshot.accurateIsTerminal &&
    record.collectionStatus === snapshot.collectionStatus &&
    record.trackingUrl === snapshot.trackingUrl &&
    sameNumber(record.collectedAmount, snapshot.collectedAmount) &&
    sameNumber(record.pendingCollectionAmount, snapshot.pendingCollectionAmount) &&
    sameNumber(record.returnedValue, snapshot.returnedValue) &&
    sameNumber(record.deliveryFees, snapshot.deliveryFees) &&
    sameNumber(record.returnFees, snapshot.returnFees) &&
    sameNumber(record.returningDueFees, snapshot.returningDueFees) &&
    sameNumber(record.customerDue, snapshot.customerDue) &&
    sameDate(record.deliveredAt, snapshot.deliveredAt) &&
    returnQueueIsInactive &&
    record.shopifyPaymentSyncStatus !== null &&
    record.shopifyPaymentFingerprint === input.shopifyFingerprint &&
    productionQueueIsReady &&
    record.odooCollectionSyncStatus !== null &&
    record.odooCollectionFingerprint === input.odooFingerprint
  );
};

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

export type StatusPollingOutcome =
  | 'synced'
  | 'not-found'
  | 'skipped-legacy'
  | 'skipped-no-reference';

export interface StatusPollingRecordRef {
  id: number;
  shopifyOrderId: string;
  accurateShipmentId?: number | null;
  accurateShipmentCode?: string | null;
}

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
   * Discover collected deliveries only. Shopify payments and Odoo accounting
   * are processed by independent durable workers.
   *
   * Page 1 is always scanned for fresh events. Historical pages use a durable
   * checkpoint and advance only after a whole page has been persisted, making
   * connection-reset replays idempotent.
   */
  async discoverCollectedShipmentsFromReports(options: {
    historyPages?: number;
    first?: number;
    budgetMs?: number;
    apply?: boolean;
    durableCursor?: boolean;
  } = {}) {
    const apply = options.apply ?? false;
    const durableCursor = options.durableCursor ?? false;
    const historyPages = Math.max(0, Math.min(options.historyPages ?? 2, 5));
    const first = Math.max(10, Math.min(options.first ?? 100, 100));
    const budgetMs = Math.max(10_000, Math.min(options.budgetMs ?? 70_000, 100_000));
    const startedAt = Date.now();
    const summary = {
      apply,
      scanned: 0,
      carrierCollections: 0,
      exactMatches: 0,
      shopifyQueued: 0,
      odooQueued: 0,
      alreadyQueued: 0,
      notInDb: 0,
      ambiguous: 0,
      legacySkipped: 0,
      failed: 0,
      recentPages: [] as number[],
      recentSweepComplete: false,
      historicalPages: [] as number[],
      nextPage: FIRST_HISTORICAL_PAGE,
      lastPage: 1,
      scanComplete: false,
      elapsedMs: 0
    };

    const processPage = async (
      page: number,
      input: Record<string, unknown> = {},
      trackHistoricalPaginator = true
    ) => {
      const result = await this.accurateClient.listShipments(input, first, page);
      if (trackHistoricalPaginator) {
        summary.lastPage = result.paginatorInfo.lastPage;
      }
      summary.scanned += result.data.length;
      const collected = result.data.filter((shipment) => {
        const statusCode = shipment.status?.code?.trim().toUpperCase() ?? '';
        const returnStatusCode = shipment.returnStatus?.code?.trim().toUpperCase() ?? '';
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
        return statusCode === 'DTR' &&
          !RETURNED_STATUS_CODES.has(returnStatusCode) &&
          projection.collectionStatus === 'collected' &&
          Number(shipment.collectedAmount ?? 0) > 0;
      });
      summary.carrierCollections += collected.length;

      const eligible = collected.filter((shipment) => {
        if (!isLegacyNonShopifyShipmentCode(shipment.code)) return true;
        summary.legacySkipped++;
        return false;
      });
      const codes = [...new Set(eligible.map((shipment) => shipment.code).filter(Boolean))];
      const records = codes.length > 0
        ? await shipmentRepository.findFinancialMatchesByShipmentCodes(codes)
        : [];
      const byCode = new Map<string, typeof records>();
      for (const record of records) {
        if (!record.accurateShipmentCode) continue;
        const matches = byCode.get(record.accurateShipmentCode) ?? [];
        matches.push(record);
        byCode.set(record.accurateShipmentCode, matches);
      }

      // A page can contain many collected shipments. Process a small bounded
      // group in parallel so one historical page remains comfortably inside
      // the serverless request budget. Every record write and queue claim is
      // still independently idempotent.
      const collectionDiscoveryConcurrency = 20;
      for (let index = 0; index < eligible.length; index += collectionDiscoveryConcurrency) {
        const chunk = eligible.slice(index, index + collectionDiscoveryConcurrency);
        await Promise.all(chunk.map(async (shipment) => {
          const matches = byCode.get(shipment.code) ?? [];
          if (matches.length === 0) {
            summary.notInDb++;
            return;
          }
          if (matches.length !== 1) {
            summary.ambiguous++;
            return;
          }
          summary.exactMatches++;
          if (!apply) return;
          const record = matches[0]!;
          try {
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
            const snapshot: AccurateSnapshotData = {
              accurateStatus: projection.shipmentStatus,
              accurateStatusCode: shipment.status?.code ?? 'DTR',
              accurateReturnStatus: shipment.returnStatus?.name ?? shipment.returnStatus?.code ?? null,
              accurateReturnStatusCode: shipment.returnStatus?.code ?? null,
              accurateIsTerminal: projection.isTerminal,
              collectionStatus: 'collected',
              trackingUrl: shipment.trackingUrl,
              collectedAmount: Number(shipment.collectedAmount ?? 0),
              pendingCollectionAmount: Number(shipment.pendingCollectionAmount ?? 0),
              returnedValue: Number(shipment.returnedValue ?? 0),
              deliveryFees: Number(shipment.deliveryFees ?? 0),
              returnFees: Number(shipment.returnFees ?? 0),
              returningDueFees: Number(shipment.returningDueFees ?? 0),
              customerDue: Number(shipment.customerDue ?? 0),
              ...actualShipmentDates(shipment)
            };
            const shopifyFingerprint = buildShopifyPaymentFingerprint(
              Number(shipment.collectedAmount ?? 0)
            );
            const odooFingerprint = buildOdooCollectionFingerprint({
              code: shipment.code,
              collectedAmount: shipment.collectedAmount,
              deliveryFees: shipment.deliveryFees,
              customerDue: shipment.customerDue
            });
            if (isCompletedCollectedDiscoveryReplay({
              record,
              snapshot,
              shopifyFingerprint,
              odooFingerprint
            })) {
              summary.alreadyQueued++;
              return;
            }

            await this.persistAccurateSnapshot(record.id, snapshot, 'accurate-report');
            await shipmentRepository.supersedeReturnSync(
              record.id,
              'Superseded because Telegraph currently reports a collected delivery'
            );
            const shopifyQueued = await shipmentRepository.queueShopifyPaymentSync(
              record.id,
              shopifyFingerprint
            );
            const odooQueued = await shipmentRepository.queueOdooCollectionSync(
              record.id,
              odooFingerprint
            );
            await shipmentRepository.ensureCollectedProductionQueued(record.id);
            if (shopifyQueued) summary.shopifyQueued++;
            if (odooQueued) summary.odooQueued++;
            if (!shopifyQueued && !odooQueued) summary.alreadyQueued++;
          } catch (error) {
            summary.failed++;
            await failedPayloadService.save({
              source: 'accurate-collection-discovery',
              externalId: shipment.code,
              reason: error instanceof Error ? error.message : String(error),
              payload: { shipmentCode: shipment.code, recordId: record.id }
            });
          }
        }));
      }
      return result;
    };

    const hotPage = await processPage(1);
    const lastPage = hotPage.paginatorInfo.lastPage;

    // Shipment pages are ordered by creation, so an older shipment that is
    // collected or settled today can sit far from page 1. Telegraph can clear
    // `collected` after paying the merchant, therefore sweep both carrier flags
    // independently. The write path is idempotent when a row appears in both.
    try {
      const recentInputs = [
        {
          statusCode: ['DTR'],
          collected: true,
          lastTransactionDate: { fromDays: 2 }
        },
        {
          statusCode: ['DTR'],
          paid: true,
          lastTransactionDate: { fromDays: 2 }
        }
      ];
      let allRecentSweepsComplete = true;
      for (const recentInput of recentInputs) {
        if (Date.now() - startedAt >= budgetMs - 20_000) {
          allRecentSweepsComplete = false;
          break;
        }
        const recentFirst = await processPage(1, recentInput, false);
        if (!summary.recentPages.includes(1)) summary.recentPages.push(1);
        const recentLastPage = recentFirst.paginatorInfo.lastPage;
        let pagesCompleted = 1;
        for (let page = 2; page <= recentLastPage; page += 1) {
          if (Date.now() - startedAt >= budgetMs - 20_000) break;
          await processPage(page, recentInput, false);
          if (!summary.recentPages.includes(page)) summary.recentPages.push(page);
          pagesCompleted++;
        }
        if (pagesCompleted !== recentLastPage) allRecentSweepsComplete = false;
      }
      summary.recentSweepComplete = allRecentSweepsComplete;
    } catch (error) {
      summary.failed++;
      await failedPayloadService.save({
        source: 'accurate-recent-collection-discovery',
        reason: error instanceof Error ? error.message : String(error),
        payload: { fromDays: 2 }
      });
    }
    summary.lastPage = lastPage;

    const cursor = durableCursor
      ? await shipmentRepository.getOperationalCursor(COLLECTION_DISCOVERY_CURSOR, FIRST_HISTORICAL_PAGE)
      : FIRST_HISTORICAL_PAGE;
    const plan = planHistoricalDiscoveryPages(cursor, lastPage, historyPages);
    const historicalPageConcurrency = 1;
    for (let index = 0; index < plan.pages.length; index += historicalPageConcurrency) {
      // Keep a 20-second response/cleanup margin. A slow historical page must
      // never be started near the request deadline merely because a replayed
      // page happened to finish quickly.
      if (Date.now() - startedAt >= budgetMs - 20_000) break;
      const pageChunk = plan.pages.slice(index, index + historicalPageConcurrency);
      await Promise.all(pageChunk.map(async (page) => {
        await processPage(page);
      }));
      // Persist only completed contiguous pages. If a request is interrupted,
      // the unfinished chunk replays safely while earlier chunks stay saved.
      for (const page of pageChunk) {
        summary.historicalPages.push(page);
        summary.nextPage = page >= lastPage ? FIRST_HISTORICAL_PAGE : page + 1;
        if (apply && durableCursor) {
          await shipmentRepository.setOperationalCursor(COLLECTION_DISCOVERY_CURSOR, summary.nextPage);
        }
      }
    }
    summary.scanComplete =
      plan.scanComplete && summary.historicalPages.length === plan.pages.length;
    if (summary.historicalPages.length === plan.pages.length) {
      summary.nextPage = plan.nextPage;
    }
    summary.elapsedMs = Date.now() - startedAt;
    logger.info('discoverCollectedShipmentsFromReports: done', summary);
    return summary;
  }

  /** Compatibility entrypoint for any retired Netlify invocation. */
  async syncCollectionsFromReports(opts: { maxActions?: number; budgetMs?: number } = {}) {
    return await this.discoverCollectedShipmentsFromReports({
      historyPages: Math.max(1, Math.min(opts.maxActions ?? 2, 5)),
      budgetMs: opts.budgetMs,
      apply: true,
      durableCursor: true
    });
  }

  /**
   * Historical implementation retained temporarily for forensic comparison.
   * It is not called by production routes.
   *
   * PERMANENT FIX (C): detect collections via the working `listShipments` API
   * instead of the unauthorized `getShipment`. For each delivered+collected
   * shipment that has a DB record but no Odoo invoice/payment yet, write the
   * collection snapshot, create the Odoo invoice+payment, and mark Shopify paid.
   *
   * Time-budgeted for Netlify; processes up to `maxActions` per run. Returns a
   * summary. Designed to run on a cron — keeps collections recorded going forward.
   */
  private async syncCollectionsFromReportsLegacy(opts: { maxActions?: number; budgetMs?: number } = {}): Promise<{
    scanned: number;
    recorded: number;
    shopifyPaid: number;
    shopifyQueued: number;
    skipped: number;
    notInDb: number;
    ambiguous: number;
    failed: number;
  }> {
    const maxActions = opts.maxActions ?? 2;
    const budgetMs = opts.budgetMs ?? 23_000;
    const start = Date.now();
    const DELIVERED = new Set(['DTR']);
    const summary = {
      scanned: 0,
      recorded: 0,
      shopifyPaid: 0,
      shopifyQueued: 0,
      skipped: 0,
      notInDb: 0,
      ambiguous: 0,
      failed: 0
    };
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

        // Financial writes require the exact Telegraph shipment code stored for
        // the Shopify order. Never infer an order from a free-text reference.
        const exactMatches = await shipmentRepository.findByShipmentCodes([code]);
        if (exactMatches.length === 0) { summary.notInDb++; continue; }
        if (exactMatches.length !== 1) { summary.ambiguous++; continue; }
        const rec = exactMatches[0]!;
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

  async syncRecord(record: StatusPollingRecordRef): Promise<StatusPollingOutcome> {
    if (!record.accurateShipmentId && !record.accurateShipmentCode) {
      return 'skipped-no-reference';
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
          await shipmentRepository.markStatusPollingMiss(
            record.id,
            `Exact Telegraph lookup did not return ${record.accurateShipmentCode ?? record.accurateShipmentId}`
          );
          return 'not-found';
        }
        shipment = match;
      } else {
        throw error;
      }
    }

    if (!shipment) {
      throw new Error(`Accurate shipment not found for record ${record.id}`);
    }
    return await this.syncResolvedShipment(record, shipment);
  }

  /**
   * Apply a shipment already resolved by an exact-code catalog scan. The
   * one-time backlog reconciliation uses this path instead of hundreds of
   * single-shipment lookups that this Telegraph account cannot read.
   */
  async syncResolvedShipment(
    record: StatusPollingRecordRef,
    shipment: AccurateShipmentSummary
  ): Promise<StatusPollingOutcome> {
    if (isLegacyNonShopifyShipmentCode(shipment.code)) {
      logger.info('Skipping legacy non-Shopify Telegraph shipment', {
        recordId: record.id,
        shipmentCode: shipment.code
      });
      if (record.accurateShipmentCode) {
        await shipmentRepository.quarantineStatusPollingRecord(
          record.id,
          record.accurateShipmentCode,
          'Legacy VI + five-zero shipment is excluded from Shopify financial automation'
        );
      }
      return 'skipped-legacy';
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
      await shipmentRepository.supersedeOdooCollectionSync(
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
        await shipmentRepository.supersedeOdooCollectionSync(
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
      return 'synced';
    }

    if (projection.collectionStatus === 'collected') {
      await shipmentRepository.queueShopifyPaymentSync(
        record.id,
        buildShopifyPaymentFingerprint(Number(shipment.collectedAmount ?? 0))
      );
      await shipmentRepository.queueOdooCollectionSync(
        record.id,
        buildOdooCollectionFingerprint({
          code: shipment.code,
          collectedAmount: shipment.collectedAmount,
          deliveryFees: shipment.deliveryFees,
          customerDue: shipment.customerDue
        })
      );
      await shipmentRepository.ensureCollectedProductionQueued(record.id);
    }

    if (isReturn) {
      await shipmentRepository.queueReturnSync(record.id, buildReturnSyncFingerprint(shipment));
    }

    if (projection.collectionStatus === 'delivered-not-collected') {
      await this.flagShopifyOrderNotCollected(record);
    }
    return 'synced';
  }

  /** Execute one idempotent Shopify payment action and let the durable queue own retries. */
  private async performShopifyPayment(
    record: { id: number; shopifyOrderId: string },
    collectedAmount: number,
    allowDiscounts: boolean
  ): Promise<{ transactionId?: string; reason?: string; manualReview?: boolean }> {
    const first = await shopifyStatusSyncClient.recordCustomerPayment({
      orderId: record.shopifyOrderId,
      amount: collectedAmount
    });
    if (!first.skipped) {
      return { transactionId: first.transactionId };
    }
    if (
      first.reason === 'needs-discount' &&
      first.needsDiscountFor &&
      first.total &&
      first.currencyCode &&
      allowDiscounts
    ) {
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
    return {
      reason: first.reason ?? 'unknown-payment-state',
      manualReview: true
    };
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
    // Discovery only persists carrier truth and queues each destination. The
    // independent workers own retries and verification.
    const dbRec = await shipmentRepository.findById(record.id);
    const collectedAmount = Number(dbRec?.collectedAmount ?? 0);
    if (
      dbRec?.accurateShipmentCode &&
      !isLegacyNonShopifyShipmentCode(dbRec.accurateShipmentCode) &&
      collectedAmount > 0
    ) {
      await shipmentRepository.supersedeReturnSync(
        record.id,
        'Superseded because an approved Telegraph collection was received'
      );
      await shipmentRepository.queueShopifyPaymentSync(
        record.id,
        buildShopifyPaymentFingerprint(collectedAmount)
      );
      await shipmentRepository.queueOdooCollectionSync(
        record.id,
        buildOdooCollectionFingerprint({
          code: dbRec.accurateShipmentCode,
          collectedAmount,
          deliveryFees: dbRec.deliveryFees,
          customerDue: dbRec.customerDue
        })
      );
      await shipmentRepository.ensureCollectedProductionQueued(record.id);
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
    input?: Record<string, unknown>;
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
    legacySkipped: number;
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
      legacySkipped: 0,
      failed: 0,
      nextPage: startPage as number | null,
      lastPage: startPage,
      scanComplete: false,
      elapsedMs: 0
    };

    for (let offset = 0; offset < pages; offset += 1) {
      if (offset > 0 && Date.now() - startedAt >= budgetMs) break;
      const page = startPage + offset;
      const result = await this.accurateClient.listShipments(options.input ?? {}, first, page);
      summary.lastPage = result.paginatorInfo.lastPage;
      summary.scanned += result.data.length;
      const returned = result.data.filter((shipment) => {
        const statusCode = shipment.status?.code?.trim().toUpperCase() ?? '';
        const returnStatusCode = shipment.returnStatus?.code?.trim().toUpperCase() ?? '';
        return RETURNED_STATUS_CODES.has(statusCode) || RETURNED_STATUS_CODES.has(returnStatusCode);
      });
      summary.carrierReturns += returned.length;

      const eligible = returned.filter((shipment) => {
        if (!isLegacyNonShopifyShipmentCode(shipment.code)) return true;
        summary.legacySkipped++;
        return false;
      });
      const codes = [...new Set(eligible.map((shipment) => shipment.code).filter(Boolean))];
      const records = codes.length > 0
        ? await shipmentRepository.findFinancialMatchesByShipmentCodes(codes)
        : [];
      const byCode = new Map<string, typeof records>();
      for (const record of records) {
        if (!record.accurateShipmentCode) continue;
        const matches = byCode.get(record.accurateShipmentCode) ?? [];
        matches.push(record);
        byCode.set(record.accurateShipmentCode, matches);
      }

      for (const shipment of eligible) {
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
          await shipmentRepository.supersedeOdooCollectionSync(
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

  /**
   * Resumable return discovery: scan the fresh first page on every schedule,
   * then advance a durable historical checkpoint by a few short pages.
   */
  async discoverReturnedShipmentsResumable(options: {
    historyPages?: number;
    first?: number;
    budgetMs?: number;
    apply?: boolean;
  } = {}) {
    const apply = options.apply ?? false;
    const historyPages = Math.max(0, Math.min(options.historyPages ?? 2, 5));
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
      legacySkipped: 0,
      failed: 0,
      recentPages: [] as number[],
      recentSweepComplete: false,
      historicalPages: [] as number[],
      nextPage: FIRST_HISTORICAL_PAGE,
      lastPage: 1,
      scanComplete: false,
      elapsedMs: 0
    };
    const merge = (part: Awaited<ReturnType<ShipmentStatusSyncService['discoverReturnedShipmentsFromReports']>>) => {
      summary.scanned += part.scanned;
      summary.carrierReturns += part.carrierReturns;
      summary.exactMatches += part.exactMatches;
      summary.needsSync += part.needsSync;
      summary.queued += part.queued;
      summary.alreadyComplete += part.alreadyComplete;
      summary.notInDb += part.notInDb;
      summary.ambiguous += part.ambiguous;
      summary.legacySkipped += part.legacySkipped;
      summary.failed += part.failed;
      summary.lastPage = part.lastPage;
    };

    const hot = await this.discoverReturnedShipmentsFromReports({
      startPage: 1,
      pages: 1,
      first,
      budgetMs,
      apply
    });
    merge(hot);
    const historicalLastPage = hot.lastPage;

    try {
      const recentInput = {
        deliveredOrReturnedDate: { fromDays: 2 }
      };
      const recentFirst = await this.discoverReturnedShipmentsFromReports({
        startPage: 1,
        pages: 1,
        first,
        budgetMs: Math.max(10_000, budgetMs - (Date.now() - startedAt)),
        apply,
        input: recentInput
      });
      merge(recentFirst);
      summary.recentPages.push(1);
      const recentLastPage = recentFirst.lastPage;
      for (let page = 2; page <= recentLastPage; page += 1) {
        if (Date.now() - startedAt >= budgetMs - 20_000) break;
        const recentPart = await this.discoverReturnedShipmentsFromReports({
          startPage: page,
          pages: 1,
          first,
          budgetMs: Math.max(10_000, budgetMs - (Date.now() - startedAt)),
          apply,
          input: recentInput
        });
        merge(recentPart);
        summary.recentPages.push(page);
      }
      summary.recentSweepComplete = summary.recentPages.length === recentLastPage;
    } catch (error) {
      summary.failed++;
      await failedPayloadService.save({
        source: 'accurate-recent-return-discovery',
        reason: error instanceof Error ? error.message : String(error),
        payload: { fromDays: 2 }
      });
    }
    summary.lastPage = historicalLastPage;

    const cursor = await shipmentRepository.getOperationalCursor(
      RETURN_DISCOVERY_CURSOR,
      FIRST_HISTORICAL_PAGE
    );
    const plan = planHistoricalDiscoveryPages(cursor, historicalLastPage, historyPages);
    for (const page of plan.pages) {
      if (Date.now() - startedAt >= budgetMs) break;
      const part = await this.discoverReturnedShipmentsFromReports({
        startPage: page,
        pages: 1,
        first,
        budgetMs: Math.max(10_000, budgetMs - (Date.now() - startedAt)),
        apply
      });
      merge(part);
      summary.historicalPages.push(page);
      summary.nextPage = page >= historicalLastPage ? FIRST_HISTORICAL_PAGE : page + 1;
      if (apply) {
        await shipmentRepository.setOperationalCursor(RETURN_DISCOVERY_CURSOR, summary.nextPage);
      }
    }
    summary.scanComplete =
      plan.scanComplete && summary.historicalPages.length === plan.pages.length;
    if (summary.historicalPages.length === plan.pages.length) {
      summary.nextPage = plan.nextPage;
    }
    summary.elapsedMs = Date.now() - startedAt;
    return summary;
  }

  /** Process claimed return actions. Odoo billing and Shopify cancellation are independently idempotent. */
  async processReturnQueue(options: {
    limit?: number;
    budgetMs?: number;
    apply?: boolean;
    restock?: boolean;
  } = {}): Promise<{
    apply: boolean;
    found: number;
    processed: number;
    skipped: number;
    failed: number;
    recovered: number;
    remaining: number;
    hasMore: boolean;
    actions: Array<{
      order: string;
      shipmentCode?: string | null;
      charge: number;
      restock: boolean;
      status: string;
    }>;
    elapsedMs: number;
  }> {
    const apply = options.apply ?? false;
    // A carrier return does not prove that the warehouse received and inspected
    // the item. Automated financial recovery therefore leaves live inventory
    // unchanged unless a deliberately controlled caller opts in.
    const restock = options.restock ?? false;
    const limit = Math.max(1, Math.min(options.limit ?? 4, 10));
    const budgetMs = Math.max(10_000, Math.min(options.budgetMs ?? 70_000, 100_000));
    const startedAt = Date.now();
    const recovered = apply ? await shipmentRepository.recoverStuckReturnSync(10) : 0;
    const records = await shipmentRepository.findPendingReturnSync(limit);
    let processed = 0;
    let skipped = 0;
    let failed = 0;
    const actions: Array<{
      order: string;
      shipmentCode?: string | null;
      charge: number;
      restock: boolean;
      status: string;
    }> = [];

    for (const candidate of records) {
      if (Date.now() - startedAt >= budgetMs) break;
      const charge = calculateTelegraphReturnCharge(candidate);
      const action = {
        order: candidate.shopifyOrderName ?? candidate.shopifyOrderId,
        shipmentCode: candidate.accurateShipmentCode,
        charge,
        restock,
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
      if (isLegacyNonShopifyShipmentCode(record.accurateShipmentCode)) {
        await shipmentRepository.supersedeReturnSync(
          candidate.id,
          'Legacy Telegraph shipment excluded from Shopify and Odoo automation'
        );
        skipped++;
        action.status = 'legacy-excluded';
        continue;
      }

      const errors: string[] = [];
      let manualReviewReason: string | undefined;
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

      const cancelShopifyOrder = async () => await shopifyStatusSyncClient.cancelOrder({
        orderId: record.shopifyOrderId,
        reason: 'OTHER',
        refund: false,
        restock,
        notifyCustomer: false,
        staffNote: `Telegraph returned shipment (${record.collectionStatus})`
      });
      try {
        try {
          await cancelShopifyOrder();
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          if (!/outstanding fulfillments/i.test(reason)) throw error;
          if (!record.accurateShipmentCode) {
            manualReviewReason = 'Shopify has outstanding fulfillments and the exact Telegraph code is missing';
          } else {
            const repair = await shopifyStatusSyncClient.cancelExactReturnedShipmentFulfillments({
              orderId: record.shopifyOrderId,
              shipmentCode: record.accurateShipmentCode
            });
            if (!repair.safe) {
              manualReviewReason =
                `Shopify fulfillment cannot be cancelled safely (${repair.reason ?? 'unknown reason'})`;
            } else {
              await cancelShopifyOrder();
            }
          }
        }
        if (manualReviewReason) {
          throw new Error(`MANUAL_REVIEW:${manualReviewReason}`);
        }
        let state = await shopifyStatusSyncClient.fetchOrderPaymentState(record.shopifyOrderId);
        for (const delay of [500, 1_500, 2_500]) {
          if (state?.cancelledAt) break;
          await sleep(delay);
          state = await shopifyStatusSyncClient.fetchOrderPaymentState(record.shopifyOrderId);
        }
        if (!state?.cancelledAt) errors.push('Shopify cancellation was not confirmed');
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (reason.startsWith('MANUAL_REVIEW:')) {
          manualReviewReason = reason.slice('MANUAL_REVIEW:'.length);
        } else {
          errors.push(`Shopify cancel: ${reason}`);
        }
      }

      if (charge > 0 && this.odooSyncService) {
        try {
          const verification = await this.odooSyncService.verifyReturnedShipmentCharge(record.id);
          if (!verification.complete) {
            errors.push(
              `Odoo return bill verification: ${verification.reason ?? 'not complete'} ` +
              `(expected=${verification.charge}, actual=${verification.actualAmount ?? 'missing'}, ` +
              `residual=${verification.residual ?? 'missing'})`
            );
          }
        } catch (error) {
          errors.push(`Odoo return bill verification: ${error instanceof Error ? error.message : String(error)}`);
        }
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
      } else if (manualReviewReason) {
        await shipmentRepository.reviewReturnSync(record.id, manualReviewReason);
        await failedPayloadService.save({
          source: 'return-sync-review',
          externalId: record.accurateShipmentCode ?? record.shopifyOrderId,
          reason: manualReviewReason,
          payload: { recordId: record.id, shopifyOrderName: record.shopifyOrderName, charge }
        });
        skipped++;
        action.status = 'needs-review';
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

  async processOdooCollectionQueue(options: {
    limit?: number;
    budgetMs?: number;
    apply?: boolean;
  } = {}): Promise<{
    apply: boolean;
    found: number;
    processed: number;
    skipped: number;
    failed: number;
    recovered: number;
    remaining: number;
    hasMore: boolean;
    actions: Array<{
      order: string;
      shipmentCode?: string | null;
      amount: number;
      status: string;
    }>;
    elapsedMs: number;
  }> {
    const apply = options.apply ?? false;
    const limit = Math.max(1, Math.min(options.limit ?? 4, 20));
    const budgetMs = Math.max(10_000, Math.min(options.budgetMs ?? 70_000, 100_000));
    const startedAt = Date.now();
    const recovered = apply ? await shipmentRepository.recoverStuckOdooCollectionSync(10) : 0;
    const records = await shipmentRepository.findPendingOdooCollectionSync(limit);
    let processed = 0;
    let skipped = 0;
    let failed = 0;
    const actions: Array<{
      order: string;
      shipmentCode?: string | null;
      amount: number;
      status: string;
    }> = [];

    const odooCollectionConcurrency = 5;
    for (let index = 0; index < records.length; index += odooCollectionConcurrency) {
      if (Date.now() - startedAt >= budgetMs) break;
      const chunk = records.slice(index, index + odooCollectionConcurrency);
      await Promise.all(chunk.map(async (candidate) => {
        const action = {
          order: candidate.shopifyOrderName ?? candidate.shopifyOrderId,
          shipmentCode: candidate.accurateShipmentCode,
          amount: Number(candidate.collectedAmount ?? 0),
          status: apply ? 'pending' : 'preview'
        };
        actions.push(action);
        if (!apply) return;
        if (isLegacyNonShopifyShipmentCode(candidate.accurateShipmentCode)) {
          await shipmentRepository.supersedeOdooCollectionSync(
            candidate.id,
            'Legacy Telegraph shipment excluded from Shopify and Odoo automation'
          );
          skipped++;
          action.status = 'legacy-excluded';
          return;
        }
        if (!this.odooSyncService) {
          throw new Error('Odoo collection service is unavailable');
        }
        if (!await shipmentRepository.claimOdooCollectionSync(candidate.id)) {
          skipped++;
          action.status = 'claimed-by-other-or-prerequisite-pending';
          return;
        }

        const current = await shipmentRepository.findById(candidate.id);
        const currentAmount = Number(current?.collectedAmount ?? 0);
        if (
          !current ||
          current.collectionStatus !== 'collected' ||
          currentAmount <= 0 ||
          !current.accurateShipmentCode ||
          isLegacyNonShopifyShipmentCode(current.accurateShipmentCode)
        ) {
          await shipmentRepository.supersedeOdooCollectionSync(
            candidate.id,
            'Superseded because the latest exact carrier state is not an actionable Shopify collection'
          );
          skipped++;
          action.status = 'superseded';
          return;
        }
        const currentFingerprint = buildOdooCollectionFingerprint({
          code: current.accurateShipmentCode,
          collectedAmount: current.collectedAmount,
          deliveryFees: current.deliveryFees,
          customerDue: current.customerDue
        });
        if (current.odooCollectionFingerprint !== currentFingerprint) {
          await shipmentRepository.replaceClaimedOdooCollectionSync(candidate.id, currentFingerprint);
          skipped++;
          action.amount = currentAmount;
          action.status = 'requeued-new-amount';
          return;
        }

        try {
          await this.odooSyncService.syncCollectedShipment(current.id);
          const verification = await this.odooSyncService.verifyCollectedShipmentAccounting(current.id);
          if (!verification.complete) {
            const reason =
              `Odoo collection verification failed: ${verification.reason ?? 'not complete'} ` +
              `(expected=${verification.targetAmount ?? 'missing'}, actual=${verification.actualAmount ?? 'missing'}, ` +
              `residual=${verification.residual ?? 'missing'})`;
            if (
              verification.reason === 'odoo-invoice-total-mismatch' ||
              verification.reason === 'odoo-invoice-payment-reversed'
            ) {
              await shipmentRepository.reviewOdooCollectionSync(current.id, reason);
              await failedPayloadService.save({
                source: 'odoo-collection-review',
                externalId: current.accurateShipmentCode,
                reason,
                payload: {
                  recordId: current.id,
                  shopifyOrderName: current.shopifyOrderName,
                  expected: verification.targetAmount,
                  actual: verification.actualAmount,
                  residual: verification.residual
                }
              });
              skipped++;
              action.status = 'needs-review';
              return;
            }
            throw new Error(reason);
          }
          await shipmentRepository.completeOdooCollectionSync(current.id);
          processed++;
          action.amount = currentAmount;
          action.status = 'completed';
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          await shipmentRepository.failOdooCollectionSync(current.id, reason);
          await failedPayloadService.save({
            source: 'odoo-collection-worker',
            externalId: current.accurateShipmentCode,
            reason,
            payload: {
              recordId: current.id,
              shopifyOrderName: current.shopifyOrderName,
              amount: currentAmount
            }
          });
          failed++;
          action.status = 'retry-scheduled';
        }
      }));
    }

    const remaining = await shipmentRepository.countDueOdooCollectionSync();
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

  async processShopifyPaymentQueue(options: {
    limit?: number;
    budgetMs?: number;
    apply?: boolean;
    allowDiscounts?: boolean;
  } = {}): Promise<{
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
    // Exact-total COD payments are safe to automate. Partial collections can
    // require editing a fulfilled Shopify order, so the scheduled worker leaves
    // them for review unless a controlled caller explicitly opts in.
    const allowDiscounts = options.allowDiscounts ?? false;
    const limit = Math.max(1, Math.min(options.limit ?? 6, 12));
    const budgetMs = Math.max(10_000, Math.min(options.budgetMs ?? 70_000, 100_000));
    const startedAt = Date.now();
    const recovered = apply ? await shipmentRepository.recoverStuckShopifyPaymentSync(10) : 0;
    const records = await shipmentRepository.findPendingShopifyPaymentSync(limit);
    let processed = 0;
    let skipped = 0;
    let failed = 0;
    const actions: Array<{ order: string; amount: number; status: string }> = [];

    const shopifyPaymentConcurrency = 3;
    for (let index = 0; index < records.length; index += shopifyPaymentConcurrency) {
      if (Date.now() - startedAt >= budgetMs) break;
      const chunk = records.slice(index, index + shopifyPaymentConcurrency);
      await Promise.all(chunk.map(async (candidate) => {
        const amount = Number(candidate.collectedAmount ?? 0);
        const action = {
          order: candidate.shopifyOrderName ?? candidate.shopifyOrderId,
          amount,
          status: apply ? 'pending' : 'preview'
        };
        actions.push(action);
        if (!apply) return;
        if (isLegacyNonShopifyShipmentCode(candidate.accurateShipmentCode)) {
          await shipmentRepository.supersedeShopifyPaymentSync(
            candidate.id,
            'Legacy Telegraph shipment excluded from Shopify and Odoo automation'
          );
          skipped++;
          action.status = 'legacy-excluded';
          return;
        }
        if (!await shipmentRepository.claimShopifyPaymentSync(candidate.id)) {
          skipped++;
          action.status = 'claimed-by-other';
          return;
        }

        const current = await shipmentRepository.findById(candidate.id);
        const currentAmount = Number(current?.collectedAmount ?? 0);
        const currentFingerprint = buildShopifyPaymentFingerprint(currentAmount);
        const explicitReturn = RETURNED_STATUS_CODES.has(current?.accurateStatusCode?.trim().toUpperCase() ?? '') ||
          RETURNED_STATUS_CODES.has(current?.accurateReturnStatusCode?.trim().toUpperCase() ?? '');
        if (
          !current ||
          current.collectionStatus !== 'collected' ||
          currentAmount <= 0 ||
          explicitReturn ||
          isLegacyNonShopifyShipmentCode(current.accurateShipmentCode)
        ) {
          await shipmentRepository.supersedeShopifyPaymentSync(
            candidate.id,
            'Superseded because the latest carrier snapshot is not a payable collection'
          );
          skipped++;
          action.status = 'superseded';
          return;
        }
        if (current.shopifyPaymentFingerprint !== currentFingerprint) {
          await shipmentRepository.replaceClaimedShopifyPaymentSync(candidate.id, currentFingerprint);
          skipped++;
          action.amount = currentAmount;
          action.status = 'requeued-new-amount';
          return;
        }
        action.amount = currentAmount;

        try {
          const result = await this.performShopifyPayment(current, currentAmount, allowDiscounts);
          if (result.manualReview) {
            const reason = `Shopify payment needs review: ${result.reason ?? 'unknown reason'}`;
            await shipmentRepository.reviewShopifyPaymentSync(candidate.id, reason);
            await failedPayloadService.save({
              source: 'shopify-payment-review',
              externalId: current.shopifyOrderId,
              reason,
              payload: {
                recordId: current.id,
                shopifyOrderName: current.shopifyOrderName,
                amount: currentAmount
              }
            });
            skipped++;
            action.status = 'needs-review';
            return;
          }
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
      }));
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

  async getStatusPollingHealth() {
    return await shipmentRepository.getStatusPollingHealth();
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

  async syncOpenShipments(options: { budgetMs?: number; batchSize?: number } = {}): Promise<{
    processed: number;
    failed: number;
    skipped: number;
    notFound: number;
  }> {
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
    let notFound = 0;

    for (let i = 0; i < openShipments.length; i += CONCURRENCY) {
      const elapsedMs = Date.now() - startTime;
      if (elapsedMs >= budgetMs) {
        skipped += openShipments.length - processed - failed - skipped - notFound;
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
          if (result.value === 'synced') processed += 1;
          else if (result.value === 'not-found') notFound += 1;
          else skipped += 1;
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

    logger.info('syncOpenShipments complete', {
      processed,
      failed,
      skipped,
      notFound,
      elapsedMs: Date.now() - startTime
    });
    return { processed, failed, skipped, notFound };
  }
}
