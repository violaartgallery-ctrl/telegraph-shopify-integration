/** Offline VM tests for the ACTUAL policy/operation modules. No real client,
 * dotenv, DB, queue or network import; no generated files. */
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script, createContext } from 'node:vm';

for (const key of Object.keys(process.env)) delete process.env[key];
const require = createRequire(import.meta.url), ts = require('typescript');
const sources = new Map(['safeQueuePolicy', 'automaticOperationSafety'].map(name => {
  const source = readFileSync(new URL(`../services/${name}.ts`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    fileName: `${name}.ts`, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  assert.equal((compiled.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  return [name, compiled.outputText];
}));
let checks = 0, deniedImports = 0, deniedNetwork = 0;
const findings = [];
async function regression(name, action) {
  try { await action(); checks++; }
  catch (error) { findings.push({ name, message: error.message.split('\n')[0] }); }
}
const check = (value, label) => { assert.ok(value, label); checks++; };
const clone = value => structuredClone(value);
const validEnv = {
  OPS_SAFE_QUEUES_ENABLED: 'true', OPS_SAFE_QUEUES_EPOCH: 'synthetic-queue-epoch-20261101',
  OPS_SAFE_QUEUES_PROOF: 'a'.repeat(64), SHOPIFY_SHOP_DOMAIN: 'violaleather.myshopify.com',
  ORDER_REFERENCE_PREFIX: 'Viola', SHIPMENT_CODE_PREFIX: 'VI', ODOO_SYNC_ENABLED: 'true',
  OPS_AUTOMATION_HOLD: 'true', PRODUCTION_PREVIEW_ONLY: 'true',
};
const lanes = ['production', 'return', 'collection', 'shopify', 'status'];
const claimSource = 'automatic_operation_claim';
const payload = row => JSON.parse(row.payloadJson);
const claims = f => f.rows.filter(r => r.source === claimSource);
const holds = f => f.rows.filter(r => r.source === 'ops_record_hold');
const op = (lane = 'production', key = 'stage-one', recordId = 1) => ({ lane, key, recordId, fingerprint: 'synthetic-fingerprint' });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function matches(row, where = {}) {
  return Object.entries(where).every(([key, wanted]) => {
    if (key === 'AND') return (Array.isArray(wanted) ? wanted : [wanted]).every(w => matches(row, w));
    if (key === 'OR') return wanted.some(w => matches(row, w));
    if (key === 'NOT') return !(Array.isArray(wanted) ? wanted : [wanted]).some(w => matches(row, w));
    const got = row[key];
    if (wanted && typeof wanted === 'object' && !Array.isArray(wanted) && !(wanted instanceof Date)) {
      return Object.entries(wanted).every(([operator, value]) => {
        if (operator === 'in') return value.includes(got);
        if (operator === 'notIn') return !value.includes(got);
        if (operator === 'equals') return got === value;
        if (operator === 'not') return got !== value;
        if (operator === 'lt') return got < value;
        if (operator === 'lte') return got <= value;
        if (operator === 'gt') return got > value;
        if (operator === 'gte') return got >= value;
        throw new Error(`Unsupported synthetic where operator ${operator}`);
      });
    }
    return got === wanted;
  });
}

function fixture({ settings = {}, disabled = false, seedRows = [], seedRecords, fault } = {}) {
  const env = { ...(disabled ? {} : validEnv), ...settings };
  const rows = clone(seedRows).map((r, i) => ({ id: i + 1, ...r }));
  const records = clone(seedRecords ?? [{
    id: 1, shopifyOrderId: '900001', odooSyncStatus: 'odoo-so-pending',
    returnSyncStatus: 'pending', odooCollectionSyncStatus: 'pending', shopifyPaymentSyncStatus: 'pending',
  }, { id: 2, shopifyOrderId: '900002', odooSyncStatus: 'odoo-stock-pending' }]);
  const io = [], locks = [], mutations = [];
  let nextId = Math.max(0, ...rows.map(r => r.id)) + 1, uuid = 0, serial = Promise.resolve(), faultHandler = fault;
  function before(operation, args) {
    io.push({ operation, args: clone(args) });
    return faultHandler?.(operation, args);
  }
  function table(name, data) {
    return {
      async findMany(args = {}) { before(`${name}.findMany`, args); return clone(data.filter(r => matches(r, args.where))); },
      async findUnique(args) {
        before(`${name}.findUnique`, args);
        const row = data.find(r => matches(r, args.where));
        if (!row) return null;
        return args.select ? Object.fromEntries(Object.entries(args.select).filter(([, yes]) => yes).map(([k]) => [k, clone(row[k])])) : clone(row);
      },
      async create(args) {
        before(`${name}.create`, args);
        const row = { id: nextId++, ...clone(args.data) }; data.push(row);
        mutations.push({ operation: `${name}.create`, args: clone(args) }); return clone(row);
      },
      async update(args) {
        before(`${name}.update`, args);
        const row = data.find(r => matches(r, args.where));
        if (!row) throw Error('Synthetic update missing row');
        Object.assign(row, clone(args.data)); mutations.push({ operation: `${name}.update`, args: clone(args) }); return clone(row);
      },
      async updateMany(args) {
        const injected = before(`${name}.updateMany`, args);
        if (injected !== undefined) return injected;
        let count = 0;
        for (const row of data) if (matches(row, args.where)) { Object.assign(row, clone(args.data)); count++; }
        mutations.push({ operation: `${name}.updateMany`, args: clone(args), count }); return { count };
      },
    };
  }
  const db = { failedPayload: table('failedPayload', rows), shipmentRecord: table('shipmentRecord', records) };
  db.$transaction = async (action, options) => {
    before('$transaction', options);
    const pending = serial.then(() => action({ ...db, async $queryRawUnsafe(sql, key) {
      before('$queryRawUnsafe', { sql, key });
      assert.equal(sql, 'SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext($1))');
      assert.ok(key.startsWith('automatic-order:')); locks.push(key); return [{ locked: 1 }];
    } }));
    serial = pending.catch(() => {}); return await pending;
  };
  const context = createContext({
    process: { env }, console,
    fetch() { deniedNetwork++; throw Error('Real network forbidden'); },
    WebSocket() { deniedNetwork++; throw Error('Real network forbidden'); },
  }, { codeGeneration: { strings: false, wasm: false } });
  function load(name, mocks = {}) {
    const module = { exports: {} };
    const strictRequire = id => {
      if (Object.hasOwn(mocks, id)) return mocks[id];
      deniedImports++; throw Error(`Unexpected import ${id}`);
    };
    new Script(`(function(require,module,exports){${sources.get(name)}\n})`, { filename: `${name}.vm.cjs` })
      .runInContext(context)(strictRequire, module, module.exports);
    return module.exports;
  }
  const policy = load('safeQueuePolicy');
  const safety = load('automaticOperationSafety', {
    'node:async_hooks': { AsyncLocalStorage }, 'node:crypto': { randomUUID: () => `synthetic-token-${++uuid}` },
    '../lib/prisma.js': { basePrisma: db, prisma: db }, './safeQueuePolicy.js': policy,
  });
  return { ...safety, policy, env, rows, records, io, locks, mutations, setFault(fn) { faultHandler = fn; } };
}
const receipt = (source, lanes, externalId = '900001', extra = {}) => ({ source, externalId, reason: 'synthetic-owner-proof', payloadJson: JSON.stringify({ version: 1, lanes, ...extra }) });
const priorClaim = (changes = {}, rowChanges = {}) => {
  const p = { version: 1, recordId: 1, key: 'production:prior', epoch: validEnv.OPS_SAFE_QUEUES_EPOCH,
    fingerprint: null, token: 'old-valid-token', status: 'completed', requestAttempted: true,
    at: '2026-11-01T00:00:00.000Z', completedAt: '2026-11-01T00:01:00.000Z',
    stoppedAt: '2026-11-01T00:01:00.000Z', reason: 'synthetic prior stop', ...changes };
  return { source: claimSource, externalId: '900001', reason: p.key, payloadJson: JSON.stringify(p), ...rowChanges };
};

// Invalid release configuration fails before ANY Prisma call or action.
for (const settings of [
  { OPS_SAFE_QUEUES_EPOCH: '' }, { OPS_SAFE_QUEUES_EPOCH: 'short' }, { OPS_SAFE_QUEUES_EPOCH: '!'.repeat(20) },
  { OPS_SAFE_QUEUES_EPOCH: 'a'.repeat(81) }, { OPS_SAFE_QUEUES_PROOF: '' },
  { OPS_SAFE_QUEUES_PROOF: 'A'.repeat(64) }, { OPS_SAFE_QUEUES_PROOF: 'f'.repeat(63) },
  { SHOPIFY_SHOP_DOMAIN: 'other.myshopify.com' }, { SHOPIFY_SHOP_DOMAIN: '' },
  { ORDER_REFERENCE_PREFIX: 'Loomlac' }, { SHIPMENT_CODE_PREFIX: 'TG' },
  { ODOO_SYNC_ENABLED: 'false' }, { ODOO_SYNC_ENABLED: '' },
]) {
  const f = fixture({ settings }); let actions = 0;
  assert.throws(() => f.policy.safeQueueConfig(), /not configured/);
  assert.equal(f.policy.safeQueueHoldReason(), 'safe-queue-release-invalid');
  assert.equal(f.automaticQueueSafetyActive(), true);
  await assert.rejects(f.withAutomaticOperation(op(), async () => { actions++; }), /not configured/);
  await assert.rejects(f.automaticRecordBlocked(1, 'production'), /not configured/);
  await assert.rejects(f.blockedAutomaticOrderIds('production'), /not configured/);
  await assert.rejects(f.beforeAutomaticOdooWrite('sale.order', 'create'), /not configured/);
  await f.beforeAutomaticShopifyWrite();
  assert.equal(f.io.length, 0); assert.equal(actions, 0); checks++;
}
for (const flag of [undefined, '', 'false', 'FALSE', '1', 'yes']) {
  const f = fixture({ disabled: true, settings: { OPS_SAFE_QUEUES_ENABLED: flag } });
  assert.equal(f.policy.safeQueueConfig(), undefined);
  assert.equal(f.automaticQueueSafetyActive(), false);
  assert.equal(await f.withAutomaticOperation(op(), async () => 'ordinary'), 'ordinary');
  await f.beforeAutomaticOdooWrite('sale.order', 'create');
  await f.beforeAutomaticShopifyWrite();
  assert.equal(await f.automaticRecordBlocked(1, 'production'), false);
  assert.equal(JSON.stringify(await f.blockedAutomaticOrderIds('production')), '[]');
  assert.equal(f.io.length, 0); checks++;
}
for (const settings of [{ OPS_AUTOMATION_HOLD: 'true' }, { PRODUCTION_PREVIEW_ONLY: 'true' }, { OPS_AUTOMATION_HOLD: '  true  ' }]) {
  const f = fixture({ disabled: true, settings });
  assert.equal(f.policy.safeQueueHoldReason(), 'operator-reconciliation-hold');
  assert.equal(f.io.length, 0); checks++;
}
{
  const f = fixture({ settings: { OPS_SAFE_QUEUES_ENABLED: ' TRUE ', ODOO_SYNC_ENABLED: ' TRUE ', OPS_SAFE_QUEUES_EPOCH: 'x'.repeat(16) } });
  assert.equal(f.policy.safeQueueConfig().epoch, 'x'.repeat(16));
  assert.equal(f.policy.safeQueueHoldReason(), undefined);
  check(f.io.length === 0, 'Valid policy is pure');
}

// Owner and completion holds are durable and authoritative, across all lanes.
for (const source of ['ops_record_hold', 'ops_completion_receipt']) for (const lane of lanes) {
  for (const heldLanes of [['*'], [lane]]) {
    const f = fixture({ seedRows: [receipt(source, heldLanes)] }); let actions = 0;
    assert.equal(await f.automaticRecordBlocked(1, lane), true);
    assert.equal(JSON.stringify(await f.blockedAutomaticOrderIds(lane)), '["900001"]');
    await assert.rejects(f.withAutomaticOperation(op(lane), async () => { actions++; }), f.AutomaticOperationReviewError);
    assert.equal(actions, 0); assert.equal(claims(f).length, 0); assert.equal(f.mutations.length, 0); checks++;
  }
}
{
  const f = fixture({ seedRows: [receipt('ops_record_hold', ['return']), receipt('ops_completion_receipt', ['return'])] });
  assert.equal(JSON.stringify(await f.blockedAutomaticOrderIds('return')), '["900001"]');
  assert.equal(await f.automaticRecordBlocked(1, 'collection'), false);
  await f.withAutomaticOperation(op('collection'), async () => 'safe other lane');
  check(payload(claims(f)[0]).status === 'completed', 'Stage-specific holds do not invent all-lane holds');
}
for (const malformed of ['not-json', JSON.stringify({ version: 0, lanes: ['*'] }), JSON.stringify({ version: 1 })]) {
  const f = fixture({ seedRows: [{ source: 'ops_record_hold', externalId: '900001', reason: 'synthetic', payloadJson: malformed }] });
  await assert.rejects(f.withAutomaticOperation(op(), async () => assert.fail('Malformed hold must block action')), /Invalid durable queue hold/);
  assert.equal(f.mutations.length, 0); checks++;
}
for (const source of ['ops_record_hold', 'ops_completion_receipt']) {
  const f = fixture(); let inserted = false;
  f.setFault(operation => {
    if (operation === '$transaction' && !inserted) {
      inserted = true;
      f.rows.push({ id: 700, ...receipt(source, ['*']) });
    }
  });
  await assert.rejects(f.withAutomaticOperation(op(), async () => assert.fail('New hold arrived before locked claim')), f.AutomaticOperationReviewError);
  assert.equal(claims(f).length, 0);
  check(f.mutations.length === 0, 'Owner/completion holds are rechecked under the order lock');
}
{
  const f = fixture({ seedRecords: [] });
  await assert.rejects(f.withAutomaticOperation(op(), async () => assert.fail('Missing record must not execute')), f.AutomaticOperationReviewError);
  check(claims(f).length === 0, 'Missing primary record never creates a claim');
}
for (const id of [undefined, null, '', ' ', '0', '-1', '900001x', 'gid://shopify/Order/900001', 900001, {}, []]) {
  const f = fixture({ seedRecords: [{ id: 1, shopifyOrderId: id }] }); let actions = 0;
  assert.equal(await f.automaticRecordBlocked(1, 'production'), true);
  await assert.rejects(f.withAutomaticOperation(op(), async () => { actions++; }), f.AutomaticOperationReviewError);
  assert.equal(actions, 0); assert.equal(f.mutations.length, 0);
  check(f.io.every(c => c.operation !== '$transaction'), 'Incomplete Shopify identity cannot reach claim transaction');
}
for (const id of [null, undefined, '', 'bad-id']) {
  const f = fixture({ seedRows: [{ ...receipt('ops_record_hold', ['*']), externalId: id }] });
  await assert.rejects(f.blockedAutomaticOrderIds('production'), f.AutomaticOperationReviewError);
  check(f.mutations.length === 0, 'An unidentifiable applicable owner hold is not silently ignored');
}
for (const input of [op('unknown'), op('production', ''), op('production', '  '), op('production', 'stage', 0), op('production', 'stage', '1'), { ...op(), fingerprint: '' }]) {
  const f = fixture();
  await assert.rejects(f.withAutomaticOperation(input, async () => assert.fail('Invalid input cannot execute')), f.AutomaticOperationReviewError);
  check(f.io.length === 0, 'Invalid operation identity fails before I/O');
}
for (const nextId of ['900002', '', null, undefined]) {
  const f = fixture(); let actions = 0;
  f.setFault(operation => { if (operation === '$transaction') f.records[0].shopifyOrderId = nextId; });
  await assert.rejects(f.withAutomaticOperation(op(), async () => { actions++; }), /identity changed before claim/);
  assert.equal(actions, 0); assert.equal(claims(f).length, 0);
  check(f.locks[0] === 'automatic-order:900001', 'Locked identity is never substituted by a later record read');
}
for (const phase of ['after-claim', 'before-write', 'before-finalization']) {
  const f = fixture(); let actions = 0, sent = 0;
  if (phase === 'after-claim') f.setFault((operation, args) => {
    if (operation === 'failedPayload.create' && args.data.source === claimSource) f.records[0].shopifyOrderId = '900099';
  });
  await assert.rejects(f.withAutomaticOperation(op(), async () => {
    actions++;
    if (phase === 'before-write') f.records[0].shopifyOrderId = '900099';
    await f.beforeAutomaticOdooWrite('sale.order', 'create'); sent++;
    if (phase === 'before-finalization') f.records[0].shopifyOrderId = '900099';
  }), f.AutomaticOperationReviewError);
  assert.equal(actions, phase === 'after-claim' ? 0 : 1);
  assert.equal(sent, phase === 'before-finalization' ? 1 : 0);
  assert.equal(f.records[0].odooSyncStatus, 'odoo-so-pending', 'Review cannot overwrite remapped primary record');
  assert.equal(holds(f)[0].externalId, '900001', 'Review evidence stays bound to original order');
  assert.ok(!f.mutations.some(c => c.operation === 'shipmentRecord.updateMany' && c.count > 0));
  checks++;
}

// Valid JSON is insufficient: old/partial/unknown claims must block, even if
// they claim to be completed under a DIFFERENT key.
const malformedClaims = [
  'not-json', 'null', '[]', 'true', '{}',
  ...[{ version: 0 }, { version: 2 }, { status: 'future-state' }, { status: null },
    { recordId: 0 }, { recordId: '1' }, { recordId: null }, { token: '' }, { token: null },
    { epoch: 'short' }, { epoch: null }, { key: '' }, { key: 'unknown:prior' }, { key: 'production:' },
    { key: 123 }, { requestAttempted: 'true' }, { requestAttempted: null },
    { status: 'started', requestAttempted: false }, { status: 'claimed', requestAttempted: true },
    { status: 'no-external-attempt', requestAttempted: true }, { fingerprint: {} }, { at: 'not-a-date' },
    { completedAt: null }, { completedAt: 'invalid' },
    { status: 'no-external-attempt', requestAttempted: false, stoppedAt: null },
    { status: 'needs-review', stoppedAt: '' }, { status: 'needs-review', reason: '' }]
    .map(change => priorClaim(change).payloadJson),
  ...['version', 'recordId', 'key', 'epoch', 'token', 'status', 'requestAttempted', 'fingerprint', 'at'].map(field => {
    const p = payload(priorClaim()); delete p[field]; return JSON.stringify(p);
  }),
];
for (const payloadJson of malformedClaims) {
  const row = priorClaim({}, { payloadJson }), f = fixture({ seedRows: [row] });
  await assert.rejects(f.withAutomaticOperation(op('collection', 'new-key'), async () => assert.fail('Malformed prior claim cannot authorize action')), f.AutomaticOperationReviewError);
  assert.equal(claims(f).length, 1); assert.equal(claims(f)[0].payloadJson, payloadJson);
  check(f.mutations.length === 0, 'Malformed prior claim is preserved unchanged');
}
{
  const f = fixture({ seedRows: [priorClaim({}, { reason: 'different-key' })] });
  await assert.rejects(f.withAutomaticOperation(op(), async () => assert.fail('Claim metadata mismatch')), f.AutomaticOperationReviewError);
  check(f.mutations.length === 0, 'Prior claim reason/key mismatch fails closed');
}
for (const status of ['claimed', 'started', 'needs-review']) {
  const f = fixture({ seedRows: [priorClaim({ status, requestAttempted: status !== 'claimed' })] });
  await assert.rejects(f.withAutomaticOperation(op('return', 'different-key'), async () => assert.fail('Unfinished claim cannot expire')), f.AutomaticOperationReviewError);
  check(f.mutations.length === 0, 'Unfinished previous claims block cross-lane work');
}
{
  const f = fixture({ seedRows: [priorClaim({ status: 'no-external-attempt', requestAttempted: false })] });
  await f.withAutomaticOperation(op('production', 'prior'), async () => 'safe fresh attempt');
  check(claims(f).length === 2, 'Only proven no-external-attempt old claims may be reclaimed');
}

// A second human/operator or destination cannot enter while one order is in flight.
for (const secondLane of lanes) {
  const f = fixture(), started = deferred(), release = deferred(); let actions = 0;
  const actors = new AsyncLocalStorage();
  const first = actors.run('Ahmed', () => f.withAutomaticOperation(op('production', 'stage-one'), async () => {
    assert.equal(actors.getStore(), 'Ahmed'); actions++; started.resolve(); await release.promise; return 'first';
  }));
  await started.promise;
  await assert.rejects(actors.run('Ayman', () => f.withAutomaticOperation(op(secondLane, 'another-key'), async () => { actions++; })), /Existing completed or uncertain/);
  assert.equal(actions, 1); assert.equal(claims(f).length, 1);
  release.resolve(); assert.equal(await first, 'first');
  assert.ok(f.locks.every(k => k === 'automatic-order:900001'));
  check(f.automaticOperationContext() === undefined, 'ALS context does not leak into caller');
}
{
  const f = fixture(), one = deferred(), two = deferred(), release = deferred();
  const first = f.withAutomaticOperation(op('production', 'one', 1), async () => { one.resolve(); await release.promise; });
  const second = f.withAutomaticOperation(op('collection', 'two', 2), async () => { two.resolve(); await release.promise; });
  await Promise.all([one.promise, two.promise]);
  assert.equal(claims(f).length, 2); release.resolve(); await Promise.all([first, second]);
  check(f.locks.includes('automatic-order:900001') && f.locks.includes('automatic-order:900002'), 'Different orders may proceed independently');
}

// Real pre-write code must CAS durable first-write intent once, before caller writes.
for (const lane of lanes) {
  const f = fixture(); let writes = 0;
  const value = await f.withAutomaticOperation(op(lane), async () => {
    assert.equal(JSON.stringify(f.automaticOperationContext()), JSON.stringify({ recordId: 1, shopifyOrderId: '900001', lane }));
    assert.equal(payload(claims(f)[0]).status, 'claimed');
    await Promise.all([f.beforeAutomaticOdooWrite('sale.order', 'create'), f.beforeAutomaticShopifyWrite()]);
    assert.equal(payload(claims(f)[0]).status, 'started');
    assert.equal(payload(claims(f)[0]).requestAttempted, true); writes++;
    await f.beforeAutomaticOdooWrite('account.move', 'action_post'); writes++;
    return 'stage-result';
  });
  assert.equal(value, 'stage-result'); assert.equal(writes, 2);
  const cas = f.io.filter(c => c.operation === 'failedPayload.updateMany' && JSON.parse(c.args.data.payloadJson).status === 'started');
  assert.equal(cas.length, 1); assert.equal(cas[0].args.where.id, claims(f)[0].id);
  assert.equal(JSON.parse(cas[0].args.where.payloadJson).status, 'claimed');
  assert.equal(JSON.parse(cas[0].args.data.payloadJson).requestAttempted, true);
  assert.equal(payload(claims(f)[0]).status, 'completed');
  assert.equal(payload(claims(f)[0]).requestAttempted, true); assert.equal(holds(f).length, 0); checks++;
}
for (const mode of ['lost-cas', 'replaced-token', 'missing-intent']) {
  const f = fixture(); let writes = 0;
  await assert.rejects(f.withAutomaticOperation(op(), async () => {
    if (mode === 'lost-cas') f.setFault(operation => operation === 'failedPayload.updateMany' ? { count: 0 } : undefined);
    if (mode === 'replaced-token') { const p = payload(claims(f)[0]); p.token = 'other-actor'; claims(f)[0].payloadJson = JSON.stringify(p); }
    if (mode === 'missing-intent') f.rows.splice(f.rows.indexOf(claims(f)[0]), 1);
    await f.beforeAutomaticOdooWrite('sale.order', 'create'); writes++;
  }), f.AutomaticOperationReviewError);
  assert.equal(writes, 0); assert.equal(holds(f).length, 1); checks++;
}
await regression('CAS-loss cleanup preserves competing sent intent', async () => {
  const f = fixture(); let writes = 0, competingIntent;
  await assert.rejects(f.withAutomaticOperation(op(), async () => {
    f.setFault((operation, args) => {
      if (operation !== 'failedPayload.updateMany') return;
      const row = claims(f)[0];
      competingIntent = JSON.stringify({ ...payload(row), token: 'competing-token', status: 'started', requestAttempted: true });
      row.payloadJson = competingIntent;
      return { count: 0 };
    });
    await f.beforeAutomaticOdooWrite('sale.order', 'create'); writes++;
  }), f.AutomaticOperationReviewError);
  assert.equal(writes, 0);
  assert.equal(claims(f)[0].payloadJson, competingIntent, 'CAS-loss cleanup must NEVER replace a competing started intent with no-external-attempt');
  f.setFault(undefined);
  await assert.rejects(f.withAutomaticOperation(op('collection', 'another-key'), async () => assert.fail('Competing started intent cannot release the order')), f.AutomaticOperationReviewError);
});
await regression('Successful finalization cannot overwrite competing intent', async () => {
  const f = fixture(); let competingIntent;
  await assert.rejects(f.withAutomaticOperation(op(), async () => {
    await f.beforeAutomaticOdooWrite('sale.order', 'create');
    const row = claims(f)[0];
    competingIntent = JSON.stringify({ ...payload(row), token: 'competing-token', status: 'started', requestAttempted: true });
    row.payloadJson = competingIntent;
    return 'must not finish another actor claim';
  }), f.AutomaticOperationReviewError);
  assert.equal(claims(f)[0].payloadJson, competingIntent);
});
await regression('Completed ALS context cannot send a late descendant write', async () => {
  const f = fixture(), release = deferred(); let escaped, sent = 0;
  await f.withAutomaticOperation(op(), async () => {
    await f.beforeAutomaticOdooWrite('sale.order', 'create'); sent++;
    escaped = (async () => {
      await release.promise;
      await f.beforeAutomaticOdooWrite('account.move', 'create'); sent++;
    })();
  });
  assert.equal(payload(claims(f)[0]).status, 'completed');
  release.resolve();
  await assert.rejects(escaped, f.AutomaticOperationReviewError);
  assert.equal(sent, 1);
});
{
  const f = fixture(); let writes = 0;
  await assert.rejects(f.withAutomaticOperation(op(), async () => {
    f.env.OPS_SAFE_QUEUES_EPOCH = 'changed-valid-release-epoch';
    await f.beforeAutomaticOdooWrite('sale.order', 'create'); writes++;
  }), /epoch changed/);
  assert.equal(writes, 0); check(payload(claims(f)[0]).requestAttempted === false, 'Changed epoch cannot send a mutation');
}

// Simulate native service swallowing BOTH unknown write and blocked fallback.
for (const lane of lanes) {
  const f = fixture(); let sent = 0;
  await assert.rejects(f.withAutomaticOperation(op(lane), async () => {
    try { await f.beforeAutomaticOdooWrite('sale.advance.payment.inv', 'create'); sent++; f.haltAutomaticOperation('ODOO_WRITE_OUTCOME_UNKNOWN'); throw Error('Synthetic uncertain sent response'); } catch {}
    try { await f.beforeAutomaticOdooWrite('account.move', 'create'); sent++; } catch {}
    try { await f.beforeAutomaticShopifyWrite(); sent++; } catch {}
    return 'swallowed-success';
  }), f.AutomaticOperationReviewError);
  assert.equal(sent, 1); assert.equal(payload(claims(f)[0]).status, 'needs-review');
  assert.equal(payload(claims(f)[0]).requestAttempted, true);
  assert.equal(holds(f).length, 1); assert.equal(JSON.stringify(payload(holds(f)[0]).lanes), '["*"]');
  for (const target of lanes) assert.equal(await f.automaticRecordBlocked(1, target), true);
  const statusField = lane === 'return' ? 'returnSyncStatus' : lane === 'collection' ? 'odooCollectionSyncStatus' : lane === 'shopify' ? 'shopifyPaymentSyncStatus' : 'odooSyncStatus';
  assert.equal(f.records[0][statusField], 'needs-review'); checks++;
}
{
  const f = fixture();
  await f.withAutomaticOperation(op('production', 'stock-ready'), async () => { await f.beforeAutomaticOdooWrite('stock.picking', 'button_validate'); });
  await f.withAutomaticOperation(op('production', 'delivery-ready'), async () => { await f.beforeAutomaticOdooWrite('stock.picking', 'button_validate'); });
  await f.withAutomaticOperation(op('collection', 'settlement-one'), async () => { await f.beforeAutomaticOdooWrite('account.payment.register', 'action_create_payments'); });
  assert.equal(claims(f).length, 3);
  await assert.rejects(f.withAutomaticOperation(op('production', 'stock-ready'), async () => assert.fail('Completed key replay')), /Existing completed or uncertain/);
  check(claims(f).length === 3, 'Successful distinct stages allowed; completed exact key cannot replay');
}

// No-external failures retain audit rows, while any sent write conservatively holds.
for (const message of ['Synthetic preflight rejection', 'compute time quota is exceeded']) {
  const f = fixture(), failure = new Error(message);
  await assert.rejects(f.withAutomaticOperation(op(), async () => { throw failure; }), error => error === failure);
  assert.equal(claims(f).length, 1); assert.equal(payload(claims(f)[0]).status, 'no-external-attempt');
  assert.equal(payload(claims(f)[0]).requestAttempted, false); assert.equal(holds(f).length, 0);
  await f.withAutomaticOperation(op(), async () => 'safe fresh no-write attempt');
  check(claims(f).length === 2, 'Proven no-external failure is retained, not deleted');
}
for (const phase of ['first-write-cas', 'completion']) {
  const f = fixture(), quota = new Error('compute time quota is exceeded'); let sent = 0;
  await assert.rejects(f.withAutomaticOperation(op(), async () => {
    f.setFault((operation, args) => {
      if (operation === 'failedPayload.updateMany' && (phase === 'first-write-cas' || JSON.parse(args.data.payloadJson).status !== 'started')) throw quota;
    });
    await f.beforeAutomaticOdooWrite('sale.order', 'create'); sent++;
    return 'done';
  }));
  assert.equal(sent, phase === 'completion' ? 1 : 0);
  assert.equal(claims(f).length, 1);
  assert.equal(payload(claims(f)[0]).status, phase === 'completion' ? 'started' : 'claimed');
  f.setFault(undefined);
  await assert.rejects(f.withAutomaticOperation(op('return', 'cross-lane'), async () => assert.fail('Uncertain durable intent must remain held')), f.AutomaticOperationReviewError);
  check(claims(f).length === 1, 'Quota cleanup failure never frees durable claim');
}
{
  const f = fixture();
  await assert.rejects(f.withAutomaticOperation(op(), async () => {
    await f.beforeAutomaticOdooWrite('sale.order', 'create'); throw Error('compute time quota is exceeded');
  }), f.AutomaticOperationReviewError);
  check(payload(claims(f)[0]).status === 'needs-review' && holds(f).length === 1, 'Quota after sent-intent cannot be retried');
}
{
  const f = fixture();
  await assert.rejects(f.beforeAutomaticOdooWrite('sale.order', 'create'), f.AutomaticOperationReviewError);
  assert.equal(f.io.length, 0);
  await f.beforeAutomaticShopifyWrite();
  f.haltAutomaticOperation('contextless');
  check(f.io.length === 0 && f.automaticOperationContext() === undefined, 'Unrelated contextless manual Shopify path is not intercepted');
}
for (const phase of ['failure', 'disabled-after-completion']) {
  const f = fixture(), release = deferred(); let escaped, sent = 0;
  const execute = f.withAutomaticOperation(op(), async () => {
    await f.beforeAutomaticOdooWrite('sale.order', 'create'); sent++;
    escaped = (async () => {
      await release.promise;
      assert.equal(f.automaticOperationContext(), undefined);
      await assert.rejects(f.beforeAutomaticOdooWrite('account.move', 'create'), f.AutomaticOperationReviewError);
      await assert.rejects(f.beforeAutomaticShopifyWrite(), f.AutomaticOperationReviewError);
      await assert.rejects(f.withAutomaticOperation(op('return', 'late'), async () => { sent++; }), f.AutomaticOperationReviewError);
    })();
    if (phase === 'failure') throw Error('Synthetic error after first mutation');
  });
  if (phase === 'failure') await assert.rejects(execute, f.AutomaticOperationReviewError); else await execute;
  if (phase === 'disabled-after-completion') f.env.OPS_SAFE_QUEUES_ENABLED = 'false';
  release.resolve(); await escaped;
  check(sent === 1, 'Closed context fences both providers and nested operations, even after flag changes');
}
{
  const f = fixture(); let sent = 0, replaced;
  await assert.rejects(f.withAutomaticOperation(op(), async () => {
    await f.beforeAutomaticOdooWrite('sale.order', 'create'); sent++;
    const row = claims(f)[0];
    replaced = JSON.stringify({ ...payload(row), token: 'different-token' }); row.payloadJson = replaced;
    await f.beforeAutomaticOdooWrite('account.move', 'create'); sent++;
  }), f.AutomaticOperationReviewError);
  assert.equal(claims(f)[0].payloadJson, replaced);
  check(sent === 1, 'Cached first-write promise never substitutes for current claim ownership');
}
for (const lane of lanes) {
  const field = lane === 'return' ? 'returnSyncStatus' : lane === 'collection' ? 'odooCollectionSyncStatus'
    : lane === 'shopify' ? 'shopifyPaymentSyncStatus' : 'odooSyncStatus';
  const f = fixture(); f.records[0][field] = field === 'odooSyncStatus' ? 'paid-existing' : 'completed';
  f.records[0].odooSalePaymentId = 24515;
  const original = clone(f.records[0]);
  await assert.rejects(f.withAutomaticOperation(op(lane), async () => {
    await f.beforeAutomaticOdooWrite('account.move', 'action_post');
    f.haltAutomaticOperation('ODOO_WRITE_OUTCOME_UNKNOWN');
  }), f.AutomaticOperationReviewError);
  assert.deepEqual(f.records[0], original);
  check(holds(f).length === 1, 'Durable uncertainty hold does not erase already-completed lane metadata');
}

assert.equal(deniedImports, 0); assert.equal(deniedNetwork, 0);
console.log(JSON.stringify({ ok: findings.length === 0, checks: checks + findings.length, passed: checks, findings, deniedImports, deniedNetwork, realDatabaseConnections: 0, realNetworkCalls: 0, realQueuePublications: 0, realBusinessWrites: 0, filesWritten: 0 }));
if (findings.length) process.exitCode = 1;
