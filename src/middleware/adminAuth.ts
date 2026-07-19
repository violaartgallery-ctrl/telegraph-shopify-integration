import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import {
  constantTimeTextEqual,
  mintAdminCapability,
  verifyAdminCapability,
  verifyShopifySessionToken
} from '../services/shopifyAdminAuth.js';

export interface AdminAuthConfig {
  adminSecretToken: string;
  shopifyClientId: string;
  shopifyClientSecret: string;
  shopifyShopDomain: string;
}

const queryString = (request: Request, name: string): string | undefined => {
  const value = request.query[name];
  return typeof value === 'string' && value ? value : undefined;
};

const bearerToken = (request: Request): string | undefined => {
  const authorization = request.header('authorization');
  if (!authorization?.startsWith('Bearer ')) return undefined;
  const token = authorization.slice('Bearer '.length).trim();
  return token || undefined;
};

const isEmbeddedDocumentRequest = (request: Request): boolean =>
  (request.method === 'GET' || request.method === 'HEAD') &&
  (request.baseUrl === '/orders' || request.originalUrl.startsWith('/orders/')) &&
  request.header('authorization') === undefined &&
  queryString(request, 'embedded') === '1' &&
  Boolean(queryString(request, 'shop')) &&
  Boolean(queryString(request, 'host'));

const bounceLocation = (request: Request): string => {
  const current = new URL(request.originalUrl, 'https://shopify-app.invalid');
  const cleanParams = new URLSearchParams(current.searchParams);
  cleanParams.delete('id_token');
  cleanParams.delete('adminToken');
  cleanParams.delete('shopify-reload');
  const reloadParams = new URLSearchParams(cleanParams);
  reloadParams.set('_shopifyAuthBounce', '1');
  const reloadTarget = `${current.pathname}?${reloadParams.toString()}`;
  cleanParams.set('shopify-reload', reloadTarget);
  return `/session-token-bounce?${cleanParams.toString()}`;
};

export const createAdminAuth = (config: AdminAuthConfig) =>
  (request: Request, response: Response, next: NextFunction): void => {
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');

    // The long-lived operations secret is header-only. Shopify Admin links use
    // signed id_token values and never contain this secret in their URLs.
    const secretHeader = request.header('x-admin-secret');
    if (
      secretHeader &&
      config.adminSecretToken &&
      constantTimeTextEqual(secretHeader, config.adminSecretToken)
    ) {
      next();
      return;
    }

    // A short-lived capability is minted only after a valid Shopify id_token.
    // Existing server-rendered forms propagate it without exposing app secrets.
    const providedCapability = queryString(request, 'adminToken') ?? secretHeader;
    if (providedCapability) {
      const capability = verifyAdminCapability(providedCapability, {
        clientSecret: config.shopifyClientSecret,
        shopDomain: config.shopifyShopDomain
      });
      if (capability.ok) {
        next();
        return;
      }
    }

    const sessionToken = bearerToken(request) ?? queryString(request, 'id_token');
    if (sessionToken) {
      const verified = verifyShopifySessionToken(sessionToken, {
        clientId: config.shopifyClientId,
        clientSecret: config.shopifyClientSecret,
        shopDomain: config.shopifyShopDomain
      });
      if (verified.ok) {
        const capability = mintAdminCapability(verified.claims, {
          clientSecret: config.shopifyClientSecret,
          shopDomain: config.shopifyShopDomain
        });
        (request.query as Record<string, unknown>).adminToken = capability;
        next();
        return;
      }
    }

    if (
      isEmbeddedDocumentRequest(request) &&
      queryString(request, '_shopifyAuthBounce') !== '1'
    ) {
      response.redirect(302, bounceLocation(request));
      return;
    }

    if (request.header('authorization')) {
      response.setHeader('X-Shopify-Retry-Invalid-Session-Request', '1');
    }
    response.status(401).json({ ok: false, message: 'Unauthorized Shopify admin request.' });
  };

export const adminAuth = createAdminAuth({
  adminSecretToken: env.adminSecretToken,
  shopifyClientId: env.shopify.clientId,
  shopifyClientSecret: env.shopify.clientSecret,
  shopifyShopDomain: env.shopify.shopDomain
});
