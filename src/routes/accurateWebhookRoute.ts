import type { Request, Response } from 'express';
import { failedPayloadService } from '../services/failedPayloadService.js';
import { ShipmentStatusSyncService } from '../services/shipmentStatusSyncService.js';
import { shipmentRepository } from '../services/shipmentRepository.js';
import type { AccurateShipmentStatusCallback } from '../types/shopify.js';

export const createAccurateWebhookHandler =
  (statusSyncService: ShipmentStatusSyncService) =>
  async (request: Request, response: Response): Promise<void> => {
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
