/**
 * Debug: inspect the actual structure of invoice lines for one of the candidates.
 */
import { OdooClient } from '../odoo/odooClient.js';

const odoo = new OdooClient();

// Sample invoice id from the preview: INV/2026/03820 → #1788
const invoices = await odoo.searchRead<{
  id: number;
  name?: string;
  invoice_line_ids?: number[];
  amount_total?: number;
}>(
  'account.move',
  [['name', '=', 'INV/2026/03820']],
  ['name', 'invoice_line_ids', 'amount_total'],
  { limit: 1 }
);

if (!invoices.length) { console.log('Invoice not found'); process.exit(1); }
const inv = invoices[0];
console.log('Invoice:', inv);

const lineIds = inv.invoice_line_ids ?? [];
console.log('invoice_line_ids:', lineIds);

if (lineIds.length === 0) { console.log('No lines'); process.exit(0); }

const lines = await odoo.searchRead<Record<string, unknown>>(
  'account.move.line',
  [['id', 'in', lineIds]],
  ['display_type', 'price_unit', 'quantity', 'price_subtotal', 'price_total', 'tax_ids', 'move_id', 'name', 'product_id', 'account_id'],
  { limit: lineIds.length }
);

console.log('\nLines:');
for (const ln of lines) {
  console.log(JSON.stringify(ln, null, 2));
}
