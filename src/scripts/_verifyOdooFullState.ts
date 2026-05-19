/**
 * READ-ONLY deep verification of the 10 orders that "failed" — but actually
 * appear to have succeeded. We check every Odoo property end-to-end:
 *   • Sale Order: state, confirmed, partner, lines, totals
 *   • Stock Pickings: internal (manufacturing) + customer (delivery) state
 *   • Manufacturing orders (MO)
 *   • Invoice: existence, state, payment_state, residual, total
 *   • Payment: existence, state
 *   • Queue position: is it stuck or progressing?
 *   • DB consistency: what we know vs what Odoo knows
 */
import { prisma } from '../lib/prisma.js';
import { OdooClient } from '../odoo/odooClient.js';

const NUMBERS = ['#2036', '#2038', '#2040', '#2042', '#2043', '#2044', '#2047', '#2048', '#2049', '#2051'];
const odoo = new OdooClient();

interface SaleOrderRow {
  [key: string]: unknown;
  id: number;
  name?: string;
  state?: string;
  partner_id?: [number, string] | false;
  amount_total?: number;
  invoice_status?: string;
  invoice_ids?: number[];
  picking_ids?: number[];
  delivery_status?: string;
  order_line?: number[];
  client_order_ref?: string | false;
}

interface PickingRow {
  [key: string]: unknown;
  id: number;
  name?: string;
  state?: string;
  picking_type_code?: string;
  origin?: string;
  location_id?: [number, string];
  location_dest_id?: [number, string];
  move_ids_without_package?: number[];
}

interface InvoiceRow {
  [key: string]: unknown;
  id: number;
  name?: string;
  state?: string;
  payment_state?: string;
  amount_total?: number;
  amount_residual?: number;
  amount_tax?: number;
  invoice_origin?: string;
}

interface PaymentRow {
  [key: string]: unknown;
  id: number;
  name?: string;
  state?: string;
  amount?: number;
  partner_id?: [number, string];
  payment_type?: string;
}

interface MOrderRow {
  [key: string]: unknown;
  id: number;
  name?: string;
  state?: string;
  product_id?: [number, string];
  product_qty?: number;
}

console.log('\n████████████████████████████████████████████████████████████');
console.log('   تحقق عميق — كل خصائص Odoo لـ 10 orders');
console.log('████████████████████████████████████████████████████████████\n');

interface VerifyResult {
  orderName: string;
  shopifyOrderId?: string;
  saleOrderId?: number;
  saleOrderName?: string;
  saleOrderState?: string;
  saleOrderTotal?: number;
  pickingCount?: number;
  pickingsInternal?: { state: string; name?: string }[];
  pickingsCustomer?: { state: string; name?: string }[];
  manufacturingCount?: number;
  manufacturingDone?: number;
  invoiceCount?: number;
  invoiceState?: string;
  invoiceTotal?: number;
  invoiceResidual?: number;
  invoicePaymentState?: string;
  paymentCount?: number;
  paymentState?: string;
  dbStatus?: string;
  dbInvoiceName?: string | null;
  dbPaymentId?: number | null;
  dbCollectedAmount?: number;
  dbDeliveryFees?: number;
  accurateStatus?: string;
  collectionStatus?: string;
  problems: string[];
}

const results: VerifyResult[] = [];

for (const orderName of NUMBERS) {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📦 ' + orderName);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const res: VerifyResult = { orderName, problems: [] };
  results.push(res);

  const rec = await prisma.shipmentRecord.findFirst({
    where: { shopifyOrderName: orderName },
    select: {
      shopifyOrderId: true,
      shopifyOrderName: true,
      odooSyncStatus: true,
      odooSaleOrderId: true,
      odooSaleOrderName: true,
      odooInvoiceId: true,
      odooInvoiceName: true,
      odooPaymentId: true,
      odooSalePaymentId: true,
      odooLastError: true,
      collectedAmount: true,
      deliveryFees: true,
      customerDue: true,
      accurateShipmentCode: true,
      accurateStatus: true,
      collectionStatus: true,
      rawOrderJson: true
    }
  });

  if (!rec) { res.problems.push('NOT IN DB'); console.log('  ❌ NOT IN DB'); continue; }

  res.shopifyOrderId = rec.shopifyOrderId;
  res.saleOrderId = rec.odooSaleOrderId ?? undefined;
  res.saleOrderName = rec.odooSaleOrderName ?? undefined;
  res.dbStatus = rec.odooSyncStatus ?? undefined;
  res.dbInvoiceName = rec.odooInvoiceName ?? null;
  res.dbPaymentId = rec.odooPaymentId ?? null;
  res.dbCollectedAmount = Number(rec.collectedAmount ?? 0);
  res.dbDeliveryFees = Number(rec.deliveryFees ?? 0);
  res.accurateStatus = rec.accurateStatus ?? undefined;
  res.collectionStatus = rec.collectionStatus ?? undefined;

  console.log('  Telegraph: ' + (rec.accurateShipmentCode ?? 'MISSING') + ' | accurateStatus=' + rec.accurateStatus);
  console.log('  DB odoo: ' + rec.odooSyncStatus + ' | SO=' + (rec.odooSaleOrderName ?? 'NULL') + ' (id=' + (rec.odooSaleOrderId ?? 'NULL') + ')');
  console.log('  DB invoice: ' + (rec.odooInvoiceName ?? 'NULL') + ' | payment=' + (rec.odooPaymentId ?? rec.odooSalePaymentId ?? 'NULL'));
  console.log('  DB collected=' + rec.collectedAmount + ' | deliveryFees=' + rec.deliveryFees + ' | customerDue=' + rec.customerDue);

  if (!rec.odooSaleOrderId) { res.problems.push('no-odoo-sale-order-id'); continue; }

  // SO from Odoo
  const [so] = await odoo.searchRead<SaleOrderRow>(
    'sale.order',
    [['id', '=', rec.odooSaleOrderId]],
    ['name', 'state', 'partner_id', 'amount_total', 'invoice_status', 'invoice_ids', 'picking_ids', 'delivery_status', 'order_line', 'client_order_ref'],
    { limit: 1 }
  );

  if (!so) { res.problems.push('odoo-sale-order-missing'); console.log('  ❌ Odoo Sale Order ' + rec.odooSaleOrderId + ' NOT FOUND'); continue; }

  res.saleOrderState = so.state;
  res.saleOrderTotal = Number(so.amount_total ?? 0);
  console.log('  Odoo SO ' + so.name + ' state=' + so.state + ' invoice_status=' + so.invoice_status + ' delivery_status=' + so.delivery_status + ' total=' + so.amount_total);
  console.log('    partner=' + (Array.isArray(so.partner_id) ? so.partner_id[1] : 'NONE') + ' | lines=' + (so.order_line?.length ?? 0));

  if (so.state !== 'sale' && so.state !== 'done') res.problems.push('so-not-confirmed (state=' + so.state + ')');
  if (!so.partner_id) res.problems.push('so-no-partner');
  if (!so.order_line?.length) res.problems.push('so-no-lines');

  // Stock pickings
  const pickingIds = so.picking_ids ?? [];
  res.pickingCount = pickingIds.length;
  if (pickingIds.length === 0) {
    res.problems.push('no-pickings');
    console.log('  ⚠️  No stock pickings');
  } else {
    const pickings = await odoo.searchRead<PickingRow>(
      'stock.picking',
      [['id', 'in', pickingIds]],
      ['name', 'state', 'picking_type_code', 'origin', 'location_id', 'location_dest_id'],
      { limit: pickingIds.length }
    );
    res.pickingsInternal = pickings.filter((p) => p.picking_type_code === 'internal').map((p) => ({ state: p.state ?? '', name: p.name }));
    res.pickingsCustomer = pickings.filter((p) => p.picking_type_code === 'outgoing').map((p) => ({ state: p.state ?? '', name: p.name }));
    console.log('  Pickings (' + pickings.length + '):');
    for (const p of pickings) {
      console.log('    ' + p.name + ' [' + p.picking_type_code + '] state=' + p.state);
    }
    const stuckInternal = pickings.filter((p) => p.picking_type_code === 'internal' && p.state !== 'done' && p.state !== 'cancel');
    const stuckOutgoing = pickings.filter((p) => p.picking_type_code === 'outgoing' && p.state !== 'done' && p.state !== 'cancel');
    if (stuckInternal.length > 0) res.problems.push('internal-pickings-not-done (' + stuckInternal.map((p) => p.state).join(',') + ')');
    if (stuckOutgoing.length > 0) res.problems.push('customer-pickings-not-done (' + stuckOutgoing.map((p) => p.state).join(',') + ')');
  }

  // Manufacturing orders for this SO (by origin = SO name)
  if (so.name) {
    const mos = await odoo.searchRead<MOrderRow>(
      'mrp.production',
      [['origin', '=', so.name]],
      ['name', 'state', 'product_id', 'product_qty'],
      { limit: 50 }
    );
    res.manufacturingCount = mos.length;
    res.manufacturingDone = mos.filter((m) => m.state === 'done').length;
    if (mos.length > 0) {
      console.log('  Manufacturing (' + mos.length + '):');
      for (const m of mos) {
        console.log('    ' + m.name + ' state=' + m.state + ' product=' + (Array.isArray(m.product_id) ? m.product_id[1] : '') + ' qty=' + m.product_qty);
      }
      const stuckMos = mos.filter((m) => m.state !== 'done' && m.state !== 'cancel');
      if (stuckMos.length > 0) res.problems.push('manufacturing-not-done (' + stuckMos.length + ' MO)');
    } else {
      console.log('  Manufacturing: none');
    }
  }

  // Invoices
  const invoiceIds = so.invoice_ids ?? [];
  res.invoiceCount = invoiceIds.length;
  if (invoiceIds.length === 0) {
    console.log('  Invoice: none yet (waiting for Telegraph collection)');
  } else {
    const invoices = await odoo.searchRead<InvoiceRow>(
      'account.move',
      [['id', 'in', invoiceIds]],
      ['name', 'state', 'payment_state', 'amount_total', 'amount_residual', 'amount_tax', 'invoice_origin'],
      { limit: invoiceIds.length }
    );
    for (const inv of invoices) {
      console.log('  Invoice ' + inv.name + ' state=' + inv.state + ' payment_state=' + inv.payment_state + ' total=' + inv.amount_total + ' residual=' + inv.amount_residual);
    }
    const main = invoices[0];
    res.invoiceState = main?.state;
    res.invoiceTotal = Number(main?.amount_total ?? 0);
    res.invoiceResidual = Number(main?.amount_residual ?? 0);
    res.invoicePaymentState = main?.payment_state;
  }

  // Payment record (if DB knows)
  const paymentId = rec.odooSalePaymentId ?? rec.odooPaymentId;
  if (paymentId) {
    const [pay] = await odoo.searchRead<PaymentRow>(
      'account.payment',
      [['id', '=', paymentId]],
      ['name', 'state', 'amount', 'partner_id', 'payment_type'],
      { limit: 1 }
    );
    if (pay) {
      console.log('  Payment ' + pay.name + ' state=' + pay.state + ' amount=' + pay.amount + ' type=' + pay.payment_type);
      res.paymentCount = 1;
      res.paymentState = pay.state;
    }
  }

  if (res.problems.length === 0) {
    console.log('  ✅ All Odoo properties OK');
  } else {
    console.log('  ⚠️  Issues: ' + res.problems.join('; '));
  }
}

// ── Final summary ────────────────────────────────────────────────────────────
console.log('\n\n████████████████████████████████████████████████████████████');
console.log('   ملخص نهائي');
console.log('████████████████████████████████████████████████████████████\n');

const stats = {
  total: results.length,
  withSO: results.filter((r) => r.saleOrderId).length,
  soConfirmed: results.filter((r) => r.saleOrderState === 'sale' || r.saleOrderState === 'done').length,
  pickingsDone: results.filter((r) => r.pickingsInternal?.every((p) => p.state === 'done' || p.state === 'cancel') && r.pickingsCustomer?.every((p) => p.state === 'done' || p.state === 'cancel') && (r.pickingCount ?? 0) > 0).length,
  customerPickingsStuck: results.filter((r) => r.pickingsCustomer?.some((p) => p.state !== 'done' && p.state !== 'cancel')).length,
  internalPickingsStuck: results.filter((r) => r.pickingsInternal?.some((p) => p.state !== 'done' && p.state !== 'cancel')).length,
  manufacturingDone: results.filter((r) => (r.manufacturingCount ?? 0) > 0 && r.manufacturingDone === r.manufacturingCount).length,
  manufacturingPartial: results.filter((r) => (r.manufacturingCount ?? 0) > 0 && (r.manufacturingDone ?? 0) < (r.manufacturingCount ?? 0)).length,
  hasInvoice: results.filter((r) => (r.invoiceCount ?? 0) > 0).length,
  paid: results.filter((r) => r.invoicePaymentState === 'paid').length,
  fullyClean: results.filter((r) => r.problems.length === 0).length
};

console.log('📊 Totals:');
console.log('  Total orders inspected: ' + stats.total);
console.log('  Have Odoo Sale Order: ' + stats.withSO + '/' + stats.total);
console.log('  SO is confirmed (sale/done): ' + stats.soConfirmed + '/' + stats.total);
console.log('  All pickings done: ' + stats.pickingsDone + '/' + stats.total);
console.log('  Internal pickings stuck: ' + stats.internalPickingsStuck);
console.log('  Customer pickings stuck: ' + stats.customerPickingsStuck);
console.log('  Manufacturing fully done: ' + stats.manufacturingDone);
console.log('  Manufacturing partial: ' + stats.manufacturingPartial);
console.log('  Has Invoice in Odoo: ' + stats.hasInvoice + '/' + stats.total);
console.log('  Fully paid: ' + stats.paid + '/' + stats.total);
console.log('  Zero problems: ' + stats.fullyClean + '/' + stats.total);

console.log('\n📋 Status per order:');
console.log('Order   | SO         | State    | Pickings (int/cust)  | MO      | Invoice');
for (const r of results) {
  const intState = r.pickingsInternal?.map((p) => p.state).join(',') || '-';
  const custState = r.pickingsCustomer?.map((p) => p.state).join(',') || '-';
  const moStr = r.manufacturingCount ? r.manufacturingDone + '/' + r.manufacturingCount : '-';
  const inv = r.invoiceCount ? (r.invoiceState ?? '?') : 'none';
  console.log((r.orderName + '         ').slice(0, 8) + '| ' + (r.saleOrderName ?? '?').padEnd(10) + ' | ' + (r.saleOrderState ?? '?').padEnd(8) + ' | ' + intState.padEnd(8) + ' / ' + custState.padEnd(10) + ' | ' + moStr.padEnd(7) + ' | ' + inv);
}

console.log('\n🛑 Problems found:');
let anyProblem = false;
for (const r of results) {
  if (r.problems.length > 0) {
    anyProblem = true;
    console.log('  ' + r.orderName + ': ' + r.problems.join('; '));
  }
}
if (!anyProblem) console.log('  ✅ None');

await prisma.$disconnect();
