/** Actual return-status source in an in-memory VM. No dotenv, real provider,
 * DB, queue or production entrypoint imports; only this test file is authored. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script, createContext } from 'node:vm';
for (const key of Object.keys(process.env)) delete process.env[key];
const require = createRequire(import.meta.url), ts = require('typescript');
const source = readFileSync(new URL('../services/shipmentStatusSyncService.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { fileName: 'shipmentStatusSyncService.ts', reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
assert.equal((compiled.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
let passed = 0, deniedImports = 0, deniedNetwork = 0;
const findings = [];
async function test(name, action) {
  try { await action(); passed++; }
  catch (error) { findings.push({ name, message: error.message.split('\n')[0] }); }
}
class ReviewError extends Error { constructor(message) { super(message); this.name = 'AutomaticOperationReviewError'; } }
function fixture({ accountId, charge = 61, enabled = true } = {}) {
  const events = [], sourceReads = [], sourceWrites = [], metadata = [];
  let accountReads = 0;
  const odoo = { get returnChargeAccountId() { accountReads++; events.push('config:expense-account'); return accountId; } };
  const sourceRead = name => async () => { events.push(`source-read:${name}`); sourceReads.push(name); throw Error('Synthetic stop after configuration preflight'); };
  const sourceWrite = name => async () => { events.push(`source-write:${name}`); sourceWrites.push(name); throw Error('Unexpected source write in configuration-only test'); };
  const candidate = { id: 1, shopifyOrderId: '900001', shopifyOrderName: '#900001', accurateShipmentCode: 'VI9000001',
    accurateShipmentId: 700, odooSaleOrderId: 31, returnSyncFingerprint: 'synthetic', collectionStatus: 'returned' };
  const repository = {
    async recoverStuckReturnSync() { metadata.push('recover'); return 0; },
    async findPendingReturnSync() { metadata.push('list'); return [candidate]; },
    async reviewReturnSync() { metadata.push('review'); },
    async countDueReturnSync() { metadata.push('count'); return 0; },
    async claimReturnSync() { metadata.push('claim'); throw Error('Claim must follow fee configuration guard'); },
  };
  const guardedRepository = new Proxy(repository, { get(target, key) {
    if (Object.hasOwn(target, key)) return target[key];
    throw Error(`Unapproved synthetic repository method ${String(key)}`);
  } });
  const mocks = {
    'node:crypto': { createHash },
    '../accurate/accurateClient.js': { AccurateClient: class {} },
    '../config/env.js': { env: { odoo } },
    '../lib/logger.js': { logger: { info() {}, warn() {}, error() {} } },
    '../lib/errors.js': { UnauthorizedError: class extends Error {} },
    '../shopify/shopifyStatusSyncClient.js': { shopifyStatusSyncClient: {
      syncShipmentState: sourceWrite('Shopify status'), cancelOrder: sourceWrite('Shopify cancellation'),
    } },
    './accurateStatusMapper.js': { projectAccurateStatusToShopify() { throw Error('Unexpected projection before preflight stop'); } },
    './failedPayloadService.js': { failedPayloadService: { async save() { metadata.push('audit'); } } },
    './shipmentRepository.js': { shipmentRepository: guardedRepository },
    '../odoo/odooSyncService.js': { calculateTelegraphReturnCharge: () => charge, OdooSyncService: class {} },
    '../odoo/odooSaleReturnService.js': { OdooSaleReturnReviewError: class extends Error {} },
    './ownerFinancialApproval.js': {readOwnerFinancialApproval:async()=>null,releaseOwnerShopifyAfterAccounting:async()=>{throw Error('Unexpected collection handoff in return fixture');}},
    './automaticOperationSafety.js': {
      AutomaticOperationReviewError: ReviewError, automaticQueueSafetyActive: () => enabled,
      async automaticRecordBlocked() { metadata.push('hold-check'); return false; },
      async withAutomaticOperation(input, action) { assert.equal(input.lane, 'return'); events.push('ALS:return'); return await action(); },
    },
    './verifiedCarrierShipment.js': { loadExactCarrierShipment: sourceRead('carrier'), assertExactCarrierIdentity() { throw Error('Unexpected carrier identity call'); } },
    './automationSafety.js': { isDatabaseQuotaError: () => false },
    '../shopify/shopifyOrdersClient.js': { shopifyOrdersClient: { getOrderByLegacyId: sourceRead('Shopify') } },
    '../odoo/odooClient.js': { OdooClient: class { searchRead = sourceRead('Odoo'); } },
  };
  const module = { exports: {} };
  const context = createContext({ module, exports: module.exports, process: { env: Object.create(null) }, console,
    fetch() { deniedNetwork++; throw Error('Real network forbidden'); },
    WebSocket() { deniedNetwork++; throw Error('Real network forbidden'); },
    setTimeout() { throw Error('Unexpected timer in pure return configuration test'); },
    require(id) { if (Object.hasOwn(mocks, id)) return mocks[id];if(id.endsWith('/cancellationRecoveryPolicy.js'))return{isOdooOnlyRecovery:()=>false,assertRecoveryNotExcluded(){}};if(id.endsWith('/cancellationRecoveryService.js'))return{deferReturnDuringGrace:async()=>false,recordNativeReturnProof:async()=>{},repairDocumentedFalseReturn:async()=>false}; deniedImports++; throw Error(`Unexpected import ${id}`); },
  }, { codeGeneration: { strings: false, wasm: false } });
  new Script(compiled.outputText, { filename: 'shipmentStatusSyncService.vm.cjs' }).runInContext(context);
  const exports = module.exports;
  return { ...exports, events, sourceReads, sourceWrites, metadata, get accountReads() { return accountReads; },
    service: new exports.ShipmentStatusSyncService({}, {
      syncReturnedShipmentCharge: sourceWrite('Odoo fee'), reverseReturnedSaleOrderAccountingAndCancel: sourceWrite('Odoo stock'),
      previewReturnedSaleOrder: sourceRead('Odoo return preview'),
    }) };
}

for (const charge of [0.01, 1, 61, 66]) await test(`Positive fee ${charge} accepts configured positive integer expense account without I/O`, () => {
  const f = fixture({ accountId: 101 }); f.assertAutomaticReturnFeeConfiguration(charge);
  assert.ok(f.accountReads > 0); assert.equal(f.metadata.length, 0); assert.equal(f.sourceReads.length, 0); assert.equal(f.sourceWrites.length, 0);
});
for (const accountId of [undefined, null, 0, -1, -101, 1.5, NaN, Infinity, '101', false, Number.MAX_SAFE_INTEGER + 1]) {
  await test(`Positive fee rejects invalid expense account ${String(accountId)} before I/O`, () => {
    const f = fixture({ accountId }); assert.throws(() => f.assertAutomaticReturnFeeConfiguration(61), ReviewError);
    assert.equal(f.metadata.length, 0); assert.equal(f.sourceReads.length, 0); assert.equal(f.sourceWrites.length, 0);
  });
}
for (const charge of [NaN, Infinity, -1, '61', null, undefined]) await test(`Invalid fee ${String(charge)} fails closed without I/O`, () => {
  const f = fixture({ accountId: 101 }); assert.throws(() => f.assertAutomaticReturnFeeConfiguration(charge), ReviewError);
  assert.equal(f.metadata.length, 0); assert.equal(f.sourceReads.length, 0); assert.equal(f.sourceWrites.length, 0);
});
for (const accountId of [undefined, null, 0, -1, 1.5, '101', 101]) await test(`Zero fee requires no expense-account read (${String(accountId)})`, () => {
  const f = fixture({ accountId }); f.assertAutomaticReturnFeeConfiguration(0);
  assert.equal(f.accountReads, 0); assert.equal(f.metadata.length, 0); assert.equal(f.sourceReads.length, 0); assert.equal(f.sourceWrites.length, 0);
});
for (const charge of [0, 61, NaN, -1]) await test(`Disabled safe mode preserves legacy no-op guard (${String(charge)})`, () => {
  const f = fixture({ enabled: false }); f.assertAutomaticReturnFeeConfiguration(charge);
  assert.equal(f.accountReads, 0); assert.equal(f.events.length, 0); assert.equal(f.metadata.length, 0);
});

// Actual processReturnQueue callback: bad config must stop BEFORE even source
// preflight reads or queue claim; only synthetic metadata review is permitted.
for (const accountId of [undefined, 0, 1.5, '101']) await test(`Return callback stops before source/claim with invalid account ${String(accountId)}`, async () => {
  const f = fixture({ accountId }); const result = await f.service.processReturnQueue({ apply: true });
  assert.equal(result.actions[0].status, 'needs-review'); assert.equal(result.processed, 0);
  assert.equal(f.sourceReads.length, 0); assert.equal(f.sourceWrites.length, 0); assert.equal(f.metadata.includes('claim'), false);
  // The new observation/grace phase has no business claim. Invalid config
  // stops even earlier; the unchanged execution ALS still starts with the guard.
  assert.ok(f.metadata.includes('review')); assert.equal(f.events[0], 'config:expense-account');assert.equal(f.events.includes('ALS:return'),false);
});
for (const [charge, accountId] of [[0, undefined], [61, 101]]) await test(`Return callback permits readonly preflight after valid fee configuration (${charge})`, async () => {
  const f = fixture({ charge, accountId }); await f.service.processReturnQueue({ apply: true });
  assert.deepEqual(f.sourceReads, ['carrier']); assert.equal(f.sourceWrites.length, 0);
  if (charge > 0) assert.ok(f.events.indexOf('config:expense-account') < f.events.indexOf('source-read:carrier'));
});

// AST ordering, not a text-search approximation: the guard must be the first
// statement of the actual return ALS callback, before every named source write.
await test('Return ALS callback starts with fee guard before all source writes', () => {
  const ast = ts.createSourceFile('shipmentStatusSyncService.ts', source, ts.ScriptTarget.Latest, true);
  let callback;
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'withAutomaticOperation') {
      const input = node.arguments[0], action = node.arguments[1];
      if (ts.isObjectLiteralExpression(input) && input.properties.some(p => ts.isPropertyAssignment(p) && p.name.getText(ast) === 'lane' && p.initializer.text === 'return')) callback = action;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast); assert.ok(callback && ts.isArrowFunction(callback) && ts.isBlock(callback.body));
  const first = callback.body.statements[0];
  assert.ok(ts.isExpressionStatement(first) && ts.isCallExpression(first.expression));
  assert.equal(first.expression.expression.getText(ast), 'assertAutomaticReturnFeeConfiguration');
  assert.equal(first.expression.arguments[0].getText(ast), 'charge');
  const required = new Set(['claimReturnSync', 'syncShipmentState', 'syncReturnedShipmentCharge', 'cancelOrder', 'reverseReturnedSaleOrderAccountingAndCancel']);
  const writes = node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && required.has(node.expression.name.text)) {
      assert.ok(node.getStart(ast) > first.end); required.delete(node.expression.name.text);
    }
    ts.forEachChild(node, writes);
  };
  writes(callback.body); assert.equal(required.size, 0);
});

for(const value of [1,61,-1,NaN,Infinity,null,undefined,'0'])await test(`Nonzero/unknown return money is held (${String(value)})`,()=>{const f=fixture({accountId:101});assert.throws(()=>f.assertAutomaticUnpaidReturn(value),ReviewError);assert.equal(f.sourceWrites.length,0);});
await test('Exactly zero collected return money is safe without I/O',()=>{const f=fixture({accountId:101});f.assertAutomaticUnpaidReturn(0);assert.equal(f.events.length,0);});
assert.equal(deniedImports, 0); assert.equal(deniedNetwork, 0);
console.log(JSON.stringify({ ok: findings.length === 0, checks: passed + findings.length, passed, findings, deniedImports, deniedNetwork,
  realNetworkCalls: 0, realDatabaseConnections: 0, realQueuePublications: 0, realPreviewRun: 0, realBusinessWrites: 0, filesWritten: 0 }));
if (findings.length) process.exitCode = 1;
