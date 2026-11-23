import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { failedPayloadService } from '../services/failedPayloadService.js';
import { constantTimeTextEqual } from '../services/shopifyAdminAuth.js';
import type { ShipmentStatusSyncService } from '../services/shipmentStatusSyncService.js';
import { shipmentRepository } from '../services/shipmentRepository.js';
import type { AccurateShipmentStatusCallback } from '../types/shopify.js';

interface AccurateWebhookRecord {
  id: number;
  shopifyOrderId: string;
  accurateShipmentId: number | null;
  accurateShipmentCode: string | null;
}

export interface AccurateWebhookDependencies {
  webhookSecret: string;
  findByReference: (reference: string) => Promise<AccurateWebhookRecord | null>;
  saveFailedPayload: (params: {
    source: string;
    externalId?: string;
    reason: string;
    payload: unknown;
  }) => Promise<unknown>;
}

const defaultDependencies: AccurateWebhookDependencies = {
  webhookSecret: env.accurate.webhookSecret,
  findByReference: shipmentRepository.findByReference,
  saveFailedPayload: failedPayloadService.save
};

let accurateSecretWarnedOnce = false;

// JSON objects/arrays must never reach a Prisma `where` as a filter operator.
const referenceText = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
};

/**
 * A callback may only name the record to refresh. If it also carries a
 * shipment identity that differs from the stored one, it is held for review
 * instead of being applied to this order.
 */
const identifierConflict = (
  payload: AccurateShipmentStatusCallback,
  record: AccurateWebhookRecord
): string | null => {
  if (payload.shipmentId != null && record.accurateShipmentId != null &&
    Number(payload.shipmentId) !== Number(record.accurateShipmentId)) {
    return 'shipmentId';
  }
  if (payload.shipmentCode != null && record.accurateShipmentCode != null &&
    String(payload.shipmentCode) !== record.accurateShipmentCode) {
    return 'shipmentCode';
  }
  return null;
};

export const createAccurateWebhookHandler =
  (
    statusSyncService: Pick<ShipmentStatusSyncService, 'syncRecord'>,
    dependencies: AccurateWebhookDependencies = defaultDependencies
  ) =>
  async (request: Request, response: Response): Promise<void> => {
  // Fail closed: this route can change Shopify/Odoo state, so a deployment
  // without ACCURATE_WEBHOOK_SECRET refuses every call. Provide the same value
  // in Telegraph's webhook settings via x-accurate-webhook-secret (preferred)
  // or the webhookSecret query parameter.
  const webhookSecret = dependencies.webhookSecret;
  if (!webhookSecret) {
    if (!accurateSecretWarnedOnce) {
      logger.warn(
        'ACCURATE_WEBHOOK_SECRET is not set. ' +
        'The /webhooks/accurate/shipment-status endpoint rejects all calls until it is configured.'
      );
      accurateSecretWarnedOnce = true;
    }
    response.status(503).json({ ok: false, message: 'Accurate webhook is not configured' });
    return;
  }

  const queryProvided = request.query['webhookSecret'];
  const provided =
    request.header('x-accurate-webhook-secret') ??
    (typeof queryProvided === 'string' ? queryProvided : undefined);
  if (!provided || !constantTimeTextEqual(provided, webhookSecret)) {
    response.status(401).json({ ok: false, message: 'Invalid or missing Accurate webhook secret' });
    return;
  }

  const payload = (request.body ?? {}) as AccurateShipmentStatusCallback;
  const reference =
    referenceText(payload.refNumber) ??
    referenceText(payload.externalReference) ??
    referenceText(payload.shipmentCode) ??
    referenceText(payload.shipmentId);

  const record = reference ? await dependencies.findByReference(reference) : null;
  if (!record) {
    await dependencies.saveFailedPayload({
      source: 'accurate-shipment-status',
      externalId: reference,
      reason: 'No matching Shopify shipment record found',
      payload
    });

    response.status(202).json({ ok: true, matched: false });
    return;
  }

  const conflict = identifierConflict(payload, record);
  if (conflict) {
    await dependencies.saveFailedPayload({
      source: 'accurate-shipment-status',
      externalId: reference,
      reason: `Callback ${conflict} does not match the stored shipment for record ${record.id}`,
      payload
    });
    response.status(409).json({ ok: false, matched: true, message: 'Shipment identity mismatch' });
    return;
  }

  // Telegraph is re-read with the stored identity only; the callback's own
  // shipment fields never decide which shipment's state lands on this order.
  try {
    await statusSyncService.syncRecord({
      id: record.id,
      shopifyOrderId: record.shopifyOrderId,
      accurateShipmentId: record.accurateShipmentId ?? undefined,
      accurateShipmentCode: record.accurateShipmentCode ?? undefined
    });
  } catch (error) {
    logger.error('Accurate webhook status sync failed', {
      recordId: record.id,
      reason: error instanceof Error ? error.message : String(error)
    });
    response.status(500).json({ ok: false, matched: true });
    return;
  }

  response.status(200).json({ ok: true, matched: true });
};
