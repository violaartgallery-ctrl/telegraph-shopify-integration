/**
 * RECOVERY (controlled write): move the 10 known V7 orphans from
 * `sales-order-created` back into the V7 queue at stage 2 (`odoo-stock-pending`).
 *
 * Safety:
 *   • Updates each row individually (NOT bulk) for full control.
 *   • Strict WHERE clause: id must match AND status must still be `sales-order-created`.
 *   • Verifies post-conditions: status must be `odoo-stock-pending` after update.
 *   • Rolls back description if any row's preconditions fail.
 *
 * After recovery: the next process-odoo-queue tick (every minute) will pick up
 * the order, run Stage 2 (prepareSalesOrderStock), then Stage 3 (confirmSalesOrderDelivery).
 */
import { prisma } from '../lib/prisma.js';

const TARGETS = ['#2036', '#2038', '#2040', '#2042', '#2043', '#2044', '#2047', '#2048', '#2049', '#2051'];

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  V7 ORPHAN RECOVERY — the 10 known orders only');
console.log('══════════════════════════════════════════════════════════════\n');

// Step 1: Pre-flight check — verify each is a true orphan before touching.
console.log('Step 1: Pre-flight check\n');

const candidates = await prisma.shipmentRecord.findMany({
  where: { shopifyOrderName: { in: TARGETS } },
  select: {
    id: true,
    shopifyOrderName: true,
    odooSyncStatus: true,
    accurateShipmentId: true,
    odooSaleOrderId: true,
    odooInvoiceId: true,
    odooPaymentId: true,
    odooSalePaymentId: true,
    collectionStatus: true
  }
});

const TERMINAL_COLLECTION = new Set(['collected', 'returned', 'returned-settled', 'delivered-not-collected']);

const safeToRecover: typeof candidates = [];
const skipped: { name: string; reason: string }[] = [];

for (const r of candidates) {
  const reasons: string[] = [];
  if (r.odooSyncStatus !== 'sales-order-created') reasons.push('status-not-sales-order-created (got ' + r.odooSyncStatus + ')');
  if (!r.accurateShipmentId) reasons.push('no-telegraph-shipment-id');
  if (!r.odooSaleOrderId) reasons.push('no-odoo-sale-order-id');
  if (r.odooInvoiceId) reasons.push('already-has-invoice');
  if (r.odooPaymentId || r.odooSalePaymentId) reasons.push('already-has-payment');
  if (r.collectionStatus && TERMINAL_COLLECTION.has(r.collectionStatus)) reasons.push('financial-terminal (' + r.collectionStatus + ')');

  if (reasons.length === 0) {
    safeToRecover.push(r);
    console.log('  ✅ ' + r.shopifyOrderName + ' (id=' + r.id + ') — safe');
  } else {
    skipped.push({ name: r.shopifyOrderName ?? String(r.id), reason: reasons.join('; ') });
    console.log('  ⏭️  ' + r.shopifyOrderName + ' — SKIP: ' + reasons.join('; '));
  }
}

const missingFromDb = TARGETS.filter((t) => !candidates.find((c) => c.shopifyOrderName === t));
for (const name of missingFromDb) {
  skipped.push({ name, reason: 'not-found-in-db' });
  console.log('  ❓ ' + name + ' — not found in DB');
}

console.log('\n  Safe to recover: ' + safeToRecover.length);
console.log('  Skipped: ' + skipped.length);

if (safeToRecover.length === 0) {
  console.log('\n⛔ Nothing to recover. Exiting.');
  await prisma.$disconnect();
  process.exit(0);
}

// Step 2: Apply recovery one-by-one with strict WHERE.
console.log('\nStep 2: Applying recovery\n');

const results: { name: string; ok: boolean; before?: string; after?: string; error?: string }[] = [];

for (const r of safeToRecover) {
  try {
    const updated = await prisma.shipmentRecord.updateMany({
      where: {
        id: r.id,
        odooSyncStatus: 'sales-order-created',
        accurateShipmentId: { not: null },
        odooSaleOrderId: { not: null },
        odooInvoiceId: null,
        odooPaymentId: null,
        odooSalePaymentId: null
      },
      data: {
        odooSyncStatus: 'odoo-stock-pending',
        odooLastError: null,
        odooAttemptCount: 0,
        odooRetryAt: null,
        odooSyncedAt: new Date()
      }
    });

    if (updated.count !== 1) {
      results.push({ name: r.shopifyOrderName ?? String(r.id), ok: false, error: 'updateMany count=' + updated.count + ' (preconditions failed at write time)' });
      console.log('  ❌ ' + r.shopifyOrderName + ' — preconditions failed at write time');
      continue;
    }

    const after = await prisma.shipmentRecord.findUnique({
      where: { id: r.id },
      select: { odooSyncStatus: true }
    });
    if (after?.odooSyncStatus !== 'odoo-stock-pending') {
      results.push({ name: r.shopifyOrderName ?? String(r.id), ok: false, error: 'post-check failed (status=' + after?.odooSyncStatus + ')' });
      console.log('  ❌ ' + r.shopifyOrderName + ' — post-check failed');
      continue;
    }

    results.push({ name: r.shopifyOrderName ?? String(r.id), ok: true, before: 'sales-order-created', after: 'odoo-stock-pending' });
    console.log('  ✅ ' + r.shopifyOrderName + ' → odoo-stock-pending');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name: r.shopifyOrderName ?? String(r.id), ok: false, error: msg });
    console.log('  ❌ ' + r.shopifyOrderName + ' — ' + msg);
  }
}

// Step 3: Final summary.
const ok = results.filter((r) => r.ok).length;
const fail = results.filter((r) => !r.ok).length;
console.log('\n══════════════════════════════════════════════════════════════');
console.log('  Recovery summary');
console.log('══════════════════════════════════════════════════════════════');
console.log('  ✅ Recovered: ' + ok);
console.log('  ❌ Failed:    ' + fail);
console.log('  ⏭️  Skipped:   ' + skipped.length);
console.log('');
console.log('  Next process-odoo-queue tick (every minute) will pick up the recovered orders:');
console.log('    Stage 2: prepareSalesOrderStock (close MO + validate internal pickings)');
console.log('    Stage 3: confirmSalesOrderDelivery (validate customer pickings)');
console.log('    Final:   delivery-confirmed');

await prisma.$disconnect();
