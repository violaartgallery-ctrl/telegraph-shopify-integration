/** Actual scheduler/policy source in a strict VM with fake primary and queue.
 * No dotenv, provider/DB/queue packages, real messages or generated files. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script, createContext } from 'node:vm';
for (const key of Object.keys(process.env)) delete process.env[key];
const require = createRequire(import.meta.url), ts = require('typescript');
const sources = new Map(['opsScheduler', 'safeQueuePolicy'].map(name => {
  const source = readFileSync(new URL(`../services/${name}.ts`, import.meta.url), 'utf8');
  const result = ts.transpileModule(source, { fileName: name + '.ts', reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  assert.equal((result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  return [name, result.outputText];
}));
const EPOCH = 'synthetic-scheduler-epoch-20261101', PROOF = 'c'.repeat(64), DEPLOYMENT = 'dpl_synthetic_current';
const SETTINGS = { OPS_SAFE_QUEUES_ENABLED: 'true', OPS_SAFE_QUEUES_EPOCH: EPOCH, OPS_SAFE_QUEUES_PROOF: PROOF,
  SHOPIFY_SHOP_DOMAIN: 'violaleather.myshopify.com', ORDER_REFERENCE_PREFIX: 'Viola', SHIPMENT_CODE_PREFIX: 'VI',
  ODOO_SYNC_ENABLED: 'true', OPS_AUTOMATION_HOLD: 'true', PRODUCTION_PREVIEW_ONLY: 'true',
  VERCEL_DEPLOYMENT_ID: DEPLOYMENT, VERCEL_ENV: 'production' };
const CONTROL = { version: 1, paused: false, epoch: EPOCH, proof: PROOF, deploymentId: DEPLOYMENT };
const LANES = ['status', 'discovery', 'financial'], NOW = 1_800_000_000_000;
let passed = 0, deniedImports = 0, deniedNetwork = 0;
const findings = [];
async function test(name, action) { try { await action(); passed++; } catch (error) { findings.push({ name, message: error.message.split('\n')[0] }); } }
const clone = value => structuredClone(value);

function fixture({ settings = {}, control = CONTROL, raw, fault, stateRead } = {}) {
  const env = { ...SETTINGS, ...settings }, rows = [], published = [], runs = [], io = [], changes = [], locks = [];
  let nextId = 1, time = NOW, token = 0;
  if (control !== null || raw !== undefined) rows.push({ id: nextId++, source: 'ops_scheduler_release', reason: 'active', payloadJson: raw ?? JSON.stringify(control) });
  for (const lane of LANES) rows.push({ id: nextId++, source: 'ops_scheduler', reason: lane, payloadJson: JSON.stringify({ completedSlot: Number.MAX_SAFE_INTEGER, marker: 'legacy-tombstone' }) });
  const same = (row, where) => Object.entries(where).every(([k, v]) => row[k] === v);
  const table = {
    async findFirst(args) {
      io.push(clone(args.where));
      fault?.(args.where);
      const row = rows.find(r => same(r, args.where));
      const result = row ? clone(row) : null;
      if (args.where.source === 'ops_scheduler') stateRead?.(args.where, api);
      return result;
    },
    async update({ where, data }) {
      const row = rows.find(r => same(r, where)); assert.ok(row, 'Synthetic update has exact row');
      Object.assign(row, clone(data)); changes.push({ id: row.id, reason: row.reason }); return clone(row);
    },
    async create({ data }) { const row = { id: nextId++, ...clone(data) }; rows.push(row); changes.push({ id: row.id, reason: row.reason }); return clone(row); },
  };
  const db = { failedPayload: table, async $transaction(action) {
    return await action({ failedPayload: table, async $queryRawUnsafe(sql, key) {
      assert.equal(sql, 'SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext($1))'); locks.push(key); return [{ locked: 1 }];
    } });
  } };
  const context = createContext({ process: { env }, Buffer, console,
    fetch() { deniedNetwork++; throw Error('Real network forbidden'); },
    WebSocket() { deniedNetwork++; throw Error('Real network forbidden'); },
  }, { codeGeneration: { strings: false, wasm: false } });
  function load(name, mocks) {
    const module = { exports: {} };
    new Script(`(function(require,module,exports){${sources.get(name)}\n})`, { filename: name + '.vm.cjs' })
      .runInContext(context)(id => { if (Object.hasOwn(mocks, id)) return mocks[id]; deniedImports++; throw Error('Unexpected import ' + id); }, module, module.exports);
    return module.exports;
  }
  const policy = load('safeQueuePolicy', {});
  const stage = name => async () => { runs.push(name); return { synthetic: true }; };
  const schedulerModule = load('opsScheduler', {
    'node:crypto': { randomUUID: () => 'synthetic-lease-' + ++token, timingSafeEqual: (a, b) => a.equals(b) },
    './automationSafety.js': { isDatabaseQuotaError: error => /quota/i.test(error?.message ?? JSON.stringify(error)) },
    './safeQueuePolicy.js': policy, '../lib/prisma.js': { basePrisma: db, prisma: db },
    '../app.js': { createAppServices: () => ({ shipmentStatusSyncService: { syncOpenShipments: stage('status') },
      metaDeliveryService: { processPending() { throw Error('Narrow release must not drain Meta'); } }, locationCatalogService: {} }) },
    '@vercel/queue': { async send() { throw Error('Default queue publisher forbidden in this suite'); } },
  });
  const scheduler = schedulerModule.createPersistentOpsScheduler({ enabled: () => true, now: () => time,
    schedule: schedulerModule.fixedIntervalSchedule(schedulerModule.OPS_INTERVALS),
    async publish(tick, options) { published.push(clone({ tick, options })); return { synthetic: true }; },
  });
  const api = { ...schedulerModule, scheduler, env, rows, io, published, runs, changes, locks,
    setTime(value) { time = value; },
    setControl(value) { const row = rows.find(r => r.source === 'ops_scheduler_release' && r.reason === 'active'); assert.ok(row); row.payloadJson = JSON.stringify(value); },
    plain() { return clone(rows.filter(r => r.source === 'ops_scheduler' && LANES.includes(r.reason))); },
  };
  return api;
}
const tick = (lane = 'status', slot = NOW) => ({ version: 1, lane, slot });
const noWork = f => {
  assert.equal(f.published.length, 0); assert.equal(f.runs.length, 0); assert.equal(f.changes.length, 0);
  assert.equal(f.io.filter(w => w.source === 'ops_scheduler').length, 0);
};

for (const [name, control, raw] of [
  ['missing', null], ['paused', { ...CONTROL, paused: true }], ['wrong epoch', { ...CONTROL, epoch: 'old-synthetic-epoch' }],
  ['wrong proof', { ...CONTROL, proof: 'd'.repeat(64) }], ['wrong deployment', { ...CONTROL, deploymentId: 'dpl_old' }],
  ['wrong version', { ...CONTROL, version: 0 }], ['malformed JSON', CONTROL, '{bad'],
  ['null payload', CONTROL, 'null'], ['array payload', CONTROL, '[]'],
  ...['epoch', 'proof', 'deploymentId', 'version', 'paused'].map(field => { const p = { ...CONTROL }; delete p[field]; return ['missing ' + field, p]; }),
  ...[null, 0, '', 'false', 'true', 1].map(paused => ['invalid paused ' + JSON.stringify(paused), { ...CONTROL, paused }]),
]) await test(`Inactive controller ${name} cannot read lane state, publish or run`, async () => {
  const f = fixture({ control, raw });
  assert.equal(await f.schedulerReleaseIsActive(), false);
  const health = await f.scheduler.health(); assert.equal(health.enabled, false);
  const ensured = await f.scheduler.ensure(); assert.equal(ensured.enabled, false); assert.equal(ensured.fallbackAllowed, false);
  assert.equal((await f.scheduler.tick(tick())).skipped, 'inactive-scheduler-release'); noWork(f);
});
for (const deployment of [undefined, '']) await test(`Missing deployment identity ${String(deployment)} cannot activate`, async () => {
  const f = fixture({ settings: { VERCEL_DEPLOYMENT_ID: deployment } });
  assert.equal(await f.schedulerReleaseIsActive(), false); assert.equal((await f.scheduler.ensure()).enabled, false);
  assert.equal((await f.scheduler.tick(tick())).skipped, 'inactive-scheduler-release'); noWork(f);
  assert.equal(f.io.length, 0);
});
for (const settings of [{ OPS_SAFE_QUEUES_EPOCH: '' }, { OPS_SAFE_QUEUES_PROOF: 'bad' }, { ODOO_SYNC_ENABLED: 'false' }]) {
  await test('Invalid safe policy has no primary/recurrence fallback', async () => {
    const f = fixture({ settings });
    const result = await f.scheduler.ensure(); assert.equal(result.enabled, false); assert.equal(result.fallbackAllowed, false);
    assert.equal((await f.scheduler.health()).enabled, false);
    assert.equal((await f.scheduler.tick(tick())).skipped, 'safe-queue-release-invalid'); noWork(f); assert.equal(f.io.length, 0);
  });
}
await test('Disabled safe capability never inherits live permission past the global hold', async () => {
  const f = fixture({ settings: { OPS_SAFE_QUEUES_ENABLED: 'false' } });
  assert.equal((await f.scheduler.ensure()).enabled, false);
  assert.equal((await f.scheduler.tick(tick())).skipped, 'operator-reconciliation-hold'); noWork(f); assert.equal(f.io.length, 0);
});
await test('Only exact current epoch/proof/deployment activates', async () => {
  const f = fixture(); assert.equal(await f.schedulerReleaseIsActive(), true);
  assert.equal((await f.scheduler.health()).enabled, true);
  assert.equal(f.published.length, 0); assert.equal(f.runs.length, 0);
  assert.ok(f.io.some(w => w.source === 'ops_scheduler_release' && w.reason === 'active'));
});
await test('Ensure uses namespaced state/idempotency and preserves old plain tombstones', async () => {
  const f = fixture(), plain = f.plain(); const result = await f.scheduler.ensure();
  assert.equal(result.enabled, true); assert.equal(result.fallbackAllowed, false); assert.equal(f.published.length, 3);
  for (const lane of LANES) {
    assert.equal(f.schedulerStateReason(lane), `${lane}@${EPOCH}`);
    assert.ok(f.rows.some(r => r.source === 'ops_scheduler' && r.reason === `${lane}@${EPOCH}`));
    assert.ok(f.published.some(p => p.options.idempotencyKey === `ops_${EPOCH}_${lane}_${NOW}`));
    assert.ok(f.locks.includes(`viola_ops_scheduler_${lane}@${EPOCH}`));
  }
  assert.deepEqual(f.plain(), plain); assert.equal(f.runs.length, 0);
});
await test('Tick claims/runs only the current namespace, not old plain or older epoch rows', async () => {
  const f = fixture(), plain = f.plain();
  const old = { id: 900, source: 'ops_scheduler', reason: 'status@old-synthetic-epoch', payloadJson: '{"completedSlot":9007199254740991}' };
  f.rows.push(clone(old)); await f.scheduler.tick(tick());
  assert.deepEqual(f.runs, ['status']); assert.equal(f.published.length, 1);
  assert.ok(f.published[0].options.idempotencyKey.startsWith(`ops_${EPOCH}_status_`));
  assert.equal(JSON.parse(f.rows.find(r => r.reason === `status@${EPOCH}`).payloadJson).completedSlot, NOW);
  assert.deepEqual(f.plain(), plain); assert.deepEqual(f.rows.find(r => r.id === 900), old);
});
for (const replacement of [{ ...CONTROL, paused: true }, { ...CONTROL, deploymentId: 'dpl_replacement' }, { ...CONTROL, epoch: 'replacement-scheduler-epoch' }]) {
  await test('Controller cutover stops an old self-recurring loop on its next tick', async () => {
    const f = fixture(); await f.scheduler.tick(tick());
    const before = [f.published.length, f.runs.length, f.changes.length];
    f.setControl(replacement); f.setTime(NOW + 600_000);
    assert.equal((await f.scheduler.tick(tick('status', NOW + 600_000))).skipped, 'inactive-scheduler-release');
    assert.deepEqual([f.published.length, f.runs.length, f.changes.length], before);
  });
}
for (const method of ['ensure', 'health', 'tick']) await test(`Quota during ${method} active check never schedules recurrence`, async () => {
  const quota = Error('Synthetic database quota exhausted');
  const f = fixture({ fault: where => { if (where.source === 'ops_scheduler_release') throw quota; } });
  if (method === 'ensure') { const result = await f.scheduler.ensure(); assert.equal(result.reason, 'database-quota-exhausted'); assert.equal(result.fallbackAllowed, false); }
  else await assert.rejects(method === 'health' ? f.scheduler.health() : f.scheduler.tick(tick()), error => error === quota);
  noWork(f);
});

// Cutover races must not enqueue another producer-pinned message or start old
// work after an await returned control to a newer/paused deployment.
await test('Cutover during ensure health reads stops before publishing', async () => {
  let flipped = false;
  const f = fixture({ stateRead(_where, api) { if (!flipped) { flipped = true; api.setControl({ ...CONTROL, paused: true }); } } });
  await f.scheduler.ensure(); assert.equal(f.published.length, 0); assert.equal(f.runs.length, 0);
});
await test('Cutover after tick lease acquisition stops before recurrence or run', async () => {
  const f = fixture();
  const active = f.schedulerReleaseIsActive;
  let states = {}, published = 0, ran = 0;
  const scheduler = new f.OpsScheduler({ now: () => NOW, enabled: () => true, active,
    read: async lane => states[lane] ?? {},
    mutate: async (lane, change) => { const result = change(states[lane] ?? {}); states[lane] = result.state; f.setControl({ ...CONTROL, paused: true }); return result.result; },
    publish: async () => { published++; }, run: async () => { ran++; },
  });
  await scheduler.tick(tick()); assert.equal(published, 0); assert.equal(ran, 0);
});

assert.equal(deniedImports, 0); assert.equal(deniedNetwork, 0);
console.log(JSON.stringify({ ok: findings.length === 0, checks: passed + findings.length, passed, findings, deniedImports, deniedNetwork,
  realNetworkCalls: 0, realDatabaseConnections: 0, realQueuePublications: 0, realPreviewRun: 0, realBusinessWrites: 0, filesWritten: 0 }));
if (findings.length) process.exitCode = 1;
