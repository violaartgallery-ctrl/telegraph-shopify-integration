import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { failedPayloadService } from '../services/failedPayloadService.js';
import { ShipmentStatusSyncService } from '../services/shipmentStatusSyncService.js';
import { shipmentRepository } from '../services/shipmentRepository.js';
import type { AccurateShipmentStatusCallback } from '../types/shopify.js';

let accurateSecretWarnedOnce = false;

export const createAccurateWebhookHandler =
  (statusSyncService: ShipmentStatusSyncService) =>
  async (request: Request, response: Response): Promise<void> => {
  // BUG-SEC-2 FIX: Validate shared secret on every incoming Accurate/Telegraph webhook call.
  // Configure ACCURATE_WEBHOOK_SECRET in env; provide the same value in Telegraph's webhook settings.
  // Accept via header (x-accurate-webhook-secret) or query param (webhookSecret).
  const webhookSecret = env.accurate.webhookSecret;
  if (webhookSecret) {
    const provided =
      request.header('x-accurate-webhook-secret') ??
      (request.query['webhookSecret'] as string | undefined);
    if (!provided || provided !== webhookSecret) {
      response.status(401).json({ ok: false, message: 'Invalid or missing Accurate webhook secret' });
      return;
    }
  } else if (!accurateSecretWarnedOnce) {
    logger.warn(
      'ACCURATE_WEBHOOK_SECRET is not set. ' +
      'The /webhooks/accurate/shipment-status endpoint accepts unauthenticated calls. ' +
      'Set ACCURATE_WEBHOOK_SECRET to protect it.'
    );
    accurateSecretWarnedOnce = true;
  }

  const payload = request.body as AccurateShipmentStatusCallback;
  const reference =
    payload.refNumber ?? payload.externalReference ?? payload.shipmentCode ?? String(payload.shipmentId ?? '');

  const record = reference ? await shipmentRepository.findByReference(reference) : null;
  if (!record) {
    await failedPayloadService.save({
      source: 'accurate-shipment-status',
      externalId: reference,
      reason: 'No matching Shopify shipment record found',
      payload
    });

    response.status(202).json({ ok: true, matched: false });
    return;
  }

  await statusSyncService.syncRecord({
    id: record.id,
    shopifyOrderId: record.shopifyOrderId,
    accurateShipmentId: payload.shipmentId ?? record.accurateShipmentId ?? undefined,
    accurateShipmentCode: payload.shipmentCode ?? record.accurateShipmentCode ?? undefined
  });

  response.status(200).json({ ok: true, matched: true });
};
