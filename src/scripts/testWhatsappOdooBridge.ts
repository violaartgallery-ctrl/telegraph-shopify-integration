/**
 * Offline synthetic suite for the WhatsApp-only Odoo bridge.
 * No database, carrier, Odoo, Shopify or Telegram is contacted: the store,
 * carrier and Odoo ports are in-memory fakes, and the one real-OdooClient test
 * uses a stubbed fetch. Run: npm run test:whatsapp-odoo-bridge
 */
import assert from 'node:assert/strict';

for (const [key, value] of Object.entries({
  DATABASE_URL: 'postgresql://synthetic:synthetic@db.invalid/synthetic',
  SHOPIFY_SHOP_DOMAIN: 'synthetic.myshopify.com', SHOPIFY_CLIENT_ID: 'synthetic', SHOPIFY_CLIENT_SECRET: 'synthetic',
  ACCURATE_GRAPHQL_ENDPOINT: 'https://carrier.invalid/graphql', ACCURATE_USERNAME: 'synthetic', ACCURATE_PASSWORD: 'synthetic',
  ACCURATE_DEFAULT_SHIPMENT_TYPE: 'FDP', ACCURATE_DEFAULT_PAYMENT_TYPE: 'COLC',
  ODOO_URL: 'https://odoo.invalid', ODOO_DB: 'synthetic', ODOO_USERNAME: 'synthetic', ODOO_PASSWORD: 'synthetic',
})) process.env[key] = value;
delete process.env.OPS_SAFE_QUEUES_ENABLED;
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error('network denied in synthetic suite'); }) as typeof fetch;

const policy = await import('../services/whatsappOdooBridgePolicy.js');
const { WhatsappOdooBridgeService, returnFingerprint } = await import('../services/whatsappOdooBridgeService.js');
const { BridgeClaimRefusedError } = await import('../services/whatsappOdooBridgeStore.js');
const { withWhatsappOdooOperation } = await import('../services/whatsappOdooOperation.js');
const safety = await import('../services/automaticOperationSafety.js');
type Store = import('../services/whatsappOdooBridgeStore.js').BridgeStore;
type Link = import('../services/whatsappOdooBridgeStore.js').BridgeLink;
type Op = import('../services/whatsappOdooBridgeStore.js').BridgeOperationRow;
type Shipment = import('../services/whatsappOdooBridgePolicy.js').BridgeCarrierShipment;
type SaleOrder = import('../services/whatsappOdooBridgePolicy.js').BridgeSaleOrder;
type Line = import('../services/whatsappOdooBridgePolicy.js').BridgeSaleOrderLine;
type Invoice = import('../services/whatsappOdooBridgePolicy.js').BridgeInvoice;

let checks = 0;
const ok = (value: unknown, label: string) => { assert.ok(value, label); checks++; };
const eq = <T>(a: T, b: T, label: string) => { assert.deepEqual(a, b, label); checks++; };
const rejects = async (p: Promise<unknown>, label: string, match?: RegExp) => {
  let failed = false;
  try { await p; } catch (error) { failed = true; if (match) assert.match(String((error as Error).message), match, label); }
  ok(failed, label);
};

// ------------------------------------------------------------- policy units
const cfg = policy.whatsappOdooBridgeConfig({});
eq(cfg.enabled, false, 'bridge is OFF by default');
eq(cfg.mode, 'observe', 'observe mode by default');
eq(cfg.maxCustomerShipping, 150, 'default max customer shipping');
eq(cfg.returnGraceMs, 24 * 3_600_000, 'default 24h return grace');
eq(cfg.minSaleOrderNumber, 26318, 'default first SO number');
const applyCfg = { ...policy.whatsappOdooBridgeConfig({ WHATSAPP_ODOO_BRIDGE_ENABLED: 'true', WHATSAPP_ODOO_BRIDGE_MODE: 'apply',
  WHATSAPP_ODOO_BRIDGE_ALERT_CHAT_IDS: '111,222,abc' }) };
eq(applyCfg.alertChatIds, ['111', '222'], 'only numeric chat ids');
eq(policy.whatsappOdooBridgeConfig({ WHATSAPP_ODOO_BRIDGE_MAX_CUSTOMER_SHIPPING: '-5' }).maxCustomerShipping, 150, 'invalid shipping ignored');

ok(policy.isBridgeCandidate({ code: 'VI00000756', refNumber: 'S26318' }), 'S-ref candidate');
ok(!policy.isBridgeCandidate({ code: 'VI0012405', refNumber: 'Viola-15818' }), 'Shopify ref is not a candidate');
ok(!policy.isBridgeCandidate({ code: 'VI00000750', refNumber: null }), 'empty ref is not a candidate');
ok(!policy.isBridgeCandidate({ code: 'VI00000750', refNumber: ' S26318' }), 'padded ref is not a candidate');
ok(!policy.isBridgeCandidate({ code: 'VI00000750', refNumber: 'S26318-2' }), 'suffixed ref is not a candidate');

const ship = (over: Partial<Shipment> = {}): Shipment => ({
  id: 9001, code: 'VI00000756', refNumber: 'S26318', price: 3150, collected: false, paidToCustomer: false, cancelled: false,
  collectedAmount: 0, customerDue: 0, deliveryFees: 71, returnFees: 0, returnedValue: 0,
  status: { code: 'PKR', name: 'طلب شحن' }, returnStatus: null, ...over,
});
const saleOrder = (over: Partial<SaleOrder> = {}): SaleOrder => ({
  id: 26318, name: 'S26318', state: 'sale', origin: 'VI00000756', client_order_ref: 'VI00000756', amount_total: 3065,
  partner_id: [43253, 'Customer'], currency_id: [74, 'EGP'], company_id: [1, 'Viola'], order_line: [501, 502],
  picking_ids: [56938, 56937], invoice_ids: [], note: '<p>بوليصة تليغراف: VI00000756</p>', ...over,
});
const lines = (): Line[] => [
  { id: 501, product_id: [10, 'Wallet'], product_uom_qty: 1, qty_delivered: 0, price_unit: 2000, discount: 0, display_type: false },
  { id: 502, product_id: [11, 'Keychain'], product_uom_qty: 1, qty_delivered: 0, price_unit: 1065, discount: 0, display_type: false },
];
const match = (over: { s?: Partial<Shipment>; so?: Partial<SaleOrder>; refs?: Array<{ id: number; name: string }>; sos?: SaleOrder[]; lines?: Line[] } = {}) =>
  policy.matchSaleOrder({ shipment: ship(over.s), saleOrders: over.sos ?? [saleOrder(over.so)], sosReferencingCode: over.refs ?? [{ id: 26318, name: 'S26318' }],
    lines: over.lines ?? lines(), config: cfg });

eq(match().kind, 'linked', 'exact origin + client_order_ref match');
eq((match() as { matchMethod: string }).matchMethod, 'both', 'both fields matched');
eq((match({ so: { origin: false } }) as { matchMethod: string }).matchMethod, 'client_order_ref', 'client_order_ref only');
eq((match({ so: { client_order_ref: false } }) as { matchMethod: string }).matchMethod, 'origin', 'origin only');
eq((match({ so: { origin: false, client_order_ref: false }, refs: [] }) as { matchMethod: string }).matchMethod, 'note', 'note token fallback');
eq(match({ so: { origin: false, client_order_ref: false, note: 'no code' }, refs: [] }).kind, 'unmatched', 'no reference anywhere: unmatched');
eq(match({ so: { origin: false, client_order_ref: false, note: 'VI00000756 and VI00000757' }, refs: [] }).kind, 'review', 'note naming another waybill');
eq(match({ so: { origin: 'VI00000755' } }).kind, 'review', 'origin names another waybill');
eq(match({ refs: [{ id: 26318, name: 'S26318' }, { id: 26400, name: 'S26400' }] }).kind, 'review', 'code on another SO');
eq(match({ sos: [] }).kind, 'unmatched', 'SO not found yet');
eq(match({ sos: [saleOrder(), saleOrder({ id: 2 })] }).kind, 'review', 'SO name not unique');
eq(match({ so: { state: 'draft' } }).kind, 'unmatched', 'draft SO waits');
eq(match({ so: { state: 'cancel' } }).kind, 'review', 'cancelled SO');
eq(match({ s: { code: 'VI0012405' } }).kind, 'review', 'bot 7-digit code series');
eq(match({ s: { refNumber: 'S100' }, so: { name: 'S100' } }).kind, 'review', 'historical SO before bridge start');
eq(match({ so: { currency_id: [2, 'USD'] } }).kind, 'review', 'non-EGP SO');
eq(match({ s: { price: 3000 } }).kind, 'review', 'COD below SO total');
eq(match({ s: { price: 3300 } }).kind, 'review', 'COD above SO total + max shipping');
eq(match({ s: { price: 3215 } }).kind, 'linked', 'COD = SO total + 150 shipping');
eq(match({ s: { price: 0 } }).kind, 'review', 'zero COD (prepaid/exchange)');
eq(match({ s: { price: -100 } }).kind, 'review', 'negative COD');
eq(match({ lines: [{ ...lines()[0]!, price_unit: -5 }] }).kind, 'review', 'negative SO line');
eq(match({ lines: [] }).kind, 'review', 'SO without lines');

const decide = (state: import('../services/whatsappOdooBridgePolicy.js').BridgeLinkState, s: Partial<Shipment>) =>
  policy.decideCarrierAction({ state, shipment: ship(s), soAmountTotal: 3065, maxCustomerShipping: 150 });
const settled = { status: { code: 'DTR' }, collected: true, paidToCustomer: true, collectedAmount: 3150, customerDue: 3079 };
eq(decide('linked', {}).kind, 'wait', 'PKR waits for pickup');
eq(decide('linked', { status: { code: 'BMT' } }).kind, 'deliver-stock', 'in carrier hands: deliver stock');
eq(decide('linked', settled).kind, 'deliver-stock', 'settled before stock: stock first');
eq(decide('stock-done', { status: { code: 'OTD' } }).kind, 'wait', 'out for delivery waits');
eq(decide('stock-done', { status: { code: 'DTR' } }).kind, 'wait', 'delivered, not collected waits');
eq(decide('stock-done', { ...settled, paidToCustomer: false }).kind, 'wait', 'collected but not merchant-settled waits');
eq(decide('stock-done', settled), { kind: 'settle', target: 3079 }, 'settled: invoice merchant net = customerDue');
eq(decide('stock-done', { ...settled, collectedAmount: 3000 }).kind, 'review', 'partial collection');
eq(decide('stock-done', { ...settled, customerDue: -71 }).kind, 'review', 'negative customerDue');
eq(decide('stock-done', { ...settled, customerDue: 3200 }).kind, 'review', 'customerDue above collection');
eq(decide('stock-done', { ...settled, returnedValue: 100 }).kind, 'review', 'returned value on delivery');
eq(decide('linked', { status: { code: 'RTRN' } }).kind, 'review', 'return before Odoo delivery');
eq(decide('stock-done', { status: { code: 'RTRN' } }).kind, 'return', 'return after stock');
eq(decide('stock-done', { status: { code: 'BMT' }, returnStatus: { code: 'RTS' } }).kind, 'return', 'return status code');
eq(decide('stock-done', { status: { code: 'RTRN' }, collectedAmount: 85 }).kind, 'review', 'return with money collected');
eq(decide('stock-done', { status: { code: 'DTR' }, returnStatus: { code: 'RTRN' } }).kind, 'review', 'exchange-like DTR + return');
eq(decide('stock-done', { status: { code: 'BMT' }, cancelled: true }).kind, 'review', 'cancelled waybill');
eq(decide('stock-done', { ...settled, price: 3500 }).kind, 'review', 'waybill price edited after link');

const inv = (over: Partial<Invoice> = {}): Invoice => ({ id: 7001, name: 'INV/1', move_type: 'out_invoice', state: 'posted',
  payment_state: 'not_paid', amount_total: 3079, amount_residual: 3079, ...over });
eq(policy.planInvoice([], 3079).kind, 'create', 'no invoice: create');
eq(policy.planInvoice([inv({ state: 'cancel' })], 3079).kind, 'create', 'cancelled invoice ignored');
eq(policy.planInvoice([inv()], 3079).kind, 'adopt-unpaid', 'exact owner invoice adopted');
eq(policy.planInvoice([inv({ payment_state: 'paid', amount_residual: 0 })], 3079).kind, 'adopt-paid', 'exact paid invoice adopted');
eq(policy.planInvoice([inv({ amount_total: 3150 })], 3079).kind, 'review', 'owner invoice total differs: never edited');
eq(policy.planInvoice([inv({ state: 'draft' })], 3079).kind, 'review', 'draft owner invoice: review');
eq(policy.planInvoice([inv(), inv({ id: 7002 })], 3079).kind, 'review', 'two invoices');
eq(policy.planInvoice([inv({ move_type: 'out_refund' })], 3079).kind, 'review', 'credit note');
eq(policy.planInvoice([inv({ payment_state: 'partial', amount_residual: 1000 })], 3079).kind, 'review', 'partially paid');

// --------------------------------------------------------------- fakes
class MemoryStore implements Store {
  links: Link[] = [];
  ops: (Op & { reason?: string | null })[] = [];
  holds = new Set<string>();
  shopifyCodes = new Set<string>();
  private nextLink = 1; private nextOp = 1;
  async findLinksByCodes(codes: string[]) { return this.links.filter(l => codes.includes(l.accurateShipmentCode)).map(l => ({ ...l })); }
  async findLinkBySaleOrderId(id: number) { const l = this.links.find(x => x.odooSaleOrderId === id); return l ? { ...l } : null; }
  async getLink(id: number) { const l = this.links.find(x => x.id === id); return l ? { ...l } : null; }
  async createLink(data: Parameters<Store['createLink']>[0]) {
    if (this.links.some(l => l.accurateShipmentCode === data.accurateShipmentCode || l.accurateShipmentId === data.accurateShipmentId ||
        (data.odooSaleOrderId != null && l.odooSaleOrderId === data.odooSaleOrderId))) return null;
    const blank = Object.fromEntries(['odooSaleOrderId', 'odooSaleOrderName', 'matchMethod', 'reviewReason', 'reviewNotifiedAt', 'plannedAction',
      'soAmountTotal', 'soPartnerId', 'soFingerprint', 'carrierStatusCode', 'carrierReturnStatusCode', 'carrierCancelled', 'carrierCollected',
      'carrierPaidToCustomer', 'carrierPrice', 'collectedAmount', 'customerDue', 'deliveryFees', 'returnFees', 'returnedValue',
      'carrierFingerprint', 'returnObservedAt', 'returnFingerprint', 'merchantTarget', 'odooInvoiceId', 'odooInvoiceName', 'odooPaymentId',
      'stockDoneAt', 'invoicedAt', 'paidAt', 'returnedAt', 'matchCheckedAt', 'lastSyncedAt', 'lastError'].map(k => [k, null]));
    const link = { ...blank, ...data, id: this.nextLink++, createdAt: new Date(clock) } as Link;
    this.links.push(link);
    return { ...link };
  }
  async updateLink(id: number, expected: string | null, patch: Parameters<Store['updateLink']>[2]) {
    const l = this.links.find(x => x.id === id);
    if (!l || (expected !== null && l.state !== expected)) return false;
    Object.assign(l, patch);
    return true;
  }
  async listLinks(states: string[], limit: number) {
    return this.links.filter(l => states.includes(l.state))
      .sort((a, b) => (a.lastSyncedAt?.getTime() ?? 0) - (b.lastSyncedAt?.getTime() ?? 0) || a.id - b.id).slice(0, limit).map(l => ({ ...l }));
  }
  async shopifyRecordUsesCode(code: string) { return this.shopifyCodes.has(code); }
  async holdApplies(link: Pick<Link, 'accurateShipmentCode' | 'carrierRefNumber'>) {
    return this.holds.has(link.accurateShipmentCode) || this.holds.has(link.carrierRefNumber);
  }
  async claimOperation(input: Parameters<Store['claimOperation']>[0]) {
    const link = this.links.find(l => l.id === input.linkId);
    if (!link || link.state !== input.expectedState) throw new BridgeClaimRefusedError('Link state changed before claim');
    if (await this.holdApplies(link)) throw new BridgeClaimRefusedError('Durable owner hold');
    const prior = this.ops.filter(o => o.linkId === input.linkId);
    if (prior.some(o => ['claimed', 'started', 'needs-review'].includes(o.status))) throw new BridgeClaimRefusedError('Unfinished or uncertain operation exists');
    const same = prior.find(o => o.key === input.key);
    if (same) {
      if (same.status !== 'no-external-attempt') throw new BridgeClaimRefusedError('Step already attempted');
      Object.assign(same, { epoch: input.epoch, token: input.token, status: 'claimed', requestAttempted: false, reason: null });
      return { ...same };
    }
    const row = { id: this.nextOp++, linkId: input.linkId, key: input.key, epoch: input.epoch, token: input.token,
      status: 'claimed' as const, requestAttempted: false };
    this.ops.push(row);
    return { ...row };
  }
  async changeOperation(id: number, token: string, from: Op['status'], patch: { status: Op['status']; requestAttempted?: boolean; reason?: string | null }) {
    const o = this.ops.find(x => x.id === id);
    if (!o || o.token !== token || o.status !== from) return false;
    Object.assign(o, patch);
    return true;
  }
  async readOperation(id: number) { const o = this.ops.find(x => x.id === id); return o ? { ...o } : null; }
}

let clock = Date.parse('2026-11-23T08:00:00Z');
const HOUR = 3_600_000;

class FakeCarrier {
  shipments = new Map<number, Shipment>();
  reads = 0;
  set(s: Shipment) { this.shipments.set(s.id, structuredClone(s)); }
  patch(id: number, over: Partial<Shipment>) { this.set({ ...this.shipments.get(id)!, ...over }); }
  async listRecent(page: number) {
    this.reads++;
    const all = [...this.shipments.values()].sort((a, b) => b.id - a.id);
    return { data: all.slice((page - 1) * 100, page * 100).map(s => structuredClone(s)), hasMorePages: all.length > page * 100 };
  }
  async listByIds(ids: number[]) { this.reads++; return ids.map(id => this.shipments.get(id)).filter(Boolean).map(s => structuredClone(s!)); }
}

type Fail = { method: string; mode: 'before-write' | 'unknown-after-write' | 'business-after-write' };
class FakeOdoo {
  sos = new Map<number, SaleOrder>();
  lineRows = new Map<number, Line>();
  pickings = new Map<number, { id: number; state: string; location_dest_id: [number, string] }>();
  invoices = new Map<number, Invoice & { lines?: number }>();
  payments = new Map<number, import('../services/whatsappOdooBridgeService.js').BridgePayment>();
  returned = new Set<number>();
  writes: string[] = [];
  fail?: Fail;
  journalType = 'cash';
  productTypes = new Map<number, string>([[10, 'product'], [11, 'product'], [99, 'service']]);
  private nextInvoice = 7001; private nextPayment = 8001;
  seed(so: SaleOrder, ls: Line[]) {
    this.sos.set(so.id, structuredClone(so));
    for (const l of ls) this.lineRows.set(l.id, structuredClone(l));
    this.pickings.set(56937, { id: 56937, state: 'assigned', location_dest_id: [5, 'Partners/Customers'] });
    this.pickings.set(56938, { id: 56938, state: 'assigned', location_dest_id: [8, 'WH/Output'] });
  }
  /** Same order as the real transport: authority hook, then the request. */
  private async write<T>(method: string, apply: () => T): Promise<T> {
    if (this.fail?.method === method && this.fail.mode === 'before-write') { this.fail = undefined; throw new Error(`synthetic rejection before ${method}`); }
    await safety.beforeAutomaticOdooWrite('synthetic', method);
    this.writes.push(method);
    const result = apply();
    if (this.fail?.method === method) {
      const mode = this.fail.mode; this.fail = undefined;
      if (mode === 'unknown-after-write') { safety.haltAutomaticOperation('ODOO_WRITE_OUTCOME_UNKNOWN'); throw new Error('Odoo mutation outcome unknown'); }
      throw new Error(`synthetic business failure after ${method}`);
    }
    return result;
  }
  port(): import('../services/whatsappOdooBridgeService.js').BridgeOdooPort {
    return {
      findSaleOrdersByName: async name => [...this.sos.values()].filter(s => s.name === name).map(s => structuredClone(s)),
      findSaleOrdersReferencingCode: async code => [...this.sos.values()].filter(s => s.origin === code || s.client_order_ref === code).map(s => ({ id: s.id, name: s.name })),
      findSaleOrdersReferencingCodes: async codes => [...this.sos.values()].filter(s => codes.includes(String(s.origin)) || codes.includes(String(s.client_order_ref))).map(s => structuredClone(s)),
      readProductTypes: async ids => new Map(ids.filter(id => this.productTypes.has(id)).map(id => [id, this.productTypes.get(id)!])),
      cancelSaleOrder: async id => this.write('cancelSaleOrder', () => { this.sos.get(id)!.state = 'cancel'; }),
      readSaleOrder: async id => structuredClone(this.sos.get(id) ?? null),
      readLines: async ids => ids.map(id => this.lineRows.get(id)).filter(Boolean).map(l => structuredClone(l!)),
      readPickings: async ids => ids.map(id => this.pickings.get(id)).filter(Boolean).map(p => structuredClone(p!)),
      readInvoices: async so => [...this.invoices.values()].filter(i => i.invoice_origin === so.name).map(i => structuredClone(i)),
      readInvoice: async id => structuredClone(this.invoices.get(id) ?? null),
      readJournal: async id => ({ id, type: this.journalType }),
      readPayment: async id => structuredClone(this.payments.get(id) ?? null),
      deliverStock: async id => this.write('deliverStock', () => {
        for (const pid of this.sos.get(id)!.picking_ids ?? []) this.pickings.get(pid)!.state = 'done';
        for (const lid of this.sos.get(id)!.order_line ?? []) { const l = this.lineRows.get(lid)!; l.qty_delivered = l.product_uom_qty; }
      }),
      createMerchantNetInvoice: async (id, target) => this.write('createMerchantNetInvoice', () => {
        const so = this.sos.get(id)!;
        const invoice = { id: this.nextInvoice++, name: `INV/2026/${this.nextInvoice}`, move_type: 'out_invoice', state: 'posted',
          payment_state: 'not_paid', amount_total: target, amount_residual: target, partner_id: so.partner_id, commercial_partner_id: so.partner_id,
          invoice_origin: so.name } as Invoice;
        this.invoices.set(invoice.id, invoice);
        so.invoice_ids = [...(so.invoice_ids ?? []), invoice.id];
        return structuredClone(invoice);
      }),
      registerPayment: async (invoiceId, amount, journalId, memo) => this.write('registerPayment', () => {
        const invoice = this.invoices.get(invoiceId)!;
        const id = this.nextPayment++;
        this.payments.set(id, { id, state: 'posted', amount, journal_id: [journalId, 'Cash'], partner_id: invoice.partner_id ?? false,
          payment_type: 'inbound', reconciled_invoice_ids: [invoiceId] });
        invoice.amount_residual = Number(invoice.amount_residual) - amount;
        invoice.payment_state = invoice.amount_residual === 0 ? 'paid' : 'partial';
        ok(memo.includes('S26318') || memo.includes('S'), 'payment memo carries SO name');
        return id;
      }),
      previewReturn: async id => ({ status: this.returned.has(id) ? 'already-complete' : 'ready' }),
      executeReturn: async id => this.write('executeReturn', () => { this.returned.add(id); this.sos.get(id)!.state = 'cancel'; return { status: 'already-complete' }; }),
    };
  }
}

const notices: string[] = [];
function world(mode: 'observe' | 'apply' = 'apply', epoch: string | undefined = 'synthetic-epoch-20261122') {
  const store = new MemoryStore(), carrier = new FakeCarrier(), odoo = new FakeOdoo();
  odoo.seed(saleOrder(), lines());
  carrier.set(ship());
  const config = { ...policy.whatsappOdooBridgeConfig({ WHATSAPP_ODOO_BRIDGE_ENABLED: 'true', WHATSAPP_ODOO_BRIDGE_MODE: mode,
    WHATSAPP_ODOO_BRIDGE_ALERT_CHAT_IDS: '6776051391' }) };
  let currentEpoch: string | undefined = epoch;
  const service = new WhatsappOdooBridgeService({ config, store, carrier, odoo: odoo.port(), paymentJournalId: 7,
    notifier: { send: async (_ids, text) => { notices.push(text); } }, now: () => clock, epoch: () => currentEpoch });
  return { store, carrier, odoo, service, setEpoch: (e: string | undefined) => { currentEpoch = e; } };
}
const linkOf = (w: ReturnType<typeof world>, code = 'VI00000756') => w.store.links.find(l => l.accurateShipmentCode === code)!;

// ------------------------------------------------------- disabled = inert
{
  const store = new MemoryStore(), carrier = new FakeCarrier(), odoo = new FakeOdoo();
  const service = new WhatsappOdooBridgeService({ config: policy.whatsappOdooBridgeConfig({}), store, carrier, odoo: odoo.port(),
    notifier: { send: async () => { throw new Error('no notice'); } }, paymentJournalId: 7 });
  eq(await service.discover(), { disabled: true }, 'disabled discovery');
  eq(await service.syncStatuses(), { disabled: true }, 'disabled status');
  eq(await service.processActions(), { disabled: true }, 'disabled actions');
  eq(carrier.reads, 0, 'disabled bridge never calls the carrier');
}

// ------------------------------------- observe mode: links but never writes
{
  const w = world('observe');
  const d = await w.service.discover();
  eq(d.registered, 1, 'observe: link registered');
  eq(linkOf(w).state, 'linked', 'observe: linked');
  eq(linkOf(w).odooSaleOrderId, 26318, 'observe: exact SO id');
  w.carrier.patch(9001, { status: { code: 'BMT' } });
  await w.service.syncStatuses();
  eq(linkOf(w).plannedAction, 'deliver-stock', 'observe: stock planned');
  const p = await w.service.processActions();
  eq(p.observe, true, 'observe: no execution');
  eq(w.odoo.writes, [], 'observe: zero Odoo writes');
  eq(w.store.ops.length, 0, 'observe: zero claims');
  w.carrier.patch(9001, { status: { code: 'RTRN' } });
  await w.service.syncStatuses();
  eq(linkOf(w).state, 'linked', 'observe: lifecycle state unchanged');
  eq(linkOf(w).plannedAction, 'review:carrier-return-before-odoo-delivery', 'observe: review only planned');
  eq(notices.length, 0, 'observe: silent (no Telegram)');
}

// --------------------------------------------- happy path S26318/VI00000756
{
  const w = world();
  await w.service.discover();
  const before = w.carrier.reads;
  const again = await w.service.discover();
  eq(again.registered, 0, 'rediscovery registers nothing');
  eq(w.store.links.length, 1, 'no duplicate link');
  ok(w.carrier.reads - before <= cfg.discoveryPages, 'rediscovery is cheap');
  await w.service.syncStatuses();
  eq(linkOf(w).plannedAction, 'wait:awaiting-carrier-pickup', 'PKR waits');
  eq((await w.service.processActions()).planned, 0, 'nothing actionable before pickup');
  w.carrier.patch(9001, { status: { code: 'BMT' } });
  await w.service.syncStatuses();
  await w.service.processActions();
  eq(linkOf(w).state, 'stock-done', 'stock delivered once in carrier hands');
  eq(w.odoo.writes, ['deliverStock'], 'one stock write');
  eq(w.store.ops.map(o => [o.key, o.status, o.requestAttempted]), [['stock:v1', 'completed', true]], 'stock claim completed');
  w.carrier.patch(9001, { status: { code: 'DTR' }, collected: true, collectedAmount: 3150 });
  await w.service.syncStatuses();
  eq(linkOf(w).plannedAction, 'wait:awaiting-merchant-settlement', 'collected waits for settlement');
  await w.service.processActions();
  eq(w.odoo.writes.length, 1, 'no invoice before merchant settlement');
  w.carrier.patch(9001, { paidToCustomer: true, customerDue: 3079 });
  await w.service.syncStatuses();
  await w.service.processActions();
  const link = linkOf(w);
  eq(link.state, 'paid', 'settled: paid');
  eq(w.odoo.writes, ['deliverStock', 'createMerchantNetInvoice', 'registerPayment'], 'exactly one invoice and one payment');
  const invoice = w.odoo.invoices.get(link.odooInvoiceId!)!;
  eq(invoice.amount_total, 3079, 'invoice = merchant net (customerDue)');
  eq(invoice.payment_state, 'paid', 'invoice paid');
  const payment = w.odoo.payments.get(link.odooPaymentId!)!;
  eq([payment.amount, (payment.journal_id as [number, string])[0]], [3079, 7], 'one Cash journal 7 payment of the net');
  eq(w.store.ops.map(o => [o.key, o.status]), [['stock:v1', 'completed'], ['invoice:v1', 'completed'], ['payment:v1', 'completed']], 'all claims completed');
  await w.service.syncStatuses(); await w.service.processActions(); await w.service.discover();
  eq(w.odoo.writes.length, 3, 'terminal link never written again');
}

// ------------------- settled before the bridge ever ran: stock then invoice
{
  const w = world();
  w.carrier.patch(9001, settled);
  await w.service.discover(); await w.service.syncStatuses(); await w.service.processActions();
  eq(linkOf(w).state, 'paid', 'stock -> invoice -> payment in one run');
  eq(w.odoo.writes, ['deliverStock', 'createMerchantNetInvoice', 'registerPayment'], 'stock before invoice');
}

// ------------------------------- owner already delivered and invoiced/paid
{
  const w = world();
  for (const p of w.odoo.pickings.values()) p.state = 'done';
  w.odoo.invoices.set(6001, { id: 6001, name: 'INV/OWNER', move_type: 'out_invoice', state: 'posted', payment_state: 'paid',
    amount_total: 3079, amount_residual: 0, invoice_origin: 'S26318' });
  w.carrier.patch(9001, settled);
  await w.service.discover(); await w.service.syncStatuses(); await w.service.processActions();
  eq(linkOf(w).state, 'paid', 'owner-paid exact invoice adopted');
  eq(w.odoo.writes, [], 'no writes when the owner already did everything');
  eq(linkOf(w).reviewReason, 'invoice-paid-outside-bridge', 'adoption recorded');
}
{
  const w = world();
  for (const p of w.odoo.pickings.values()) p.state = 'done';
  w.odoo.invoices.set(6001, { id: 6001, move_type: 'out_invoice', state: 'posted', payment_state: 'not_paid',
    amount_total: 3065, amount_residual: 3065, invoice_origin: 'S26318' });
  w.carrier.patch(9001, settled);
  await w.service.discover(); await w.service.syncStatuses(); await w.service.processActions();
  eq(linkOf(w).state, 'needs-review', 'owner invoice with a different total: review');
  eq(w.odoo.writes, [], 'never edits an owner invoice');
  ok(notices.some(n => n.includes('existing-invoice-total-differs')), 'Telegram notice sent');
}

// ------------------------------- unknown outcome on payment: never replayed
{
  const w = world();
  w.carrier.patch(9001, settled);
  await w.service.discover(); await w.service.syncStatuses();
  w.odoo.fail = { method: 'registerPayment', mode: 'unknown-after-write' };
  const r = await w.service.processActions();
  eq(r.reviews, 1, 'unknown payment outcome is a review');
  eq(linkOf(w).state, 'needs-review', 'link held for review');
  const op = w.store.ops.find(o => o.key === 'payment:v1')!;
  eq([op.status, op.requestAttempted], ['needs-review', true], 'payment claim uncertain, attempted');
  await w.service.syncStatuses(); await w.service.processActions();
  eq(w.odoo.writes.filter(x => x === 'registerPayment').length, 1, 'payment never attempted twice');
  await rejects(w.store.claimOperation({ linkId: linkOf(w).id, key: 'payment:v1', expectedState: 'needs-review', fingerprint: null,
    epoch: 'e', token: 't' }), 'uncertain claim blocks any new claim', /Unfinished|uncertain/);
}

// ------------------- business failure after invoice write: also a review
{
  const w = world();
  w.carrier.patch(9001, settled);
  await w.service.discover(); await w.service.syncStatuses();
  w.odoo.fail = { method: 'createMerchantNetInvoice', mode: 'business-after-write' };
  await w.service.processActions();
  eq(linkOf(w).state, 'needs-review', 'failure after a sent write: review');
  eq(w.store.ops.find(o => o.key === 'invoice:v1')!.status, 'needs-review', 'invoice claim uncertain');
}

// -------------------- rejection before any write: reclaimable, then succeeds
{
  const w = world();
  w.carrier.patch(9001, { status: { code: 'BMT' } });
  await w.service.discover(); await w.service.syncStatuses();
  w.odoo.fail = { method: 'deliverStock', mode: 'before-write' };
  const r = await w.service.processActions();
  eq(r.failed, 1, 'pre-write rejection counted as failure');
  eq(linkOf(w).state, 'linked', 'link not advanced');
  eq(w.store.ops[0]!.status, 'no-external-attempt', 'claim proven no-external-attempt');
  await w.service.processActions();
  eq(linkOf(w).state, 'stock-done', 'reclaimed and completed');
  eq(w.odoo.writes, ['deliverStock'], 'single real stock write');
}

// ------------------------------------------- return path with 24h grace
{
  const w = world();
  w.carrier.patch(9001, { status: { code: 'BMT' } });
  await w.service.discover(); await w.service.syncStatuses(); await w.service.processActions();
  eq(linkOf(w).state, 'stock-done', 'return setup: stock done');
  w.carrier.patch(9001, { status: { code: 'RTRN' } });
  await w.service.syncStatuses();
  ok(linkOf(w).returnObservedAt, 'return first observed');
  await w.service.processActions();
  eq(w.odoo.writes.includes('executeReturn'), false, 'no return inside the grace period');
  clock += 12 * HOUR;
  w.carrier.patch(9001, { status: { code: 'DTR' } }); // false return flips back
  await w.service.syncStatuses();
  eq(linkOf(w).returnObservedAt, null, 'false return clears the grace window');
  w.carrier.patch(9001, { status: { code: 'RTRN' } });
  await w.service.syncStatuses();
  clock += 23 * HOUR;
  await w.service.syncStatuses(); await w.service.processActions();
  eq(w.odoo.writes.includes('executeReturn'), false, 'grace restarts after a flip');
  clock += 2 * HOUR;
  await w.service.syncStatuses(); await w.service.processActions();
  eq(linkOf(w).state, 'returned', 'stable return: stock returned on the same SO');
  eq(w.odoo.writes, ['deliverStock', 'executeReturn'], 'exactly one return, no invoice');
  eq(w.odoo.invoices.size, 0, 'return creates no invoice');
  eq(returnFingerprint(w.carrier.shipments.get(9001)!), linkOf(w).returnFingerprint, 'return fingerprint persisted');
}

// ----------------------------------------- unsafe states go to review once
{
  const w = world();
  await w.service.discover();
  w.carrier.patch(9001, { status: { code: 'RTRN' } });
  const n = notices.length;
  await w.service.syncStatuses(); await w.service.syncStatuses();
  eq(linkOf(w).state, 'needs-review', 'return before Odoo delivery: review');
  eq(notices.length - n, 1, 'exactly one Telegram notice');
  eq(w.odoo.writes, [], 'no stock action guessed');
}
{
  const w = world();
  w.carrier.patch(9001, { status: { code: 'BMT' } });
  await w.service.discover(); await w.service.syncStatuses();
  w.odoo.lineRows.get(501)!.price_unit = 2100; // SO edited after linking
  await w.service.processActions();
  eq(linkOf(w).state, 'needs-review', 'SO changed after link: review');
  eq(w.odoo.writes, [], 'no write on a changed SO');
}
{
  const w = world();
  w.carrier.patch(9001, { status: { code: 'BMT' } });
  await w.service.discover(); await w.service.syncStatuses();
  w.store.holds.add('S26318');
  const r = await w.service.processActions();
  eq(r.skipped, 1, 'owner hold skips the link');
  eq(w.odoo.writes, [], 'no write under hold');
  w.store.holds.clear();
  await w.service.processActions();
  eq(linkOf(w).state, 'stock-done', 'proceeds after the hold is removed');
}
{
  const w = world();
  w.carrier.patch(9001, settled);
  await w.service.discover(); await w.service.syncStatuses();
  w.setEpoch(undefined);
  eq((await w.service.processActions()).held, 'safe-queue-epoch-missing', 'no epoch: actions held');
  eq(w.odoo.writes, [], 'no epoch: zero writes');
}
{
  const w = world();
  w.carrier.patch(9001, settled);
  await w.service.discover(); await w.service.syncStatuses();
  w.odoo.journalType = 'bank';
  await w.service.processActions();
  eq(linkOf(w).state, 'needs-review', 'payment journal must be a cash journal');
  eq(w.odoo.writes.includes('registerPayment'), false, 'no payment to a non-cash journal');
}
{
  const w = world();
  w.carrier.set(ship({ id: 9002, code: 'VI00000757' })); // second waybill, same SO
  await w.service.discover();
  const states = w.store.links.map(l => [l.accurateShipmentCode, l.state]).sort();
  eq(states, [['VI00000756', 'linked'], ['VI00000757', 'needs-review']], 'second waybill for the same SO: review');
}
{
  const w = world();
  w.store.shopifyCodes.add('VI00000756');
  await w.service.discover();
  eq(linkOf(w).state, 'needs-review', 'waybill owned by a Shopify order: review');
  eq(linkOf(w).odooSaleOrderId, null, 'no SO bound');
}
{
  const w = world();
  w.odoo.sos.get(26318)!.state = 'draft';
  await w.service.discover();
  eq(linkOf(w).state, 'unmatched', 'draft SO: unmatched');
  w.odoo.sos.get(26318)!.state = 'sale';
  await w.service.discover();
  eq(linkOf(w).state, 'unmatched', 'rematch waits an hour');
  clock += HOUR;
  await w.service.discover();
  eq(linkOf(w).state, 'linked', 'linked after the owner confirms');
}
{
  const w = world();
  w.odoo.sos.clear();
  await w.service.discover();
  clock += 80 * HOUR;
  await w.service.discover();
  eq(linkOf(w).state, 'needs-review', 'unmatched times out into review');
}
{
  const w = world();
  for (let i = 0; i < 25; i++) w.carrier.set(ship({ id: 9100 + i, code: `VI0000${String(1000 + i).padStart(4, '0')}`, refNumber: `S2${7000 + i}` }));
  const r = await w.service.discover();
  ok(Number(r.registered) + Number(r.unmatched) + Number(r.reviews) <= 10, 'at most 10 new candidates per run');
}

// ------------------- empty-reference waybills matched by SO origin/client_order_ref
const codeShip = (over: Partial<Shipment> = {}): Shipment => ship({ id: 9300, code: 'VI00000748', refNumber: null, price: 1076,
  deliveryFees: 76, status: { code: 'BMT' }, ...over });
const serviceSo = (over: Partial<SaleOrder> = {}): SaleOrder => saleOrder({ id: 26400, name: 'S26400', origin: 'VI00000748',
  client_order_ref: 'VI00000748', amount_total: 1000, order_line: [601], picking_ids: [], note: false, ...over });
const serviceLine = (): Line[] => [{ id: 601, product_id: [99, 'WhatsApp Sale'], product_uom_qty: 1, qty_delivered: 0, price_unit: 1000, discount: 0, display_type: false }];
ok(policy.isCodeReferenceCandidate(codeShip()), 'active empty-ref hand-made waybill is a candidate');
ok(policy.isCodeReferenceCandidate(codeShip({ refNumber: '  ' })), 'whitespace ref counts as empty');
ok(!policy.isCodeReferenceCandidate(codeShip({ refNumber: 'Viola-15891' })), 'Shopify ref is not a code candidate');
ok(!policy.isCodeReferenceCandidate(codeShip({ code: 'VI0012405' })), 'bot code series is not a code candidate');
ok(!policy.isCodeReferenceCandidate(codeShip({ cancelled: true })), 'cancelled waybill is not active');
ok(!policy.isCodeReferenceCandidate(codeShip({ status: { code: 'RTRN' } })), 'returned waybill is not active');
ok(!policy.isCodeReferenceCandidate(codeShip({ status: { code: 'DTR' }, paidToCustomer: true })), 'settled waybill is terminal');
ok(policy.isCodeReferenceCandidate(codeShip({ status: { code: 'DTR' }, collected: true })), 'delivered, not settled, still active');
const byCode = (sos: SaleOrder[], ls: Line[] = serviceLine(), s: Partial<Shipment> = {}) =>
  policy.matchSaleOrderByCode({ shipment: codeShip(s), sosReferencingCode: sos, lines: ls, config: cfg });
eq(byCode([serviceSo()]).kind, 'linked', 'exact code reference on one confirmed SO');
eq((byCode([serviceSo()]) as { matchMethod: string }).matchMethod, 'code-reference', 'code-reference match method');
eq(byCode([serviceSo({ client_order_ref: false })]).kind, 'linked', 'origin alone is enough');
eq(byCode([]).kind, 'none', 'no SO references the code: not a WhatsApp-only order');
eq(byCode([serviceSo(), serviceSo({ id: 26401, name: 'S26401' })]).kind, 'review', 'two SOs reference the code');
eq(byCode([serviceSo({ client_order_ref: 'VI00000749' })]).kind, 'review', 'other field names another waybill');
eq(byCode([serviceSo({ state: 'draft' })]).kind, 'unmatched', 'draft SO waits');
eq(byCode([serviceSo({ state: 'cancel' })]).kind, 'review', 'cancelled SO');
eq(byCode([serviceSo({ name: 'S100' })]).kind, 'review', 'historical SO before bridge start');
eq(byCode([serviceSo()], serviceLine(), { price: 1200 }).kind, 'review', 'COD above SO net + max shipping');
eq(byCode([serviceSo()], serviceLine(), { refNumber: 'S26400' }).kind, 'none', 'a referenced waybill uses the S-path');
const types = new Map([[10, 'product'], [11, 'product'], [99, 'service']]);
eq(policy.saleOrderStockKind(serviceSo(), serviceLine(), types), 'service-only', 'service line without pickings');
eq(policy.saleOrderStockKind(saleOrder(), lines(), types), 'stock', 'goods with pickings');
eq(policy.saleOrderStockKind(serviceSo(), lines(), types), 'review', 'goods without pickings: never guessed');
eq(policy.saleOrderStockKind(saleOrder(), serviceLine(), types), 'review', 'service-only SO with pickings: review');
eq(policy.saleOrderStockKind(serviceSo(), serviceLine(), new Map()), 'review', 'unknown product type: review');

function codeWorld(mode: 'observe' | 'apply' = 'apply') {
  const w = world(mode);
  w.odoo.seed(serviceSo(), serviceLine());
  w.odoo.pickings.clear();
  for (const p of [56937, 56938]) w.odoo.pickings.set(p, { id: p, state: 'assigned', location_dest_id: [p === 56937 ? 5 : 8, p === 56937 ? 'Partners/Customers' : 'WH/Output'] });
  w.carrier.set(codeShip());
  return w;
}
{
  const w = codeWorld();
  const d = await w.service.discover();
  const link = linkOf(w, 'VI00000748');
  eq(d.codeRegistered, 1, 'empty-ref waybill registered by code');
  eq([link.state, link.odooSaleOrderName, link.carrierRefNumber, link.matchMethod], ['stock-done', 'S26400', '', 'code-reference+service-only'],
    'service-only SO starts at stock-done (nothing to deliver)');
  w.carrier.patch(9300, { status: { code: 'DTR' }, collected: true, collectedAmount: 1076 });
  await w.service.syncStatuses(); await w.service.processActions();
  eq(linkOf(w, 'VI00000748').state, 'stock-done', 'no invoice before merchant settlement');
  w.carrier.patch(9300, { paidToCustomer: true, customerDue: 1000 });
  await w.service.syncStatuses(); await w.service.processActions();
  const done = linkOf(w, 'VI00000748');
  eq(done.state, 'paid', 'service-only WhatsApp sale: invoiced and paid');
  eq(w.odoo.writes.filter(x => x !== 'deliverStock'), ['createMerchantNetInvoice', 'registerPayment'], 'no stock write for the service SO');
  eq(w.odoo.invoices.get(done.odooInvoiceId!)!.amount_total, 1000, 'invoice at carrier net (customerDue)');
  eq((w.odoo.payments.get(done.odooPaymentId!)!.journal_id as [number, string])[0], 7, 'Cash journal 7');
  const before = w.odoo.writes.length;
  await w.service.discover(); await w.service.syncStatuses(); await w.service.processActions();
  eq(w.odoo.writes.length, before, 'no rediscovery or repeat after paid');
}
{
  const w = codeWorld();
  await w.service.discover();
  w.carrier.patch(9300, { status: { code: 'RTRN' } });
  await w.service.syncStatuses(); await w.service.processActions();
  eq(w.odoo.writes.includes('cancelSaleOrder'), false, 'service-only return waits for the grace period');
  clock += 25 * HOUR;
  await w.service.syncStatuses(); await w.service.processActions();
  eq(linkOf(w, 'VI00000748').state, 'returned', 'stable return: service SO closed');
  eq(w.odoo.writes.filter(x => x === 'cancelSaleOrder').length, 1, 'cancelled exactly once');
  eq(w.odoo.writes.includes('executeReturn'), false, 'no stock return for a service line');
  eq(w.odoo.sos.get(26400)!.state, 'cancel', 'SO cancelled');
  eq([...w.odoo.invoices.values()].filter(i => i.invoice_origin === 'S26400').length, 0, 'no invoice on a return');
}
{
  const w = codeWorld();
  w.odoo.sos.delete(26400);
  const d = await w.service.discover();
  eq([d.codeCandidates, d.codeRegistered], [1, 0], 'empty-ref waybill without an SO is only checked');
  eq(w.store.links.some(l => l.accurateShipmentCode === 'VI00000748'), false, 'no row, no review noise for Shopify hand-made waybills');
}
{
  const w = codeWorld();
  w.odoo.seed(serviceSo({ id: 26401, name: 'S26401' }), [{ ...serviceLine()[0]!, id: 602 }]);
  await w.service.discover();
  eq(linkOf(w, 'VI00000748').state, 'needs-review', 'two SOs carry the code: review');
  eq(linkOf(w, 'VI00000748').reviewReason, 'waybill-code-on-several-sale-orders', 'review reason');
}
{
  const w = codeWorld();
  w.store.shopifyCodes.add('VI00000748');
  await w.service.discover();
  eq(linkOf(w, 'VI00000748').reviewReason, 'waybill-owned-by-shopify-order', 'Shopify-owned code with an SO: review');
}
{
  const w = codeWorld();
  w.odoo.productTypes.set(99, 'product'); // goods line but no pickings
  await w.service.discover();
  eq(linkOf(w, 'VI00000748').reviewReason, 'sale-order-stock-lines-unsupported', 'goods SO without pickings: review');
}
{
  const w = codeWorld();
  await w.service.discover();
  w.carrier.patch(9300, { refNumber: 'S26400', status: { code: 'DTR' }, collected: true, paidToCustomer: true, collectedAmount: 1076, customerDue: 1000 });
  await w.service.syncStatuses();
  eq(linkOf(w, 'VI00000748').state, 'needs-review', 'carrier reference added later: identity change review');
  eq(w.odoo.writes, [], 'no write after identity change');
}
{
  const w = codeWorld();
  await w.service.discover();
  w.odoo.sos.get(26400)!.origin = false; w.odoo.sos.get(26400)!.client_order_ref = false;
  w.carrier.patch(9300, { status: { code: 'DTR' }, collected: true, paidToCustomer: true, collectedAmount: 1076, customerDue: 1000 });
  await w.service.syncStatuses(); await w.service.processActions();
  eq(linkOf(w, 'VI00000748').state, 'needs-review', 'SO reference removed after link: review');
  eq(w.odoo.writes, [], 'no invoice once the code reference is gone');
}
{
  const w = codeWorld('observe');
  await w.service.discover();
  w.carrier.patch(9300, { status: { code: 'DTR' }, collected: true, paidToCustomer: true, collectedAmount: 1076, customerDue: 1000 });
  await w.service.syncStatuses();
  eq(linkOf(w, 'VI00000748').plannedAction, 'settle', 'observe: settlement planned for the service SO');
  await w.service.processActions();
  eq(w.odoo.writes, [], 'observe: still zero Odoo writes');
}
{
  // An S-ref waybill on a service-only SO also skips the stock step.
  const w = world();
  w.odoo.seed(saleOrder({ picking_ids: [], order_line: [601], amount_total: 3065 }), [{ ...serviceLine()[0]!, price_unit: 3065 }]);
  w.carrier.patch(9001, settled);
  await w.service.discover(); await w.service.syncStatuses(); await w.service.processActions();
  eq(linkOf(w).state, 'paid', 'S-ref service-only SO paid');
  eq(w.odoo.writes, ['createMerchantNetInvoice', 'registerPayment'], 'S-ref service-only: no stock write');
}

// ------------------------- operation primitive + real Odoo transport hook
{
  const store = new MemoryStore();
  const link = (await store.createLink({ accurateShipmentId: 1, accurateShipmentCode: 'VI00000001', carrierRefNumber: 'S26320', state: 'linked' }))!;
  await rejects(withWhatsappOdooOperation({ store, epoch: () => undefined }, { linkId: link.id, key: 'k', expectedState: 'linked' }, async () => 1),
    'operation requires the safe-queue epoch', /epoch/);
  // Outside any operation the legacy behavior is unchanged (safe queues off).
  await safety.beforeAutomaticOdooWrite('sale.order', 'write');
  ok(true, 'legacy path unchanged outside a bridge scope');
  await rejects(safety.beforeAutomaticShopifyWrite().then(async () => {
    await withWhatsappOdooOperation({ store, epoch: () => 'synthetic-epoch-20261122' }, { linkId: link.id, key: 'shopify', expectedState: 'linked' },
      async () => { await safety.beforeAutomaticShopifyWrite(); });
  }), 'bridge never writes Shopify', /never writes to Shopify/);
  eq(store.ops.find(o => o.key === 'shopify')!.status, 'no-external-attempt', 'refused Shopify write is not an attempt');
  await rejects(withWhatsappOdooOperation({ store, epoch: () => 'synthetic-epoch-20261122' }, { linkId: link.id, key: 'nested', expectedState: 'linked' },
    async () => { await safety.withAutomaticOperation({ recordId: 1, lane: 'collection', key: 'x' }, async () => 1); }),
  'Shopify-record operation refused inside the bridge', /inside a WhatsApp bridge/);

  const { OdooClient } = await import('../odoo/odooClient.js');
  const client = new OdooClient();
  const observed: string[] = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    if (body.params.service === 'common') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 7 }));
    const op = store.ops.find(o => o.key === 'transport');
    observed.push(`${body.params.args[3]}.${body.params.args[4]}:${op?.status}`);
    return new Response('<html>gateway</html>', { status: 200 }); // unparseable: outcome unknown
  }) as unknown as typeof fetch;
  await rejects(withWhatsappOdooOperation({ store, epoch: () => 'synthetic-epoch-20261122' }, { linkId: link.id, key: 'transport', expectedState: 'linked' },
    async () => { await client.call('stock.picking', 'button_validate', [[1]]); await client.call('stock.picking', 'button_validate', [[2]]); }),
  'unknown transport outcome becomes a review', /OUTCOME_REVIEW|outcome/i);
  eq(observed, ['stock.picking.button_validate:started'], 'claim persisted as started BEFORE the request; no second write after halt');
  eq(store.ops.find(o => o.key === 'transport')!.status, 'needs-review', 'real transport unknown outcome: needs-review');
  globalThis.fetch = (async () => { throw new Error('network denied in synthetic suite'); }) as typeof fetch;
}

globalThis.fetch = realFetch;
console.log(`whatsapp-odoo-bridge: ${checks} checks passed`);
