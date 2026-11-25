// Synthetic only: no network, database, credentials or real orders.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { accountingMoneyUnchanged, assertOdooProductionSourceUnchanged, bindOdooAccountingMoney } from '../services/odooShipmentBinding.js';
import { ACCOUNTANT_CATEGORIES, categorizeReviewCase, primaryCategory } from '../services/accountantCategories.js';
import { RETURN_REVIEW_ERROR, SOURCE_REVIEW_TEXT, decideExtraRearm, extraClaimProof, runExtraReviewRearm, type ExtraPorts, type ExtraRecord } from '../services/reviewRearmExtra.js';
import { renderAccountantDesk, renderAccountantDeskScript, ACCOUNTANT_RULES } from '../ui/accountantDeskUi.js';

let checks = 0;
const ok = (v: unknown, m: string) => { assert.ok(v, m); checks++; };
const eq = (a: unknown, b: unknown, m: string) => { assert.deepEqual(a, b, m); checks++; };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

// ── 1. Money-only accounting source (owner rule 12) ─────────────────────────
const order: any = {
  id: 900001, name: '#90001', order_number: 90001, currency: 'EGP', financial_status: 'pending', cancelled_at: null, test: false,
  current_total_price: '1485.00', total_price: '1485.00', current_subtotal_price: '1400.00', total_discounts: '0.00', total_tax: '0.00',
  note: 'أصلية', tags: 'Confirmed, wa-pending', shipping_address: { address1: 'شارع 1', city: 'القاهرة' },
  shipping_lines: [{ price: '85.00', discounted_price: '85.00' }],
  line_items: [
    { product_id: 1, variant_id: 11, sku: 'EAS-CAR-GRN', quantity: 1, current_quantity: 1, price: '750.00', total_discount: '0.00', properties: [{ name: 'اسم', value: 'أحمد' }] },
    { product_id: 2, variant_id: 22, sku: 'EAS-CAR-BRN', quantity: 1, current_quantity: 1, price: '650.00', total_discount: '0.00', properties: [] },
  ],
};
const noteOnly = clone(order); noteOnly.note = 'العميل عايز التوصيل بعد الضهر'; noteOnly.tags = 'wa-needs-agent, accurate-delivered';
noteOnly.shipping_address.address1 = 'شارع 2'; noteOnly.line_items[0].properties = [{ name: 'اسم', value: 'محمد' }]; noteOnly.name = '#90001';
ok(accountingMoneyUnchanged(order, noteOnly), 'notes/tags/address/customization do not change accounting money');
const paidCod = clone(order); paidCod.financial_status = 'paid';
ok(accountingMoneyUnchanged(order, paidCod), 'our own COD payment (pending -> paid) is not a money change');
const reordered = clone(order); reordered.line_items.reverse();
ok(accountingMoneyUnchanged(order, reordered), 'line order does not matter');
const removedZero = clone(order); removedZero.line_items.push({ product_id: 3, variant_id: 33, sku: 'X', quantity: 1, current_quantity: 0, price: '99.00' });
ok(accountingMoneyUnchanged(order, removedZero), 'a removed (quantity 0) line is ignored');
for (const [label, change] of [
  ['price', (o: any) => { o.line_items[0].price = '760.00'; }],
  ['colour/variant', (o: any) => { o.line_items[0].variant_id = 12; o.line_items[0].sku = 'EAS-CAR-BLK'; }],
  ['quantity', (o: any) => { o.line_items[1].current_quantity = 2; }],
  ['total', (o: any) => { o.current_total_price = '1400.00'; }],
  ['discount', (o: any) => { o.total_discounts = '50.00'; }],
  ['shipping', (o: any) => { o.shipping_lines[0].discounted_price = '0.00'; }],
  ['cancelled', (o: any) => { o.cancelled_at = '2026-11-25T00:00:00Z'; }],
  ['refund status', (o: any) => { o.financial_status = 'partially_refunded'; }],
  ['voided', (o: any) => { o.financial_status = 'voided'; }],
  ['other order', (o: any) => { o.id = 900002; }],
  ['added product', (o: any) => { o.line_items.push({ product_id: 4, variant_id: 44, sku: 'NEW', quantity: 1, current_quantity: 1, price: '10.00' }); }],
] as const) { const x = clone(order); change(x); ok(!accountingMoneyUnchanged(order, x), `${label} change still blocks`); }
const bad = clone(order); bad.line_items[0].price = 'abc';
ok(!accountingMoneyUnchanged(order, bad), 'invalid money never passes');
ok(bindOdooAccountingMoney(order).moneyKey === bindOdooAccountingMoney(reordered).moneyKey, 'canonical money key');
delete process.env.OPS_ACCOUNTING_MONEY_ONLY_SOURCE;
assert.throws(() => assertOdooProductionSourceUnchanged(order, noteOnly), /Accounting money\/products\/address\/customization changed/); checks++;
process.env.OPS_ACCOUNTING_MONEY_ONLY_SOURCE = 'true';
assertOdooProductionSourceUnchanged(order, noteOnly); checks++;
const priced = clone(order); priced.line_items[0].price = '700.00';
assert.throws(() => assertOdooProductionSourceUnchanged(order, priced), /changed/); checks++;
assertOdooProductionSourceUnchanged(order, clone(order)); checks++;
delete process.env.OPS_ACCOUNTING_MONEY_ONLY_SOURCE;

// ── 2. Categories ───────────────────────────────────────────────────────────
const cat = (reason: string, classification = 'needs-review') => categorizeReviewCase({ reason, classification });
eq(cat('Current carrier collection facts changed; no accounting write'), 'auto', 'carrier facts → bot');
eq(cat(RETURN_REVIEW_ERROR), 'auto', 'return facts → bot');
eq(cat('AUTOMATION_REVIEW_REQUIRED: Accounting money/products/address/customization changed: #1'), 'changed', 'source change');
eq(cat('AUTOMATION_REVIEW_REQUIRED: Owner-excluded recovery case'), 'clones', 'restored clones');
eq(cat('AUTOMATION_REVIEW_REQUIRED: Historical waybill is not visible; no financial/stock action'), 'no_waybill', 'invisible waybill');
eq(cat('Collected/unknown return money requires an explicit settlement decision'), 'return_money', 'return money');
eq(cat('OWNER_PARTIAL_DELIVERY_20261122: invoiced collected net 799'), 'partial', 'partial delivery');
eq(cat('Shopify payment needs review: amount-exceeds-order-total'), 'money', 'money difference');
eq(cat('AUTOMATION_OUTCOME_REVIEW: financial/stock operation may already exist; never replay'), 'uncertain', 'uncertain outcome');
eq(cat('anything', 'uncertain-claim'), 'uncertain', 'uncertain claim classification');
eq(cat('PRIMARY_RECONCILIATION_READINESS_HOLD: historical external links registered only'), 'held', 'historical hold');
eq(cat('x', 'durable-hold'), 'held', 'durable hold');
eq(cat('Internal server error'), 'new', 'unknown → new scenario');
eq(primaryCategory(['auto', 'changed']), 'changed', 'most restrictive category wins');
eq(primaryCategory(['auto', 'held']), 'held', 'held wins over bot');
eq(new Set(ACCOUNTANT_CATEGORIES.map(c => c.id)).size, ACCOUNTANT_CATEGORIES.length, 'unique category ids');
const reviewSource = readFileSync(new URL('../ui/operationsReviewUi.ts', import.meta.url), 'utf8');
ok(reviewSource.includes(`deskOrder=${JSON.stringify(ACCOUNTANT_CATEGORIES.map(c => c.id)).replace(/"/g, "'")}`), 'review list uses the same category order');

// ── 3. Extra re-arm decisions (owner rules 6 and 12) ────────────────────────
const base: ExtraRecord = {
  id: 7, shopifyOrderId: '900001', shopifyOrderNumber: '90001', shopifyOrderName: '#90001', accurateShipmentId: 501, accurateShipmentCode: 'VI0011000',
  collectionStatus: 'returned', odooSyncStatus: 'delivery-confirmed', odooLastError: null, odooSaleOrderId: 3001, odooInvoiceId: null,
  returnSyncStatus: 'needs-review', returnSyncLastError: RETURN_REVIEW_ERROR, returnSyncFingerprint: 'old', rawOrderJson: JSON.stringify(order), updatedAt: new Date('2026-11-25T08:00:00Z'),
};
const returnClaim = { id: 1, reason: 'return:return', payload: { status: 'no-external-attempt', requestAttempted: false, reason: 'AutomaticOperationReviewError: ' + RETURN_REVIEW_ERROR } };
const carrier = { id: 501, code: 'VI0011000', refNumber: 'Viola-90001', collected: false, cancelled: false, collectedAmount: 0, status: { code: 'RTRN' }, returnStatus: null };
const shop = { id: 900001, name: '#90001', test: false, cancelled_at: null, financial_status: 'pending', current_total_price: '1485.00', total_price: '1485.00', total_outstanding: '1485.00', payment_gateway_names: ['Cash on Delivery (COD)'] };
const decide = (o: Partial<Parameters<typeof decideExtraRearm>[0]> = {}) => decideExtraRearm({ record: base, claims: [returnClaim], blocked: false, orderReferencePrefix: 'Viola', carrier, liveReturnFingerprint: 'live', order: shop, ...o });
eq(decide(), { kind: 'rearm', lane: 'return', returnFingerprint: 'live' }, 'goods back, no money → return lane');
eq(decide({ blocked: true }).kind, 'skip', 'held stays');
eq(decide({ claims: [] }), { kind: 'skip', reason: 'return:no-lane-claim' }, 'needs zero-effect claim');
eq(decide({ claims: [{ ...returnClaim, payload: { ...returnClaim.payload, requestAttempted: true } }] }).kind, 'skip', 'attempted claim never re-armed');
eq(decide({ claims: [returnClaim, { id: 2, reason: 'collection:collection', payload: { status: 'started' } }] }).kind, 'skip', 'any unfinished claim blocks');
eq(decide({ carrier: { ...carrier, collectedAmount: 85, collected: true } }), { kind: 'skip', reason: 'return:not-back-without-money' }, 'shipping fee collected → accountant (rule 7)');
eq(decide({ carrier: { ...carrier, status: { code: 'RTS' } } }), { kind: 'skip', reason: 'return:not-back-without-money' }, 'still on the way back');
eq(decide({ carrier: { ...carrier, refNumber: 'Viola-1' } }), { kind: 'skip', reason: 'carrier-identity-differs' }, 'wrong waybill');
eq(decide({ order: { ...shop, financial_status: 'paid' } }), { kind: 'skip', reason: 'shopify-not-unpaid-cod' }, 'prepaid return → accountant');
eq(decide({ order: { ...shop, payment_gateway_names: ['kashier'] } }), { kind: 'skip', reason: 'shopify-not-unpaid-cod' }, 'gateway order');
eq(decide({ record: { ...base, odooInvoiceId: 5 } }).kind, 'skip', 'invoiced SO not touched');
eq(decide({ carrier: null }), { kind: 'skip', reason: 'carrier-not-visible' }, 'carrier needed');
const sourceRecord: ExtraRecord = { ...base, returnSyncStatus: null, returnSyncLastError: null, odooSyncStatus: 'needs-review',
  odooLastError: `AUTOMATION_REVIEW_REQUIRED: ${SOURCE_REVIEW_TEXT}: #90001`, odooSaleOrderId: null, collectionStatus: 'collected' };
const sourceClaim = { id: 3, reason: 'production:odoo-so-pending', payload: { status: 'no-external-attempt', requestAttempted: false, reason: 'Error: AUTOMATION_REVIEW_REQUIRED: ' + SOURCE_REVIEW_TEXT + ': #90001' } };
const decideSource = (o: Partial<Parameters<typeof decideExtraRearm>[0]> = {}) => decideExtraRearm({ record: sourceRecord, claims: [sourceClaim], blocked: false, orderReferencePrefix: 'Viola', carrier: null, order: shop, moneyUnchanged: true, ...o });
eq(decideSource(), { kind: 'rearm', lane: 'production' }, 'note-only change → production lane again');
eq(decideSource({ moneyUnchanged: false }), { kind: 'skip', reason: 'production:money-or-products-changed' }, 'real change stays for accountant');
eq(decideSource({ record: { ...sourceRecord, odooSaleOrderId: 9 } }), { kind: 'skip', reason: 'production:sale-order-already-linked' }, 'never a second SO');
eq(decideSource({ order: { ...shop, cancelled_at: '2026-11-25' } }), { kind: 'skip', reason: 'shopify-order-not-ordinary' }, 'cancelled order stays');
eq(decideSource({ record: { ...sourceRecord, odooLastError: `AUTOMATION_REVIEW_REQUIRED: ${SOURCE_REVIEW_TEXT}: #1` } }), { kind: 'skip', reason: 'no-exact-zero-effect-review' }, 'exact order name required');
eq(extraClaimProof([{ ...sourceClaim, payload: { ...sourceClaim.payload, status: 'completed' } }], 'production'), 'lane-claim-completed', 'completed stage never repeated');

// ── 4. Runner with synthetic ports ──────────────────────────────────────────
const applied: any[] = []; let cursor = 0;
const ports: ExtraPorts = {
  candidates: async (after, limit) => [base, sourceRecord, { ...base, id: 9, shopifyOrderId: '900009', returnSyncLastError: 'other' }].filter(r => r.id > after).slice(0, limit),
  readCursor: async () => cursor, writeCursor: async id => { cursor = id; },
  claims: async id => (id === '900001' ? [returnClaim, sourceClaim] : []),
  blocked: async () => false,
  carrier: async () => ({ carrier, fingerprint: 'live' }),
  order: async () => shop,
  moneyUnchanged: () => true,
  apply: async (r, _c, d, receipt) => { applied.push({ id: r.id, d, receipt }); return true; },
};
// Both synthetic rows share one order id; the first's production claim is not its lane, so it must still decide alone.
const summary = await runExtraReviewRearm(ports, { limit: 10, epoch: 'e', orderReferencePrefix: 'Viola', now: () => Date.parse('2026-11-25T10:00:00Z') });
eq(summary.rearmed, 2, 'two zero-effect rows re-armed');
eq(applied.map(a => a.d.lane), ['return', 'production'], 'one lane each');
ok(applied.every(a => a.receipt.businessWrite === false && typeof a.receipt.rule === 'string'), 'receipts say no business write');
eq(summary.skipped['no-exact-zero-effect-review'], 1, 'unrelated review skipped');
eq(cursor, 0, 'cursor wraps after a short page');

// ── 5. Accountant desk UI (synthetic DOM) ───────────────────────────────────
const html = renderAccountantDesk(), script = renderAccountantDeskScript();
ok(html.includes('dir="rtl"') && html.includes('lang="ar"') && html.includes('مكتب المحاسب'), 'Arabic desk shell');
ok(!/innerHTML|insertAdjacentHTML|document\.write|setInterval|localStorage|fetch\(/.test(script), 'no HTML injection, polling, storage or own fetch');
ok(ACCOUNTANT_RULES.length === 15 && ACCOUNTANT_RULES.every((r, i) => r.n === i + 1), 'rule table complete');
const ids = new Map<string, any>(); const listeners: Record<string, Function> = {}; const dispatched: any[] = [];
class N { tag: string; children: any[] = []; style: any = {}; dataset: any = {}; attrs: any = {}; hidden = false; className = ''; type = ''; text = ''; listeners: any = {};
  constructor(tag: string) { this.tag = tag; }
  set textContent(v: string) { this.text = v; this.children = []; } get textContent(): string { return this.text + this.children.map(c => typeof c === 'string' ? c : c.textContent).join(''); }
  append(...x: any[]) { this.children.push(...x); } appendChild(x: any) { this.children.push(x); return x; } replaceChildren() { this.children = []; this.text = ''; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; } getAttribute(k: string) { return this.attrs[k]; }
  addEventListener(k: string, f: Function) { this.listeners[k] = f; }
  querySelectorAll(sel: string) { const out: any[] = []; const walk = (n: any) => { for (const c of n.children ?? []) { if (typeof c !== 'string') { if (sel === '.ad-cat' && c.className === 'ad-cat') out.push(c); walk(c); } } }; walk(this); return out; }
  scrollIntoView() {} }
for (const id of ['accountant-desk', 'ad-time', 'ad-summary', 'ad-stack', 'ad-cats', 'ad-hint', 'ad-all', 'ad-rules']) { const n = new N('div'); ids.set(id, n); }
const g: any = {
  document: { getElementById: (id: string) => ids.get(id), createElement: (t: string) => new N(t), createElementNS: (_: string, t: string) => new N(t) },
  window: { addEventListener: (k: string, f: Function) => { listeners[k] = f; }, dispatchEvent: (e: any) => { dispatched.push(e); } },
  CustomEvent: class { type: string; detail: unknown; constructor(t: string, o: any) { this.type = t; this.detail = o?.detail; } },
  requestAnimationFrame: (f: Function) => f(), Intl, Number, Math, Object, String, Array, Map, Set, JSON, Date,
};
vm.runInNewContext(script, g);
eq(ids.get('ad-rules').children.length, 15, 'rules rendered');
listeners['viola-operations-snapshot']!({ detail: { ok: true, generatedAt: '2026-11-25T08:00:00Z', scheduler: [{ lane: 'financial', nextAt: '2026-11-25T08:30:00Z' }], reviewCases: [
  { orderId: '1', category: 'auto' }, { orderId: '1', category: 'changed' }, { orderId: '2', category: 'auto' }, { orderId: '3', category: 'no_waybill' }, { orderId: 'x', category: 'held' },
] } });
const summaryText = ids.get('ad-summary').textContent;
ok(summaryText.includes('٣') && summaryText.includes('٢') && summaryText.includes('١'), 'three orders: two for the accountant, one for the bot');
eq(ids.get('ad-stack').children.length, 3, 'stack has one segment per non-empty category');
const buttons = ids.get('ad-cats').querySelectorAll('.ad-cat');
ok(buttons.some((b: any) => b.dataset.cat === 'changed') && buttons.some((b: any) => b.dataset.cat === 'new'), 'category buttons + always-on new-scenario button');
buttons.find((b: any) => b.dataset.cat === 'no_waybill').listeners.click();
eq(dispatched.at(-1)?.detail, 'no_waybill', 'click filters the decisions list');
ok(ids.get('ad-hint').hidden === false && ids.get('ad-all').hidden === false, 'hint and show-all appear');
listeners['viola-operations-snapshot']!({ detail: { ok: true, reviewCases: 'bad' } });
ok(ids.get('ad-summary').textContent.includes('تعذر'), 'malformed snapshot is never shown as zero');

console.log(JSON.stringify({ ok: true, checks, realNetwork: 0, realDatabase: 0 }));
