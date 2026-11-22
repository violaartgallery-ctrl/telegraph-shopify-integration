/** Actual service/scheduler source, transpiled only inside strict synthetic VMs.
 * No dotenv, real clients, DB, network, production jobs, files or queues. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script, createContext } from 'node:vm';

for (const key of Object.keys(process.env)) delete process.env[key];
const require = createRequire(import.meta.url), ts = require('typescript');
const sourcePaths = ['odoo/odooSyncService', 'services/opsScheduler', 'services/safeQueuePolicy'];
const sources = new Map(sourcePaths.map(path => [path, readFileSync(new URL(`../${path}.ts`, import.meta.url), 'utf8')]));
let passed = 0, deniedImports = 0, deniedNetwork = 0;
const findings = [];
async function test(name, action) {
  try { await action(); passed++; }
  catch (error) { findings.push({ name, message: error.message.split('\n')[0] }); }
}
const clone = value => structuredClone(value);
const validEnv = {
  OPS_SAFE_QUEUES_ENABLED: 'true', OPS_SAFE_QUEUES_EPOCH: 'synthetic-financial-epoch-20261101',
  OPS_SAFE_QUEUES_PROOF: 'b'.repeat(64), SHOPIFY_SHOP_DOMAIN: 'violaleather.myshopify.com',
  ORDER_REFERENCE_PREFIX: 'Viola', SHIPMENT_CODE_PREFIX: 'VI', ODOO_SYNC_ENABLED: 'true',
  OPS_AUTOMATION_HOLD: 'true', PRODUCTION_PREVIEW_ONLY: 'true',
};
function vmLoader(settings = {}) {
  const env = { ...validEnv, ...settings };
  const context = createContext({
    process: { env }, console, Buffer,
    fetch() { deniedNetwork++; throw Error('Real network forbidden'); },
    WebSocket() { deniedNetwork++; throw Error('Real network forbidden'); },
    setTimeout() { throw Error('Unexpected timer in bounded integration test'); },
  }, { codeGeneration: { strings: false, wasm: false } });
  return { env, load(path, mocks, suffix = '') {
    assert.ok(sources.has(path));
    const compiled = ts.transpileModule(sources.get(path) + suffix, {
      fileName: `${path}.ts`, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    });
    assert.equal((compiled.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
    const module = { exports: {} };
    new Script(`(function(require,module,exports){${compiled.outputText}\n})`, { filename: `${path}.vm.cjs` })
      .runInContext(context)(id => {
        if (Object.hasOwn(mocks, id)) return mocks[id];
        // These legacy ordinary-order fixtures cannot grant the new recovery authority.
        if(id.endsWith('/cancellationRecoveryPolicy.js'))return{isOdooOnlyRecovery:()=>false,assertRecoveryNotExcluded(){}};
        if(id.endsWith('/cancellationRecoveryService.js'))return{recoveryCollectionPreflight:async()=>{throw Error('No cancelled recovery in ordinary fixture');}};
        if(id==='../accurate/accurateClient.js')return{AccurateClient:class{}};
        if(id.endsWith('/verifiedCarrierShipment.js'))return{loadExactCarrierShipment:async()=>{throw Error('No cancelled recovery carrier call in ordinary fixture');}};
        deniedImports++; throw Error(`Unexpected import ${id}`);
      }, module, module.exports);
    return module.exports;
  } };
}
class ReviewError extends Error { constructor(message) { super(message); this.name = 'AutomaticOperationReviewError'; } }
const order = { id: 900001, order_number: 900001, name: '#900001', line_items: [] };
const reference = '#900001 / Viola-900001';
const invoice = { id: 42, name: 'INV/SYNTHETIC', state: 'posted', move_type: 'out_invoice', amount_total: 100, amount_residual: 100, payment_state: 'not_paid' };
const payment = { id: 88, name: 'PAY/SYNTHETIC', amount: 100, journal_id: [7, 'Synthetic Cash'] };
function serviceFixture({ safe = true, invoices = [invoice], payments = [payment], sales = [], create, call, storedRecord } = {}) {
  const vm = vmLoader(), events = [], reads = [], writes = [], halts = [];
  let invoiceRead = 0;
  const client = {
    async searchRead(model, domain, fields, options) {
      reads.push({ model, domain: clone(domain), fields: clone(fields), options: clone(options) });
      events.push(`read:${model}`);
      if (model === 'sale.order') return clone(sales);
      if (model === 'account.move') return [clone(invoices[Math.min(invoiceRead++, invoices.length - 1)])].filter(Boolean);
      if (model === 'account.payment') return clone(payments);
      throw Error(`Unapproved synthetic Odoo read ${model}`);
    },
    async create(model, values, context) {
      writes.push({ model, method: 'create', values: clone(values), context: clone(context) }); events.push(`write:${model}:create`);
      return create ? await create(model, values, context) : 77;
    },
    async call(model, method, args, kwargs) {
      writes.push({ model, method, args: clone(args), kwargs: clone(kwargs) }); events.push(`write:${model}:${method}`);
      return call ? await call(model, method, args, kwargs) : { res_id: 88 };
    },
    async executeKw() { throw Error('Unexpected executeKw in scoped service case'); },
  };
  const deny = new Proxy({}, { get(_target, key) { throw Error(`Real dependency path forbidden: ${String(key)}`); } });
  const { OdooSyncService } = vm.load('odoo/odooSyncService', {
    '../config/env.js': { env: { orderReferencePrefix: 'Viola', odoo: { enabled: true } } },
    '../lib/logger.js': { logger: { info() {}, warn() {}, error() {} } },
    '../services/shipmentRepository.js': { shipmentRepository: storedRecord === undefined ? deny : new Proxy({}, { get(_target, key) {
      if (key === 'findByShopifyOrderId') return async id => { assert.equal(id, String(order.id)); events.push('read:primary'); return clone(storedRecord); };
      throw Error(`Unapproved primary repository call ${String(key)}`);
    } }) },
    '../shopify/shopifyAdminGraphql.js': { requestShopifyAdmin: deny },
    '../shopify/shopifyOrdersClient.js': { shopifyOrdersClient: deny },
    './odooSaleReturnService.js': { OdooSaleReturnService: class {} },
    './odooClient.js': { OdooClient: class {} },
    '../services/ownerFinancialApproval.js': {readOwnerFinancialApproval:async()=>null,assertOwnerFinancialOdooPreflight:async()=>{throw Error('Unexpected owner plan in legacy fixture');}},
    '../services/automaticOperationSafety.js': {
      automaticQueueSafetyActive: () => safe, AutomaticOperationReviewError: ReviewError,
      haltAutomaticOperation(reason) { halts.push(reason); },
    },
  });
  return { service: new OdooSyncService(client), events, reads, writes, halts };
}

const exactSale = { id: 31, name: 'S/SYNTHETIC', state: 'sale', client_order_ref: reference, origin: order.name };
await test('Exact active Sales Order is adopted, not recreated', async () => {
  const f = serviceFixture({ sales: [exactSale] });
  assert.equal((await f.service.findExistingSaleOrder(order)).id, 31);
  assert.equal(f.writes.length, 0);
  const read = f.reads[0];
  assert.equal(read.model, 'sale.order'); assert.equal(read.options.limit, 10);
  assert.equal(JSON.stringify(read.domain), JSON.stringify(['|', ['client_order_ref', '=', reference], ['origin', '=', order.name]]));
});
await test('No matching Sales Order returns undefined without creating', async () => {
  const f = serviceFixture(); assert.equal(await f.service.findExistingSaleOrder(order), undefined); assert.equal(f.writes.length, 0);
});
for (const [name, sales] of [
  ['foreign ref', [{ ...exactSale, client_order_ref: 'Loomlac-900001' }]],
  ['foreign origin', [{ ...exactSale, origin: '#other' }]],
  ['cancelled', [{ ...exactSale, state: 'cancel' }]],
  ['multiple exact', [exactSale, { ...exactSale, id: 32 }]],
  ['mixed exact/foreign', [exactSale, { ...exactSale, id: 32, origin: '#other' }]],
  ['saturated results', Array.from({ length: 10 }, (_, i) => ({ ...exactSale, id: i + 1 }))],
]) await test(`Sales Order ${name} requires review with no write`, async () => {
  const f = serviceFixture({ sales });
  await assert.rejects(f.service.findExistingSaleOrder(order), ReviewError); assert.equal(f.writes.length, 0);
});
for (const prepareStock of [true, false]) {
  await test(`Stored exact active Sales Order accepted, prepareStock=${prepareStock}`, async () => {
    const f = serviceFixture({ storedRecord: { odooSaleOrderId: 31, odooSaleOrderName: exactSale.name }, sales: [exactSale] });
    let prepared = 0;
    f.service.prepareSalesOrderStock = async id => { assert.equal(id, 31); prepared++; assert.equal(f.events.at(-1), 'read:sale.order'); };
    const result = await f.service.ensureSalesOrder(order, undefined, { prepareStock });
    assert.equal(result.id, 31); assert.equal(result.created, false); assert.equal(prepared, prepareStock ? 1 : 0);
    assert.equal(f.writes.length, 0);
    assert.equal(JSON.stringify(f.reads[0].domain), '[["id","=",31]]');
    for (const field of ['name', 'state', 'origin', 'client_order_ref']) assert.ok(f.reads[0].fields.includes(field));
  });
  for (const [name, sales] of [
    ['cancelled', [{ ...exactSale, state: 'cancel' }]], ['not confirmed', [{ ...exactSale, state: 'draft' }]],
    ['foreign origin', [{ ...exactSale, origin: '#other' }]], ['foreign ref', [{ ...exactSale, client_order_ref: 'foreign' }]],
    ['foreign name', [{ ...exactSale, name: 'S/OTHER' }]], ['missing', []],
    ['multiple', [exactSale, { ...exactSale, id: 32 }]], ['missing state', [{ ...exactSale, state: undefined }]],
  ]) await test(`Stored ${name} Sales Order blocked before preparation, prepareStock=${prepareStock}`, async () => {
    const f = serviceFixture({ storedRecord: { odooSaleOrderId: 31, odooSaleOrderName: exactSale.name }, sales }); let prepared = 0;
    f.service.prepareSalesOrderStock = async () => { prepared++; };
    await assert.rejects(f.service.ensureSalesOrder(order, undefined, { prepareStock }), ReviewError);
    assert.equal(prepared, 0); assert.equal(f.writes.length, 0);
    assert.deepEqual(f.events, ['read:primary', 'read:sale.order']);
  });
}

await test('Settled invoice reuses one exact existing payment with no wizard', async () => {
  const f = serviceFixture({ invoices: [{ ...invoice, amount_residual: 0, payment_state: 'paid' }] });
  assert.equal((await f.service.registerPayment(42, 100, 7, reference)).id, 88);
  assert.equal(f.writes.length, 0);
});
for (const [name, payments] of [
  ['missing', []], ['multiple', [payment, { ...payment, id: 89 }]],
  ['foreign journal', [{ ...payment, journal_id: [6, 'Other'] }]],
  ['foreign amount', [{ ...payment, amount: 101 }]],
]) await test(`Settled invoice ${name} payment must review, never create/adopt guessed identity`, async () => {
  const f = serviceFixture({ invoices: [{ ...invoice, amount_residual: 0, payment_state: 'paid' }], payments });
  await assert.rejects(f.service.registerPayment(42, 100, 7, reference), ReviewError); assert.equal(f.writes.length, 0);
});
await test('Outstanding invoice makes one wizard and one payment action, then exact verification', async () => {
  const f = serviceFixture();
  assert.equal((await f.service.registerPayment(42, 100, 7, reference)).id, 88);
  assert.equal(f.writes.length, 2);
  assert.equal(JSON.stringify(f.writes.map(w => `${w.model}:${w.method}`)), JSON.stringify(['account.payment.register:create', 'account.payment.register:action_create_payments']));
  assert.equal(f.writes[0].values.amount, 100); assert.equal(f.writes[0].values.journal_id, 7);
  assert.equal(f.writes[0].context.active_id, 42);
  assert.equal(f.events.at(-1), 'read:account.payment');
  assert.ok(f.reads.at(-1).fields.includes('amount') && f.reads.at(-1).fields.includes('journal_id'));
});
for (const amount of [99, 101]) await test(`Residual mismatch ${amount} blocks payment before wizard`, async () => {
  const f = serviceFixture(); await assert.rejects(f.service.registerPayment(42, amount, 7, reference), ReviewError); assert.equal(f.writes.length, 0);
});
await test('Residual changes during wizard preparation: never posts another payment', async () => {
  const f = serviceFixture({ invoices: [invoice, { ...invoice, amount_residual: 0, payment_state: 'paid' }] });
  await assert.rejects(f.service.registerPayment(42, 100, 7, reference), ReviewError);
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].method, 'create');
});
for (const [name, payments] of [
  ['missing', []], ['foreign journal', [{ ...payment, journal_id: [6, 'Other'] }]],
  ['foreign amount', [{ ...payment, amount: 101 }]], ['wrong returned ID', [{ ...payment, id: 89 }]],
  ['multiple exact', [payment, { ...payment, id: 89 }]],
]) await test(`Outstanding invoice ${name} verification is held without replay`, async () => {
  const f = serviceFixture({ payments, call: () => name === 'multiple exact' ? {} : { res_id: 88 } });
  await assert.rejects(f.service.registerPayment(42, 100, 7, reference), ReviewError);
  assert.equal(f.writes.length, 2); assert.deepEqual(f.halts, ['PAYMENT_IDENTITY_UNVERIFIED']);
});
await test('No returned action ID still requires exactly one matching related payment', async () => {
  const f = serviceFixture({ call: () => ({}) });
  assert.equal((await f.service.registerPayment(42, 100, 7, reference)).id, 88); assert.equal(f.writes.length, 2);
});

for (const safe of [true, false]) for (const phase of ['wizard create', 'invoice action']) await test(`Uncertain ${phase}, safe=${safe}: no fallback invoice creation`, async () => {
  const unknown = new Error('Odoo mutation outcome unknown; manual review required. Do not repeat before independent reconciliation.');
  Object.assign(unknown, { code: 'ODOO_WRITE_OUTCOME_UNKNOWN', manualReviewRequired: true, retryable: false });
  const f = serviceFixture({ safe, sales: [{ id: 31, name: 'S/SYNTHETIC', invoice_ids: [] }],
    create: () => { if (phase === 'wizard create') throw unknown; return 77; },
    call: () => { throw unknown; },
  });
  await assert.rejects(f.service.createSaleInvoiceFromWizard(31), error => error === unknown);
  assert.equal(f.reads.length, 0, 'Unknown outcome must not enter fallback reads/creation');
  assert.equal(f.writes.length, phase === 'wizard create' ? 1 : 2);
  assert.ok(f.writes.every(w => w.model === 'sale.advance.payment.inv'));
});

function schedulerFixture(settings = {}, failure) {
  const vm = vmLoader(settings), events = [], imported = [];
  const policy = vm.load('services/safeQueuePolicy', {});
  const stage = name => async () => { events.push(name); if (failure === name) throw Error('Synthetic stage failure'); return { ok: true }; };
  const sync = {
    syncOpenShipments: stage('status'), discoverCollectedShipmentsFromReports: stage('discover-collections'),
    discoverReturnedShipmentsResumable: stage('discover-returns'), processReturnQueue: stage('returns'),
    processShopifyPaymentQueue: stage('shopify'), processOdooCollectionQueue: stage('collections'),
  };
  const mocks = {
    'node:crypto': { randomUUID: () => 'synthetic-scheduler-token', timingSafeEqual: (a, b) => a.equals(b) },
    './automationSafety.js': { isDatabaseQuotaError: value => /quota/i.test(typeof value === 'string' ? value : JSON.stringify(value)) },
    './safeQueuePolicy.js': policy,
    '../app.js': { createAppServices() { imported.push('app'); return { shipmentStatusSyncService: sync,
      metaDeliveryService: { processPending: stage('meta') }, locationCatalogService: { refreshIfStale: stage('locations') } }; } },
    '../lib/prisma.js': { prisma: { failedPayload: { async findFirst() { events.push('recovery-db'); return null; } } } },
    './productionJobStore.js': { async listRecoverableJobs() { events.push('productionRecovery'); return [{ chatId: 101, job: { batchId: 'synthetic', updatedAt: 'synthetic' } }]; } },
    './productionContinuation.js': { async scheduleProductionContinuation() { events.push('fake-continuation'); } },
    '../netlify/functions/process-odoo-queue-background.js': { async handler() { events.push('odoo'); return { statusCode: 200, body: '{"ok":true}' }; } },
  };
  return { ...vm.load('services/opsScheduler', mocks, '\nexport {runLane as testOnlyRunLane};'), events, imported };
}
await test('Safe status lane skips Meta, production recovery, DB job reads and continuation', async () => {
  const f = schedulerFixture(); const result = await f.testOnlyRunLane('status');
  assert.deepEqual(f.events, ['status']); assert.equal(JSON.stringify(Object.keys(result)), '["status"]');
});
await test('Safe discovery lane only executes approved discovery stages', async () => {
  const f = schedulerFixture(); await f.testOnlyRunLane('discovery');
  assert.deepEqual(f.events, ['locations', 'discover-collections', 'discover-returns']);
});
await test('Safe financial lane contains only Odoo/return/Shopify/collection workers', async () => {
  const f = schedulerFixture(); await f.testOnlyRunLane('financial');
  assert.deepEqual(f.events, ['odoo', 'returns', 'shopify', 'collections']);
});
await test('Invalid safe policy blocks scheduler before app import or stage', async () => {
  const f = schedulerFixture({ OPS_SAFE_QUEUES_EPOCH: '' });
  await assert.rejects(f.testOnlyRunLane('status'), /held/); assert.deepEqual(f.events, []); assert.deepEqual(f.imported, []);
});
await test('Held normal policy cannot run status or recovery', async () => {
  const f = schedulerFixture({ OPS_SAFE_QUEUES_ENABLED: 'false' });
  await assert.rejects(f.testOnlyRunLane('status'), /held/); assert.deepEqual(f.events, []); assert.deepEqual(f.imported, []);
});
await test('Safe status failure is not silently reported as success or followed by recovery', async () => {
  const f = schedulerFixture({}, 'status');
  await assert.rejects(f.testOnlyRunLane('status'), /Ops lane stages failed: status/); assert.deepEqual(f.events, ['status']);
});
await test('Disabled safe capability preserves ordinary unheld status behavior in mocks', async () => {
  const f = schedulerFixture({ OPS_SAFE_QUEUES_ENABLED: 'false', OPS_AUTOMATION_HOLD: '', PRODUCTION_PREVIEW_ONLY: 'false' });
  await f.testOnlyRunLane('status');
  assert.deepEqual(f.events, ['meta', 'status', 'recovery-db', 'productionRecovery', 'fake-continuation']);
});

assert.equal(deniedImports, 0); assert.equal(deniedNetwork, 0);
console.log(JSON.stringify({ ok: findings.length === 0, checks: passed + findings.length, passed, findings, deniedImports, deniedNetwork,
  realNetworkCalls: 0, realDatabaseConnections: 0, realQueuePublications: 0, realPreviewRun: 0, realBusinessWrites: 0, filesWritten: 0 }));
if (findings.length) process.exitCode = 1;
