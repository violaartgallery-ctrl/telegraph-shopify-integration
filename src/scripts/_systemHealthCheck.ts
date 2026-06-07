/**
 * READ-ONLY system-wide health check across all pipelines:
 *   1. Telegraph (shipment creation + status polling)
 *   2. Odoo Sales Order queue (V7 background queue)
 *   3. Odoo invoices (collected → invoice → payment)
 *   4. Shopify webhook + fulfillment health
 *   5. Failed payloads / retry-able records
 *   6. Recent activity / staleness
 */
import { prisma } from '../lib/prisma.js';
import { OdooClient } from '../odoo/odooClient.js';
import { calculateMerchantInvoiceTarget } from '../odoo/odooSyncService.js';

const odoo = new OdooClient();

console.log('\n████████████████████████████████████████████████████████████');
console.log('   SYSTEM-WIDE HEALTH CHECK');
console.log('████████████████████████████████████████████████████████████\n');

const now = Date.now();
const HOUR = 3_600_000;

// ─── 1. Telegraph / shipment health ────────────────────────────────
console.log('🚚 1. TELEGRAPH SHIPMENT HEALTH\n');
const tgRecent = await prisma.shipmentRecord.findMany({
  where: { createdAt: { gt: new Date(now - 24 * HOUR) } },
  select: { shopifyOrderName: true, accurateShipmentId: true, accurateShipmentCode: true, accurateStatus: true, createdAt: true, lastError: true, lastSyncedAt: true }
});
const tgWithShipment = tgRecent.filter((r) => r.accurateShipmentId).length;
const tgFailed = tgRecent.filter((r) => !r.accurateShipmentId && r.lastError).length;
const tgPending = tgRecent.filter((r) => !r.accurateShipmentId && !r.lastError).length;
console.log('  Last 24h orders created in DB: ' + tgRecent.length);
console.log('    ✅ With Telegraph shipment:  ' + tgWithShipment);
console.log('    ⏳ Pending (no error):       ' + tgPending);
console.log('    ❌ Failed:                   ' + tgFailed);

// Stale sync (open shipments not synced in 30 min)
const staleSync = await prisma.shipmentRecord.findMany({
  where: {
    accurateShipmentId: { not: null },
    accurateIsTerminal: false,
    OR: [
      { lastSyncedAt: null },
      { lastSyncedAt: { lt: new Date(now - 30 * 60_000) } }
    ]
  },
  select: { shopifyOrderName: true, lastSyncedAt: true }
});
console.log('  Open shipments stale (>30 min since last sync): ' + staleSync.length);
if (staleSync.length > 0 && staleSync.length <= 10) {
  for (const s of staleSync.slice(0, 5)) {
    const age = s.lastSyncedAt ? Math.round((now - s.lastSyncedAt.getTime()) / 60000) + ' min' : 'never';
    console.log('    ' + (s.shopifyOrderName ?? '?') + ' — last sync ' + age + ' ago');
  }
}

// ─── 2. Odoo Sales Order queue ─────────────────────────────────────
console.log('\n📦 2. ODOO SALES ORDER QUEUE\n');
const queueStates = await prisma.shipmentRecord.groupBy({
  by: ['odooSyncStatus'],
  _count: true,
  where: {
    odooSyncStatus: {
      in: ['odoo-so-pending', 'odoo-so-creating', 'odoo-stock-pending', 'odoo-stock-preparing',
            'odoo-delivery-pending', 'odoo-delivery-confirming', 'odoo-failed-retryable', 'failed']
    }
  }
});
const totalActiveQueue = queueStates.reduce((s, x) => s + x._count, 0);
console.log('  Active queue depth: ' + totalActiveQueue);
for (const s of queueStates) {
  const icon = s.odooSyncStatus === 'failed' ? '❌' : s.odooSyncStatus === 'odoo-failed-retryable' ? '⚠️' : '⏳';
  console.log('    ' + icon + ' ' + (s.odooSyncStatus ?? '?').padEnd(28) + ': ' + s._count);
}

// Stuck-processing (in -creating/-preparing/-confirming for >15 min)
const stuckProcessing = await prisma.shipmentRecord.findMany({
  where: {
    odooSyncStatus: { in: ['odoo-so-creating', 'odoo-stock-preparing', 'odoo-delivery-confirming'] },
    odooSyncedAt: { lt: new Date(now - 15 * 60_000) }
  },
  select: { shopifyOrderName: true, odooSyncStatus: true, odooSyncedAt: true }
});
console.log('  Stuck-processing (>15 min): ' + stuckProcessing.length);
for (const s of stuckProcessing.slice(0, 5)) {
  const age = s.odooSyncedAt ? Math.round((now - s.odooSyncedAt.getTime()) / 60000) + ' min' : '?';
  console.log('    ' + (s.shopifyOrderName ?? '?') + ' | ' + s.odooSyncStatus + ' | ' + age + ' ago');
}

// V7-orphans at sales-order-created (the bug we squashed)
const v7Orphans = await prisma.shipmentRecord.count({
  where: {
    odooSyncStatus: 'sales-order-created',
    accurateShipmentId: { not: null },
    odooSaleOrderId: { not: null },
    odooInvoiceId: null,
    odooPaymentId: null,
    odooSalePaymentId: null,
    NOT: { OR: [
      { collectionStatus: 'collected' },
      { collectionStatus: 'returned' },
      { collectionStatus: 'returned-settled' },
      { collectionStatus: 'payment-review' }
    ]}
  }
});
console.log('  V7-orphans at `sales-order-created`: ' + v7Orphans);

// ─── 3. Odoo invoices ──────────────────────────────────────────────
console.log('\n💰 3. ODOO INVOICES HEALTH\n');
const paidRecs = await prisma.shipmentRecord.findMany({
  where: { odooSyncStatus: { in: ['paid', 'paid-existing'] }, odooInvoiceId: { not: null } },
  select: { shopifyOrderName: true, odooInvoiceId: true, collectedAmount: true, deliveryFees: true, customerDue: true }
});
const invIds = paidRecs.map((r) => r.odooInvoiceId!);
const invs = invIds.length === 0 ? [] : await odoo.searchRead<{ id: number; name?: string; payment_state?: string; amount_total?: number; amount_residual?: number }>(
  'account.move',
  [['id', 'in', invIds]],
  ['name', 'payment_state', 'amount_total', 'amount_residual'],
  { limit: invIds.length }
);
const invMap = new Map(invs.map((i) => [i.id, i]));
let invPaid = 0, invPartial = 0, invMismatch = 0;
const mismatchedExamples: string[] = [];
for (const r of paidRecs) {
  const inv = invMap.get(r.odooInvoiceId!);
  if (!inv) continue;
  if (inv.payment_state === 'paid') { invPaid++; continue; }
  const target = calculateMerchantInvoiceTarget({ collectedAmount: r.collectedAmount, deliveryFees: r.deliveryFees, customerDue: r.customerDue });
  if (target === null) continue;
  if (Number(inv.amount_total ?? 0) > target + 0.01) {
    invPartial++;
    invMismatch++;
    if (mismatchedExamples.length < 5) mismatchedExamples.push((r.shopifyOrderName ?? '?') + '/' + inv.name + ' total=' + inv.amount_total + ' target=' + target);
  } else if (inv.payment_state === 'partial') {
    invPartial++;
  }
}
console.log('  Total paid/paid-existing records with invoice: ' + paidRecs.length);
console.log('    ✅ Fully paid:                  ' + invPaid);
console.log('    ⚠️ Partial:                     ' + invPartial);
console.log('    🚨 Partial w/ net-due mismatch: ' + invMismatch);
if (mismatchedExamples.length > 0) {
  console.log('  Mismatched examples:');
  for (const e of mismatchedExamples) console.log('    ' + e);
}

// ─── 4. Shopify (fulfillment + mark-as-paid failures) ──────────────
console.log('\n🛒 4. SHOPIFY HEALTH\n');
const shopifyFailures = await prisma.failedPayload.groupBy({
  by: ['source'],
  _count: true,
  where: {
    source: { in: ['shopify-mark-as-paid', 'shopify-fulfillment-create', 'shopify-orders-create'] },
    createdAt: { gt: new Date(now - 24 * HOUR) }
  }
});
console.log('  Shopify-side failures in last 24h:');
let totalShopifyFails = 0;
for (const s of shopifyFailures) {
  totalShopifyFails += s._count;
  console.log('    ' + s.source.padEnd(28) + ': ' + s._count);
}
if (totalShopifyFails === 0) console.log('    (none) ✅');

// ─── 5. Failed payloads (last 24h, all sources) ────────────────────
console.log('\n📛 5. FAILED PAYLOADS (last 24h, all sources)\n');
const recentFails = await prisma.failedPayload.groupBy({
  by: ['source'],
  _count: true,
  where: { createdAt: { gt: new Date(now - 24 * HOUR) } }
});
const totalFails = recentFails.reduce((s, x) => s + x._count, 0);
console.log('  Total: ' + totalFails);
for (const s of recentFails.sort((a, b) => b._count - a._count)) {
  console.log('    ' + s.source.padEnd(35) + ': ' + s._count);
}

// ─── 6. Throughput (last 24h) ──────────────────────────────────────
console.log('\n📈 6. THROUGHPUT (last 24h)\n');
const completedRecently = await prisma.shipmentRecord.count({
  where: { odooSyncStatus: { in: ['paid', 'paid-existing', 'delivery-confirmed'] }, odooSyncedAt: { gt: new Date(now - 24 * HOUR) } }
});
const createdRecently = await prisma.shipmentRecord.count({
  where: { createdAt: { gt: new Date(now - 24 * HOUR) } }
});
console.log('  Orders created in DB:                ' + createdRecently);
console.log('  Reached delivery-confirmed / paid:   ' + completedRecently);

// ─── Verdict ───────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
const issues: string[] = [];
if (tgFailed > 0) issues.push(tgFailed + ' Telegraph creation failures');
if (staleSync.length > 30) issues.push(staleSync.length + ' stale syncs (cron behind?)');
const queueFailed = queueStates.find((q) => q.odooSyncStatus === 'failed');
if (queueFailed && queueFailed._count > 0) issues.push(queueFailed._count + ' records in `failed`');
if (stuckProcessing.length > 0) issues.push(stuckProcessing.length + ' stuck-processing');
if (v7Orphans > 0) issues.push(v7Orphans + ' V7 orphans');
if (invMismatch > 0) issues.push(invMismatch + ' net-due partial invoices');
if (issues.length === 0) {
  console.log('🟢 ALL CLEAR — system healthy.');
} else {
  console.log('🟡 Issues:');
  for (const i of issues) console.log('  • ' + i);
}
console.log('══════════════════════════════════════════════════════════════\n');

await prisma.$disconnect();
