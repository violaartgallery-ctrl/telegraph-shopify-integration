import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { AccurateClient } from './accurate/accurateClient.js';
import { AccurateZoneResolver } from './accurate/zoneResolver.js';
import { logger } from './lib/logger.js';
import { AccurateMapper } from './services/accurateMapper.js';
import { ShopifyOrderProcessor } from './services/shopifyOrderProcessor.js';
import { createAccurateWebhookHandler } from './routes/accurateWebhookRoute.js';
import { createAdminAppRouter } from './routes/adminAppRoute.js';
import { createShopifyWebhookHandler } from './routes/shopifyWebhookRoute.js';
import { ShipmentStatusSyncService } from './services/shipmentStatusSyncService.js';

export const createAppServices = () => {
  const accurateClient = new AccurateClient();
  const zoneResolver = new AccurateZoneResolver(accurateClient);
  const accurateMapper = new AccurateMapper(zoneResolver);
  const shopifyOrderProcessor = new ShopifyOrderProcessor(accurateClient, accurateMapper);
  const shipmentStatusSyncService = new ShipmentStatusSyncService(accurateClient);

  return {
    accurateClient,
    shopifyOrderProcessor,
    shipmentStatusSyncService
  };
};

export const createApp = () => {
  const app = express();
  const services = createAppServices();

  app.use((request, response, next) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Shopify-Hmac-Sha256');
    if (request.method === 'OPTIONS') {
      response.status(204).end();
      return;
    }
    next();
  });

  app.get('/health', (_request, response) => {
    response.status(200).json({ ok: true });
  });

  app.use(createAdminAppRouter(services.shopifyOrderProcessor, services.accurateClient));

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

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    logger.error('Unhandled request error', error);
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    const status = typeof error === 'object' && error && 'statusCode' in error ? Number(error.statusCode) : 500;
    response.status(status).json({ ok: false, message });
  });

  return { app, services };
};
