/**
 * REAL WRITE SCRIPT — creates Telegraph shipments for #2010 and #2011
 * and queues both for Odoo background processing (odoo-so-pending).
 *
 * Writes:
 *   - Telegraph (Accurate) shipment created for each order
 *   - Shopify fulfillment synced
 *   - DB: ShipmentRecord created + odooSyncStatus = 'odoo-so-pending'
 */

import { shopifyOrdersClient } from '../shopify/shopifyOrdersClient.js';
import { createAppServices } from '../app.js';
import { prisma } from '../lib/prisma.js';

const { shopifyOrderProcessor } = createAppServices();

const orders = await shopifyOrdersClient.listRecentOrders(250);

for (const num of ['2010', '2011'] as const) {
  const order = orders.find(o => o.name === `#${num}`);
  if (!order) {
    console.log(`\n#${num}: ❌ not found in last 250 orders`);
    continue;
  }

  console.log(`\n══════════════════ #${num} ══════════════════`);
  console.log('  shopify id:', order.id);
  console.log('  items:', order.line_items?.map(i => `${i.title} x${i.quantity} (sku=${i.sku})`).join(', '));

  try {
    const result = await shopifyOrderProcessor.process(order);
    console.log('  ✅ result.skipped        :', result.skipped, result.reason ?? '');
    console.log('  ✅ fulfillment.skipped   :', result.fulfillment?.skipped, result.fulfillment?.reason ?? '');
    console.log('  ✅ odoo                  :', JSON.stringify(result.odoo));
  } catch (err: any) {
    console.error('  ❌ FAILED:', err.message);
  }
}

// Verify DB state
console.log('\n══ DB verification ══════════════════════════');
const rows = await prisma.shipmentRecord.findMany({
  where: {
    OR: [
      { shopifyOrderName: '#2010' },
      { shopifyOrderName: '#2011' }
    ]
  }
});

for (const r of rows) {
  console.log(`\n  ${r.shopifyOrderName}`);
  console.log('    accurateShipmentCode:', r.accurateShipmentCode);
  console.log('    accurateStatus      :', r.accurateStatus);
  console.log('    odooSyncStatus      :', r.odooSyncStatus);
  console.log('    odooAttemptCount    :', r.odooAttemptCount);
  console.log('    rawOrderJson exists :', !!r.rawOrderJson);
}

await prisma.$disconnect();
