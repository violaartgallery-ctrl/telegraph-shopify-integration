/**
 * READ-ONLY: investigate the Sandbox.Timedout / HTTP 502 wave on orders 2036-2051.
 */
import { prisma } from '../lib/prisma.js';

const NUMBERS = ['#2036', '#2038', '#2040', '#2042', '#2043', '#2044', '#2047', '#2048', '#2049', '#2051'];

console.log('\n════════════════════════════════════════════════════════════');
console.log('  TIMEOUT WAVE — تحقيق على الأوردرز #2036-#2051');
console.log('════════════════════════════════════════════════════════════\n');

// 1. DB state for these orders
console.log('🔍 STEP 1: حالة الأوردرز في الـ DB\n');
for (const name of NUMBERS) {
  const r = await prisma.shipmentRecord.findFirst({
    where: { shopifyOrderName: name },
    select: {
      shopifyOrderName: true,
      accurateShipmentId: true,
      accurateShipmentCode: true,
      accurateStatus: true,
      odooSyncStatus: true,
      lastError: true,
      odooLastError: true,
      createdAt: true,
      updatedAt: true
    }
  });
  if (!r) { console.log(`  ${name}: NOT FOUND in DB`); continue; }
  const created = r.createdAt.toISOString().slice(0, 16);
  const updated = r.updatedAt.toISOString().slice(0, 16);
  const tg = r.accurateShipmentCode ?? 'NO_SHIPMENT';
  const odoo = r.odooSyncStatus ?? 'null';
  const err = r.lastError?.slice(0, 80) ?? '';
  console.log(`  ${name}: TG=${tg} | odoo=${odoo} | created=${created} | updated=${updated}`);
  if (err) console.log(`    lastError: ${err}`);
}

// 2. Recent failed payloads (last 6 hours)
console.log('\n\n🔍 STEP 2: Failed payloads (آخر 6 ساعات)\n');
const recentFails = await prisma.failedPayload.findMany({
  where: { createdAt: { gt: new Date(Date.now() - 6 * 3600_000) } },
  orderBy: { createdAt: 'desc' },
  select: { source: true, externalId: true, reason: true, createdAt: true }
});

const bySource: Record<string, number> = {};
for (const f of recentFails) {
  bySource[f.source] = (bySource[f.source] || 0) + 1;
}
console.log(`  Total failures (6h): ${recentFails.length}`);
console.log('  By source:');
for (const [s, c] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${s}: ${c}`);
}

console.log('\n  Recent failures (latest 10):');
for (const f of recentFails.slice(0, 10)) {
  console.log(`  ${f.createdAt.toISOString().slice(11, 19)} | ${f.source} | ${f.externalId} | ${f.reason.slice(0, 90)}`);
}

// 3. Telegraph saveShipment failures specifically
console.log('\n\n🔍 STEP 3: Recent shopify-orders-create failures (Telegraph button)\n');
const tgFails = await prisma.failedPayload.findMany({
  where: {
    source: 'shopify-orders-create',
    createdAt: { gt: new Date(Date.now() - 24 * 3600_000) }
  },
  orderBy: { createdAt: 'desc' },
  take: 20,
  select: { externalId: true, reason: true, createdAt: true }
});

console.log(`  Total in last 24h: ${tgFails.length}`);
for (const f of tgFails) {
  console.log(`  ${f.createdAt.toISOString().slice(11, 16)} | ${f.externalId} | ${f.reason.slice(0, 100)}`);
}

// 4. Detect what's running during the wave: check Odoo queue activity
console.log('\n\n🔍 STEP 4: Odoo queue activity overlap\n');
const oneHourAgo = new Date(Date.now() - 3600_000);
const odooActivity = await prisma.shipmentRecord.count({
  where: { odooSyncedAt: { gt: oneHourAgo } }
});
const tgActivity = await prisma.shipmentRecord.count({
  where: {
    accurateShipmentCode: { not: null },
    createdAt: { gt: oneHourAgo }
  }
});
console.log(`  Odoo activities last hour: ${odooActivity}`);
console.log(`  Telegraph shipments created last hour: ${tgActivity}`);

// 5. Show what the system status looked like around those failures
console.log('\n\n🔍 STEP 5: Heavy load indicators\n');
const orphans = await prisma.shipmentRecord.count({
  where: {
    odooSyncStatus: { in: ['odoo-so-creating', 'odoo-stock-preparing', 'odoo-delivery-confirming'] }
  }
});
console.log(`  Orders stuck in processing right now: ${orphans}`);

const queueDepth = await prisma.shipmentRecord.count({
  where: {
    odooSyncStatus: { in: ['odoo-so-pending', 'odoo-stock-pending', 'odoo-delivery-pending', 'odoo-failed-retryable'] }
  }
});
console.log(`  Queue depth (pending): ${queueDepth}`);

await prisma.$disconnect();
