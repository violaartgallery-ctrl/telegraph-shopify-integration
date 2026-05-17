/**
 * CRITICAL: Why do V7 orders have ZERO invoices?
 */
import { prisma } from '../lib/prisma.js';

console.log('\n████████████████████████████████████████████████████████████');
console.log('   🚨 ليه V7 (new flow) عنده 0 invoices?');
console.log('████████████████████████████████████████████████████████████\n');

// All V7 orders
const v7Statuses = ['odoo-so-pending', 'odoo-stock-pending', 'odoo-delivery-pending', 'delivery-confirmed'];
const v7Orders = await prisma.shipmentRecord.findMany({
  where: { odooSyncStatus: { in: v7Statuses } },
  select: {
    shopifyOrderName: true,
    odooSyncStatus: true,
    collectionStatus: true,
    accurateStatus: true,
    accurateShipmentCode: true,
    lastSyncedAt: true,
    createdAt: true
  },
  orderBy: { createdAt: 'desc' }
});

console.log(`Total V7 orders: ${v7Orders.length}\n`);

// Breakdown
const odooBreakdown: Record<string, number> = {};
const collectionBreakdown: Record<string, number> = {};
for (const o of v7Orders) {
  const os = o.odooSyncStatus ?? 'null';
  odooBreakdown[os] = (odooBreakdown[os] || 0) + 1;
  
  const cs = o.collectionStatus ?? 'null';
  collectionBreakdown[cs] = (collectionBreakdown[cs] || 0) + 1;
}

console.log('By Odoo status:');
for (const [s, c] of Object.entries(odooBreakdown)) {
  console.log(`  ${s}: ${c}`);
}

console.log('\nBy Collection status:');
for (const [s, c] of Object.entries(collectionBreakdown)) {
  console.log(`  ${s}: ${c}`);
}

// Critical: V7 orders that should have invoices but don't
const v7DeliveredCollected = v7Orders.filter(o => 
  o.odooSyncStatus === 'delivery-confirmed' && 
  o.collectionStatus === 'collected'
);

console.log(`\n⚠️  V7 orders DELIVERY-CONFIRMED + COLLECTED (should have invoice): ${v7DeliveredCollected.length}`);
for (const o of v7DeliveredCollected.slice(0, 5)) {
  console.log(`  ${o.shopifyOrderName}: ${o.accurateShipmentCode} | collection=${o.collectionStatus}`);
}

// Check: V7 sync staleness
console.log('\n\n📊 V7 SYNC STATUS:');
const now = Date.now();
const v7Synced = v7Orders.filter(o => o.lastSyncedAt);
const v7NeverSynced = v7Orders.filter(o => !o.lastSyncedAt);

console.log(`  V7 orders synced at least once: ${v7Synced.length}`);
console.log(`  V7 orders NEVER synced: ${v7NeverSynced.length} ❌`);

if (v7Synced.length > 0) {
  const avgAge = v7Synced.reduce((sum, o) => sum + (now - o.lastSyncedAt!.getTime()), 0) / v7Synced.length / 60000;
  console.log(`  Average V7 sync age: ${avgAge.toFixed(0)} minutes`);
}

// Check Accurate GraphQL validation errors
console.log('\n\n🔍 "Accurate GraphQL validation error" details:');
const validationFails = await prisma.failedPayload.findMany({
  where: { reason: { contains: 'Accurate GraphQL validation error' } },
  select: { externalId: true, reason: true, createdAt: true },
  orderBy: { createdAt: 'desc' },
  take: 5
});

for (const f of validationFails) {
  console.log(`\n  ${f.createdAt.toISOString().slice(0, 16)} | ${f.externalId}`);
  console.log(`  Full reason: ${f.reason.slice(0, 200)}`);
}

await prisma.$disconnect();
