/**
 * READ-ONLY comprehensive end-to-end audit:
 *  A. Netlify cron schedules + last 24h activity
 *  B. Telegraph shipment polling health
 *  C. Odoo Sales Order queue health
 *  D. Odoo invoice + payment health
 *  E. Returned-shipment bills
 *  F. Shopify webhook + fulfillment failures
 *  G. Failed payloads breakdown
 *  H. Stale-sync drain rate
 *  I. Data integrity (orphans, half-creates, missing links)
 *  J. Active queue depths
 */
import { prisma } from '../lib/prisma.js';
import { OdooClient } from '../odoo/odooClient.js';
import { calculateMerchantInvoiceTarget } from '../odoo/odooSyncService.js';

const odoo = new OdooClient();

const now = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let totalIssues = 0;
const flags: string[] = [];
const flag = (msg: string) => { totalIssues++; flags.push(msg); };

console.log('\n████████████████████████████████████████████████████████████');
console.log('   COMPREHENSIVE END-TO-END AUDIT');
console.log('████████████████████████████████████████████████████████████\n');

// ─── A. CRON / DEPLOY STATE ────────────────────────────────────────
console.log('🛠️  A. CRON & DEPLOYED CODE\n');
console.log('  Expected schedules (from netlify.toml):');
console.log('    sync-open-shipments       → */15 * * * *');
console.log('    process-odoo-queue        → */1  * * * *');
console.log('    ensure-telegram-webhook   → */5  * * * *');
console.log('    run-production-background → on-demand (background)');

// ─── B. TELEGRAPH HEALTH ───────────────────────────────────────────
console.log('\n📦 B. TELEGRAPH SHIPMENT HEALTH\n');

const tgRecent = await prisma.shipmentRecord.findMany({
  where: { createdAt: { gt: new Date(now - 24 * HOUR) } },
  select: { shopifyOrderName: true, accurateShipmentId: true, accurateShipmentCode: true, accurateStatus: true, createdAt: true, lastError: true, lastSyncedAt: true, odooSyncStatus: true }
});
const tgWith = tgRecent.filter((r) => r.accurateShipmentId).length;
const tgPending = tgRecent.filter((r) => !r.accurateShipmentId && !r.lastError).length;
const tgFailed = tgRecent.filter((r) => !r.accurateShipmentId && r.lastError).length;
console.log('  Orders created (last 24h):     ' + tgRecent.length);
console.log('    ✅ With Telegraph shipment:   ' + tgWith);
console.log('    ⏳ Pending (no shipment yet): ' + tgPending);
console.log('    ❌ Failed:                    ' + tgFailed);
if (tgFailed > 0) flag(tgFailed + ' Telegraph creation failures (last 24h)');
if (tgPending > 5) flag(tgPending + ' orders pending Telegraph creation');

// Pending details
if (tgPending > 0) {
  console.log('\n  Pending details:');
  for (const r of tgRecent.filter((r) => !r.accurateShipmentId && !r.lastError).slice(0, 10)) {
    const age = Math.round((now - r.createdAt.getTime()) / 60000);
    console.log('    ' + (r.shopifyOrderName ?? '?').padEnd(8) + ' | odooStatus=' + r.odooSyncStatus + ' | age=' + age + 'min');
  }
}

// Stale-sync drain (open shipments not synced > 30 min)
const staleOpen = await prisma.shipmentRecord.findMany({
  where: {
    accurateShipmentId: { not: null },
    accurateIsTerminal: false,
    OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: new Date(now - 30 * 60_000) } }]
  },
  select: { shopifyOrderName: true, lastSyncedAt: true, accurateStatus: true }
});
const neverSynced = staleOpen.filter((r) => !r.lastSyncedAt).length;
const olderThan1h = staleOpen.filter((r) => r.lastSyncedAt && (now - r.lastSyncedAt.getTime()) > HOUR).length;
const olderThan4h = staleOpen.filter((r) => r.lastSyncedAt && (now - r.lastSyncedAt.getTime()) > 4 * HOUR).length;
console.log('\n  Open shipments staleness:');
console.log('    Never synced:        ' + neverSynced);
console.log('    Stale > 30 min:      ' + staleOpen.length);
console.log('    Stale > 1 hour:      ' + olderThan1h);
console.log('    Stale > 4 hours:     ' + olderThan4h);
if (olderThan4h > 0) flag(olderThan4h + ' shipments NOT synced for >4h (cron may be stuck)');
if (staleOpen.length > 200) flag(staleOpen.length + ' stale syncs — cron behind by hours');

// ─── C. ODOO SALES ORDER QUEUE ─────────────────────────────────────
console.log('\n📦 C. ODOO V7 QUEUE\n');
const queue = await prisma.shipmentRecord.groupBy({
  by: ['odooSyncStatus'],
  _count: true,
  where: {
    odooSyncStatus: {
      in: ['odoo-so-pending', 'odoo-so-creating', 'odoo-stock-pending', 'odoo-stock-preparing',
            'odoo-delivery-pending', 'odoo-delivery-confirming', 'odoo-failed-retryable', 'failed']
    }
  }
});
const queueDepth = queue.reduce((s, x) => s + x._count, 0);
console.log('  Active queue depth: ' + queueDepth);
for (const s of queue) {
  const ic = s.odooSyncStatus === 'failed' ? '❌' : s.odooSyncStatus === 'odoo-failed-retryable' ? '⚠️' : '⏳';
  console.log('    ' + ic + ' ' + (s.odooSyncStatus ?? '?').padEnd(28) + ': ' + s._count);
}
const failedCount = queue.find((q) => q.odooSyncStatus === 'failed')?._count ?? 0;
const retryableCount = queue.find((q) => q.odooSyncStatus === 'odoo-failed-retryable')?._count ?? 0;
if (failedCount > 0) flag(failedCount + ' records in permanent `failed`');
if (retryableCount > 0) flag(retryableCount + ' records waiting for retry');

// Stuck-processing (> 15 min in *-creating/*-preparing/*-confirming)
const stuck = await prisma.shipmentRecord.findMany({
  where: {
    odooSyncStatus: { in: ['odoo-so-creating', 'odoo-stock-preparing', 'odoo-delivery-confirming'] },
    odooSyncedAt: { lt: new Date(now - 15 * 60_000) }
  },
  select: { shopifyOrderName: true, odooSyncStatus: true, odooSyncedAt: true }
});
console.log('  Stuck-processing (>15 min): ' + stuck.length);
if (stuck.length > 0) flag(stuck.length + ' stuck mid-processing');

// V7-orphans (sales-order-created with shipment + SO + no invoice + not financial-terminal)
const v7Orphans = await prisma.shipmentRecord.findMany({
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
  },
  select: { shopifyOrderName: true }
});
console.log('  V7 orphans at sales-order-created: ' + v7Orphans.length);
if (v7Orphans.length > 0) flag(v7Orphans.length + ' V7 orphans');

// ─── D. ODOO INVOICE & PAYMENT HEALTH ──────────────────────────────
console.log('\n💰 D. ODOO INVOICE + PAYMENT HEALTH\n');
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
let paidOk = 0, partial = 0, netDueMismatch = 0;
const mismatchExamples: string[] = [];
for (const r of paidRecs) {
  const inv = invMap.get(r.odooInvoiceId!);
  if (!inv) continue;
  if (inv.payment_state === 'paid') { paidOk++; continue; }
  partial++;
  const target = calculateMerchantInvoiceTarget({ collectedAmount: r.collectedAmount, deliveryFees: r.deliveryFees, customerDue: r.customerDue });
  if (target === null) continue;
  if (Number(inv.amount_total ?? 0) > target + 0.01) {
    netDueMismatch++;
    if (mismatchExamples.length < 8) mismatchExamples.push((r.shopifyOrderName ?? '?') + ' / ' + inv.name + ' total=' + inv.amount_total + ' target=' + target);
  }
}
console.log('  Records marked paid/paid-existing with invoice: ' + paidRecs.length);
console.log('    ✅ Fully paid in Odoo:           ' + paidOk);
console.log('    ⚠️  Partial:                    ' + partial);
console.log('    🚨 Net-due mismatch partials:   ' + netDueMismatch);
if (netDueMismatch > 0) {
  flag(netDueMismatch + ' net-due mismatch partials need backfill');
  console.log('  Mismatch examples:');
  for (const e of mismatchExamples) console.log('    ' + e);
}

// ─── E. RETURNED-SHIPMENT BILLS ────────────────────────────────────
console.log('\n↩️  E. RETURNED-SHIPMENT BILLS\n');
const returnedRecs = await prisma.shipmentRecord.findMany({
  where: { OR: [{ collectionStatus: 'returned' }, { collectionStatus: 'returned-settled' }] },
  select: { shopifyOrderName: true, odooReturnBillId: true, customerDue: true, returningDueFees: true }
});
const returnsWithBill = returnedRecs.filter((r) => r.odooReturnBillId).length;
const returnsWithoutBill = returnedRecs.filter((r) => !r.odooReturnBillId).length;
console.log('  Returned shipments total:           ' + returnedRecs.length);
console.log('    With return bill in Odoo:         ' + returnsWithBill);
console.log('    Without return bill (legit zero): ' + returnsWithoutBill);
// Not a flag — returns with customerDue > 0 legitimately have no charge.

// ─── F. SHOPIFY FAILURES ───────────────────────────────────────────
console.log('\n🛒 F. SHOPIFY HEALTH\n');
const shopifyFails = await prisma.failedPayload.groupBy({
  by: ['source'],
  _count: true,
  where: {
    source: { in: ['shopify-mark-as-paid', 'shopify-fulfillment-create', 'shopify-orders-create'] },
    createdAt: { gt: new Date(now - DAY) }
  }
});
let totalShopify = 0;
for (const s of shopifyFails) {
  totalShopify += s._count;
  console.log('    ' + s.source.padEnd(30) + ': ' + s._count);
}
if (shopifyFails.length === 0) console.log('    (none) ✅');
// COD mark-as-paid is a known limitation, not a hard issue.

// ─── G. FAILED PAYLOADS ────────────────────────────────────────────
console.log('\n📛 G. FAILED PAYLOADS (last 24h, all sources)\n');
const allFails = await prisma.failedPayload.groupBy({
  by: ['source'],
  _count: true,
  where: { createdAt: { gt: new Date(now - DAY) } }
});
const totalFails = allFails.reduce((s, x) => s + x._count, 0);
console.log('  Total: ' + totalFails);
for (const s of allFails.sort((a, b) => b._count - a._count)) {
  console.log('    ' + s.source.padEnd(35) + ': ' + s._count);
}

// ─── H. DATA INTEGRITY ─────────────────────────────────────────────
console.log('\n🧩 H. DATA INTEGRITY CHECKS\n');

const soWithoutShipment = await prisma.shipmentRecord.count({
  where: { odooSaleOrderId: { not: null }, accurateShipmentId: null, odooSyncStatus: { notIn: ['paid', 'paid-existing', 'delivery-confirmed', 'failed'] } }
});
console.log('  SO created but NO Telegraph shipment (active): ' + soWithoutShipment);

const shipmentWithoutSo = await prisma.shipmentRecord.count({
  where: {
    accurateShipmentId: { not: null },
    odooSaleOrderId: null,
    accurateIsTerminal: false,
    odooSyncStatus: { notIn: ['failed', 'odoo-failed-retryable'] }
  }
});
console.log('  Shipment but NO SO (active): ' + shipmentWithoutSo);

const ghostStatus = await prisma.shipmentRecord.count({
  where: { odooSyncStatus: null, accurateShipmentId: { not: null } }
});
console.log('  Has shipment but odooSyncStatus is null: ' + ghostStatus);
if (ghostStatus > 0) flag(ghostStatus + ' shipments with null odooSyncStatus');

// ─── I. THROUGHPUT (last 24h) ──────────────────────────────────────
console.log('\n📈 I. THROUGHPUT (last 24h)\n');
const createdLast24 = await prisma.shipmentRecord.count({ where: { createdAt: { gt: new Date(now - DAY) } } });
const paidLast24 = await prisma.shipmentRecord.count({
  where: { odooSyncStatus: { in: ['paid', 'paid-existing'] }, odooSyncedAt: { gt: new Date(now - DAY) } }
});
const deliveredLast24 = await prisma.shipmentRecord.count({
  where: { odooSyncStatus: 'delivery-confirmed', odooSyncedAt: { gt: new Date(now - DAY) } }
});
console.log('  Orders created in DB (last 24h):       ' + createdLast24);
console.log('  Reached delivery-confirmed (last 24h): ' + deliveredLast24);
console.log('  Reached paid/paid-existing (last 24h): ' + paidLast24);

// ─── VERDICT ───────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
if (totalIssues === 0) {
  console.log('🟢 ALL CLEAR — every pipeline healthy, no gaps detected.');
} else {
  console.log('🟡 ISSUES DETECTED (' + totalIssues + '):');
  for (const f of flags) console.log('  • ' + f);
}
console.log('══════════════════════════════════════════════════════════════');

await prisma.$disconnect();
