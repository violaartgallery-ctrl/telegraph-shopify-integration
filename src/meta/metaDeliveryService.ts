import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import {
  mergeAccurateSnapshot,
  type AccurateSnapshotData
} from '../services/shipmentRepository.js';
import type { ShopifyOrder } from '../types/shopify.js';
import {
  buildMetaDeliveredPayload,
  sha256,
  stableJsonStringify
} from './metaDeliveredPayload.js';
import {
  MetaCapiClient,
  type MetaCapiMode,
  type MetaCapiSendFailure
} from './metaCapiClient.js';
import {
  metaDeliveryOutboxRepository,
  type ClaimedMetaDeliveryEvent,
  type MetaOutboxHealth
} from './metaDeliveryOutboxRepository.js';

export type MetaDeliverySource =
  | 'accurate-status'
  | 'accurate-report'
  | 'accurate-payment'
  | 'reconciliation';

export interface MetaDeliveryConfig {
  enabled: boolean;
  mode: MetaCapiMode;
  pixelId: string;
  accessToken: string;
  apiVersion: string;
  testEventCode?: string;
  cutoverAt?: Date;
  eventSourceUrl: string;
  batchSize: number;
  leaseMs: number;
  requestTimeoutMs: number;
  maxAttempts: number;
}

export interface MetaDeliveryObservationResult {
  enqueued: boolean;
  reason: string;
}

export interface MetaDeliveryDrainSummary {
  enabled: boolean;
  mode: MetaCapiMode;
  reconciled: number;
  claimed: number;
  sent: number;
  retry: number;
  dead: number;
  leaseLost: number;
  health: MetaOutboxHealth | null;
}

const META_MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const parseOrder = (rawOrderJson: string | null): ShopifyOrder | null => {
  if (!rawOrderJson) return null;
  try {
    const parsed: unknown = JSON.parse(rawOrderJson);
    return parsed && typeof parsed === 'object' ? (parsed as ShopifyOrder) : null;
  } catch {
    return null;
  }
};

const parseDate = (value?: string | null): Date | undefined => {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

const snapshotDataWithoutDates = (data: AccurateSnapshotData) => ({
  accurateStatus: data.accurateStatus,
  accurateStatusCode: data.accurateStatusCode,
  accurateReturnStatus: data.accurateReturnStatus,
  accurateReturnStatusCode: data.accurateReturnStatusCode,
  accurateIsTerminal: data.accurateIsTerminal,
  collectionStatus: data.collectionStatus,
  trackingUrl: data.trackingUrl,
  collectedAmount: data.collectedAmount,
  pendingCollectionAmount: data.pendingCollectionAmount,
  returnedValue: data.returnedValue,
  deliveryFees: data.deliveryFees,
  returnFees: data.returnFees,
  returningDueFees: data.returningDueFees,
  customerDue: data.customerDue,
  lastSyncedAt: new Date()
});

const safeErrorCode = (failure: MetaCapiSendFailure): string | undefined =>
  failure.errorSubcode !== undefined
    ? `${String(failure.errorCode ?? failure.classification)}:${failure.errorSubcode}`
    : failure.errorCode !== undefined
      ? String(failure.errorCode)
      : failure.classification;

const retryAtFor = (row: ClaimedMetaDeliveryEvent, failure: MetaCapiSendFailure): Date => {
  const explicitMs = (failure.retryAfterSeconds ?? 0) * 1000;
  const backoffMs = failure.classification === 'auth'
    ? 6 * 60 * 60 * 1000
    : Math.min(6 * 60 * 60 * 1000, 30_000 * (2 ** Math.min(10, Math.max(0, row.attemptCount - 1))));
  return new Date(Date.now() + Math.max(explicitMs, backoffMs));
};

export class MetaDeliveryService {
  private readonly client?: MetaCapiClient;

  constructor(private readonly config: MetaDeliveryConfig, client?: MetaCapiClient) {
    if (!Number.isSafeInteger(config.batchSize) || config.batchSize <= 0) {
      throw new Error('META_DELIVERED_BATCH_SIZE must be a positive integer');
    }
    if (!Number.isSafeInteger(config.leaseMs) || config.leaseMs <= 0) {
      throw new Error('META_DELIVERED_LEASE_MS must be a positive integer');
    }
    if (!Number.isSafeInteger(config.maxAttempts) || config.maxAttempts <= 0) {
      throw new Error('META_DELIVERED_MAX_ATTEMPTS must be a positive integer');
    }
    if (config.enabled && !config.cutoverAt) {
      throw new Error('META_DELIVERED_CUTOVER_AT is required when Meta Delivered is enabled');
    }

    if (config.enabled) {
      this.client = client ?? new MetaCapiClient({
        pixelId: config.pixelId,
        accessToken: config.accessToken,
        apiVersion: config.apiVersion,
        mode: config.mode,
        testEventCode: config.testEventCode,
        timeoutMs: config.requestTimeoutMs
      });
    }
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Writes carrier truth and the immutable outbox payload in one DB transaction.
   * The unique event ID makes repeated webhooks, polling and report sweeps harmless.
   */
  async observeSnapshot(
    shipmentRecordId: number,
    data: AccurateSnapshotData,
    source: Exclude<MetaDeliverySource, 'reconciliation'>
  ): Promise<MetaDeliveryObservationResult> {
    return await prisma.$transaction(async (tx) => {
      // Lock before merging because collection reports can be newer than the
      // ordinary Accurate lookup even when requests finish out of order.
      await tx.shipmentRecord.update({
        where: { id: shipmentRecordId },
        data: { lastSyncedAt: new Date() }
      });
      const currentSnapshot = await tx.shipmentRecord.findUniqueOrThrow({ where: { id: shipmentRecordId } });
      const merged = mergeAccurateSnapshot(currentSnapshot, data);
      await tx.shipmentRecord.update({
        where: { id: shipmentRecordId },
        data: snapshotDataWithoutDates(merged)
      });

      // The update above locks this row for the rest of the transaction. Read
      // the timestamps under that lock, then fill only facts never seen before.
      const timestamps = await tx.shipmentRecord.findUniqueOrThrow({
        where: { id: shipmentRecordId },
        select: { deliveredAt: true, returnedAt: true }
      });
      if ((!timestamps.deliveredAt && merged.deliveredAt) || (!timestamps.returnedAt && merged.returnedAt)) {
        await tx.shipmentRecord.update({
          where: { id: shipmentRecordId },
          data: {
            deliveredAt: timestamps.deliveredAt ? undefined : merged.deliveredAt ?? undefined,
            returnedAt: timestamps.returnedAt ? undefined : merged.returnedAt ?? undefined
          }
        });
      }

      const result = await this.enqueueInsideTransaction(
        tx as unknown as Prisma.TransactionClient,
        shipmentRecordId,
        source
      );
      await tx.shipmentRecord.update({
        where: { id: shipmentRecordId },
        data: {
          metaDeliveryLastReason: result.reason,
          metaDeliveryLastObservedAt: new Date(),
          metaDeliveryLastMode: this.config.mode
        }
      });
      return result;
    }, { maxWait: 20_000, timeout: 30_000 });
  }

  private async enqueueInsideTransaction(
    tx: Prisma.TransactionClient,
    shipmentRecordId: number,
    source: MetaDeliverySource
  ): Promise<MetaDeliveryObservationResult> {
    if (!this.config.enabled) return { enqueued: false, reason: 'disabled' };
    const cutoverAt = this.config.cutoverAt;
    if (!cutoverAt) return { enqueued: false, reason: 'missing-cutover' };

    const record = await tx.shipmentRecord.findUnique({ where: { id: shipmentRecordId } });
    if (!record) return { enqueued: false, reason: 'record-not-found' };
    const order = parseOrder(record.rawOrderJson);
    if (!order) return { enqueued: false, reason: 'missing-order-payload' };

    const shopifyCreatedAt = record.shopifyCreatedAt ?? parseDate(order.created_at);
    if (!record.shopifyCreatedAt && shopifyCreatedAt) {
      await tx.shipmentRecord.update({
        where: { id: record.id },
        data: { shopifyCreatedAt }
      });
    }

    const built = buildMetaDeliveredPayload({
      shopifyOrderId: record.shopifyOrderId,
      shopifyCreatedAt,
      deliveredAt: record.deliveredAt,
      cutoverAt,
      statusCode: record.accurateStatusCode,
      returnStatusCode: record.accurateReturnStatusCode,
      collectionStatus: record.collectionStatus,
      returnedAt: record.returnedAt,
      customerDue: record.customerDue,
      orderTest: order.test,
      cancelledAt: order.cancelled_at,
      orderTags: order.tags,
      order,
      collectedAmount: record.collectedAmount,
      externalId: order.customer?.id,
      eventSourceUrl: this.config.eventSourceUrl,
      defaultCountryCode: 'EG'
    });

    if (!built.ok) return { enqueued: false, reason: built.reason };

    // Store the single event object. The transport adds data[] and Test Events
    // code, while retries verify and resend these exact bytes/semantics.
    const payloadJson = stableJsonStringify(built.payload.data[0]);
    const payloadHash = sha256(payloadJson);
    const inserted = await tx.metaDeliveryOutbox.createMany({
      data: [{
        shipmentRecordId: record.id,
        shopifyOrderId: record.shopifyOrderId,
        eventName: 'Delivered',
        eventId: built.eventId,
        eventTime: new Date(built.eventTime * 1000),
        source,
        mode: this.config.mode,
        payloadJson,
        payloadHash,
        matchQualityJson: stableJsonStringify(built.matchQuality)
      }],
      skipDuplicates: true
    });

    return inserted.count === 1
      ? { enqueued: true, reason: 'enqueued' }
      : { enqueued: false, reason: 'duplicate' };
  }

  async reconcileEligible(limit = this.config.batchSize * 4): Promise<number> {
    if (!this.config.enabled || !this.config.cutoverAt) return 0;
    const ids = await metaDeliveryOutboxRepository.findReconciliationCandidateIds(
      this.config.cutoverAt,
      limit,
      this.config.mode
    );
    let enqueued = 0;
    for (const id of ids) {
      const result = await prisma.$transaction(
        (tx) => this.enqueueInsideTransaction(
          tx as unknown as Prisma.TransactionClient,
          id,
          'reconciliation'
        ),
        { maxWait: 20_000, timeout: 30_000 }
      );
      if (result.enqueued) enqueued += 1;
    }
    return enqueued;
  }

  private async processOne(row: ClaimedMetaDeliveryEvent): Promise<'sent' | 'retry' | 'dead' | 'lease-lost'> {
    const now = Date.now();
    const current = await prisma.shipmentRecord.findUnique({
      where: { id: row.shipmentRecordId },
      select: {
        accurateStatusCode: true,
        accurateReturnStatusCode: true,
        collectionStatus: true,
        returnedAt: true
      }
    });
    if (!current) {
      const changed = await metaDeliveryOutboxRepository.markDead(row, {
        errorCode: 'SHIPMENT_RECORD_MISSING',
        error: 'Shipment record no longer exists'
      });
      return changed ? 'dead' : 'lease-lost';
    }
    const currentCollection = current.collectionStatus?.trim().toLowerCase() ?? '';
    const currentReturnCode = current.accurateReturnStatusCode?.trim().toUpperCase() ?? '';
    const explicitReversal =
      Boolean(current.returnedAt) ||
      ['RTRN', 'RTS', 'RJCT'].includes(current.accurateStatusCode?.trim().toUpperCase() ?? '') ||
      ['RTRN', 'RTS', 'RJCT'].includes(currentReturnCode) ||
      ['returned', 'returned-settled', 'cancelled'].includes(currentCollection);
    if (explicitReversal) {
      const changed = await metaDeliveryOutboxRepository.markDead(row, {
        errorCode: 'DELIVERY_STATE_REVERSED',
        error: 'Carrier explicitly marked shipment returned or cancelled'
      });
      return changed ? 'dead' : 'lease-lost';
    }
    const isStillDelivered =
      current?.accurateStatusCode?.trim().toUpperCase() === 'DTR' &&
      currentCollection === 'collected';
    if (!isStillDelivered) {
      // A stale ordinary lookup must not permanently destroy a report-confirmed
      // event. Hold and retry until carrier truth converges or explicitly reverses.
      const changed = await metaDeliveryOutboxRepository.markRetry(row, {
        retryAt: new Date(now + 30 * 60 * 1000),
        errorCode: 'DELIVERY_STATE_PENDING',
        error: 'Shipment is temporarily not in DTR and collected state'
      });
      return changed ? 'retry' : 'lease-lost';
    }
    if (sha256(row.payloadJson) !== row.payloadHash) {
      const changed = await metaDeliveryOutboxRepository.markDead(row, {
        errorCode: 'PAYLOAD_HASH_MISMATCH',
        error: 'Stored Meta event failed integrity verification'
      });
      return changed ? 'dead' : 'lease-lost';
    }
    if (now - row.eventTime.getTime() > META_MAX_EVENT_AGE_MS) {
      const changed = await metaDeliveryOutboxRepository.markDead(row, {
        errorCode: 'EVENT_TOO_OLD',
        error: 'Meta event exceeded the seven-day delivery window; timestamp was not rewritten'
      });
      return changed ? 'dead' : 'lease-lost';
    }
    if (row.eventTime.getTime() > now + 5 * 60 * 1000) {
      const changed = await metaDeliveryOutboxRepository.markRetry(row, {
        retryAt: row.eventTime,
        errorCode: 'EVENT_IN_FUTURE',
        error: 'Carrier delivery time is in the future'
      });
      return changed ? 'retry' : 'lease-lost';
    }

    const result = await this.client!.sendEventJson(row.payloadJson);
    if (result.ok) {
      const changed = await metaDeliveryOutboxRepository.markSent(row, result);
      return changed ? 'sent' : 'lease-lost';
    }

    const common = {
      httpStatus: result.httpStatus,
      errorCode: safeErrorCode(result),
      error: result.safeMessage,
      fbtraceId: result.fbtraceId
    };
    if (!result.retryable || row.attemptCount >= this.config.maxAttempts) {
      const changed = await metaDeliveryOutboxRepository.markDead(row, common);
      return changed ? 'dead' : 'lease-lost';
    }
    const changed = await metaDeliveryOutboxRepository.markRetry(row, {
      ...common,
      retryAt: retryAtFor(row, result)
    });
    return changed ? 'retry' : 'lease-lost';
  }

  async processPending(): Promise<MetaDeliveryDrainSummary> {
    const empty: MetaDeliveryDrainSummary = {
      enabled: this.config.enabled,
      mode: this.config.mode,
      reconciled: 0,
      claimed: 0,
      sent: 0,
      retry: 0,
      dead: 0,
      leaseLost: 0,
      health: null
    };
    if (!this.config.enabled) return empty;

    // No automatic reconciliation/backfill: only the same transaction that
    // first observes an eligible carrier transition may enqueue a live event.
    // This keeps the post-cutover Delivered cohort clean and predictable.
    const rows = await metaDeliveryOutboxRepository.claimDue(
      this.config.batchSize,
      this.config.leaseMs,
      this.config.mode
    );
    empty.claimed = rows.length;

    const concurrency = 5;
    for (let index = 0; index < rows.length; index += concurrency) {
      const results = await Promise.all(rows.slice(index, index + concurrency).map(async (row) => {
        try {
          return await this.processOne(row);
        } catch {
          // Never strand a claimed row until its lease expires because one
          // unexpected record-specific exception aborted the whole cron batch.
          const changed = await metaDeliveryOutboxRepository.markRetry(row, {
            retryAt: new Date(Date.now() + 5 * 60 * 1000),
            errorCode: 'WORKER_UNEXPECTED_ERROR',
            error: 'Unexpected Meta Delivered worker error'
          });
          return changed ? 'retry' as const : 'lease-lost' as const;
        }
      }));
      for (const result of results) {
        if (result === 'sent') empty.sent += 1;
        else if (result === 'retry') empty.retry += 1;
        else if (result === 'dead') empty.dead += 1;
        else empty.leaseLost += 1;
      }
    }
    empty.health = await metaDeliveryOutboxRepository.getHealth(this.config.mode);
    logger.info('Meta Delivered outbox drain completed', {
      mode: empty.mode,
      reconciled: empty.reconciled,
      claimed: empty.claimed,
      sent: empty.sent,
      retry: empty.retry,
      dead: empty.dead,
      leaseLost: empty.leaseLost,
      health: empty.health
    });
    return empty;
  }

  async health(): Promise<MetaOutboxHealth | null> {
    return this.config.enabled ? await metaDeliveryOutboxRepository.getHealth(this.config.mode) : null;
  }
}
