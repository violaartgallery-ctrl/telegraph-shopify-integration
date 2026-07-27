/**
 * Read-only helper: identify the expense account already used by historical
 * Telegraph return-charge vendor bills. It never creates or updates Odoo data.
 */
import { OdooClient } from '../odoo/odooClient.js';

type Bill = {
  id: number;
  name?: string;
  ref?: string;
  invoice_line_ids?: number[];
};

type BillLine = {
  id: number;
  move_id?: [number, string] | false;
  account_id?: [number, string] | false;
  display_type?: string | false;
};

const odoo = new OdooClient();
const bills = await odoo.searchRead<Bill>(
  'account.move',
  [
    ['move_type', '=', 'in_invoice'],
    ['ref', 'ilike', 'Return shipping charge']
  ],
  ['name', 'ref', 'invoice_line_ids'],
  { limit: 200, order: 'id desc' }
);

const lineIds = bills.flatMap((bill) => bill.invoice_line_ids ?? []);
const lines = lineIds.length === 0
  ? []
  : await odoo.searchRead<BillLine>(
      'account.move.line',
      [
        ['id', 'in', lineIds],
        ['display_type', '=', 'product']
      ],
      ['move_id', 'account_id', 'display_type'],
      { limit: Math.max(lineIds.length, 1) }
    );

const usage = new Map<number, { id: number; name: string; count: number }>();
for (const line of lines) {
  if (!Array.isArray(line.account_id)) continue;
  const [id, name] = line.account_id;
  const current = usage.get(id) ?? { id, name, count: 0 };
  current.count += 1;
  usage.set(id, current);
}

console.log(JSON.stringify({
  readOnly: true,
  historicalBills: bills.length,
  accounts: [...usage.values()].sort((a, b) => b.count - a.count)
}, null, 2));
