import { prisma } from '../lib/prisma.js';

const rows = await prisma.shipmentRecord.findMany({
  where: {
    OR: [
      { shopifyOrderNumber: '2011' },
      { shopifyOrderNumber: '2010' },
      { shopifyOrderName: '#2011' },
      { shopifyOrderName: '#2010' }
    ]
  }
});

console.log(`Found ${rows.length} record(s):\n`);
for (const r of rows) {
  console.log('─────────────────────────────────────────');
  console.log('  shopifyOrderId      :', r.shopifyOrderId);
  console.log('  shopifyOrderNumber  :', r.shopifyOrderNumber);
  console.log('  shopifyOrderName    :', r.shopifyOrderName);
  console.log('  accurateShipmentId  :', r.accurateShipmentId);
  console.log('  accurateShipmentCode:', r.accurateShipmentCode);
  console.log('  accurateStatus      :', r.accurateStatus);
  console.log('  accurateIsTerminal  :', r.accurateIsTerminal);
  console.log('  odooSyncStatus      :', r.odooSyncStatus);
  console.log('  odooSaleOrderId     :', r.odooSaleOrderId);
  console.log('  odooSaleOrderName   :', r.odooSaleOrderName);
  console.log('  odooLastError       :', r.odooLastError);
  console.log('  odooAttemptCount    :', r.odooAttemptCount);
  console.log('  odooRetryAt         :', r.odooRetryAt);
  console.log('  rawOrderJson exists :', !!r.rawOrderJson);
  console.log('  createdAt           :', r.createdAt.toISOString());
  console.log('  updatedAt           :', r.updatedAt.toISOString());
}

await prisma.$disconnect();
