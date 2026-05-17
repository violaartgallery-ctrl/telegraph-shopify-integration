/**
 * Post-deploy inspection - verify everything works
 */
import { prisma } from '../lib/prisma.js';

console.log('\n████████████████████████████████████████████████████████████');
console.log('   POST-DEPLOY INSPECTION');
console.log('████████████████████████████████████████████████████████████\n');

const now = Date.now();

// 1. Check if cron has been running recently
console.log('🔍 #1: Has sync-open-shipments been running?\n');

const recentSync = await prisma.shipmentRecord.findMany({
  where: {
    lastSyncedAt: { gt: new Date(now - 30 * 60000) } // last 30 min
  },
  select: { shopifyOrderName: true, lastSyncedAt: true, accurateStatus: true }
});

console.log(`  Orders synced in last 30 min: ${recentSync.length}`);
if (recentSync.length > 0) {
  console.log('  Most recent 5:');
  for (const r of recentSync.slice(0, 5).sort((a, b) => (b.lastSyncedAt?.getTime() ?? 0) - (a.lastSyncedAt?.getTime() ?? 0))) {
    const ago = Math.round((now - r.lastSyncedAt!.getTime()) / 60000);
    console.log(`    ${r.shopifyOrderName}: ${ago} min ago | accurate=${r.accurateStatus}`);
  }
}

// 2. Check process-odoo-queue activity
console.log('\n\n🔍 #2: process-odoo-queue (every minute)\n');

const recentOdoo = await prisma.shipmentRecord.findMany({
  where: {
    odooSyncedAt: { gt: new Date(now - 10 * 60000) } // last 10 min
  },
  select: { shopifyOrderName: true, odooSyncedAt: true, odooSyncStatus: true },
  orderBy: { odooSyncedAt: 'desc' },
  take: 5
});

console.log(`  Odoo activities in last 10 min: ${recentOdoo.length}`);
for (const r of recentOdoo) {
  const ago = Math.round((now - r.odooSyncedAt!.getTime()) / 60000);
  console.log(`    ${r.shopifyOrderName}: ${ago} min ago | status=${r.odooSyncStatus}`);
}

// 3. Check return failures - any retried with new env?
console.log('\n\n🔍 #3: Return charge failures (env was missing)\n');

const returnFails = await prisma.failedPayload.findMany({
  where: { source: 'odoo-return-charge-sync' },
  select: { externalId: true, createdAt: true, reason: true },
  orderBy: { createdAt: 'desc' },
  take: 10
});

console.log(`  Total return charge failures: ${returnFails.length}`);
if (returnFails.length > 0) {
  console.log(`  Latest: ${returnFails[0].createdAt.toISOString().slice(0, 16)}`);
  console.log(`  After deploy: ${returnFails.filter(f => f.createdAt > new Date(now - 30 * 60000)).length} new`);
}

// 4. Check queue health
console.log('\n\n🔍 #4: Queue health\n');

const queueStatus = await prisma.shipmentRecord.groupBy({
  by: ['odooSyncStatus'],
  _count: true,
  where: {
    odooSyncStatus: {
      in: ['odoo-so-pending', 'odoo-so-creating', 'odoo-stock-pending', 
            'odoo-stock-preparing', 'odoo-delivery-pending', 'odoo-delivery-confirming',
            'odoo-failed-retryable']
    }
  }
});

if (queueStatus.length === 0) {
  console.log('  ✅ Queue empty');
} else {
  for (const item of queueStatus) {
    console.log(`  ${item.odooSyncStatus}: ${item._count}`);
  }
}

// 5. Overall status
console.log('\n\n🔍 #5: Overall status counts\n');

const breakdown = await prisma.shipmentRecord.groupBy({
  by: ['odooSyncStatus'],
  _count: true,
  orderBy: { _count: { odooSyncStatus: 'desc' } }
});

for (const b of breakdown) {
  console.log(`  ${b.odooSyncStatus ?? 'null'}: ${b._count}`);
}

// 6. Check returned orders that should now be billable
console.log('\n\n🔍 #6: Returned orders ready for retry (with new env)\n');

const returnedOrders = await prisma.shipmentRecord.findMany({
  where: {
    OR: [
      { collectionStatus: 'returned' },
      { collectionStatus: 'returned-settled' }
    ],
    odooReturnBillId: null
  },
  select: {
    shopifyOrderName: true,
    collectionStatus: true,
    returnedValue: true,
    odooSaleOrderName: true
  }
});

console.log(`  Returned orders pending bill: ${returnedOrders.length}`);
for (const r of returnedOrders.slice(0, 6)) {
  console.log(`    ${r.shopifyOrderName}: $${r.returnedValue} | SO=${r.odooSaleOrderName}`);
}
console.log('\n  ℹ️  These will get bills on next sync-open-shipments run (within 15 min)');

await prisma.$disconnect();
