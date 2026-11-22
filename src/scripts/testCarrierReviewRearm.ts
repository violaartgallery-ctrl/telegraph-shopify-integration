/**
 * Offline synthetic suite for the bounded carrier-fact review re-arm.
 * No database, carrier, Shopify or Odoo is contacted. Run: npm run test:carrier-review-rearm
 */
import assert from 'node:assert/strict';

for (const [key, value] of Object.entries({
  DATABASE_URL: 'postgresql://synthetic:synthetic@db.invalid/synthetic',
  SHOPIFY_SHOP_DOMAIN: 'synthetic.myshopify.com', SHOPIFY_CLIENT_ID: 'synthetic', SHOPIFY_CLIENT_SECRET: 'synthetic',
  ACCURATE_GRAPHQL_ENDPOINT: 'https://carrier.invalid/graphql', ACCURATE_USERNAME: 'synthetic', ACCURATE_PASSWORD: 'synthetic',
  ACCURATE_DEFAULT_SHIPMENT_TYPE: 'FDP', ACCURATE_DEFAULT_PAYMENT_TYPE: 'COLC',
})) process.env[key] = value;
globalThis.fetch = (async () => { throw new Error('network denied in synthetic suite'); }) as typeof fetch;

const m = await import('../services/carrierReviewRearm.js');
const native = await import('../services/shipmentStatusSyncService.js');
type Rec = import('../services/carrierReviewRearm.js').RearmRecord;
type Claim = import('../services/carrierReviewRearm.js').RearmClaim;
type Carrier = import('../services/carrierReviewRearm.js').RearmCarrier;
type Order = import('../services/carrierReviewRearm.js').RearmShopifyOrder;
type Odoo = import('../services/carrierReviewRearm.js').RearmOdooFacts;

let checks = 0;
const ok = (v: unknown, label: string) => { assert.ok(v, label); checks++; };
const eq = <T>(a: T, b: T, label: string) => { assert.deepEqual(a, b, label); checks++; };

// Fingerprints must be byte-identical to the native queue fingerprints.
for (const x of [{ code: 'VI0012405', collectedAmount: 885, deliveryFees: 76, customerDue: 809 }, { code: ' vi0012405 ', collectedAmount: 885.004, deliveryFees: null, customerDue: 0 }]) {
  eq(m.collectionFingerprint(x), native.buildOdooCollectionFingerprint(x), 'collection fingerprint identical to native');
}
eq(m.shopifyFingerprint(885), native.buildShopifyPaymentFingerprint(885), 'Shopify fingerprint identical to native');

const settledCarrier = (over: Partial<Carrier> = {}): Carrier => ({ id: 7001, code: 'VI0012405', refNumber: 'Viola-15818', status: { code: 'DTR' },
  returnStatus: null, collected: true, paidToCustomer: true, cancelled: false, collectedAmount: 885, deliveryFees: 76, customerDue: 809, ...over });
const record = (over: Partial<Rec> = {}): Rec => ({ id: 41, shopifyOrderId: '900001', shopifyOrderNumber: '15818', shopifyOrderName: '#15818',
  accurateShipmentId: 7001, accurateShipmentCode: 'VI0012405', collectionStatus: 'collected', collectedAmount: 885, deliveryFees: 76, customerDue: 809,
  odooSyncStatus: 'delivery-confirmed', odooSaleOrderId: 3001, odooSaleOrderName: 'S30001', odooInvoiceId: null, odooSalePaymentId: null, odooPaymentId: null,
  odooCollectionSyncStatus: 'needs-review', odooCollectionLastError: m.COLLECTION_REVIEW_ERROR,
  odooCollectionFingerprint: m.collectionFingerprint({ code: 'VI0012405', collectedAmount: 885, deliveryFees: 76, customerDue: 885 }),
  shopifyPaymentSyncStatus: 'needs-review', shopifyPaymentLastError: m.SHOPIFY_REVIEW_ERROR, shopifyPaymentFingerprint: 'old',
  updatedAt: new Date('2026-11-22T10:00:00Z'), ...over });
const zeroClaim = (id: number, lane: 'collection' | 'shopify'): Claim => ({ id, reason: `${lane}:${lane}`, payload: { version: 1, status: 'no-external-attempt',
  requestAttempted: false, reason: 'AutomaticOperationReviewError: ' + (lane === 'collection' ? m.COLLECTION_REVIEW_ERROR : m.SHOPIFY_REVIEW_ERROR) } });
const production: Claim = { id: 1, reason: 'production:so', payload: { status: 'completed', requestAttempted: true } };
const order = (over: Partial<Order> = {}): Order => ({ id: '900001', name: '#15818', financial_status: 'pending', current_total_price: '885.00',
  total_price: '885.00', total_outstanding: '885.00', payment_gateway_names: ['Cash on Delivery (COD)'], ...over });
const odoo = (over: Partial<Odoo> = {}): Odoo => ({ expectedReference: '#15818 / Viola-15818',
  saleOrders: [{ id: 3001, name: 'S30001', state: 'sale', client_order_ref: '#15818 / Viola-15818', origin: '#15818' }], invoices: [], ...over });
const decide = (o: { r?: Partial<Rec>; claims?: Claim[]; blocked?: Partial<Record<'collection' | 'shopify', boolean>>; s?: Partial<Carrier> | null; order?: Partial<Order> | null; odoo?: Partial<Odoo> | null } = {}) =>
  m.decideRearm({ record: record(o.r), claims: o.claims ?? [production, zeroClaim(10, 'collection'), zeroClaim(11, 'shopify')],
    blocked: { collection: false, shopify: false, ...o.blocked }, carrier: o.s === null ? null : settledCarrier(o.s ?? {}),
    order: o.order === null ? null : order(o.order ?? {}), odoo: o.odoo === null ? null : odoo(o.odoo ?? {}), orderReferencePrefix: 'Viola' });

const happy = decide();
eq(happy.kind, 'rearm', 'ordinary settled COD with zero-effect review is re-armed');
eq((happy as { lanes: string[] }).lanes, ['collection'], 'collection first; Shopify waits for completed collection');
eq((happy as { collectionFingerprint: string }).collectionFingerprint, m.collectionFingerprint({ code: 'VI0012405', collectedAmount: 885, deliveryFees: 76, customerDue: 809 }), 'requeued with the current stable fingerprint');
const shop = decide({ r: { odooCollectionSyncStatus: 'completed', odooCollectionLastError: null, odooInvoiceId: 9, odooSalePaymentId: 8 }, claims: [production, { ...zeroClaim(10, 'collection'), payload: { status: 'completed', requestAttempted: true } }, zeroClaim(11, 'shopify')] });
eq([shop.kind, (shop as { lanes: string[] }).lanes], ['rearm', ['shopify']], 'Shopify re-armed after Odoo collection completed');
eq((shop as { shopifyFingerprint: string }).shopifyFingerprint, m.shopifyFingerprint(885), 'Shopify fingerprint = current amount');
eq(decide({ r: { shopifyPaymentSyncStatus: 'pending', shopifyPaymentLastError: null } }).kind, 'rearm', 'collection-only review');
const skip = (o: Parameters<typeof decide>[0], reason: string, label: string) => { const d = decide(o); eq(d.kind === 'skip' ? d.reason : 'rearm', reason, label); };
skip({ r: { odooCollectionLastError: 'Current carrier collection facts changed; no accounting write (x)', shopifyPaymentLastError: 'other' } }, 'no-exact-carrier-fact-review', 'only the exact messages qualify');
skip({ r: { accurateShipmentCode: 'VI00000756' } }, 'no-ordinary-waybill', 'legacy hand-made code excluded');
skip({ r: { collectionStatus: 'delivered-not-collected' } }, 'record-not-collected', 'record must be collected');
skip({ blocked: { collection: true } }, 'held-collection', 'durable hold / completion receipt respected');
skip({ claims: [production, zeroClaim(11, 'shopify')] }, 'collection:no-lane-claim', 'no lane claim: no proof');
skip({ claims: [production, { ...zeroClaim(10, 'collection'), payload: { status: 'needs-review', requestAttempted: true, reason: 'x' } }, zeroClaim(11, 'shopify')] }, 'collection:unfinished-or-uncertain-claim', 'uncertain claim never re-armed');
skip({ claims: [{ id: 2, reason: 'return:return', payload: { status: 'started', requestAttempted: true } }, zeroClaim(10, 'collection'), zeroClaim(11, 'shopify')] }, 'collection:unfinished-or-uncertain-claim', 'any in-flight claim of the order blocks');
skip({ claims: [production, { ...zeroClaim(10, 'collection'), payload: { ...zeroClaim(10, 'collection').payload, requestAttempted: true } }, zeroClaim(11, 'shopify')] }, 'collection:lane-claim-attempted', 'attempted lane claim never re-armed');
skip({ claims: [production, { ...zeroClaim(10, 'collection'), payload: { ...zeroClaim(10, 'collection').payload, reason: 'Timeout' } }, zeroClaim(11, 'shopify')] }, 'collection:lane-claim-not-zero-effect-review', 'claim must carry the exact message');
skip({ claims: [production, zeroClaim(10, 'collection'), { ...zeroClaim(12, 'collection'), payload: { status: 'completed', requestAttempted: true } }, zeroClaim(11, 'shopify')] }, 'collection:lane-claim-completed', 'completed lane claim: never again');
skip({ s: null }, 'carrier-not-visible', 'carrier must be readable');
skip({ s: { refNumber: 'Viola-15819' } }, 'carrier-identity-differs', 'exact carrier reference');
skip({ s: { code: 'VI0012406' } }, 'carrier-identity-differs', 'exact carrier code');
skip({ s: { paidToCustomer: false } }, 'carrier-not-delivered-collected-settled', 'merchant settlement required');
skip({ s: { collected: false } }, 'carrier-not-delivered-collected-settled', 'collection required');
skip({ s: { status: { code: 'OTD' } } }, 'carrier-not-delivered-collected-settled', 'DTR required');
skip({ s: { returnStatus: { code: 'RTRN' } } }, 'carrier-not-delivered-collected-settled', 'no return');
skip({ s: { cancelled: true } }, 'carrier-not-delivered-collected-settled', 'not cancelled');
skip({ s: { customerDue: -76 } }, 'carrier-net-not-positive', 'negative net stays in review');
skip({ s: { customerDue: 820 } }, 'carrier-facts-not-yet-stable', 'live differs from last observation: wait');
skip({ r: { customerDue: 885 } }, 'carrier-facts-not-yet-stable', 'snapshot not yet updated: wait');
skip({ order: null }, 'shopify-order-unreadable', 'Shopify order must be readable');
skip({ order: { financial_status: 'paid' } }, 'shopify-not-unpaid-cod', 'already paid on Shopify');
skip({ order: { financial_status: 'partially_refunded' } }, 'shopify-not-unpaid-cod', 'refund excluded');
skip({ order: { financial_status: 'voided' } }, 'shopify-not-unpaid-cod', 'void excluded');
skip({ order: { payment_gateway_names: ['kashier'] } }, 'shopify-not-unpaid-cod', 'prepaid gateway excluded');
skip({ order: { current_total_price: '800.00' } }, 'shopify-total-differs-or-refunded', 'Shopify total must equal carrier collection');
skip({ order: { total_outstanding: '100.00' } }, 'shopify-total-differs-or-refunded', 'partial payment excluded');
skip({ order: { cancelled_at: '2026-11-21T00:00:00Z' } }, 'shopify-order-not-ordinary', 'cancelled order excluded');
skip({ order: { name: '#15819' } }, 'shopify-order-not-ordinary', 'order identity');
skip({ odoo: null }, 'collection:no-sale-order', 'Odoo facts required');
skip({ r: { odooSyncStatus: 'odoo-so-pending' } }, 'collection:production-not-ready', 'production must be ready');
skip({ odoo: { saleOrders: [...odoo().saleOrders, { id: 3002, name: 'S30002', state: 'sale', client_order_ref: '#15818 / Viola-15818', origin: '#15818' }] } }, 'collection:sale-order-not-unique', 'two SOs');
skip({ odoo: { saleOrders: [{ ...odoo().saleOrders[0]!, id: 3999 }] } }, 'collection:sale-order-not-unique', 'different SO than linked');
skip({ odoo: { invoices: [{ id: 5 }] } }, 'collection:invoice-or-payment-exists', 'existing invoice: never another');
skip({ r: { odooInvoiceId: 5 } }, 'collection:invoice-or-payment-exists', 'linked invoice');
skip({ r: { odooCollectionSyncStatus: 'pending', odooCollectionLastError: null } }, 'shopify:collection-not-completed', 'Shopify alone waits for Odoo');

// ------------------------------------------------------------ the runner
interface Row extends Rec { claimsRaw: Claim[] }
function fakePorts(rows: Row[], opts: { carrier?: Partial<Carrier>; casFail?: boolean } = {}) {
  let cursor = 0;
  const reads = { carrier: 0, order: 0, odoo: 0 }, receipts: Record<string, unknown>[] = [];
  const ports: import('../services/carrierReviewRearm.js').RearmPorts = {
    candidates: async (after, limit) => rows.filter(r => r.id > after && m.reviewLanes(r).length > 0).sort((a, b) => a.id - b.id).slice(0, limit).map(r => ({ ...r })),
    readCursor: async () => cursor,
    writeCursor: async id => { cursor = id; },
    claims: async id => structuredClone(rows.find(r => r.shopifyOrderId === id)!.claimsRaw),
    blocked: async () => false,
    carrier: async r => { reads.carrier++; return settledCarrier({ id: r.accurateShipmentId!, code: r.accurateShipmentCode!, refNumber: 'Viola-' + r.shopifyOrderNumber, ...opts.carrier }); },
    order: async id => { reads.order++; const r = rows.find(x => x.shopifyOrderId === id)!; return order({ id, name: r.shopifyOrderName! }); },
    odoo: async r => { reads.odoo++; return odoo({ expectedReference: `${r.shopifyOrderName} / Viola-${r.shopifyOrderNumber}`,
      saleOrders: [{ id: r.odooSaleOrderId!, name: 'S', state: 'sale', client_order_ref: `${r.shopifyOrderName} / Viola-${r.shopifyOrderNumber}`, origin: r.shopifyOrderName! }] }); },
    apply: async (rec, _claims, decision, receipt) => {
      if (opts.casFail) return false;
      const row = rows.find(r => r.id === rec.id)!;
      if (row.updatedAt.getTime() !== rec.updatedAt.getTime()) return false;
      if (decision.lanes.includes('collection')) Object.assign(row, { odooCollectionSyncStatus: 'pending', odooCollectionLastError: null, odooCollectionFingerprint: decision.collectionFingerprint });
      if (decision.lanes.includes('shopify')) Object.assign(row, { shopifyPaymentSyncStatus: 'pending', shopifyPaymentLastError: null, shopifyPaymentFingerprint: decision.shopifyFingerprint });
      row.updatedAt = new Date(row.updatedAt.getTime() + 1);
      receipts.push(receipt);
      return true;
    },
  };
  return { ports, reads, receipts, cursor: () => cursor };
}
const mkRow = (id: number, over: Partial<Rec> = {}): Row => ({ ...record({ id, shopifyOrderId: String(900000 + id), shopifyOrderNumber: String(15000 + id),
  shopifyOrderName: '#' + (15000 + id), accurateShipmentId: 7000 + id, accurateShipmentCode: 'VI00' + (12000 + id), odooSaleOrderId: 3000 + id, ...over }),
  claimsRaw: [production, zeroClaim(10, 'collection'), zeroClaim(11, 'shopify')] });
{
  const rows = Array.from({ length: 12 }, (_, i) => mkRow(i + 1));
  const f = fakePorts(rows);
  const s1 = await m.runCarrierReviewRearm(f.ports, { limit: 5, epoch: 'e', orderReferencePrefix: 'Viola' });
  eq([s1.checked, s1.rearmed, s1.lanes], [5, 5, 5], 'bounded batch of 5 per cycle');
  eq(f.cursor(), 5, 'cursor advances so later rows are not starved');
  ok(f.receipts.every(r => r.businessWrite === false && Array.isArray(r.claimIds) && r.epoch === 'e'), 'one durable receipt per re-arm, no business write');
  eq(rows.filter(r => r.odooCollectionSyncStatus === 'pending').length, 5, 'only the batch changed');
  eq(rows.every(r => r.shopifyPaymentSyncStatus === 'needs-review'), true, 'Shopify lanes untouched until Odoo completes');
  await m.runCarrierReviewRearm(f.ports, { limit: 5, orderReferencePrefix: 'Viola' });
  const s3 = await m.runCarrierReviewRearm(f.ports, { limit: 5, orderReferencePrefix: 'Viola' });
  eq(rows.filter(r => r.odooCollectionSyncStatus === 'pending').length, 12, 'all collection reviews re-armed over three cycles');
  eq(s3.checked, 2, 'last partial batch');
  eq(f.cursor(), 0, 'cursor wraps after a partial batch');
}
{
  const rows = [mkRow(1)];
  const f = fakePorts(rows, { carrier: { paidToCustomer: false } });
  const s = await m.runCarrierReviewRearm(f.ports, { limit: 5, orderReferencePrefix: 'Viola' });
  eq([s.rearmed, f.reads.order, f.reads.odoo], [0, 0, 0], 'unsettled carrier: no Shopify/Odoo reads, stays in review');
  eq(rows[0]!.odooCollectionSyncStatus, 'needs-review', 'still in review');
}
{
  const rows = [mkRow(1, { odooCollectionLastError: 'Odoo timeout', shopifyPaymentLastError: 'x' })];
  const f = fakePorts(rows);
  const s = await m.runCarrierReviewRearm(f.ports, { limit: 5, orderReferencePrefix: 'Viola' });
  eq([s.checked, f.reads.carrier], [0, 0], 'other review reasons are never candidates');
}
{
  const rows = [mkRow(1)];
  rows[0]!.claimsRaw = [production, { ...zeroClaim(10, 'collection'), payload: { status: 'needs-review', requestAttempted: true, reason: 'x' } }];
  const f = fakePorts(rows);
  const s = await m.runCarrierReviewRearm(f.ports, { limit: 5, orderReferencePrefix: 'Viola' });
  eq([s.rearmed, f.reads.carrier], [0, 0], 'uncertain claim: skipped before any external read');
}
{
  const rows = [mkRow(1)];
  const f = fakePorts(rows, { casFail: true });
  const s = await m.runCarrierReviewRearm(f.ports, { limit: 5, orderReferencePrefix: 'Viola' });
  eq([s.rearmed, s.skipped['cas-lost']], [0, 1], 'lost CAS writes nothing');
}

console.log(`carrier-review-rearm: ${checks} checks passed`);
