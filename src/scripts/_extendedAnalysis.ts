/**
 * Extended analysis - dig deeper into hidden issues
 */
import { prisma } from '../lib/prisma.js';

console.log('\n████████████████████████████████████████████████████████████');
console.log('   EXTENDED ANALYSIS - مشاكل خفية');
console.log('████████████████████████████████████████████████████████████\n');

// ──────────────────────────────────────────────────────────────────
// 1. RETURNED ORDERS FLOW
// ──────────────────────────────────────────────────────────────────
console.log('🔍 INVESTIGATION #1: Returns Flow\n');

const returned = await prisma.shipmentRecord.findMany({
  where: {
    OR: [
      { collectionStatus: 'returned' },
      { collectionStatus: 'returned-settled' }
    ]
  },
  select: {
    shopifyOrderName: true,
    collectionStatus: true,
    accurateStatus: true,
    odooSyncStatus: true,
    odooReturnBillId: true,
    odooReturnPaymentId: true,
    returnedValue: true,
    returnFees: true,
    deliveredAt: true
  }
});

console.log(`Total returned orders: ${returned.length}`);
const returnedNoBill = returned.filter(r => !r.odooReturnBillId);
const returnedNoPayment = returned.filter(r => !r.odooReturnPaymentId);

console.log(`  - Without return bill in Odoo: ${returnedNoBill.length}`);
console.log(`  - Without return payment in Odoo: ${returnedNoPayment.length}`);

if (returnedNoBill.length > 0) {
  console.log('\n  Examples without return bill:');
  for (const r of returnedNoBill.slice(0, 5)) {
    console.log(`    ${r.shopifyOrderName}: ${r.collectionStatus} | returnedValue=$${r.returnedValue} | odooStatus=${r.odooSyncStatus}`);
  }
}

// ──────────────────────────────────────────────────────────────────
// 2. DELIVERED-NOT-COLLECTED (Critical business issue)
// ──────────────────────────────────────────────────────────────────
console.log('\n\n🔍 INVESTIGATION #2: Delivered but money NOT collected\n');

const notCollected = await prisma.shipmentRecord.findMany({
  where: { collectionStatus: 'delivered-not-collected' },
  select: {
    shopifyOrderName: true,
    accurateShipmentCode: true,
    accurateStatus: true,
    odooSyncStatus: true,
    odooInvoiceName: true,
    collectedAmount: true,
    pendingCollectionAmount: true,
    customerDue: true,
    deliveredAt: true
  },
  orderBy: { deliveredAt: 'desc' }
});

console.log(`Total: ${notCollected.length} orders delivered but NO money collected\n`);
let totalPending = 0;
for (const r of notCollected.slice(0, 10)) {
  const delivered = r.deliveredAt?.toISOString().slice(0, 10) ?? 'unknown';
  console.log(`  ${r.shopifyOrderName}: ${r.accurateShipmentCode} | delivered=${delivered} | pending=$${r.pendingCollectionAmount ?? 0} | customerDue=$${r.customerDue ?? 0}`);
  totalPending += Number(r.pendingCollectionAmount ?? 0);
}
console.log(`\n  💰 Total pending money: $${totalPending.toFixed(2)}`);

// ──────────────────────────────────────────────────────────────────
// 3. PAID vs PAID-EXISTING comparison
// ──────────────────────────────────────────────────────────────────
console.log('\n\n🔍 INVESTIGATION #3: paid vs paid-existing\n');

const paid = await prisma.shipmentRecord.count({ where: { odooSyncStatus: 'paid' } });
const paidExisting = await prisma.shipmentRecord.count({ where: { odooSyncStatus: 'paid-existing' } });

console.log(`  'paid' (new payment registered): ${paid}`);
console.log(`  'paid-existing' (matched existing): ${paidExisting}`);
console.log(`  ℹ️  'paid-existing' = invoice was already paid in Odoo before sync`);

// ──────────────────────────────────────────────────────────────────
// 4. ORPHAN/INCONSISTENT RECORDS
// ──────────────────────────────────────────────────────────────────
console.log('\n\n🔍 INVESTIGATION #4: Orphan/Inconsistent records\n');

// Orders with sale order but no Shopify ID
const orphans = await prisma.shipmentRecord.findMany({
  where: {
    AND: [
      { odooSaleOrderName: { not: null } },
      { accurateShipmentCode: null }
    ]
  },
  select: { shopifyOrderName: true, odooSaleOrderName: true }
});

console.log(`  Has Odoo SO but NO Telegraph shipment: ${orphans.length}`);
for (const o of orphans.slice(0, 5)) {
  console.log(`    ${o.shopifyOrderName}: ${o.odooSaleOrderName}`);
}

// Orders with collected money but no Odoo invoice
const moneyNoInvoice = await prisma.shipmentRecord.findMany({
  where: {
    AND: [
      { collectionStatus: 'collected' },
      { odooInvoiceName: null }
    ]
  },
  select: {
    shopifyOrderName: true,
    collectedAmount: true,
    odooSyncStatus: true
  }
});

console.log(`\n  Has collected money but NO Odoo invoice: ${moneyNoInvoice.length}`);
let lostMoney = 0;
for (const r of moneyNoInvoice) {
  console.log(`    ${r.shopifyOrderName}: $${r.collectedAmount} | odooStatus=${r.odooSyncStatus}`);
  lostMoney += Number(r.collectedAmount ?? 0);
}
if (lostMoney > 0) console.log(`    💸 Unaccounted: $${lostMoney.toFixed(2)}`);

// ──────────────────────────────────────────────────────────────────
// 5. TIME-BASED FLOW ANALYSIS
// ──────────────────────────────────────────────────────────────────
console.log('\n\n🔍 INVESTIGATION #5: Pipeline Speed Analysis\n');

const completedOrders = await prisma.shipmentRecord.findMany({
  where: {
    odooSyncStatus: 'paid',
    deliveredAt: { not: null },
    createdAt: { not: undefined }
  },
  select: {
    shopifyOrderName: true,
    createdAt: true,
    deliveredAt: true,
    odooSyncedAt: true
  },
  take: 10,
  orderBy: { odooSyncedAt: 'desc' }
});

console.log('Last 10 fully processed orders - Time from delivery to payment:');
for (const r of completedOrders) {
  if (!r.deliveredAt || !r.odooSyncedAt) continue;
  const deliveryToSync = Math.round((r.odooSyncedAt.getTime() - r.deliveredAt.getTime()) / 1000 / 60 / 60);
  console.log(`  ${r.shopifyOrderName}: delivered → invoice/payment in ${deliveryToSync} hours`);
}

// ──────────────────────────────────────────────────────────────────
// 6. FAILED PAYLOADS - WHAT'S BLOCKED?
// ──────────────────────────────────────────────────────────────────
console.log('\n\n🔍 INVESTIGATION #6: Failed Payloads Summary\n');

const failureSources = await prisma.failedPayload.groupBy({
  by: ['source'],
  _count: true,
  orderBy: { _count: { source: 'desc' } }
});

console.log('Failure sources:');
for (const f of failureSources) {
  console.log(`  ${f.source}: ${f._count}`);
}

// Get unique failure reasons in last 24h
const recentFails = await prisma.failedPayload.findMany({
  where: {
    createdAt: { gt: new Date(Date.now() - 86400000) }
  },
  select: { reason: true, source: true },
  take: 100
});

const uniqueReasons = new Map<string, number>();
for (const f of recentFails) {
  const key = `[${f.source}] ${f.reason.slice(0, 80)}`;
  uniqueReasons.set(key, (uniqueReasons.get(key) || 0) + 1);
}

console.log('\nUnique failure reasons (last 24h):');
for (const [reason, count] of [...uniqueReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${count}× ${reason}`);
}

await prisma.$disconnect();
