/**
 * BACKFILL: fix partial invoices by resetting to draft, adjusting lines to the
 * net merchant due, re-posting, then re-reconciling with the existing payment.
 *
 * Safe constraints per invoice (all must hold or skip):
 *   • state = posted
 *   • payment_state in (partial, not_paid, in_payment) — never touch fully paid
 *   • amount_total > netMerchantDue + 0.01 (current overshoot is the bug we fix)
 *   • residual ≈ amount_total − netMerchantDue (residual matches the rule)
 *   • amount_tax = 0 (we don't touch tax cases automatically)
 *   • no associated credit note (out_refund) reversing this invoice
 *   • lines ≤ 3 (audit pre-classification)
 *
 * For each safe row:
 *   1. button_draft → invoice back to draft (unreconciles payments).
 *   2. adjustDraftInvoiceLinesToTotal(invoiceId, netMerchantDue).
 *   3. action_post.
 *   4. re-reconcile the existing payment line against the new invoice's open receivable line.
 *   5. verify residual = 0 and payment_state = paid; otherwise rollback report.
 *
 * Read-only on first pass, then writes only with DRY=0.
 */
import { prisma } from '../lib/prisma.js';
import { OdooClient } from '../odoo/odooClient.js';
import { calculateNetMerchantDue } from '../odoo/odooSyncService.js';

const DRY = process.env.DRY !== '0';
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
  line_ids?: number[];
}

interface MoveLineRow {
  [key: string]: unknown;
  id: number;
  account_id?: [number, string];
  reconciled?: boolean;
  amount_residual?: number;
  display_type?: string | false;
  move_id?: [number, string];
}

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  BACKFILL — partial invoices to fully paid (net merchant due)');
console.log('  Mode: ' + (DRY ? 'DRY RUN (read-only)' : 'WRITE'));
console.log('══════════════════════════════════════════════════════════════\n');

const paidRecords = await prisma.shipmentRecord.findMany({
  where: {
    odooSyncStatus: { in: ['paid', 'paid-existing'] },
    odooInvoiceId: { not: null }
  },
  select: {
    id: true,
    shopifyOrderName: true,
    shopifyOrderId: true,
    odooInvoiceId: true,
    odooInvoiceName: true,
    odooPaymentId: true,
    odooSalePaymentId: true,
    collectedAmount: true,
    deliveryFees: true
  }
});

const invoiceIds = paidRecords.map((r) => r.odooInvoiceId!).filter(Boolean);
const invoices = invoiceIds.length === 0 ? [] : await odoo.searchRead<InvoiceRow>(
  'account.move',
  [['id', 'in', invoiceIds]],
  ['name', 'state', 'payment_state', 'amount_total', 'amount_residual', 'amount_tax', 'invoice_line_ids', 'line_ids'],
  { limit: invoiceIds.length }
);
const invById = new Map(invoices.map((i) => [i.id, i]));

// Detect credit notes that reverse any of these invoices.
const reversals = invoiceIds.length === 0 ? [] : await odoo.searchRead<{ id: number; reversed_entry_id?: [number, string] | false }>(
  'account.move',
  [['move_type', '=', 'out_refund'], ['reversed_entry_id', 'in', invoiceIds]],
  ['reversed_entry_id'],
  { limit: 500 }
);
const reversedSet = new Set<number>();
for (const r of reversals) {
  const ref = Array.isArray(r.reversed_entry_id) ? r.reversed_entry_id[0] : undefined;
  if (ref) reversedSet.add(ref);
}

interface Candidate {
  recordId: number;
  orderName: string;
  invoiceId: number;
  invoiceName: string;
  invoiceTotal: number;
  netMerchantDue: number;
  residual: number;
  paymentId?: number | null;
  reasons: string[];
}

const safeRows: Candidate[] = [];
const skipped: { name: string; invoice: string; reason: string }[] = [];

for (const r of paidRecords) {
  const inv = invById.get(r.odooInvoiceId!);
  if (!inv) continue;

  const netDue = calculateNetMerchantDue({ collectedAmount: r.collectedAmount, deliveryFees: r.deliveryFees });
  if (netDue === null) continue;

  const total = Number(inv.amount_total ?? 0);
  const residual = Number(inv.amount_residual ?? 0);

  // Healthy / non-applicable cases.
  if (inv.payment_state === 'paid') continue;
  if (Math.abs(total - netDue) <= 0.01) continue;
  if (total <= netDue) continue;

  const reasons: string[] = [];
  if (inv.state !== 'posted') reasons.push('not-posted (' + inv.state + ')');
  if (Number(inv.amount_tax ?? 0) > 0) reasons.push('has-tax');
  if (reversedSet.has(inv.id)) reasons.push('has-credit-note');
  const expectedResidual = Number((total - netDue).toFixed(2));
  if (Math.abs(residual - expectedResidual) > 0.02) reasons.push('residual-mismatch (expected ' + expectedResidual + ', got ' + residual + ')');

  // Inspect invoice product lines (must be 1–3 simple lines).
  const lineIds = inv.invoice_line_ids ?? [];
  if (lineIds.length === 0) reasons.push('no-product-lines');
  if (lineIds.length > 3) reasons.push('many-lines (' + lineIds.length + ')');

  const candidate: Candidate = {
    recordId: r.id,
    orderName: r.shopifyOrderName ?? r.shopifyOrderId,
    invoiceId: inv.id,
    invoiceName: inv.name ?? String(inv.id),
    invoiceTotal: total,
    netMerchantDue: netDue,
    residual,
    paymentId: r.odooPaymentId ?? r.odooSalePaymentId ?? null,
    reasons
  };

  if (reasons.length === 0) safeRows.push(candidate);
  else skipped.push({ name: candidate.orderName, invoice: candidate.invoiceName, reason: reasons.join('; ') });
}

console.log('Candidates:        ' + (safeRows.length + skipped.length));
console.log('  ✅ Safe to fix:  ' + safeRows.length);
console.log('  ⏭️  Skipped:      ' + skipped.length);
if (skipped.length > 0) {
  console.log('\nSkipped:');
  for (const s of skipped) console.log('  ' + s.name.padEnd(8) + ' | ' + s.invoice.padEnd(15) + ' | ' + s.reason);
}

if (safeRows.length === 0 || DRY) {
  console.log('\nPreview only:');
  for (const c of safeRows) {
    console.log('  ' + c.orderName.padEnd(8) + ' | ' + c.invoiceName.padEnd(15) + ' | total ' + c.invoiceTotal.toFixed(2) + ' → ' + c.netMerchantDue.toFixed(2) + ' (residual ' + c.residual.toFixed(2) + ')');
  }
  console.log('\n' + (DRY ? '⚠️  DRY mode. Re-run with DRY=0 to apply.' : '⚠️  Nothing to do.'));
  await prisma.$disconnect();
  process.exit(0);
}

// ── WRITE PASS ────────────────────────────────────────────────────
console.log('\nApplying backfill...\n');

let okCount = 0;
let failCount = 0;

for (const c of safeRows) {
  console.log('━━━ ' + c.orderName + ' / ' + c.invoiceName + ' ━━━');
  console.log('  total=' + c.invoiceTotal + ' netDue=' + c.netMerchantDue + ' residual=' + c.residual);

  try {
    // 1. Reset to draft.
    await odoo.call('account.move', 'button_draft', [[c.invoiceId]]);
    let inv = (await odoo.searchRead<InvoiceRow>('account.move', [['id', '=', c.invoiceId]], ['state', 'payment_state', 'amount_total', 'amount_residual', 'invoice_line_ids'], { limit: 1 }))[0];
    if (inv?.state !== 'draft') {
      console.log('  ❌ button_draft did not move to draft (state=' + inv?.state + ')');
      failCount++;
      continue;
    }

    // 2. Adjust lines.
    const lineIds = inv.invoice_line_ids ?? [];
    const lines = await odoo.searchRead<MoveLineRow & { price_unit?: number; quantity?: number; price_subtotal?: number }>(
      'account.move.line',
      [['id', 'in', lineIds]],
      ['display_type', 'price_unit', 'quantity', 'price_subtotal'],
      { limit: lineIds.length }
    );
    const productLines = lines.filter((l) => !l.display_type || l.display_type === 'product');
    if (productLines.length === 0) { console.log('  ❌ no product lines'); failCount++; continue; }

    if (productLines.length === 1) {
      const only = productLines[0];
      const qty = Number(only.quantity ?? 0) > 0 ? Number(only.quantity) : 1;
      const newUnit = Number((c.netMerchantDue / qty).toFixed(2));
      await odoo.executeKw('account.move.line', 'write', [[only.id], { price_unit: newUnit, quantity: qty }]);
    } else {
      const subtotals = productLines.map((l) => Number(l.price_subtotal ?? Number(l.price_unit ?? 0) * Number(l.quantity ?? 1)));
      const currentSubtotal = subtotals.reduce((a, b) => a + b, 0);
      if (currentSubtotal <= 0) { console.log('  ❌ zero subtotal — abort'); failCount++; continue; }
      const factor = c.netMerchantDue / currentSubtotal;
      let running = 0;
      for (let i = 0; i < productLines.length; i++) {
        const line = productLines[i];
        const qty = Number(line.quantity ?? 1) || 1;
        let scaled = Number((subtotals[i] * factor).toFixed(2));
        if (i === productLines.length - 1) scaled = Number((c.netMerchantDue - running).toFixed(2));
        running = Number((running + scaled).toFixed(2));
        const newUnit = Number((scaled / qty).toFixed(2));
        await odoo.executeKw('account.move.line', 'write', [[line.id], { price_unit: newUnit }]);
      }
    }

    // 3. Re-post.
    await odoo.call('account.move', 'action_post', [[c.invoiceId]]);
    inv = (await odoo.searchRead<InvoiceRow>('account.move', [['id', '=', c.invoiceId]], ['state', 'payment_state', 'amount_total', 'amount_residual', 'line_ids'], { limit: 1 }))[0];
    if (inv?.state !== 'posted') {
      console.log('  ❌ action_post failed (state=' + inv?.state + ')');
      failCount++;
      continue;
    }
    console.log('  Adjusted: total=' + inv.amount_total + ' residual=' + inv.amount_residual + ' payment_state=' + inv.payment_state);

    // 4. Re-reconcile with existing payment if any unreconciled receivable line remains.
    if (Number(inv.amount_residual ?? 0) > 0.01 && c.paymentId) {
      // Find receivable line on the new posted invoice.
      const allLines = await odoo.searchRead<MoveLineRow & { credit?: number; debit?: number }>(
        'account.move.line',
        [['move_id', '=', c.invoiceId]],
        ['account_id', 'reconciled', 'amount_residual', 'display_type', 'debit', 'credit'],
        { limit: 50 }
      );
      // Receivable line = unreconciled with debit > 0 on AR account.
      const arLine = allLines.find((l) => l.reconciled !== true && (Number(l.debit ?? 0) > 0) && !l.display_type);

      // Find payment's open receivable line.
      const payLines = await odoo.searchRead<MoveLineRow & { credit?: number; debit?: number; payment_id?: [number, string] }>(
        'account.move.line',
        [['payment_id', '=', c.paymentId]],
        ['account_id', 'reconciled', 'amount_residual', 'credit', 'debit', 'payment_id'],
        { limit: 50 }
      );
      // Payment side that reduces the AR is a CREDIT to receivable.
      const payLine = payLines.find((l) => l.reconciled !== true && Number(l.credit ?? 0) > 0);

      if (arLine && payLine) {
        try {
          await odoo.executeKw('account.move.line', 'reconcile', [[arLine.id, payLine.id]]);
          console.log('  ✅ reconciled AR line ' + arLine.id + ' with payment line ' + payLine.id);
        } catch (recErr) {
          console.log('  ⚠️  reconcile failed: ' + (recErr instanceof Error ? recErr.message : String(recErr)));
        }
      } else {
        console.log('  ⚠️  could not locate AR line or payment line to reconcile (ar=' + arLine?.id + ', pay=' + payLine?.id + ')');
      }

      inv = (await odoo.searchRead<InvoiceRow>('account.move', [['id', '=', c.invoiceId]], ['state', 'payment_state', 'amount_total', 'amount_residual'], { limit: 1 }))[0];
    }

    // 5. Verify.
    if (inv?.payment_state === 'paid' && Number(inv.amount_residual ?? 0) <= 0.01) {
      console.log('  ✅ paid (total=' + inv.amount_total + ', residual=' + inv.amount_residual + ')');
      okCount++;
    } else {
      console.log('  ⚠️  not fully paid yet: state=' + inv?.payment_state + ' residual=' + inv?.amount_residual);
      failCount++;
    }
  } catch (err) {
    console.log('  ❌ ' + (err instanceof Error ? err.message : String(err)));
    failCount++;
  }
}

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  Summary');
console.log('══════════════════════════════════════════════════════════════');
console.log('  ✅ Backfilled paid: ' + okCount);
console.log('  ❌ Failed/partial:  ' + failCount);

await prisma.$disconnect();
