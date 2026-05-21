/**
 * Test if button_draft works on one of the current partial invoices.
 * If it errors, we know the reset path can't work because of COGS-linked entries.
 */
import { OdooClient } from '../odoo/odooClient.js';
const odoo = new OdooClient();

// Try the newest partial: INV/2026/03974
const [inv] = await odoo.searchRead<{ id: number; name?: string; state?: string; payment_state?: string; amount_total?: number; amount_residual?: number }>(
  'account.move',
  [['name', '=', 'INV/2026/03974']],
  ['name', 'state', 'payment_state', 'amount_total', 'amount_residual'],
  { limit: 1 }
);
console.log('Before:', inv);

try {
  await odoo.call('account.move', 'button_draft', [[inv.id]]);
  const [after] = await odoo.searchRead<{ id: number; name?: string; state?: string }>(
    'account.move',
    [['id', '=', inv.id]],
    ['state'],
    { limit: 1 }
  );
  console.log('After button_draft:', after?.state);
  // If we got here without error, re-post it so we don't leave it broken.
  if (after?.state === 'draft') {
    console.log('Re-posting to restore original state...');
    await odoo.call('account.move', 'action_post', [[inv.id]]);
    const [final] = await odoo.searchRead<{ id: number; state?: string }>('account.move', [['id', '=', inv.id]], ['state'], { limit: 1 });
    console.log('Restored:', final?.state);
  }
} catch (err) {
  console.log('button_draft FAILED:', err instanceof Error ? err.message : String(err));
}
