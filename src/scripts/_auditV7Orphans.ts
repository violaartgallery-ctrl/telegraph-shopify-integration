/**
 * READ-ONLY audit: count V7-orphans stuck at `sales-order-created`.
 *
 * V7-orphan = V7 queue interrupted between ensureSalesOrder (which sets status
 *             to 'sales-order-created' as a side effect) and markOdooStageSuccess.
 *
 * Heuristic to distinguish from legitimate V6 records:
 *   • odooSyncStatus = 'sales-order-created'
 *   • accurateShipmentId IS NOT NULL
 *   • odooInvoiceId IS NULL  (V6 legitimate ones already have invoices)
 *   • odooPaymentId IS NULL  (V6 paid ones have payment)
 *   • odooSalePaymentId IS NULL
 *   • collectionStatus is NOT 'collected' / 'returned' / 'returned-settled'
 *     (those go through the sync-open-shipments flow)
 *
 * Output:
 *   - total `sales-order-created` records
 *   - count of probable V7-orphans
 *   - count of V6-legitimate records
 *   - the 10 known orders for reference
 *   - any other orphans found
 */
import { prisma } from '../lib/prisma.js';

console.log('\n████████████████████████████████████████████████████████████');
console.log('   V7 ORPHANS AUDIT — read-only');
console.log('████████████████████████████████████████████████████████████\n');

const known10 = ['#2036', '#2038', '#2040', '#2042', '#2043', '#2044', '#2047', '#2048', '#2049', '#2051'];

const allSalesOrderCreated = await prisma.shipmentRecord.findMany({
  where: { odooSyncStatus: 'sales-order-created' },
  select: {
    id: true,
    shopifyOrderId: true,
    shopifyOrderName: true,
    accurateShipmentId: true,
    accurateShipmentCode: true,
    accurateStatus: true,
    collectionStatus: true,
    odooSaleOrderId: true,
    odooSaleOrderName: true,
    odooInvoiceId: true,
    odooInvoiceName: true,
    odooPaymentId: true,
    odooSalePaymentId: true,
    odooLastError: true,
    createdAt: true,
    updatedAt: true,
    collectedAmount: true,
    deliveryFees: true
  }
});

console.log('Total records with status=sales-order-created: ' + allSalesOrderCreated.length + '\n');

const TERMINAL_COLLECTION = new Set(['collected', 'returned', 'returned-settled', 'delivered-not-collected']);

const orphans: typeof allSalesOrderCreated = [];
const v6Legitimate: typeof allSalesOrderCreated = [];
const other: typeof allSalesOrderCreated = [];

for (const r of allSalesOrderCreated) {
  const hasInvoice = !!r.odooInvoiceId;
  const hasPayment = !!(r.odooPaymentId || r.odooSalePaymentId);
  const isFinancialDone = r.collectionStatus && TERMINAL_COLLECTION.has(r.collectionStatus);

  if (!hasInvoice && !hasPayment && !isFinancialDone && r.accurateShipmentId) {
    orphans.push(r);
  } else if (hasInvoice || hasPayment || isFinancialDone) {
    v6Legitimate.push(r);
  } else {
    other.push(r);
  }
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Classification:');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  ❌ V7 ORPHANS (need recovery):              ' + orphans.length);
console.log('  ✅ V6 legitimate (have invoice/payment/coll): ' + v6Legitimate.length);
console.log('  ⚠️  Other (no shipment / unclear):           ' + other.length);

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('V7 Orphans by age:');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
const now = Date.now();
const byAge: Record<string, number> = { '<1h': 0, '1-6h': 0, '6-24h': 0, '1-3 days': 0, '3-7 days': 0, '>7 days': 0 };
for (const o of orphans) {
  const hours = (now - o.createdAt.getTime()) / 3600_000;
  if (hours < 1) byAge['<1h']++;
  else if (hours < 6) byAge['1-6h']++;
  else if (hours < 24) byAge['6-24h']++;
  else if (hours < 72) byAge['1-3 days']++;
  else if (hours < 168) byAge['3-7 days']++;
  else byAge['>7 days']++;
}
for (const [bucket, count] of Object.entries(byAge)) {
  if (count > 0) console.log('  ' + bucket.padEnd(12) + ': ' + count);
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Known 10 orders status in audit:');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
for (const name of known10) {
  const isOrphan = orphans.find((o) => o.shopifyOrderName === name);
  const isLegit = v6Legitimate.find((o) => o.shopifyOrderName === name);
  const isOther = other.find((o) => o.shopifyOrderName === name);
  const label = isOrphan ? '❌ ORPHAN' : isLegit ? '✅ V6-legit' : isOther ? '⚠️  other' : '? not in list';
  console.log('  ' + name.padEnd(7) + ' ' + label);
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Full V7 Orphan list (' + orphans.length + ' rows):');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Order      | Telegraph    | SO          | Accurate          | Collection       | Age');
for (const o of orphans.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
  const ageHours = ((now - o.createdAt.getTime()) / 3600_000).toFixed(1);
  console.log((o.shopifyOrderName ?? '?').padEnd(10) + ' | ' +
              (o.accurateShipmentCode ?? '?').padEnd(12) + ' | ' +
              (o.odooSaleOrderName ?? '?').padEnd(11) + ' | ' +
              (o.accurateStatus ?? 'null').padEnd(17) + ' | ' +
              (o.collectionStatus ?? 'null').padEnd(16) + ' | ' +
              ageHours + 'h');
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Summary:');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Total orphans to recover: ' + orphans.length);
console.log('  Recovery action: UPDATE odooSyncStatus FROM sales-order-created TO odoo-stock-pending');
console.log('  Recovery condition: each row must have accurateShipmentId + odooSaleOrderId + no invoice + no payment + not financial-terminal');
console.log('');
console.log('  ⚠️  NO writes performed. Review the list above before approving recovery.');

await prisma.$disconnect();
