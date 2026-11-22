import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createOpsRouter } from '../routes/opsRoute.js';
import type { ShipmentStatusSyncService } from '../services/shipmentStatusSyncService.js';
import { createApp } from '../app.js';

const savedHold = process.env.OPS_AUTOMATION_HOLD;
const savedSecret = process.env.OPS_SECRET;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('No external request is allowed in hold tests'); };
process.env.OPS_AUTOMATION_HOLD = 'neon-quota-reconciliation-required';
process.env.OPS_SECRET = 'test-only-ops-secret';
const service = new Proxy({}, { get() { throw new Error('Hold must not access business services'); } }) as ShipmentStatusSyncService;
const app = express();
app.use(createOpsRouter(service));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
let checks = 0;
try {
  for (const [path, method] of [
    ['/ops/process-odoo-queue', 'POST'], ['/ops/process-return-queue?apply=1', 'POST'],
    ['/ops/process-shopify-payment-queue?apply=1', 'POST'], ['/ops/process-odoo-collection-queue?apply=1', 'POST'],
    ['/ops/sync-open-shipments', 'GET'], ['/ops/resume-production-jobs', 'GET'],
    ['/ops/meta-delivered/drain', 'POST'], ['/ops/refresh-location-catalog', 'POST'],
    ['/ops/production-health', 'GET'], ['/ops/financial-health', 'GET'],
  ]) {
    const denied = await originalFetch(base + path, { method });
    assert.equal(denied.status, 401); checks++;
    const held = await originalFetch(base + path, { method, headers: { 'x-ops-secret': 'test-only-ops-secret' } });
    assert.equal(held.status, 503); assert.equal((await held.json()).reason, 'operator-reconciliation-hold'); checks += 2;
  }
  const ensure = await originalFetch(base + '/ops/scheduler/ensure', { headers: { 'x-ops-secret': 'test-only-ops-secret' } });
  assert.equal(ensure.status, 200);
  assert.deepEqual(await ensure.json(), { ok: true, enabled: false, primaryHealthy: false, fallbackAllowed: false, reason: 'operator-reconciliation-hold' });
  checks += 2;
  const health = await originalFetch(base + '/ops/scheduler/health', { headers: { 'x-ops-secret': 'test-only-ops-secret' } });
  assert.equal(health.status, 503); assert.equal((await health.json()).reason, 'operator-reconciliation-hold'); checks += 2;
  const appServer = createApp().app.listen(0, '127.0.0.1');
  await once(appServer, 'listening');
  const appBase = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
  try {
    for (const [path, method] of [
      ['/webhooks/shopify/orders-create', 'POST'], ['/webhooks/accurate/shipment-status', 'POST'],
      ['/telegram-webhook', 'POST'], ['/internal/production/resume', 'POST'],
      ['/orders/make-telegraph', 'GET'], ['/api/orders', 'POST'],
    ]) {
      const held = await originalFetch(appBase + path, { method });
      assert.equal(held.status, 503); assert.equal((await held.json()).reason, 'operator-reconciliation-hold'); checks += 2;
    }
    const live = await originalFetch(appBase + '/health');
    assert.equal(live.status, 200); checks++;
  } finally { appServer.close(); appServer.closeAllConnections(); }
  console.log(JSON.stringify({ ok: true, checks, externalCalls: 0 }));
} finally {
  server.close(); server.closeAllConnections();
  globalThis.fetch = originalFetch;
  if (savedHold === undefined) delete process.env.OPS_AUTOMATION_HOLD; else process.env.OPS_AUTOMATION_HOLD = savedHold;
  if (savedSecret === undefined) delete process.env.OPS_SECRET; else process.env.OPS_SECRET = savedSecret;
}
