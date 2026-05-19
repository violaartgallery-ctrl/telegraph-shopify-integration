import { prisma } from '../lib/prisma.js';
import { OdooClient } from '../odoo/odooClient.js';
const odoo = new OdooClient();

const stuck = ['#2080','#2083','#2086','#2087','#2088','#2091','#2097','#2098','#2104','#2110','#2112'];
const partialInvoices = [403934, 403921, 403935, 403936, 403937, 403938, 403940, 403941, 403942, 403943]
  .map((n) => 'INV/2026/0' + n);

console.log('=== 8 STUCK + #2104 + 2 done ===');
const r = await prisma.shipmentRecord.findMany({
  where: { shopifyOrderName: { in: stuck } },
  select: { shopifyOrderName: true, odooSyncStatus: true, odooSaleOrderName: true }
});
r.sort((a,b) => (a.shopifyOrderName||'').localeCompare(b.shopifyOrderName||''));
for (const x of r) console.log('  ' + (x.shopifyOrderName||'').padEnd(8) + ' | ' + (x.odooSyncStatus||'null').padEnd(25) + ' | ' + (x.odooSaleOrderName||'-'));

console.log('\n=== 10 BACKFILLED INVOICES ===');
const invs = await odoo.searchRead<{ id: number; name?: string; payment_state?: string; amount_total?: number; amount_residual?: number }>(
  'account.move',
  [['name', 'in', partialInvoices]],
  ['name', 'payment_state', 'amount_total', 'amount_residual'],
  { limit: 20 }
);
for (const inv of invs.sort((a,b) => (a.name||'').localeCompare(b.name||''))) {
  const icon = inv.payment_state === 'paid' ? '✅' : '⚠️';
  console.log('  ' + icon + ' ' + (inv.name||'').padEnd(15) + ' | total=' + inv.amount_total + ' | residual=' + inv.amount_residual + ' | ' + inv.payment_state);
}

console.log('\n=== Overall DB queue state ===');
const states = await prisma.shipmentRecord.groupBy({
  by: ['odooSyncStatus'],
  _count: true,
  where: {
    odooSyncStatus: { in: ['odoo-so-pending','odoo-stock-pending','odoo-delivery-pending','odoo-failed-retryable','failed','sales-order-created','delivery-confirmed','paid','paid-existing'] }
  }
});
for (const s of states.sort((a,b) => b._count - a._count)) {
  console.log('  ' + (s.odooSyncStatus||'null').padEnd(28) + ': ' + s._count);
}

await prisma.$disconnect();
