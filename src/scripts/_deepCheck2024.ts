/**
 * Full deep-dive on #2024 / INV/2026/03975 to confirm correct handling.
 *
 * Decision tree:
 *  - If invoice can be safely backfilled (just over the cap of 3 lines), do it.
 *  - If real Telegraph data anomaly (collected != expected), flag for manual.
 */
import { prisma } from '../lib/prisma.js';
import { OdooClient } from '../odoo/odooClient.js';
import { calculateNetMerchantDue } from '../odoo/odooSyncService.js';

const odoo = new OdooClient();

console.log('═══════════════════════════════════════════════════════');
console.log('  #2024 / INV/2026/03975 deep check');
console.log('═══════════════════════════════════════════════════════\n');

const rec = await prisma.shipmentRecord.findFirst({
  where: { shopifyOrderName: '#2024' },
  select: {
    shopifyOrderName: true,
    odooInvoiceId: true,
    odooInvoiceName: true,
    odooPaymentId: true,
    odooSalePaymentId: true,
    collectedAmount: true,
    deliveryFees: true,
    customerDue: true,
    accurateShipmentCode: true,
    accurateStatus: true,
    collectionStatus: true,
    odooSyncStatus: true,
    odooSyncedAt: true
  }
});
console.log('DB record:');
console.log('  ' + JSON.stringify(rec, null, 2));

const netDue = calculateNetMerchantDue({ collectedAmount: rec?.collectedAmount, deliveryFees: rec?.deliveryFees });
console.log('\nComputed netMerchantDue = ' + netDue);
console.log('  (collected ' + rec?.collectedAmount + ' − deliveryFees ' + rec?.deliveryFees + ')');

if (!rec?.odooInvoiceId) { console.log('No invoice id, stopping.'); process.exit(0); }

const [inv] = await odoo.searchRead<{ id: number; name?: string; state?: string; payment_state?: string; amount_total?: number; amount_residual?: number; amount_tax?: number; invoice_line_ids?: number[] }>(
  'account.move',
  [['id', '=', rec.odooInvoiceId]],
  ['name', 'state', 'payment_state', 'amount_total', 'amount_residual', 'amount_tax', 'invoice_line_ids'],
  { limit: 1 }
);
console.log('\nInvoice:');
console.log('  ' + JSON.stringify(inv, null, 2));

// Line breakdown
const lineIds = inv?.invoice_line_ids ?? [];
console.log('\n' + lineIds.length + ' invoice_line_ids');
if (lineIds.length > 0) {
  const lines = await odoo.searchRead<{ id: number; name?: string; display_type?: string | false; price_unit?: number; quantity?: number; price_subtotal?: number; tax_ids?: number[] }>(
    'account.move.line',
    [['id', 'in', lineIds]],
    ['name', 'display_type', 'price_unit', 'quantity', 'price_subtotal', 'tax_ids'],
    { limit: lineIds.length }
  );
  let productSubtotal = 0;
  for (const l of lines) {
    console.log('  [' + (l.display_type ?? 'falsy') + '] ' + l.name + ' | qty=' + l.quantity + ' unit=' + l.price_unit + ' subtotal=' + l.price_subtotal + ' tax=' + (l.tax_ids?.length ?? 0));
    if (!l.display_type || l.display_type === 'product') productSubtotal += Number(l.price_subtotal ?? 0);
  }
  console.log('\nSum of product subtotals: ' + productSubtotal);
  console.log('Invoice total:            ' + inv?.amount_total);
  console.log('Invoice residual:         ' + inv?.amount_residual);
  console.log('Invoice payment_state:    ' + inv?.payment_state);
  console.log('Net merchant due:         ' + netDue);
  const diff = Number(inv?.amount_total ?? 0) - (netDue ?? 0);
  console.log('Diff (invoice - netDue):  ' + diff);
  const expectedResidual = diff;
  const actualResidual = Number(inv?.amount_residual ?? 0);
  console.log('Expected residual:        ' + expectedResidual.toFixed(2));
  console.log('Actual residual:          ' + actualResidual.toFixed(2));
  console.log('Residual mismatch:        ' + (actualResidual - expectedResidual).toFixed(2));
}

await prisma.$disconnect();
