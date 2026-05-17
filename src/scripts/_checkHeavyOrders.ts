import { prisma } from '../lib/prisma.js';

const rows = await prisma.shipmentRecord.findMany({
  where: { shopifyOrderName: { in: ['#1988', '#1977', '#2009'] } },
  orderBy: { shopifyOrderName: 'asc' }
});

for (const r of rows) {
  console.log('\n── ' + r.shopifyOrderName + ' ───────────────────────────────────');
  console.log('  accurateShipmentCode:', r.accurateShipmentCode);
  console.log('  accurateShipmentId  :', r.accurateShipmentId);
  console.log('  accurateStatus      :', r.accurateStatus);
  console.log('  odooSyncStatus      :', r.odooSyncStatus);
  console.log('  odooSaleOrderId     :', r.odooSaleOrderId);
  console.log('  odooSaleOrderName   :', r.odooSaleOrderName);
  console.log('  odooAttemptCount    :', r.odooAttemptCount);
  console.log('  odooLastError       :', r.odooLastError);
  console.log('  odooRetryAt         :', r.odooRetryAt);
  console.log('  rawOrderJson exists :', !!r.rawOrderJson);
  console.log('  createdAt           :', r.createdAt.toISOString());
  console.log('  updatedAt           :', r.updatedAt.toISOString());
}

await prisma.$disconnect();
