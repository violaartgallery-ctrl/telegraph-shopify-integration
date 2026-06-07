import { prisma } from '../lib/prisma.js';

const now = Date.now();

// 1. #2842 stuck details
const r = await prisma.shipmentRecord.findFirst({
  where: { shopifyOrderName: '#2842' },
  select: {
    shopifyOrderName: true, odooSyncStatus: true, odooSaleOrderId: true,
    odooSaleOrderName: true, accurateShipmentId: true, accurateShipmentCode: true,
    odooSyncedAt: true, createdAt: true, odooLastError: true, odooAttemptCount: true
  }
});
console.log('#2842 state:');
console.log(JSON.stringify(r, null, 2));

// 2. Distribution of stale sync ages
const stale = await prisma.shipmentRecord.findMany({
  where: {
    accurateShipmentId: { not: null },
    accurateIsTerminal: false,
    lastSyncedAt: { lt: new Date(now - 4 * 3600_000) }
  },
  select: { lastSyncedAt: true }
});

const buckets: Record<string, number> = { '4-12h': 0, '12-24h': 0, '1-2d': 0, '2-7d': 0, '>7d': 0 };
for (const s of stale) {
  if (!s.lastSyncedAt) continue;
  const hrs = (now - s.lastSyncedAt.getTime()) / 3600_000;
  if (hrs < 12) buckets['4-12h']++;
  else if (hrs < 24) buckets['12-24h']++;
  else if (hrs < 48) buckets['1-2d']++;
  else if (hrs < 168) buckets['2-7d']++;
  else buckets['>7d']++;
}
console.log('\nStale shipment distribution:');
for (const [b, c] of Object.entries(buckets)) console.log('  ' + b.padEnd(8) + ': ' + c);

// 3. Mark-as-paid pattern: who's repeating?
const markFails = await prisma.failedPayload.groupBy({
  by: ['externalId'],
  _count: true,
  where: { source: 'shopify-mark-as-paid', createdAt: { gt: new Date(now - 24 * 3600_000) } },
  orderBy: { _count: { externalId: 'desc' } },
  take: 5
});
console.log('\nshopify-mark-as-paid: top repeat offenders (last 24h):');
for (const f of markFails) {
  const rec = await prisma.shipmentRecord.findUnique({
    where: { shopifyOrderId: f.externalId! },
    select: { shopifyOrderName: true }
  });
  console.log('  ' + (rec?.shopifyOrderName ?? f.externalId) + ': ' + f._count + ' attempts');
}

await prisma.$disconnect();
