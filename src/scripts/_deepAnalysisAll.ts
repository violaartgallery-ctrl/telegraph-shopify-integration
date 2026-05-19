/**
 * READ-ONLY deep analysis of all current issues:
 *  1. Stuck orders at sales-order-created (V7 orphans, new wave)
 *  2. Failed orders (#2104 etc.)
 *  3. Partial invoices that should have been Paid (net-due fix not catching them)
 *  4. Why the wizard returns posted invoices (timing bug)
 *
 * No writes anywhere.
 */
import { writeFileSync } from 'node:fs';
import { prisma } from '../lib/prisma.js';
import { OdooClient } from '../odoo/odooClient.js';
import { calculateNetMerchantDue } from '../odoo/odooSyncService.js';

const odoo = new OdooClient();

interface InvoiceRow {
  [key: string]: unknown;
  id: number;
  name?: string;
  state?: string;
  payment_state?: string;
  amount_total?: number;
  amount_residual?: number;
  amount_tax?: number;
  invoice_line_ids?: number[];
  invoice_origin?: string;
}

interface SaleOrderRow {
  [key: string]: unknown;
  id: number;
  name?: string;
  state?: string;
  invoice_ids?: number[];
  picking_ids?: number[];
}

console.log('\n████████████████████████████████████████████████████████████');
console.log('   DEEP ANALYSIS — كل المشاكل الحالية');
console.log('████████████████████████████████████████████████████████████\n');

// ─── 1. Queue snapshot ─────────────────────────────────────────────
console.log('🔍 STEP 1: Snapshot of all current queue states\n');

const queueStates = await prisma.shipmentRecord.groupBy({
  by: ['odooSyncStatus'],
  _count: true,
  where: {
    odooSyncStatus: {
      in: [
        'odoo-so-pending', 'odoo-so-creating',
        'odoo-stock-pending', 'odoo-stock-preparing',
        'odoo-delivery-pending', 'odoo-delivery-confirming',
        'odoo-failed-retryable', 'failed',
        'sales-order-created', 'sales-order-existing',
        'delivery-confirmed', 'paid', 'paid-existing'
      ]
    }
  }
});

for (const s of queueStates.sort((a, b) => b._count - a._count)) {
  console.log('  ' + (s.odooSyncStatus ?? 'null').padEnd(28) + ': ' + s._count);
}

// ─── 2. Currently-stuck orders at sales-order-created (V7 orphans) ──
console.log('\n\n🔍 STEP 2: V7 orphans currently stuck at sales-order-created\n');

const stuckSales = await prisma.shipmentRecord.findMany({
  where: {
    odooSyncStatus: 'sales-order-created',
    accurateShipmentId: { not: null },
    accurateShipmentCode: { not: null },
    odooSaleOrderId: { not: null },
    odooInvoiceId: null,
    odooPaymentId: null,
    odooSalePaymentId: null,
    NOT: {
      OR: [
        { collectionStatus: 'collected' },
        { collectionStatus: 'returned' },
        { collectionStatus: 'returned-settled' },
        { collectionStatus: 'payment-review' }
      ]
    }
  },
  select: {
    id: true,
    shopifyOrderName: true,
    odooSaleOrderName: true,
    accurateShipmentCode: true,
    accurateStatus: true,
    collectionStatus: true,
    customerDue: true,
    createdAt: true,
    updatedAt: true
  },
  orderBy: { createdAt: 'desc' }
});

console.log('Total stuck candidates: ' + stuckSales.length);

const now = Date.now();
const recent24h = stuckSales.filter((s) => (now - s.createdAt.getTime()) < 86_400_000);
console.log('  Recent (< 24h): ' + recent24h.length);
console.log('  Older: ' + (stuckSales.length - recent24h.length));

console.log('\nRecent (< 24h) stuck:');
for (const r of recent24h.slice(0, 15)) {
  const age = ((now - r.createdAt.getTime()) / 3600_000).toFixed(1);
  console.log('  ' + (r.shopifyOrderName ?? '?').padEnd(8) + ' | ' + (r.accurateShipmentCode ?? '?').padEnd(12) + ' | ' + (r.odooSaleOrderName ?? '?').padEnd(11) + ' | accurate=' + (r.accurateStatus ?? '-').padEnd(8) + ' | age=' + age + 'h');
}

// ─── 3. Failed orders ──────────────────────────────────────────────
console.log('\n\n🔍 STEP 3: Failed orders\n');

const failedOrders = await prisma.shipmentRecord.findMany({
  where: { odooSyncStatus: 'failed' },
  select: {
    id: true,
    shopifyOrderName: true,
    accurateShipmentCode: true,
    odooSaleOrderId: true,
    odooLastError: true,
    odooAttemptCount: true,
    createdAt: true
  }
});

console.log('Total failed: ' + failedOrders.length);
for (const f of failedOrders) {
  console.log('  ' + (f.shopifyOrderName ?? '?').padEnd(8) + ' | Telegraph=' + (f.accurateShipmentCode ?? '?').padEnd(12) + ' | SO=' + (f.odooSaleOrderId ?? 'none') + ' | attempts=' + f.odooAttemptCount + ' | err=' + (f.odooLastError ?? '').slice(0, 80));
}

// ─── 4. Partial invoices (THE NEW BIG ONE) ──────────────────────────
console.log('\n\n🔍 STEP 4: Partial invoices — net-due fix gap analysis\n');

// Find every shipment record with paid/paid-existing status and invoice
const paidRecords = await prisma.shipmentRecord.findMany({
  where: {
    odooSyncStatus: { in: ['paid', 'paid-existing'] },
    odooInvoiceId: { not: null }
  },
  select: {
    shopifyOrderName: true,
    shopifyOrderId: true,
    odooInvoiceId: true,
    odooInvoiceName: true,
    collectedAmount: true,
    deliveryFees: true,
    customerDue: true,
    odooSyncedAt: true
  }
});

console.log('Records with paid/paid-existing + invoice: ' + paidRecords.length);

// Read invoices from Odoo
const invoiceIds = paidRecords.map((r) => r.odooInvoiceId!).filter(Boolean);
const invoices = invoiceIds.length === 0 ? [] : await odoo.searchRead<InvoiceRow>(
  'account.move',
  [['id', 'in', invoiceIds]],
  ['name', 'state', 'payment_state', 'amount_total', 'amount_residual', 'amount_tax', 'invoice_line_ids', 'invoice_origin'],
  { limit: invoiceIds.length }
);
const invById = new Map(invoices.map((i) => [i.id, i]));

interface PartialMismatch {
  orderName: string;
  invoiceName: string;
  invoiceId: number;
  invoiceTotal: number;
  netMerchantDue: number;
  residual: number;
  paymentState: string;
  lastSync?: string;
  hasTax: boolean;
}

const partials: PartialMismatch[] = [];
let paidOk = 0;
let noNetDue = 0;

for (const r of paidRecords) {
  const inv = invById.get(r.odooInvoiceId!);
  if (!inv) continue;

  const netDue = calculateNetMerchantDue({ collectedAmount: r.collectedAmount, deliveryFees: r.deliveryFees });
  if (netDue === null) { noNetDue++; continue; }

  const total = Number(inv.amount_total ?? 0);
  const residual = Number(inv.amount_residual ?? 0);

  if (inv.payment_state === 'paid') {
    paidOk++;
    continue;
  }

  if (inv.payment_state === 'partial' || (residual > 0.01 && total > netDue + 0.01)) {
    partials.push({
      orderName: r.shopifyOrderName ?? r.shopifyOrderId,
      invoiceName: inv.name ?? String(inv.id),
      invoiceId: inv.id,
      invoiceTotal: total,
      netMerchantDue: netDue,
      residual,
      paymentState: inv.payment_state ?? '?',
      lastSync: r.odooSyncedAt?.toISOString().slice(0, 16),
      hasTax: Number(inv.amount_tax ?? 0) > 0
    });
  }
}

console.log('Already paid OK:                 ' + paidOk);
console.log('Cannot compute net due (no data): ' + noNetDue);
console.log('🚨 PARTIAL (invoice > net due):  ' + partials.length);

if (partials.length > 0) {
  console.log('\nPartial invoice list (newest first):');
  for (const p of partials.sort((a, b) => (b.lastSync ?? '').localeCompare(a.lastSync ?? ''))) {
    console.log('  ' + p.orderName.padEnd(8) + ' | ' + p.invoiceName.padEnd(15) + ' | total=' + p.invoiceTotal.toFixed(2).padStart(8) + ' | netDue=' + p.netMerchantDue.toFixed(2).padStart(8) + ' | residual=' + p.residual.toFixed(2).padStart(7) + ' | tax=' + (p.hasTax ? 'Y' : 'N') + ' | synced=' + (p.lastSync ?? '?'));
  }
}

// ─── 5. Wizard timing investigation ─────────────────────────────────
console.log('\n\n🔍 STEP 5: createSaleInvoiceFromWizard — does it return draft or posted?\n');

if (partials.length > 0) {
  // For first partial, look at its current state in Odoo and reason why adjust didn't fire
  const sample = partials[0];
  console.log('Sample: ' + sample.orderName + ' (invoice ' + sample.invoiceName + ', id=' + sample.invoiceId + ')');
  console.log('  In Odoo: total=' + sample.invoiceTotal + ', residual=' + sample.residual + ', state=' + sample.paymentState);
  console.log('  Should have been: total=' + sample.netMerchantDue + ', residual=0, state=paid');
  console.log('');
  console.log('Root cause hypothesis:');
  console.log('  findOrCreatePostedSaleInvoice → createSaleInvoiceFromWizard');
  console.log('  → wizard.create_invoices returns res_id of an ALREADY POSTED invoice');
  console.log('  → "if (invoice.state === draft)" branch SKIPPED');
  console.log('  → adjustDraftInvoiceLinesToTotal NEVER CALLED');
  console.log('  → invoice total stays at gross product price');
  console.log('  → payment registered for net due → leaves residual = deliveryFees → partial');
}

// ─── 6. Write report ────────────────────────────────────────────────
const md: string[] = [];
md.push('# VIOLA — Deep Analysis Report');
md.push('');
md.push('Generated: ' + new Date().toISOString());
md.push('');
md.push('## Queue snapshot');
md.push('');
for (const s of queueStates.sort((a, b) => b._count - a._count)) {
  md.push('- `' + (s.odooSyncStatus ?? 'null') + '`: ' + s._count);
}
md.push('');
md.push('## Stuck at sales-order-created (V7 orphans)');
md.push('');
md.push('Total: ' + stuckSales.length + ' (' + recent24h.length + ' recent < 24h)');
md.push('');
md.push('Recent table:');
md.push('');
md.push('| Order | Telegraph | SO | Accurate | Collection | Age (h) |');
md.push('|---|---|---|---|---|---:|');
for (const r of recent24h) {
  const age = ((now - r.createdAt.getTime()) / 3600_000).toFixed(1);
  md.push('| ' + (r.shopifyOrderName ?? '?') + ' | ' + (r.accurateShipmentCode ?? '?') + ' | ' + (r.odooSaleOrderName ?? '?') + ' | ' + (r.accurateStatus ?? '-') + ' | ' + (r.collectionStatus ?? 'null') + ' | ' + age + ' |');
}
md.push('');
md.push('## Failed orders');
md.push('');
md.push('| Order | Telegraph | SO | Attempts | Error |');
md.push('|---|---|---|---:|---|');
for (const f of failedOrders) {
  md.push('| ' + (f.shopifyOrderName ?? '?') + ' | ' + (f.accurateShipmentCode ?? '?') + ' | ' + (f.odooSaleOrderId ?? '-') + ' | ' + f.odooAttemptCount + ' | ' + (f.odooLastError ?? '').replace(/\|/g, '/').slice(0, 100) + ' |');
}
md.push('');
md.push('## Partial invoices (net-due fix gap)');
md.push('');
md.push('Total partial: ' + partials.length);
md.push('');
md.push('| Order | Invoice | Total | Net Due | Residual | Tax | Last Sync |');
md.push('|---|---|---:|---:|---:|---|---|');
for (const p of partials.sort((a, b) => (b.lastSync ?? '').localeCompare(a.lastSync ?? ''))) {
  md.push('| ' + p.orderName + ' | ' + p.invoiceName + ' | ' + p.invoiceTotal.toFixed(2) + ' | ' + p.netMerchantDue.toFixed(2) + ' | ' + p.residual.toFixed(2) + ' | ' + (p.hasTax ? 'Y' : 'N') + ' | ' + (p.lastSync ?? '?') + ' |');
}
md.push('');
md.push('## Root cause: timing of invoice posting');
md.push('');
md.push('`findOrCreatePostedSaleInvoice` calls `createSaleInvoiceFromWizard`, which calls the Odoo wizard `sale.advance.payment.inv.create_invoices`. In Odoo 17 this wizard creates the invoice and *immediately posts it*. By the time `findOrCreatePostedSaleInvoice` reads the invoice back, `state` is `posted`, so the existing guard `if (invoice.state === "draft")` falls through and the line adjustment never runs. Payment registration then leaves a residual equal to `deliveryFees`, producing the Partially Paid state.');
md.push('');
md.push('## Proposed plan');
md.push('');
md.push('1. Code fix in `findOrCreatePostedSaleInvoice` / `createSaleInvoiceFromWizard`:');
md.push('   - After the wizard returns, if invoice is already posted and `targetInvoiceTotal` is provided, reset it to draft via `button_draft`, then `adjustDraftInvoiceLinesToTotal`, then `action_post`.');
md.push('   - If reset fails (linked payments, locked period, etc.), fall back to the current safe behaviour (warn + leave for manual review).');
md.push('2. DB recovery for the 8 stuck `sales-order-created` orders and #2104 `failed`.');
md.push('3. Backfill the partial invoices above using the same reset-to-draft → adjust → post path.');

writeFileSync('VIOLA_DEEP_ANALYSIS.md', md.join('\n'));
console.log('\n\n📄 Report saved: VIOLA_DEEP_ANALYSIS.md');

await prisma.$disconnect();
