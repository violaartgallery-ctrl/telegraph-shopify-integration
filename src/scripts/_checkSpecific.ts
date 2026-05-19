import { prisma } from '../lib/prisma.js';
const names = ['#2080','#2083','#2086','#2087','#2088','#2091','#2097','#2098','#2104','#2110','#2112'];
const r = await prisma.shipmentRecord.findMany({
  where: { shopifyOrderName: { in: names } },
  select: { shopifyOrderName: true, odooSyncStatus: true, odooSaleOrderName: true, accurateShipmentCode: true, odooLastError: true, odooInvoiceName: true }
});
r.sort((a,b) => (a.shopifyOrderName||'').localeCompare(b.shopifyOrderName||''));
r.forEach(x => console.log((x.shopifyOrderName||'').padEnd(8), '|', (x.odooSyncStatus||'null').padEnd(25), '|', (x.odooSaleOrderName||'-').padEnd(11), '|', (x.accurateShipmentCode||'-').padEnd(12), '|', (x.odooInvoiceName||'-').padEnd(15), '|', (x.odooLastError||'').slice(0,50)));
await prisma.$disconnect();
