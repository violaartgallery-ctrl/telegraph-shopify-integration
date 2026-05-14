import { AccurateClient } from '../accurate/accurateClient.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { shopifyStatusSyncClient } from '../shopify/shopifyStatusSyncClient.js';
import { projectAccurateStatusToShopify } from './accurateStatusMapper.js';
import { failedPayloadService } from './failedPayloadService.js';
import { shipmentRepository } from './shipmentRepository.js';
import { OdooSyncService } from '../odoo/odooSyncService.js';

const buildStatusNote = (params: {
  shipmentCode?: string | null;
  shipmentStatus: string;
  collectionStatus: string;
  collectedAmount?: number | null;
  pendingCollectionAmount?: number | null;
  returnedValue?: number | null;
  deliveryFees?: number | null;
  returnFees?: number | null;
  returningDueFees?: number | null;
  customerDue?: number | null;
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
    `Delivery fees: ${params.deliveryFees ?? 0}`,
    `Return fees: ${params.returnFees ?? 0}`,
    `Returning due fees: ${params.returningDueFees ?? 0}`,
    `Customer due: ${params.customerDue ?? 0}`,
    params.trackingUrl ? `Tracking URL: ${params.trackingUrl}` : undefined
  ]
    .filter(Boolean)
    .join('\n');

export class ShipmentStatusSyncService {
  constructor(
    private readonly accurateClient: AccurateClient,
    private readonly odooSyncService?: OdooSyncService
  ) {}

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
      cancelled: shipment.cancelled,
      customerDue: shipment.customerDue
    });

    await shipmentRepository.updateAccurateSnapshot(record.id, {
      accurateStatus: projection.shipmentStatus,
      accurateStatusCode: shipment.status?.code ?? null,
      accurateReturnStatus: shipment.returnStatus?.name ?? shipment.returnStatus?.code ?? null,
      accurateReturnStatusCode: shipment.returnStatus?.code ?? null,
      accurateIsTerminal: projection.isTerminal,
      collectionStatus: projection.collectionStatus,
      trackingUrl: shipment.trackingUrl,
      collectedAmount: shipment.collectedAmount,
      pendingCollectionAmount: shipment.pendingCollectionAmount,
      returnedValue: shipment.returnedValue,
      deliveryFees: shipment.deliveryFees,
      returnFees: shipment.returnFees,
      returningDueFees: shipment.returningDueFees,
      customerDue: shipment.customerDue,
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
        deliveryFees: shipment.deliveryFees,
        returnFees: shipment.returnFees,
        returningDueFees: shipment.returningDueFees,
        customerDue: shipment.customerDue,
        trackingUrl: shipment.trackingUrl
      })
    });

    if (projection.collectionStatus === 'payment-review') {
      await failedPayloadService.save({
        source: 'payment-review',
        externalId: record.shopifyOrderId,
        reason: 'Telegraph delivered shipment needs manual payment review',
        payload: {
          record,
          shipment: {
            code: shipment.code,
            statusCode: shipment.status?.code,
            customerDue: shipment.customerDue,
            collectedAmount: shipment.collectedAmount,
            deliveryFees: shipment.deliveryFees,
            returnFees: shipment.returnFees,
            returningDueFees: shipment.returningDueFees
          }
        }
      });
      return;
    }

    if (projection.collectionStatus === 'collected' && this.odooSyncService) {
      try {
        await this.odooSyncService.syncCollectedShipment(record.id);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Unknown Odoo sync error';
        logger.error('Failed to sync collected shipment to Odoo', {
          recordId: record.id,
          shopifyOrderId: record.shopifyOrderId,
          reason
        });
        await failedPayloadService.save({
          source: 'odoo-collected-sync',
          externalId: record.shopifyOrderId,
          reason,
          payload: record
        });
      }
    }

    if (projection.collectionStatus === 'collected') {
      try {
        const markResult = await shopifyStatusSyncClient.markOrderAsPaid(record.shopifyOrderId);
        if (markResult.skipped) {
          logger.info('Shopify order already paid — mark-as-paid skipped', {
            shopifyOrderId: record.shopifyOrderId,
            reason: markResult.reason
          });
        } else {
          logger.info('Shopify order marked as paid', {
            shopifyOrderId: record.shopifyOrderId,
            financialStatus: markResult.financialStatus
          });
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Unknown Shopify mark-as-paid error';
        logger.error('Failed to mark Shopify order as paid', {
          recordId: record.id,
          shopifyOrderId: record.shopifyOrderId,
          reason
        });
        await failedPayloadService.save({
          source: 'shopify-mark-as-paid',
          externalId: record.shopifyOrderId,
          reason,
          payload: record
        });
      }
    }

    if ((projection.collectionStatus === 'returned' || projection.collectionStatus === 'returned-settled') && this.odooSyncService) {
      try {
        await this.odooSyncService.syncReturnedShipmentCharge(record.id);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Unknown Odoo return charge sync error';
        logger.error('Failed to sync returned shipment charge to Odoo', {
          recordId: record.id,
          shopifyOrderId: record.shopifyOrderId,
          reason
        });
        await failedPayloadService.save({
          source: 'odoo-return-charge-sync',
          externalId: record.shopifyOrderId,
          reason,
          payload: record
        });
      }
    }
  }

  async syncOpenShipments(): Promise<{ processed: number; failed: number; skipped: number }> {
    // Time-budget guard: stop before Netlify cuts us off.
    // Records not reached this run remain open and retry next scheduled run.
    const budgetMs = env.syncTimeBudgetMs;
    const startTime = Date.now();

    // Concurrency: process up to 3 shipments in parallel per batch.
    // Each syncRecord is independent (separate SO / invoice / payment) so parallel is safe.
    // Running in parallel means 3 shipments complete in the time of the slowest one (~11s)
    // instead of ~27s sequentially — safely within the 20s budget.
    const CONCURRENCY = 3;

    const openShipments = await shipmentRepository.findOpenShipments(env.syncOpenShipmentsBatchSize);
    let processed = 0;
    let failed = 0;
    let skipped = 0;

    for (let i = 0; i < openShipments.length; i += CONCURRENCY) {
      const elapsedMs = Date.now() - startTime;
      if (elapsedMs >= budgetMs) {
        skipped = openShipments.length - processed - failed;
        logger.warn('syncOpenShipments time budget exhausted — stopping early; skipped records will retry next run', {
          processed,
          failed,
          skipped,
          elapsedMs,
          budgetMs
        });
        break;
      }

      const batch = openShipments.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map((record) => this.syncRecord(record)));

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        const record = batch[j];
        if (result.status === 'fulfilled') {
          processed += 1;
        } else {
          failed += 1;
          const reason = result.reason instanceof Error ? result.reason.message : 'Unknown sync error';
          logger.error('Failed to sync shipment record', { recordId: record.id, reason });
          if (/shipment not found/i.test(reason)) {
            await shipmentRepository.clearDeletedShipment(record.shopifyOrderId, reason);
          }
          await failedPayloadService.save({
            source: 'accurate-polling-sync',
            externalId: record.accurateShipmentCode ?? String(record.accurateShipmentId ?? record.id),
            reason,
            payload: record
          });
        }
      }
    }

    logger.info('syncOpenShipments complete', { processed, failed, skipped, elapsedMs: Date.now() - startTime });
    return { processed, failed, skipped };
  }
}
