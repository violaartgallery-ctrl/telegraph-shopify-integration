import { createAppServices } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { OdooClient } from '../odoo/odooClient.js';
import { requestShopifyAdmin } from '../shopify/shopifyAdminGraphql.js';

const targets = ['10589568336164', '10589613588772'];
const odoo = new OdooClient();
const { accurateClient } = createAppServices();

const shopifyQuery = `
  query VerifyOrder($id: ID!) {
    order(id: $id) {
      id
      name
      displayFulfillmentStatus
      displayFinancialStatus
      fulfillments(first: 10) {
        id
        status
        trackingInfo {
          company
          number
          url
        }
      }
    }
  }
`;

for (const shopifyOrderId of targets) {
  const rec = await prisma.shipmentRecord.findUnique({ where: { shopifyOrderId } });
  console.log(`\n${'='.repeat(80)}`);
  console.log(`${rec?.shopifyOrderName ?? shopifyOrderId}`);
  console.log('='.repeat(80));

  console.log('DB:', {
    accurateShipmentCode: rec?.accurateShipmentCode,
    accurateShipmentId: rec?.accurateShipmentId,
    odooSyncStatus: rec?.odooSyncStatus,
    odooSaleOrderName: rec?.odooSaleOrderName,
    odooSaleOrderId: rec?.odooSaleOrderId,
    odooLastError: rec?.odooLastError,
    odooAttemptCount: rec?.odooAttemptCount
  });

  if (rec?.odooSaleOrderId) {
    const [so] = await odoo.searchRead<any>(
      'sale.order',
      [['id', '=', rec.odooSaleOrderId]],
      ['name', 'state', 'client_order_ref', 'origin', 'picking_ids', 'mrp_production_ids'],
      { limit: 1 }
    );
    console.log('Odoo SO:', so ?? null);
  }

  if (rec?.accurateShipmentId) {
    try {
      const shipment = await accurateClient.getShipment({ id: rec.accurateShipmentId });
      console.log('Telegraph:', {
        id: shipment?.id,
        code: shipment?.code,
        status: shipment?.status
      });
    } catch (error) {
      console.log('Telegraph lookup failed:', error instanceof Error ? error.message : String(error));
    }
  }

  const shopify = await requestShopifyAdmin<any>(shopifyQuery, {
    id: `gid://shopify/Order/${shopifyOrderId}`
  });
  console.log('Shopify:', JSON.stringify(shopify.order, null, 2));
}

await prisma.$disconnect();
