import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ShopifySessionClaims {
  iss: string;
  dest: string;
  aud: string | string[];
  sub: string;
  exp: number;
  nbf: number;
  iat?: number;
  [claim: string]: unknown;
}

export interface AdminCapabilityClaims {
  v: 1;
  shop: string;
  sub: string;
  iat: number;
  exp: number;
}

export type TokenVerification<T> =
  | { ok: true; claims: T }
  | { ok: false; reason: string };

interface ShopifySessionVerificationConfig {
  clientId: string;
  clientSecret: string;
  shopDomain: string;
  nowSeconds?: number;
  clockSkewSeconds?: number;
}

interface AdminCapabilityConfig {
  clientSecret: string;
  shopDomain: string;
  nowSeconds?: number;
  ttlSeconds?: number;
  maxTtlSeconds?: number;
}

const ADMIN_CAPABILITY_PREFIX = 'adm1';
const DEFAULT_CAPABILITY_TTL_SECONDS = 60 * 60;
const DEFAULT_MAX_CAPABILITY_TTL_SECONDS = 2 * 60 * 60;

const normalizeShopDomain = (value: string): string => {
  const trimmed = value.trim().toLowerCase().replace(/\/$/, '');
  if (!trimmed) return '';

  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return '';
  }
};

const decodeJsonPart = (value: string): unknown =>
  JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;

const sign = (value: string, secret: string): Buffer =>
  createHmac('sha256', secret).update(value).digest();

const verifySignature = (signedValue: string, encodedSignature: string, secret: string): boolean => {
  try {
    const expected = sign(signedValue, secret);
    const provided = Buffer.from(encodedSignature, 'base64url');
    return expected.length === provided.length && timingSafeEqual(expected, provided);
  } catch {
    return false;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export const constantTimeTextEqual = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

export const verifyShopifySessionToken = (
  token: string,
  config: ShopifySessionVerificationConfig
): TokenVerification<ShopifySessionClaims> => {
  if (token.length > 8_192 || !config.clientId || !config.clientSecret) {
    return { ok: false, reason: 'invalid-token-config' };
  }
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed-token' };

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  let header: unknown;
  let payload: unknown;
  try {
    header = decodeJsonPart(encodedHeader);
    payload = decodeJsonPart(encodedPayload);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }

  if (!isRecord(header) || header.alg !== 'HS256') {
    return { ok: false, reason: 'invalid-algorithm' };
  }
  if (!verifySignature(`${encodedHeader}.${encodedPayload}`, encodedSignature, config.clientSecret)) {
    return { ok: false, reason: 'invalid-signature' };
  }
  if (!isRecord(payload)) return { ok: false, reason: 'invalid-payload' };

  const now = config.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = config.clockSkewSeconds ?? 5;
  if (!isFiniteNumber(payload.exp) || payload.exp <= now - skew) {
    return { ok: false, reason: 'expired' };
  }
  if (!isFiniteNumber(payload.nbf) || payload.nbf > now + skew) {
    return { ok: false, reason: 'not-active' };
  }
  if (payload.iat !== undefined && (!isFiniteNumber(payload.iat) || payload.iat > now + skew)) {
    return { ok: false, reason: 'invalid-issued-at' };
  }

  const audience = payload.aud;
  const audienceMatches = typeof audience === 'string'
    ? audience === config.clientId
    : Array.isArray(audience) && audience.some((entry) => entry === config.clientId);
  if (!audienceMatches) return { ok: false, reason: 'invalid-audience' };

  if (typeof payload.dest !== 'string' || typeof payload.iss !== 'string') {
    return { ok: false, reason: 'invalid-shop-claims' };
  }

  let destination: URL;
  let issuer: URL;
  try {
    destination = new URL(payload.dest);
    issuer = new URL(payload.iss);
  } catch {
    return { ok: false, reason: 'invalid-shop-urls' };
  }

  const expectedShop = normalizeShopDomain(config.shopDomain);
  const destinationHost = destination.hostname.toLowerCase();
  const issuerHost = issuer.hostname.toLowerCase();
  if (
    destination.protocol !== 'https:' ||
    issuer.protocol !== 'https:' ||
    !expectedShop ||
    destinationHost !== expectedShop ||
    issuerHost !== destinationHost ||
    !(issuer.pathname === '/admin' || issuer.pathname.startsWith('/admin/'))
  ) {
    return { ok: false, reason: 'invalid-shop' };
  }

  if (typeof payload.sub !== 'string' || !payload.sub.trim()) {
    return { ok: false, reason: 'missing-user' };
  }

  return { ok: true, claims: payload as ShopifySessionClaims };
};

export const mintAdminCapability = (
  session: ShopifySessionClaims,
  config: AdminCapabilityConfig
): string => {
  const now = config.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = Math.min(
    Math.max(60, config.ttlSeconds ?? DEFAULT_CAPABILITY_TTL_SECONDS),
    config.maxTtlSeconds ?? DEFAULT_MAX_CAPABILITY_TTL_SECONDS
  );
  const payload: AdminCapabilityClaims = {
    v: 1,
    shop: normalizeShopDomain(session.dest),
    sub: session.sub,
    iat: now,
    exp: now + ttl
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signedValue = `${ADMIN_CAPABILITY_PREFIX}.${encodedPayload}`;
  const signature = sign(signedValue, config.clientSecret).toString('base64url');
  return `${signedValue}.${signature}`;
};

export const verifyAdminCapability = (
  token: string,
  config: AdminCapabilityConfig
): TokenVerification<AdminCapabilityClaims> => {
  if (token.length > 2_048 || !config.clientSecret) {
    return { ok: false, reason: 'invalid-capability-config' };
  }
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== ADMIN_CAPABILITY_PREFIX) {
    return { ok: false, reason: 'malformed-capability' };
  }

  const [prefix, encodedPayload, encodedSignature] = parts;
  if (!verifySignature(`${prefix}.${encodedPayload}`, encodedSignature, config.clientSecret)) {
    return { ok: false, reason: 'invalid-capability-signature' };
  }

  let payload: unknown;
  try {
    payload = decodeJsonPart(encodedPayload);
  } catch {
    return { ok: false, reason: 'invalid-capability-json' };
  }
  if (!isRecord(payload)) return { ok: false, reason: 'invalid-capability-payload' };

  const now = config.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxTtl = config.maxTtlSeconds ?? DEFAULT_MAX_CAPABILITY_TTL_SECONDS;
  if (
    payload.v !== 1 ||
    typeof payload.shop !== 'string' ||
    typeof payload.sub !== 'string' ||
    !payload.sub ||
    !isFiniteNumber(payload.iat) ||
    !isFiniteNumber(payload.exp) ||
    payload.iat > now + 5 ||
    payload.exp <= now ||
    payload.exp - payload.iat > maxTtl ||
    normalizeShopDomain(payload.shop) !== normalizeShopDomain(config.shopDomain)
  ) {
    return { ok: false, reason: 'invalid-capability-claims' };
  }

  return { ok: true, claims: payload as unknown as AdminCapabilityClaims };
};
