import { AccurateClient } from '../accurate/accurateClient.js';
import { AccurateMapper } from './accurateMapper.js';
import { failedPayloadService } from './failedPayloadService.js';
import { logger } from '../lib/logger.js';
import { shipmentRepository } from './shipmentRepository.js';
import { isOrderEligibleForShipment } from './orderEligibility.js';
import { shopifyFulfillmentClient } from '../shopify/shopifyFulfillmentClient.js';
import { shipmentCodeService } from './shipmentCodeService.js';
import { ValidationError } from '../lib/errors.js';
import type { ShopifyOrder } from '../types/shopify.js';
import type { OdooSyncService } from '../odoo/odooSyncService.js';

interface ProcessResult {
  skipped: boolean;
  reason?: string;
  fulfillment?: {
    skipped: boolean;
    reason?: string;
  };
  odoo?: {
    skipped: boolean;
    reason?: string;
    saleOrderName?: string;
    created?: boolean;
  };
}

const telegraphDashboardUrl = (shipmentId?: number | null): string | null =>
  shipmentId ? `https://system.telegraphex.com/admin/shipments/${shipmentId}` : null;

const isDuplicateShipmentCodeError = (error: unknown): boolean => {
  if (!(error instanceof ValidationError)) return false;
  return JSON.stringify(error.details ?? error.message).includes('input.code');
};

export class ShopifyOrderProcessor {
  constructor(
    private readonly accurateClient: AccurateClient,
    private readonly accurateMapper: AccurateMapper,
    private readonly odooSyncService?: OdooSyncService
  ) {}

  async process(
    order: ShopifyOrder,
    context?: Record<string, unknown> & { skipEligibility?: boolean; requireTelegraphLocation?: boolean }
  ): Promise<ProcessResult> {
    const orderId = String(order.id);
    const existing = await shipmentRepository.findByShopifyOrderId(orderId);
    if (existing?.accurateShipmentId) {
      const existingShipment = await this.findExistingTelegraphShipment(
        existing.accurateShipmentId,
        existing.accurateShipmentCode
      );
      if (!existingShipment) {
        await shipmentRepository.clearDeletedShipment(orderId, 'Telegraph shipment was not found; recreating shipment');
      } else {
        const fulfillment = await this.fulfillShopifyOrder(order, {
          shipmentId: existing.accurateShipmentId,
          shipmentCode: existing.accurateShipmentCode,
          context
        });
        if (existing.odooSaleOrderId && existing.odooSaleOrderName) {
          return {
            skipped: true,
            reason: 'duplicate-order',
            fulfillment,
            odoo: {
              skipped: true,
              reason: 'odoo-sales-order-already-synced',
              saleOrderName: existing.odooSaleOrderName,
              created: false
            }
          };
        }
        const odoo = await this.syncOdooSalesOrder(order, {
          shipmentId: existing.accurateShipmentId,
          shipmentCode: existing.accurateShipmentCode,
          context
        });
        return { skipped: true, reason: 'duplicate-order', fulfillment, odoo };
      }
    }

    if (!context?.skipEligibility && !isOrderEligibleForShipment(order)) {
      return { skipped: true, reason: 'order-not-eligible' };
    }

    await shipmentRepository.createPending(order);

    try {
      let shipmentCode = await shipmentCodeService.reserveForOrder(orderId);
      const shipmentInput = await this.accurateMapper.mapOrderToShipment(order, {
        requireTelegraphLocation: context?.requireTelegraphLocation,
        shipmentCode
      });
      let shipment = await this.saveShipmentWithFreshCodeRetry(orderId, shipmentInput, shipmentCode);

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

      const odoo = await this.syncOdooSalesOrder(order, {
        shipmentId: shipment.id,
        shipmentCode: shipment.code,
        context
      });

      return { skipped: false, fulfillment, odoo };
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

  private async saveShipmentWithFreshCodeRetry(
    orderId: string,
    shipmentInput: Awaited<ReturnType<AccurateMapper['mapOrderToShipment']>>,
    initialShipmentCode?: string
  ) {
    let shipmentCode = initialShipmentCode;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await this.accurateClient.saveShipment({
          ...shipmentInput,
          code: shipmentCode
        });
      } catch (error) {
        if (!isDuplicateShipmentCodeError(error)) {
          throw error;
        }

        shipmentCode = await shipmentCodeService.reserveFreshForOrder(orderId);
        logger.warn('Telegraph shipment code already exists; retrying with a fresh code', {
          shopifyOrderId: orderId,
          nextShipmentCode: shipmentCode
        });
      }
    }

    throw new Error('Could not create Telegraph shipment after retrying fresh shipment codes');
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

  private async findExistingTelegraphShipment(
    shipmentId?: number | null,
    shipmentCode?: string | null
  ): Promise<{ id: number; code: string } | null> {
    try {
      const shipment = await this.accurateClient.getShipment({
        ...(shipmentId ? { id: shipmentId } : {}),
        ...(!shipmentId && shipmentCode ? { code: shipmentCode } : {})
      });
      return shipment ? { id: shipment.id, code: shipment.code } : null;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Telegraph shipment lookup error';
      if (/not found|404|cannot query field|does not exist|no shipment/i.test(message)) {
        return null;
      }
      throw error;
    }
  }

  private async syncOdooSalesOrder(
    order: ShopifyOrder,
    params: {
      shipmentId?: number | null;
      shipmentCode?: string | null;
      context?: Record<string, unknown>;
    }
  ): Promise<NonNullable<ProcessResult['odoo']>> {
    if (!this.odooSyncService) {
      return { skipped: true, reason: 'odoo-sync-not-configured' };
    }

    try {
      const saleOrder = await this.odooSyncService.ensureSalesOrder(order, {
        accurateShipmentCode: params.shipmentCode,
        trackingUrl: telegraphDashboardUrl(params.shipmentId)
      });
      await this.odooSyncService.confirmSalesOrderDelivery(saleOrder.id);

      logger.info('Odoo sales order delivery confirmed after Telegraph shipment', {
        shopifyOrderId: String(order.id),
        saleOrderId: saleOrder.id,
        saleOrderName: saleOrder.name,
        created: saleOrder.created
      });

      return {
        skipped: false,
        saleOrderName: saleOrder.name,
        created: saleOrder.created
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Odoo sales order error';
      logger.error('Failed to sync Odoo sales order after Telegraph shipment', {
        shopifyOrderId: String(order.id),
        reason: message
      });

      await failedPayloadService.save({
        source: 'odoo-sales-order-after-shipment',
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

      return { skipped: true, reason: `odoo-error: ${message}` };
    }
  }
}
