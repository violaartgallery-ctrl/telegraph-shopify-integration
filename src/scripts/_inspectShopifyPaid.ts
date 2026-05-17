/**
 * Investigate why Shopify mark-as-paid is failing/not happening
 */
import { prisma } from '../lib/prisma.js';

console.log('\n════════════════════════════════════════════════════════════');
console.log('   ليه Shopify mark-as-paid مش بيشتغل?');
console.log('════════════════════════════════════════════════════════════\n');

// Check failed payloads for shopify-mark-as-paid
const shopifyFails = await prisma.failedPayload.findMany({
  where: { source: 'shopify-mark-as-paid' },
  orderBy: { createdAt: 'desc' },
  take: 20
});

console.log(`📊 Total shopify-mark-as-paid failures: ${shopifyFails.length}\n`);

if (shopifyFails.length > 0) {
  console.log('Recent failures:');
  for (const f of shopifyFails.slice(0, 10)) {
    console.log(`  ${f.createdAt.toISOString().slice(0, 16)} | externalId=${f.externalId}`);
    console.log(`    Reason: ${f.reason}`);
    console.log('');
  }
}

// Group by reason
const reasonCount: Record<string, number> = {};
for (const f of shopifyFails) {
  const key = f.reason.slice(0, 80);
  reasonCount[key] = (reasonCount[key] || 0) + 1;
}

console.log('\nReason breakdown:');
for (const [reason, count] of Object.entries(reasonCount)) {
  console.log(`  ${count}× ${reason}`);
}

// Check how many orders are 'collected' in Telegraph
const collected = await prisma.shipmentRecord.count({
  where: { collectionStatus: 'collected' }
});

const collectedRecent = await prisma.shipmentRecord.findMany({
  where: { collectionStatus: 'collected' },
  select: {
    shopifyOrderName: true,
    shopifyOrderId: true,
    collectedAmount: true,
    odooSyncStatus: true,
    odooInvoiceName: true,
    lastSyncedAt: true,
    updatedAt: true
  },
  orderBy: { updatedAt: 'desc' },
  take: 10
});

console.log(`\n\n📊 Total orders in "collected" state: ${collected}\n`);
console.log('Recent 10 collected orders:');
for (const r of collectedRecent) {
  const synced = r.lastSyncedAt?.toISOString().slice(0, 16) ?? 'NEVER';
  console.log(`  ${r.shopifyOrderName}: $${r.collectedAmount} | odoo=${r.odooSyncStatus} | invoice=${r.odooInvoiceName ?? 'NONE'} | lastSync=${synced}`);
}

await prisma.$disconnect();
