/**
 * Owner rules 6 and 12 (2026-11-25): bounded native re-arm of two more
 * zero-effect reviews that never come back on their own.
 *
 * - return: "Current carrier return facts changed" while the goods are back
 *   (RTRN) and the customer paid nothing. The native return lane then cancels
 *   Shopify, returns stock and books the return fee with all its own checks.
 * - production: "Accounting money/products/address/customization changed" when
 *   only notes, tags, names, addresses or customization changed (money-only
 *   accounting rule, OPS_ACCOUNTING_MONEY_ONLY_SOURCE). The native SO stage runs
 *   again from the saved snapshot.
 *
 * Every row needs a lane claim that stopped before any external request with
 * the exact review text. Anything else stays in review for the accountant.
 * This step writes queue metadata and a receipt only: never a business document.
 */
export const RETURN_REVIEW_ERROR = 'Current carrier return facts changed; do not cancel or return stock';
export const SOURCE_REVIEW_TEXT = 'Accounting money/products/address/customization changed';
export const EXTRA_RECEIPT_SOURCE = 'ops_review_rearm_extra_v1';
export const EXTRA_CURSOR_SOURCE = 'ops_review_rearm_extra_cursor';
export type ExtraLane = 'return' | 'production';

const LEGACY_CODE = /^VI0{5}\d+$/i;
const READY_ODOO = ['delivery-confirmed', 'invoice-posted', 'invoice-posted-awaiting-payment', 'paid', 'paid-existing'];
const cents = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100));
const sameMoney = (a: unknown, b: unknown) => { const x = cents(a), y = cents(b); return x !== null && x === y; };

export interface ExtraRecord {
  id: number; shopifyOrderId: string; shopifyOrderNumber: string; shopifyOrderName: string | null;
  accurateShipmentId: number | null; accurateShipmentCode: string | null; collectionStatus: string | null;
  odooSyncStatus: string | null; odooLastError: string | null; odooSaleOrderId: number | null; odooInvoiceId: number | null;
  returnSyncStatus: string | null; returnSyncLastError: string | null; returnSyncFingerprint: string | null;
  rawOrderJson: string | null; updatedAt: Date;
}
export interface ExtraClaim { id: number; reason: string; payload: Record<string, unknown> }
export interface ExtraCarrier {
  id: number; code: string; refNumber?: string | null; collected?: boolean | null; cancelled?: boolean | null;
  collectedAmount?: number | null; status?: { code?: string | null } | null; returnStatus?: { code?: string | null } | null;
}
export interface ExtraOrder {
  id: number | string; name: string; test?: boolean; cancelled_at?: string | null; financial_status?: string | null;
  current_total_price?: string; total_price: string; total_outstanding?: string; gateway?: string | null; payment_gateway_names?: string[];
}
export type ExtraDecision =
  | { kind: 'rearm'; lane: ExtraLane; returnFingerprint?: string }
  | { kind: 'skip'; reason: string };

export function extraLane(r: Pick<ExtraRecord, 'returnSyncStatus' | 'returnSyncLastError' | 'odooSyncStatus' | 'odooLastError' | 'shopifyOrderName'>): ExtraLane | null {
  if (r.returnSyncStatus === 'needs-review' && r.returnSyncLastError === RETURN_REVIEW_ERROR) return 'return';
  if (r.odooSyncStatus === 'needs-review' && r.shopifyOrderName &&
      r.odooLastError === `AUTOMATION_REVIEW_REQUIRED: ${SOURCE_REVIEW_TEXT}: ${r.shopifyOrderName}`) return 'production';
  return null;
}

/** The lane's own claim stopped before any external request with this exact review. */
export function extraClaimProof(claims: ExtraClaim[], lane: ExtraLane): string | null {
  for (const c of claims) {
    const s = c.payload.status;
    if (s === 'claimed' || s === 'started' || s === 'needs-review') return 'unfinished-or-uncertain-claim';
  }
  const key = lane === 'return' ? 'return:return' : 'production:odoo-so-pending';
  const text = lane === 'return' ? RETURN_REVIEW_ERROR : SOURCE_REVIEW_TEXT;
  const own = claims.filter(c => c.reason === key);
  if (own.length === 0) return 'no-lane-claim';
  if (own.some(c => c.payload.status === 'completed')) return 'lane-claim-completed';
  if (own.some(c => c.payload.requestAttempted === true)) return 'lane-claim-attempted';
  const latest = own.reduce((a, b) => (b.id > a.id ? b : a));
  if (latest.payload.status !== 'no-external-attempt' || latest.payload.requestAttempted !== false ||
      typeof latest.payload.reason !== 'string' || !latest.payload.reason.includes(text)) return 'lane-claim-not-zero-effect-review';
  return null;
}

const unpaidCod = (o: ExtraOrder): boolean => {
  const gateway = (o.payment_gateway_names ?? [o.gateway]).filter(Boolean).join(' ').toLowerCase();
  return o.financial_status === 'pending' && !/kashier|visa|card|instapay|paymob|valu/.test(gateway) && /cash on delivery|\bcod\b/.test(gateway);
};

/** Pure. `liveReturnFingerprint` is the native buildReturnSyncFingerprint of `carrier`. */
export function decideExtraRearm(input: {
  record: ExtraRecord; claims: ExtraClaim[]; blocked: boolean; orderReferencePrefix: string;
  carrier: ExtraCarrier | null; liveReturnFingerprint?: string | null;
  order: ExtraOrder | null; moneyUnchanged?: boolean;
}): ExtraDecision {
  const { record: r, carrier: s, order: o } = input;
  const lane = extraLane(r);
  if (!lane) return { kind: 'skip', reason: 'no-exact-zero-effect-review' };
  if (input.blocked) return { kind: 'skip', reason: `held-${lane}` };
  const bad = extraClaimProof(input.claims, lane);
  if (bad) return { kind: 'skip', reason: `${lane}:${bad}` };
  if (!r.accurateShipmentId || !r.accurateShipmentCode || LEGACY_CODE.test(r.accurateShipmentCode)) return { kind: 'skip', reason: 'no-ordinary-waybill' };

  if (lane === 'production') {
    if (r.odooSaleOrderId || r.odooInvoiceId) return { kind: 'skip', reason: 'production:sale-order-already-linked' };
    if (!r.rawOrderJson) return { kind: 'skip', reason: 'production:no-saved-snapshot' };
    if (!o) return { kind: 'skip', reason: 'shopify-order-unreadable' };
    if (String(o.id) !== r.shopifyOrderId || o.name !== r.shopifyOrderName || o.test || o.cancelled_at) return { kind: 'skip', reason: 'shopify-order-not-ordinary' };
    if (input.moneyUnchanged !== true) return { kind: 'skip', reason: 'production:money-or-products-changed' };
    return { kind: 'rearm', lane };
  }

  // return
  if (!['returned', 'returned-settled'].includes(r.collectionStatus ?? '')) return { kind: 'skip', reason: 'return:record-not-returned' };
  if (!READY_ODOO.includes(r.odooSyncStatus ?? '') || !r.odooSaleOrderId || r.odooInvoiceId) return { kind: 'skip', reason: 'return:sale-order-not-ready-or-invoiced' };
  if (!s) return { kind: 'skip', reason: 'carrier-not-visible' };
  if (s.id !== r.accurateShipmentId || s.code !== r.accurateShipmentCode || s.refNumber !== `${input.orderReferencePrefix}-${r.shopifyOrderNumber}`) {
    return { kind: 'skip', reason: 'carrier-identity-differs' };
  }
  if ((s.status?.code ?? '').toUpperCase() !== 'RTRN' || s.cancelled || s.collected === true || cents(s.collectedAmount) !== 0) {
    return { kind: 'skip', reason: 'return:not-back-without-money' };
  }
  if (!input.liveReturnFingerprint) return { kind: 'skip', reason: 'return:no-fingerprint' };
  if (!o) return { kind: 'skip', reason: 'shopify-order-unreadable' };
  if (String(o.id) !== r.shopifyOrderId || (r.shopifyOrderName && o.name !== r.shopifyOrderName) || o.test || o.cancelled_at) return { kind: 'skip', reason: 'shopify-order-not-ordinary' };
  if (!unpaidCod(o)) return { kind: 'skip', reason: 'shopify-not-unpaid-cod' };
  const total = o.current_total_price ?? o.total_price;
  if (o.total_outstanding !== undefined && !sameMoney(o.total_outstanding, total)) return { kind: 'skip', reason: 'shopify-partly-paid-or-refunded' };
  return { kind: 'rearm', lane, returnFingerprint: input.liveReturnFingerprint };
}

export interface ExtraPorts {
  candidates(afterId: number, limit: number): Promise<ExtraRecord[]>;
  readCursor(): Promise<number>;
  writeCursor(id: number): Promise<void>;
  claims(orderId: string): Promise<ExtraClaim[]>;
  blocked(recordId: number, lane: ExtraLane): Promise<boolean>;
  carrier(record: ExtraRecord): Promise<{ carrier: ExtraCarrier; fingerprint: string } | null>;
  order(orderId: string): Promise<ExtraOrder | null>;
  moneyUnchanged(record: ExtraRecord, order: ExtraOrder): boolean;
  apply(record: ExtraRecord, claims: ExtraClaim[], decision: Extract<ExtraDecision, { kind: 'rearm' }>, receipt: Record<string, unknown>): Promise<boolean>;
}

export async function runExtraReviewRearm(ports: ExtraPorts, options: { limit?: number; epoch?: string; orderReferencePrefix: string; now?: () => number }) {
  const limit = Math.max(1, Math.min(options.limit ?? 10, 30));
  const now = options.now ?? Date.now;
  const cursor = await ports.readCursor();
  let rows = await ports.candidates(cursor, limit);
  let wrapped = false;
  if (rows.length === 0 && cursor > 0) { rows = await ports.candidates(0, limit); wrapped = true; }
  const summary = { checked: 0, rearmed: 0, byLane: { return: 0, production: 0 } as Record<ExtraLane, number>, skipped: {} as Record<string, number>, wrapped };
  for (const record of rows) {
    summary.checked++;
    const lane = extraLane(record);
    const claims = await ports.claims(record.shopifyOrderId);
    const blocked = lane ? await ports.blocked(record.id, lane) : false;
    const base = { record, claims, blocked, orderReferencePrefix: options.orderReferencePrefix };
    let decision = decideExtraRearm({ ...base, carrier: null, order: null });
    // External reads only when local proof passed.
    if (decision.kind === 'skip' && (decision.reason === 'carrier-not-visible' || decision.reason === 'shopify-order-unreadable')) {
      let carrier: ExtraCarrier | null = null, fingerprint: string | null = null, order: ExtraOrder | null = null;
      if (lane === 'return') {
        try { const c = await ports.carrier(record); carrier = c?.carrier ?? null; fingerprint = c?.fingerprint ?? null; } catch { carrier = null; }
        decision = decideExtraRearm({ ...base, carrier, liveReturnFingerprint: fingerprint, order: null });
      }
      if (decision.kind === 'skip' && decision.reason === 'shopify-order-unreadable') {
        try { order = await ports.order(record.shopifyOrderId); } catch { order = null; }
        const moneyUnchanged = lane === 'production' && order ? ports.moneyUnchanged(record, order) : undefined;
        decision = decideExtraRearm({ ...base, carrier, liveReturnFingerprint: fingerprint, order, moneyUnchanged });
      }
    }
    if (decision.kind === 'rearm') {
      const receipt = { version: 1, at: new Date(now()).toISOString(), recordId: record.id, orderId: record.shopifyOrderId,
        lane: decision.lane, previousUpdatedAt: record.updatedAt.toISOString(), previousReturnFingerprint: record.returnSyncFingerprint,
        returnFingerprint: decision.returnFingerprint ?? null, claimIds: claims.map(c => c.id), epoch: options.epoch ?? null, businessWrite: false,
        rule: decision.lane === 'return'
          ? 'owner rule 6: RTRN with zero collection; no-external-attempt return claim; unpaid ordinary COD; SO without invoice'
          : 'owner rule 12: only notes/tags/names/address/customization changed; money and products identical; no SO yet' };
      if (await ports.apply(record, claims, decision, receipt)) { summary.rearmed++; summary.byLane[decision.lane]++; }
      else summary.skipped['cas-lost'] = (summary.skipped['cas-lost'] ?? 0) + 1;
    } else summary.skipped[decision.reason] = (summary.skipped[decision.reason] ?? 0) + 1;
  }
  await ports.writeCursor(rows.length === limit ? rows[rows.length - 1]!.id : 0);
  return summary;
}
