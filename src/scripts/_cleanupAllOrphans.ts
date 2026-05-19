/**
 * Full cleanup:
 *   • Find every safe V7 orphan (sales-order-created with shipment + SO, no invoice/payment, not financial-terminal).
 *   • Find every `failed` record that has a Telegraph shipment + raw JSON and looks recoverable.
 *   • Apply DB recovery only. No Odoo writes.
 *
 * Safety: per-row updateMany with strict WHERE preconditions; verify post-state.
 */
import { prisma } from '../lib/prisma.js';

const HARD_EXCLUDE = new Set(['#1880', '#1920', '#1942']);
const TERMINAL_COLLECTION = new Set(['collected', 'returned', 'returned-settled', 'payment-review']);

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  Full Cleanup — orphans + recoverable failed');
console.log('══════════════════════════════════════════════════════════════\n');

// PHASE A — V7 orphans → odoo-stock-pending
const orphans = await prisma.shipmentRecord.findMany({
  where: {
    odooSyncStatus: 'sales-order-created',
    accurateShipmentId: { not: null },
    accurateShipmentCode: { not: null },
    odooSaleOrderId: { not: null },
    odooInvoiceId: null,
    odooPaymentId: null,
    odooSalePaymentId: null
  },
  select: { id: true, shopifyOrderName: true, collectionStatus: true, customerDue: true, accurateIsTerminal: true }
});

console.log('Phase A — V7 orphans candidates: ' + orphans.length);
let okOrphans = 0, skipOrphans = 0;
for (const r of orphans) {
  const name = r.shopifyOrderName ?? String(r.id);
  if (HARD_EXCLUDE.has(name)) { skipOrphans++; continue; }
  if (r.collectionStatus && TERMINAL_COLLECTION.has(r.collectionStatus)) { skipOrphans++; continue; }
  if (r.accurateIsTerminal === true) { skipOrphans++; continue; }
  if (r.customerDue !== null && Number(r.customerDue) < 0) { skipOrphans++; continue; }

  const upd = await prisma.shipmentRecord.updateMany({
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
  if (upd.count === 1) { okOrphans++; console.log('  ✅ ' + name + ' → odoo-stock-pending'); }
  else { skipOrphans++; }
}
console.log('  Recovered: ' + okOrphans + ' | Skipped: ' + skipOrphans);

// PHASE B — failed → odoo-so-pending (only those with Shopify JSON, no SO yet, not exhausted attempts).
const failed = await prisma.shipmentRecord.findMany({
  where: { odooSyncStatus: 'failed' },
  select: { id: true, shopifyOrderName: true, rawOrderJson: true, accurateShipmentId: true, odooSaleOrderId: true, odooInvoiceId: true, odooAttemptCount: true, odooLastError: true }
});
console.log('\nPhase B — failed candidates: ' + failed.length);
let okFailed = 0, skipFailed = 0;
for (const r of failed) {
  const name = r.shopifyOrderName ?? String(r.id);
  // Only requeue when there is a shipment, no invoice, no SO yet (SO failed mid-creation).
  if (!r.rawOrderJson) { skipFailed++; continue; }
  if (r.odooInvoiceId) { skipFailed++; continue; }
  if (!r.accurateShipmentId) { skipFailed++; continue; }
  if ((r.odooAttemptCount ?? 0) >= 5) { skipFailed++; continue; }

  const upd = await prisma.shipmentRecord.updateMany({
    where: {
      id: r.id,
      odooSyncStatus: 'failed',
      odooInvoiceId: null,
      accurateShipmentId: { not: null }
    },
    data: {
      odooSyncStatus: r.odooSaleOrderId ? 'odoo-stock-pending' : 'odoo-so-pending',
      odooLastError: null,
      odooAttemptCount: 0,
      odooRetryAt: null,
      odooSyncedAt: new Date()
    }
  });
  if (upd.count === 1) {
    const next = r.odooSaleOrderId ? 'odoo-stock-pending' : 'odoo-so-pending';
    okFailed++;
    console.log('  ✅ ' + name + ' → ' + next + ' (was failed: ' + (r.odooLastError ?? '').slice(0, 40) + ')');
  } else {
    skipFailed++;
  }
}
console.log('  Recovered: ' + okFailed + ' | Skipped: ' + skipFailed);

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  Total recovered: ' + (okOrphans + okFailed));
console.log('  Total skipped:   ' + (skipOrphans + skipFailed));
console.log('══════════════════════════════════════════════════════════════');

await prisma.$disconnect();
