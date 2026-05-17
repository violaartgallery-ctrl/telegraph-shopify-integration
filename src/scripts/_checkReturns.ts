/**
 * Check if the 5 returns got their bills
 */
import { prisma } from '../lib/prisma.js';

const orderNames = ['#1841', '#1810', '#1789', '#1876', '#1786'];

console.log('\n══ Status الـ 5 returns ════════════════════════════\n');

for (const name of orderNames) {
  const r = await prisma.shipmentRecord.findFirst({
    where: { shopifyOrderName: name },
    select: {
      shopifyOrderName: true,
      collectionStatus: true,
      returnedValue: true,
      odooReturnBillId: true,
      odooReturnPaymentId: true,
      odooSyncStatus: true,
      odooLastError: true,
      odooSyncedAt: true,
      lastSyncedAt: true
    }
  });
  
  if (!r) {
    console.log(`  ${name}: NOT FOUND`);
    continue;
  }
  
  const billStatus = r.odooReturnBillId ? `✅ Bill ID=${r.odooReturnBillId}` : '❌ NO BILL';
  const paymentStatus = r.odooReturnPaymentId ? `✅ Paid` : '⏳ No payment';
  const synced = r.lastSyncedAt?.toISOString().slice(11, 16) ?? 'never';
  
  console.log(`  ${r.shopifyOrderName} ($${r.returnedValue}):`);
  console.log(`    Status: ${r.collectionStatus} | odoo=${r.odooSyncStatus}`);
  console.log(`    Bill: ${billStatus}`);
  console.log(`    Payment: ${paymentStatus}`);
  console.log(`    Last sync: ${synced}`);
  if (r.odooLastError) console.log(`    Error: ${r.odooLastError.slice(0, 100)}`);
  console.log('');
}

// Check failed payloads for these
console.log('\n══ Recent failed payloads (last 30 min) ═════════════\n');
const recentFails = await prisma.failedPayload.findMany({
  where: {
    source: 'odoo-return-charge-sync',
    createdAt: { gt: new Date(Date.now() - 30 * 60000) }
  },
  select: { externalId: true, reason: true, createdAt: true },
  orderBy: { createdAt: 'desc' }
});

if (recentFails.length === 0) {
  console.log('  ✅ مفيش failures جديدة');
} else {
  for (const f of recentFails) {
    console.log(`  ${f.createdAt.toISOString().slice(11, 16)} | ${f.externalId}`);
    console.log(`    ${f.reason.slice(0, 100)}`);
  }
}

await prisma.$disconnect();
