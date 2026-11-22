// Synthetic VM only: no real config, Prisma client, HTTP, carrier, or queue import.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as crypto from 'node:crypto';
import ts from 'typescript';

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };
const equal = (a, b, message) => { assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), message); checks++; };
const rejects = async (fn, expression = /./) => { await assert.rejects(fn, expression); checks++; };
class ValidationError extends Error { constructor(message, details) { super(message); this.details = details; } }
class UnauthorizedError extends Error {}
let now = 1_800_000_000_000;
class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
const env = { ORDER_REFERENCE_PREFIX: 'Viola', SHIPMENT_CODE_PREFIX: 'VI', SHOPIFY_SHOP_DOMAIN: 'violaleather.myshopify.com',
  PRODUCTION_MANUAL_RUN_ENABLED: 'true', PRODUCTION_MANUAL_RUN_EPOCH: 'synthetic-native-epoch',
  PRODUCTION_MANUAL_RUN_MIN_UPDATE_ID: '100', PRODUCTION_PREVIEW_ALLOWED_CHAT_IDS: '101,102',
  SHOPIFY_MANUAL_SHIPPING_ENABLED: 'true', SHOPIFY_MANUAL_SHIPPING_EPOCH: 'synthetic-admin-epoch',
  ADMIN_SECRET_TOKEN: 'synthetic-not-a-real-signing-secret' };
function load(relative, mocks) {
  const module = { exports: {} }, path = new URL('../' + relative + '.ts', import.meta.url);
  const compiled = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  vm.runInNewContext(compiled.outputText, { module, exports: module.exports, Buffer, Date: Clock, Error, console,
    process: { env }, fetch() { throw Error('REAL NETWORK FORBIDDEN'); }, require(name) {
      if (!Object.hasOwn(mocks, name)) throw Error('REAL IMPORT FORBIDDEN: ' + name);
      return mocks[name];
    } }, { filename: path.pathname });
  return module.exports;
}
const errors = { ValidationError, UnauthorizedError };
const binding = load('services/manualShipmentBinding', { 'node:crypto': crypto });
const pipeline = load('services/productionPipelineErrors', {});
let rows, record, carrier, current, snapshot, sequence, calls, control, serial = Promise.resolve();
function matches(row, where = {}) {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return value.some(w => matches(row, w));
    if (value && typeof value === 'object') {
      if ('in' in value) return value.in.includes(row[key]);
      if ('startsWith' in value) return typeof row[key] === 'string' && row[key].startsWith(value.startsWith);
      return false;
    }
    return row[key] === value;
  });
}
const table = {
  async findMany({ where } = {}) { return structuredClone(rows.filter(r => matches(r, where))); },
  async findUnique({ where }) { return structuredClone(rows.find(r => matches(r, where)) ?? null); },
  async create({ data }) { const row = { id: sequence++, externalId: null, ...data }; rows.push(row); calls.claimWrites++;
    if (control.failBoundaryCreate && row.source === 'shopify_existing_fulfillment_claim') throw Error('boundary response lost');
    return structuredClone(row); },
  async updateMany({ where, data }) {
    let count = 0;
    for (const row of rows) if (matches(row, where)) { Object.assign(row, data); count++; }
    if (count) calls.claimWrites++;
    if (count && control.refundDuringIntent && where.source === 'shopify_existing_fulfillment_claim' && JSON.parse(data.payloadJson ?? '{}').status === 'external-attempt') {
      snapshot.order.refunds.push({ id: g('Refund', 999) }); control.refundDuringIntent = false;
    }
    if (count && control.advanceCarrierCASMs && rows.some(r => matches(r, { id: where.id, source: 'manual_shipment_claim' })) &&
        JSON.parse(data.payloadJson ?? '{}').status === 'external-attempt') {
      now += control.advanceCarrierCASMs; control.advanceCarrierCASMs = 0;
    }
    if (control.ambiguousIntent && JSON.parse(data.payloadJson ?? '{}').status === 'external-attempt' && where.source === 'shopify_existing_fulfillment_claim') {
      control.ambiguousIntent = false; throw Error('intent CAS response lost after commit');
    }
    if (control.failCompletion && JSON.parse(data.payloadJson ?? '{}').status === 'completed' && where.source === 'shopify_existing_fulfillment_claim') {
      control.failCompletion = false; throw Error('completion response lost after commit');
    }
    return { count };
  },
  async update({ where, data }) { const row = rows.find(r => matches(r, where)); if (!row) throw Error('fake row missing'); Object.assign(row, data); calls.claimWrites++; return structuredClone(row); }
};
const db = { failedPayload: table, shipmentRecord: {
  async findUnique({ where }) { return record && matches(record, where) ? structuredClone(record) : null; },
  async updateMany({ where, data }) {
    if (data.lastError === null && control.replaceReviewBeforeClear) {
      record.lastError = 'OWNER_FINANCIAL_REVIEW_NEWER'; record.odooCollectionSyncStatus = 'needs-review'; control.replaceReviewBeforeClear = false;
    }
    if (!record || !matches(record, where)) return { count: 0 };
    Object.assign(record, data); calls.reviewWrites++;
    if (data.lastError === null && control.failClearResponse) { control.failClearResponse = false; throw Error('marker-clear metadata response lost'); }
    return { count: 1 };
  }
}, $transaction(fn) {
  const p = serial.then(async () => { const before = structuredClone(rows); try { return await fn({ ...db, $queryRawUnsafe: async (_sql, key) => { calls.locks.push(key); return []; } }); }
    catch (error) { rows = before; throw error; } });
  serial = p.catch(() => {}); return p;
} };
const native = load('services/manualShippingSafety', { 'node:crypto': crypto, '../lib/prisma.js': { prisma: db }, '../lib/errors.js': errors });
const policy = load('services/adminReadOnlyPolicy', {});
const admin = load('services/adminShippingSafety', { 'node:crypto': crypto, '../lib/prisma.js': { prisma: db },
  '../lib/errors.js': errors, './adminReadOnlyPolicy.js': policy, './manualShippingSafety.js': native, './manualShipmentBinding.js': binding });

const g = (kind, id) => `gid://shopify/${kind}/${id}`;
const orderFixture = () => ({ id: 900001, name: '#900001', order_number: 900001, cancelled_at: null, test: false,
  financial_status: 'pending', fulfillment_status: null, total_price: '100', current_total_price: '100', total_outstanding: '100',
  tags: 'confirmed', note: 'synthetic', payment_gateway_names: ['Cash on Delivery (COD)'],
  shipping_address: { address1: 'synthetic address', city: 'synthetic' },
  line_items: [{ id: 4001, title: 'synthetic', sku: 'SYNTH', quantity: 1, current_quantity: 1, price: '100',
    properties: [{ name: 'engraving', value: 'synthetic' }] }] });
const carrierFixture = () => ({ id: 700, code: 'VI9000001', refNumber: 'Viola-900001', cancelled: false, status: { code: 'BMT' }, returnStatus: null });
const missingSnapshot = () => ({ order: { id: g('Order', 900001), name: '#900001', cancelledAt: null, test: false,
  displayFinancialStatus: 'PENDING', displayFulfillmentStatus: 'UNFULFILLED', refunds: [], transactions: [], fulfillments: [],
  fulfillmentOrders: { pageInfo: { hasNextPage: false }, nodes: [{ id: g('FulfillmentOrder', 2001), status: 'OPEN', requestStatus: 'UNSUBMITTED',
    lineItems: { pageInfo: { hasNextPage: false }, nodes: [{ id: g('FulfillmentOrderLineItem', 5001),
      remainingQuantity: 1, totalQuantity: 1, lineItem: { id: g('LineItem', 4001) } }] } }] } } });
function fulfilled(url = null) {
  snapshot.order.displayFulfillmentStatus = 'FULFILLED'; current.fulfillment_status = 'fulfilled';
  snapshot.order.fulfillmentOrders.nodes.forEach(fo => { fo.status = 'CLOSED'; fo.lineItems.nodes.forEach(l => l.remainingQuantity = 0); });
  snapshot.order.fulfillments = [{ id: g('Fulfillment', 8001), status: 'SUCCESS', trackingInfo: [{ company: 'Telegraph', number: 'VI9000001', url }],
    fulfillmentLineItems: { pageInfo: { hasNextPage: false }, nodes: [{ quantity: 1, lineItem: { id: g('LineItem', 4001) } }] } }];
}
let holdMutation, enteredMutation;
const nativeEligibility = load('services/orderEligibility', {});
const fulfillmentClient = load('shopify/shopifyFulfillmentClient', { 'node:crypto': crypto, '../services/orderEligibility.js': nativeEligibility, './shopifyAdminGraphql.js': {
  async requestShopifyAdmin(query, variables) {
    if (query.includes('mutation')) {
      calls.shopifyWrites++; calls.variables.push(structuredClone(variables)); enteredMutation?.(); if (holdMutation) await holdMutation;
      if (control.mutationError) throw Error('ECONNRESET unknown Shopify outcome');
      if (control.nullResponse) return { fulfillmentCreate: { fulfillment: null, userErrors: [] } };
      fulfilled(control.createdUrl ?? null);
      if (control.readbackError) control.breakRead = true;
      return { fulfillmentCreate: { fulfillment: { id: g('Fulfillment', 8001), status: 'SUCCESS' }, userErrors: [] } };
    }
    calls.shopifyReads++;
    if (control.breakRead) throw Error('readback unavailable');
    if (control.onRead) await control.onRead(calls.shopifyReads);
    return structuredClone(snapshot);
  }
} });
const helper = load('services/existingShipmentFulfillment', { 'node:crypto': crypto, '../lib/prisma.js': { basePrisma: db },
  '../lib/errors.js': errors, './adminShippingSafety.js': admin, './manualShipmentBinding.js': binding,
  '../shopify/shopifyFulfillmentClient.js': fulfillmentClient });
const repo = {
  async findByShopifyOrderId() { return structuredClone(record); },
  async createPending(order) { calls.pending++; record ??= { id: 10, shopifyOrderId: String(order.id), shopifyOrderName: order.name,
    shopifyOrderNumber: String(order.order_number), rawOrderJson: JSON.stringify(order), lastError: null }; },
  async markCreated(id, s) { calls.receipts++; Object.assign(record, { accurateShipmentId: s.id, accurateShipmentCode: s.code, accurateStatus: s.status, lastError: null });
    if (control.expireAfterMark) now = control.deadline + 1; },
  async markFailed(_id, error) { calls.failed++; Object.assign(record, { accurateStatus: 'FAILED', lastError: error }); },
  async markOdooSoPending() { calls.odoo++; },
  async clearDeletedShipment() { throw Error('CARRIER RECREATION FORBIDDEN'); }
};
const logger = { info() {}, warn() {}, error() {} };
const processorModule = load('services/shopifyOrderProcessor', { '../accurate/accurateClient.js': {}, './accurateMapper.js': {},
  './failedPayloadService.js': { failedPayloadService: { async save(p) { return table.create({ data: { source: p.source, reason: p.reason, externalId: p.externalId, payloadJson: JSON.stringify(p.payload) } }); } } },
  '../lib/logger.js': { logger }, './shipmentRepository.js': { shipmentRepository: repo }, './orderEligibility.js': nativeEligibility,
  '../shopify/shopifyFulfillmentClient.js': fulfillmentClient, './shipmentCodeService.js': { shipmentCodeService: { async reserveForOrder() { calls.reserve++; return 'VI9000001'; } } },
  '../lib/errors.js': errors, './manualShippingSafety.js': native, './adminShippingSafety.js': admin, './manualShipmentBinding.js': binding,
  './productionPipelineErrors.js': pipeline, './existingShipmentFulfillment.js': helper });
const processor = new processorModule.ShopifyOrderProcessor({
  async getShipment() { return structuredClone(carrier); }, async listShipments() { return { data: carrier ? [structuredClone(carrier)] : [] }; },
  async saveShipment() { calls.carrierWrites++; if (control.carrierError) throw Error('ECONNRESET unknown carrier outcome'); carrier = carrierFixture(); return structuredClone(carrier); }
}, { async mapOrderToShipment() { if (control.expireDuringMapping) now = control.deadline - 1; return { code: 'VI9000001', refNumber: 'Viola-900001' }; } });
const auth = () => ({ chatId: 101, batchId: 'synthetic-current-human-batch', epoch: env.PRODUCTION_MANUAL_RUN_EPOCH, updateId: 101 });
function reset(linked = true) {
  rows = []; sequence = 1; now = 1_800_000_000_000; current = orderFixture(); carrier = linked ? carrierFixture() : null; snapshot = missingSnapshot();
  record = linked ? { id: 10, shopifyOrderId: String(current.id), shopifyOrderName: current.name, shopifyOrderNumber: String(current.order_number),
    accurateShipmentId: 700, accurateShipmentCode: 'VI9000001', accurateStatus: 'BMT', rawOrderJson: JSON.stringify(current), lastError: null, odooSyncStatus: null } : null;
  calls = { claimWrites: 0, reviewWrites: 0, shopifyWrites: 0, shopifyReads: 0, carrierWrites: 0, pending: 0, reserve: 0, receipts: 0, failed: 0, odoo: 0, locks: [], variables: [] };
  control = {}; holdMutation = null; enteredMutation = null; delete env.PRODUCTION_PREVIEW_ONLY;
}
function context(extra = {}) {
  const saved = binding.bindManualShipment(current), deadline = typeof extra.operationDeadline === 'number' ? extra.operationDeadline : now + 300_000;
  control.deadline = deadline;
  return { manualRunAuthorization: auth(), operationDeadline: deadline,
    assertOperationAllowed: async () => { if (control.cancelled) throw Error('native lease cancelled'); if (now >= deadline) throw new pipeline.SoftDeadlineError('native deadline'); },
    assertSourceUnchanged: async () => { binding.assertManualShipmentUnchanged(saved, current); }, ...extra };
}
function carrierClaim(status = 'completed') {
  const row = { id: sequence++, source: 'manual_shipment_claim', reason: '900001', externalId: 'old-human-batch',
    payloadJson: JSON.stringify({ version: 1, orderId: '900001', authorization: auth(), token: 'original-carrier-token', status,
      requestAttempted: status !== 'no-external-attempt', shipmentId: 700, shipmentCode: 'VI9000001', at: new Clock().toISOString(), completedAt: new Clock().toISOString() }) };
  rows.push(row); return row;
}
const noBusinessReplay = () => { ok(calls.carrierWrites === 0 && calls.odoo === 0 && calls.reserve === 0 && calls.pending === 0, 'Repair has no carrier/accounting/sequence write'); };

// Verified waybill + missing fulfillment: only explicit native human approval.
reset(); carrierClaim(); const original = rows[0].payloadJson;
await processor.process(structuredClone(current)); ok(calls.shopifyWrites === 0 && calls.claimWrites === 0, 'Contextless duplicate read is inert'); noBusinessReplay();
const result = await processor.process(structuredClone(current), context());
ok(result.skipped && !result.fulfillment.skipped && calls.shopifyWrites === 1, 'Verified duplicate repairs Shopify exactly once'); noBusinessReplay();
ok(result.reason === 'existing-shipment-fulfillment-repaired', 'Fulfillment-only repair is observable without claiming a new shipment');
ok(rows[0].payloadJson === original, 'Original carrier claim byte-identical');
ok(rows.some(r => r.source === helper.EXISTING_FULFILLMENT_CLAIM_SOURCE && r.reason === '900001' && r.externalId === 'VI9000001' && JSON.parse(r.payloadJson).status === 'completed'), 'Separate durable completion tuple');
ok(calls.locks.includes('manual-shipment:900001') && calls.locks.includes('automatic-order:900001'), 'Native order advisory identities shared');
await processor.process(structuredClone(current), context()); ok(calls.shopifyWrites === 1, 'Repeated native approval cannot write twice');

// Four current incident pattern: old carrier needs-review + completed owner
// repair, number/company only, exact lines. They remain READ-ONLY and immutable.
for (let i = 0; i < 4; i++) {
  reset(); carrierClaim('needs-review'); fulfilled();
  record.lastError = 'historical softdeadline after markCreated';
  rows.push({ id: sequence++, source: 'owner_existing_fulfillment_repair', reason: '900001', externalId: 'VI9000001',
    payloadJson: JSON.stringify({ version: 1, status: 'completed', requestAttempted: true, ownerApproved: true }) });
  const before = JSON.stringify(rows); const ownerNoop = await processor.process(structuredClone(current), context());
  ok(calls.shopifyWrites === 0 && JSON.stringify(rows) === before, 'Completed owner pattern remains untouched ' + i); noBusinessReplay();
  ok(ownerNoop.reason === 'duplicate-order' && ownerNoop.skipped, 'Already exact owner repair is still a no-op');
  ok(record.lastError === 'historical softdeadline after markCreated', 'Completed owner observation does not erase original diagnostic');
}
reset(); carrierClaim(); fulfilled('https://system.telegraphex.com/admin/shipments/700');
await processor.process(structuredClone(current), context()); ok(calls.shopifyWrites === 0, 'Exact dashboard URL accepted'); noBusinessReplay();

// Native admin authority is reused; there is NO new env, route, or token flow.
reset(); carrierClaim(); const p = admin.verifyAdminShipmentConfirmation(admin.mintAdminShipmentConfirmation(current), '900001');
const adminContext = context({ manualRunAuthorization: undefined, adminShipmentAuthorization: p, operationDeadline: undefined });
await processor.process(structuredClone(current), adminContext); ok(calls.shopifyWrites === 1, 'Existing signed admin approval can reconcile without inventing a deadline'); noBusinessReplay();
reset(); carrierClaim(); await rejects(() => processor.process(structuredClone(current), context({ manualRunAuthorization: { ...auth(), epoch: 'old' } })), /stale|invalid/); noBusinessReplay();
reset(); carrierClaim(); await rejects(() => processor.process(structuredClone(current), { manualRunAuthorization: auth() }), /fences/); ok(calls.shopifyWrites === 0, 'No missing-fence bypass');
reset(); carrierClaim(); const cancelledAdmin = admin.verifyAdminShipmentConfirmation(admin.mintAdminShipmentConfirmation(current), '900001');
control.cancelled = true;
await rejects(() => processor.process(structuredClone(current), context({ manualRunAuthorization: undefined,
  adminShipmentAuthorization: cancelledAdmin, operationDeadline: undefined })), /lease cancelled/);
ok(calls.shopifyWrites === 0, 'Admin without a deadline retains its full operation fence');

// Source edits, incomplete/partial plans, wrong tracking/source and locations.
for (const mutate of [o => o.line_items[0].current_quantity = 2, o => o.line_items[0].properties[0].value = 'changed',
  o => o.total_price = '200', o => o.shipping_address.address1 = 'changed', o => o.cancelled_at = new Clock().toISOString()]) {
  reset(); carrierClaim(); const c = context(); mutate(current); await rejects(() => processor.process(orderFixture(), c), /source changed/); ok(calls.shopifyWrites === 0, 'Changed current source never repaired');
}
const planner = fulfillmentClient.planExistingShipmentFulfillment;
for (const mutate of [s => s.order.id = g('Order', 999), s => s.order.name = '#wrong',
  s => s.order.fulfillmentOrders.pageInfo.hasNextPage = true,
  s => s.order.fulfillmentOrders.nodes[0].lineItems.pageInfo.hasNextPage = true,
  s => s.order.fulfillmentOrders.nodes[0].lineItems.nodes[0].remainingQuantity = 0,
  s => s.order.fulfillmentOrders.nodes[0].requestStatus = 'SUBMITTED',
  s => s.order.fulfillmentOrders.nodes[0].status = 'ON_HOLD',
  s => s.order.displayFulfillmentStatus = 'PARTIALLY_FULFILLED']) {
  reset(); mutate(snapshot); assert.throws(() => planner(current, carrier, snapshot), /incomplete|partial|conflicting/); checks++;
}
reset(); current.line_items.push({ ...structuredClone(current.line_items[0]), id: 4002 });
const second = structuredClone(snapshot.order.fulfillmentOrders.nodes[0]); second.id = g('FulfillmentOrder', 2002);
second.lineItems.nodes[0].id = g('FulfillmentOrderLineItem', 5002); second.lineItems.nodes[0].lineItem.id = g('LineItem', 4002); snapshot.order.fulfillmentOrders.nodes.push(second);
assert.throws(() => planner(current, carrier, snapshot), /incomplete|partial|conflicting/); checks++;
snapshot.order.fulfillmentOrders.nodes.forEach(fo => { fo.assignedLocation = { address: { address1: 'same synthetic address' } }; });
assert.throws(() => planner(current, carrier, snapshot), /incomplete|partial|conflicting/); checks++;
// Already-present full coverage is location-independent, even with several
// fully closed fulfillment orders whose remaining quantities are all zero.
snapshot.order.fulfillmentOrders.nodes.forEach(fo => { delete fo.assignedLocation; fo.status = 'CLOSED'; fo.lineItems.nodes.forEach(l => l.remainingQuantity = 0); });
snapshot.order.displayFulfillmentStatus = 'FULFILLED';
snapshot.order.fulfillments = [{ id: g('Fulfillment', 8001), status: 'SUCCESS', trackingInfo: [{ company: 'Telegraph', number: carrier.code, url: null }],
  fulfillmentLineItems: { pageInfo: { hasNextPage: false }, nodes: current.line_items.map(l => ({ quantity: l.current_quantity, lineItem: { id: g('LineItem', l.id) } })) } }];
ok(planner(current, carrier, snapshot).state === 'present', 'Exact present fulfillment accepts fully closed multi-FO coverage without location access');
for (const mutate of [s => s.order.fulfillments[0].trackingInfo[0].number = 'VIwrong',
  s => s.order.fulfillments[0].trackingInfo[0].company = 'Other', s => s.order.fulfillments[0].trackingInfo[0].url = 'https://invalid.test/wrong',
  s => s.order.fulfillments[0].fulfillmentLineItems.nodes[0].quantity = 2,
  s => s.order.fulfillments[0].status = 'FAILURE']) {
  reset(); carrierClaim(); fulfilled(); mutate(snapshot); await rejects(() => processor.process(structuredClone(current), context()), /incomplete|partial|conflicting/); ok(calls.shopifyWrites === 0, 'Conflicting existing fulfillment never rewritten');
}

// Fresh source financial state PLUS explicit fresh refunds/transactions reads.
for (const status of ['refunded', 'partially_refunded', 'voided', 'unknown']) {
  reset(); carrierClaim(); current.financial_status = status; record.rawOrderJson = JSON.stringify(current); snapshot.order.displayFinancialStatus = status.toUpperCase();
  await rejects(() => processor.process(structuredClone(current), context()), /incomplete|partial|conflicting/); ok(calls.shopifyWrites === 0, 'Unsafe financial status held ' + status);
}
for (const status of ['authorized', 'partially_paid']) {
  reset(); carrierClaim(); current.financial_status = status; current.payment_gateway_names = ['synthetic-card'];
  snapshot.order.displayFinancialStatus = status.toUpperCase(); record.rawOrderJson = JSON.stringify(current); fulfilled();
  const present = await processor.process(structuredClone(current), context());
  ok(present.reason === 'duplicate-order' && calls.shopifyWrites === 0, 'Native ' + status + ' accepted for strict PRESENT proof'); noBusinessReplay();
  reset(false); current.financial_status = status; current.payment_gateway_names = ['synthetic-card']; snapshot.order.displayFinancialStatus = status.toUpperCase();
  ok(nativeEligibility.isOrderEligibleForShipment(current), 'Unchanged native policy explicitly permits ' + status);
  await processor.process(structuredClone(current), context());
  ok(calls.carrierWrites === 1 && calls.shopifyWrites === 1 && calls.odoo === 1, 'Native new-shipment readback preserves ' + status + ' feature parity');
  ok(current.financial_status === status && rows.filter(r => r.source === helper.EXISTING_FULFILLMENT_CLAIM_SOURCE).every(r => JSON.parse(r.payloadJson).status === 'completed'), 'Readback does not alter native financial state ' + status);
}
reset(); carrierClaim(); current.payment_gateway_names = []; delete current.gateway; record.rawOrderJson = JSON.stringify(current);
await rejects(() => processor.process(structuredClone(current), context()), /incomplete|partial|conflicting/);
ok(calls.shopifyWrites === 0, 'Linked PENDING with unknown gateway is not broadened beyond native policy'); noBusinessReplay();
reset(false); current.payment_gateway_names = []; delete current.gateway;
const unknownPending = await processor.process(structuredClone(current), context());
ok(unknownPending.skipped && unknownPending.reason === 'order-not-eligible' && calls.carrierWrites === 0 && calls.shopifyWrites === 0 && calls.odoo === 0, 'Normal PENDING unknown gateway remains natively ineligible');
reset(); carrierClaim(); current.payment_gateway_names = []; current.gateway = 'cash_on_delivery'; record.rawOrderJson = JSON.stringify(current);
await processor.process(structuredClone(current), context());
ok(calls.shopifyWrites === 1 && calls.odoo === 0, 'Native explicit cash_on_delivery gateway remains eligible for PENDING repair');
for (const mutate of [s => s.order.refunds.push({ id: g('Refund', 1) }),
  s => s.order.transactions.push({ id: g('OrderTransaction', 1), kind: 'REFUND', status: 'PENDING' }),
  s => s.order.transactions.push({ id: g('OrderTransaction', 1), kind: 'VOID', status: 'SUCCESS' }),
  s => s.order.refunds = undefined, s => s.order.transactions = undefined,
  s => s.order.test = true, s => s.order.cancelledAt = new Clock().toISOString()]) {
  reset(); carrierClaim(); mutate(snapshot); await rejects(() => processor.process(structuredClone(current), context()), /incomplete|partial|conflicting/); ok(calls.shopifyWrites === 0, 'Fresh refund/transaction/cancellation evidence fail-closed');
}
reset(); carrierClaim(); control.onRead = async n => { if (n === 2) snapshot.order.refunds.push({ id: g('Refund', 1) }); };
await rejects(() => processor.process(structuredClone(current), context()), /incomplete|partial|conflicting/); ok(calls.shopifyWrites === 0, 'Refund appearing during preparation fences send');
reset(); carrierClaim(); control.refundDuringIntent = true;
await rejects(() => processor.process(structuredClone(current), context()), /review|retry/);
ok(calls.shopifyWrites === 0, 'Refund injected DURING intent CAS is read AFTER fences and prevents mutation');
ok(JSON.parse(rows.find(r => r.source === helper.EXISTING_FULFILLMENT_CLAIM_SOURCE).payloadJson).requestAttempted === true, 'Conservative started intent remains held after post-intent refund stop');
for (const change of ['lease-loss', 'source-drift']) {
  reset(); carrierClaim();
  control.onRead = async n => {
    // Read 1 prepares, read 2 refreshes before intent, read 3 is the post-CAS
    // atSend snapshot. Invalidate authority while THAT read is in flight.
    if (n === 3) {
      if (change === 'lease-loss') control.cancelled = true;
      else current.line_items[0].properties[0].value = 'changed-during-atSend';
    }
  };
  await rejects(() => processor.process(structuredClone(current), context()), /review|retry/);
  ok(calls.shopifyReads === 3 && calls.shopifyWrites === 0, 'Final post-atSend fence stops mutation after ' + change);
  const intent = JSON.parse(rows.find(r => r.source === helper.EXISTING_FULFILLMENT_CLAIM_SOURCE).payloadJson);
  ok(intent.requestAttempted === true && intent.status === 'needs-review', 'Post-CAS authority loss retains conservative durable intent ' + change);
}

// Unknown attempted fulfillment (runtime, owner, or legacy) never becomes retry.
for (const source of ['shopify_existing_fulfillment_claim', 'owner_existing_fulfillment_repair']) {
  for (const status of ['external-attempt', 'needs-review', 'uncertain', 'claimed']) {
    reset(); carrierClaim(); rows.push({ id: sequence++, source, reason: '900001', externalId: 'VI9000001', payloadJson: JSON.stringify({ version: 1, status, requestAttempted: true }) });
    await rejects(() => processor.process(structuredClone(current), context()), /not retryable/); ok(calls.shopifyWrites === 0, 'Unknown attempt held ' + source + '/' + status);
  }
}
reset(); carrierClaim(); rows.push({ id: sequence++, source: 'shopify-fulfillment-create', reason: 'old unknown failure', externalId: '900001', payloadJson: '{}' });
await rejects(() => processor.process(structuredClone(current), context()), /failed|unknown/); ok(calls.shopifyWrites === 0, 'Legacy uncertain fulfillment failure is held');
for (const diagnostic of [{ requestAttempted: false }, { requestAttempted: false, orderId: 900001, shipmentId: 700, shipmentCode: 'VI9000001' },
  { requestAttempted: false, orderId: 900001, shipmentId: 700, shipmentCode: 'VI9000001', boundaryClaimId: 999, boundaryProofHash: 'a'.repeat(64) }]) {
  reset(); carrierClaim(); rows.push({ id: sequence++, source: 'shopify-fulfillment-create', reason: 'unproven no-attempt', externalId: '900001', payloadJson: JSON.stringify(diagnostic) });
  await rejects(() => processor.process(structuredClone(current), context()), /failed|unknown/);
  ok(calls.shopifyWrites === 0, 'Bare false/exact tuple without durable boundary proof stays held');
}
reset(); carrierClaim('needs-review'); await rejects(() => processor.process(structuredClone(current), context()), /without exact/); ok(calls.shopifyWrites === 0, 'Unproven old carrier uncertainty is not erased');
reset(); carrierClaim(); rows.push({ id: sequence++, source: 'shopify_existing_fulfillment_claim', reason: '900001', externalId: 'VIwrong', payloadJson: '{' });
await rejects(() => processor.process(structuredClone(current), context()), /different carrier/); ok(calls.shopifyWrites === 0, 'Dedup does not filter by carrier code');
reset(); carrierClaim(); rows.push({ id: sequence++, source: 'ops_record_hold', externalId: '900001', reason: 'owner', payloadJson: '{' });
await rejects(() => processor.process(structuredClone(current), context()), /hold/); noBusinessReplay();
reset(); carrierClaim(); rows.push({ id: sequence++, source: 'automatic_operation_claim', externalId: '900001', reason: 'production:old',
  payloadJson: JSON.stringify({ version: 1, status: 'completed', requestAttempted: true }) });
await rejects(() => processor.process(structuredClone(current), context()), /uncertain native/); ok(calls.shopifyWrites === 0, 'Malformed completed native claim stays held');
reset(); carrierClaim(); carrier.refNumber = 'Viola-OTHER'; await rejects(() => processor.process(structuredClone(current), context()), /NEVER recreate/); noBusinessReplay();
reset(); carrierClaim(); carrier.returnStatus = { code: 'RTRN' }; await rejects(() => processor.process(structuredClone(current), context()), /return\/status/); noBusinessReplay();
for (const cancelled of [true, undefined]) {
  reset(); carrierClaim(); carrier.cancelled = cancelled;
  await rejects(() => processor.process(structuredClone(current), context()), /return\/status/);
  ok(calls.shopifyWrites === 0, 'Carrier cancelled must be explicitly false, not true or unread'); noBusinessReplay();
}
reset(); carrierClaim(); current.financial_status = 'paid'; record.rawOrderJson = JSON.stringify(current); snapshot.order.displayFinancialStatus = 'PAID';
await processor.process(structuredClone(current), context()); ok(calls.shopifyWrites === 1 && calls.odoo === 0, 'Exact paid non-refunded order can reconcile without financial writes');

// Durable concurrency: distinct human operators, same order and claim slot.
reset(); carrierClaim(); let release, entered; holdMutation = new Promise(r => release = r); const started = new Promise(r => entered = r); enteredMutation = entered;
const one = processor.process(structuredClone(current), context()); await started;
await rejects(() => processor.process(structuredClone(current), context({ manualRunAuthorization: { ...auth(), chatId: 102, batchId: 'other-current-batch' } })), /not retryable/);
release(); await one; ok(calls.shopifyWrites === 1, 'Concurrent operators issue one fulfillment only'); noBusinessReplay();

// Unknown write / ambiguous intent CAS / post-write readback: no retry slot.
for (const flag of ['mutationError', 'ambiguousIntent', 'readbackError', 'nullResponse']) {
  reset(); carrierClaim(); control[flag] = true;
  await rejects(() => processor.process(structuredClone(current), context()), /review|retry/);
  const writes = calls.shopifyWrites; control.breakRead = false; control[flag] = false;
  await rejects(() => processor.process(structuredClone(current), context()), /not retryable/);
  ok(calls.shopifyWrites === writes && writes <= 1, 'Unknown outcome never replayed ' + flag);
  const p = JSON.parse(rows.find(r => r.source === helper.EXISTING_FULFILLMENT_CLAIM_SOURCE).payloadJson);
  ok(p.requestAttempted === true && ['external-attempt', 'needs-review'].includes(p.status), 'Unknown intent never relabelled no-attempt ' + flag);
}

// Reserve BEFORE native carrier claim/createPending/reservation/provider call.
reset(false); const c = context({ operationDeadline: now + processorModule.MIN_CARRIER_COMPLETION_BUDGET_MS - 1 });
await rejects(() => processor.process(structuredClone(current), c), /defer this whole order/);
ok(rows.length === 0 && calls.carrierWrites === 0 && calls.pending === 0 && calls.reserve === 0, 'Low budget defers whole order before any carrier work');
reset(false); const mappingContext = context(); control.expireDuringMapping = true;
await rejects(() => processor.process(structuredClone(current), mappingContext), /defer this whole order/);
ok(calls.carrierWrites === 0 && rows.filter(r => r.source === 'manual_shipment_claim').every(r => JSON.parse(r.payloadJson).requestAttempted === false), 'Mapping delay rechecks budget before carrier intent');
reset(false); const casContext = context({ operationDeadline: now + 235_000 }); control.advanceCarrierCASMs = 120_000;
await processor.process(structuredClone(current), casContext);
ok(calls.carrierWrites === 1 && calls.shopifyWrites === 1, '235s admission survives CAS time advance below 120s reserve without stranding attempted carrier claim');
ok(rows.filter(r => r.source === 'manual_shipment_claim').every(r => JSON.parse(r.payloadJson).status === 'completed'), 'Post-intent checks retain hard deadline/lease, not a second reserve threshold');

// Original incident boundary reproduced: carrier recorded, then deadline dies.
reset(false); const initial = context(); control.expireAfterMark = true;
await rejects(() => processor.process(structuredClone(current), initial), /manual review/);
ok(record.accurateShipmentId === 700 && record.accurateShipmentCode === 'VI9000001' && calls.failed === 0, 'Carrier identity/status preserved after boundary stop');
ok(record.lastError === helper.FULFILLMENT_REVIEW_REASON && calls.shopifyWrites === 0 && calls.odoo === 0, 'Missing fulfillment is review, never false success/accounting queue');
const oldCarrier = rows.find(r => r.source === 'manual_shipment_claim').payloadJson;
const boundary = rows.find(r => r.source === helper.EXISTING_FULFILLMENT_CLAIM_SOURCE);
ok(JSON.parse(boundary.payloadJson).status === 'no-external-attempt' && JSON.parse(boundary.payloadJson).requestAttempted === false, 'Exact no-fulfillment-attempt boundary durable before deadline fence');
const link = await helper.existingFulfillmentBoundaryLink(boundary.id, '900001', carrierFixture());
rows.push({ id: sequence++, source: 'shopify-fulfillment-create', externalId: '900001', reason: 'proven no-attempt fence failure',
  payloadJson: JSON.stringify({ orderId: 900001, shipmentId: 700, shipmentCode: 'VI9000001', requestAttempted: false, ...link }) });
record.odooSyncStatus = 'odoo-stock-pending'; record.odooSaleOrderId = 44; record.odooInvoiceId = 55;
const expectedAfterRepair = { ...structuredClone(record), lastError: null };
control.expireAfterMark = false;
await processor.process(structuredClone(current), context({ manualRunAuthorization: { ...auth(), updateId: 102, batchId: 'new-human-run' } }));
ok(calls.carrierWrites === 1 && calls.shopifyWrites === 1 && calls.odoo === 0, 'Fresh explicit HumanRun repairs ONLY same-waybill fulfillment after boundary');
ok(JSON.parse(rows.find(r => r.id === boundary.id).payloadJson).boundaryProofHash === link.boundaryProofHash, 'Immutable boundary proof survives claim CAS and validates exact no-attempt diagnostic');
equal(record, expectedAfterRepair, 'Successful new repair clears ONLY own exact marker; all identity/status/financial fields unchanged');
ok(rows.find(r => r.source === 'manual_shipment_claim').payloadJson === oldCarrier, 'Needs-review original carrier claim never reopened or changed');

reset(); carrierClaim(); record.lastError = helper.FULFILLMENT_REVIEW_REASON; control.replaceReviewBeforeClear = true;
await processor.process(structuredClone(current), context());
ok(record.lastError === 'OWNER_FINANCIAL_REVIEW_NEWER' && record.odooCollectionSyncStatus === 'needs-review', 'Exact marker CAS preserves a newer owner/financial diagnostic and status');
ok(calls.shopifyWrites === 1 && calls.odoo === 0, 'Marker cleanup does not requeue accounting or repeat fulfillment');
reset(); carrierClaim(); record.lastError = 'arbitrary financial source conflict';
await rejects(() => processor.process(structuredClone(current), context()), /held/);
ok(record.lastError === 'arbitrary financial source conflict' && calls.shopifyWrites === 0, 'Arbitrary pre-existing financial error is never cleared');
reset(); carrierClaim(); record.lastError = helper.FULFILLMENT_REVIEW_REASON; control.failClearResponse = true;
await rejects(() => processor.process(structuredClone(current), context()), /marker-clear/);
ok(JSON.parse(rows.find(r => r.source === helper.EXISTING_FULFILLMENT_CLAIM_SOURCE).payloadJson).status === 'completed', 'Ambiguous marker-only cleanup never downgrades completed provider claim');
await processor.process(structuredClone(current), context());
ok(calls.shopifyWrites === 1 && calls.odoo === 0, 'Completed provider operation remains no-write after metadata cleanup uncertainty');

// Ordinary new order succeeds only after exact fulfillment readback.
reset(false); await processor.process(structuredClone(current), context());
ok(calls.carrierWrites === 1 && calls.shopifyWrites === 1 && calls.odoo === 1, 'Normal first shipping preserves existing accounting-intent behavior');
ok(rows.filter(r => r.source === helper.EXISTING_FULFILLMENT_CLAIM_SOURCE).every(r => JSON.parse(r.payloadJson).status === 'completed'), 'Initial Shopify attempt also has durable completion');
reset(false); control.nullResponse = true; await rejects(() => processor.process(structuredClone(current), context()), /manual review/);
ok(calls.carrierWrites === 1 && calls.odoo === 0 && record.lastError === helper.FULFILLMENT_REVIEW_REASON, 'Null fulfillment success is not falsely reported or queued');

// Only deadline plumbing is permitted in Telegram shipping caller.
const caller = readFileSync(new URL('../services/productionShippingService.ts', import.meta.url), 'utf8');
ok(caller.includes('operationDeadline: deadline,'), 'Native Telegram deadline is explicitly propagated');
ok(caller.includes("result.reason === 'existing-shipment-fulfillment-repaired'") && caller.includes('بدون شحنة جديدة'), 'Native progress distinguishes repaired Shopify from duplicate/noop without cursor rebase');
const fulfillmentSource = readFileSync(new URL('../shopify/shopifyFulfillmentClient.ts', import.meta.url), 'utf8');
ok(!fulfillmentSource.includes('assignedLocation'), 'Strict query and validation do not require location-read scopes');
console.log(JSON.stringify({ ok: true, checks, realDatabaseConnections: 0, realNetworkCalls: 0, realPreviewRun: 0,
  carrierMutations: 0, accountingWrites: 0, newEnvironmentFlags: 0, newRoutes: 0 }));
