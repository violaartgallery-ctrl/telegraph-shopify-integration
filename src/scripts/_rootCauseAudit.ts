/**
 * READ-ONLY root-cause audit:
 *  - count remaining sales-order-created orphans (now)
 *  - count failed records
 *  - identify all current paths that still call ensureSalesOrder without skipDbStatusUpdate
 *  - check for partial invoices still in the wild
 */
import { prisma } from '../lib/prisma.js';
import { OdooClient } from '../odoo/odooClient.js';
import { calculateNetMerchantDue } from '../odoo/odooSyncService.js';

const odoo = new OdooClient();

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  ROOT CAUSE AUDIT');
console.log('══════════════════════════════════════════════════════════════\n');

// 1. Orphans at sales-order-created with no invoice/payment + has shipment.
const orphans = await prisma.shipmentRecord.count({
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
console.log('1. V7-orphans currently stuck at sales-order-created: ' + orphans);

// 2. Failed records.
const failed = await prisma.shipmentRecord.findMany({
  where: { odooSyncStatus: 'failed' },
  select: { shopifyOrderName: true, odooLastError: true, odooAttemptCount: true }
});
console.log('\n2. Records in `failed` status: ' + failed.length);
for (const f of failed) {
  console.log('   ' + (f.shopifyOrderName ?? '?').padEnd(8) + ' | attempts=' + f.odooAttemptCount + ' | err=' + (f.odooLastError ?? '').slice(0, 80));
}

// 3. Failed-retryable records.
const retryable = await prisma.shipmentRecord.count({ where: { odooSyncStatus: 'odoo-failed-retryable' } });
console.log('\n3. Records in `odoo-failed-retryable`: ' + retryable);

// 4. Partial invoices still in the wild.
const paidRecs = await prisma.shipmentRecord.findMany({
  where: { odooSyncStatus: { in: ['paid', 'paid-existing'] }, odooInvoiceId: { not: null } },
  select: { shopifyOrderName: true, odooInvoiceId: true, collectedAmount: true, deliveryFees: true }
});
const invIds = paidRecs.map((r) => r.odooInvoiceId!).filter(Boolean);
const invs = invIds.length === 0 ? [] : await odoo.searchRead<{ id: number; name?: string; payment_state?: string; amount_total?: number; amount_residual?: number }>(
  'account.move',
  [['id', 'in', invIds]],
  ['name', 'payment_state', 'amount_total', 'amount_residual'],
  { limit: invIds.length }
);
const byId = new Map(invs.map((i) => [i.id, i]));
const partials: string[] = [];
for (const r of paidRecs) {
  const inv = byId.get(r.odooInvoiceId!);
  if (!inv) continue;
  if (inv.payment_state === 'paid') continue;
  const netDue = calculateNetMerchantDue({ collectedAmount: r.collectedAmount, deliveryFees: r.deliveryFees });
  if (netDue === null) continue;
  const total = Number(inv.amount_total ?? 0);
  if (total > netDue + 0.01) partials.push((r.shopifyOrderName ?? '?') + ' / ' + inv.name + ' (' + total + ' vs ' + netDue + ')');
}
console.log('\n4. Partial invoices remaining: ' + partials.length);
for (const p of partials) console.log('   ' + p);

// 5. Records with rawOrderJson set but no Telegraph shipment (potential half-creates from timeouts).
const halfCreated = await prisma.shipmentRecord.count({
  where: {
    rawOrderJson: { not: null },
    accurateShipmentId: null,
    odooSyncStatus: { notIn: ['failed', 'odoo-failed-retryable'] }
  }
});
console.log('\n5. Records with Shopify JSON but NO Telegraph shipment (queued / never started): ' + halfCreated);

await prisma.$disconnect();
