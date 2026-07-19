import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createAdminAuth } from '../middleware/adminAuth.js';
import {
  mintAdminCapability,
  verifyAdminCapability,
  verifyShopifySessionToken,
  type ShopifySessionClaims
} from '../services/shopifyAdminAuth.js';

const config = {
  adminSecretToken: 'legacy-secret-for-transition',
  shopifyClientId: 'client-id-123',
  shopifyClientSecret: 'shopify-shared-secret',
  shopifyShopDomain: 'violaleather.myshopify.com'
};
const now = Math.floor(Date.now() / 1000);

const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

const makeSessionToken = (overrides: Partial<ShopifySessionClaims> = {}): string => {
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    iss: 'https://violaleather.myshopify.com/admin',
    dest: 'https://violaleather.myshopify.com',
    aud: config.shopifyClientId,
    sub: 'staff-user-42',
    exp: now + 60,
    nbf: now - 1,
    iat: now - 1,
    ...overrides
  });
  const signed = `${header}.${payload}`;
  const signature = createHmac('sha256', config.shopifyClientSecret)
    .update(signed)
    .digest('base64url');
  return `${signed}.${signature}`;
};

const validToken = makeSessionToken();
const valid = verifyShopifySessionToken(validToken, {
  clientId: config.shopifyClientId,
  clientSecret: config.shopifyClientSecret,
  shopDomain: config.shopifyShopDomain,
  nowSeconds: now
});
assert.equal(valid.ok, true);

assert.equal(verifyShopifySessionToken(`${validToken.slice(0, -1)}x`, {
  clientId: config.shopifyClientId,
  clientSecret: config.shopifyClientSecret,
  shopDomain: config.shopifyShopDomain,
  nowSeconds: now
}).ok, false);
assert.equal(verifyShopifySessionToken(makeSessionToken({ exp: now - 30 }), {
  clientId: config.shopifyClientId,
  clientSecret: config.shopifyClientSecret,
  shopDomain: config.shopifyShopDomain,
  nowSeconds: now
}).ok, false);
assert.equal(verifyShopifySessionToken(makeSessionToken({ aud: 'wrong-client' }), {
  clientId: config.shopifyClientId,
  clientSecret: config.shopifyClientSecret,
  shopDomain: config.shopifyShopDomain,
  nowSeconds: now
}).ok, false);
assert.equal(verifyShopifySessionToken(makeSessionToken({ dest: 'https://attacker.myshopify.com' }), {
  clientId: config.shopifyClientId,
  clientSecret: config.shopifyClientSecret,
  shopDomain: config.shopifyShopDomain,
  nowSeconds: now
}).ok, false);

const capability = mintAdminCapability(valid.claims, {
  clientSecret: config.shopifyClientSecret,
  shopDomain: config.shopifyShopDomain,
  nowSeconds: now,
  ttlSeconds: 600
});
assert.equal(verifyAdminCapability(capability, {
  clientSecret: config.shopifyClientSecret,
  shopDomain: config.shopifyShopDomain,
  nowSeconds: now
}).ok, true);
assert.equal(verifyAdminCapability(capability, {
  clientSecret: config.shopifyClientSecret,
  shopDomain: config.shopifyShopDomain,
  nowSeconds: now + 601
}).ok, false);

const app = express();
app.use('/locked', createAdminAuth({ ...config, adminSecretToken: '' }));
app.use('/locked', (request, response) => {
  response.json({ ok: true, adminToken: request.query.adminToken ?? null });
});
app.use(createAdminAuth(config));
app.use((request, response) => {
  response.json({ ok: true, adminToken: request.query.adminToken ?? null });
});
const server = app.listen(0);
await once(server, 'listening');

try {
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  assert.equal((await fetch(`${base}/locked`)).status, 401);
  assert.equal((await fetch(`${base}/locked?id_token=${encodeURIComponent(validToken)}`)).status, 200);
  assert.equal((await fetch(`${base}/orders/test`)).status, 401);
  assert.equal((await fetch(`${base}/orders/test?adminToken=${encodeURIComponent(config.adminSecretToken)}`)).status, 401);
  assert.equal((await fetch(`${base}/orders/test`, {
    headers: { 'x-admin-secret': config.adminSecretToken }
  })).status, 200);
  assert.equal((await fetch(`${base}/orders/test?adminToken=${encodeURIComponent(config.adminSecretToken)}&id_token=${encodeURIComponent(validToken)}`)).status, 200);

  const tokenResponse = await fetch(`${base}/orders/test?id_token=${encodeURIComponent(validToken)}`);
  assert.equal(tokenResponse.status, 200);
  const tokenBody = await tokenResponse.json() as { adminToken: string };
  assert.ok(tokenBody.adminToken.startsWith('adm1.'));
  assert.equal((await fetch(`${base}/orders/test?adminToken=${encodeURIComponent(tokenBody.adminToken)}`)).status, 200);

  assert.equal((await fetch(`${base}/api/test`, {
    headers: { Authorization: `Bearer ${validToken}` }
  })).status, 200);

  const invalidBearer = await fetch(`${base}/api/test`, {
    headers: { Authorization: 'Bearer invalid' }
  });
  assert.equal(invalidBearer.status, 401);
  assert.equal(invalidBearer.headers.get('x-shopify-retry-invalid-session-request'), '1');

  const bounce = await fetch(`${base}/orders/test?embedded=1&shop=violaleather.myshopify.com&host=abc`, {
    redirect: 'manual'
  });
  assert.equal(bounce.status, 302);
  assert.match(bounce.headers.get('location') ?? '', /^\/session-token-bounce\?/);
  assert.match(bounce.headers.get('location') ?? '', /shopify-reload=/);
  assert.equal((await fetch(`${base}/orders/test?embedded=1&shop=violaleather.myshopify.com&host=abc&_shopifyAuthBounce=1`)).status, 401);
} finally {
  server.close();
  await once(server, 'close');
}

console.log('Admin authentication tests passed: 18 checks.');
