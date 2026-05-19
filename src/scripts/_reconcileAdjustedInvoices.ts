/**
 * Second-pass: reconcile the 10 already-adjusted invoices with their existing
 * customer-payment AR lines.
 *
 * The previous script reset → adjusted → re-posted them correctly (totals match
 * the net merchant due now), but left the new posted invoices unreconciled.
 * The DB column `odooPaymentId` stores the AR-side line of the customer payment
 * journal entry (not the account.payment id). We reconcile that line against
 * the invoice's payment-term AR line.
 */
import { prisma } from '../lib/prisma.js';
import { OdooClient } from '../odoo/odooClient.js';
import { calculateNetMerchantDue } from '../odoo/odooSyncService.js';

const DRY = process.env.DRY !== '0';
const odoo = new OdooClient();

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  RECONCILE — adjusted invoices ↔ existing customer payments');
console.log('  Mode: ' + (DRY ? 'DRY RUN' : 'WRITE'));
console.log('══════════════════════════════════════════════════════════════\n');

const records = await prisma.shipmentRecord.findMany({
  where: {
    odooSyncStatus: { in: ['paid', 'paid-existing'] },
    odooInvoiceId: { not: null }
  },
  select: {
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

let okCount = 0;
let alreadyPaid = 0;
let failCount = 0;
let nothingToDo = 0;

for (const r of records) {
  const invoiceId = r.odooInvoiceId!;
  const paymentLineId = r.odooPaymentId ?? r.odooSalePaymentId;
  if (!paymentLineId) continue;

  const netDue = calculateNetMerchantDue({ collectedAmount: r.collectedAmount, deliveryFees: r.deliveryFees });
  if (netDue === null) continue;

  // Read invoice state.
  const [inv] = await odoo.searchRead<Record<string, unknown> & { id: number; state?: string; payment_state?: string; amount_total?: number; amount_residual?: number }>(
    'account.move',
    [['id', '=', invoiceId]],
    ['name', 'state', 'payment_state', 'amount_total', 'amount_residual'],
    { limit: 1 }
  );
  if (!inv) { failCount++; continue; }
  if (inv.payment_state === 'paid') { alreadyPaid++; continue; }

  // Only act on invoices whose total now equals net merchant due (i.e. the adjusted ones).
  const total = Number(inv.amount_total ?? 0);
  if (Math.abs(total - netDue) > 0.01) { nothingToDo++; continue; }

  const residual = Number(inv.amount_residual ?? 0);
  if (residual <= 0.01) { alreadyPaid++; continue; }

  // The DB column actually stores `account.payment.id`, not a move-line id.
  // Resolve the payment → its move → the receivable-side move line.
  const [payment] = await odoo.searchRead<Record<string, unknown> & { id: number; move_id?: [number, string] | false }>(
    'account.payment',
    [['id', '=', paymentLineId]],
    ['name', 'move_id', 'state'],
    { limit: 1 }
  );
  if (!payment || !payment.move_id) {
    console.log('  ⏭️  ' + (r.shopifyOrderName ?? '?') + ' / ' + inv.name + ' — payment ' + paymentLineId + ' not found');
    failCount++;
    continue;
  }
  const payMoveId = Array.isArray(payment.move_id) ? (payment.move_id as [number, string])[0] : (payment.move_id as unknown as number);

  // Find the AR receivable line on the payment move (must be open).
  const payLines = await odoo.searchRead<Record<string, unknown> & { id: number; debit?: number; credit?: number; reconciled?: boolean; account_id?: [number, string] }>(
    'account.move.line',
    [['move_id', '=', payMoveId]],
    ['debit', 'credit', 'reconciled', 'account_id'],
    { limit: 10 }
  );
  // Pick the line on the same account as the invoice's payment_term line — i.e. the AR side.
  const invArLines = await odoo.searchRead<Record<string, unknown> & { id: number; debit?: number; reconciled?: boolean; account_id?: [number, string] }>(
    'account.move.line',
    [['move_id', '=', invoiceId], ['display_type', '=', 'payment_term']],
    ['debit', 'reconciled', 'account_id'],
    { limit: 5 }
  );
  const arLine = invArLines.find((l) => l.reconciled !== true && Number(l.debit ?? 0) > 0);
  const arAccountId = Array.isArray(arLine?.account_id) ? (arLine!.account_id as [number, string])[0] : undefined;
  const payArLine = arAccountId ? payLines.find((l) => l.reconciled !== true && Array.isArray(l.account_id) && (l.account_id as [number, string])[0] === arAccountId && Number(l.credit ?? 0) > 0) : undefined;

  if (!arLine || !payArLine) {
    console.log('  ⏭️  ' + (r.shopifyOrderName ?? '?') + ' / ' + inv.name + ' — cannot locate open AR/payment lines (invAR=' + arLine?.id + ', payAR=' + payArLine?.id + ', acct=' + arAccountId + ')');
    failCount++;
    continue;
  }

  console.log('━━━ ' + (r.shopifyOrderName ?? '?') + ' / ' + inv.name + ' ━━━');
  console.log('  invoice total=' + total + ' residual=' + residual + ' invAR=' + arLine.id + ' payAR=' + payArLine.id + ' account=' + arAccountId);
  if (DRY) { console.log('  [DRY] would reconcile'); continue; }

  try {
    await odoo.executeKw('account.move.line', 'reconcile', [[arLine.id, payArLine.id]]);
    const [after] = await odoo.searchRead<Record<string, unknown> & { id: number; state?: string; payment_state?: string; amount_residual?: number }>(
      'account.move',
      [['id', '=', invoiceId]],
      ['payment_state', 'amount_residual'],
      { limit: 1 }
    );
    if (after?.payment_state === 'paid' && Number(after.amount_residual ?? 0) <= 0.01) {
      console.log('  ✅ paid (residual=' + after.amount_residual + ')');
      okCount++;
    } else {
      console.log('  ⚠️  not fully paid: state=' + after?.payment_state + ' residual=' + after?.amount_residual);
      failCount++;
    }
  } catch (err) {
    console.log('  ❌ reconcile failed: ' + (err instanceof Error ? err.message : String(err)));
    failCount++;
  }
}

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  Summary');
console.log('══════════════════════════════════════════════════════════════');
console.log('  ✅ Reconciled paid: ' + okCount);
console.log('  ✅ Already paid:    ' + alreadyPaid);
console.log('  ⏭️  Skipped:         ' + nothingToDo);
console.log('  ❌ Failed:          ' + failCount);

await prisma.$disconnect();
