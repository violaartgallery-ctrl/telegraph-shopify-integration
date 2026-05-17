/**
 * WRITE: Create Telegraph shipments for #1988, #1977, #2009
 * and queue all for Odoo background processing.
 */
import { shopifyOrdersClient } from '../shopify/shopifyOrdersClient.js';
import { createAppServices } from '../app.js';
import { shipmentRepository } from '../services/shipmentRepository.js';
import { prisma } from '../lib/prisma.js';

const TARGET_NAMES = ['#1988', '#1977', '#2009'];
const { shopifyOrderProcessor } = createAppServices();

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║  CREATE TELEGRAPH SHIPMENTS — #1988 / #1977 / #2009          ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

const orders = await shopifyOrdersClient.listRecentOrders(250);

for (const targetName of TARGET_NAMES) {
  const order = orders.find(o => o.name === targetName);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${targetName}`);
  console.log('═'.repeat(60));

  if (!order) {
    console.log(`  ❌ NOT FOUND`);
    continue;
  }

  try {
    const result = await shopifyOrderProcessor.process(order);
    console.log(`  result.skipped       : ${result.skipped} ${result.reason ? '(' + result.reason + ')' : ''}`);
    console.log(`  fulfillment.skipped  : ${result.fulfillment?.skipped} ${result.fulfillment?.reason ? '(' + result.fulfillment.reason + ')' : ''}`);
    console.log(`  odoo                 : ${JSON.stringify(result.odoo)}`);
  } catch (err: any) {
    console.error(`  ❌ PROCESS FAILED: ${err.message}`);
  }
}

// DB verification
console.log('\n\n══ DB VERIFICATION ══════════════════════════════════════════════');
for (const targetName of TARGET_NAMES) {
  const order = orders.find(o => o.name === targetName);
  if (!order) continue;

  const r = await shipmentRepository.findByShopifyOrderId(String(order.id));
  console.log(`\n  ${targetName}`);
  if (!r) {
    console.log(`    ❌ no DB record found`);
    continue;
  }
  console.log(`    id                 : ${r.id}`);
  console.log(`    accurateShipmentCode: ${r.accurateShipmentCode}`);
  console.log(`    accurateShipmentId : ${r.accurateShipmentId}`);
  console.log(`    accurateStatus     : ${r.accurateStatus}`);
  console.log(`    odooSyncStatus     : ${r.odooSyncStatus === 'odoo-so-pending' ? '✅ ' : '❌ '}${r.odooSyncStatus}`);
  console.log(`    odooAttemptCount   : ${r.odooAttemptCount}`);
  console.log(`    rawOrderJson       : ${r.rawOrderJson ? '✅ exists' : '❌ missing'}`);
}

await prisma.$disconnect();
