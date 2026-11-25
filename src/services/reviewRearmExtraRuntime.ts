import {
  EXTRA_CURSOR_SOURCE, EXTRA_RECEIPT_SOURCE, RETURN_REVIEW_ERROR, SOURCE_REVIEW_TEXT, runExtraReviewRearm,
  type ExtraClaim, type ExtraLane, type ExtraPorts, type ExtraRecord,
} from './reviewRearmExtra.js';

const HOLD = 'ops_record_hold', CLOSED = 'ops_completion_receipt', CLAIM = 'automatic_operation_claim';
const SELECT = {
  id: true, shopifyOrderId: true, shopifyOrderNumber: true, shopifyOrderName: true, accurateShipmentId: true, accurateShipmentCode: true,
  collectionStatus: true, odooSyncStatus: true, odooLastError: true, odooSaleOrderId: true, odooInvoiceId: true,
  returnSyncStatus: true, returnSyncLastError: true, returnSyncFingerprint: true, rawOrderJson: true, updatedAt: true,
} as const;

const parseClaim = (row: { id: number; reason: string; payloadJson: string }): ExtraClaim & { raw: string } => {
  try {
    const p = JSON.parse(row.payloadJson);
    if (p && typeof p === 'object' && !Array.isArray(p)) return { id: row.id, reason: row.reason, payload: p, raw: row.payloadJson };
  } catch { /* malformed evidence never means permission */ }
  return { id: row.id, reason: row.reason, payload: { status: 'needs-review' }, raw: row.payloadJson };
};
const holdApplies = (payloadJson: string, lane: ExtraLane): boolean => {
  try { const p = JSON.parse(payloadJson); return !Array.isArray(p?.lanes) || p.lanes.some((l: unknown) => l === '*' || l === lane); }
  catch { return true; }
};

/** Native financial-lane stage (opt-in). Reads Neon, Telegraph and Shopify; writes only queue metadata + receipt. */
export async function runNativeExtraReviewRearm(options: { limit?: number } = {}) {
  const [{ basePrisma: db }, { automaticRecordBlocked }, { loadExactCarrierShipment }, { AccurateClient }, { shopifyOrdersClient },
    { env }, { safeQueueConfig }, { buildReturnSyncFingerprint }, { accountingMoneyOnlySourceEnabled, accountingMoneyUnchanged }] = await Promise.all([
    import('../lib/prisma.js'), import('./automaticOperationSafety.js'), import('./verifiedCarrierShipment.js'),
    import('../accurate/accurateClient.js'), import('../shopify/shopifyOrdersClient.js'), import('../config/env.js'),
    import('./safeQueuePolicy.js'), import('./shipmentStatusSyncService.js'), import('./odooShipmentBinding.js')]);
  const epoch = safeQueueConfig()?.epoch;
  if (!epoch) return { skipped: 'safe-queue-release-required' };
  const moneyOnly = accountingMoneyOnlySourceEnabled();
  const carrierClient = new AccurateClient();
  const lanes: Array<Record<string, unknown>> = [{ returnSyncStatus: 'needs-review', returnSyncLastError: RETURN_REVIEW_ERROR }];
  // The production rule only makes sense when the production fence accepts it too.
  if (moneyOnly) lanes.push({ odooSyncStatus: 'needs-review', odooLastError: { contains: SOURCE_REVIEW_TEXT }, odooSaleOrderId: null });
  const ports: ExtraPorts = {
    candidates: async (afterId, limit) => await db.shipmentRecord.findMany({
      where: { id: { gt: afterId }, OR: lanes as any }, orderBy: { id: 'asc' }, take: limit, select: SELECT,
    }) as ExtraRecord[],
    async readCursor() {
      const row = await db.failedPayload.findFirst({ where: { source: EXTRA_CURSOR_SOURCE, reason: 'cursor' } });
      try { const v = Number(JSON.parse(row?.payloadJson ?? '{}').afterId); return Number.isSafeInteger(v) && v > 0 ? v : 0; } catch { return 0; }
    },
    async writeCursor(afterId) {
      const payloadJson = JSON.stringify({ version: 1, afterId, at: new Date().toISOString() });
      const row = await db.failedPayload.findFirst({ where: { source: EXTRA_CURSOR_SOURCE, reason: 'cursor' } });
      if (row) await db.failedPayload.update({ where: { id: row.id }, data: { payloadJson } });
      else await db.failedPayload.create({ data: { source: EXTRA_CURSOR_SOURCE, reason: 'cursor', payloadJson } });
    },
    claims: async orderId => (await db.failedPayload.findMany({ where: { source: CLAIM, externalId: orderId }, orderBy: { id: 'asc' } })).map(parseClaim),
    blocked: (recordId, lane) => automaticRecordBlocked(recordId, lane),
    async carrier(record) {
      const carrier = await loadExactCarrierShipment(carrierClient, record as any);
      return carrier ? { carrier: carrier as any, fingerprint: buildReturnSyncFingerprint(carrier as any) } : null;
    },
    order: async orderId => await shopifyOrdersClient.getOrderByLegacyId(orderId) as any,
    moneyUnchanged(record, order) {
      if (!moneyOnly || !record.rawOrderJson) return false;
      try { return accountingMoneyUnchanged(JSON.parse(record.rawOrderJson), order as any); } catch { return false; }
    },
    async apply(record, claims, decision, receipt) {
      return await db.$transaction(async tx => {
        await tx.$queryRawUnsafe('SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext($1))', 'automatic-order:' + record.shopifyOrderId);
        const fresh = await tx.failedPayload.findMany({ where: { source: CLAIM, externalId: record.shopifyOrderId }, orderBy: { id: 'asc' } });
        const before = claims as Array<ExtraClaim & { raw?: string }>;
        if (fresh.length !== before.length || fresh.some((c, i) => c.id !== before[i]!.id || c.payloadJson !== before[i]!.raw)) return false;
        const holds = await tx.failedPayload.findMany({ where: { source: { in: [HOLD, CLOSED] }, externalId: record.shopifyOrderId } });
        if (holds.some(h => holdApplies(h.payloadJson, decision.lane))) return false;
        const where: Record<string, unknown> = { id: record.id, updatedAt: record.updatedAt };
        const data: Record<string, unknown> = {};
        if (decision.lane === 'return') {
          Object.assign(where, { returnSyncStatus: 'needs-review', returnSyncLastError: RETURN_REVIEW_ERROR, odooInvoiceId: null });
          Object.assign(data, { returnSyncStatus: 'pending', returnSyncLastError: null, returnSyncRetryAt: null, returnSyncFingerprint: decision.returnFingerprint });
        } else {
          Object.assign(where, { odooSyncStatus: 'needs-review', odooLastError: record.odooLastError, odooSaleOrderId: null });
          Object.assign(data, { odooSyncStatus: 'odoo-so-pending', odooLastError: null, odooRetryAt: null });
        }
        if ((await tx.shipmentRecord.updateMany({ where, data })).count !== 1) return false;
        await tx.failedPayload.create({ data: { source: EXTRA_RECEIPT_SOURCE, externalId: record.shopifyOrderId,
          reason: decision.lane, payloadJson: JSON.stringify(receipt) } });
        return true;
      }, { isolationLevel: 'Serializable', timeout: 30_000, maxWait: 10_000 });
    },
  };
  return await runExtraReviewRearm(ports, { limit: options.limit, epoch, orderReferencePrefix: env.orderReferencePrefix });
}
