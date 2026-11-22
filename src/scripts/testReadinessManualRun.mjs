/** Offline VM-only tests. The imported harness first runs its 195 unchanged
 * default-manual-false regressions. No production module is imported by Node. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture, OWNER, OTHER, DATE, UPDATE, EPOCH } from './testReadinessPreviewOnly.mjs';

const RUN_EPOCH = 'synthetic_manual_run_20261101';
const manualEnv = { PRODUCTION_MANUAL_RUN_ENABLED: 'true', PRODUCTION_MANUAL_RUN_EPOCH: RUN_EPOCH,
  PRODUCTION_MANUAL_RUN_NOT_BEFORE: String(DATE), PRODUCTION_MANUAL_RUN_MIN_UPDATE_ID: String(UPDATE),
  PRODUCTION_PREVIEW_ALLOWED_CHAT_IDS: `${OWNER},${OTHER}`, PRODUCTION_PREVIEW_RECIPIENT_CHAT_IDS: `${OWNER},${OTHER}`,
  TELEGRAPH_ENABLED: 'true', ODOO_SYNC_ENABLED: 'false' };
const clone = value => structuredClone(value);
const order = () => ({ id: 900100, admin_graphql_api_id: 'gid://shopify/Order/900100', name: '#SYNTHETIC',
  order_number: 900100, confirmed: true, test: false, cancelled_at: null, fulfillment_status: null,
  financial_status: 'pending', total_price: '100', total_outstanding: '100', currency: 'EGP',
  payment_gateway_names: ['Cash on Delivery (COD)'], tags: 'confirmed', note: 'synthetic customization',
  shipping_address: { address1: 'synthetic', city: 'synthetic', phone: '0000000000' },
  note_attributes: [{ name: 'Telegraph Governorate ID', value: '1' }, { name: 'Telegraph Area ID', value: '2' }],
  line_items: [{ id: 900101, title: 'synthetic product', sku: 'SYNTHETIC', quantity: 1, current_quantity: 1,
    variant_id: 900102, product_id: 900103, price: '100', properties: [{ name: 'engraving', value: 'synthetic' }] }] });
function setup(overrides = {}) {
  const f = fixture({ ...manualEnv, ...overrides });
  const binding = f.load('src/services/manualShipmentBinding.ts');
  const bindings = [binding.bindManualShipment(order())];
  const ready = (patch = {}) => f.cursor({ status: 'preview_ready', sourceFingerprint: 'a'.repeat(64),
    previewReadyAt: DATE, recipientChatIds: [String(OWNER), String(OTHER)], manualShipmentBindings: clone(bindings),
    manualShipmentBindingHash: binding.manualShipmentBindingsHash(bindings), ...patch });
  const request = (who = OWNER, patch = {}) => ({ recipientChatIds: [String(OWNER), String(OTHER)],
    telegramUpdateId: UPDATE + 10, telegramFromId: who, telegramMessageDate: DATE + 1, ...patch });
  return { ...f, binding, ready, request };
}
let checks = 0, failures = 0;
async function check(name, fn) {
  checks++;
  try { await fn(); console.log(`manual ok ${checks} - ${name}`); }
  catch (error) { failures++; console.error(`manual not ok ${checks} - ${name}\n${error.stack}`); }
}
for (const [key, values] of Object.entries({
  PRODUCTION_MANUAL_RUN_EPOCH: [undefined, '', 'short', EPOCH, 'x'.repeat(81)],
  PRODUCTION_MANUAL_RUN_NOT_BEFORE: [undefined, '', ' ', 'no', '0', '-1', '1.5', 'Infinity'],
  PRODUCTION_MANUAL_RUN_MIN_UPDATE_ID: [undefined, '', ' ', 'no', '-1', '1.5', '9007199254740992'],
})) for (const value of values) await check(`invalid ${key}=${JSON.stringify(value)} fails before effects`, async () => {
  const f = setup({ [key]: value });
  assert.throws(f.policy.manualRunConfig, /not configured safely/);
  await assert.rejects(f.store.queueRun(OWNER, f.request()), /not configured safely/); f.idle();
});
for (const who of [OWNER, OTHER]) {
  await check(`operator ${who} atomically approves only ready bound Preview`, async () => {
    const f = setup(); f.seed(f.ready(), who); f.seedSnapshot('synthetic-batch');
    const result = await f.store.queueRun(who, f.request(who));
    const run = result.job;
    assert.equal(result.action, 'started_run'); assert.equal(run.kind, 'run'); assert.equal(run.pendingRun, false);
    assert.equal(run.manualRunApprovedBy, who); assert.equal(run.manualRunEpoch, RUN_EPOCH);
    assert.equal(run.manualRunApprovedUpdateId, UPDATE + 10); assert.equal(run.manualRunMessageDate, DATE + 1);
    assert.equal(run.manualRunApprovedBatchId, run.batchId); assert.equal(run.previewOnlyEpoch, EPOCH);
    assert.equal(run.manualRunApprovalBindingHash, run.manualShipmentBindingHash);
    assert.deepEqual(clone(run.manualShipmentBindings), clone(f.ready().manualShipmentBindings));
    f.policy.assertProductionRunAllowed({ chatId: who, cursor: run });
    await f.policy.assertProductionInvocationAllowed(who, run.batchId);
    await f.load('src/services/productionContinuation.ts').scheduleProductionContinuation({ chatId: who, batchId: run.batchId });
    assert.equal(f.effects.publications[0][0], f.policy.PREVIEW_ONLY_TOPIC);
    const claimed = await f.store.claimJob(who, run.batchId); assert.equal(claimed.status, 'running');
    await f.store.assertJobLease(who, claimed.batchId, claimed.executionToken);
    assert.ok(f.rows().some(row => row.source === 'prod_preview_snapshot'));
    const before = f.rows(); await assert.rejects(f.store.queueRun(who, f.request(who)), /already accepted/);
    assert.deepEqual(f.rows(), before); assert.equal(f.effects.business, 0); f.protectedIntact();
  });
  for (const status of ['queued', 'running', 'retrying', 'needs_review']) await check(`operator ${who} cannot queue pending Run from ${status}`, async () => {
    const f = setup(); f.seed(f.ready({ status }), who); const before = f.rows();
    await assert.rejects(f.store.queueRun(who, f.request(who)), /NEW completed Preview/);
    assert.deepEqual(f.rows(), before); assert.equal(f.effects.writes + f.effects.publications.length, 0); f.protectedIntact();
  });
  await check(`operator ${who} cannot create implicit Preview or Run`, async () => {
    const f = setup(); const before = f.rows(); await assert.rejects(f.store.queueRun(who, f.request(who)), /NEW completed Preview/);
    assert.deepEqual(f.rows(), before); assert.equal(f.effects.writes, 0);
  });
  await check(`operator ${who} fresh webhook /run approves and dispatches only dedicated transport`, async () => {
    const f = setup(); f.seed(f.ready(), who); const update = f.payload('/run');
    update.update_id = UPDATE + 10; update.message.chat.id = who; update.message.from.id = who; update.message.date = DATE + 1;
    await f.webhook(update); const run = await f.store.loadJob(who);
    assert.equal(run.kind, 'run'); assert.equal(run.manualRunApprovedBy, who);
    assert.equal(f.effects.publications.length, 1); assert.equal(f.effects.publications[0][0], f.policy.PREVIEW_ONLY_TOPIC);
    assert.equal(f.effects.business + f.effects.sheets + f.effects.callbacks, 0);
    const before = f.rows(), messages = f.effects.messages.length; await f.webhook(update);
    assert.deepEqual(f.rows(), before); assert.equal(f.effects.messages.length, messages); f.protectedIntact();
  });
}
for (const [label, patch] of [
  ['old epoch', { previewOnlyEpoch: 'old_preview_epoch_20261031' }], ['missing bindings', { manualShipmentBindings: undefined }],
  ['binding hash mismatch', { manualShipmentBindingHash: 'b'.repeat(64) }], ['no source hash', { sourceFingerprint: undefined }],
  ['pendingRun', { pendingRun: true }], ['no ready timestamp', { previewReadyAt: undefined }],
  ['message predates ready', { previewReadyAt: DATE + 2 }], ['single recipient', { recipientChatIds: [String(OWNER)] }],
]) await check(`ready gate rejects ${label} without writes`, async () => {
  const f = setup(); f.seed(f.ready(patch)); const before = f.rows(); await assert.rejects(f.store.queueRun(OWNER, f.request()));
  assert.deepEqual(f.rows(), before); assert.equal(f.effects.writes + f.effects.publications.length, 0);
});
for (const patch of [{ telegramFromId: OTHER }, { telegramFromId: undefined }, { telegramMessageDate: DATE - 1 },
  { telegramUpdateId: UPDATE }, { telegramUpdateId: undefined }, { recipientChatIds: [OWNER, 900003] }]) {
  await check(`request gate rejects ${JSON.stringify(patch)} before DB`, async () => {
    const f = setup(); await assert.rejects(f.store.queueRun(OWNER, f.request(OWNER, patch))); f.idle();
  });
}
await check('Run boundaries independently reject old date and update', async () => {
  for (const overrides of [{ PRODUCTION_MANUAL_RUN_NOT_BEFORE: String(DATE + 2) },
    { PRODUCTION_MANUAL_RUN_MIN_UPDATE_ID: String(UPDATE + 11) }]) {
    const f = setup(overrides); await assert.rejects(f.store.queueRun(OWNER, f.request())); f.idle();
  }
});
const runFixture = async (who = OWNER) => { const f = setup(); f.seed(f.ready(), who); const { job } = await f.store.queueRun(who, f.request(who)); return { f, run: job }; };
for (const [label, patch] of [
  ['missing approval', { manualRunApprovedBy: undefined }], ['different operator', { manualRunApprovedBy: OTHER }],
  ['wrong Run epoch', { manualRunEpoch: 'old_manual_epoch_20261031' }], ['wrong batch', { manualRunApprovedBatchId: 'other' }],
  ['old approval update', { manualRunApprovedUpdateId: UPDATE }], ['old approval date', { manualRunMessageDate: DATE - 1 }],
  ['missing approvedAt', { manualRunApprovedAt: undefined }], ['changed binding', { manualRunApprovalBindingHash: 'f'.repeat(64) }],
  ['changed production fingerprint', { sourceFingerprint: 'c'.repeat(64) }],
  ['widened recipients', { recipientChatIds: [String(OWNER), '900003'] }], ['pending Run', { pendingRun: true }],
]) await check(`durable invocation rejects ${label}`, async () => {
  const { f, run } = await runFixture(); Object.assign(run, patch);
  assert.throws(() => f.policy.assertProductionRunAllowed({ chatId: OWNER, cursor: run }));
  const g = setup(); g.seed(run); const before = g.rows();
  await assert.rejects(g.policy.assertProductionInvocationAllowed(OWNER, run.batchId));
  await assert.rejects(g.store.claimJob(OWNER, run.batchId)); assert.deepEqual(g.rows(), before); assert.equal(g.effects.writes, 0);
});
for (const who of [OWNER, OTHER]) await check(`operator ${who} may cancel approved current Run but not old Run`, async () => {
  const { f, run } = await runFixture(who); await f.store.clearJob(who, UPDATE + 11);
  assert.equal(await f.store.loadJob(who), null); assert.equal(JSON.parse(f.rows().find(r => r.source === 'prod_job_history').payloadJson).status, 'cancelled');
  const g = setup(); g.seed({ ...run, manualRunEpoch: 'old_manual_epoch_20261031' }, who); const before = g.rows();
  await assert.rejects(g.store.clearJob(who, UPDATE + 12)); assert.deepEqual(g.rows(), before); assert.equal(g.effects.writes, 0);
});
await check('old valid v2 Preview remains cancellable across Preview epoch change', async () => {
  const f = setup(); f.seed(f.ready({ previewOnlyEpoch: 'old_preview_epoch_20261031' }));
  await f.store.clearJob(OWNER, UPDATE + 11); assert.equal(await f.store.loadJob(OWNER), null); f.protectedIntact();
});
for (const field of ['id', 'name', 'total_price', 'financial_status', 'cancelled_at', 'shipping_address', 'line_items', 'note_attributes', 'note', 'payment_gateway_names']) {
  await check(`shipping binding detects ${field} change`, () => {
    const f = setup(), before = order(), binding = f.binding.bindManualShipment(before), after = clone(before);
    if (field === 'id') after.id++;
    else if (field === 'line_items') after.line_items[0].quantity++;
    else if (field === 'shipping_address') after.shipping_address.city = 'changed';
    else if (field === 'note_attributes') after.note_attributes[0].value = '3';
    else after[field] = field === 'payment_gateway_names' ? ['changed'] : 'changed';
    assert.throws(() => f.binding.assertManualShipmentUnchanged(binding, after)); f.idle();
  });
}
await check('observational timestamp changes alone do not alter binding', () => {
  const f = setup(), before = order(), after = { ...order(), updated_at: '2030-01-01T00:00:00Z' };
  f.binding.assertManualShipmentUnchanged(f.binding.bindManualShipment(before), after); f.idle();
});
await check('own fulfillment transition leaves immutable shipping binding unchanged', () => {
  const f = setup(), before = order(), after = { ...order(), fulfillment_status: 'fulfilled' };
  f.binding.assertManualShipmentUnchanged(f.binding.bindManualShipment(before), after); f.idle();
});
await check('unread line customizations cannot silently receive an incomplete binding', () => {
  const f = setup(), value = order(); delete value.line_items[0].properties;
  assert.throws(() => f.binding.bindManualShipment(value), /Complete line-item properties/); f.idle();
});
await check('a full 50-line GraphQL page is held rather than assumed complete', () => {
  const f = setup(), value = order(); value.line_items = Array.from({ length: 50 }, (_, i) => ({ ...value.line_items[0], id: 900200 + i }));
  assert.throws(() => f.binding.bindManualShipment(value), /fewer than 50/); f.idle();
});
await check('completed manual Preview retains source and records ready boundary', async () => {
  const f = setup(), preview = f.ready({ status: 'running', executionToken: 'synthetic-lease', previewReadyAt: undefined });
  f.seed(preview); f.seedSnapshot(preview.batchId); const ready = await f.store.finishPreview(OWNER, preview, preview.executionToken);
  assert.ok(Number.isSafeInteger(ready.previewReadyAt)); assert.equal(ready.pendingRun, false);
  assert.ok(f.rows().some(r => r.source === 'prod_preview_snapshot')); f.protectedIntact();
});
for (const mutate of [false, true]) await check(`Preview captures bracketed shipping bindings; source drift=${mutate}`, async () => {
  const f = setup(), preview = f.cursor({ status: 'running', executionToken: 'synthetic-lease', orderNumbers: ['#900100'], recipientChatIds: [String(OWNER), String(OTHER)] });
  f.seed(preview); let reads = 0, saved = 0;
  f.mocks['src/shopify/shopifyOrdersClient.ts'].shopifyOrdersClient.listAllMatchingOrders = async () => {
    const value = { ...order(), name: '#900100' }; if (++reads === 2 && mutate) value.line_items[0].quantity++; return [value];
  };
  Object.assign(f.mocks['src/services/productionAgentClient.ts'], {
    fetchProductionBatch: async () => ({ productionEntries: [], ordersDetail: [{ order_name: '#900100' }], wordBase64: 'synthetic' }),
    extractOrderNumbers: () => ['#900100'], productionSourceFingerprint: () => 'a'.repeat(64),
  });
  await assert.rejects(f.load('src/services/productionPreviewService.ts').sendCompleteProductionPreview({ chatId: OWNER, cursor: preview,
    deadline: Date.now() + 50000, checkpoint: async () => { throw Error('capture-complete-stop'); },
    sourceSnapshot: { load: async () => null, save: async () => { saved++; } } }), mutate ? /source changed/ : /capture-complete-stop/);
  assert.equal(reads, 2); assert.equal(saved, mutate ? 0 : 1); assert.equal(f.effects.business, 0);
  if (!mutate) f.binding.assertManualShipmentBindings(preview); f.protectedIntact();
});
await check('contextless/direct/normal queue paths remain held even with manual opt-in', async () => {
  const f = setup({ OPS_AUTOMATION_HOLD: undefined }); assert.throws(f.policy.assertProductionRunAllowed);
  assert.throws(f.safety.assertAutomationReleased);
  await assert.rejects(f.load('src/netlify/functions/run-production-background.ts').handler({ body: JSON.stringify({ chatId: OWNER, execute: true }) }));
  await assert.rejects(f.load('src/services/productionShippingService.ts').createExactBatchShipments({ chatId: OWNER, cursor: f.ready() }));
  f.load('api/production-continuation-queue.ts'); await assert.rejects(f.consumers.at(-1).callback({ chatId: OWNER, batchId: 'synthetic-batch' })); f.idle();
});
for (const text of ['شحن', 'اشحن', '/resume', '/stop']) await check(`manual mode does not authorize ${text}`, async () => {
  const f = setup(); await f.webhook(f.payload(text)); assert.equal(f.effects.writes + f.effects.publications.length + f.effects.business, 0); f.protectedIntact();
});
await check('health distinguishes manual permission from global/financial release', () => {
  const f = setup(); f.load('src/app.ts').createApp(); const health = f.routes.find(r => r.path === '/health'); let result;
  health.handlers[0]({}, { status() { return this; }, json(value) { result = clone(value); } });
  assert.equal(result.manualRunEnabled, true); assert.equal(result.runEnabled, false);
  assert.equal(result.automaticWorkHeld, true); assert.equal(result.financialWorkersHeld, true); f.idle();
});
await check('actual shipping helper passes the scoped processor contract with fake reads only', async () => {
  const { f, run } = await runFixture(); let calls = 0, freshReads = 0;
  Object.assign(f.mocks['src/shopify/shopifyOrdersClient.ts'].shopifyOrdersClient, {
    listAllMatchingOrders: async () => [order()], getOrderByLegacyId: async id => { assert.equal(id, '900100'); freshReads++; return order(); },
  });
  f.mocks['src/services/shopifyOrderProcessor.ts'] = { ShopifyOrderProcessor: class { async process(candidate, ctx) {
    calls++; assert.equal(candidate.id, 900100);
    assert.deepEqual(clone(ctx.manualRunAuthorization), { chatId: OWNER, batchId: run.batchId, epoch: RUN_EPOCH, updateId: UPDATE + 10 });
    await ctx.assertOperationAllowed(); await ctx.assertSourceUnchanged(); return { skipped: false, accurateShipmentId: 900199 };
  } } };
  await f.load('src/netlify/functions/run-production-background.ts').runPipeline(OWNER, run.batchId);
  assert.equal(calls, 1); assert.ok(freshReads >= 2); assert.equal(await f.store.loadJob(OWNER), null);
  assert.ok(f.effects.messages.some(([, text]) => text.includes('Odoo') && text.includes('لم')));
  assert.equal(f.effects.business + f.effects.sheets + f.effects.callbacks, 0); f.protectedIntact();
});
await check('ordinary queue and direct handler source retain independent global/no-context fences', () => {
  const root = new URL('../../', import.meta.url);
  assert.match(readFileSync(new URL('api/production-continuation-queue.ts', root), 'utf8'), /assertAutomationReleased\(\)/);
  assert.match(readFileSync(new URL('src/netlify/functions/run-production-background.ts', root), 'utf8'), /export const handler[\s\S]*assertProductionRunAllowed\(\)/);
});
await check('simultaneous duplicate approvals mint only one durable Run', async () => {
  const f = setup(); f.seed(f.ready());
  const results = await Promise.allSettled([f.store.queueRun(OWNER, f.request()), f.store.queueRun(OWNER, f.request())]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.rows().filter(r => r.source === 'prod_job').length, 1);
  assert.equal((await f.store.loadJob(OWNER)).manualRunApprovedUpdateId, UPDATE + 10); f.protectedIntact();
});
await check('fresh second /run cannot replace an approved Run or add pendingRun', async () => {
  const { f } = await runFixture(); const before = f.rows();
  await assert.rejects(f.store.queueRun(OWNER, f.request(OWNER, { telegramUpdateId: UPDATE + 11 })), /NEW completed Preview/);
  assert.deepEqual(f.rows(), before);
});
await check('manual flag without Preview containment fails closed before effects', async () => {
  const f = setup({ PRODUCTION_PREVIEW_ONLY: 'false', OPS_AUTOMATION_HOLD: undefined });
  assert.throws(f.policy.assertProductionRunAllowed, /not configured safely/);
  await assert.rejects(f.policy.assertProductionInvocationAllowed(OWNER, 'synthetic-batch'), /not configured safely/); f.idle();
});
for (const mutate of ['source', 'cancel', 'fulfillment']) await check(`processor callback boundary preserves ${mutate} safety`, async () => {
  const { f, run } = await runFixture(); let sourceReads = 0, creates = 0, documents = 0;
  f.mocks['src/telegram/telegramApi.ts'].sendDocument = async () => { documents++; return true; };
  Object.assign(f.mocks['src/shopify/shopifyOrdersClient.ts'].shopifyOrdersClient, {
    listAllMatchingOrders: async () => [order()],
    getOrderByLegacyId: async () => {
      sourceReads++; const value = order();
      if (sourceReads > 1 && mutate === 'source') value.shipping_address.address1 = 'changed';
      return value;
    },
  });
  f.mocks['src/services/shopifyOrderProcessor.ts'] = { ShopifyOrderProcessor: class { async process(candidate, ctx) {
    if (mutate === 'cancel') await f.store.clearJob(OWNER, UPDATE + 11);
    await ctx.assertOperationAllowed(); await ctx.assertSourceUnchanged(); creates++;
    return { skipped: false, accurateShipmentId: 900199,
      ...(mutate === 'fulfillment' ? { fulfillment: { skipped: true, reason: 'fulfillment-error: synthetic failure' } } : {}) };
  } } };
  await f.load('src/netlify/functions/run-production-background.ts').runPipeline(OWNER, run.batchId);
  assert.equal(creates, mutate === 'fulfillment' ? 1 : 0);
  if (mutate === 'fulfillment') {
    const history = f.rows().find(r => r.source === 'prod_job_history');
    const saved = JSON.parse(history.payloadJson);
    assert.equal(saved.results[0].category, 'shipped');
    assert.match(saved.results[0].reason, /^fulfillment-error:/);
    assert.ok(saved.needsReviewOrderNames.includes('#SYNTHETIC'));
    assert.ok(f.effects.messages.some(([, text]) => text.includes('fulfillment') && text.includes('1')));
    assert.ok(documents > 0);
  }
  assert.equal(f.effects.business, 0); f.protectedIntact();
});
for (const phase of ['before', 'own']) await check(`fulfillment ${phase} operation is handled at correct boundary`, async () => {
  const { f, run } = await runFixture(); let created = 0, fulfilled = phase === 'before';
  f.mocks['src/telegram/telegramApi.ts'].sendDocument = async () => true;
  Object.assign(f.mocks['src/shopify/shopifyOrdersClient.ts'].shopifyOrdersClient, {
    listAllMatchingOrders: async () => [order()],
    getOrderByLegacyId: async () => ({ ...order(), fulfillment_status: fulfilled ? 'fulfilled' : null }),
  });
  f.mocks['src/services/shopifyOrderProcessor.ts'] = { ShopifyOrderProcessor: class { async process(candidate, ctx) {
    await ctx.assertSourceUnchanged(); created++; fulfilled = true;
    await ctx.assertOperationAllowed(); await ctx.assertSourceUnchanged();
    return { skipped: false, accurateShipmentId: 900199 };
  } } };
  await f.load('src/netlify/functions/run-production-background.ts').runPipeline(OWNER, run.batchId);
  assert.equal(created, phase === 'before' ? 0 : 1); assert.equal(f.effects.business, 0); f.protectedIntact();
});
console.log(JSON.stringify({ manualRun: true, ok: failures === 0, checks, failures, realNetwork: 0, realDB: 0, realQueue: 0, realBusinessWrites: 0 }));
if (failures) process.exitCode = 1;
