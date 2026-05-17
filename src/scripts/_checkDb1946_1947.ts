import { prisma } from '../lib/prisma.js';

const recs = await prisma.shipmentRecord.findMany({
  where: { shopifyOrderId: { in: ['10589568336164', '10589613588772'] } },
  select: {
    id: true, shopifyOrderId: true, shopifyOrderName: true,
    accurateShipmentId: true, accurateShipmentCode: true, accurateStatus: true,
    odooSyncStatus: true, odooSaleOrderName: true, odooSaleOrderId: true,
    lastError: true, odooLastError: true
  }
});

for (const r of recs) {
  console.log(`\nOrder: ${r.shopifyOrderName ?? r.shopifyOrderId}`);
  console.log(`  accurateShipmentId  : ${r.accurateShipmentId ?? 'NULL'}`);
  console.log(`  accurateShipmentCode: ${r.accurateShipmentCode ?? 'NULL'}`);
  console.log(`  accurateStatus      : ${r.accurateStatus ?? 'NULL'}`);
  console.log(`  odooSyncStatus      : ${r.odooSyncStatus ?? 'NULL'}`);
  console.log(`  odooSaleOrderName   : ${r.odooSaleOrderName ?? 'NULL'}`);
  console.log(`  odooSaleOrderId     : ${r.odooSaleOrderId ?? 'NULL'}`);
  console.log(`  lastError           : ${r.lastError ?? 'NULL'}`);
  console.log(`  odooLastError       : ${r.odooLastError ?? 'NULL'}`);
}

await prisma.$disconnect();
