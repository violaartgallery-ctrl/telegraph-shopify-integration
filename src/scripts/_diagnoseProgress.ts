/**
 * Diagnose: What caused these changes?
 * Manual runs vs Automatic cron
 */
import { prisma } from '../lib/prisma.js';

console.log('\n════════════════════════════════════════════════════════════');
console.log('   فين الفرق جاي من؟ المانيوال ولا الـ Auto-Cron?');
console.log('════════════════════════════════════════════════════════════\n');

// Check the 14 newly paid orders - when were they updated?
const recentlyPaid = await prisma.shipmentRecord.findMany({
  where: { odooSyncStatus: 'paid' },
  select: {
    shopifyOrderName: true,
    odooSyncStatus: true,
    odooInvoiceName: true,
    collectionStatus: true,
    odooSyncedAt: true
  },
  orderBy: { odooSyncedAt: 'desc' },
  take: 15
});

console.log('📊 LAST 15 PAID ORDERS - When were they processed?\n');
for (const r of recentlyPaid) {
  const time = r.odooSyncedAt?.toISOString().slice(11, 16) ?? 'unknown';
  const hasInvoice = r.odooInvoiceName ? '✅' : '❌';
  console.log(`  ${r.shopifyOrderName}: ${time} | ${hasInvoice} invoice | status=${r.odooSyncStatus}`);
}

// Check order #1763 specifically - when did invoice get created?
console.log('\n\n🔍 ORDER #1763 - WHEN DID INVOICE GET CREATED?\n');
const order1763 = await prisma.shipmentRecord.findFirst({
  where: { shopifyOrderName: '#1763' }
});

console.log(`  Invoice: ${order1763?.odooInvoiceName}`);
console.log(`  Last synced: ${order1763?.odooSyncedAt?.toISOString()}`);

// Check failed payloads for 1763 - any recent successes?
const failures1763 = await prisma.failedPayload.findMany({
  where: { externalId: order1763?.shopifyOrderId },
  orderBy: { createdAt: 'desc' },
  take: 5
});

console.log(`\n  Failure history:`);
for (const f of failures1763) {
  console.log(`    ${f.createdAt.toISOString().slice(0, 16)} | ${f.source}`);
}

// Estimate: Manual runs were at 18:11, 18:20, 18:21, 18:22
// If recent updates are after 18:22, they're from automatic cron
const cutoffTime = new Date('2026-05-16T18:22:00Z');
const afterManualRuns = recentlyPaid.filter(r => r.odooSyncedAt && r.odooSyncedAt > cutoffTime);

console.log('\n\n════════════════════════════════════════════════════════════');
console.log('🎯 CONCLUSION:\n');

if (afterManualRuns.length > 0) {
  console.log(`  ✅ AUTOMATIC CRON IS RUNNING!`);
  console.log(`    ${afterManualRuns.length} orders were processed AFTER manual runs ended`);
  console.log(`    (after 18:22 UTC today)`);
  console.log(`\n  This means:`);
  console.log(`    1. Netlify may have auto-redeployed`);
  console.log(`    2. OR someone triggered a redeploy`);
  console.log(`    3. The cron is NOW working ✅`);
} else {
  console.log(`  ❌ All changes from MANUAL queue processor runs`);
  console.log(`    Automatic cron still not running`);
}

await prisma.$disconnect();
