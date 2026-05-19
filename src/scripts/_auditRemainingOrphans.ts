/**
 * READ-ONLY: audit the REMAINING V7 orphans (excluding the already-recovered 10).
 *
 * For each candidate: inspect Odoo (SO state, invoices, MOs, pickings) and
 * classify as SAFE_RECOVERY or MANUAL_REVIEW.
 *
 * Writes report to VIOLA_REMAINING_V7_ORPHANS_AUDIT.md.
 *
 * No writes anywhere.
 */
import { writeFileSync } from 'node:fs';
import { prisma } from '../lib/prisma.js';
import { OdooClient } from '../odoo/odooClient.js';

const ALREADY_RECOVERED = new Set(['#2036', '#2038', '#2040', '#2042', '#2043', '#2044', '#2047', '#2048', '#2049', '#2051']);

// Hard exclusions per task brief.
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
  amount_total?: number;
  partner_id?: [number, string] | false;
  order_line?: number[];
}

interface PickingRow {
  [key: string]: unknown;
  id: number;
  name?: string;
  state?: string;
  picking_type_code?: string;
}

interface MOrderRow {
  [key: string]: unknown;
  id: number;
  name?: string;
  state?: string;
}

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  Remaining V7 Orphans Audit (read-only)');
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
    odooSyncStatus: true,
    odooSaleOrderId: true,
    odooSaleOrderName: true,
    odooInvoiceId: true,
    odooPaymentId: true,
    odooSalePaymentId: true,
    accurateShipmentCode: true,
    accurateStatus: true,
    accurateIsTerminal: true,
    collectionStatus: true,
    createdAt: true,
    customerDue: true
  }
});

console.log('Raw DB candidates (orphan-shape, excluding already-paid/collected): ' + candidates.length);

interface InspectedCandidate {
  recordId: number;
  shopifyOrderName: string;
  shopifyOrderId: string;
  telegraphCode: string | null;
  accurateStatus: string | null;
  collectionStatus: string | null;
  saleOrderId: number;
  saleOrderName: string | null;
  saleOrderState?: string;
  invoiceCount?: number;
  manufacturingTotal?: number;
  manufacturingDone?: number;
  internalPickingTotal?: number;
  internalPickingDone?: number;
  customerPickingTotal?: number;
  customerPickingDone?: number;
  classification: 'SAFE_RECOVERY' | 'MANUAL_REVIEW';
  excludeReasons: string[];
  manualReasons: string[];
  ageHours: number;
}

const inspected: InspectedCandidate[] = [];
const now = Date.now();

for (const r of candidates) {
  const orderName = r.shopifyOrderName ?? r.shopifyOrderId;
  const item: InspectedCandidate = {
    recordId: r.id,
    shopifyOrderName: orderName,
    shopifyOrderId: r.shopifyOrderId,
    telegraphCode: r.accurateShipmentCode,
    accurateStatus: r.accurateStatus,
    collectionStatus: r.collectionStatus,
    saleOrderId: r.odooSaleOrderId!,
    saleOrderName: r.odooSaleOrderName,
    classification: 'SAFE_RECOVERY',
    excludeReasons: [],
    manualReasons: [],
    ageHours: Number(((now - r.createdAt.getTime()) / 3600_000).toFixed(1))
  };

  // Hard exclusions.
  if (ALREADY_RECOVERED.has(orderName)) item.excludeReasons.push('already-recovered');
  if (HARD_EXCLUDE_ORDERS.has(orderName)) item.excludeReasons.push('explicit-exclude');
  if (r.collectionStatus && HARD_EXCLUDE_COLLECTION.has(r.collectionStatus)) {
    item.excludeReasons.push('collectionStatus=' + r.collectionStatus);
  }
  if (r.accurateIsTerminal === true) item.excludeReasons.push('telegraph-terminal');
  if (r.customerDue !== null && Number(r.customerDue) < 0) item.excludeReasons.push('negative-customerDue');

  if (item.excludeReasons.length > 0) {
    item.classification = 'MANUAL_REVIEW';
    item.manualReasons.push(...item.excludeReasons);
    inspected.push(item);
    continue;
  }

  // Inspect Odoo SO.
  const [so] = await odoo.searchRead<SaleOrderRow>(
    'sale.order',
    [['id', '=', r.odooSaleOrderId]],
    ['name', 'state', 'invoice_ids', 'picking_ids', 'amount_total', 'partner_id', 'order_line'],
    { limit: 1 }
  );

  if (!so) {
    item.manualReasons.push('odoo-sale-order-missing');
    item.classification = 'MANUAL_REVIEW';
    inspected.push(item);
    continue;
  }

  item.saleOrderState = so.state;
  item.invoiceCount = so.invoice_ids?.length ?? 0;

  if (so.state !== 'sale') item.manualReasons.push('so-state=' + so.state);
  if ((so.invoice_ids?.length ?? 0) > 0) item.manualReasons.push('has-invoice-in-odoo');
  if (!so.partner_id) item.manualReasons.push('so-no-partner');
  if (!so.order_line?.length) item.manualReasons.push('so-no-lines');

  // Pickings.
  const pickingIds = so.picking_ids ?? [];
  if (pickingIds.length === 0) {
    item.manualReasons.push('no-pickings');
  } else {
    const pickings = await odoo.searchRead<PickingRow>(
      'stock.picking',
      [['id', 'in', pickingIds]],
      ['name', 'state', 'picking_type_code'],
      { limit: pickingIds.length }
    );
    const internals = pickings.filter((p) => p.picking_type_code === 'internal');
    const customers = pickings.filter((p) => p.picking_type_code === 'outgoing');
    item.internalPickingTotal = internals.length;
    item.internalPickingDone = internals.filter((p) => p.state === 'done' || p.state === 'cancel').length;
    item.customerPickingTotal = customers.length;
    item.customerPickingDone = customers.filter((p) => p.state === 'done' || p.state === 'cancel').length;
  }

  // Manufacturing.
  if (so.name) {
    const mos = await odoo.searchRead<MOrderRow>(
      'mrp.production',
      [['origin', '=', so.name]],
      ['name', 'state'],
      { limit: 50 }
    );
    item.manufacturingTotal = mos.length;
    item.manufacturingDone = mos.filter((m) => m.state === 'done' || m.state === 'cancel').length;
  }

  // Final SAFE_RECOVERY rule:
  // SO state=sale, no invoice, has partner + lines, at least one stage to do.
  if (item.manualReasons.length === 0) {
    const hasWorkLeft =
      (item.manufacturingTotal ?? 0) > (item.manufacturingDone ?? 0) ||
      (item.internalPickingTotal ?? 0) > (item.internalPickingDone ?? 0) ||
      (item.customerPickingTotal ?? 0) > (item.customerPickingDone ?? 0);
    if (!hasWorkLeft) {
      item.manualReasons.push('nothing-to-do');
      item.classification = 'MANUAL_REVIEW';
    } else {
      item.classification = 'SAFE_RECOVERY';
    }
  } else {
    item.classification = 'MANUAL_REVIEW';
  }

  inspected.push(item);
  process.stdout.write('.');
}

console.log('\n\nClassification done.\n');

const safe = inspected.filter((i) => i.classification === 'SAFE_RECOVERY');
const manual = inspected.filter((i) => i.classification === 'MANUAL_REVIEW');

console.log('Total inspected: ' + inspected.length);
console.log('  SAFE_RECOVERY: ' + safe.length);
console.log('  MANUAL_REVIEW: ' + manual.length);

// Markdown.
const md: string[] = [];
md.push('# VIOLA — Remaining V7 Orphans Audit');
md.push('');
md.push('**Generated:** ' + new Date().toISOString());
md.push('');
md.push('## Summary');
md.push('');
md.push('| Group | Count |');
md.push('|---|---:|');
md.push('| Inspected (after DB filter) | ' + inspected.length + ' |');
md.push('| ✅ SAFE_RECOVERY | ' + safe.length + ' |');
md.push('| ⚠️ MANUAL_REVIEW | ' + manual.length + ' |');
md.push('');
md.push('## Filter applied');
md.push('');
md.push('```');
md.push('DB filter:');
md.push('  odooSyncStatus = sales-order-created');
md.push('  accurateShipmentId NOT NULL');
md.push('  accurateShipmentCode NOT NULL');
md.push('  odooSaleOrderId NOT NULL');
md.push('  odooInvoiceId IS NULL');
md.push('  odooPaymentId IS NULL');
md.push('  odooSalePaymentId IS NULL');
md.push('');
md.push('Hard exclusions:');
md.push('  - already-recovered 10 orders');
md.push('  - explicit exclude: #1880, #1920, #1942');
md.push('  - collectionStatus in (collected, returned, returned-settled, payment-review)');
md.push('  - accurateIsTerminal=true');
md.push('  - customerDue < 0');
md.push('');
md.push('SAFE_RECOVERY also requires (verified live in Odoo):');
md.push('  - sale.order state = "sale"');
md.push('  - no invoices on the SO');
md.push('  - partner + lines present');
md.push('  - at least one MO/picking still incomplete (work left for the queue)');
md.push('```');
md.push('');

const renderRows = (title: string, rows: InspectedCandidate[]) => {
  md.push('## ' + title + ' (' + rows.length + ')');
  md.push('');
  if (rows.length === 0) { md.push('_None_'); md.push(''); return; }
  md.push('| Order | Telegraph | SO | State | MO done | Internal done | Customer done | Age (h) | Notes |');
  md.push('|---|---|---|---|---|---|---|---:|---|');
  for (const c of rows.sort((a, b) => a.ageHours - b.ageHours)) {
    const mo = (c.manufacturingDone ?? 0) + '/' + (c.manufacturingTotal ?? 0);
    const ip = (c.internalPickingDone ?? 0) + '/' + (c.internalPickingTotal ?? 0);
    const cp = (c.customerPickingDone ?? 0) + '/' + (c.customerPickingTotal ?? 0);
    const notes = c.classification === 'SAFE_RECOVERY' ? '_queue will run stages 2→3_' : c.manualReasons.join('; ');
    md.push('| ' + c.shopifyOrderName + ' | ' + (c.telegraphCode ?? '-') + ' | ' + (c.saleOrderName ?? '-') + ' | ' + (c.saleOrderState ?? '-') + ' | ' + mo + ' | ' + ip + ' | ' + cp + ' | ' + c.ageHours + ' | ' + notes + ' |');
  }
  md.push('');
};

renderRows('SAFE_RECOVERY', safe);
renderRows('MANUAL_REVIEW', manual);

md.push('## Proposed action for SAFE_RECOVERY');
md.push('');
md.push('```');
md.push('UPDATE shipment_records');
md.push('SET odooSyncStatus = "odoo-stock-pending",');
md.push('    odooLastError = NULL,');
md.push('    odooRetryAt = NULL,');
md.push('    odooAttemptCount = 0,');
md.push('    odooSyncedAt = NOW()');
md.push('WHERE id = <recordId>');
md.push('  AND odooSyncStatus = "sales-order-created"');
md.push('  AND accurateShipmentId IS NOT NULL');
md.push('  AND odooSaleOrderId IS NOT NULL');
md.push('  AND odooInvoiceId IS NULL');
md.push('  AND odooPaymentId IS NULL');
md.push('  AND odooSalePaymentId IS NULL;');
md.push('```');
md.push('');
md.push('No writes to Odoo, Shopify, or Telegraph.');
md.push('The V7 queue picks them up on the next `process-odoo-queue` tick (every minute).');

writeFileSync('VIOLA_REMAINING_V7_ORPHANS_AUDIT.md', md.join('\n'));
console.log('\nReport saved: VIOLA_REMAINING_V7_ORPHANS_AUDIT.md\n');

// Console preview of SAFE_RECOVERY.
console.log('SAFE_RECOVERY preview (' + safe.length + '):');
for (const c of safe) {
  console.log('  ' + c.shopifyOrderName.padEnd(8) + ' | SO=' + (c.saleOrderName ?? '?').padEnd(8) + ' | MO ' + (c.manufacturingDone ?? 0) + '/' + (c.manufacturingTotal ?? 0) + ' | int ' + (c.internalPickingDone ?? 0) + '/' + (c.internalPickingTotal ?? 0) + ' | cust ' + (c.customerPickingDone ?? 0) + '/' + (c.customerPickingTotal ?? 0));
}

console.log('\nMANUAL_REVIEW (' + manual.length + ', not touched):');
for (const c of manual.slice(0, 10)) {
  console.log('  ' + c.shopifyOrderName.padEnd(8) + ' — ' + c.manualReasons.join('; '));
}

await prisma.$disconnect();
