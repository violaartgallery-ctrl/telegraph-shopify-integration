/**
 * RECOVERY (controlled write): move the SAFE_RECOVERY orphans from
 * `sales-order-created` to `odoo-stock-pending`.
 *
 * Re-uses the same audit logic and applies recovery only to records
 * still matching SAFE_RECOVERY at write time.
 */
import { prisma } from '../lib/prisma.js';
import { OdooClient } from '../odoo/odooClient.js';

const ALREADY_RECOVERED = new Set(['#2036', '#2038', '#2040', '#2042', '#2043', '#2044', '#2047', '#2048', '#2049', '#2051']);
const HARD_EXCLUDE_COLLECTION = new Set(['collected', 'returned', 'returned-settled', 'payment-review']);
const HARD_EXCLUDE_ORDERS = new Set(['#1880', '#1920', '#1942']);

const odoo = new OdooClient();

interface SaleOrderRow {
  [key: string]: unknown;
  id: number;
  name?: string;
  state?: string;
  invoice_ids?: number[];
  picking_ids?: number[];
  partner_id?: [number, string] | false;
  order_line?: number[];
}

interface PickingRow {
  [key: string]: unknown;
  id: number;
  state?: string;
  picking_type_code?: string;
}

interface MOrderRow {
  [key: string]: unknown;
  id: number;
  state?: string;
}

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  RECOVERY — remaining SAFE V7 orphans');
console.log('══════════════════════════════════════════════════════════════\n');

const candidates = await prisma.shipmentRecord.findMany({
  where: {
    odooSyncStatus: 'sales-order-created',
    accurateShipmentId: { not: null },
    accurateShipmentCode: { not: null },
    odooSaleOrderId: { not: null },
    odooInvoiceId: null,
    odooPaymentId: null,
    odooSalePaymentId: null
  },
  select: {
    id: true,
    shopifyOrderId: true,
    shopifyOrderName: true,
    odooSaleOrderId: true,
    odooSaleOrderName: true,
    accurateStatus: true,
    accurateIsTerminal: true,
    collectionStatus: true,
    customerDue: true
  }
});

interface SafeRow { id: number; shopifyOrderId: string; shopifyOrderName: string; saleOrderName?: string }
const safeRows: SafeRow[] = [];
const excluded: { name: string; reason: string }[] = [];

for (const r of candidates) {
  const orderName = r.shopifyOrderName ?? r.shopifyOrderId;

  if (ALREADY_RECOVERED.has(orderName)) { excluded.push({ name: orderName, reason: 'already-recovered' }); continue; }
  if (HARD_EXCLUDE_ORDERS.has(orderName)) { excluded.push({ name: orderName, reason: 'explicit-exclude' }); continue; }
  if (r.collectionStatus && HARD_EXCLUDE_COLLECTION.has(r.collectionStatus)) { excluded.push({ name: orderName, reason: 'collectionStatus=' + r.collectionStatus }); continue; }
  if (r.accurateIsTerminal === true) { excluded.push({ name: orderName, reason: 'telegraph-terminal' }); continue; }
  if (r.customerDue !== null && Number(r.customerDue) < 0) { excluded.push({ name: orderName, reason: 'negative-customerDue' }); continue; }

  // Inspect Odoo.
  const [so] = await odoo.searchRead<SaleOrderRow>(
    'sale.order',
    [['id', '=', r.odooSaleOrderId]],
    ['name', 'state', 'invoice_ids', 'picking_ids', 'partner_id', 'order_line'],
    { limit: 1 }
  );
  if (!so) { excluded.push({ name: orderName, reason: 'odoo-so-missing' }); continue; }
  if (so.state !== 'sale') { excluded.push({ name: orderName, reason: 'so-state=' + so.state }); continue; }
  if ((so.invoice_ids?.length ?? 0) > 0) { excluded.push({ name: orderName, reason: 'has-invoice-in-odoo' }); continue; }
  if (!so.partner_id || !so.order_line?.length) { excluded.push({ name: orderName, reason: 'so-incomplete' }); continue; }

  // Check there's work left for the queue.
  let hasWorkLeft = false;
  const pickingIds = so.picking_ids ?? [];
  if (pickingIds.length > 0) {
    const pickings = await odoo.searchRead<PickingRow>(
      'stock.picking',
      [['id', 'in', pickingIds]],
      ['state', 'picking_type_code'],
      { limit: pickingIds.length }
    );
    hasWorkLeft = pickings.some((p) => p.state !== 'done' && p.state !== 'cancel');
  }
  if (!hasWorkLeft && so.name) {
    const mos = await odoo.searchRead<MOrderRow>(
      'mrp.production',
      [['origin', '=', so.name]],
      ['state'],
      { limit: 50 }
    );
    hasWorkLeft = mos.some((m) => m.state !== 'done' && m.state !== 'cancel');
  }
  if (!hasWorkLeft) { excluded.push({ name: orderName, reason: 'nothing-to-do' }); continue; }

  safeRows.push({ id: r.id, shopifyOrderId: r.shopifyOrderId, shopifyOrderName: orderName, saleOrderName: r.odooSaleOrderName ?? undefined });
}

console.log('Inspected: ' + candidates.length);
console.log('Excluded:  ' + excluded.length);
console.log('Safe:      ' + safeRows.length);

if (safeRows.length === 0) {
  console.log('\nNo safe rows to recover. Exiting.');
  await prisma.$disconnect();
  process.exit(0);
}

console.log('\nApplying recovery (strict WHERE per row)...\n');

const results: { name: string; ok: boolean; error?: string }[] = [];
for (const r of safeRows) {
  try {
    const upd = await prisma.shipmentRecord.updateMany({
      where: {
        id: r.id,
        odooSyncStatus: 'sales-order-created',
        accurateShipmentId: { not: null },
        odooSaleOrderId: { not: null },
        odooInvoiceId: null,
        odooPaymentId: null,
        odooSalePaymentId: null
      },
      data: {
        odooSyncStatus: 'odoo-stock-pending',
        odooLastError: null,
        odooAttemptCount: 0,
        odooRetryAt: null,
        odooSyncedAt: new Date()
      }
    });
    if (upd.count !== 1) {
      results.push({ name: r.shopifyOrderName, ok: false, error: 'updateMany count=' + upd.count });
      console.log('  ❌ ' + r.shopifyOrderName + ' — preconditions failed at write');
    } else {
      results.push({ name: r.shopifyOrderName, ok: true });
      console.log('  ✅ ' + r.shopifyOrderName + ' (SO=' + r.saleOrderName + ') → odoo-stock-pending');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name: r.shopifyOrderName, ok: false, error: msg });
    console.log('  ❌ ' + r.shopifyOrderName + ' — ' + msg);
  }
}

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  Recovery Summary');
console.log('══════════════════════════════════════════════════════════════');
console.log('  ✅ Recovered: ' + results.filter((r) => r.ok).length);
console.log('  ❌ Failed:    ' + results.filter((r) => !r.ok).length);
console.log('  ⏭️  Excluded:  ' + excluded.length);

await prisma.$disconnect();
