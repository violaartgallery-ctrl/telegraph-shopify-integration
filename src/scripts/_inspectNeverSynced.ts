/**
 * Investigate the 49 orders that have NEVER been synced
 */
import { prisma } from '../lib/prisma.js';

console.log('\n════════════════════════════════════════════════════════════');
console.log('   ليه 49 order ما اتسنكوش أبداً؟');
console.log('════════════════════════════════════════════════════════════\n');

const neverSynced = await prisma.shipmentRecord.findMany({
  where: {
    lastSyncedAt: null,
    accurateShipmentId: { not: null },
    OR: [
      { accurateIsTerminal: null },
      { accurateIsTerminal: false }
    ]
  },
  select: {
    shopifyOrderName: true,
    accurateShipmentCode: true,
    accurateShipmentId: true,
    accurateStatus: true,
    accurateIsTerminal: true,
    odooSyncStatus: true,
    odooInvoiceName: true,
    createdAt: true,
    updatedAt: true,
    lastError: true
  },
  orderBy: { createdAt: 'desc' }
});

console.log(`📊 Total never-synced orders: ${neverSynced.length}\n`);

console.log('Newest orders (top 20):');
for (const r of neverSynced.slice(0, 20)) {
  const created = r.createdAt.toISOString().slice(0, 16);
  const error = r.lastError ? ` | ERROR=${r.lastError.slice(0, 50)}` : '';
  console.log(`  ${r.shopifyOrderName}: ${r.accurateShipmentCode} (ID=${r.accurateShipmentId})`);
  console.log(`    odooStatus=${r.odooSyncStatus} | accurate=${r.accurateStatus}${error}`);
  console.log(`    createdAt=${created}`);
}

// Count by odooSyncStatus
console.log('\n📊 By Odoo Status:');
const byOdooStatus: Record<string, number> = {};
for (const r of neverSynced) {
  const status = r.odooSyncStatus || 'NULL';
  byOdooStatus[status] = (byOdooStatus[status] || 0) + 1;
}
for (const [status, count] of Object.entries(byOdooStatus).sort((a,b) => b[1]-a[1])) {
  console.log(`  ${status}: ${count}`);
}

await prisma.$disconnect();
