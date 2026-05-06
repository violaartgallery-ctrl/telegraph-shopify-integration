import { AccurateClient } from '../accurate/accurateClient.js';
import { AccurateMapper } from './accurateMapper.js';
import { failedPayloadService } from './failedPayloadService.js';
import { logger } from '../lib/logger.js';
import { shipmentRepository } from './shipmentRepository.js';
import { isOrderEligibleForShipment } from './orderEligibility.js';
import { shopifyFulfillmentClient } from '../shopify/shopifyFulfillmentClient.js';
import { shipmentCodeService } from './shipmentCodeService.js';
import type { ShopifyOrder } from '../types/shopify.js';

interface ProcessResult {
  skipped: boolean;
  reason?: string;
  fulfillment?: {
    skipped: boolean;
    reason?: string;
  };
}

const telegraphDashboardUrl = (shipmentId?: number | null): string | null =>
  shipmentId ? `https://system.telegraphex.com/admin/shipments/${shipmentId}` : null;

export class ShopifyOrderProcessor {
  constructor(
    private readonly accurateClient: AccurateClient,
    private readonly accurateMapper: AccurateMapper
  ) {}

  async process(
    order: ShopifyOrder,
    context?: Record<string, unknown> & { skipEligibility?: boolean; requireTelegraphLocation?: boolean }
  ): Promise<ProcessResult> {
    const orderId = String(order.id);
    const existing = await shipmentRepository.findByShopifyOrderId(orderId);
    if (existing?.accurateShipmentId) {
      const fulfillment = await this.fulfillShopifyOrder(order, {
        shipmentId: existing.accurateShipmentId,
        shipmentCode: existing.accurateShipmentCode,
        context
      });
      return { skipped: true, reason: 'duplicate-order', fulfillment };
    }

    if (!context?.skipEligibility && !isOrderEligibleForShipment(order)) {
      return { skipped: true, reason: 'order-not-eligible' };
    }

    await shipmentRepository.createPending(order);

    try {
      const shipmentCode = await shipmentCodeService.reserveForOrder(orderId);
      const shipmentInput = await this.accurateMapper.mapOrderToShipment(order, {
        requireTelegraphLocation: context?.requireTelegraphLocation,
        shipmentCode
      });
      const shipment = await this.accurateClient.saveShipment(shipmentInput);

      if (!shipment) {
        throw new Error('Accurate saveShipment returned null');
      }

      await shipmentRepository.markCreated(orderId, {
        id: shipment.id,
        code: shipment.code,
        status: shipment.status?.code ?? shipment.status?.name ?? 'CREATED'
      });

      logger.info('Shipment created successfully', {
        shopifyOrderId: orderId,
        accurateShipmentId: shipment.id,
        accurateShipmentCode: shipment.code
      });

      const fulfillment = await this.fulfillShopifyOrder(order, {
        shipmentId: shipment.id,
        shipmentCode: shipment.code,
        context
      });

      return { skipped: false, fulfillment };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown shipment creation error';
      await shipmentRepository.markFailed(orderId, message);
      await failedPayloadService.save({
        source: 'shopify-orders-create',
        externalId: orderId,
        reason: message,
        payload: order,
        headers: context
      });
      throw error;
    }
  }

  private async fulfillShopifyOrder(
    order: ShopifyOrder,
    params: {
      shipmentId?: number | null;
      shipmentCode?: string | null;
      context?: Record<string, unknown>;
    }
  ): Promise<{ skipped: boolean; reason?: string }> {
    try {
      const result = await shopifyFulfillmentClient.fulfillOrder({
        orderId: order.admin_graphql_api_id ?? order.id,
        trackingNumber: params.shipmentCode,
        trackingUrl: telegraphDashboardUrl(params.shipmentId)
      });

      logger.info('Shopify order fulfillment synced', {
        shopifyOrderId: String(order.id),
        skipped: result.skipped,
        reason: result.reason,
        fulfillmentIds: result.fulfillmentIds
      });

      return { skipped: result.skipped, reason: result.reason };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Shopify fulfillment error';
      logger.error('Failed to fulfill Shopify order after Telegraph shipment creation', {
        shopifyOrderId: String(order.id),
        reason: message
      });

      await failedPayloadService.save({
        source: 'shopify-fulfillment-create',
        externalId: String(order.id),
        reason: message,
        payload: {
          orderId: order.id,
          orderName: order.name,
          shipmentId: params.shipmentId,
          shipmentCode: params.shipmentCode
        },
        headers: params.context
      });

      return { skipped: true, reason: `fulfillment-error: ${message}` };
    }
  }
}
