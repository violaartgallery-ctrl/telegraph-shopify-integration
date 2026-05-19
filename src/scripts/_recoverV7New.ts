/**
 * RECOVERY:
 *  - 8 V7 orphans stuck at sales-order-created → odoo-stock-pending
 *  - #2104 failed (fetch failed, no SO) → odoo-so-pending
 *
 * Strict per-row WHERE preconditions. No Odoo/Shopify/Telegraph writes.
 */
import { prisma } from '../lib/prisma.js';

const STUCK = ['#2080', '#2083', '#2086', '#2087', '#2088', '#2091', '#2097', '#2098'];
const FAILED_REQUEUE = '#2104';

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  RECOVERY — 8 stuck + 1 failed');
console.log('══════════════════════════════════════════════════════════════\n');

console.log('Part 1: 8 V7 orphans → odoo-stock-pending\n');

for (const name of STUCK) {
  try {
    const upd = await prisma.shipmentRecord.updateMany({
      where: {
        shopifyOrderName: name,
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
    if (upd.count === 1) {
      console.log('  ✅ ' + name + ' → odoo-stock-pending');
    } else {
      console.log('  ❌ ' + name + ' — preconditions not met (updated=' + upd.count + ')');
    }
  } catch (e) {
    console.log('  ❌ ' + name + ' — ' + (e instanceof Error ? e.message : String(e)));
  }
}

console.log('\nPart 2: ' + FAILED_REQUEUE + ' (failed, fetch-failed) → odoo-so-pending\n');

try {
  const upd = await prisma.shipmentRecord.updateMany({
    where: {
      shopifyOrderName: FAILED_REQUEUE,
      odooSyncStatus: 'failed',
      odooSaleOrderId: null,
      odooInvoiceId: null,
      accurateShipmentId: { not: null }
    },
    data: {
      odooSyncStatus: 'odoo-so-pending',
      odooLastError: null,
      odooAttemptCount: 0,
      odooRetryAt: null,
      odooSyncedAt: new Date()
    }
  });
  if (upd.count === 1) {
    console.log('  ✅ ' + FAILED_REQUEUE + ' → odoo-so-pending');
  } else {
    console.log('  ❌ ' + FAILED_REQUEUE + ' — preconditions not met (updated=' + upd.count + ')');
  }
} catch (e) {
  console.log('  ❌ ' + FAILED_REQUEUE + ' — ' + (e instanceof Error ? e.message : String(e)));
}

console.log('\nDone.');
await prisma.$disconnect();
