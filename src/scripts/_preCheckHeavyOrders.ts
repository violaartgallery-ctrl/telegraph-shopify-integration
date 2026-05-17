/**
 * READ-ONLY pre-check for orders #1988, #1977, #2009
 * Checks: Telegraph location, SKUs, Odoo readiness, discounts, variants, bundles
 */
import { shopifyOrdersClient } from '../shopify/shopifyOrdersClient.js';
import { isOrderEligibleForShipment } from '../services/orderEligibility.js';
import { getTelegraphLocationSelection } from '../services/telegraphLocation.js';
import { createAppServices } from '../app.js';
import { shipmentRepository } from '../services/shipmentRepository.js';
import { prisma } from '../lib/prisma.js';

const TARGET_NAMES = ['#1988', '#1977', '#2009'];
const { odooSyncService } = createAppServices();

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║  PRE-CHECK — READ ONLY — #1988 / #1977 / #2009              ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

const orders = await shopifyOrdersClient.listRecentOrders(250);

for (const targetName of TARGET_NAMES) {
  const order = orders.find(o => o.name === targetName);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ORDER ${targetName}`);
  console.log('═'.repeat(60));

  if (!order) {
    console.log(`  ❌ NOT FOUND in last 250 orders — try fetching more`);
    continue;
  }

  // ── Basic info ──────────────────────────────────────────────
  const addr = order.shipping_address ?? order.billing_address;
  console.log(`  shopify id       : ${order.id}`);
  console.log(`  financial_status : ${order.financial_status}`);
  console.log(`  fulfillment_status: ${order.fulfillment_status ?? 'null'}`);
  console.log(`  tags             : ${order.tags || '(none)'}`);
  console.log(`  customer         : ${addr?.name ?? order.customer?.first_name + ' ' + order.customer?.last_name}`);
  console.log(`  phone            : ${addr?.phone ?? order.phone ?? order.customer?.phone ?? '❌ MISSING'}`);
  console.log(`  city/province    : ${addr?.city} / ${addr?.province}`);
  console.log(`  total_price      : ${order.total_price} ${order.currency}`);
  console.log(`  current_total    : ${order.current_total_price}`);
  console.log(`  total_outstanding: ${order.total_outstanding}`);
  console.log(`  gateway          : ${order.gateway}`);
  console.log(`  payment_gateways : ${order.payment_gateway_names?.join(', ') || '(none)'}`);
  console.log(`  test             : ${order.test}`);

  // ── Eligibility ──────────────────────────────────────────────
  const eligible = isOrderEligibleForShipment(order);
  console.log(`\n  ── Eligibility ──`);
  console.log(`  eligible         : ${eligible ? '✅ YES' : '❌ NO'}`);

  // ── Telegraph Location ────────────────────────────────────────
  console.log(`\n  ── Telegraph Location ──`);
  const loc = getTelegraphLocationSelection(order);
  if (loc) {
    console.log(`  governorate_id   : ✅ ${loc.governorateId} (${loc.governorate ?? '?'})`);
    console.log(`  area_id          : ✅ ${loc.areaId} (${loc.area ?? '?'})`);
  } else {
    console.log(`  governorate_id   : ⚠️  not set (will use city/province fallback)`);
    console.log(`  area_id          : ⚠️  not set (will use city/province fallback)`);
  }

  // ── Line items ───────────────────────────────────────────────
  console.log(`\n  ── Line Items (${order.line_items?.length ?? 0}) ──`);
  const activeItems = (order.line_items ?? []).filter(i => (i.current_quantity ?? i.quantity) > 0);
  let hasBundle = false;
  let hasVariant = false;
  let missingSkus: string[] = [];

  for (const item of activeItems) {
    const qty = item.current_quantity ?? item.quantity;
    const hasSku = Boolean(item.sku?.trim());
    const isVariant = Boolean(item.variant_title && item.variant_title !== 'Default Title');
    const isBundle = item.title?.toLowerCase().includes('bundle') ||
      item.title?.toLowerCase().includes('مجموعة') ||
      item.title?.toLowerCase().includes('باقة') ||
      item.properties?.some(p => p.name?.includes('_bundle') || p.name?.includes('bundle'));

    if (isVariant) hasVariant = true;
    if (isBundle) hasBundle = true;
    if (!hasSku) missingSkus.push(item.title);

    console.log(`  item: ${item.title}`);
    console.log(`    variant  : ${item.variant_title ?? 'Default Title'} ${isVariant ? '⚡ VARIANT' : ''}`);
    console.log(`    qty      : ${qty}`);
    console.log(`    price    : ${item.price}`);
    console.log(`    sku      : ${item.sku?.trim() || '❌ MISSING'}`);
    console.log(`    product_id: ${item.product_id}`);
    if (item.properties?.length) {
      console.log(`    properties: ${item.properties.map(p => `${p.name}=${p.value}`).join(', ')} ${isBundle ? '⚡ BUNDLE?' : ''}`);
    }
  }

  // ── Discounts ────────────────────────────────────────────────
  console.log(`\n  ── Discounts ──`);
  const totalDiscount = parseFloat(order.total_discounts ?? '0');
  if (totalDiscount > 0) {
    console.log(`  total_discounts  : ⚡ ${order.total_discounts} ${order.currency}`);
    const codes = order.discount_codes ?? [];
    for (const dc of codes) {
      console.log(`    code: ${dc.code} | amount: ${dc.amount} | type: ${dc.type}`);
    }
    const apps = (order as any).discount_applications ?? [];
    for (const da of apps) {
      console.log(`    app: ${da.type} | code: ${da.code ?? '—'} | value: ${da.value} (${da.value_type})`);
    }
  } else {
    console.log(`  total_discounts  : none`);
  }

  // ── DB state ──────────────────────────────────────────────────
  console.log(`\n  ── DB State ──`);
  const dbRecord = await shipmentRepository.findByShopifyOrderId(String(order.id));
  if (dbRecord) {
    console.log(`  DB record id     : ${dbRecord.id}`);
    console.log(`  accurateCode     : ${dbRecord.accurateShipmentCode}`);
    console.log(`  accurateStatus   : ${dbRecord.accurateStatus}`);
    console.log(`  odooSyncStatus   : ${dbRecord.odooSyncStatus}`);
    console.log(`  odooSaleOrderName: ${dbRecord.odooSaleOrderName}`);
    console.log(`  odooAttemptCount : ${dbRecord.odooAttemptCount}`);
    console.log(`  ⚠️  Already in DB — user said they may delete old shipments`);
  } else {
    console.log(`  DB record        : ✅ not in DB — fresh order`);
  }

  // ── Odoo Readiness ────────────────────────────────────────────
  console.log(`\n  ── Odoo Product Readiness ──`);
  if (!odooSyncService) {
    console.log(`  Odoo             : ⚠️  not configured`);
  } else {
    try {
      const preview = await odooSyncService.previewOrder(order);
      console.log(`  Odoo ready       : ${preview.ready ? '✅ YES' : '❌ NO'}`);
      console.log(`  Odoo reference   : ${preview.reference}`);
      console.log(`  customer ready   : ${preview.customer.ready ? '✅' : '❌'} (${preview.customer.name} / ${preview.customer.phone})`);
      for (const p of preview.products) {
        console.log(`  product: ${p.title} (sku=${p.sku}) → ${p.ready ? '✅ ready' : '❌ ' + p.reason} ${p.odooProductId ? '[id=' + p.odooProductId + ']' : ''}`);
      }
    } catch (e: any) {
      console.log(`  Odoo preview ERR : ${e.message}`);
    }
  }

  // ── Summary flags ─────────────────────────────────────────────
  console.log(`\n  ── Summary ──`);
  console.log(`  has_variant      : ${hasVariant ? '⚡ YES' : 'no'}`);
  console.log(`  has_bundle       : ${hasBundle ? '⚡ YES' : 'no'}`);
  console.log(`  missing_skus     : ${missingSkus.length > 0 ? '❌ ' + missingSkus.join(', ') : '✅ none'}`);
  console.log(`  phone_ok         : ${addr?.phone || order.phone || order.customer?.phone ? '✅' : '❌ MISSING'}`);
  console.log(`  location_explicit: ${loc ? '✅' : '⚠️  fallback'}`);
}

console.log('\n\n╔══════════════════════════════════════════════════════════════╗');
console.log('║  PRE-CHECK COMPLETE — no writes made                         ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

await prisma.$disconnect();
