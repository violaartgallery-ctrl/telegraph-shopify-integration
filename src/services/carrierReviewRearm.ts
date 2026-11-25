import { createHash } from 'node:crypto';
import { AutomaticOperationReviewError } from './automaticOperationSafety.js';

/**
 * Bounded native re-arm of the two zero-effect carrier-fact reviews.
 *
 * The collection and Shopify-payment lanes refuse to write when the live
 * Telegraph facts differ from the fingerprint the row was queued with, and park
 * the row in needs-review with one of the two EXACT messages below. Those rows
 * never come back, because a needs-review row is not requeued under native
 * safety. This step puts such a row back to `pending` (and nothing else) only
 * when the claim proves no external attempt was made and the current carrier,
 * Shopify and Odoo facts are the ordinary, settled, unambiguous case. The
 * normal lanes then do the accounting with all their own checks.
 */
export const COLLECTION_REVIEW_ERROR = 'Current carrier collection facts changed; no accounting write';
export const SHOPIFY_REVIEW_ERROR = 'Current carrier payment facts changed; no Shopify payment write';
export const REARM_RECEIPT_SOURCE = 'ops_carrier_review_rearm_v1';
export const REARM_CURSOR_SOURCE = 'ops_carrier_review_rearm_cursor';
export type RearmLane = 'collection' | 'shopify';

const LEGACY_CODE = /^VI0{5}\d+$/i;
const READY_ODOO = ['delivery-confirmed', 'invoice-posted', 'invoice-posted-awaiting-payment', 'paid', 'paid-existing'];

const cents = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100));
const sameMoney = (a: unknown, b: unknown) => { const x = cents(a), y = cents(b); return x !== null && x === y; };
const fixed = (v: unknown): string | null => (v === undefined || v === null || !Number.isFinite(Number(v)) ? null : Number(v).toFixed(2));
const hash = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
/** Byte-identical to buildOdooCollectionFingerprint / buildShopifyPaymentFingerprint. */
export const collectionFingerprint = (x: { code?: string | null; collectedAmount?: number | null; deliveryFees?: number | null; customerDue?: number | null }) =>
  hash(['odoo-collection-v1', x.code?.trim().toUpperCase() ?? null, fixed(x.collectedAmount), fixed(x.deliveryFees), fixed(x.customerDue)]);
export const shopifyFingerprint = (amount: number) => hash(['shopify-payment-v1', fixed(amount)]);

export interface RearmRecord {
  id: number;
  shopifyOrderId: string;
  shopifyOrderNumber: string;
  shopifyOrderName: string | null;
  accurateShipmentId: number | null;
  accurateShipmentCode: string | null;
  collectionStatus: string | null;
  collectedAmount: number | null;
  deliveryFees: number | null;
  customerDue: number | null;
  odooSyncStatus: string | null;
  odooSaleOrderId: number | null;
  odooSaleOrderName: string | null;
  odooInvoiceId: number | null;
  odooSalePaymentId: number | null;
  odooPaymentId: number | null;
  odooCollectionSyncStatus: string | null;
  odooCollectionLastError: string | null;
  odooCollectionFingerprint: string | null;
  shopifyPaymentSyncStatus: string | null;
  shopifyPaymentLastError: string | null;
  shopifyPaymentFingerprint: string | null;
  updatedAt: Date;
}
export interface RearmClaim { id: number; reason: string; payload: Record<string, unknown> }
export interface RearmCarrier {
  id: number; code: string; refNumber?: string | null; collected?: boolean | null; paidToCustomer?: boolean | null;
  cancelled?: boolean | null; collectedAmount?: number | null; deliveryFees?: number | null; customerDue?: number | null;
  status?: { code?: string | null } | null; returnStatus?: { code?: string | null } | null;
}
export interface RearmShopifyOrder {
  id: number | string; name: string; test?: boolean; cancelled_at?: string | null; financial_status?: string | null;
  current_total_price?: string; total_price: string; total_outstanding?: string; gateway?: string | null; payment_gateway_names?: string[];
}
export interface RearmOdooFacts {
  /** SOs matching the order's native reference (same domain as findExistingSaleOrder). */
  saleOrders: Array<{ id: number; name?: string; state?: string; client_order_ref?: string | false; origin?: string | false }>;
  expectedReference: string;
  /** Non-cancelled customer invoices / credit notes of the record's SO. */
  invoices: Array<{ id: number }>;
}

export type RearmDecision =
  | { kind: 'rearm'; lanes: RearmLane[]; collectionFingerprint?: string; shopifyFingerprint?: string }
  | { kind: 'skip'; reason: string };

export function reviewLanes(r: Pick<RearmRecord, 'odooCollectionSyncStatus' | 'odooCollectionLastError' | 'shopifyPaymentSyncStatus' | 'shopifyPaymentLastError'>): RearmLane[] {
  const lanes: RearmLane[] = [];
  if (r.odooCollectionSyncStatus === 'needs-review' && r.odooCollectionLastError === COLLECTION_REVIEW_ERROR) lanes.push('collection');
  if (r.shopifyPaymentSyncStatus === 'needs-review' && r.shopifyPaymentLastError === SHOPIFY_REVIEW_ERROR) lanes.push('shopify');
  return lanes;
}

/** Claim proof: the lane's own claim stopped before any external request with this exact message. */
export function claimProof(claims: RearmClaim[], lane: RearmLane): string | null {
  for (const c of claims) {
    const s = c.payload.status;
    if (s === 'claimed' || s === 'started' || s === 'needs-review') return 'unfinished-or-uncertain-claim';
  }
  const own = claims.filter(c => c.reason === `${lane}:${lane}`);
  if (own.length === 0) return 'no-lane-claim';
  if (own.some(c => c.payload.status === 'completed')) return 'lane-claim-completed';
  if (own.some(c => c.payload.requestAttempted === true)) return 'lane-claim-attempted';
  const latest = own.reduce((a, b) => (b.id > a.id ? b : a));
  const error = lane === 'collection' ? COLLECTION_REVIEW_ERROR : SHOPIFY_REVIEW_ERROR;
  if (latest.payload.status !== 'no-external-attempt' || latest.payload.requestAttempted !== false ||
      typeof latest.payload.reason !== 'string' || !latest.payload.reason.includes(error)) return 'lane-claim-not-zero-effect-review';
  return null;
}

/** Pure decision. Every condition must hold; anything else stays in review. */
export function decideRearm(input: {
  record: RearmRecord;
  claims: RearmClaim[];
  blocked: Record<RearmLane, boolean>;
  carrier: RearmCarrier | null;
  order: RearmShopifyOrder | null;
  odoo: RearmOdooFacts | null;
  orderReferencePrefix: string;
}): RearmDecision {
  const { record: r, carrier: s, order: o } = input;
  const lanes = reviewLanes(r);
  if (lanes.length === 0) return { kind: 'skip', reason: 'no-exact-carrier-fact-review' };
  if (!r.accurateShipmentId || !r.accurateShipmentCode || LEGACY_CODE.test(r.accurateShipmentCode)) return { kind: 'skip', reason: 'no-ordinary-waybill' };
  if (r.collectionStatus !== 'collected' || !(Number(r.collectedAmount) > 0)) return { kind: 'skip', reason: 'record-not-collected' };
  for (const lane of lanes) if (input.blocked[lane]) return { kind: 'skip', reason: `held-${lane}` };
  for (const lane of lanes) { const bad = claimProof(input.claims, lane); if (bad) return { kind: 'skip', reason: `${lane}:${bad}` }; }

  if (!s) return { kind: 'skip', reason: 'carrier-not-visible' };
  if (s.id !== r.accurateShipmentId || s.code !== r.accurateShipmentCode || s.refNumber !== `${input.orderReferencePrefix}-${r.shopifyOrderNumber}`) {
    return { kind: 'skip', reason: 'carrier-identity-differs' };
  }
  if ((s.status?.code ?? '').toUpperCase() !== 'DTR' || s.returnStatus?.code || s.cancelled || s.collected !== true || s.paidToCustomer !== true) {
    return { kind: 'skip', reason: 'carrier-not-delivered-collected-settled' };
  }
  if (!(cents(s.customerDue) !== null && cents(s.customerDue)! > 0 && cents(s.customerDue)! <= cents(s.collectedAmount)!)) return { kind: 'skip', reason: 'carrier-net-not-positive' };
  // Stability: the record snapshot (written by an earlier status observation)
  // must equal the current read.
  const liveCollection = collectionFingerprint({ code: s.code, collectedAmount: s.collectedAmount, deliveryFees: s.deliveryFees, customerDue: s.customerDue });
  const snapCollection = collectionFingerprint({ code: r.accurateShipmentCode, collectedAmount: r.collectedAmount, deliveryFees: r.deliveryFees, customerDue: r.customerDue });
  if (liveCollection !== snapCollection || !sameMoney(r.collectedAmount, s.collectedAmount)) return { kind: 'skip', reason: 'carrier-facts-not-yet-stable' };

  if (!o) return { kind: 'skip', reason: 'shopify-order-unreadable' };
  const gateway = (o.payment_gateway_names ?? [o.gateway]).filter(Boolean).join(' ').toLowerCase();
  if (String(o.id) !== r.shopifyOrderId || (r.shopifyOrderName && o.name !== r.shopifyOrderName) || o.test || o.cancelled_at) return { kind: 'skip', reason: 'shopify-order-not-ordinary' };
  if (o.financial_status !== 'pending' || /kashier|visa|card|instapay|paymob|valu/.test(gateway) || !/cash on delivery|\bcod\b/.test(gateway)) return { kind: 'skip', reason: 'shopify-not-unpaid-cod' };
  const total = o.current_total_price ?? o.total_price;
  if (!sameMoney(total, s.collectedAmount) || !sameMoney(total, o.total_price) || (o.total_outstanding !== undefined && !sameMoney(o.total_outstanding, total))) {
    return { kind: 'skip', reason: 'shopify-total-differs-or-refunded' };
  }

  const out: RearmLane[] = [];
  if (lanes.includes('collection')) {
    const odoo = input.odoo;
    if (!odoo || !r.odooSaleOrderId) return { kind: 'skip', reason: 'collection:no-sale-order' };
    if (!READY_ODOO.includes(r.odooSyncStatus ?? '')) return { kind: 'skip', reason: 'collection:production-not-ready' };
    const exact = odoo.saleOrders.filter(so => so.client_order_ref === odoo.expectedReference && so.origin === r.shopifyOrderName && so.state !== 'cancel');
    if (odoo.saleOrders.length !== 1 || exact.length !== 1 || exact[0]!.id !== r.odooSaleOrderId || exact[0]!.state !== 'sale') return { kind: 'skip', reason: 'collection:sale-order-not-unique' };
    if (odoo.invoices.length > 0 || r.odooInvoiceId || r.odooSalePaymentId) return { kind: 'skip', reason: 'collection:invoice-or-payment-exists' };
    out.push('collection');
  }
  if (lanes.includes('shopify')) {
    // Odoo first: Shopify payment only after the collection is completed natively.
    if (r.odooCollectionSyncStatus !== 'completed' || !r.odooInvoiceId || !(r.odooSalePaymentId ?? r.odooPaymentId)) {
      if (out.length === 0) return { kind: 'skip', reason: 'shopify:collection-not-completed' };
    } else out.push('shopify');
  }
  return {
    kind: 'rearm', lanes: out,
    ...(out.includes('collection') ? { collectionFingerprint: liveCollection } : {}),
    ...(out.includes('shopify') ? { shopifyFingerprint: shopifyFingerprint(Number(s.collectedAmount)) } : {}),
  };
}

export interface RearmPorts {
  /** Candidates with an exact carrier-fact review, id > afterId, ascending. */
  candidates(afterId: number, limit: number): Promise<RearmRecord[]>;
  readCursor(): Promise<number>;
  writeCursor(id: number): Promise<void>;
  claims(orderId: string): Promise<RearmClaim[]>;
  blocked(recordId: number, lane: RearmLane): Promise<boolean>;
  carrier(record: RearmRecord): Promise<RearmCarrier | null>;
  order(orderId: string): Promise<RearmShopifyOrder | null>;
  odoo(record: RearmRecord, order: RearmShopifyOrder): Promise<RearmOdooFacts>;
  /** One transaction under the order lock: CAS on updatedAt + exact review state + same claims; writes the receipt. */
  apply(record: RearmRecord, claims: RearmClaim[], decision: Extract<RearmDecision, { kind: 'rearm' }>, receipt: Record<string, unknown>): Promise<boolean>;
}

export async function runCarrierReviewRearm(ports: RearmPorts, options: { limit?: number; epoch?: string; orderReferencePrefix: string; now?: () => number }) {
  const limit = Math.max(1, Math.min(options.limit ?? 5, 30));
  const now = options.now ?? Date.now;
  const cursor = await ports.readCursor();
  let rows = await ports.candidates(cursor, limit);
  let wrapped = false;
  if (rows.length === 0 && cursor > 0) { rows = await ports.candidates(0, limit); wrapped = true; }
  const summary = { checked: 0, rearmed: 0, lanes: 0, skipped: {} as Record<string, number>, wrapped };
  for (const record of rows) {
    summary.checked++;
    const claims = await ports.claims(record.shopifyOrderId);
    const lanes = reviewLanes(record);
    const blocked = { collection: lanes.includes('collection') && await ports.blocked(record.id, 'collection'),
      shopify: lanes.includes('shopify') && await ports.blocked(record.id, 'shopify') };
    // Cheap local checks first; external reads only when they can matter.
    const pre = decideRearm({ record, claims, blocked, carrier: null, order: null, odoo: null, orderReferencePrefix: options.orderReferencePrefix });
    let decision: RearmDecision = pre;
    if (pre.kind === 'skip' && pre.reason === 'carrier-not-visible') {
      let carrier: RearmCarrier | null = null, order: RearmShopifyOrder | null = null, odoo: RearmOdooFacts | null = null;
      try { carrier = await ports.carrier(record); } catch (e) { if (!(e instanceof AutomaticOperationReviewError)) throw e; }
      decision = decideRearm({ record, claims, blocked, carrier, order: null, odoo: null, orderReferencePrefix: options.orderReferencePrefix });
      if (decision.kind === 'skip' && decision.reason === 'shopify-order-unreadable') {
        order = await ports.order(record.shopifyOrderId);
        decision = decideRearm({ record, claims, blocked, carrier, order, odoo: null, orderReferencePrefix: options.orderReferencePrefix });
        if (decision.kind === 'skip' && decision.reason === 'collection:no-sale-order' && order && record.odooSaleOrderId) {
          odoo = await ports.odoo(record, order);
          decision = decideRearm({ record, claims, blocked, carrier, order, odoo, orderReferencePrefix: options.orderReferencePrefix });
        }
      }
    }
    if (decision.kind === 'rearm') {
      const receipt = { version: 1, at: new Date(now()).toISOString(), recordId: record.id, orderId: record.shopifyOrderId,
        lanes: decision.lanes, previousUpdatedAt: record.updatedAt.toISOString(),
        previousCollectionFingerprint: record.odooCollectionFingerprint, collectionFingerprint: decision.collectionFingerprint ?? null,
        previousShopifyFingerprint: record.shopifyPaymentFingerprint, shopifyFingerprint: decision.shopifyFingerprint ?? null,
        claimIds: claims.map(c => c.id), epoch: options.epoch ?? null, businessWrite: false,
        rule: 'exact zero-effect carrier-fact review; no-external-attempt claim; DTR+collected+paidToCustomer; stable fingerprint; ordinary unpaid COD; unique SO without invoice' };
      if (await ports.apply(record, claims, decision, receipt)) { summary.rearmed++; summary.lanes += decision.lanes.length; }
      else summary.skipped['cas-lost'] = (summary.skipped['cas-lost'] ?? 0) + 1;
    } else summary.skipped[decision.reason] = (summary.skipped[decision.reason] ?? 0) + 1;
  }
  await ports.writeCursor(rows.length === limit ? rows[rows.length - 1]!.id : 0);
  return summary;
}
