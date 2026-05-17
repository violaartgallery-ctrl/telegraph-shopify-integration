/**
 * READ-ONLY diagnosis for orders #1946 and #1947
 * - Fetch from Shopify
 * - Check DB record
 * - Check eligibility
 * - Check Telegraph location
 * - Check Odoo readiness
 * - Check failed payloads
 */
import { shopifyOrdersClient } from '../shopify/shopifyOrdersClient.js';
import { isOrderEligibleForShipment } from '../services/orderEligibility.js';
import { getTelegraphLocationSelection } from '../services/telegraphLocation.js';
import { createAppServices } from '../app.js';
import { shipmentRepository } from '../services/shipmentRepository.js';
import { prisma } from '../lib/prisma.js';

const { odooSyncService } = createAppServices();
const TARGET = ['#1946', '#1947'];

// Fetch more orders to find them
const orders = await shopifyOrdersClient.listRecentOrders(500);

for (const name of TARGET) {
  const order = orders.find(o => o.name === name);

  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  ${name}`);
  console.log('═'.repeat(64));

  if (!order) {
    console.log(`  ❌ NOT FOUND in last 500 orders`);
    continue;
  }

  const addr = order.shipping_address ?? order.billing_address;

  // Basic
  console.log(`  shopify id        : ${order.id}`);
  console.log(`  financial_status  : ${order.financial_status}`);
  console.log(`  fulfillment_status: ${order.fulfillment_status ?? 'null'}`);
  console.log(`  tags              : ${order.tags || '(none)'}`);
  console.log(`  test              : ${order.test}`);
  console.log(`  phone             : ${addr?.phone ?? order.phone ?? order.customer?.phone ?? '❌ MISSING'}`);
  console.log(`  gateway           : ${order.gateway}`);
  console.log(`  total_price       : ${order.total_price}`);
  console.log(`  total_outstanding : ${order.total_outstanding}`);

  // Eligibility
  const eligible = isOrderEligibleForShipment(order);
  console.log(`\n  eligible          : ${eligible ? '✅ YES' : '❌ NO'}`);

  // Telegraph location
  const loc = getTelegraphLocationSelection(order);
  console.log(`  telegraph loc     : ${loc ? `✅ gov=${loc.governorateId} area=${loc.areaId}` : '⚠️  missing (fallback)'}`);

  // Line items
  console.log(`\n  Line items:`);
  for (const item of order.line_items ?? []) {
    const qty = item.current_quantity ?? item.quantity;
    console.log(`    • ${item.title} | variant=${item.variant_title ?? 'Default'} | qty=${qty} | sku=${item.sku || '❌ MISSING'}`);
  }

  // DB record
  const rec = await shipmentRepository.findByShopifyOrderId(String(order.id));
  console.log(`\n  DB record:`);
  if (rec) {
    console.log(`    id              : ${rec.id}`);
    console.log(`    accurateCode    : ${rec.accurateShipmentCode ?? 'null'}`);
    console.log(`    accurateStatus  : ${rec.accurateStatus ?? 'null'}`);
    console.log(`    odooSyncStatus  : ${rec.odooSyncStatus ?? 'null'}`);
    console.log(`    odooSaleOrderName: ${rec.odooSaleOrderName ?? 'null'}`);
    console.log(`    odooLastError   : ${rec.odooLastError ?? 'null'}`);
    console.log(`    lastError       : ${rec.lastError ?? 'null'}`);
  } else {
    console.log(`    ✅ not in DB — fresh order`);
  }

  // Failed payloads
  const fails = await prisma.failedPayload.findMany({
    where: { externalId: String(order.id) },
    orderBy: { createdAt: 'desc' },
    take: 5
  });
  if (fails.length > 0) {
    console.log(`\n  FailedPayloads (${fails.length}):`);
    for (const f of fails) {
      console.log(`    source=${f.source} | reason=${f.reason} | at=${f.createdAt.toISOString()}`);
    }
  }

  // Odoo readiness
  if (odooSyncService) {
    try {
      const preview = await odooSyncService.previewOrder(order);
      console.log(`\n  Odoo ready: ${preview.ready ? '✅ YES' : '❌ NO'}`);
      for (const p of preview.products) {
        console.log(`    product: ${p.title} (sku=${p.sku}) → ${p.ready ? '✅' : '❌ ' + p.reason}`);
      }
    } catch (e: any) {
      console.log(`\n  Odoo preview ERR: ${e.message}`);
    }
  }
}

// Also check failed payloads by order name
console.log(`\n${'═'.repeat(64)}`);
console.log(`  FailedPayloads search by name`);
console.log('═'.repeat(64));
for (const name of ['1946', '1947', '#1946', '#1947']) {
  const fails = await prisma.failedPayload.findMany({
    where: { OR: [{ externalId: name }, { reason: { contains: name } }] },
    orderBy: { createdAt: 'desc' },
    take: 3
  });
  if (fails.length) {
    for (const f of fails) {
      console.log(`  [${name}] source=${f.source} | reason=${f.reason} | at=${f.createdAt.toISOString()}`);
    }
  }
}

await prisma.$disconnect();
