import { prisma } from '../lib/prisma.js';
import { OdooClient } from '../odoo/odooClient.js';
const odoo = new OdooClient();

const r = await prisma.shipmentRecord.findFirst({
  where: { shopifyOrderName: '#2013' },
  select: { odooSyncStatus: true, odooInvoiceId: true, odooSyncedAt: true, collectedAmount: true, deliveryFees: true }
});
console.log('DB:', r);

if (r?.odooInvoiceId) {
  const [inv] = await odoo.searchRead<{ id: number; name?: string; state?: string; payment_state?: string; amount_total?: number; amount_residual?: number; create_date?: string }>(
    'account.move',
    [['id', '=', r.odooInvoiceId]],
    ['name', 'state', 'payment_state', 'amount_total', 'amount_residual', 'create_date'],
    { limit: 1 }
  );
  console.log('Invoice:', inv);
}

await prisma.$disconnect();
