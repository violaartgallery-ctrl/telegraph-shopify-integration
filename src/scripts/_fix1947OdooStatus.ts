/**
 * One-time fix for order #1947 — advances Odoo status from old V6
 * 'sales-order-created' → 'odoo-stock-pending' so the background queue
 * can pick it up and complete stages 2 (stock) and 3 (delivery).
 *
 * The Telegraph shipment (VI0000376) and Odoo SO (S14567) already exist.
 * We only need to run prepareSalesOrderStock + confirmSalesOrderDelivery.
 */
import { prisma } from '../lib/prisma.js';

const SHOPIFY_ORDER_ID = '10589613588772'; // #1947
const EXPECTED_STATUS = 'sales-order-created';
const TARGET_STATUS   = 'odoo-stock-pending';

const rec = await prisma.shipmentRecord.findUnique({
  where: { shopifyOrderId: SHOPIFY_ORDER_ID },
  select: { id: true, shopifyOrderName: true, odooSyncStatus: true, odooSaleOrderName: true, odooSaleOrderId: true }
});

if (!rec) {
  console.log('❌ Record not found');
  process.exit(1);
}

console.log(`Order: ${rec.shopifyOrderName ?? SHOPIFY_ORDER_ID}`);
console.log(`  current odooSyncStatus : ${rec.odooSyncStatus}`);
console.log(`  odooSaleOrderName      : ${rec.odooSaleOrderName}`);
console.log(`  odooSaleOrderId        : ${rec.odooSaleOrderId}`);

if (rec.odooSyncStatus !== EXPECTED_STATUS) {
  console.log(`\n⚠️  Status is not '${EXPECTED_STATUS}' — aborting to avoid overwriting valid state.`);
  console.log(`   If you want to force-advance, change EXPECTED_STATUS in this script.`);
  process.exit(1);
}

if (!rec.odooSaleOrderId) {
  console.log('\n❌ odooSaleOrderId is null — cannot proceed without a Sale Order');
  process.exit(1);
}

const result = await prisma.shipmentRecord.update({
  where: { id: rec.id },
  data: {
    odooSyncStatus:   TARGET_STATUS,
    odooAttemptCount: 0,
    odooRetryAt:      null,
    odooLastError:    null,
    odooSyncedAt:     new Date()
  }
});

console.log(`\n✅ Updated odooSyncStatus: '${EXPECTED_STATUS}' → '${result.odooSyncStatus}'`);
console.log('   Run processOdooQueueOnce.ts to execute stages 2 and 3.');

await prisma.$disconnect();
