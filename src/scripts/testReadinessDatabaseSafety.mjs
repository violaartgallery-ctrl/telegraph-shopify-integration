/**
 * Run: node src/scripts/testReadinessDatabaseSafety.mjs
 * Compiles the selected TypeScript sources in memory, never imports the real
 * Prisma client/app/queue, and never loads dotenv. No files are generated.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createContext, Script } from 'node:vm';

// Remove inherited production settings in THIS test process before loading any
// package. The sandbox also receives a separate, empty environment.
for (const key of Object.keys(process.env)) delete process.env[key];
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = new URL('../../', import.meta.url);
const sources = new Map();
for (const path of [
  'src/lib/prisma.ts',
  'src/services/automationSafety.ts',
  'src/services/safeQueuePolicy.ts',
  'src/services/opsScheduler.ts',
]) sources.set(path, readFileSync(new URL(path, root), 'utf8'));

let checks = 0;
let deniedNetworkCalls = 0;
let deniedDatabaseCalls = 0;
let deniedImports = 0;
const denyNetwork = () => { deniedNetworkCalls++; throw new Error('Network denied by readiness test'); };
const denyDatabase = () => { deniedDatabaseCalls++; throw new Error('Real database denied by readiness test'); };

function sandbox() {
  const delays = [];
  const context = createContext({
    Buffer, URL, Intl, console,
    process: { env: Object.create(null) },
    fetch: denyNetwork,
    WebSocket: denyNetwork,
    setTimeout: (callback, delay) => { delays.push(delay); callback(); },
    clearTimeout: () => {},
  }, { codeGeneration: { strings: false, wasm: false } });
  function load(path, mocks = {}, suffix = '') {
    assert.ok(sources.has(path), `Source must be explicitly allowlisted: ${path}`);
    const output = ts.transpileModule(sources.get(path) + suffix, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      fileName: path,
      reportDiagnostics: true,
    });
    const errors = (output.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
    assert.equal(errors.length, 0, `TypeScript syntax diagnostics in ${path}`);
    const module = { exports: {} };
    const restrictedRequire = (id) => {
      if (Object.hasOwn(mocks, id)) return mocks[id];
      if (id === 'node:crypto') return require(id);
      deniedImports++;
      throw new Error(`Import denied by readiness test: ${id}`);
    };
    new Script(`(function(require,module,exports){${output.outputText}\n})`, {
      filename: fileURLToPath(new URL(path, root)),
    }).runInContext(context)(restrictedRequire, module, module.exports);
    return module.exports;
  }
  return { context, delays, load };
}

class KnownRequestError extends Error {
  constructor(code) { super(`Synthetic connection failure ${code}`); this.code = code; }
}
class InitializationError extends Error {}

const database = sandbox();
const safety = database.load('src/services/automationSafety.ts');
let clientConstructions = 0;
class MockPrismaClient {
  constructor() { clientConstructions++; }
  $connect = denyDatabase;
  $transaction = denyDatabase;
  $queryRaw = denyDatabase;
  $executeRaw = denyDatabase;
  $extends(extension) { return extension; }
}
const { prisma } = database.load('src/lib/prisma.ts', {
  '@prisma/client': {
    PrismaClient: MockPrismaClient,
    Prisma: {
      PrismaClientKnownRequestError: KnownRequestError,
      PrismaClientInitializationError: InitializationError,
    },
  },
  '../services/automationSafety.js': safety,
});
assert.equal(clientConstructions, 1);
const execute = prisma.query.$allOperations;
const transientErrors = [
  ...['P1001', 'P1002', 'P1008', 'P1017', 'P2024'].map((code) => new KnownRequestError(code)),
  new InitializationError('Synthetic cold start'),
  new Error('ECONNRESET'),
];
const reads = [
  'findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow',
  'findMany', 'count', 'aggregate', 'groupBy',
];
for (const operation of reads) {
  for (const error of transientErrors) {
    let calls = 0;
    const args = { synthetic: true };
    const before = database.delays.length;
    const value = await execute({ model: 'SyntheticRecord', operation, args, query: async (received) => {
      assert.equal(received, args);
      if (++calls === 1) throw error;
      return 'read recovered';
    } });
    assert.equal(value, 'read recovered');
    assert.equal(calls, 2);
    assert.deepEqual(database.delays.slice(before), [250]);
    checks++;
  }
}

// A simulated write commits, then loses its response. Neither the operation
// name nor a transient error is evidence that issuing it again would be safe.
const writesAndUnknown = [
  'create', 'createMany', 'createManyAndReturn', 'update', 'updateMany',
  'updateManyAndReturn', 'upsert', 'delete', 'deleteMany',
  '$executeRaw', '$executeRawUnsafe', '$queryRaw', '$queryRawUnsafe',
  '$runCommandRaw', 'findRaw', 'aggregateRaw', 'futureOperation', '',
];
for (const operation of writesAndUnknown) {
  for (const error of transientErrors) {
    let commits = 0;
    const before = database.delays.length;
    await assert.rejects(execute({ model: 'SyntheticRecord', operation, args: {}, query: async () => {
      commits++;
      throw error;
    } }), (caught) => caught === error);
    assert.equal(commits, 1, `${operation} must not retry an ambiguous write`);
    assert.equal(database.delays.length, before);
    checks++;
  }
}
for (const model of [undefined, null, '']) {
  let calls = 0;
  const error = new Error('connection closed');
  await assert.rejects(execute({ model, operation: 'findMany', args: {}, query: async () => {
    calls++; throw error;
  } }), (caught) => caught === error);
  assert.equal(calls, 1, 'No model identity means the operation is not proven read-only');
  checks++;
}
for (const error of [new Error('compute time quota is exceeded'), new KnownRequestError('P2002')]) {
  let calls = 0;
  await assert.rejects(execute({ model: 'SyntheticRecord', operation: 'findMany', args: {}, query: async () => {
    calls++; throw error;
  } }), (caught) => caught === error);
  assert.equal(calls, 1, 'Quota and permanent read failures must not retry');
  checks++;
}
{
  let calls = 0;
  const before = database.delays.length;
  const error = new KnownRequestError('P1017');
  await assert.rejects(execute({ model: 'SyntheticRecord', operation: 'count', args: {}, query: async () => {
    calls++; throw error;
  } }), (caught) => caught === error);
  assert.equal(calls, 4);
  assert.deepEqual(database.delays.slice(before), [250, 750, 1500]);
  checks++;
}
{
  let calls = 0;
  assert.equal(await execute({ model: 'SyntheticRecord', operation: 'create', args: {}, query: async () => {
    calls++; return 'one write';
  } }), 'one write');
  assert.equal(calls, 1);
  checks++;
}

function financialFixture(response, handlerError) {
  const env = sandbox();
  const policy = env.load('src/services/automationSafety.ts');
  const stages = [];
  const scheduler = env.load('src/services/opsScheduler.ts', {
    './automationSafety.js': policy,
    './safeQueuePolicy.js': env.load('src/services/safeQueuePolicy.ts'),
    '../lib/prisma.js': new Proxy({}, { get: denyDatabase }),
    '../app.js': { createAppServices: () => ({
      shipmentStatusSyncService: {
        processReturnQueue: async () => { stages.push('returns'); return {}; },
        processShopifyPaymentQueue: async () => { stages.push('shopify'); return {}; },
        processOdooCollectionQueue: async () => { stages.push('collections'); return {}; },
      },
    }) },
    '../netlify/functions/process-odoo-queue-background.js': { handler: async () => {
      stages.push('odoo');
      if (handlerError) throw handlerError;
      return response;
    } },
  }, '\nexport { runLane as testOnlyRunLane };');
  return { ...scheduler, policy, stages };
}

const quotaBodies = [
  JSON.stringify({ ok: false, message: 'Your compute time quota is exceeded' }),
  JSON.stringify({ cause: { meta: { database_error: 'compute allowance exhausted' } } }),
  JSON.stringify('compute time quota is exceeded'),
  'compute time quota is exceeded',
  'not-json: payment required',
];
for (const body of quotaBodies) {
  const fixture = financialFixture({ statusCode: 500, body });
  let propagated;
  await assert.rejects(fixture.testOnlyRunLane('financial'), (error) => {
    propagated = error;
    return fixture.policy.isDatabaseQuotaError(error);
  });
  assert.deepEqual(fixture.stages, ['odoo'], 'Quota stops every subsequent financial stage');
  assert.equal(propagated.message, 'Odoo queue stage failed: database quota exhausted');
  assert.equal(propagated.cause, undefined, 'Private handler payload must not escape');
  assert.equal(fixture.policy.opsControlRetry(propagated, 1).acknowledge, true);
  checks++;
}
{
  const fixture = financialFixture(undefined, new Error('compute time quota is exceeded'));
  await assert.rejects(fixture.testOnlyRunLane('financial'), fixture.policy.isDatabaseQuotaError);
  assert.deepEqual(fixture.stages, ['odoo']);
  checks++;
}
for (const body of [JSON.stringify({ message: 'service unavailable' }), 'not-json', '']) {
  const fixture = financialFixture({ statusCode: 503, body });
  await assert.rejects(fixture.testOnlyRunLane('financial'), (error) => {
    assert.equal(fixture.policy.isDatabaseQuotaError(error), false);
    return /Ops lane stages failed: odoo/.test(error.message);
  });
  assert.deepEqual(fixture.stages, ['odoo', 'returns', 'shopify', 'collections']);
  checks++;
}
{
  const fixture = financialFixture({ statusCode: 200, body: JSON.stringify({ ok: true, processed: 0 }) });
  const result = await fixture.testOnlyRunLane('financial');
  assert.equal(result.odoo.ok, true);
  assert.deepEqual(fixture.stages, ['odoo', 'returns', 'shopify', 'collections']);
  checks++;
}
{
  // Exercise the consumer-facing path too: no success marker or cleanup SQL
  // after quota, and the original control retry policy still acknowledges it.
  const fixture = financialFixture({ statusCode: 500, body: quotaBodies[0] });
  let state = {};
  let mutations = 0;
  let mockPublications = 0;
  const now = 1_800_000_000_000;
  const scheduler = new fixture.OpsScheduler({
    now: () => now,
    enabled: () => true,
    read: async () => state,
    mutate: async (_lane, change) => {
      mutations++;
      const changed = change(state);
      state = changed.state;
      return changed.result;
    },
    publish: async () => { mockPublications++; },
    run: fixture.testOnlyRunLane,
  });
  await assert.rejects(scheduler.tick({ version: 1, lane: 'financial', slot: now }), (error) => {
    assert.equal(fixture.policy.opsControlRetry(error, 1).acknowledge, true);
    return fixture.policy.isDatabaseQuotaError(error);
  });
  assert.deepEqual(fixture.stages, ['odoo']);
  assert.equal(mutations, 2, 'Only in-memory lease and next-slot bookkeeping; no quota cleanup');
  assert.equal(mockPublications, 1, 'Only the existing pre-work recurrence, represented by a mock');
  assert.equal(state.lastSuccessAt, undefined);
  assert.equal(state.completedSlot, undefined);
  checks++;
}

assert.equal(deniedNetworkCalls, 0);
assert.equal(deniedDatabaseCalls, 0);
assert.equal(deniedImports, 0);
assert.deepEqual(Object.keys(database.context.process.env), []);
console.log(JSON.stringify({
  ok: true, checks,
  isolation: 'in-memory transpilation, empty environments, strict import allowlist, network/database denial',
  actualDatabaseCalls: 0, actualNetworkCalls: 0, actualQueueCalls: 0, filesWritten: 0,
}));
