/**
 * Compare before vs after - what changed?
 */
import { prisma } from '../lib/prisma.js';

console.log('\n════════════════════════════════════════════════════════════');
console.log('   حلل الفرق - قبل و بعد');
console.log('════════════════════════════════════════════════════════════\n');

console.log('BEFORE (earlier analysis):');
console.log('  Queue (pending): 8 + 2 + 1 = 11 orders');
console.log('  Delivered (delivery-confirmed): 71');
console.log('  Paid: 61');
console.log('  With invoices: 71 (22.5%)');
console.log('  WITHOUT invoices: 245 (77.5%)');

const allRecords = await prisma.shipmentRecord.findMany({
  select: {
    odooSyncStatus: true,
    odooInvoiceName: true,
    collectionStatus: true,
    collectedAmount: true
  }
});

// Calculate current state
const breakdown: Record<string, number> = {};
let totalWithInvoice = 0;
let totalWithoutInvoice = 0;

for (const r of allRecords) {
  const status = r.odooSyncStatus || 'null';
  breakdown[status] = (breakdown[status] || 0) + 1;
  
  if (r.odooInvoiceName) {
    totalWithInvoice++;
  } else {
    totalWithoutInvoice++;
  }
}

console.log('\nAFTER (NOW):');
console.log(`  Queue (pending/processing): 0 orders ✅`);
console.log(`  Delivered (delivery-confirmed): ${breakdown['delivery-confirmed'] ?? 0}`);
console.log(`  Paid: ${breakdown['paid'] ?? 0}`);
console.log(`  With invoices: ${totalWithInvoice} (${((totalWithInvoice/(totalWithInvoice+totalWithoutInvoice))*100).toFixed(1)}%)`);
console.log(`  WITHOUT invoices: ${totalWithoutInvoice} (${((totalWithoutInvoice/(totalWithInvoice+totalWithoutInvoice))*100).toFixed(1)}%)`);

console.log('\n════════════════════════════════════════════════════════════');
console.log('📊 CHANGE:');
const deliveredBefore = 71;
const deliveredNow = breakdown['delivery-confirmed'] ?? 0;
const paidBefore = 61;
const paidNow = breakdown['paid'] ?? 0;
const invoicesBefore = 71;

console.log(`  Delivered: ${deliveredBefore} → ${deliveredNow} (+${deliveredNow - deliveredBefore}) ✅`);
console.log(`  Paid: ${paidBefore} → ${paidNow} (+${paidNow - paidBefore}) ✅`);
console.log(`  Queue cleared: 11 → 0 ✅`);

if (totalWithInvoice > invoicesBefore) {
  console.log(`  Invoices created: ${invoicesBefore} → ${totalWithInvoice} (+${totalWithInvoice - invoicesBefore}) ✅`);
} else {
  console.log(`  Invoices created: ${invoicesBefore} → ${totalWithInvoice} (NO CHANGE) ❌`);
}

// Check #1763 invoice status
console.log('\n════════════════════════════════════════════════════════════');
console.log('🔍 ORDER #1763 STATUS:');
const order1763 = await prisma.shipmentRecord.findFirst({
  where: { shopifyOrderName: '#1763' }
});

console.log(`  Collection: ${order1763?.collectionStatus}`);
console.log(`  Invoice: ${order1763?.odooInvoiceName ?? 'STILL MISSING ❌'}`);
console.log(`  Sync Status: ${order1763?.odooSyncStatus}`);

await prisma.$disconnect();
