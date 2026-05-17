/**
 * Check recent sync failures + open shipments status
 */
import { prisma } from '../lib/prisma.js';

// Recent failed payloads from sync
const fails = await prisma.failedPayload.findMany({
  where: {
    source: { in: ['accurate-polling-sync', 'accurate-shipment-status', 'odoo-collected-sync'] }
  },
  orderBy: { createdAt: 'desc' },
  take: 20
});

console.log(`\n══ Recent sync failures (${fails.length}) ══════════════════════════`);
for (const f of fails) {
  console.log(`  [${f.source}] ${f.externalId} | ${f.reason.slice(0, 100)} | ${f.createdAt.toISOString()}`);
}

// Count open shipments
const open = await prisma.shipmentRecord.count({
  where: {
    accurateShipmentId: { not: null },
    collectionStatus: { notIn: ['collected', 'returned', 'returned-settled', 'cancelled'] }
  }
});
console.log(`\n══ Open shipments (not yet collected/returned): ${open}`);

// What collection statuses exist?
const statuses = await prisma.shipmentRecord.groupBy({
  by: ['collectionStatus'],
  _count: true,
  orderBy: { _count: { collectionStatus: 'desc' } }
});
console.log('\n══ Collection status breakdown:');
for (const s of statuses) {
  console.log(`  ${s.collectionStatus ?? 'null'}: ${s._count}`);
}

await prisma.$disconnect();
