/**
 * Fix the 2 failed Odoo orders:
 * #1763 (S14279) — "no quantities reserved" on delivery
 * #1689 (S14428) — "partner cannot follow twice" on some operation
 */
import { createAppServices } from '../app.js';
import { shipmentRepository } from '../services/shipmentRepository.js';
import { OdooClient } from '../odoo/odooClient.js';
import { prisma } from '../lib/prisma.js';

const { odooSyncService } = createAppServices();
if (!odooSyncService) throw new Error('Odoo not configured');

const odooClient = new OdooClient();

// ══════════════════════════════════════════════════════════════
// Helper: force-validate a stock.picking by setting qty_done on lines
// ══════════════════════════════════════════════════════════════
async function forceValidatePicking(pickingId: number): Promise<void> {
  // Get moves
  const moves = await odooClient.searchRead<{
    id: number; product_uom_qty: number; quantity: number;
    move_line_ids: number[]; product_id: [number, string];
    product_uom: [number, string]; location_id: [number, string]; location_dest_id: [number, string];
  }>(
    'stock.move',
    [['picking_id', '=', pickingId], ['state', 'not in', ['done', 'cancel']]],
    ['product_uom_qty', 'quantity', 'move_line_ids', 'product_id', 'product_uom', 'location_id', 'location_dest_id'],
    { limit: 50 }
  );

  for (const move of moves) {
    const qty = Number(move.product_uom_qty || 1);
    console.log(`    Move ${move.id}: ${move.product_id[1]} × ${qty}`);

    if (!move.move_line_ids?.length) {
      // Create move line
      const productId = Array.isArray(move.product_id) ? move.product_id[0] : move.product_id;
      const uomId = Array.isArray(move.product_uom) ? move.product_uom[0] : move.product_uom;
      const locId = Array.isArray(move.location_id) ? move.location_id[0] : move.location_id;
      const locDestId = Array.isArray(move.location_dest_id) ? move.location_dest_id[0] : move.location_dest_id;
      await odooClient.create('stock.move.line', {
        picking_id: pickingId,
        move_id: move.id,
        product_id: productId,
        product_uom_id: uomId,
        location_id: locId,
        location_dest_id: locDestId,
        quantity: qty
      });
      console.log(`      → created move line with qty=${qty}`);
    } else {
      // Update existing lines
      await odooClient.executeKw('stock.move.line', 'write', [move.move_line_ids, { quantity: qty }]);
      console.log(`      → updated ${move.move_line_ids.length} move line(s) qty_done=${qty}`);
    }

    // Also write on the move itself
    await odooClient.executeKw('stock.move', 'write', [[move.id], { quantity: qty, picked: true }]);
  }

  // Force validate
  const result = await odooClient.call<unknown>('stock.picking', 'button_validate', [[pickingId]]);
  // Handle wizard if returned
  if (result && typeof result === 'object' && (result as any).type === 'ir.actions.act_window') {
    // It's a wizard — try immediate transfer
    const wiz = await odooClient.create('stock.immediate.transfer', { pick_ids: [[6, 0, [pickingId]]] });
    await odooClient.call('stock.immediate.transfer', 'process', [[wiz]]);
    console.log(`      → wizard processed (immediate transfer)`);
  }
  console.log(`    ✅ Picking ${pickingId} validated`);
}

// ══════════════════════════════════════════════════════════════
// Fix #1763 (S14279) — force delivery picking
// ══════════════════════════════════════════════════════════════
console.log('\n══ Fix #1763 (S14279) ══════════════════════════════');
try {
  // Find customer delivery pickings for S14279
  const pickings = await odooClient.searchRead<{
    id: number; name: string; state: string;
    location_dest_id: [number, string];
  }>(
    'stock.picking',
    [['origin', '=', 'S14279'], ['state', 'not in', ['done', 'cancel']]],
    ['name', 'state', 'location_dest_id'],
    { limit: 10 }
  );

  console.log(`  Found ${pickings.length} pending picking(s)`);
  for (const p of pickings) {
    const dest = Array.isArray(p.location_dest_id) ? p.location_dest_id[1] : '';
    console.log(`  Picking ${p.name} (${p.id}): state=${p.state} → ${dest}`);
    await forceValidatePicking(p.id);
  }

  if (pickings.length === 0) {
    console.log('  ℹ️  No pending pickings — may already be done. Trying delivery confirm directly...');
    await odooSyncService.confirmSalesOrderDelivery(14279);
    console.log('  ✅ Delivery confirmed');
  }

  // Mark as delivery-confirmed in DB
  await prisma.shipmentRecord.update({
    where: { shopifyOrderId: '10573911261476' },
    data: { odooSyncStatus: 'delivery-confirmed', odooLastError: null, odooSyncedAt: new Date() }
  });
  console.log('  ✅ DB updated: delivery-confirmed');
} catch (e: any) {
  console.log(`  ❌ Error: ${e.message}`);
}

// ══════════════════════════════════════════════════════════════
// Fix #1689 (S14428) — remove duplicate followers then retry delivery
// ══════════════════════════════════════════════════════════════
console.log('\n══ Fix #1689 (S14428) ══════════════════════════════');
try {
  // Remove duplicate followers from the sale order
  const [so] = await odooClient.searchRead<{ id: number; message_follower_ids: number[] }>(
    'sale.order',
    [['id', '=', 14428]],
    ['message_follower_ids'],
    { limit: 1 }
  );

  if (so?.message_follower_ids?.length) {
    // Get follower records with partner info
    const followers = await odooClient.searchRead<{ id: number; partner_id: [number, string] }>(
      'mail.followers',
      [['id', 'in', so.message_follower_ids]],
      ['partner_id'],
      { limit: 100 }
    );

    // Find duplicates
    const seen = new Map<number, number[]>();
    for (const f of followers) {
      const partnerId = Array.isArray(f.partner_id) ? f.partner_id[0] : f.partner_id;
      if (!seen.has(partnerId)) seen.set(partnerId, []);
      seen.get(partnerId)!.push(f.id);
    }

    const dupeIds: number[] = [];
    for (const [partnerId, ids] of seen) {
      if (ids.length > 1) {
        // Keep first, remove rest
        dupeIds.push(...ids.slice(1));
        console.log(`  Partner ${partnerId}: ${ids.length} followers → removing ${ids.length - 1} duplicate(s)`);
      }
    }

    if (dupeIds.length > 0) {
      await odooClient.executeKw('mail.followers', 'unlink', [dupeIds]);
      console.log(`  ✅ Removed ${dupeIds.length} duplicate follower(s)`);
    } else {
      console.log('  ℹ️  No duplicate followers found');
    }
  }

  // Now retry delivery confirmation
  console.log('  Retrying confirmSalesOrderDelivery(14428)...');
  try {
    await odooSyncService.confirmSalesOrderDelivery(14428);
    await prisma.shipmentRecord.update({
      where: { shopifyOrderId: '10566660751652' },
      data: { odooSyncStatus: 'delivery-confirmed', odooLastError: null, odooSyncedAt: new Date() }
    });
    console.log('  ✅ Delivery confirmed + DB updated');
  } catch (e2: any) {
    console.log(`  ⚠️  Delivery confirm still failed: ${e2.message}`);
    // Maybe the error was in a different stage — check all pickings
    const pickings = await odooClient.searchRead<{ id: number; name: string; state: string }>(
      'stock.picking',
      [['origin', '=', 'S14428'], ['state', 'not in', ['done', 'cancel']]],
      ['name', 'state'],
      { limit: 10 }
    );
    console.log(`  Found ${pickings.length} pending picking(s)`);
    for (const p of pickings) {
      await forceValidatePicking(p.id);
    }
    await prisma.shipmentRecord.update({
      where: { shopifyOrderId: '10566660751652' },
      data: { odooSyncStatus: 'delivery-confirmed', odooLastError: null, odooSyncedAt: new Date() }
    });
    console.log('  ✅ DB updated: delivery-confirmed');
  }
} catch (e: any) {
  console.log(`  ❌ Error: ${e.message}`);
}

await prisma.$disconnect();
console.log('\nDone.');
