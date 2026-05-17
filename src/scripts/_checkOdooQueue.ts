/**
 * Check the Odoo background queue status
 */
import { prisma } from '../lib/prisma.js';

const queue = await prisma.shipmentRecord.findMany({
  where: {
    odooSyncStatus: {
      in: [
        'odoo-so-pending', 'odoo-so-creating',
        'odoo-stock-pending', 'odoo-stock-preparing',
        'odoo-delivery-pending', 'odoo-delivery-confirming',
        'odoo-failed-retryable'
      ]
    }
  },
  select: {
    id: true, shopifyOrderName: true, odooSyncStatus: true,
    odooAttemptCount: true, odooRetryAt: true, odooLastError: true,
    odooSaleOrderName: true, accurateShipmentCode: true, updatedAt: true
  },
  orderBy: { updatedAt: 'asc' }
});

console.log(`\n══ Odoo Queue (${queue.length} records) ══════════════════════════`);
for (const r of queue) {
  console.log(`\n  ${r.shopifyOrderName}: ${r.accurateShipmentCode}`);
  console.log(`    status      : ${r.odooSyncStatus}`);
  console.log(`    attempts    : ${r.odooAttemptCount}`);
  console.log(`    retryAt     : ${r.odooRetryAt?.toISOString() ?? 'null'}`);
  console.log(`    lastError   : ${r.odooLastError?.slice(0, 100) ?? 'null'}`);
  console.log(`    updatedAt   : ${r.updatedAt.toISOString()}`);
}

// Status breakdown of ALL records
const breakdown = await prisma.shipmentRecord.groupBy({
  by: ['odooSyncStatus'],
  _count: true,
  orderBy: { _count: { odooSyncStatus: 'desc' } }
});

console.log('\n══ All Odoo Status Breakdown ══════════════════════════');
for (const b of breakdown) {
  console.log(`  ${b.odooSyncStatus ?? 'null'}: ${b._count}`);
}

await prisma.$disconnect();
