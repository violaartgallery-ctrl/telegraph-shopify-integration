import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { waitUntil } from '@vercel/functions';
import { AccurateClient } from './accurate/accurateClient.js';
import { AccurateZoneResolver } from './accurate/zoneResolver.js';
import { logger } from './lib/logger.js';
import { AccurateMapper } from './services/accurateMapper.js';
import { ShopifyOrderProcessor } from './services/shopifyOrderProcessor.js';
import { createAccurateWebhookHandler } from './routes/accurateWebhookRoute.js';
import { createAdminAppRouter, getLocations } from './routes/adminAppRoute.js';
import { createShopifyWebhookHandler } from './routes/shopifyWebhookRoute.js';
import { createOpsRouter } from './routes/opsRoute.js';
import { handler as telegramWebhookHandler } from './netlify/functions/telegram-webhook.js';
import { ShipmentStatusSyncService } from './services/shipmentStatusSyncService.js';
import { OdooClient } from './odoo/odooClient.js';
import { OdooSyncService } from './odoo/odooSyncService.js';
import { adminAuth } from './middleware/adminAuth.js';
import { env } from './config/env.js';
import { MetaDeliveryService } from './meta/metaDeliveryService.js';
import { verifyResumeRequest } from './services/productionContinuation.js';
import { resumeProductionInvocation } from './netlify/functions/run-production-background.js';

export const createAppServices = () => {
  const accurateClient = new AccurateClient();
  const zoneResolver = new AccurateZoneResolver(accurateClient);
  const accurateMapper = new AccurateMapper(zoneResolver);
  const odooSyncService = new OdooSyncService(new OdooClient());
  const shopifyOrderProcessor = new ShopifyOrderProcessor(accurateClient, accurateMapper, odooSyncService);
  const metaDeliveryService = new MetaDeliveryService({
    ...env.metaDelivered,
    testEventCode: env.metaDelivered.testEventCode || undefined
  });
  const shipmentStatusSyncService = new ShipmentStatusSyncService(
    accurateClient,
    odooSyncService,
    metaDeliveryService
  );

  return {
    accurateClient,
    shopifyOrderProcessor,
    shipmentStatusSyncService,
    odooSyncService,
    metaDeliveryService
  };
};

export const createApp = () => {
  const app = express();
  const services = createAppServices();

  app.use((request, response, next) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    // x-admin-secret is included so browser-based Shopify App Extension calls work
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Shopify-Hmac-Sha256,x-admin-secret');
    if (request.method === 'OPTIONS') {
      response.status(204).end();
      return;
    }
    next();
  });

  app.get('/health', (_request, response) => {
    response.status(200).json({ ok: true });
  });

  // A signed self-request gives a long batch a fresh Vercel execution window.
  // This route is deliberately outside /api (admin auth); it has its own HMAC,
  // timestamp replay protection, and a batch-id guard inside the job lease.
  app.post(
    '/internal/production/resume',
    express.text({ type: 'application/json', limit: '20kb' }),
    (request, response) => {
      const rawBody = typeof request.body === 'string' ? request.body : '';
      if (!verifyResumeRequest(request.headers, rawBody)) {
        response.status(401).json({ ok: false, message: 'Invalid continuation signature' });
        return;
      }

      let payload: { chatId?: unknown; batchId?: unknown; delayMs?: unknown };
      try {
        payload = JSON.parse(rawBody) as typeof payload;
      } catch {
        response.status(400).json({ ok: false, message: 'Invalid JSON' });
        return;
      }
      const chatId = Number(payload.chatId);
      const batchId = typeof payload.batchId === 'string' ? payload.batchId : '';
      const delayMs = Number(payload.delayMs ?? 0);
      if (!Number.isSafeInteger(chatId) || !batchId || !Number.isFinite(delayMs)) {
        response.status(400).json({ ok: false, message: 'Invalid continuation payload' });
        return;
      }

      waitUntil(resumeProductionInvocation(chatId, batchId, delayMs));
      response.status(202).json({ ok: true, batchId });
    }
  );

  // Scheduled ops (triggered by GitHub Actions every 30 min). Mounted before the
  // adminAuth guards because it lives under /ops (not /api) and self-guards via
  // OPS_SECRET.
  app.use(createOpsRouter(services.shipmentStatusSyncService, services.metaDeliveryService));

  // Public, read-only fallback for the Shopify theme. The local theme JSON is
  // primary; this endpoint must remain reachable without the admin secret when
  // Shopify's CDN asset is temporarily unavailable.
  app.get('/api/accurate/locations', async (_request, response, next) => {
    try {
      response.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
      response.json({ locations: await getLocations(services.accurateClient) });
    } catch (error) {
      next(error);
    }
  });

  // BUG-SEC-4 FIX: Protect all admin routes under /orders/* and /api/* with adminAuth.
  // Shopify webhook routes (/webhooks/*) are intentionally NOT protected here —
  // they use their own HMAC signature verification.
  app.use('/orders', adminAuth);
  app.use('/api', adminAuth);

  app.use(createAdminAppRouter(services.shopifyOrderProcessor, services.accurateClient, services.odooSyncService, services.shipmentStatusSyncService));

  app.post(
    '/webhooks/shopify/orders-create',
    express.raw({ type: 'application/json' }),
    createShopifyWebhookHandler(services.shopifyOrderProcessor)
  );

  app.post(
    '/webhooks/accurate/shipment-status',
    express.json({ limit: '1mb' }),
    createAccurateWebhookHandler(services.shipmentStatusSyncService)
  );

  // Telegram bot webhook. Not under /orders or /api, so it bypasses adminAuth; it
  // self-verifies via the x-telegram-bot-api-secret-token header inside the
  // handler. The handler acks fast and runs the /run pipeline via waitUntil.
  app.post('/telegram-webhook', express.json({ limit: '1mb' }), async (request, response) => {
    const result = await telegramWebhookHandler({
      httpMethod: request.method,
      headers: request.headers as Record<string, string | undefined>,
      body: JSON.stringify(request.body ?? {})
    });
    response.status(result.statusCode).send(result.body);
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    logger.error('Unhandled request error', error);
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    const status = typeof error === 'object' && error && 'statusCode' in error ? Number(error.statusCode) : 500;
    response.status(status).json({ ok: false, message });
  });

  return { app, services };
};
