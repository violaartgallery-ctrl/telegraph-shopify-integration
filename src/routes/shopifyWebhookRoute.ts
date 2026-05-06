import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { ShopifyOrderProcessor } from '../services/shopifyOrderProcessor.js';
import type { ShopifyOrder } from '../types/shopify.js';
import { verifyShopifyWebhook } from '../shopify/verifyWebhook.js';

export const createShopifyWebhookHandler =
  (processor: ShopifyOrderProcessor) => async (request: Request, response: Response): Promise<void> => {
    const rawBody = request.body as Buffer;
    const signature = request.header('X-Shopify-Hmac-Sha256');

    if (!verifyShopifyWebhook(rawBody, signature, env.shopify.webhookSecret)) {
      throw new HttpError('Invalid Shopify webhook signature', 401);
    }

    const payload = JSON.parse(rawBody.toString('utf8')) as ShopifyOrder;
    const result = await processor.process(payload, request.headers as Record<string, unknown>);

    logger.info('Processed Shopify orders/create webhook', {
      orderId: payload.id,
      skipped: result.skipped,
      reason: result.reason
    });

    response.status(200).json({
      ok: true,
      ...result
    });
  };
