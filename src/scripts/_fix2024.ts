/**
 * One-off fix for #2024 / INV/2026/03975.
 *
 * Target: 3419 (= customerDue, what the payment was actually registered for).
 * Current: 6 product lines summing to 6012 → proportionally scale to 3419.
 * Then reconcile with the existing customer payment.
 */
import { OdooClient } from '../odoo/odooClient.js';

const odoo = new OdooClient();
const INVOICE_ID = 408021;
const PAYMENT_ID = 15310;
const TARGET = 3419;

interface InvRow { [k: string]: unknown; id: number; state?: string; payment_state?: string; amount_total?: number; amount_residual?: number; invoice_line_ids?: number[] }
interface LineRow { [k: string]: unknown; id: number; display_type?: string | false; price_unit?: number; quantity?: number; price_subtotal?: number; account_id?: [number, string]; debit?: number; credit?: number; reconciled?: boolean }
interface PayRow { [k: string]: unknown; id: number; move_id?: [number, string] | false }

console.log('Step 1: button_draft');
await odoo.call('account.move', 'button_draft', [[INVOICE_ID]]);
let [inv] = await odoo.searchRead<InvRow>('account.move', [['id', '=', INVOICE_ID]], ['state', 'amount_total', 'invoice_line_ids'], { limit: 1 });
console.log('  state=' + inv?.state + ' total=' + inv?.amount_total);
if (inv?.state !== 'draft') { console.log('Cannot proceed.'); process.exit(1); }

console.log('\nStep 2: proportional adjust to ' + TARGET);
const productLines = await odoo.searchRead<LineRow>(
  'account.move.line',
  [['move_id', '=', INVOICE_ID], ['display_type', '=', 'product']],
  ['price_unit', 'quantity', 'price_subtotal'],
  { limit: 20 }
);
const subtotals = productLines.map((l) => Number(l.price_subtotal ?? 0));
const currentSubtotal = subtotals.reduce((a, b) => a + b, 0);
const factor = TARGET / currentSubtotal;
let running = 0;
for (let i = 0; i < productLines.length; i++) {
  const line = productLines[i];
  const qty = Number(line.quantity ?? 1) || 1;
  let scaled = Number((subtotals[i] * factor).toFixed(2));
  if (i === productLines.length - 1) scaled = Number((TARGET - running).toFixed(2));
  running = Number((running + scaled).toFixed(2));
  const newUnit = Number((scaled / qty).toFixed(2));
  await odoo.executeKw('account.move.line', 'write', [[line.id], { price_unit: newUnit }]);
  console.log('  line ' + line.id + ': ' + subtotals[i] + ' → ' + scaled + ' (unit ' + newUnit + ')');
}

console.log('\nStep 3: action_post');
await odoo.call('account.move', 'action_post', [[INVOICE_ID]]);
[inv] = await odoo.searchRead<InvRow>('account.move', [['id', '=', INVOICE_ID]], ['state', 'amount_total', 'amount_residual', 'payment_state'], { limit: 1 });
console.log('  state=' + inv?.state + ' total=' + inv?.amount_total + ' residual=' + inv?.amount_residual + ' payment_state=' + inv?.payment_state);

console.log('\nStep 4: reconcile with payment ' + PAYMENT_ID);
const [payment] = await odoo.searchRead<PayRow>('account.payment', [['id', '=', PAYMENT_ID]], ['move_id'], { limit: 1 });
const payMoveId = Array.isArray(payment?.move_id) ? (payment!.move_id as [number, string])[0] : undefined;
if (!payMoveId) { console.log('  payment move not found'); process.exit(1); }

const [invArLine] = await odoo.searchRead<LineRow>(
  'account.move.line',
  [['move_id', '=', INVOICE_ID], ['display_type', '=', 'payment_term'], ['reconciled', '=', false]],
  ['debit', 'account_id'],
  { limit: 1 }
);
const arAccount = Array.isArray(invArLine?.account_id) ? (invArLine!.account_id as [number, string])[0] : undefined;
const payLines = await odoo.searchRead<LineRow>(
  'account.move.line',
  [['move_id', '=', payMoveId], ['account_id', '=', arAccount], ['reconciled', '=', false]],
  ['credit', 'account_id'],
  { limit: 5 }
);
const payArLine = payLines.find((l) => Number(l.credit ?? 0) > 0);
if (!invArLine || !payArLine) { console.log('  could not locate AR lines'); process.exit(1); }

console.log('  Reconciling invoice AR line ' + invArLine.id + ' with payment AR line ' + payArLine.id);
await odoo.executeKw('account.move.line', 'reconcile', [[invArLine.id, payArLine.id]]);

const [final] = await odoo.searchRead<InvRow>('account.move', [['id', '=', INVOICE_ID]], ['state', 'amount_total', 'amount_residual', 'payment_state'], { limit: 1 });
console.log('\nFinal: state=' + final?.state + ' total=' + final?.amount_total + ' residual=' + final?.amount_residual + ' payment_state=' + final?.payment_state);
