/** Offline tests: only a loopback Express server is called; no database or provider is touched. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import {
  createAccurateWebhookHandler,
  type AccurateWebhookDependencies
} from '../routes/accurateWebhookRoute.js';
import type { StatusPollingRecordRef } from '../services/shipmentStatusSyncService.js';

const loopbackFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname !== '127.0.0.1') throw new Error(`Offline webhook test attempted ${url.host}`);
  return await loopbackFetch(input, init);
};

const SECRET = 'accurate-webhook-test-secret';
const records = new Map([
  ['#5001', { id: 1, shopifyOrderId: 'gid-5001', accurateShipmentId: 900001, accurateShipmentCode: 'VI0005001' }],
  ['#5002', { id: 2, shopifyOrderId: 'gid-5002', accurateShipmentId: null, accurateShipmentCode: 'VI0005002' }],
  ['#5003', { id: 3, shopifyOrderId: 'gid-5003', accurateShipmentId: 900003, accurateShipmentCode: 'VI0005003' }]
]);

let lookups: unknown[] = [];
let saved: Array<{ reason: string; externalId?: string }> = [];
let synced: StatusPollingRecordRef[] = [];
let syncFailure = false;

const reset = () => { lookups = []; saved = []; synced = []; syncFailure = false; };

const dependencies = (webhookSecret: string): AccurateWebhookDependencies => ({
  webhookSecret,
  findByReference: async (reference) => { lookups.push(reference); return records.get(reference) ?? null; },
  saveFailedPayload: async (params) => { saved.push({ reason: params.reason, externalId: params.externalId }); return params; }
});

const statusSync = {
  syncRecord: async (record: StatusPollingRecordRef) => {
    if (syncFailure) throw new Error('Telegraph unavailable');
    synced.push(record);
    return 'synced' as never;
  }
};

const startServer = async (webhookSecret: string) => {
  const app = express();
  app.post('/hook', express.json({ limit: '1mb' }), createAccurateWebhookHandler(statusSync, dependencies(webhookSecret)));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}/hook` };
};

const post = async (url: string, body: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
};

let checks = 0;
const check = (condition: boolean, label: string) => { assert.ok(condition, label); checks++; };
const auth = { 'x-accurate-webhook-secret': SECRET };

// An unconfigured deployment refuses everything before touching the database.
{
  const { server, base } = await startServer('');
  reset();
  const result = await post(base, { refNumber: '#5001', shipmentId: 900003 }, auth);
  check(result.status === 503, 'missing ACCURATE_WEBHOOK_SECRET must fail closed');
  check(lookups.length === 0 && saved.length === 0 && synced.length === 0, 'fail-closed path has no side effects');
  server.close();
}

const { server, base } = await startServer(SECRET);

const rejectedHeaders: Array<Record<string, string>> = [
  {},
  { 'x-accurate-webhook-secret': 'wrong' },
  { 'x-accurate-webhook-secret': `${SECRET}x` }
];
for (const headers of rejectedHeaders) {
  reset();
  const result = await post(base, { refNumber: '#5001' }, headers);
  check(result.status === 401, 'missing or wrong secret is rejected');
  check(lookups.length === 0 && saved.length === 0 && synced.length === 0, 'rejected call has no side effects');
}

reset();
let result = await post(`${base}?webhookSecret=${SECRET}`, { refNumber: '#5001' });
check(result.status === 200 && synced.length === 1, 'query-parameter secret remains accepted');

// The forged pattern: a real order reference with another shipment's identity.
reset();
result = await post(base, { refNumber: '#5001', shipmentId: 900003 }, auth);
check(result.status === 409, 'mismatched shipmentId is held for review');
check(synced.length === 0, 'mismatched shipmentId never syncs');
check(saved.length === 1 && saved[0]!.reason.includes('shipmentId'), 'mismatch is recorded for review');

reset();
result = await post(base, { refNumber: '#5001', shipmentCode: 'VI0005003' }, auth);
check(result.status === 409 && synced.length === 0, 'mismatched shipmentCode never syncs');

reset();
result = await post(base, { refNumber: '#5001', shipmentId: 'not-a-number' }, auth);
check(result.status === 409 && synced.length === 0, 'non-numeric shipmentId is not accepted as a match');

// A consistent callback refreshes the record from its stored identity only.
reset();
result = await post(base, { refNumber: '#5001', shipmentId: 900001, shipmentCode: 'VI0005001' }, auth);
check(result.status === 200 && result.json.matched === true, 'consistent callback is accepted');
assert.deepEqual(synced, [{ id: 1, shopifyOrderId: 'gid-5001', accurateShipmentId: 900001, accurateShipmentCode: 'VI0005001' }]);
checks++;

reset();
result = await post(base, { refNumber: '#5002', shipmentId: 777777 }, auth);
check(result.status === 200, 'a record without a stored id is refreshed from its stored code');
assert.deepEqual(synced, [{ id: 2, shopifyOrderId: 'gid-5002', accurateShipmentId: undefined, accurateShipmentCode: 'VI0005002' }],
  'the callback shipmentId is never used to read Telegraph');
checks++;

// Unknown references are logged, not synced.
reset();
result = await post(base, { refNumber: '#9999' }, auth);
check(result.status === 202 && result.json.matched === false, 'unknown reference is acknowledged as unmatched');
check(saved.length === 1 && synced.length === 0, 'unknown reference is saved for review only');

// JSON objects must never reach the Prisma filter as operators.
reset();
result = await post(base, { refNumber: { not: '' }, externalReference: ['#5001'] }, auth);
check(result.status === 202 && lookups.length === 0, 'object/array references are ignored');

reset();
result = await post(base, { shipmentId: 5001.5 }, auth);
check(lookups.length === 1 && lookups[0] === '5001.5', 'numeric references are looked up as text');

reset();
const raw = await fetch(base, { method: 'POST', headers: { ...auth, 'content-type': 'text/plain' }, body: 'hello' });
check(raw.status === 202, 'a non-JSON body is treated as unmatched instead of crashing');

reset();
syncFailure = true;
result = await post(base, { refNumber: '#5003' }, auth);
check(result.status === 500 && result.json.ok === false, 'a sync failure returns 500 without crashing the process');

server.close();
globalThis.fetch = loopbackFetch;
console.log(JSON.stringify({ ok: true, checks, externalCalls: 0 }));
