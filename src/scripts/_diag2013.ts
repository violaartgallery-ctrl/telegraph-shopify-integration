import { OdooClient } from '../odoo/odooClient.js';
const odoo = new OdooClient();

const lines = await odoo.searchRead<Record<string, unknown> & { id: number }>(
  'account.move.line',
  [['move_id', '=', 407450]],
  ['name', 'account_id', 'display_type', 'debit', 'credit', 'amount_residual', 'reconciled', 'matched_debit_ids', 'matched_credit_ids'],
  { limit: 50 }
);
console.log('Lines:');
for (const l of lines) console.log(JSON.stringify(l));
