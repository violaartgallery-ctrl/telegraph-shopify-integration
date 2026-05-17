/**
 * Deep analysis: Why are 71 delivered orders missing invoices?
 */
import { prisma } from '../lib/prisma.js';

const delivered = await prisma.shipmentRecord.findMany({
  where: { odooSyncStatus: 'delivery-confirmed' },
  select: {
    shopifyOrderName: true,
    odooSyncStatus: true,
    odooInvoiceName: true,
    collectionStatus: true,
    collectedAmount: true,
    accurateShipmentId: true,
    accurateShipmentCode: true,
    updatedAt: true
  }
});

console.log(`\n══ 71 DELIVERED ORDERS - INVOICE STATUS ════════════════\n`);

const grouped: Record<string, typeof delivered> = {};
for (const r of delivered) {
  const key = `collection=${r.collectionStatus ?? 'null'} | shipment=${r.accurateShipmentId ? 'yes' : 'no'}`;
  if (!grouped[key]) grouped[key] = [];
  grouped[key].push(r);
}

for (const [key, records] of Object.entries(grouped)) {
  console.log(`\n📊 ${key}: ${records.length} orders`);
  for (const r of records.slice(0, 3)) {
    console.log(`   ${r.shopifyOrderName}: collected=$${r.collectedAmount ?? 'null'} | invoice=${r.odooInvoiceName ?? 'NONE'}`);
  }
  if (records.length > 3) console.log(`   ... and ${records.length - 3} more`);
}

console.log('\n══ SUMMARY ════════════════════════════════════════════════');
const byCollection: Record<string, number> = {};
for (const r of delivered) {
  const status = r.collectionStatus ?? 'null';
  byCollection[status] = (byCollection[status] || 0) + 1;
}

console.log(`\nOf the 71 delivered orders:`);
for (const [status, count] of Object.entries(byCollection)) {
  console.log(`  - Collection status "${status}": ${count} orders (no invoice yet)`);
}

await prisma.$disconnect();
