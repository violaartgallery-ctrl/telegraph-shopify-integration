/**
 * Analyze invoice creation flow:
 * Orders that are shipped & delivered but NO invoice
 */
import { prisma } from '../lib/prisma.js';

console.log('\n══════════════════════════════════════════════════════════');
console.log('INVOICE FLOW ANALYSIS');
console.log('══════════════════════════════════════════════════════════\n');

// Get all records
const allRecords = await prisma.shipmentRecord.findMany({
  select: {
    id: true,
    shopifyOrderName: true,
    odooSyncStatus: true,
    odooInvoiceName: true,
    collectionStatus: true,
    collectedAmount: true,
    deliveredAt: true,
    updatedAt: true
  },
  orderBy: { updatedAt: 'desc' }
});

// Breakdown by status
const breakdown: Record<string, number> = {};
const deliveredNoInvoice: typeof allRecords = [];
const paidNoInvoice: typeof allRecords = [];

for (const r of allRecords) {
  const status = r.odooSyncStatus || 'null';
  breakdown[status] = (breakdown[status] || 0) + 1;

  // Identify problematic records
  if (r.odooSyncStatus === 'delivery-confirmed' && !r.odooInvoiceName) {
    deliveredNoInvoice.push(r);
  }
  if (r.collectionStatus === 'paid' && !r.odooInvoiceName) {
    paidNoInvoice.push(r);
  }
}

console.log('📊 OVERALL STATUS BREAKDOWN:');
for (const [status, count] of Object.entries(breakdown).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${status ?? 'null'}: ${count}`);
}

const totalRecords = allRecords.length;
const withInvoice = allRecords.filter(r => r.odooInvoiceName).length;
const withoutInvoice = totalRecords - withInvoice;

console.log(`\n📈 INVOICE COVERAGE:`);
console.log(`  Total orders: ${totalRecords}`);
console.log(`  With invoice: ${withInvoice} (${((withInvoice/totalRecords)*100).toFixed(1)}%)`);
console.log(`  WITHOUT invoice: ${withoutInvoice} (${((withoutInvoice/totalRecords)*100).toFixed(1)}%)`);

console.log(`\n⚠️  PROBLEM RECORDS:`);
console.log(`  - Delivered (delivery-confirmed) but NO invoice: ${deliveredNoInvoice.length}`);
console.log(`  - Paid but NO invoice: ${paidNoInvoice.length}`);

console.log('\n══ DELIVERED → BUT NO INVOICE (newest first) ══════════════════');
for (const r of deliveredNoInvoice.slice(0, 15)) {
  const collected = r.collectedAmount ? `$${r.collectedAmount}` : 'none';
  console.log(`  ${r.shopifyOrderName}: collected=${collected} | status=${r.collectionStatus} | invoice=${r.odooInvoiceName ?? 'NONE'} | updated=${r.updatedAt.toISOString().slice(0, 16)}`);
}

console.log('\n══ PAID → BUT NO INVOICE (newest first) ══════════════════');
for (const r of paidNoInvoice.slice(0, 15)) {
  console.log(`  ${r.shopifyOrderName}: amount=$${r.collectedAmount} | status=${r.odooSyncStatus} | invoice=${r.odooInvoiceName ?? 'NONE'} | updated=${r.updatedAt.toISOString().slice(0, 16)}`);
}

await prisma.$disconnect();
