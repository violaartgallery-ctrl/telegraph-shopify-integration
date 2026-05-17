/**
 * Even deeper analysis - timing, patterns, configuration
 */
import { prisma } from '../lib/prisma.js';

console.log('\n████████████████████████████████████████████████████████████');
console.log('   DEEPER ANALYSIS - حاجات اكتر');
console.log('████████████████████████████████████████████████████████████\n');

// ──────────────────────────────────────────────────────────────────
// 1. FAILURE PATTERNS OVER TIME
// ──────────────────────────────────────────────────────────────────
console.log('🔍 INVESTIGATION #1: When do failures happen?\n');

const failures = await prisma.failedPayload.findMany({
  where: {
    createdAt: { gt: new Date(Date.now() - 7 * 86400000) } // last 7 days
  },
  select: { createdAt: true, source: true }
});

// Group by hour
const byHour: Record<number, number> = {};
for (const f of failures) {
  const hour = f.createdAt.getUTCHours();
  byHour[hour] = (byHour[hour] || 0) + 1;
}

console.log('Failures by hour of day (UTC):');
for (let h = 0; h < 24; h++) {
  const count = byHour[h] || 0;
  const bar = '█'.repeat(Math.min(count, 30));
  console.log(`  ${String(h).padStart(2, '0')}:00 │${bar} ${count}`);
}

// Group by day
const byDay: Record<string, number> = {};
for (const f of failures) {
  const day = f.createdAt.toISOString().slice(0, 10);
  byDay[day] = (byDay[day] || 0) + 1;
}

console.log('\nFailures by day (last 7 days):');
for (const [day, count] of Object.entries(byDay).sort()) {
  console.log(`  ${day}: ${count}`);
}

// ──────────────────────────────────────────────────────────────────
// 2. shopify-orders-create failures
// ──────────────────────────────────────────────────────────────────
console.log('\n\n🔍 INVESTIGATION #2: shopify-orders-create failures\n');

const orderCreateFails = await prisma.failedPayload.findMany({
  where: { source: 'shopify-orders-create' },
  select: { externalId: true, reason: true, createdAt: true },
  orderBy: { createdAt: 'desc' }
});

console.log(`Total: ${orderCreateFails.length}`);
const uniqueOrders = new Set<string>();
const reasonCount: Record<string, number> = {};
for (const f of orderCreateFails) {
  if (f.externalId) uniqueOrders.add(f.externalId);
  const reason = f.reason.slice(0, 80);
  reasonCount[reason] = (reasonCount[reason] || 0) + 1;
}

console.log(`Unique orders affected: ${uniqueOrders.size}`);
console.log('\nReason breakdown:');
for (const [reason, count] of Object.entries(reasonCount)) {
  console.log(`  ${count}× ${reason}`);
}

// ──────────────────────────────────────────────────────────────────
// 3. V6 vs V7 orders breakdown
// ──────────────────────────────────────────────────────────────────
console.log('\n\n🔍 INVESTIGATION #3: V6 (old) vs V7 (new) orders\n');

// V6 had statuses like 'sales-order-created', 'paid', etc. without queue stages
// V7 uses 'odoo-so-pending', 'odoo-stock-pending', etc.

const v6Statuses = ['sales-order-created', 'paid', 'paid-existing', 'sales-order-existing', 'returned-charge-paid'];
const v7Statuses = ['odoo-so-pending', 'odoo-stock-pending', 'odoo-delivery-pending', 'delivery-confirmed'];

const v6Count = await prisma.shipmentRecord.count({
  where: { odooSyncStatus: { in: v6Statuses } }
});
const v7Count = await prisma.shipmentRecord.count({
  where: { odooSyncStatus: { in: v7Statuses } }
});

console.log(`  V6 (old flow) orders: ${v6Count}`);
console.log(`  V7 (new flow) orders: ${v7Count}`);

// V7 orders with invoices
const v7WithInvoice = await prisma.shipmentRecord.count({
  where: {
    odooSyncStatus: { in: v7Statuses },
    odooInvoiceName: { not: null }
  }
});

console.log(`  V7 with invoice: ${v7WithInvoice} / ${v7Count} (${(v7WithInvoice / v7Count * 100).toFixed(1)}%)`);

// ──────────────────────────────────────────────────────────────────
// 4. Order Age Analysis
// ──────────────────────────────────────────────────────────────────
console.log('\n\n🔍 INVESTIGATION #4: How old are unpaid orders?\n');

const unpaidOldOrders = await prisma.shipmentRecord.findMany({
  where: {
    odooInvoiceName: null,
    accurateIsTerminal: false
  },
  select: {
    shopifyOrderName: true,
    createdAt: true,
    collectionStatus: true,
    accurateStatus: true
  },
  orderBy: { createdAt: 'asc' }
});

const now = Date.now();
const ageBuckets = {
  'over 14 days': 0,
  '7-14 days': 0,
  '3-7 days': 0,
  '1-3 days': 0,
  'today': 0
};

for (const o of unpaidOldOrders) {
  const ageDays = Math.floor((now - o.createdAt.getTime()) / 86400000);
  if (ageDays > 14) ageBuckets['over 14 days']++;
  else if (ageDays > 7) ageBuckets['7-14 days']++;
  else if (ageDays > 3) ageBuckets['3-7 days']++;
  else if (ageDays > 1) ageBuckets['1-3 days']++;
  else ageBuckets['today']++;
}

console.log('Active unpaid orders by age:');
for (const [bucket, count] of Object.entries(ageBuckets)) {
  console.log(`  ${bucket}: ${count}`);
}

console.log('\n  ⚠️  Oldest 5 unpaid orders:');
for (const o of unpaidOldOrders.slice(0, 5)) {
  const ageDays = Math.floor((now - o.createdAt.getTime()) / 86400000);
  console.log(`    ${o.shopifyOrderName}: ${ageDays} days old | collection=${o.collectionStatus} | accurate=${o.accurateStatus}`);
}

// ──────────────────────────────────────────────────────────────────
// 5. Collection rate analysis
// ──────────────────────────────────────────────────────────────────
console.log('\n\n🔍 INVESTIGATION #5: Collection Rate\n');

const allDelivered = await prisma.shipmentRecord.count({
  where: { 
    OR: [
      { accurateStatusCode: 'DELIVERED' },
      { collectionStatus: 'collected' },
      { collectionStatus: 'delivered-not-collected' }
    ]
  }
});

const collected = await prisma.shipmentRecord.count({
  where: { collectionStatus: 'collected' }
});

const notCollected = await prisma.shipmentRecord.count({
  where: { collectionStatus: 'delivered-not-collected' }
});

const collectionRate = (collected / (collected + notCollected) * 100).toFixed(1);

console.log(`  Total delivered: ${allDelivered}`);
console.log(`  Successfully collected: ${collected}`);
console.log(`  Delivered but NOT collected: ${notCollected}`);
console.log(`  📊 Collection rate: ${collectionRate}%`);

// ──────────────────────────────────────────────────────────────────
// 6. Average sync gap
// ──────────────────────────────────────────────────────────────────
console.log('\n\n🔍 INVESTIGATION #6: Sync staleness\n');

const synced = await prisma.shipmentRecord.findMany({
  where: {
    lastSyncedAt: { not: null },
    accurateIsTerminal: false
  },
  select: { lastSyncedAt: true }
});

if (synced.length > 0) {
  const ages = synced.map(s => now - s.lastSyncedAt!.getTime());
  const avgAge = ages.reduce((a, b) => a + b, 0) / ages.length / 60000; // minutes
  const maxAge = Math.max(...ages) / 60000;
  const minAge = Math.min(...ages) / 60000;

  console.log(`  Active orders: ${synced.length}`);
  console.log(`  Average sync age: ${avgAge.toFixed(0)} minutes`);
  console.log(`  Oldest sync: ${maxAge.toFixed(0)} minutes (${(maxAge/60).toFixed(1)} hours)`);
  console.log(`  Newest sync: ${minAge.toFixed(0)} minutes`);
  console.log('');
  console.log(`  ⚠️  If avg > 60 mins → cron is slower than schedule`);
  console.log(`  ⚠️  If max > 120 mins → backlog growing`);
}

await prisma.$disconnect();
