/**
 * Deep inspection - find what's REALLY broken
 */
import { prisma } from '../lib/prisma.js';

console.log('\n████████████████████████████████████████████████████████████');
console.log('   DEEP INSPECTION - فين المشكله بالظبط؟');
console.log('████████████████████████████████████████████████████████████\n');

// ──────────────────────────────────────────────────────────────────
// 1. The 162 "sales-order-created" orders - what's wrong with them?
// ──────────────────────────────────────────────────────────────────
console.log('🔍 INVESTIGATION #1: The 162 "sales-order-created" orders\n');

const salesOrderCreated = await prisma.shipmentRecord.findMany({
  where: { odooSyncStatus: 'sales-order-created' },
  select: {
    shopifyOrderName: true,
    odooSaleOrderName: true,
    odooInvoiceName: true,
    accurateShipmentCode: true,
    accurateStatus: true,
    accurateIsTerminal: true,
    collectionStatus: true,
    collectedAmount: true,
    deliveredAt: true,
    updatedAt: true
  }
});

// Group by accurate status
const accurateBreakdown: Record<string, number> = {};
const collectionBreakdown: Record<string, number> = {};
const terminalBreakdown: Record<string, number> = {};

for (const r of salesOrderCreated) {
  const ac = r.accurateStatus || 'NULL';
  accurateBreakdown[ac] = (accurateBreakdown[ac] || 0) + 1;
  
  const cs = r.collectionStatus || 'NULL';
  collectionBreakdown[cs] = (collectionBreakdown[cs] || 0) + 1;
  
  const tm = r.accurateIsTerminal === null ? 'NULL' : String(r.accurateIsTerminal);
  terminalBreakdown[tm] = (terminalBreakdown[tm] || 0) + 1;
}

console.log('  By Accurate Status:');
for (const [s, c] of Object.entries(accurateBreakdown).sort((a,b) => b[1]-a[1])) {
  console.log(`    ${s}: ${c}`);
}

console.log('\n  By Collection Status:');
for (const [s, c] of Object.entries(collectionBreakdown).sort((a,b) => b[1]-a[1])) {
  console.log(`    ${s}: ${c}`);
}

console.log('\n  By isTerminal:');
for (const [s, c] of Object.entries(terminalBreakdown).sort((a,b) => b[1]-a[1])) {
  console.log(`    ${s}: ${c}`);
}

// ──────────────────────────────────────────────────────────────────
// 2. How many are TERMINAL (not synced anymore)?
// ──────────────────────────────────────────────────────────────────
console.log('\n\n🔍 INVESTIGATION #2: Orders excluded from sync (Terminal)\n');

const terminal = await prisma.shipmentRecord.count({
  where: { accurateIsTerminal: true }
});

const notTerminal = await prisma.shipmentRecord.count({
  where: { 
    OR: [
      { accurateIsTerminal: false },
      { accurateIsTerminal: null }
    ]
  }
});

console.log(`  Terminal (excluded from sync): ${terminal}`);
console.log(`  Active (will be synced): ${notTerminal}`);

// ──────────────────────────────────────────────────────────────────
// 3. Orders that SHOULD have been processed by sync-open-shipments
// ──────────────────────────────────────────────────────────────────
console.log('\n\n🔍 INVESTIGATION #3: Open shipments waiting for sync\n');

const openShipments = await prisma.shipmentRecord.findMany({
  where: {
    accurateShipmentId: { not: null },
    OR: [
      { accurateIsTerminal: null },
      { accurateIsTerminal: false }
    ]
  },
  select: {
    shopifyOrderName: true,
    accurateShipmentCode: true,
    accurateStatus: true,
    collectionStatus: true,
    odooSyncStatus: true,
    odooInvoiceName: true,
    lastSyncedAt: true,
    updatedAt: true
  },
  orderBy: { updatedAt: 'desc' }
});

console.log(`  Total open shipments: ${openShipments.length}`);

// Group by last sync time
const now = Date.now();
const within1h = openShipments.filter(s => s.lastSyncedAt && (now - s.lastSyncedAt.getTime()) < 3600000).length;
const within24h = openShipments.filter(s => s.lastSyncedAt && (now - s.lastSyncedAt.getTime()) < 86400000).length;
const neverSynced = openShipments.filter(s => !s.lastSyncedAt).length;

console.log(`    Synced within 1 hour:  ${within1h}`);
console.log(`    Synced within 24 hours: ${within24h}`);
console.log(`    NEVER synced:           ${neverSynced}`);

// Show 10 oldest synced
console.log(`\n  10 OLDEST sync times (most stale):`);
const sorted = [...openShipments].sort((a, b) => {
  if (!a.lastSyncedAt) return -1;
  if (!b.lastSyncedAt) return 1;
  return a.lastSyncedAt.getTime() - b.lastSyncedAt.getTime();
});
for (const s of sorted.slice(0, 10)) {
  const synced = s.lastSyncedAt?.toISOString().slice(0, 16) ?? 'NEVER';
  console.log(`    ${s.shopifyOrderName}: ${s.accurateShipmentCode} | lastSync=${synced} | invoice=${s.odooInvoiceName ?? 'NONE'}`);
}

// ──────────────────────────────────────────────────────────────────
// 4. THE BIG PICTURE - why no invoices?
// ──────────────────────────────────────────────────────────────────
console.log('\n\n🔍 INVESTIGATION #4: Why are 231 orders without invoices?\n');

const noInvoice = await prisma.shipmentRecord.findMany({
  where: { odooInvoiceName: null },
  select: { 
    odooSyncStatus: true,
    collectionStatus: true,
    accurateIsTerminal: true
  }
});

// Categorize by reason
const reasons: Record<string, number> = {};
for (const r of noInvoice) {
  let reason = '';
  
  if (r.accurateIsTerminal === true) {
    reason = 'Terminal (excluded)';
  } else if (r.odooSyncStatus === 'sales-order-created' && !r.collectionStatus) {
    reason = 'Awaiting Telegraph payment status';
  } else if (r.odooSyncStatus === 'sales-order-created' && r.collectionStatus === 'pending') {
    reason = 'Payment pending in Telegraph';
  } else if (r.odooSyncStatus === 'sales-order-created' && r.collectionStatus === 'collected') {
    reason = 'COLLECTED but invoice not created ❌';
  } else if (r.odooSyncStatus === 'delivery-confirmed' && !r.collectionStatus) {
    reason = 'Delivered, awaiting payment from Telegraph';
  } else if (r.odooSyncStatus === 'delivery-confirmed' && r.collectionStatus === 'pending') {
    reason = 'Delivered, payment pending';
  } else if (r.odooSyncStatus === 'delivery-confirmed' && r.collectionStatus === 'collected') {
    reason = 'Delivered + collected but no invoice ❌';
  } else {
    reason = `Other: status=${r.odooSyncStatus}, collection=${r.collectionStatus}`;
  }
  
  reasons[reason] = (reasons[reason] || 0) + 1;
}

console.log('  Reason breakdown:');
for (const [reason, count] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${count}× ${reason}`);
}

await prisma.$disconnect();
