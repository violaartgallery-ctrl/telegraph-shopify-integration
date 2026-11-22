/** VM-only actual Shopify transport tests. All authentication, operation hooks
 * and fetches are strict synthetic mocks; no dotenv/DB/network/queue imports. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script, createContext } from 'node:vm';
for (const key of Object.keys(process.env)) delete process.env[key];
const require = createRequire(import.meta.url), ts = require('typescript');
const source = readFileSync(new URL('../shopify/shopifyAdminGraphql.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { fileName: 'shopifyAdminGraphql.ts', reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
assert.equal((compiled.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
let checks = 0, deniedImports = 0;
class ReviewError extends Error { constructor(message) { super(message); this.name = 'AutomaticOperationReviewError'; } }
const mutation = 'mutation SyntheticWrite { syntheticWrite { id } }', query = 'query SyntheticRead { shop { name } }';
const valid = () => ({ ok: true, status: 200, async json() { return { data: { syntheticWrite: { id: 'synthetic' } } }; }, async text() { return '{"transaction":{"id":88}}'; } });
function fixture({ respond = valid, context = true, hookError, authError } = {}) {
  const calls = [], events = [], halts = [];
  let halted = false, tokens = 0, clears = 0;
  const module = { exports: {} };
  const mocks = {
    '../config/env.js': { env: { shopify: { shopDomain: 'synthetic.invalid.test', apiVersion: 'synthetic-version' } } },
    './shopifyAuth.js': { shopifyAuth: {
      async getAccessToken() { tokens++; events.push('auth'); if (authError) throw authError; return 'synthetic-token'; },
      clearCachedToken() { clears++; events.push('clear-token'); },
    } },
    '../services/automaticOperationSafety.js': {
      AutomaticOperationReviewError: ReviewError,
      automaticOperationContext: () => context ? { recordId: 1, shopifyOrderId: '900001', lane: 'return' } : undefined,
      haltAutomaticOperation(reason) { halts.push(reason); halted = true; events.push('halt'); },
      async beforeAutomaticShopifyWrite() { events.push('hook'); if (hookError) throw hookError; if (halted) throw new ReviewError('Synthetic sticky operation is halted'); },
    },
  };
  const vm = createContext({ module, exports: module.exports, process: { env: Object.create(null) }, console,
    async fetch(url, options) {
      assert.ok(url.startsWith('https://synthetic.invalid.test/admin/api/synthetic-version/'));
      assert.equal(options.headers['X-Shopify-Access-Token'], 'synthetic-token');
      calls.push({ url, options }); events.push('fetch'); return await respond(calls.length);
    },
    require(id) { if (Object.hasOwn(mocks, id)) return mocks[id]; deniedImports++; throw Error(`Unexpected import ${id}`); },
  }, { codeGeneration: { strings: false, wasm: false } });
  new Script(compiled.outputText, { filename: 'shopifyAdminGraphql.vm.cjs' }).runInContext(vm);
  return { ...module.exports, calls, events, halts, get tokens() { return tokens; }, get clears() { return clears; } };
}
const invoke = (f, kind) => kind === 'GraphQL' ? f.requestShopifyAdmin(mutation, { synthetic: true })
  : f.requestShopifyAdminRest('/orders/900001/transactions.json', { method: 'POST', body: { synthetic: true } });

const graphqlFailures = [
  ['null', () => ({ ok: true, status: 200, async json() { return null; } })],
  ['array', () => ({ ok: true, status: 200, async json() { return []; } })],
  ['JSON/body read rejection', () => ({ ok: true, status: 200, async json() { throw new Error('Synthetic body stream interrupted'); } })],
  ['JSON syntax rejection', () => ({ ok: true, status: 200, async json() { throw new SyntaxError('Synthetic JSON truncated'); } })],
  ['missing data', () => ({ ok: true, status: 200, async json() { return {}; } })],
  ['execution errors', () => ({ ok: true, status: 200, async json() { return { errors: [{ message: 'Synthetic resolver failure' }] }; } })],
];
const restFailures = [
  ['body read rejection', () => ({ ok: true, status: 200, async text() { throw Error('Synthetic body stream interrupted'); } })],
  ['JSON syntax rejection', () => ({ ok: true, status: 200, async text() { return '{broken'; } })],
];
for (const [kind, failures] of [['GraphQL', graphqlFailures], ['REST', restFailures]]) {
  for (const [label, respond] of [
    ...failures, ['fetch rejection', () => { throw Error('fetch failed ECONNRESET'); }],
    ...[401, 403, 429, 500, 502, 503, 504].map(status => [`HTTP ${status}`, () => ({ ok: false, status, async text() { return 'Synthetic failure'; } })]),
  ]) {
    const f = fixture({ respond });
    await assert.rejects(invoke(f, kind), error => error instanceof ReviewError && /outcome unknown.*independent review/.test(error.message));
    assert.equal(f.calls.length, 1, `${kind} ${label} must not replay mutation`);
    assert.equal(f.tokens, 1); assert.equal(f.clears, 0);
    assert.deepEqual(f.halts, ['SHOPIFY_WRITE_OUTCOME_UNKNOWN']);
    assert.deepEqual(f.events.slice(0, 3), ['auth', 'hook', 'fetch']);
    // Model a native service catch followed by a fallback mutation: the
    // original sticky halt must prevent any second sent request.
    await assert.rejects(invoke(f, kind), /sticky operation is halted/);
    assert.equal(f.calls.length, 1); assert.equal(f.clears, 0); checks++;
  }
  {
    const denial = Error('Synthetic owner/claim denial'), f = fixture({ hookError: denial });
    await assert.rejects(invoke(f, kind), error => error === denial);
    assert.equal(f.calls.length, 0); assert.equal(f.tokens, 1); assert.equal(f.clears, 0); assert.deepEqual(f.halts, []); checks++;
  }
  {
    const denial = Error('Synthetic authentication failure'), f = fixture({ authError: denial });
    await assert.rejects(invoke(f, kind), error => error === denial);
    assert.equal(f.calls.length, 0); assert.deepEqual(f.events, ['auth']); assert.deepEqual(f.halts, []); checks++;
  }
  {
    const f = fixture(); await invoke(f, kind);
    assert.equal(f.calls.length, 1); assert.equal(f.tokens, 1); assert.equal(f.clears, 0); assert.deepEqual(f.halts, []); checks++;
  }
  {
    const original = Error('Synthetic transport interruption'), f = fixture({ context: false, respond() { throw original; } });
    await assert.rejects(invoke(f, kind), error => error === original);
    assert.equal(f.calls.length, 1); assert.deepEqual(f.halts, []); checks++;
  }
}
for (const kind of ['GraphQL', 'REST']) for (const status of [401, 403]) {
  const f = fixture({ respond: n => n === 1 ? { ok: false, status, async text() { return 'Synthetic auth error'; } } : valid() });
  if (kind === 'GraphQL') await f.requestShopifyAdmin(query);
  else await f.requestShopifyAdminRest('/orders/900001.json', { method: 'GET' });
  assert.equal(f.calls.length, 2); assert.equal(f.tokens, 2); assert.equal(f.clears, 1);
  assert.equal(f.events.includes('hook'), false); assert.deepEqual(f.halts, []); checks++;
}
for (const kind of ['GraphQL', 'REST']) {
  const f = fixture({ respond: () => ({ ok: false, status: 401, async text() { return 'Synthetic persistent auth error'; } }) });
  await assert.rejects(kind === 'GraphQL' ? f.requestShopifyAdmin(query) : f.requestShopifyAdminRest('/orders/900001.json'));
  assert.equal(f.calls.length, 2); assert.equal(f.clears, 1); assert.deepEqual(f.halts, []); checks++;
}
assert.equal(deniedImports, 0);
console.log(JSON.stringify({ ok: true, checks, deniedImports, realNetworkCalls: 0, realDatabaseConnections: 0,
  realQueuePublications: 0, realPreviewRun: 0, realBusinessWrites: 0, filesWritten: 0 }));
