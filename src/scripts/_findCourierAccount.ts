/**
 * READ-ONLY: Find Odoo account 400021 Courier
 */
import { OdooClient } from '../odoo/odooClient.js';

const odoo = new OdooClient();

// Search by code first
const byCode = await odoo.searchRead<{
  id: number; code: string; name: string; account_type?: string;
}>(
  'account.account',
  [['code', '=', '400021']],
  ['code', 'name', 'account_type'],
  { limit: 5 }
);

console.log('\n══ Search by code = "400021" ══');
console.log(JSON.stringify(byCode, null, 2));

// Search by name ilike Courier
const byName = await odoo.searchRead<{
  id: number; code: string; name: string; account_type?: string;
}>(
  'account.account',
  [['name', 'ilike', 'Courier']],
  ['code', 'name', 'account_type'],
  { limit: 10 }
);

console.log('\n══ Search by name ilike "Courier" ══');
console.log(JSON.stringify(byName, null, 2));
