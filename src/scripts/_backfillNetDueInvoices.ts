/**
 * CONTROLLED WRITE: fix historical partially-paid collected invoices by aligning
 * posted invoice totals to Telegraph net merchant due.
 *
 * Business rule:
 *   invoice total = collectedAmount - deliveryFees
 *
 * Safety:
 * - Recomputes SAFE_AUTO_FIX criteria live before every write.
 * - Stops on first failure unless CONTINUE_ON_ERROR=1.
 * - Does not touch taxes, credit notes, many-line invoices, already-paid invoices,
 *   or records where residual does not exactly match invoiceTotal - netMerchantDue.
 *
 * Usage:
 *   node --import tsx src/scripts/_backfillNetDueInvoices.ts
 *   LIMIT=1 node --import tsx src/scripts/_backfillNetDueInvoices.ts
 */
import { prisma } from '../lib/prisma.js';
import { OdooClient } from '../odoo/odooClient.js';
import { calculateNetMerchantDue } from '../odoo/odooSyncService.js';

const TOLERANCE = 0.02;
const limit = Number(process.env.LIMIT ?? '0');
const continueOnError = process.env.CONTINUE_ON_ERROR === '1';
const orderFilter = process.env.ORDER ? new Set(process.env.ORDER.split(',').map((s) => s.trim())) : null;

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
}

interface LineRow {
  [key: string]: unknown;
  id: number;
  display_type?: string | false;
  price_unit?: number;
  quantity?: number;
  price_subtotal?: number;
  price_total?: number;
  tax_ids?: number[];
  move_id?: [number, string];
}

interface ReversalRow {
  [key: string]: unknown;
  id: number;
  reversed_entry_id?: [number, string] | false;
}

interface Candidate {
  recordId: number;
  shopifyOrderId: string;
  shopifyOrderName: string;
  invoiceId: number;
  invoiceName: string;
  invoiceTotal: number;
  residual: number;
  netMerchantDue: number;
  productLines: LineRow[];
}

const round2 = (value: number): number => Number(Number(value).toFixed(2));

async function getInvoice(invoiceId: number): Promise<InvoiceRow> {
  const [invoice] = await odoo.searchRead<InvoiceRow>(
    'account.move',
    [['id', '=', invoiceId]],
    ['name', 'state', 'payment_state', 'amount_total', 'amount_tax', 'amount_residual', 'invoice_line_ids'],
    { limit: 1 }
  );
  if (!invoice) throw new Error(`Invoice not found: ${invoiceId}`);
  return invoice;
}

async function getProductLines(invoice: InvoiceRow): Promise<LineRow[]> {
  const lineIds = invoice.invoice_line_ids ?? [];
  if (lineIds.length === 0) return [];
  const lines = await odoo.searchRead<LineRow>(
    'account.move.line',
    [['id', 'in', lineIds]],
    ['display_type', 'price_unit', 'quantity', 'price_subtotal', 'price_total', 'tax_ids', 'move_id'],
    { limit: lineIds.length }
  );
  return lines.filter((line) => {
    const displayType = line.display_type;
    return !displayType || displayType === 'product';
  });
}

async function hasCreditNote(invoiceId: number): Promise<boolean> {
  const reversals = await odoo.searchRead<ReversalRow>(
    'account.move',
    [['move_type', '=', 'out_refund'], ['reversed_entry_id', '=', invoiceId]],
    ['reversed_entry_id'],
    { limit: 1 }
  );
  return reversals.length > 0;
}

async function buildCandidates(): Promise<Candidate[]> {
  const records = await prisma.shipmentRecord.findMany({
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
      id: true,
      shopifyOrderId: true,
      shopifyOrderName: true,
      collectedAmount: true,
      deliveryFees: true,
      odooInvoiceId: true,
      odooInvoiceName: true
    },
    orderBy: { id: 'asc' }
  });

  const candidates: Candidate[] = [];
  for (const record of records) {
    const orderName = record.shopifyOrderName ?? record.shopifyOrderId;
    if (orderFilter && !orderFilter.has(orderName)) continue;

    const netMerchantDue = calculateNetMerchantDue({
      collectedAmount: record.collectedAmount,
      deliveryFees: record.deliveryFees
    });
    if (netMerchantDue === null) continue;

    const invoice = await getInvoice(record.odooInvoiceId!);
    if (invoice.state !== 'posted') continue;
    if (invoice.payment_state === 'paid') continue;
    if (Number(invoice.amount_tax ?? 0) > 0) continue;
    if (await hasCreditNote(invoice.id)) continue;

    const productLines = await getProductLines(invoice);
    if (productLines.length === 0 || productLines.length > 4) continue;
    if (productLines.some((line) => (line.tax_ids ?? []).length > 0)) continue;

    const invoiceTotal = round2(Number(invoice.amount_total ?? 0));
    const residual = round2(Number(invoice.amount_residual ?? 0));
    const expectedResidual = round2(invoiceTotal - netMerchantDue);
    if (invoiceTotal <= netMerchantDue + TOLERANCE) continue;
    if (Math.abs(residual - expectedResidual) > TOLERANCE) continue;

    candidates.push({
      recordId: record.id,
      shopifyOrderId: record.shopifyOrderId,
      shopifyOrderName: orderName,
      invoiceId: invoice.id,
      invoiceName: invoice.name ?? record.odooInvoiceName ?? String(invoice.id),
      invoiceTotal,
      residual,
      netMerchantDue,
      productLines
    });
  }
  return limit > 0 ? candidates.slice(0, limit) : candidates;
}

async function adjustDraftInvoiceLinesToTotal(invoiceId: number, targetTotal: number): Promise<void> {
  const invoice = await getInvoice(invoiceId);
  if (invoice.state !== 'draft') {
    throw new Error(`Invoice ${invoice.name ?? invoiceId} is not draft after button_draft`);
  }

  const productLines = await getProductLines(invoice);
  if (productLines.length === 0 || productLines.length > 4) {
    throw new Error(`Unsafe product line count after draft reset: ${productLines.length}`);
  }

  const target = round2(targetTotal);
  if (productLines.length === 1) {
    const line = productLines[0];
    const qty = Number(line.quantity ?? 0) > 0 ? Number(line.quantity) : 1;
    await odoo.executeKw('account.move.line', 'write', [[line.id], {
      price_unit: round2(target / qty),
      quantity: qty
    }]);
    return;
  }

  const subtotals = productLines.map((line) => Number(line.price_subtotal ?? Number(line.price_unit ?? 0) * Number(line.quantity ?? 1)));
  const currentSubtotal = subtotals.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(currentSubtotal) || currentSubtotal <= 0) {
    throw new Error('Current subtotal is invalid');
  }

  const factor = target / currentSubtotal;
  let runningTotal = 0;
  for (let i = 0; i < productLines.length; i += 1) {
    const line = productLines[i];
    const qty = Number(line.quantity ?? 1) || 1;
    let scaledSubtotal = round2(subtotals[i] * factor);
    if (i === productLines.length - 1) {
      scaledSubtotal = round2(target - runningTotal);
    }
    runningTotal = round2(runningTotal + scaledSubtotal);
    await odoo.executeKw('account.move.line', 'write', [[line.id], {
      price_unit: round2(scaledSubtotal / qty)
    }]);
  }
}

async function assignExistingOutstandingPayment(invoiceId: number, paymentId: number | null): Promise<void> {
  const [invoice] = await odoo.searchRead<InvoiceRow & {
    invoice_outstanding_credits_debits_widget?: {
      content?: Array<{ id?: number; account_payment_id?: number; amount?: number }>;
    } | false;
  }>(
    'account.move',
    [['id', '=', invoiceId]],
    ['invoice_outstanding_credits_debits_widget'],
    { limit: 1 }
  );

  const widget = invoice?.invoice_outstanding_credits_debits_widget;
  const content = widget && typeof widget === 'object' ? widget.content ?? [] : [];
  const match = content.find((item) => {
    if (!item.id) return false;
    return paymentId ? item.account_payment_id === paymentId : true;
  });
  if (!match?.id) {
    throw new Error(`No outstanding payment line found for invoice ${invoiceId}${paymentId ? ` / payment ${paymentId}` : ''}`);
  }

  await odoo.call('account.move', 'js_assign_outstanding_line', [[invoiceId], match.id]);
}

async function fixOne(candidate: Candidate): Promise<void> {
  console.log(`\n→ ${candidate.shopifyOrderName} ${candidate.invoiceName}: ${candidate.invoiceTotal} → ${candidate.netMerchantDue} (residual ${candidate.residual})`);

  await odoo.call('account.move', 'button_draft', [[candidate.invoiceId]]);
  await adjustDraftInvoiceLinesToTotal(candidate.invoiceId, candidate.netMerchantDue);
  await odoo.call('account.move', 'action_post', [[candidate.invoiceId]]);

  let after = await getInvoice(candidate.invoiceId);
  if (round2(Number(after.amount_residual ?? 0)) > TOLERANCE && after.payment_state !== 'paid') {
    const record = await prisma.shipmentRecord.findUnique({
      where: { id: candidate.recordId },
      select: { odooSalePaymentId: true, odooPaymentId: true }
    });
    const paymentId = record?.odooSalePaymentId ?? record?.odooPaymentId ?? null;
    await assignExistingOutstandingPayment(candidate.invoiceId, paymentId);
  }

  after = await getInvoice(candidate.invoiceId);
  const total = round2(Number(after.amount_total ?? 0));
  const residual = round2(Number(after.amount_residual ?? 0));
  const paymentState = after.payment_state ?? '';
  if (Math.abs(total - candidate.netMerchantDue) > TOLERANCE) {
    throw new Error(`Post-check failed: total=${total}, expected=${candidate.netMerchantDue}`);
  }
  if (residual > TOLERANCE || !['paid', 'in_payment'].includes(paymentState)) {
    throw new Error(`Post-check failed: residual=${residual}, payment_state=${paymentState}`);
  }

  await prisma.shipmentRecord.update({
    where: { id: candidate.recordId },
    data: {
      odooLastError: null,
      odooSyncedAt: new Date()
    }
  });

  console.log(`  ✓ fixed: total=${total}, residual=${residual}, payment_state=${paymentState}`);
}

const candidates = await buildCandidates();
console.log(`Backfill candidates selected: ${candidates.length}${limit > 0 ? ` (LIMIT=${limit})` : ''}`);

const fixed: string[] = [];
const failed: Array<{ order: string; invoice: string; error: string }> = [];

for (const candidate of candidates) {
  try {
    await fixOne(candidate);
    fixed.push(candidate.shopifyOrderName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  ✗ failed ${candidate.shopifyOrderName}: ${message}`);
    failed.push({ order: candidate.shopifyOrderName, invoice: candidate.invoiceName, error: message });
    if (!continueOnError) break;
  }
}

console.log('\nSummary');
console.log(JSON.stringify({ selected: candidates.length, fixed: fixed.length, failed }, null, 2));

await prisma.$disconnect();
