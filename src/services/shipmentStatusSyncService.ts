import { AccurateClient } from '../accurate/accurateClient.js';
import { logger } from '../lib/logger.js';
import { shopifyStatusSyncClient } from '../shopify/shopifyStatusSyncClient.js';
import { projectAccurateStatusToShopify } from './accurateStatusMapper.js';
import { failedPayloadService } from './failedPayloadService.js';
import { shipmentRepository } from './shipmentRepository.js';

const buildStatusNote = (params: {
  shipmentCode?: string | null;
  shipmentStatus: string;
  collectionStatus: string;
  collectedAmount?: number | null;
  pendingCollectionAmount?: number | null;
  returnedValue?: number | null;
  trackingUrl?: string | null;
}): string =>
  [
    `Accurate shipment sync`,
    `Shipment code: ${params.shipmentCode ?? 'n/a'}`,
    `Shipment status: ${params.shipmentStatus}`,
    `Collection status: ${params.collectionStatus}`,
    `Collected amount: ${params.collectedAmount ?? 0}`,
    `Pending collection amount: ${params.pendingCollectionAmount ?? 0}`,
    `Returned value: ${params.returnedValue ?? 0}`,
    params.trackingUrl ? `Tracking URL: ${params.trackingUrl}` : undefined
  ]
    .filter(Boolean)
    .join('\n');

export class ShipmentStatusSyncService {
  constructor(private readonly accurateClient: AccurateClient) {}

  async syncRecord(record: {
    id: number;
    shopifyOrderId: string;
    accurateShipmentId?: number | null;
    accurateShipmentCode?: string | null;
  }): Promise<void> {
    if (!record.accurateShipmentId && !record.accurateShipmentCode) {
      return;
    }

    const shipment = await this.accurateClient.getShipment({
      id: record.accurateShipmentId ?? undefined,
      code: record.accurateShipmentCode ?? undefined
    });

    if (!shipment) {
      throw new Error(`Accurate shipment not found for record ${record.id}`);
    }

    const projection = projectAccurateStatusToShopify({
      statusCode: shipment.status?.code,
      statusName: shipment.status?.name,
      returnStatusCode: shipment.returnStatus?.code,
      returnStatusName: shipment.returnStatus?.name,
      collected: shipment.collected,
      paidToCustomer: shipment.paidToCustomer,
      cancelled: shipment.cancelled
    });

    await shipmentRepository.updateAccurateSnapshot(record.id, {
      accurateStatus: projection.shipmentStatus,
      accurateReturnStatus: shipment.returnStatus?.name ?? shipment.returnStatus?.code ?? null,
      collectionStatus: projection.collectionStatus,
      trackingUrl: shipment.trackingUrl,
      collectedAmount: shipment.collectedAmount,
      pendingCollectionAmount: shipment.pendingCollectionAmount,
      returnedValue: shipment.returnedValue,
      deliveredAt: shipment.deliveredOrReturnedDate ? new Date(shipment.deliveredOrReturnedDate) : null
    });

    await shopifyStatusSyncClient.syncShipmentState({
      orderId: record.shopifyOrderId,
      shipmentStatus: projection.shipmentStatus,
      collectionStatus: projection.collectionStatus,
      collectedAmount: shipment.collectedAmount,
      returnedValue: shipment.returnedValue,
      trackingUrl: shipment.trackingUrl,
      tags: projection.tags,
      syncSummary: buildStatusNote({
        shipmentCode: shipment.code,
        shipmentStatus: projection.shipmentStatus,
        collectionStatus: projection.collectionStatus,
        collectedAmount: shipment.collectedAmount,
        pendingCollectionAmount: shipment.pendingCollectionAmount,
        returnedValue: shipment.returnedValue,
        trackingUrl: shipment.trackingUrl
      })
    });
  }

  async syncOpenShipments(): Promise<void> {
    const openShipments = await shipmentRepository.findOpenShipments();
    for (const record of openShipments) {
      try {
        await this.syncRecord(record);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Unknown sync error';
        logger.error('Failed to sync shipment record', { recordId: record.id, reason });
        await failedPayloadService.save({
          source: 'accurate-polling-sync',
          externalId: record.accurateShipmentCode ?? String(record.accurateShipmentId ?? record.id),
          reason,
          payload: record
        });
      }
    }
  }
}
