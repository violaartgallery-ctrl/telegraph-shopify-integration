import { OdooClient } from '../odoo/odooClient.js';
import { OdooSyncService } from '../odoo/odooSyncService.js';
import { shopifyOrdersClient } from '../shopify/shopifyOrdersClient.js';

const orderId = process.argv[2];
if (!orderId) {
  console.error('Usage: npm run test:odoo-preview -- <shopify legacy order id>');
  process.exit(1);
}

const service = new OdooSyncService(new OdooClient());

try {
  const order = await shopifyOrdersClient.getOrderByLegacyId(orderId);
  const preview = await service.previewOrder(order);
  console.log(JSON.stringify({ order: order.name, preview }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
