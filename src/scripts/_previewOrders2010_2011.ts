// Read-only: preview eligibility + Odoo product readiness for #2010 and #2011
import { shopifyOrdersClient } from '../shopify/shopifyOrdersClient.js';
import { isOrderEligibleForShipment } from '../services/orderEligibility.js';
import { createAppServices } from '../app.js';
import { prisma } from '../lib/prisma.js';

const { odooSyncService } = createAppServices();

for (const num of ['2010', '2011'] as const) {
  const orders = await shopifyOrdersClient.listRecentOrders(250);
  const order = orders.find(o => o.name === `#${num}`);
  if (!order) { console.log(`#${num}: not found`); continue; }

  console.log(`\n══════════════════ #${num} ══════════════════`);
  console.log('  eligible for shipment:', isOrderEligibleForShipment(order));

  // Line items
  for (const item of order.line_items ?? []) {
    console.log(`  item: ${item.title} | qty=${item.quantity} | price=${item.price} | sku=${item.sku}`);
  }

  // Address
  const addr = order.shipping_address ?? order.billing_address;
  console.log('  address city    :', addr?.city);
  console.log('  address province:', addr?.province);
  console.log('  address country :', addr?.country_code);

  // Odoo product preview
  if (odooSyncService) {
    try {
      const preview = await odooSyncService.previewOrder(order);
      console.log('  Odoo ready      :', preview.ready);
      console.log('  Odoo reference  :', preview.reference);
      for (const p of preview.products) {
        console.log(`  product: ${p.title} | ready=${p.ready} | reason=${p.reason ?? 'ok'}`);
      }
    } catch (e: any) {
      console.log('  Odoo preview ERR:', e.message);
    }
  }
}

await prisma.$disconnect();
