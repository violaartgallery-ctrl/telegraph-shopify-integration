/**
 * One-time repair for Viola orders #1946 and #1947.
 *
 * This script writes to production integrations:
 * - clears unusable Telegraph shipment links from ShipmentRecord
 * - creates fresh Telegraph shipments through the normal ShopifyOrderProcessor
 * - verifies/recreates Odoo Sales Orders only if the existing DB-linked SO is missing
 * - updates tracking on already-fulfilled Shopify orders when possible
 *
 * It does NOT deploy.
 */
import { createAppServices } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { shipmentRepository } from '../services/shipmentRepository.js';
import { shopifyOrdersClient } from '../shopify/shopifyOrdersClient.js';
import { requestShopifyAdmin } from '../shopify/shopifyAdminGraphql.js';
import { OdooClient } from '../odoo/odooClient.js';
import type { ShopifyOrder } from '../types/shopify.js';

const TARGETS = [
  { name: '#1946', legacyId: '10589568336164' },
  { name: '#1947', legacyId: '10589613588772' }
];

const { accurateClient, shopifyOrderProcessor } = createAppServices();
const odooClient = new OdooClient();

const trackingUrl = (shipmentId?: number | null): string | null =>
  shipmentId ? `https://system.telegraphex.com/admin/shipments/${shipmentId}` : null;

async function findOdooSaleOrder(id?: number | null, name?: string | null) {
  if (id) {
    const [byId] = await odooClient.searchRead<any>(
      'sale.order',
      [['id', '=', id]],
      ['id', 'name', 'state', 'client_order_ref', 'origin'],
      { limit: 1 }
    );
    if (byId) return byId;
  }
  if (name) {
    const [byName] = await odooClient.searchRead<any>(
      'sale.order',
      [['name', '=', name]],
      ['id', 'name', 'state', 'client_order_ref', 'origin'],
      { limit: 1 }
    );
    if (byName) return byName;
  }
  return null;
}

async function updateFulfillmentTrackingIfAlreadyFulfilled(order: ShopifyOrder, shipmentCode?: string | null, shipmentId?: number | null) {
  if (order.fulfillment_status !== 'fulfilled' || !shipmentCode || !shipmentId) {
    return { skipped: true, reason: 'not-already-fulfilled-or-missing-shipment' };
  }

  const query = `
    query OrderFulfillments($id: ID!) {
      order(id: $id) {
        id
        name
        fulfillments(first: 10) {
          id
          status
          trackingInfo {
            number
            url
            company
          }
        }
      }
    }
  `;
  const mutation = `
    mutation UpdateTracking($fulfillmentId: ID!, $trackingInfoInput: FulfillmentTrackingInput!, $notifyCustomer: Boolean) {
      fulfillmentTrackingInfoUpdate(
        fulfillmentId: $fulfillmentId,
        trackingInfoInput: $trackingInfoInput,
        notifyCustomer: $notifyCustomer
      ) {
        fulfillment {
          id
          trackingInfo {
            number
            url
            company
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const data = await requestShopifyAdmin<any>(query, {
    id: order.admin_graphql_api_id ?? `gid://shopify/Order/${order.id}`
  });
  const fulfillment = data.order?.fulfillments?.[0];
  if (!fulfillment?.id) {
    return { skipped: true, reason: 'no-existing-fulfillment-found' };
  }

  const result = await requestShopifyAdmin<any>(mutation, {
    fulfillmentId: fulfillment.id,
    trackingInfoInput: {
      company: 'Telegraph',
      number: shipmentCode,
      url: trackingUrl(shipmentId)
    },
    notifyCustomer: false
  });
  const errors = result.fulfillmentTrackingInfoUpdate?.userErrors ?? [];
  if (errors.length) {
    return {
      skipped: true,
      reason: errors.map((error: any) => `${error.field?.join('.') ?? 'tracking'} ${error.message}`).join('; ')
    };
  }
  return { skipped: false, fulfillmentId: fulfillment.id };
}

for (const target of TARGETS) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`${target.name}`);
  console.log('='.repeat(80));

  const order = await shopifyOrdersClient.getOrderByLegacyId(target.legacyId);
  const before = await shipmentRepository.findByShopifyOrderId(String(order.id));
  console.log(`Shopify fulfillment_status: ${order.fulfillment_status ?? 'unfulfilled'}`);
  console.log(`DB before: shipment=${before?.accurateShipmentCode ?? 'NULL'} (${before?.accurateShipmentId ?? 'NULL'}), Odoo=${before?.odooSaleOrderName ?? 'NULL'} / ${before?.odooSyncStatus ?? 'NULL'}`);

  let oldShipmentUsable = false;
  if (before?.accurateShipmentId || before?.accurateShipmentCode) {
    try {
      const shipment = await accurateClient.getShipment({
        ...(before.accurateShipmentId ? { id: before.accurateShipmentId } : {}),
        ...(!before.accurateShipmentId && before.accurateShipmentCode ? { code: before.accurateShipmentCode } : {})
      });
      oldShipmentUsable = Boolean(shipment?.id);
      console.log(`Telegraph old shipment lookup: OK ${shipment?.code ?? before.accurateShipmentCode}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`Telegraph old shipment lookup: FAILED (${message})`);
    }
  }

  const existingSo = await findOdooSaleOrder(before?.odooSaleOrderId ?? null, before?.odooSaleOrderName ?? null);
  if (existingSo) {
    console.log(`Odoo SO lookup: OK ${existingSo.name} id=${existingSo.id} state=${existingSo.state}`);
  } else if (before?.odooSaleOrderId || before?.odooSaleOrderName) {
    console.log('Odoo SO lookup: MISSING - clearing DB Odoo link so queue can recreate it.');
    await prisma.shipmentRecord.update({
      where: { shopifyOrderId: String(order.id) },
      data: {
        odooSaleOrderId: null,
        odooSaleOrderName: null,
        odooSyncStatus: null,
        odooLastError: null,
        odooAttemptCount: 0,
        odooRetryAt: null
      }
    });
  } else {
    console.log('Odoo SO lookup: no existing DB SO link.');
  }

  if (before?.accurateShipmentId || before?.accurateShipmentCode) {
    const reason = oldShipmentUsable
      ? 'Manual repair: recreating Telegraph shipment for requested order'
      : 'Manual repair: old Telegraph shipment is not readable/usable; recreating shipment';
    console.log(`Clearing old Telegraph link: ${reason}`);
    await shipmentRepository.clearDeletedShipment(String(order.id), reason);
  }

  const result = await shopifyOrderProcessor.process(order, {
    source: 'manual-repair-1946-1947',
    skipEligibility: true,
    requireTelegraphLocation: true
  });
  console.log('Processor result:', JSON.stringify(result, null, 2));

  const after = await shipmentRepository.findByShopifyOrderId(String(order.id));
  console.log(`DB after: shipment=${after?.accurateShipmentCode ?? 'NULL'} (${after?.accurateShipmentId ?? 'NULL'}), Odoo=${after?.odooSaleOrderName ?? 'NULL'} / ${after?.odooSyncStatus ?? 'NULL'}`);

  const tracking = await updateFulfillmentTrackingIfAlreadyFulfilled(order, after?.accurateShipmentCode, after?.accurateShipmentId);
  console.log('Shopify tracking update:', JSON.stringify(tracking, null, 2));
}

await prisma.$disconnect();
