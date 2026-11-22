import {
  COLLECTION_REVIEW_ERROR, REARM_CURSOR_SOURCE, REARM_RECEIPT_SOURCE, SHOPIFY_REVIEW_ERROR, runCarrierReviewRearm,
  type RearmClaim, type RearmLane, type RearmPorts, type RearmRecord,
} from './carrierReviewRearm.js';

const HOLD = 'ops_record_hold', CLOSED = 'ops_completion_receipt', CLAIM = 'automatic_operation_claim';
const SELECT = {
  id: true, shopifyOrderId: true, shopifyOrderNumber: true, shopifyOrderName: true, accurateShipmentId: true, accurateShipmentCode: true,
  collectionStatus: true, collectedAmount: true, deliveryFees: true, customerDue: true, odooSyncStatus: true, odooSaleOrderId: true,
  odooSaleOrderName: true, odooInvoiceId: true, odooSalePaymentId: true, odooPaymentId: true, odooCollectionSyncStatus: true,
  odooCollectionLastError: true, odooCollectionFingerprint: true, shopifyPaymentSyncStatus: true, shopifyPaymentLastError: true,
  shopifyPaymentFingerprint: true, updatedAt: true,
} as const;

const parseClaim = (row: { id: number; reason: string; payloadJson: string }): RearmClaim & { raw: string } => {
  try {
    const p = JSON.parse(row.payloadJson);
    if (p && typeof p === 'object' && !Array.isArray(p)) return { id: row.id, reason: row.reason, payload: p, raw: row.payloadJson };
  } catch { /* malformed evidence never means permission */ }
  return { id: row.id, reason: row.reason, payload: { status: 'needs-review' }, raw: row.payloadJson };
};
const holdApplies = (payloadJson: string, lane: RearmLane): boolean => {
  try { const p = JSON.parse(payloadJson); return !Array.isArray(p?.lanes) || p.lanes.some((l: unknown) => l === '*' || l === lane); }
  catch { return true; }
};

/** Native financial-lane stage. Reads Neon, Telegraph, Shopify and Odoo; writes only queue metadata + receipt. */
export async function runNativeCarrierReviewRearm(options: { limit?: number } = {}) {
  const [{ basePrisma: db }, { automaticRecordBlocked }, { loadExactCarrierShipment }, { AccurateClient }, { shopifyOrdersClient },
    { OdooClient }, { env }, { safeQueueConfig }] = await Promise.all([
    import('../lib/prisma.js'), import('./automaticOperationSafety.js'), import('./verifiedCarrierShipment.js'),
    import('../accurate/accurateClient.js'), import('../shopify/shopifyOrdersClient.js'), import('../odoo/odooClient.js'),
    import('../config/env.js'), import('./safeQueuePolicy.js')]);
  const epoch = safeQueueConfig()?.epoch;
  if (!epoch) return { skipped: 'safe-queue-release-required' };
  const carrier = new AccurateClient(), odoo = new OdooClient();
  const ports: RearmPorts = {
    candidates: async (afterId, limit) => await db.shipmentRecord.findMany({
      where: { id: { gt: afterId }, collectionStatus: 'collected', OR: [
        { odooCollectionSyncStatus: 'needs-review', odooCollectionLastError: COLLECTION_REVIEW_ERROR },
        { shopifyPaymentSyncStatus: 'needs-review', shopifyPaymentLastError: SHOPIFY_REVIEW_ERROR },
      ] }, orderBy: { id: 'asc' }, take: limit, select: SELECT,
    }) as RearmRecord[],
    async readCursor() {
      const row = await db.failedPayload.findFirst({ where: { source: REARM_CURSOR_SOURCE, reason: 'cursor' } });
      try { const v = Number(JSON.parse(row?.payloadJson ?? '{}').afterId); return Number.isSafeInteger(v) && v > 0 ? v : 0; } catch { return 0; }
    },
    async writeCursor(afterId) {
      const payloadJson = JSON.stringify({ version: 1, afterId, at: new Date().toISOString() });
      const row = await db.failedPayload.findFirst({ where: { source: REARM_CURSOR_SOURCE, reason: 'cursor' } });
      if (row) await db.failedPayload.update({ where: { id: row.id }, data: { payloadJson } });
      else await db.failedPayload.create({ data: { source: REARM_CURSOR_SOURCE, reason: 'cursor', payloadJson } });
    },
    claims: async orderId => (await db.failedPayload.findMany({ where: { source: CLAIM, externalId: orderId }, orderBy: { id: 'asc' } })).map(parseClaim),
    blocked: (recordId, lane) => automaticRecordBlocked(recordId, lane),
    carrier: async record => await loadExactCarrierShipment(carrier, record),
    order: async orderId => await shopifyOrdersClient.getOrderByLegacyId(orderId),
    async odoo(record, order) {
      const expectedReference = `${order.name} / ${env.orderReferencePrefix}-${record.shopifyOrderNumber}`;
      const saleOrders = await odoo.searchRead<{ id: number; name?: string; state?: string; client_order_ref?: string | false; origin?: string | false }>(
        'sale.order', ['|', ['client_order_ref', '=', expectedReference], ['origin', '=', order.name]], ['name', 'state', 'client_order_ref', 'origin'], { limit: 10 });
      const [so] = await odoo.searchRead<{ id: number; name?: string; invoice_ids?: number[] }>('sale.order', [['id', '=', record.odooSaleOrderId]], ['name', 'invoice_ids'], { limit: 1 });
      const invoices = so ? await odoo.searchRead<{ id: number }>('account.move', [
        ['move_type', 'in', ['out_invoice', 'out_refund']], ['state', '!=', 'cancel'],
        ...(so.invoice_ids?.length ? ['|', ['id', 'in', so.invoice_ids]] : []), ['invoice_origin', '=', so.name],
      ], ['name'], { limit: 10 }) : [{ id: -1 }];
      return { saleOrders, expectedReference, invoices };
    },
    async apply(record, claims, decision, receipt) {
      return await db.$transaction(async tx => {
        // Same lock native claims take: no claim can start while we decide.
        await tx.$queryRawUnsafe('SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext($1))', 'automatic-order:' + record.shopifyOrderId);
        const fresh = await tx.failedPayload.findMany({ where: { source: CLAIM, externalId: record.shopifyOrderId }, orderBy: { id: 'asc' } });
        const before = claims as Array<RearmClaim & { raw?: string }>;
        if (fresh.length !== before.length || fresh.some((c, i) => c.id !== before[i]!.id || c.payloadJson !== before[i]!.raw)) return false;
        const holds = await tx.failedPayload.findMany({ where: { source: { in: [HOLD, CLOSED] }, externalId: record.shopifyOrderId } });
        if (decision.lanes.some(lane => holds.some(h => holdApplies(h.payloadJson, lane)))) return false;
        const data: Record<string, unknown> = {};
        const where: Record<string, unknown> = { id: record.id, updatedAt: record.updatedAt };
        if (decision.lanes.includes('collection')) {
          Object.assign(where, { odooCollectionSyncStatus: 'needs-review', odooCollectionLastError: COLLECTION_REVIEW_ERROR, odooInvoiceId: null });
          Object.assign(data, { odooCollectionSyncStatus: 'pending', odooCollectionLastError: null, odooCollectionRetryAt: null,
            odooCollectionClaimedAt: null, odooCollectionAttemptCount: 0, odooCollectionFingerprint: decision.collectionFingerprint });
        }
        if (decision.lanes.includes('shopify')) {
          Object.assign(where, { shopifyPaymentSyncStatus: 'needs-review', shopifyPaymentLastError: SHOPIFY_REVIEW_ERROR, odooCollectionSyncStatus: 'completed' });
          Object.assign(data, { shopifyPaymentSyncStatus: 'pending', shopifyPaymentLastError: null, shopifyPaymentRetryAt: null,
            shopifyPaymentClaimedAt: null, shopifyPaymentAttemptCount: 0, shopifyPaymentFingerprint: decision.shopifyFingerprint });
        }
        if ((await tx.shipmentRecord.updateMany({ where, data })).count !== 1) return false;
        await tx.failedPayload.create({ data: { source: REARM_RECEIPT_SOURCE, externalId: record.shopifyOrderId,
          reason: decision.lanes.join('+'), payloadJson: JSON.stringify(receipt) } });
        return true;
      }, { isolationLevel: 'Serializable', timeout: 30_000, maxWait: 10_000 });
    },
  };
  return await runCarrierReviewRearm(ports, { limit: options.limit, epoch, orderReferencePrefix: env.orderReferencePrefix });
}
