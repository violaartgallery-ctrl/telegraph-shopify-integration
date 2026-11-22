/**
 * Offline-only: transpile the actual route and auth helper into a VM. All app
 * imports are synthetic; no env loader, Prisma, provider, socket or queue runs.
 * Run: NODE_DISABLE_COMPILE_CACHE=1 node src/scripts/testAccurateWebhookAuth.ts
 */
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import type { Request, Response } from 'express';
import type {
  AccurateWebhookDependencies,
  createAccurateWebhookHandler
} from '../routes/accurateWebhookRoute.js';
import type { StatusPollingRecordRef } from '../services/shipmentStatusSyncService.js';

const require = createRequire(import.meta.url);
const ts: typeof import('typescript') = require('typescript');
const routeSource = readFileSync(new URL('../routes/accurateWebhookRoute.ts', import.meta.url), 'utf8');
const authSource = readFileSync(new URL('../services/shopifyAdminAuth.ts', import.meta.url), 'utf8');
const SECRET = 'synthetic-accurate-webhook-secret';
const firstRecord = {
  id: 1, shopifyOrderId: 'synthetic-order-5001',
  accurateShipmentId: 900001, accurateShipmentCode: 'VI-TEST-5001'
};
const codeOnlyRecord = {
  id: 2, shopifyOrderId: 'synthetic-order-5002',
  accurateShipmentId: null, accurateShipmentCode: 'VI-TEST-5002'
};
const idOnlyRecord = {
  id: 3, shopifyOrderId: 'synthetic-order-5003',
  accurateShipmentId: 900003, accurateShipmentCode: null
};
type TestRecord = NonNullable<Awaited<ReturnType<AccurateWebhookDependencies['findByReference']>>>;
const records = new Map<string, TestRecord>([
  ['#5001', firstRecord], ['5001', firstRecord], ['VI-TEST-5001', firstRecord],
  ['#5002', codeOnlyRecord], ['#5003', idOnlyRecord], ['900003', idOnlyRecord],
  ['#5004', { id: 4, shopifyOrderId: 'synthetic-order-5004', accurateShipmentId: null, accurateShipmentCode: null }],
  ['#5005', { ...firstRecord, id: 5, accurateShipmentId: -1 }],
  ['#5006', { ...firstRecord, id: 6, accurateShipmentCode: '' }]
]);

type Failure = Parameters<AccurateWebhookDependencies['saveFailedPayload']>[0];
let lookups: string[] = [];
let saved: Failure[] = [];
let synced: StatusPollingRecordRef[] = [];
let logs: unknown[] = [];
let failLookup = false;
let failReview = false;
let failSync = false;
let comparisons = 0;
let forbiddenEffects = 0;
let checks = 0;

const denied = (): never => {
  forbiddenEffects++;
  throw new Error('External/network/unapproved effect denied');
};
const originalFetch = globalThis.fetch;
globalThis.fetch = denied;

const reset = () => {
  lookups = []; saved = []; synced = []; logs = [];
  failLookup = false; failReview = false; failSync = false; comparisons = 0;
};
const check = (condition: unknown, label: string) => { assert.ok(condition, label); checks++; };
const equal = (actual: unknown, expected: unknown, label: string) => {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), label);
  checks++;
};
const noEffects = (label: string) => equal(
  { lookups, saved, synced }, { lookups: [], saved: [], synced: [] }, label
);

const findByReference: AccurateWebhookDependencies['findByReference'] = async (reference) => {
  assert.equal(typeof reference, 'string', 'Prisma reference must be scalar text');
  lookups.push(reference);
  if (failLookup) throw new Error('Synthetic private upstream detail must not be logged');
  return records.get(reference) ?? null;
};
const saveFailedPayload: AccurateWebhookDependencies['saveFailedPayload'] = async (params) => {
  if (failReview) throw new Error('Synthetic private DB detail must not be logged');
  saved.push(params);
};
const statusSync = {
  syncRecord: async (record: StatusPollingRecordRef) => {
    synced.push(record);
    if (failSync) throw new Error('Synthetic private provider detail must not be logged');
    return 'synced' as const;
  }
};

const context = vm.createContext({
  Buffer,
  process: Object.freeze({ env: Object.freeze({ ACCURATE_WEBHOOK_SECRET: SECRET }) }),
  fetch: denied,
  setTimeout: denied,
  console: { log: denied, error: denied, warn: denied }
});
const compile = (source: string, modules: Record<string, unknown>) => {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  });
  const module = { exports: {} as Record<string, unknown> };
  new vm.Script(`(function(require,module,exports){${compiled.outputText}\n})`).runInContext(context)(
    (id: string) => Object.hasOwn(modules, id) ? modules[id] : denied(), module, module.exports
  );
  return module.exports;
};
const actualAuth = compile(authSource, { 'node:crypto': crypto }) as {
  constantTimeTextEqual: (left: string, right: string) => boolean;
};
const modules = {
  '../config/env.js': { env: { accurate: { webhookSecret: SECRET } } },
  '../lib/logger.js': {
    logger: { warn: (...args: unknown[]) => logs.push(args), error: (...args: unknown[]) => logs.push(args) }
  },
  '../services/failedPayloadService.js': { failedPayloadService: { save: saveFailedPayload } },
  '../services/shipmentRepository.js': { shipmentRepository: { findByReference } },
  '../services/shopifyAdminAuth.js': {
    constantTimeTextEqual: (left: string, right: string) => {
      comparisons++;
      return actualAuth.constantTimeTextEqual(left, right);
    }
  }
};
const factory = (source = routeSource) => compile(source, modules)
  .createAccurateWebhookHandler as typeof createAccurateWebhookHandler;
const createHandler = factory();
const handler = createHandler(statusSync);
type Handler = ReturnType<typeof createAccurateWebhookHandler>;
// VM-owned JSON objects preserve the same prototype guarantees as Express JSON.
const parseBody = vm.runInContext('(raw) => JSON.parse(raw)', context) as (raw: string) => unknown;

interface CallOptions {
  secret?: unknown;
  query?: unknown;
  contentType?: string;
  rawBody?: unknown;
}
const call = async (body: unknown, options: CallOptions = {}, target: Handler = handler) => {
  let status = 200;
  let json: unknown;
  let responses = 0;
  const request = {
    body: Object.hasOwn(options, 'rawBody') ? options.rawBody :
      body === undefined ? undefined : parseBody(JSON.stringify(body)),
    query: { webhookSecret: options.query },
    header: () => Object.hasOwn(options, 'secret') ? options.secret : SECRET,
    is: (type: string) => (options.contentType ?? 'application/json') === type ? type : false
  } as unknown as Request;
  const response = {
    status: (code: number) => { status = code; return response; },
    json: (value: unknown) => { responses++; json = value; return response; }
  } as unknown as Response;
  await target(request, response);
  assert.equal(responses, 1, 'exactly one response, no unhandled async rejection');
  return { status, json: JSON.parse(JSON.stringify(json)) as Record<string, unknown> };
};
const dependencies = (webhookSecret: string): AccurateWebhookDependencies => ({
  webhookSecret, findByReference, saveFailedPayload
});
const expectRejected = async (body: unknown, label: string, options: CallOptions = {}) => {
  reset();
  const result = await call(body, options);
  check(result.status === 400, label);
  noEffects(`${label}: zero DB/provider effects`);
};

try {
  for (const secret of ['', ' ', '\t\n', 's'.repeat(4097)]) {
    reset();
    const result = await call({ refNumber: '#5001' }, {}, createHandler(statusSync, dependencies(secret)));
    check(result.status === 503, 'missing/blank/invalid configured secret fails closed');
    noEffects('unconfigured route performs no DB/provider effect');
  }
  for (const secret of [undefined, '', 'wrong', SECRET + 'x', SECRET.slice(0, -1) + 'x', 'سرّي', [], {}, 'x'.repeat(4097)]) {
    reset();
    const result = await call({ refNumber: '#5001' }, { secret });
    check(result.status === 401, 'invalid header secret rejected');
    noEffects('invalid authentication precedes DB/provider effects');
    if (typeof secret === 'string' && secret.length > 0 && secret.length <= 4096) {
      check(comparisons === 1, 'secret comparison uses actual timing-safe helper');
    }
  }
  for (const query of [undefined, [], [SECRET], { equals: SECRET }]) {
    reset();
    check((await call({}, { secret: undefined, query })).status === 401, 'non-scalar query secret rejected');
    noEffects('query authentication rejection has no effects');
  }
  reset();
  check((await call({ refNumber: '#5001' }, { secret: undefined, query: SECRET })).status === 200,
    'legacy scalar query authentication remains supported');
  check(comparisons === 1 && synced.length === 1, 'authenticated query reaches native sync once');
  reset();
  check((await call({ refNumber: '#5001' }, { secret: 'wrong', query: SECRET })).status === 401,
    'correct query cannot override an explicitly wrong header');
  noEffects('wrong header wins without effects');
  reset();
  check((await call({ refNumber: '#5001' }, { query: ['wrong'] })).status === 200,
    'valid preferred header does not depend on unused query auth');
  reset();
  check((await call(null, { secret: 'wrong' })).status === 401, 'authentication precedes invalid-body processing');
  noEffects('bad auth plus malformed body has no effects');

  for (const body of [undefined, null, [], [{}], 'text', 1, true, {}, { status: 'DTR' }]) {
    await expectRejected(body, 'non-object/empty/missing-identity body rejected');
  }
  for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', '']) {
    await expectRejected({ refNumber: '#5001' }, 'non-JSON content type rejected', { contentType });
  }
  for (const rawBody of [Buffer.from('{}'), new Date(), Object.create({ refNumber: '#5001' })]) {
    await expectRejected({}, 'non-JSON object prototype rejected', { rawBody });
  }
  for (const key of ['refNumber', 'externalReference']) {
    for (const value of [[], ['#5001'], {}, { not: '' }, true, false, '', ' ', 'x'.repeat(257),
      '#5001\n', '#5001\u0000', '#5001\u007f', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expectRejected({ refNumber: '#5001', [key]: value }, `${key} rejects malformed scalar/operator`);
    }
  }
  for (const value of [[], [900001], {}, { equals: 900001 }, true, false, '', ' ', '1e3', '900001.0',
    '+900001', '-1', ' 900001 ', '9'.repeat(17), '9007199254740992', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await expectRejected({ refNumber: '#5001', shipmentId: value }, 'invalid shipmentId cannot be coerced');
  }
  for (const value of [[], ['VI-TEST-5001'], {}, { equals: 'VI-TEST-5001' }, 5001, true, '', ' ',
    'x'.repeat(129), 'VI-TEST-5001\r']) {
    await expectRejected({ refNumber: '#5001', shipmentCode: value }, 'invalid shipmentCode rejected');
  }
  for (const value of [NaN, Infinity, -Infinity]) {
    const rawBody = parseBody('{"refNumber":"#5001"}') as Record<string, unknown>;
    rawBody.shipmentId = value;
    await expectRejected({}, 'non-finite identity rejected', { rawBody });
  }

  for (const body of [
    { refNumber: '#5001' },
    { refNumber: ' #5001 ', externalReference: '#5001' },
    { refNumber: 5001 },
    { externalReference: '#5001' },
    { shipmentCode: 'VI-TEST-5001' },
    { refNumber: '#5001', shipmentId: 900001, shipmentCode: 'VI-TEST-5001' },
    { refNumber: '#5001', shipmentId: '900001' },
    { refNumber: '#5001', shipmentId: '000900001' },
    { refNumber: '#5001', externalReference: '5001' },
    { refNumber: '#5001', status: { code: 'FORGED' }, collectedAmount: 999999,
      customer: { private: 'must-not-be-used-or-saved' }, shipmentId: null, shipmentCode: null }
  ]) {
    reset();
    const result = await call(body);
    check(result.status === 200 && result.json.matched === true, 'authentic callback remains compatible');
    equal(synced, [firstRecord], 'sync receives exactly the stored identity, not callback fields');
    check(saved.length === 0 && lookups.length <= 2, 'valid callback performs bounded lookup, no failure write');
  }
  reset();
  check((await call({ refNumber: '#5002', shipmentId: 777777 })).status === 200,
    'missing stored id does not authorize callback id');
  equal(synced, [{ ...codeOnlyRecord, accurateShipmentId: undefined }], 'code-only record sync uses stored code only');
  reset();
  check((await call({ refNumber: '#5003', shipmentCode: 'UNTRUSTED' })).status === 200,
    'missing stored code does not authorize callback code');
  equal(synced, [{ ...idOnlyRecord, accurateShipmentCode: undefined }], 'id-only record sync uses stored id only');
  reset();
  check((await call({ shipmentId: 900003 })).status === 200, 'legacy integer-only reference lookup supported');
  equal(synced, [{ ...idOnlyRecord, accurateShipmentCode: undefined }], 'integer-only callback still uses stored identity');

  for (const body of [
    { refNumber: '#5001', shipmentId: 900003 },
    { refNumber: '#5001', shipmentCode: 'VI-TEST-5003' },
    { refNumber: '#5001', externalReference: '#5002' },
    { refNumber: '#5001', externalReference: '#unknown' },
    { refNumber: '#5004', shipmentId: 900004, shipmentCode: 'CALLBACK-CANNOT-REPAIR-IDENTITY' },
    { refNumber: '#5005' }, { refNumber: '#5006' }
  ]) {
    reset();
    const result = await call({ ...body, status: 'DTR', customer: 'PRIVATE-SYNTHETIC-BODY' });
    check(result.status === 409 && synced.length === 0, 'identity conflict/missing stored identity is review-only');
    check(saved.length === 1 && saved[0]!.source === 'accurate-shipment-status', 'one bounded review receipt saved');
    check(!JSON.stringify(saved).includes('PRIVATE-SYNTHETIC-BODY') && !JSON.stringify(saved).includes('DTR'),
      'review receipt excludes raw body/status/customer information');
  }
  reset();
  check((await call({ refNumber: '#unknown' })).status === 202, 'unknown valid reference remains acknowledged');
  equal({ lookups, saved, synced }, { lookups: ['#unknown'], saved: [], synced: [] },
    'unknown reference does not create failure jobs');
  reset();
  for (let i = 0; i < 100; i++) {
    check((await call({ refNumber: { not: '' } })).status === 400, 'malformed callback flood rejected');
  }
  noEffects('100 malformed requests create no rows/lookups/provider calls');
  reset();
  for (let i = 0; i < 100; i++) await call({ refNumber: '#unknown' });
  check(lookups.length === 100 && saved.length === 0 && synced.length === 0,
    'unknown callback retries never amplify into 100 failure rows');

  reset(); failLookup = true;
  let result = await call({ refNumber: '#5001' });
  check(result.status === 500 && result.json.matched === false, 'lookup/Neon failure is handled');
  check(saved.length === 0 && synced.length === 0 && lookups.length === 1, 'lookup failure has no write/retry');
  check(!JSON.stringify(logs).includes('private'), 'upstream DB details are not logged');
  reset(); failReview = true;
  result = await call({ refNumber: '#5001', shipmentId: 777777 });
  check(result.status === 500 && synced.length === 0, 'failed review persistence never falls through to sync');
  check(!JSON.stringify(logs).includes('private'), 'review DB details are not logged');
  reset(); failSync = true;
  result = await call({ refNumber: '#5001' });
  check(result.status === 500 && result.json.matched === true, 'sync rejection is handled without process crash');
  check(synced.length === 1 && saved.length === 0, 'unknown sync outcome is not retried or saved as a new job');
  check(!JSON.stringify(logs).includes('private') && !JSON.stringify(logs).includes(SECRET),
    'sync failure log contains no private provider details or secrets');

  // Mutation proofs: the stored-ID assertions catch either callback override,
  // including the important case where the local identity field is NULL.
  for (const field of ['accurateShipmentId', 'accurateShipmentCode'] as const) {
    const callbackField = field === 'accurateShipmentId' ? 'shipmentId' : 'shipmentCode';
    const needle = `${field}: record.${field} ?? undefined`;
    const mutant = routeSource.replace(needle, `${field}: identity.${callbackField} ?? record.${field} ?? undefined`);
    check(mutant !== routeSource, 'authority mutation applied to actual route source');
    reset();
    const body = field === 'accurateShipmentId'
      ? { refNumber: '#5002', shipmentId: 777777 }
      : { refNumber: '#5003', shipmentCode: 'UNTRUSTED' };
    await call(body, {}, factory(mutant)(statusSync));
    const expected = field === 'accurateShipmentId'
      ? [{ ...codeOnlyRecord, accurateShipmentId: undefined }]
      : [{ ...idOnlyRecord, accurateShipmentCode: undefined }];
    assert.throws(() => assert.deepEqual(JSON.stringify(synced), JSON.stringify(expected)));
    checks++;
  }
  const failClosedMutant = routeSource.replace(
    "typeof webhookSecret !== 'string' || !webhookSecret.trim() || webhookSecret.length > MAX_SECRET_LENGTH", 'false'
  );
  check(failClosedMutant !== routeSource, 'fail-closed mutation applied to actual source');
  reset();
  result = await call({ refNumber: '#5001' }, {}, factory(failClosedMutant)(statusSync, dependencies('')));
  assert.throws(() => assert.equal(result.status, 503)); checks++;
  check(forbiddenEffects === 0, 'no external/network/queue/real DB effect attempted');
  console.log(JSON.stringify({
    ok: true, checks, mutationChecks: 3, externalCalls: 0, realDatabaseCalls: 0,
    isolation: 'VM synthetic imports, actual route and timing-safe auth helper; external fetch denied'
  }));
} finally {
  globalThis.fetch = originalFetch;
}
