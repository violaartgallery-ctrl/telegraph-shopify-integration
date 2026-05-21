/**
 * End-to-end test of reset → adjust → re-post on a real partial.
 * Trace each step to find where the adjustment is being lost.
 */
import { OdooClient } from '../odoo/odooClient.js';
const odoo = new OdooClient();

const INV_NAME = 'INV/2026/03974'; // total 1120, residual 6, want net 1114
const TARGET = 1114;

const [inv] = await odoo.searchRead<{ id: number; name?: string; state?: string; payment_state?: string; amount_total?: number; amount_residual?: number; invoice_line_ids?: number[] }>(
  'account.move',
  [['name', '=', INV_NAME]],
  ['name', 'state', 'payment_state', 'amount_total', 'amount_residual', 'invoice_line_ids'],
  { limit: 1 }
);
console.log('BEFORE:', inv);

// Inspect product lines
const lines = await odoo.searchRead<{ id: number; display_type?: string | false; price_unit?: number; quantity?: number; price_subtotal?: number; sale_line_ids?: number[]; name?: string }>(
  'account.move.line',
  [['move_id', '=', inv.id], ['display_type', '=', 'product']],
  ['display_type', 'price_unit', 'quantity', 'price_subtotal', 'sale_line_ids', 'name'],
  { limit: 20 }
);
console.log('\nProduct lines:');
for (const l of lines) console.log('  ', JSON.stringify(l));

// Step 1: reset to draft
console.log('\n[STEP 1] button_draft...');
await odoo.call('account.move', 'button_draft', [[inv.id]]);
const [step1] = await odoo.searchRead<{ id: number; state?: string; amount_total?: number }>('account.move', [['id', '=', inv.id]], ['state', 'amount_total'], { limit: 1 });
console.log('  state=' + step1?.state + ' total=' + step1?.amount_total);

// Step 2: adjust line price_unit
if (lines.length === 1 && step1?.state === 'draft') {
  const only = lines[0];
  const qty = Number(only.quantity ?? 1) || 1;
  const newUnit = Number((TARGET / qty).toFixed(2));
  console.log('\n[STEP 2] writing price_unit=' + newUnit + ' on line ' + only.id);
  await odoo.executeKw('account.move.line', 'write', [[only.id], { price_unit: newUnit }]);
  const [afterWrite] = await odoo.searchRead<{ id: number; state?: string; amount_total?: number }>('account.move', [['id', '=', inv.id]], ['state', 'amount_total'], { limit: 1 });
  console.log('  After write: state=' + afterWrite?.state + ' total=' + afterWrite?.amount_total);

  // Step 3: re-post
  console.log('\n[STEP 3] action_post...');
  await odoo.call('account.move', 'action_post', [[inv.id]]);
  const [afterPost] = await odoo.searchRead<{ id: number; state?: string; amount_total?: number; amount_residual?: number; payment_state?: string }>('account.move', [['id', '=', inv.id]], ['state', 'amount_total', 'amount_residual', 'payment_state'], { limit: 1 });
  console.log('  After post: state=' + afterPost?.state + ' total=' + afterPost?.amount_total + ' residual=' + afterPost?.amount_residual + ' payment_state=' + afterPost?.payment_state);

  // Re-inspect lines
  const linesAfter = await odoo.searchRead<{ id: number; price_unit?: number; price_subtotal?: number }>(
    'account.move.line',
    [['id', '=', only.id]],
    ['price_unit', 'price_subtotal'],
    { limit: 1 }
  );
  console.log('  Line after:', JSON.stringify(linesAfter[0]));
} else {
  console.log('SKIP: lines.length=' + lines.length + ' state=' + step1?.state);
}
