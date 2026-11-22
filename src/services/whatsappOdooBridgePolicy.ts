import { createHash } from 'node:crypto';

/**
 * Pure rules for WhatsApp-only Odoo orders (no Shopify order).
 *
 * Owner setup since 22 November 2026: the owner confirms an Odoo sales order,
 * then creates the Telegraph waybill by hand with carrier reference = the SO
 * name (e.g. S26318) and writes the waybill code (VI + 8 digits, e.g.
 * VI00000756) into the SO's origin / client_order_ref.
 *
 * Nothing in this file talks to a network or a database.
 */

export const BRIDGE_REF_PATTERN = /^S\d{1,9}$/;
export const BRIDGE_CODE_PATTERN = /^VI\d{8}$/;

export type BridgeLinkState =
  | 'unmatched'     // waybill seen, SO match not (yet) possible; re-checked
  | 'needs-review'  // conflict or unsupported case; never progressed automatically
  | 'linked'        // exact SO match registered; stock delivery not yet done
  | 'stock-done'    // SO pickings validated (goods left stock in Odoo)
  | 'invoiced'      // merchant-net customer invoice posted
  | 'paid'          // one Cash journal payment registered (terminal)
  | 'returned';     // stock returned on the same SO, SO cancelled (terminal)

export const ACTIVE_STATES: BridgeLinkState[] = ['linked', 'stock-done', 'invoiced'];
export const TERMINAL_STATES: BridgeLinkState[] = ['paid', 'returned'];

const RETURNED = new Set(['RTRN', 'RTS', 'RJCT']);
/** Pickup requested but the parcel is not yet with the carrier. */
const BEFORE_PICKUP = new Set(['PKR', 'PKM', 'PKH', 'PKD', 'PRP', 'PRPD', '']);

export interface BridgeCarrierShipment {
  id: number;
  code: string;
  refNumber?: string | null;
  price?: number | null;
  deliveredOrReturnedDate?: string | null;
  collected?: boolean | null;
  paidToCustomer?: boolean | null;
  cancelled?: boolean | null;
  collectedAmount?: number | null;
  pendingCollectionAmount?: number | null;
  returnedValue?: number | null;
  deliveryFees?: number | null;
  returnFees?: number | null;
  returningDueFees?: number | null;
  customerDue?: number | null;
  status?: { code?: string | null; name?: string | null } | null;
  returnStatus?: { code?: string | null; name?: string | null } | null;
}

export interface BridgeSaleOrder {
  id: number;
  name: string;
  state: string;
  origin?: string | false | null;
  client_order_ref?: string | false | null;
  amount_total?: number | null;
  partner_id?: [number, string] | number | false | null;
  currency_id?: [number, string] | number | false | null;
  company_id?: [number, string] | number | false | null;
  order_line?: number[];
  picking_ids?: number[];
  invoice_ids?: number[];
  note?: string | false | null;
}

export interface BridgeSaleOrderLine {
  id: number;
  product_id?: [number, string] | number | false | null;
  product_uom_qty?: number | null;
  qty_delivered?: number | null;
  qty_invoiced?: number | null;
  price_unit?: number | null;
  discount?: number | null;
  display_type?: string | false | null;
}

export interface BridgeConfig {
  enabled: boolean;
  /** observe: register links and plan actions, never write to Odoo or Telegram. */
  mode: 'observe' | 'apply';
  /** Largest customer-paid shipping allowed between waybill price and SO total. */
  maxCustomerShipping: number;
  /** A carrier return must stay stable this long before stock is returned. */
  returnGraceMs: number;
  /** SOs below this number are historical and never processed. */
  minSaleOrderNumber: number;
  discoveryPages: number;
  /** An unmatched waybill becomes a review after this long. */
  unmatchedTimeoutMs: number;
  alertChatIds: string[];
}

const flag = (value: string | undefined) => value?.trim().toLowerCase() === 'true';
const positiveNumber = (value: string | undefined, fallback: number, max: number): number => {
  const n = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= max ? n : fallback;
};

/** Default OFF. Defaults are conservative; every value is env-overridable. */
export function whatsappOdooBridgeConfig(source: Record<string, string | undefined> = process.env): BridgeConfig {
  const mode = source.WHATSAPP_ODOO_BRIDGE_MODE?.trim().toLowerCase() === 'apply' ? 'apply' : 'observe';
  const chats = (source.WHATSAPP_ODOO_BRIDGE_ALERT_CHAT_IDS?.trim()
    || source.PRODUCTION_ALERT_CHAT_IDS?.trim()
    || source.PRODUCTION_RECIPIENT_CHAT_IDS?.trim()
    || '6776051391,8615245657').split(',').map(v => v.trim()).filter(v => /^-?\d+$/.test(v));
  return {
    enabled: flag(source.WHATSAPP_ODOO_BRIDGE_ENABLED),
    mode,
    maxCustomerShipping: positiveNumber(source.WHATSAPP_ODOO_BRIDGE_MAX_CUSTOMER_SHIPPING, 150, 1000),
    returnGraceMs: positiveNumber(source.WHATSAPP_ODOO_BRIDGE_RETURN_GRACE_HOURS, 24, 240) * 3_600_000,
    minSaleOrderNumber: Math.floor(positiveNumber(source.WHATSAPP_ODOO_BRIDGE_MIN_SO_NUMBER, 26318, 1e9)),
    discoveryPages: Math.max(1, Math.floor(positiveNumber(source.WHATSAPP_ODOO_BRIDGE_DISCOVERY_PAGES, 2, 10))),
    unmatchedTimeoutMs: positiveNumber(source.WHATSAPP_ODOO_BRIDGE_UNMATCHED_TIMEOUT_HOURS, 72, 720) * 3_600_000,
    alertChatIds: [...new Set(chats)],
  };
}

export const cents = (value: number | null | undefined): number | null =>
  value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 100);
export const sameMoney = (a: number | null | undefined, b: number | null | undefined): boolean => {
  const x = cents(a), y = cents(b);
  return x !== null && y !== null && x === y;
};

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
export const relationId = (value: unknown): number | null =>
  Array.isArray(value) && typeof value[0] === 'number' ? value[0] : typeof value === 'number' ? value : null;
const relationName = (value: unknown): string => (Array.isArray(value) && typeof value[1] === 'string' ? value[1] : '');

export function isBridgeCandidate(shipment: Pick<BridgeCarrierShipment, 'code' | 'refNumber'>): boolean {
  return BRIDGE_REF_PATTERN.test(shipment.refNumber ?? '');
}

export function saleOrderNumber(name: string): number | null {
  return BRIDGE_REF_PATTERN.test(name) ? Number(name.slice(1)) : null;
}

const fingerprint = (parts: unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

/** Integrity of the SO the owner confirmed: any later edit sends the link to review. */
export function saleOrderFingerprint(so: BridgeSaleOrder, lines: BridgeSaleOrderLine[]): string {
  return fingerprint(['wa-so-v1', so.id, so.name, relationId(so.partner_id), relationId(so.currency_id),
    relationId(so.company_id), cents(so.amount_total),
    [...lines].sort((a, b) => a.id - b.id).map(l => [l.id, relationId(l.product_id), cents(l.product_uom_qty),
      cents(l.price_unit), cents(l.discount ?? 0), l.display_type || null])]);
}

export function carrierFingerprint(s: BridgeCarrierShipment): string {
  return fingerprint(['wa-carrier-v1', s.id, s.code, s.refNumber ?? null, statusCode(s), returnCode(s),
    Boolean(s.collected), Boolean(s.paidToCustomer), Boolean(s.cancelled), cents(s.price), cents(s.collectedAmount),
    cents(s.customerDue), cents(s.deliveryFees), cents(s.returnFees), cents(s.returnedValue)]);
}

export const statusCode = (s: BridgeCarrierShipment) => text(s.status?.code).toUpperCase();
export const returnCode = (s: BridgeCarrierShipment) => text(s.returnStatus?.code).toUpperCase();
export const isCarrierReturn = (s: BridgeCarrierShipment) => RETURNED.has(statusCode(s)) || RETURNED.has(returnCode(s));

export type MatchResult =
  | { kind: 'linked'; matchMethod: 'origin' | 'client_order_ref' | 'both' | 'note' | 'code-reference'; amountTotal: number }
  | { kind: 'unmatched'; reason: string }
  | { kind: 'review'; reason: string };

const stripHtml = (value: string) => value.replace(/<[^>]*>/g, ' ');

/**
 * Decide whether waybill `shipment` safely belongs to `so`.
 * `sosReferencingCode` = every SO whose origin/client_order_ref equals the code.
 */
export function matchSaleOrder(input: {
  shipment: BridgeCarrierShipment;
  saleOrders: BridgeSaleOrder[]; // exact name matches for refNumber
  sosReferencingCode: Array<Pick<BridgeSaleOrder, 'id' | 'name'>>;
  lines: BridgeSaleOrderLine[];
  config: Pick<BridgeConfig, 'maxCustomerShipping' | 'minSaleOrderNumber'>;
}): MatchResult {
  const { shipment, config } = input;
  const ref = shipment.refNumber ?? '';
  if (!BRIDGE_CODE_PATTERN.test(shipment.code)) return { kind: 'review', reason: 'waybill-code-not-hand-made-series' };
  const number = saleOrderNumber(ref);
  if (number === null) return { kind: 'review', reason: 'carrier-reference-not-sale-order' };
  if (number < config.minSaleOrderNumber) return { kind: 'review', reason: 'sale-order-before-bridge-start' };
  if (input.saleOrders.length === 0) return { kind: 'unmatched', reason: 'sale-order-not-found' };
  if (input.saleOrders.length > 1) return { kind: 'review', reason: 'sale-order-name-not-unique' };
  const so = input.saleOrders[0]!;
  if (so.name !== ref) return { kind: 'review', reason: 'sale-order-name-mismatch' };
  if (so.state === 'draft' || so.state === 'sent') return { kind: 'unmatched', reason: 'sale-order-not-confirmed' };
  if (so.state !== 'sale') return { kind: 'review', reason: `sale-order-state-${so.state || 'missing'}` };
  if (input.sosReferencingCode.some(o => o.id !== so.id)) return { kind: 'review', reason: 'waybill-code-on-another-sale-order' };

  const origin = text(so.origin), clientRef = text(so.client_order_ref);
  if ((origin && origin !== shipment.code) || (clientRef && clientRef !== shipment.code)) {
    return { kind: 'review', reason: 'sale-order-reference-names-another-waybill' };
  }
  let matchMethod: 'origin' | 'client_order_ref' | 'both' | 'note';
  if (origin && clientRef) matchMethod = 'both';
  else if (origin) matchMethod = 'origin';
  else if (clientRef) matchMethod = 'client_order_ref';
  else {
    // Fallback: the code appears as an exact token in the SO note and nowhere else.
    const note = stripHtml(text(so.note));
    const tokens = note.match(/VI\d{8}/g) ?? [];
    if (tokens.length === 0) return { kind: 'unmatched', reason: 'sale-order-has-no-waybill-reference' };
    if (!tokens.every(t => t === shipment.code)) return { kind: 'review', reason: 'sale-order-note-names-another-waybill' };
    matchMethod = 'note';
  }

  const content = checkSaleOrderContent(shipment, so, input.lines, config.maxCustomerShipping);
  if ('reason' in content) return { kind: 'review', reason: content.reason };
  return { kind: 'linked', matchMethod, amountTotal: content.amountTotal };
}

/** Currency, lines and COD amount checks shared by both match paths. */
function checkSaleOrderContent(shipment: BridgeCarrierShipment, so: BridgeSaleOrder, lines: BridgeSaleOrderLine[],
  maxCustomerShipping: number): { amountTotal: number } | { reason: string } {
  if (relationName(so.currency_id) && relationName(so.currency_id) !== 'EGP') return { reason: 'sale-order-currency-not-egp' };
  if (lines.length === 0) return { reason: 'sale-order-has-no-lines' };
  const productLines = lines.filter(l => !l.display_type || l.display_type === 'product');
  if (productLines.length === 0) return { reason: 'sale-order-has-no-product-lines' };
  if (productLines.some(l => Number(l.product_uom_qty ?? 0) <= 0 || Number(l.price_unit ?? 0) < 0 ||
      Number(l.discount ?? 0) < 0 || Number(l.discount ?? 0) >= 100)) {
    return { reason: 'sale-order-has-negative-or-zero-line' };
  }
  const amountTotal = Number(so.amount_total);
  if (!Number.isFinite(amountTotal) || amountTotal <= 0) return { reason: 'sale-order-total-not-positive' };
  const amount = checkWaybillAmount(shipment, amountTotal, maxCustomerShipping);
  if (amount) return { reason: amount };
  return { amountTotal };
}

/**
 * Hand-made waybill with NO carrier reference (older WhatsApp orders): it can
 * only be matched by an SO whose origin/client_order_ref is exactly its code.
 * Only active waybills qualify: not cancelled, not returned, not already
 * delivered and merchant-settled.
 */
export function isCodeReferenceCandidate(s: BridgeCarrierShipment): boolean {
  if (!BRIDGE_CODE_PATTERN.test(s.code) || (s.refNumber ?? '').trim() !== '') return false;
  if (s.cancelled || isCarrierReturn(s)) return false;
  return !(statusCode(s) === 'DTR' && s.paidToCustomer);
}

/**
 * Match path for empty-reference waybills. `sosReferencingCode` holds the full
 * SO records whose origin or client_order_ref equals the code.
 * `none` = no SO references the code (not a WhatsApp-only order; no link row).
 */
export function matchSaleOrderByCode(input: {
  shipment: BridgeCarrierShipment;
  sosReferencingCode: BridgeSaleOrder[];
  lines: BridgeSaleOrderLine[];
  config: Pick<BridgeConfig, 'maxCustomerShipping' | 'minSaleOrderNumber'>;
}): MatchResult | { kind: 'none' } {
  const { shipment, config } = input;
  if (!BRIDGE_CODE_PATTERN.test(shipment.code) || (shipment.refNumber ?? '').trim() !== '') return { kind: 'none' };
  if (input.sosReferencingCode.length === 0) return { kind: 'none' };
  if (input.sosReferencingCode.length > 1) return { kind: 'review', reason: 'waybill-code-on-several-sale-orders' };
  const so = input.sosReferencingCode[0]!;
  const number = saleOrderNumber(so.name);
  if (number === null) return { kind: 'review', reason: 'sale-order-name-not-standard' };
  if (number < config.minSaleOrderNumber) return { kind: 'review', reason: 'sale-order-before-bridge-start' };
  if (so.state === 'draft' || so.state === 'sent') return { kind: 'unmatched', reason: 'sale-order-not-confirmed' };
  if (so.state !== 'sale') return { kind: 'review', reason: `sale-order-state-${so.state || 'missing'}` };
  const origin = text(so.origin), clientRef = text(so.client_order_ref);
  if (origin !== shipment.code && clientRef !== shipment.code) return { kind: 'review', reason: 'sale-order-reference-not-exact' };
  if ((origin && origin !== shipment.code) || (clientRef && clientRef !== shipment.code)) {
    return { kind: 'review', reason: 'sale-order-reference-names-another-waybill' };
  }
  const content = checkSaleOrderContent(shipment, so, input.lines, config.maxCustomerShipping);
  if ('reason' in content) return { kind: 'review', reason: content.reason };
  return { kind: 'linked', matchMethod: 'code-reference', amountTotal: content.amountTotal };
}

export type StockKind = 'stock' | 'service-only' | 'review';

/**
 * service-only: no pickings and every product line is a service (e.g. the
 * generic "WhatsApp Sale" product): there is no stock to deliver or return.
 * Pickings missing on goods lines is never guessed.
 */
export function saleOrderStockKind(so: BridgeSaleOrder, lines: BridgeSaleOrderLine[], productTypes: Map<number, string>): StockKind {
  const productLines = lines.filter(l => !l.display_type || l.display_type === 'product');
  const allService = productLines.length > 0 && productLines.every(l => productTypes.get(relationId(l.product_id) ?? -1) === 'service');
  if ((so.picking_ids ?? []).length > 0) return allService ? 'review' : 'stock';
  return allService ? 'service-only' : 'review';
}

/** Waybill COD must be the SO total plus a plausible customer shipping charge. */
export function checkWaybillAmount(shipment: BridgeCarrierShipment, soTotal: number, maxCustomerShipping: number): string | null {
  const price = cents(shipment.price), total = cents(soTotal);
  if (price === null) return 'waybill-price-unknown';
  if (price < 0) return 'waybill-price-negative';
  if (price === 0) return 'waybill-price-zero-prepaid-or-exchange';
  if (total === null) return 'sale-order-total-unknown';
  const shipping = price - total;
  if (shipping < 0) return 'waybill-price-below-sale-order-total';
  if (shipping > Math.round(maxCustomerShipping * 100)) return 'waybill-price-exceeds-sale-order-total-plus-shipping';
  return null;
}

/** Merchant net the bot books for COD: Telegraph customerDue. */
export function merchantTarget(shipment: BridgeCarrierShipment): number | null {
  const due = cents(shipment.customerDue), collected = cents(shipment.collectedAmount);
  if (due === null || collected === null || due <= 0 || due > collected) return null;
  return due / 100;
}

export type CarrierDecision =
  | { kind: 'wait'; reason: string }
  | { kind: 'deliver-stock' }
  | { kind: 'settle'; target: number }
  | { kind: 'return' }
  | { kind: 'review'; reason: string };

/**
 * What the CURRENT carrier truth asks for, given the link phase.
 * Settlement requires delivered + collected + merchant settled (paidToCustomer).
 */
export function decideCarrierAction(input: {
  state: BridgeLinkState;
  shipment: BridgeCarrierShipment;
  soAmountTotal: number;
  maxCustomerShipping: number;
}): CarrierDecision {
  const { state, shipment: s } = input;
  const code = statusCode(s);
  if (isCarrierReturn(s)) {
    if (code === 'DTR' || cents(s.collectedAmount) !== 0) return { kind: 'review', reason: 'carrier-return-with-collection-or-exchange' };
    if (state === 'linked') return { kind: 'review', reason: 'carrier-return-before-odoo-delivery' };
    if (state === 'stock-done') return { kind: 'return' };
    return { kind: 'review', reason: 'carrier-return-after-invoice' };
  }
  if (s.cancelled) return { kind: 'review', reason: 'carrier-waybill-cancelled' };
  const amount = checkWaybillAmount(s, input.soAmountTotal, input.maxCustomerShipping);
  if (amount) return { kind: 'review', reason: amount };
  if (state === 'linked') {
    return BEFORE_PICKUP.has(code) ? { kind: 'wait', reason: 'awaiting-carrier-pickup' } : { kind: 'deliver-stock' };
  }
  if (code !== 'DTR') return { kind: 'wait', reason: 'awaiting-delivery' };
  if (cents(s.customerDue) !== null && cents(s.customerDue)! < 0) return { kind: 'review', reason: 'carrier-customer-due-negative' };
  if (!(s.collected || s.paidToCustomer)) return { kind: 'wait', reason: 'awaiting-collection' };
  if (!s.paidToCustomer) return { kind: 'wait', reason: 'awaiting-merchant-settlement' };
  if (!sameMoney(s.collectedAmount, s.price)) return { kind: 'review', reason: 'partial-or-different-collection' };
  if (cents(s.returnedValue) !== null && cents(s.returnedValue)! !== 0) return { kind: 'review', reason: 'carrier-returned-value-on-delivery' };
  const target = merchantTarget(s);
  if (target === null) return { kind: 'review', reason: 'merchant-net-not-computable' };
  return { kind: 'settle', target };
}

export interface BridgeInvoice {
  id: number;
  name?: string | null;
  move_type?: string | null;
  state?: string | null;
  payment_state?: string | null;
  amount_total?: number | null;
  amount_residual?: number | null;
  partner_id?: [number, string] | number | false | null;
  commercial_partner_id?: [number, string] | number | false | null;
  invoice_origin?: string | false | null;
}

export type InvoicePlan =
  | { kind: 'create' }
  | { kind: 'adopt-unpaid'; invoice: BridgeInvoice }
  | { kind: 'adopt-paid'; invoice: BridgeInvoice }
  | { kind: 'review'; reason: string };

/** Never edit, reset or duplicate an invoice the owner created. */
export function planInvoice(invoices: BridgeInvoice[], target: number): InvoicePlan {
  const active = invoices.filter(i => i.state !== 'cancel');
  if (active.some(i => i.move_type !== 'out_invoice')) return { kind: 'review', reason: 'sale-order-has-credit-note' };
  if (active.length === 0) return { kind: 'create' };
  if (active.length > 1) return { kind: 'review', reason: 'sale-order-has-multiple-invoices' };
  const inv = active[0]!;
  if (inv.state !== 'posted') return { kind: 'review', reason: 'existing-invoice-not-posted' };
  if (!sameMoney(inv.amount_total, target)) return { kind: 'review', reason: 'existing-invoice-total-differs-from-merchant-net' };
  if (['paid', 'in_payment'].includes(inv.payment_state ?? '') && (cents(inv.amount_residual) ?? 1) === 0) return { kind: 'adopt-paid', invoice: inv };
  if (inv.payment_state === 'not_paid' && sameMoney(inv.amount_residual, target)) return { kind: 'adopt-unpaid', invoice: inv };
  return { kind: 'review', reason: 'existing-invoice-partially-paid' };
}

export function reviewMessage(link: { accurateShipmentCode: string; carrierRefNumber: string; reviewReason?: string | null }): string {
  return [
    '⚠️ طلب واتساب (أودو فقط) محتاج مراجعة',
    `البوليصة: ${link.accurateShipmentCode}`,
    `أمر البيع: ${link.carrierRefNumber}`,
    `السبب: ${link.reviewReason ?? 'غير معروف'}`,
    'البوت لم يغيّر أي شيء في أودو لهذا الطلب. راجعه يدويًا.',
  ].join('\n');
}
