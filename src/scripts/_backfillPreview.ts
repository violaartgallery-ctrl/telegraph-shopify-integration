/**
 * READ-ONLY: Phase 1 preview for partial-invoice backfill.
 * No writes. No deploys. Generates VIOLA_NET_DUE_INVOICE_BACKFILL_PREVIEW.md.
 */
import { writeFileSync } from 'node:fs';
import { prisma } from '../lib/prisma.js';
import { OdooClient } from '../odoo/odooClient.js';
import { calculateNetMerchantDue } from '../odoo/odooSyncService.js';

const TOLERANCE = 0.02;
const odoo = new OdooClient();

interface InvoiceRow {
  id: number;
  name?: string;
  state?: string;
  payment_state?: string;
  amount_total?: number;
  amount_residual?: number;
  amount_tax?: number;
  invoice_line_ids?: number[];
  reversal_move_id?: [number, string] | false;
  reversed_entry_id?: [number, string] | false;
}

interface LineRow {
  id: number;
  display_type?: string | false;
  price_unit?: number;
  quantity?: number;
  price_subtotal?: number;
  price_total?: number;
  tax_ids?: number[];
  move_id?: [number, string];
}

interface ReversalRow { id: number; reversed_entry_id?: [number, string] | false; }

interface Candidate {
  shopifyOrderName: string;
  shopifyOrderId: string;
  invoiceId: number;
  invoiceName: string;
  invoiceTotal: number;
  invoiceTax: number;
  amountResidual: number;
  paymentState: string;
  collectedAmount: number;
  deliveryFees: number;
  netMerchantDue: number;
  lineCount: number;
  hasTaxes: boolean;
  hasCreditNote: boolean;
  classification: 'SAFE_AUTO_FIX' | 'NEEDS_MANUAL_REVIEW';
  reasons: string[];
  proposedAction: string;
}

async function main(): Promise<void> {
  const dbRecords = await prisma.shipmentRecord.findMany({
    where: {
      collectionStatus: 'collected',
      odooInvoiceId: { not: null },
      odooSyncStatus: 'paid',
      OR: [
        { odooSalePaymentId: { not: null } },
        { odooPaymentId: { not: null } }
      ]
    },
    select: {
      shopifyOrderId: true,
      shopifyOrderName: true,
      collectedAmount: true,
      deliveryFees: true,
      odooInvoiceId: true,
      odooInvoiceName: true,
      odooSalePaymentId: true,
      odooPaymentId: true,
      odooSaleOrderName: true
    }
  });

  console.log(`DB candidates (collected + invoice + payment + status=paid): ${dbRecords.length}`);

  const invoiceIds = dbRecords.map((r) => r.odooInvoiceId!).filter(Boolean);
  const invoices = invoiceIds.length === 0 ? [] : await odoo.searchRead<InvoiceRow>(
    'account.move',
    [['id', 'in', invoiceIds]],
    ['name', 'state', 'payment_state', 'amount_total', 'amount_tax', 'amount_residual', 'invoice_line_ids', 'reversal_move_id', 'reversed_entry_id'],
    { limit: invoiceIds.length }
  );
  const invoicesById = new Map(invoices.map((i) => [i.id, i]));

  const allInvoiceLineIds = invoices.flatMap((i) => i.invoice_line_ids ?? []);
  const allLines = allInvoiceLineIds.length === 0 ? [] : await odoo.searchRead<LineRow>(
    'account.move.line',
    [['id', 'in', allInvoiceLineIds]],
    ['display_type', 'price_unit', 'quantity', 'price_subtotal', 'price_total', 'tax_ids', 'move_id'],
    { limit: allInvoiceLineIds.length }
  );
  const linesByInvoice = new Map<number, LineRow[]>();
  for (const ln of allLines) {
    const moveId = Array.isArray(ln.move_id) ? ln.move_id[0] : undefined;
    if (!moveId) continue;
    const arr = linesByInvoice.get(moveId) ?? [];
    arr.push(ln);
    linesByInvoice.set(moveId, arr);
  }

  const reversals = invoiceIds.length === 0 ? [] : await odoo.searchRead<ReversalRow>(
    'account.move',
    [['move_type', '=', 'out_refund'], ['reversed_entry_id', 'in', invoiceIds]],
    ['reversed_entry_id'],
    { limit: 500 }
  );
  const reversedInvoiceIds = new Set<number>();
  for (const r of reversals) {
    const ref = Array.isArray(r.reversed_entry_id) ? r.reversed_entry_id[0] : undefined;
    if (ref) reversedInvoiceIds.add(ref);
  }

  const candidates: Candidate[] = [];
  let skippedNoInvoice = 0;
  let skippedAlreadyPaid = 0;
  let skippedNoFinancials = 0;
  let skippedNotPosted = 0;

  for (const r of dbRecords) {
    const invoice = invoicesById.get(r.odooInvoiceId!);
    if (!invoice) { skippedNoInvoice++; continue; }
    if (invoice.payment_state === 'paid') { skippedAlreadyPaid++; continue; }
    if (invoice.state !== 'posted') { skippedNotPosted++; continue; }

    const netMerchantDue = calculateNetMerchantDue({
      collectedAmount: r.collectedAmount,
      deliveryFees: r.deliveryFees
    });
    if (netMerchantDue === null) { skippedNoFinancials++; continue; }

    const invoiceTotal = Number(invoice.amount_total ?? 0);
    const invoiceTax = Number(invoice.amount_tax ?? 0);
    const residual = Number(invoice.amount_residual ?? 0);
    // Odoo 17 sets display_type='product' for normal invoice lines; treat 'product' and false/empty
    // as product lines, exclude 'line_section', 'line_note', and other non-product types.
    const lines = (linesByInvoice.get(invoice.id) ?? []).filter((l) => {
      const dt = l.display_type;
      return !dt || dt === 'product';
    });
    const hasTaxes = invoiceTax > 0 || lines.some((l) => (l.tax_ids ?? []).length > 0);
    const hasCreditNote = reversedInvoiceIds.has(invoice.id);

    const expectedResidual = Number((invoiceTotal - netMerchantDue).toFixed(2));
    const residualMatchesRule = Math.abs(residual - expectedResidual) <= TOLERANCE;
    const invoiceLargerThanNet = invoiceTotal > netMerchantDue + TOLERANCE;

    const reasons: string[] = [];
    let classification: 'SAFE_AUTO_FIX' | 'NEEDS_MANUAL_REVIEW' = 'SAFE_AUTO_FIX';

    if (hasCreditNote) { classification = 'NEEDS_MANUAL_REVIEW'; reasons.push('has-credit-note'); }
    if (hasTaxes) { classification = 'NEEDS_MANUAL_REVIEW'; reasons.push('has-taxes'); }
    if (!invoiceLargerThanNet) { classification = 'NEEDS_MANUAL_REVIEW'; reasons.push('invoice-total-not-greater-than-net'); }
    if (!residualMatchesRule) { classification = 'NEEDS_MANUAL_REVIEW'; reasons.push('residual-mismatch (expected=' + expectedResidual.toFixed(2) + ', got=' + residual.toFixed(2) + ')'); }
    if (lines.length === 0) { classification = 'NEEDS_MANUAL_REVIEW'; reasons.push('no-product-lines'); }
    if (lines.length > 3) { classification = 'NEEDS_MANUAL_REVIEW'; reasons.push('many-lines (' + lines.length + ')'); }

    const proposedAction =
      classification === 'SAFE_AUTO_FIX'
        ? 'reset draft → set total = ' + netMerchantDue + ' (was ' + invoiceTotal.toFixed(2) + ') → post → reconcile existing payment'
        : 'manual review required';

    candidates.push({
      shopifyOrderName: r.shopifyOrderName ?? r.shopifyOrderId,
      shopifyOrderId: r.shopifyOrderId,
      invoiceId: invoice.id,
      invoiceName: invoice.name ?? String(invoice.id),
      invoiceTotal,
      invoiceTax,
      amountResidual: residual,
      paymentState: invoice.payment_state ?? '',
      collectedAmount: Number(r.collectedAmount ?? 0),
      deliveryFees: Number(r.deliveryFees ?? 0),
      netMerchantDue,
      lineCount: lines.length,
      hasTaxes,
      hasCreditNote,
      classification,
      reasons,
      proposedAction
    });
  }

  const safe = candidates.filter((c) => c.classification === 'SAFE_AUTO_FIX');
  const manual = candidates.filter((c) => c.classification === 'NEEDS_MANUAL_REVIEW');

  console.log('\n══ Summary ══════════════════════════════════════════════');
  console.log('  Candidates inspected:         ' + candidates.length);
  console.log('  SAFE_AUTO_FIX:                ' + safe.length);
  console.log('  NEEDS_MANUAL_REVIEW:          ' + manual.length);
  console.log('  Skipped: no invoice in Odoo:  ' + skippedNoInvoice);
  console.log('  Skipped: already paid:        ' + skippedAlreadyPaid);
  console.log('  Skipped: not posted:          ' + skippedNotPosted);
  console.log('  Skipped: missing financials:  ' + skippedNoFinancials);

  console.log('\n══ Top 5 SAFE_AUTO_FIX ══════════════════════════════════');
  for (const c of safe.slice(0, 5)) {
    console.log('  ' + c.shopifyOrderName.padEnd(8) + ' ' + c.invoiceName.padEnd(16) + ' total=' + c.invoiceTotal.toFixed(2) + ' netDue=' + c.netMerchantDue.toFixed(2) + ' residual=' + c.amountResidual.toFixed(2) + ' lines=' + c.lineCount);
  }

  console.log('\n══ Top 5 NEEDS_MANUAL_REVIEW ════════════════════════════');
  for (const c of manual.slice(0, 5)) {
    console.log('  ' + c.shopifyOrderName.padEnd(8) + ' ' + c.invoiceName.padEnd(16) + ' total=' + c.invoiceTotal.toFixed(2) + ' netDue=' + c.netMerchantDue.toFixed(2) + ' residual=' + c.amountResidual.toFixed(2) + ' reasons=[' + c.reasons.join('; ') + ']');
  }

  const md: string[] = [];
  md.push('# VIOLA — Net-Due Invoice Backfill PREVIEW (Phase 1, read-only)');
  md.push('');
  md.push('Generated: ' + new Date().toISOString());
  md.push('');
  md.push('## Summary');
  md.push('');
  md.push('- DB candidates (collected + invoice + payment + status=paid): **' + dbRecords.length + '**');
  md.push('- Candidates inspected (invoice exists, posted, not fully paid, has financials): **' + candidates.length + '**');
  md.push('- **SAFE_AUTO_FIX:** ' + safe.length);
  md.push('- **NEEDS_MANUAL_REVIEW:** ' + manual.length);
  md.push('- Skipped:');
  md.push('  - no invoice found in Odoo: ' + skippedNoInvoice);
  md.push('  - already fully paid: ' + skippedAlreadyPaid);
  md.push('  - not posted (draft/cancel): ' + skippedNotPosted);
  md.push('  - missing collectedAmount/deliveryFees: ' + skippedNoFinancials);
  md.push('');
  md.push('## Rule applied');
  md.push('');
  md.push('netMerchantDue = collectedAmount - deliveryFees');
  md.push('');
  md.push('SAFE_AUTO_FIX requires ALL of:');
  md.push('- collected + paid + invoice posted + not fully paid');
  md.push('- invoice total > netMerchantDue');
  md.push('- residual ≈ invoice total - netMerchantDue (tolerance 0.02)');
  md.push('- lines count between 1 and 3');
  md.push('- no taxes on lines');
  md.push('- no credit-note (out_refund) reversing the invoice');
  md.push('');

  const renderTable = (title: string, rows: Candidate[]) => {
    md.push('## ' + title + ' (' + rows.length + ')');
    md.push('');
    if (rows.length === 0) { md.push('_None_'); md.push(''); return; }
    md.push('| Order | Invoice | Invoice Total | Net Merchant Due | Residual | Lines | Tax | Credit Note | Reasons / Action |');
    md.push('|---|---|---:|---:|---:|---:|---|---|---|');
    for (const c of rows) {
      const reasonOrAction = c.classification === 'SAFE_AUTO_FIX' ? c.proposedAction : c.reasons.join('; ');
      md.push('| ' + c.shopifyOrderName + ' | ' + c.invoiceName + ' | ' + c.invoiceTotal.toFixed(2) + ' | ' + c.netMerchantDue.toFixed(2) + ' | ' + c.amountResidual.toFixed(2) + ' | ' + c.lineCount + ' | ' + (c.hasTaxes ? 'yes' : 'no') + ' | ' + (c.hasCreditNote ? 'yes' : 'no') + ' | ' + reasonOrAction + ' |');
    }
    md.push('');
  };

  renderTable('SAFE_AUTO_FIX', safe);
  renderTable('NEEDS_MANUAL_REVIEW', manual);

  md.push('## Next step');
  md.push('');
  md.push('No writes performed. Awaiting explicit approval before Phase 2.');
  md.push('Phase 2 (if approved) will, for SAFE_AUTO_FIX only:');
  md.push('1. reset the invoice to draft (button_draft)');
  md.push('2. adjust line(s) so invoice total equals netMerchantDue');
  md.push('3. post the invoice (action_post)');
  md.push('4. confirm reconciliation with existing payment');
  md.push('5. verify amount_residual == 0 and payment_state == paid');
  md.push('');
  md.push('Each fixed invoice will be verified individually; any failure aborts and is reported.');

  writeFileSync('VIOLA_NET_DUE_INVOICE_BACKFILL_PREVIEW.md', md.join('\n'));
  console.log('\nReport saved: VIOLA_NET_DUE_INVOICE_BACKFILL_PREVIEW.md');

  await prisma.$disconnect();
}

await main();
