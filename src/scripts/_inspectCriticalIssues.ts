/**
 * Investigate the critical issues found
 */
import { prisma } from '../lib/prisma.js';

console.log('\n████████████████████████████████████████████████████████████');
console.log('   CRITICAL ISSUES DEEP DIVE');
console.log('████████████████████████████████████████████████████████████\n');

// ──────────────────────────────────────────────────────────────────
// 1. Return Charge config missing
// ──────────────────────────────────────────────────────────────────
console.log('🔴 CRITICAL #1: Return charges BROKEN — env var missing\n');
console.log('   Failed: 6× "ODOO_RETURN_CHARGE_ACCOUNT_ID is not configured"');
console.log('   Impact: 6 returned orders worth $959-$1114 each cannot be billed');
console.log('   Solution: Set ODOO_RETURN_CHARGE_ACCOUNT_ID env var');

// ──────────────────────────────────────────────────────────────────
// 2. SKU missing - product issue
// ──────────────────────────────────────────────────────────────────
console.log('\n\n🔴 CRITICAL #2: "Photo keychain" missing SKU\n');
const skuFails = await prisma.failedPayload.findMany({
  where: { reason: { contains: 'no SKU' } },
  select: { externalId: true, reason: true, createdAt: true },
  orderBy: { createdAt: 'desc' },
  take: 10
});

console.log(`   ${skuFails.length} failures due to missing SKU`);
for (const f of skuFails.slice(0, 5)) {
  console.log(`   ${f.createdAt.toISOString().slice(0, 10)} | ${f.externalId}`);
}

// Check if there are any orders blocked by this
const blockedOrders = await prisma.failedPayload.findMany({
  where: { source: 'odoo-sales-order-after-shipment' },
  select: { externalId: true, reason: true },
  distinct: ['externalId']
});

console.log(`\n   Unique orders blocked: ${blockedOrders.length}`);

// ──────────────────────────────────────────────────────────────────
// 3. Orphan Odoo SOs - 71 without Telegraph
// ──────────────────────────────────────────────────────────────────
console.log('\n\n🟡 ISSUE #3: 71 Odoo Sales Orders without Telegraph shipment\n');
const orphans = await prisma.shipmentRecord.findMany({
  where: {
    AND: [
      { odooSaleOrderName: { not: null } },
      { accurateShipmentCode: null }
    ]
  },
  select: {
    shopifyOrderName: true,
    odooSaleOrderName: true,
    odooSyncStatus: true,
    accurateStatus: true,
    createdAt: true
  },
  orderBy: { createdAt: 'asc' }
});

// Group by accurate status
const byAccurateStatus: Record<string, number> = {};
for (const o of orphans) {
  const key = o.accurateStatus || 'NULL';
  byAccurateStatus[key] = (byAccurateStatus[key] || 0) + 1;
}
console.log('   Distribution by accurateStatus:');
for (const [s, c] of Object.entries(byAccurateStatus)) {
  console.log(`     ${s}: ${c}`);
}

console.log('\n   Oldest 5:');
for (const o of orphans.slice(0, 5)) {
  console.log(`     ${o.shopifyOrderName}: ${o.odooSaleOrderName} | created=${o.createdAt.toISOString().slice(0,10)} | accurate=${o.accurateStatus}`);
}

// ──────────────────────────────────────────────────────────────────
// 4. Pipeline Delay Analysis
// ──────────────────────────────────────────────────────────────────
console.log('\n\n🟡 ISSUE #4: Pipeline takes 54-127 hours (2-5 days!)\n');
console.log('   This is the REAL impact of slow sync-open-shipments:');
console.log('   Customer pays Telegraph → 2-5 days later → Odoo invoice');
console.log('   ');
console.log('   With sync every 10 mins (proposed):');
console.log('     Expected delay: <1 hour after Telegraph reports collection');

// ──────────────────────────────────────────────────────────────────
// 5. Delivered-not-collected business impact
// ──────────────────────────────────────────────────────────────────
console.log('\n\n💰 ISSUE #5: Delivered but NOT paid (business risk)\n');
const notCollected = await prisma.shipmentRecord.findMany({
  where: { collectionStatus: 'delivered-not-collected' },
  select: {
    shopifyOrderName: true,
    deliveredAt: true,
    pendingCollectionAmount: true,
    customerDue: true
  }
});

let totalDue = 0;
let totalCustomerDue = 0;
for (const r of notCollected) {
  totalDue += Number(r.pendingCollectionAmount ?? 0);
  totalCustomerDue += Number(r.customerDue ?? 0);
}

console.log(`   Orders: ${notCollected.length}`);
console.log(`   Total pending: $${totalDue.toFixed(2)}`);
console.log(`   Total customer due: $${totalCustomerDue.toFixed(2)}`);
console.log(`   Average per order: $${(totalDue / notCollected.length).toFixed(2)}`);

// Group by delivery date
const byDate: Record<string, number> = {};
for (const r of notCollected) {
  const date = r.deliveredAt?.toISOString().slice(0, 10) ?? 'unknown';
  byDate[date] = (byDate[date] || 0) + 1;
}
console.log('\n   By delivery date:');
for (const [date, count] of Object.entries(byDate).sort()) {
  console.log(`     ${date}: ${count} orders`);
}

// ──────────────────────────────────────────────────────────────────
// 6. Webhook reliability check
// ──────────────────────────────────────────────────────────────────
console.log('\n\n🔍 ISSUE #6: Shopify webhook reliability\n');
const noActiveItems = await prisma.failedPayload.findMany({
  where: { reason: { contains: 'no active line items' } },
  select: { externalId: true, reason: true, createdAt: true }
});

console.log(`   Orders with "no active line items": ${noActiveItems.length}`);
for (const f of noActiveItems) {
  console.log(`     ${f.reason}`);
}

// ──────────────────────────────────────────────────────────────────
// 7. Accurate polling unauthorized
// ──────────────────────────────────────────────────────────────────
console.log('\n\n🔍 ISSUE #7: Telegraph "Unauthorized" errors\n');
const unauthFails = await prisma.failedPayload.findMany({
  where: { 
    source: 'accurate-polling-sync',
    reason: { contains: 'Unauthorized' }
  },
  select: { externalId: true, createdAt: true },
  orderBy: { createdAt: 'desc' },
  take: 5
});

console.log(`   Latest 5 unauthorized failures:`);
for (const f of unauthFails) {
  console.log(`     ${f.createdAt.toISOString().slice(0, 16)} | ${f.externalId}`);
}
console.log('\n   ℹ️  Probably old V6 account permissions issue');

await prisma.$disconnect();
