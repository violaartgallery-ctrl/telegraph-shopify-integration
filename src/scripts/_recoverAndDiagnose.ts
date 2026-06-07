/**
 * Recovery for #2842 + diagnose the 311 stale + 3391 mark-as-paid pattern.
 */
import { prisma } from '../lib/prisma.js';

const now = Date.now();

// 1. Recover #2842 stuck at sales-order-creating
console.log('=== Phase 1: Recover #2842 ===');
const r2842 = await prisma.shipmentRecord.findFirst({
  where: { shopifyOrderName: '#2842' },
  select: { id: true, odooSyncStatus: true, odooSaleOrderId: true, accurateShipmentId: true }
});
console.log('  Before:', JSON.stringify(r2842));
if (r2842 && r2842.odooSyncStatus === 'sales-order-creating') {
  // It has an SO but no shipment. Move it back to a state the queue/cron can handle.
  // Since no Telegraph shipment, V7 queue won't help. Mark as failed for manual review.
  await prisma.shipmentRecord.updateMany({
    where: { id: r2842.id, odooSyncStatus: 'sales-order-creating' },
    data: {
      odooSyncStatus: r2842.odooSaleOrderId ? 'sales-order-created' : 'odoo-so-pending',
      odooLastError: 'Recovered from stuck sales-order-creating (no Telegraph shipment, manual review)',
      odooAttemptCount: 0,
      odooSyncedAt: new Date()
    }
  });
  const after = await prisma.shipmentRecord.findUnique({ where: { id: r2842.id }, select: { odooSyncStatus: true } });
  console.log('  After: ' + after?.odooSyncStatus);
} else {
  console.log('  No action needed.');
}

// 2. Stale shipments — check their Telegraph last status to see if they're terminal but mis-flagged
console.log('\n=== Phase 2: Stale shipments — what statuses are they in? ===');
const stale = await prisma.shipmentRecord.groupBy({
  by: ['accurateStatus', 'collectionStatus'],
  _count: true,
  where: {
    accurateShipmentId: { not: null },
    accurateIsTerminal: false,
    lastSyncedAt: { lt: new Date(now - 4 * 3600_000) }
  },
  orderBy: { _count: { accurateStatus: 'desc' } }
});
console.log('  Top groupings:');
for (const s of stale.slice(0, 15)) {
  console.log('    ' + (s.accurateStatus ?? 'null').padEnd(30) + ' / ' + (s.collectionStatus ?? 'null').padEnd(25) + ': ' + s._count);
}

// 3. Mark-as-paid spam — count repeat offenders by status
console.log('\n=== Phase 3: Mark-as-paid spam — collection states ===');
const markFailIds = await prisma.failedPayload.findMany({
  where: { source: 'shopify-mark-as-paid', createdAt: { gt: new Date(now - 24 * 3600_000) } },
  select: { externalId: true },
  distinct: ['externalId']
});
console.log('  Unique orders failing mark-as-paid (last 24h): ' + markFailIds.length);
if (markFailIds.length > 0) {
  const ids = markFailIds.slice(0, 10).map((m) => m.externalId).filter(Boolean) as string[];
  const recs = await prisma.shipmentRecord.findMany({
    where: { shopifyOrderId: { in: ids } },
    select: { shopifyOrderName: true, collectionStatus: true, odooSyncStatus: true, odooInvoiceId: true }
  });
  console.log('  Sample state of repeat offenders:');
  for (const r of recs) {
    console.log('    ' + (r.shopifyOrderName ?? '?').padEnd(8) + ' | collection=' + r.collectionStatus + ' | odoo=' + r.odooSyncStatus + ' | invoice=' + (r.odooInvoiceId ?? 'none'));
  }
}

await prisma.$disconnect();
