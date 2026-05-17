/**
 * READ-ONLY: Inspect financial status of all collected/returned/paid orders
 * in DB — verify that invoices and payments actually got registered in Odoo.
 * Focus: Thursday & Friday orders (recent).
 */
import { prisma } from '../lib/prisma.js';
import { OdooClient } from '../odoo/odooClient.js';

const odooClient = new OdooClient();

// ── 1. Pull all financially-interesting records from DB ──────────────────────
const records = await prisma.shipmentRecord.findMany({
  where: {
    OR: [
      { odooSyncStatus: 'paid' },
      { odooSyncStatus: 'paid-existing' },
      { odooSyncStatus: 'invoice-posted' },
      { odooSyncStatus: 'invoice-posted-awaiting-payment' },
      { odooSyncStatus: 'returned-charge-paid' },
      { odooSyncStatus: 'returned-charge-paid-test-90' },
      { odooSyncStatus: 'delivery-confirmed' },
      { collectionStatus: 'collected' },
      { collectionStatus: 'returned' },
      { collectionStatus: 'returned-settled' },
    ]
  },
  orderBy: { updatedAt: 'desc' },
  take: 60
});

console.log(`\n╔══════════════════════════════════════════════════════════════════╗`);
console.log(`║  FINANCIAL STATUS INSPECTION — ${new Date().toISOString().slice(0,10)}           ║`);
console.log(`╚══════════════════════════════════════════════════════════════════╝`);
console.log(`  Total records fetched: ${records.length}\n`);

// ── 2. Categorize ─────────────────────────────────────────────────────────────
const categories = {
  fullyPaid:        records.filter(r => r.odooSyncStatus === 'paid' || r.odooSyncStatus === 'paid-existing'),
  invoiceOnly:      records.filter(r => r.odooSyncStatus === 'invoice-posted' || r.odooSyncStatus === 'invoice-posted-awaiting-payment'),
  returnedCharge:   records.filter(r => r.odooSyncStatus?.startsWith('returned-charge-paid')),
  deliveryConfirmed:records.filter(r => r.odooSyncStatus === 'delivery-confirmed' && r.collectionStatus === 'collected'),
  collectedNoOdoo:  records.filter(r => r.collectionStatus === 'collected' && !r.odooSyncStatus?.includes('paid') && !r.odooSyncStatus?.includes('invoice') && r.odooSyncStatus !== 'delivery-confirmed'),
};

console.log(`  ✅ paid / paid-existing        : ${categories.fullyPaid.length}`);
console.log(`  ⚠️  invoice-posted (no payment) : ${categories.invoiceOnly.length}`);
console.log(`  🔄 returned-charge-paid        : ${categories.returnedCharge.length}`);
console.log(`  ⚠️  delivery-confirmed+collected: ${categories.deliveryConfirmed.length}  ← collected but odoo=delivery-confirmed (no invoice yet?)`);
console.log(`  ❓ collected, no invoice status : ${categories.collectedNoOdoo.length}`);

// ── 3. Deep-dive: delivery-confirmed but collectionStatus=collected ───────────
if (categories.deliveryConfirmed.length > 0) {
  console.log(`\n${'─'.repeat(68)}`);
  console.log(`  ⚠️  CONCERN: delivery-confirmed + collected (should be 'paid' or 'invoice-posted')`);
  console.log(`${'─'.repeat(68)}`);
  for (const r of categories.deliveryConfirmed) {
    console.log(`\n  ${r.shopifyOrderName ?? r.shopifyOrderNumber}`);
    console.log(`    odooSyncStatus    : ${r.odooSyncStatus}  ← should advance after collection`);
    console.log(`    collectionStatus  : ${r.collectionStatus}`);
    console.log(`    collectedAmount   : ${r.collectedAmount}`);
    console.log(`    deliveryFees      : ${r.deliveryFees}`);
    console.log(`    customerDue       : ${r.customerDue}`);
    console.log(`    odooSaleOrderName : ${r.odooSaleOrderName}`);
    console.log(`    odooInvoiceName   : ${r.odooInvoiceName ?? '❌ NONE'}`);
    console.log(`    odooPaymentId     : ${r.odooPaymentId ?? '❌ NONE'}`);
    console.log(`    updatedAt         : ${r.updatedAt.toISOString()}`);
  }
}

// ── 4. Invoice-posted but no payment ─────────────────────────────────────────
if (categories.invoiceOnly.length > 0) {
  console.log(`\n${'─'.repeat(68)}`);
  console.log(`  ⚠️  invoice-posted WITHOUT payment registered`);
  console.log(`${'─'.repeat(68)}`);
  for (const r of categories.invoiceOnly) {
    console.log(`\n  ${r.shopifyOrderName ?? r.shopifyOrderNumber}`);
    console.log(`    odooSyncStatus  : ${r.odooSyncStatus}`);
    console.log(`    odooInvoiceName : ${r.odooInvoiceName}`);
    console.log(`    odooPaymentId   : ${r.odooPaymentId ?? '❌ NONE'}`);
    console.log(`    collectedAmount : ${r.collectedAmount}`);
    console.log(`    deliveryFees    : ${r.deliveryFees}`);
    console.log(`    customerDue     : ${r.customerDue}`);
    console.log(`    updatedAt       : ${r.updatedAt.toISOString()}`);
  }
}

// ── 5. Fully paid — verify in Odoo ───────────────────────────────────────────
const recentPaid = categories.fullyPaid.slice(0, 15);
console.log(`\n${'─'.repeat(68)}`);
console.log(`  ✅ PAID orders — Odoo verification (last ${recentPaid.length})`);
console.log(`${'─'.repeat(68)}`);

for (const r of recentPaid) {
  process.stdout.write(`\n  ${r.shopifyOrderName ?? r.shopifyOrderNumber}`);

  // Check invoice in Odoo
  let invoiceOk = false;
  let paymentOk = false;
  let invoiceState = '?';
  let invoicePaymentState = '?';
  let invoiceTotal = '?';
  let invoiceResidual = '?';

  if (r.odooInvoiceId) {
    try {
      const [inv] = await odooClient.searchRead<{
        id: number; name?: string; state?: string;
        payment_state?: string; amount_total?: number; amount_residual?: number;
      }>(
        'account.move',
        [['id', '=', r.odooInvoiceId]],
        ['name', 'state', 'payment_state', 'amount_total', 'amount_residual'],
        { limit: 1 }
      );
      if (inv) {
        invoiceOk = inv.state === 'posted';
        invoiceState = inv.state ?? '?';
        invoicePaymentState = inv.payment_state ?? '?';
        invoiceTotal = String(inv.amount_total ?? '?');
        invoiceResidual = String(inv.amount_residual ?? '?');
        paymentOk = inv.payment_state === 'paid' || inv.payment_state === 'in_payment';
      }
    } catch { invoiceState = 'ERR'; }
  }

  const invoiceIcon = invoiceOk ? '✅' : (r.odooInvoiceId ? '❌' : '⬜');
  const paymentIcon = paymentOk ? '✅' : (r.odooPaymentId ? '❌' : '⬜');

  console.log(``);
  console.log(`    DB odooSyncStatus : ${r.odooSyncStatus}`);
  console.log(`    DB invoice        : ${r.odooInvoiceName ?? '(none)'}  id=${r.odooInvoiceId ?? 'none'}`);
  console.log(`    DB payment id     : ${r.odooPaymentId ?? '(none)'}`);
  console.log(`    Odoo invoice state: ${invoiceIcon} ${invoiceState} | payment_state=${invoicePaymentState} | total=${invoiceTotal} | residual=${invoiceResidual}`);
  console.log(`    collectedAmount   : ${r.collectedAmount}  deliveryFees=${r.deliveryFees}  customerDue=${r.customerDue}`);
  console.log(`    updatedAt         : ${r.updatedAt.toISOString()}`);
}

// ── 6. Summary verdict ────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(68)}`);
console.log(`  SUMMARY`);
console.log(`${'═'.repeat(68)}`);
const broken = [
  ...categories.deliveryConfirmed,
  ...categories.invoiceOnly,
  ...categories.collectedNoOdoo,
].length;
if (broken === 0) {
  console.log(`  ✅ No anomalies detected — all collected orders have invoice/payment`);
} else {
  console.log(`  ❌ ${broken} record(s) need attention — see details above`);
}
console.log(``);

await prisma.$disconnect();
