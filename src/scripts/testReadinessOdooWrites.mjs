/**
 * Offline only: transpile the Odoo client in memory with dummy configuration,
 * strict imports and synthetic fetch/operation hooks. No dotenv, DB, queue,
 * production app import, generated files or real provider calls.
 * Run: node src/scripts/testReadinessOdooWrites.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script, createContext } from 'node:vm';

for (const key of Object.keys(process.env)) delete process.env[key];
const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = readFileSync(new URL('../odoo/odooClient.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  fileName: 'odooClient.ts', reportDiagnostics: true,
});
assert.equal((compiled.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
let checks = 0, deniedImports = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const legacyTransient = /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|socket hang up|ESOCKETTIMEDOUT|timeout|503|504|Gateway/i;
const reads = ['search', 'search_read', 'search_count', 'read', 'read_group', 'fields_get'];
const mutations = ['create', 'write', 'unlink', 'action_confirm', 'action_post', 'create_invoices', 'action_create_payments', 'process', 'create_returns', 'action_create_returns', 'read_custom_write', 'onchange', 'default_get', 'future_method', 'SEARCH_READ', ''];
const result = (value, extra = {}) => ({ ok: true, status: 200, async json() { return { jsonrpc: '2.0', id: 1, result: value, ...extra }; } });
const business = (message) => ({ ok: true, status: 200, async json() { return { jsonrpc: '2.0', id: 1, error: { message: 'Odoo Server Error', data: { message } } }; } });

function fixture({ config = {}, respond = () => result(true), hook } = {}) {
  const calls = [], delays = [], events = [], halts = [];
  let halted = false;
  const env = { odoo: { url: 'https://odoo.invalid.test', db: 'synthetic-db', username: 'synthetic-user', password: 'synthetic-password', ...config } };
  const safety = {
    async beforeAutomaticOdooWrite(model, method) {
      events.push(`hook:${model}:${method}`);
      if (halted) throw new Error('Synthetic durable operation is halted; manual review required');
      await hook?.(model, method);
    },
    haltAutomaticOperation(code) { halted = true; halts.push(code); events.push('halt'); },
  };
  const module = { exports: {} };
  const context = createContext({
    module, exports: module.exports,
    process: { env: Object.create(null) }, console,
    setTimeout(callback, delay) { delays.push(delay); callback(); },
    async fetch(url, options) {
      assert.equal(url, 'https://odoo.invalid.test/jsonrpc');
      assert.equal(options.method, 'POST');
      const payload = JSON.parse(options.body);
      assert.equal(payload.jsonrpc, '2.0');
      assert.equal(payload.method, 'call');
      const { service, method, args } = payload.params;
      calls.push({ service, method, args });
      events.push(`fetch:${service}:${service === 'object' ? args[4] : method}`);
      if (service === 'common') {
        assert.equal(method, 'login');
        assert.deepEqual(args, ['synthetic-db', 'synthetic-user', 'synthetic-password']);
        return await respond({ service, method, args, calls }) ?? result(7);
      }
      assert.equal(service, 'object');
      assert.equal(method, 'execute_kw');
      assert.equal(args[0], 'synthetic-db');
      assert.equal(args[1], 7);
      assert.equal(args[2], 'synthetic-password');
      return await respond({ service, method: args[4], model: args[3], args, calls });
    },
    require(id) {
      if (id === '../config/env.js') return { env };
      if (id === '../services/automaticOperationSafety.js') return safety;
      deniedImports++;
      throw new Error(`Import denied: ${id}`);
    },
  }, { codeGeneration: { strings: false, wasm: false } });
  new Script(compiled.outputText, { filename: 'odooClient.vm.cjs' }).runInContext(context);
  const exported = module.exports;
  return { ...exported, client: new exported.OdooClient(), calls, delays, events, halts, env };
}
const mutationCalls = f => f.calls.filter(c => c.service === 'object');
const uncertain = [
  ['transport', () => { throw new Error('fetch failed ECONNRESET timeout 503 Gateway synthetic-password'); }],
  ...[401, 429, 500, 502, 503, 504, 599].map(status => [`HTTP${status}`, () => ({ ok: false, status, json() { throw new Error('Must not parse a failed mutation response'); } })]),
  ['parse', () => ({ ok: true, status: 200, async json() { throw new SyntaxError('Unexpected end of JSON input'); } })],
  ['missing result', () => ({ ok: true, status: 200, async json() { return { jsonrpc: '2.0', id: 1 }; } })],
  ...[null, [], 'not an envelope', 3].map(body => [`bad shape ${JSON.stringify(body)}`, () => ({ ok: true, status: 200, async json() { return body; } })]),
  ['wrong ID', () => result(1, { id: 2 })],
  ['wrong version', () => result(1, { jsonrpc: '1.0' })],
  ['empty error', () => ({ ok: true, status: 200, async json() { return { error: {} }; } })],
  ['error and result', () => result(1, { error: { message: 'uncertain' } })],
];

for (const method of mutations) {
  for (const [label, respond] of uncertain) {
    const f = fixture({ respond: req => req.service === 'common' ? result(7) : respond() });
    await assert.rejects(f.client.call('account.move', method, [[42]]), error => {
      assert.ok(error instanceof f.OdooWriteOutcomeUnknownError);
      assert.equal(error.code, 'ODOO_WRITE_OUTCOME_UNKNOWN');
      assert.equal(error.manualReviewRequired, true);
      assert.equal(error.retryable, false);
      assert.equal(error.model, 'account.move');
      assert.equal(error.method, method);
      assert.equal(error.cause, undefined);
      assert.equal(legacyTransient.test(error.message), false);
      assert.equal(error.message.includes('synthetic-password'), false);
      return true;
    });
    assert.equal(mutationCalls(f).length, 1, `${method}/${label}: only one sent mutation`);
    assert.deepEqual(f.delays, []);
    assert.deepEqual(f.halts, ['ODOO_WRITE_OUTCOME_UNKNOWN']);
    assert.equal(f.events.filter(e => e.startsWith('hook:')).length, 1);
    checks++;
  }
}

// A native invoice-wizard catch must not permit a fallback create in the same
// durable operation context after an unknown sent outcome.
{
  const f = fixture({ respond: req => req.service === 'common' ? result(7) : (() => { throw Error('ECONNRESET'); })() });
  await assert.rejects(f.client.create('sale.advance.payment.inv', {}), f.OdooWriteOutcomeUnknownError);
  await assert.rejects(f.client.create('account.move', {}), /operation is halted/);
  assert.equal(mutationCalls(f).length, 1);
  assert.deepEqual(f.halts, ['ODOO_WRITE_OUTCOME_UNKNOWN']);
  checks++;
}

for (const method of mutations) {
  const denial = new Error('Synthetic context/intent denied');
  const f = fixture({ respond: req => req.service === 'common' ? result(7) : result(42), hook() { throw denial; } });
  await assert.rejects(f.client.executeKw('sale.order', method), error => error === denial);
  assert.equal(mutationCalls(f).length, 0);
  assert.deepEqual(f.halts, []);
  assert.deepEqual(f.events, ['fetch:common:login', `hook:sale.order:${method}`]);
  checks++;
}
{
  let release, entered;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const f = fixture({ respond: req => result(req.service === 'common' ? 7 : 42), async hook() { entered(); await waiting; } });
  const pending = f.client.create('sale.order', {});
  await started;
  assert.equal(mutationCalls(f).length, 0, 'Async intent persistence is awaited before sending');
  release();
  assert.equal(await pending, 42);
  assert.deepEqual(f.events, ['fetch:common:login', 'hook:sale.order:create', 'fetch:object:create']);
  checks++;
}

for (const method of reads) {
  let attempts = 0;
  const f = fixture({ hook() { throw new Error('Reads must not call mutation hook'); }, respond: req => {
    if (req.service === 'common') return result(7);
    if (++attempts < 3) throw new Error('fetch failed');
    return result([{ id: 42 }]);
  } });
  assert.equal((await f.client.executeKw('sale.order', method))[0].id, 42);
  assert.equal(attempts, 3);
  assert.deepEqual(f.delays, [300, 600]);
  assert.deepEqual(f.halts, []);
  check(f.events.every(e => !e.startsWith('hook:')), `Proven read bypasses mutation hook: ${method}`);
}
for (const status of [429, 500, 501, 502, 503, 504, 599]) {
  let readsSent = 0;
  const f = fixture({ respond: req => {
    if (req.service === 'common') return result(7);
    return ++readsSent === 1 ? { ok: false, status } : result([]);
  } });
  assert.equal((await f.client.searchRead('sale.order', [], ['name'])).length, 0);
  assert.equal(readsSent, 2);
  assert.deepEqual(f.delays, [300]);
  assert.deepEqual(f.halts, []);
  checks++;
}
for (const method of reads) {
  const f = fixture({ respond: req => {
    if (req.service === 'common') return result(7);
    throw new Error('ECONNRESET');
  } });
  await assert.rejects(f.client.executeKw('sale.order', method), /ECONNRESET/);
  assert.equal(mutationCalls(f).length, 3, 'Read retry budget is bounded');
  assert.deepEqual(f.delays, [300, 600]);
  assert.deepEqual(f.halts, []);
  checks++;
}
for (const response of [
  { ok: false, status: 401 },
  business('Validation rejected'),
  { ok: true, status: 200, async json() { throw new SyntaxError('invalid JSON'); } },
  { ok: true, status: 200, async json() { return {}; } },
]) {
  const f = fixture({ respond: req => req.service === 'common' ? result(7) : response });
  await assert.rejects(f.client.searchRead('sale.order', [], ['name']));
  assert.equal(mutationCalls(f).length, 1, 'Permanent/malformed reads do not spin');
  assert.equal(f.calls.filter(c => c.service === 'common').length, 1, 'No implicit auth replay');
  assert.deepEqual(f.delays, []);
  assert.deepEqual(f.halts, []);
  checks++;
}
{
  const f = fixture({ respond: () => { throw new Error('fetch failed'); } });
  await assert.rejects(f.client.create('sale.order', {}), /fetch failed/);
  assert.equal(f.calls.length, 3, 'Authentication has a bounded retry budget');
  assert.equal(mutationCalls(f).length, 0);
  assert.deepEqual(f.delays, [300, 600]);
  assert.deepEqual(f.halts, []);
  check(f.events.every(e => !e.startsWith('hook:')), 'Failed auth never reaches write hook');
}
{
  let authSent = 0;
  const f = fixture({ respond: req => {
    if (req.service === 'common') {
      if (++authSent < 3) throw new Error('ETIMEDOUT');
      return result(7);
    }
    return result(42);
  } });
  assert.equal(await f.client.create('sale.order', { name: 'synthetic' }), 42);
  assert.equal(authSent, 3);
  assert.equal(mutationCalls(f).length, 1);
  assert.deepEqual(f.halts, []);
  assert.deepEqual(f.events.slice(-2), ['hook:sale.order:create', 'fetch:object:create']);
  checks++;
}
for (const uid of [false, null, 0, -1, '7', 1.5]) {
  const f = fixture({ respond: () => result(uid) });
  await assert.rejects(f.client.create('sale.order', {}), /Odoo login failed/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.halts, []);
  checks++;
}
for (const value of [null, false, 0, '', [], { res_id: 42 }]) {
  const f = fixture({ respond: req => result(req.service === 'common' ? 7 : value) });
  assert.equal(JSON.stringify(await f.client.call('sale.order', 'action_confirm', [[42]])), JSON.stringify(value));
  assert.equal(mutationCalls(f).length, 1);
  assert.deepEqual(f.halts, []);
  checks++;
}
for (const value of [false, null, 0, -1, '42', {}, [], [0], [42, 'bad']]) {
  const f = fixture({ respond: req => result(req.service === 'common' ? 7 : value) });
  await assert.rejects(f.client.create('sale.order', {}), f.OdooWriteOutcomeUnknownError);
  assert.equal(mutationCalls(f).length, 1);
  assert.deepEqual(f.halts, ['ODOO_WRITE_OUTCOME_UNKNOWN']);
  checks++;
}
for (const message of ["method 'create_returns' does not exist", 'another entry with the same name already exists', 'Validation rejected', 'Gateway timeout business rejection']) {
  const f = fixture({ respond: req => req.service === 'common' ? result(7) : business(message) });
  await assert.rejects(f.client.call('stock.return.picking', 'create_returns', [[42]]), error => error.message === message && !(error instanceof f.OdooWriteOutcomeUnknownError));
  assert.equal(mutationCalls(f).length, 1);
  assert.deepEqual(f.delays, []);
  assert.deepEqual(f.halts, []);
  checks++;
}
{
  const f = fixture({ respond: req => result(req.service === 'common' ? 7 : 42) });
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(f.client.create('sale.order', cyclic), error => !(error instanceof f.OdooWriteOutcomeUnknownError));
  assert.equal(mutationCalls(f).length, 0);
  assert.deepEqual(f.halts, []);
  checks++;
}
for (const field of ['url', 'db', 'username', 'password']) {
  const f = fixture({ config: { [field]: '' } });
  await assert.rejects(f.client.create('sale.order', {}), f.OdooConfigError);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.halts, []);
  checks++;
}
{
  let n = 0;
  const f = fixture({ respond: req => result(req.service === 'common' ? 7 : ++n) });
  await f.client.create('sale.order', {});
  await f.client.create('account.move', {});
  assert.equal(f.calls.filter(c => c.service === 'common').length, 1, 'Successful auth remains cached');
  assert.equal(f.events.filter(e => e.startsWith('hook:')).length, 2, 'Every mutation checks intent/context');
  assert.deepEqual(f.halts, []);
  checks++;
}
{
  const f = fixture({ respond: req => result(req.service === 'common' ? 7 : req.method === 'create' ? 42 : [{ id: 42, name: 'S42' }]) });
  const domain = [['id', '=', 42]], fields = ['name'], context = { company_id: 1 };
  assert.equal((await f.client.searchRead('sale.order', domain, fields, { limit: 1, order: 'id desc', context }))[0].name, 'S42');
  const read = mutationCalls(f)[0];
  assert.deepEqual(read.args.slice(3), ['sale.order', 'search_read', [domain], { fields, limit: 1, order: 'id desc', context }]);
  assert.equal(await f.client.create('account.move', { ref: 'synthetic' }, context), 42);
  assert.deepEqual(mutationCalls(f)[1].args.slice(3), ['account.move', 'create', [{ ref: 'synthetic' }], { context }]);
  assert.deepEqual(f.halts, []);
  checks++;
}
{
  const f = fixture({ respond: req => result(req.service === 'common' ? 7 : [42, 43]) });
  assert.equal(JSON.stringify(await f.client.executeKw('sale.order', 'create', [[{}, {}]])), '[42,43]', 'Generic ORM batch create retains result compatibility');
  assert.deepEqual(f.halts, []);
  checks++;
}
assert.equal(deniedImports, 0);
console.log(JSON.stringify({ ok: true, checks, deniedImports, realNetworkCalls: 0, realDatabaseConnections: 0, realQueuePublications: 0, realBusinessWrites: 0, filesWritten: 0 }));
