/**
 * Fetch orders #1946 and #1947 by name — no fulfillment_status filter.
 */
import { requestShopifyAdmin } from '../shopify/shopifyAdminGraphql.js';
import { shipmentRepository } from '../services/shipmentRepository.js';
import { isOrderEligibleForShipment } from '../services/orderEligibility.js';
import { getTelegraphLocationSelection } from '../services/telegraphLocation.js';
import { createAppServices } from '../app.js';
import { prisma } from '../lib/prisma.js';

const { odooSyncService } = createAppServices();

const ORDER_NAMES = ['1946', '1947'];

interface OrderNode {
  id: string;
  legacyResourceId: string;
  name: string;
  displayFinancialStatus: string;
  displayFulfillmentStatus: string;
  confirmed: boolean;
  tags: string[];
  test: boolean;
  phone?: string | null;
  email?: string | null;
  totalPriceSet: { shopMoney: { amount: string } };
  currentTotalPriceSet: { shopMoney: { amount: string } };
  totalOutstandingSet: { shopMoney: { amount: string } };
  paymentGatewayNames: string[];
  shippingAddress?: {
    name?: string | null;
    address1?: string | null;
    address2?: string | null;
    city?: string | null;
    province?: string | null;
    phone?: string | null;
  } | null;
  lineItems: {
    nodes: Array<{
      id: string;
      title: string;
      sku?: string | null;
      quantity: number;
      currentQuantity: number;
      variantTitle?: string | null;
      variant?: { sku?: string | null } | null;
      discountedUnitPriceSet: { shopMoney: { amount: string } };
    }>;
  };
  customAttributes: Array<{ key: string; value?: string | null }>;
  customer?: { firstName?: string | null; lastName?: string | null; phone?: string | null } | null;
}

interface SearchResponse {
  orders: { nodes: OrderNode[] };
}

const QUERY = `
  query SearchOrders($query: String!) {
    orders(first: 5, query: $query) {
      nodes {
        id legacyResourceId name displayFinancialStatus displayFulfillmentStatus
        confirmed tags test phone email
        totalPriceSet { shopMoney { amount } }
        currentTotalPriceSet { shopMoney { amount } }
        totalOutstandingSet { shopMoney { amount } }
        paymentGatewayNames
        shippingAddress { name address1 address2 city province phone }
        lineItems(first: 20) {
          nodes {
            id title sku quantity currentQuantity variantTitle
            variant { sku }
            discountedUnitPriceSet { shopMoney { amount } }
          }
        }
        customAttributes { key value }
        customer { firstName lastName phone }
      }
    }
  }
`;

for (const num of ORDER_NAMES) {
  const res = await requestShopifyAdmin<SearchResponse>(QUERY, { query: `name:#${num}` });
  const node = res.orders.nodes[0];

  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  #${num}`);
  console.log('═'.repeat(64));

  if (!node) {
    console.log(`  ❌ NOT FOUND`);
    continue;
  }

  const addr = node.shippingAddress;
  const phone = addr?.phone ?? node.phone ?? node.customer?.phone;

  console.log(`  shopify id            : ${node.legacyResourceId}`);
  console.log(`  GID                   : ${node.id}`);
  console.log(`  financial_status      : ${node.displayFinancialStatus}`);
  console.log(`  fulfillment_status    : ${node.displayFulfillmentStatus}`);
  console.log(`  confirmed             : ${node.confirmed}`);
  console.log(`  tags                  : ${node.tags.join(', ') || '(none)'}`);
  console.log(`  test                  : ${node.test}`);
  console.log(`  phone                 : ${phone || '❌ MISSING'}`);
  console.log(`  gateways              : ${node.paymentGatewayNames.join(', ')}`);
  console.log(`  total_price           : ${node.totalPriceSet.shopMoney.amount}`);
  console.log(`  total_outstanding     : ${node.totalOutstandingSet.shopMoney.amount}`);
  console.log(`  city/province         : ${addr?.city} / ${addr?.province}`);

  // Line items
  console.log(`\n  Line items:`);
  for (const item of node.lineItems.nodes) {
    const sku = item.variant?.sku ?? item.sku;
    const qty = item.currentQuantity ?? item.quantity;
    console.log(`    • ${item.title} | variant=${item.variantTitle ?? 'Default'} | qty=${qty} | sku=${sku || '❌ MISSING'} | price=${item.discountedUnitPriceSet.shopMoney.amount}`);
  }

  // customAttributes (Telegraph location)
  const attrs = node.customAttributes;
  const govId = attrs.find(a => a.key === 'Telegraph Governorate ID')?.value;
  const areaId = attrs.find(a => a.key === 'Telegraph Area ID')?.value;
  const gov = attrs.find(a => a.key === 'Telegraph Governorate')?.value;
  const area = attrs.find(a => a.key === 'Telegraph Area')?.value;
  console.log(`\n  Telegraph location:`);
  console.log(`    Governorate ID: ${govId ?? '⚠️  missing'} (${gov ?? '?'})`);
  console.log(`    Area ID       : ${areaId ?? '⚠️  missing'} (${area ?? '?'})`);

  // DB record
  const rec = await shipmentRepository.findByShopifyOrderId(node.legacyResourceId);
  console.log(`\n  DB record:`);
  if (rec) {
    console.log(`    id              : ${rec.id}`);
    console.log(`    accurateCode    : ${rec.accurateShipmentCode ?? 'null'}`);
    console.log(`    accurateStatus  : ${rec.accurateStatus ?? 'null'}`);
    console.log(`    odooSyncStatus  : ${rec.odooSyncStatus ?? 'null'}`);
    console.log(`    odooSaleOrder   : ${rec.odooSaleOrderName ?? 'null'}`);
    console.log(`    lastError       : ${rec.lastError ?? 'null'}`);
    console.log(`    odooLastError   : ${rec.odooLastError ?? 'null'}`);
  } else {
    console.log(`    ✅ not in DB — fresh`);
  }

  // Failed payloads
  const fails = await prisma.failedPayload.findMany({
    where: { externalId: node.legacyResourceId },
    orderBy: { createdAt: 'desc' }, take: 5
  });
  if (fails.length) {
    console.log(`\n  FailedPayloads:`);
    for (const f of fails) {
      console.log(`    [${f.source}] ${f.reason.slice(0, 120)} | ${f.createdAt.toISOString()}`);
    }
  }

  // Odoo readiness — rebuild a minimal ShopifyOrder to pass to previewOrder
  if (odooSyncService) {
    try {
      const fakeOrder = {
        id: Number(node.legacyResourceId),
        name: node.name,
        order_number: Number(num),
        financial_status: node.displayFinancialStatus.toLowerCase(),
        fulfillment_status: null,
        confirmed: node.confirmed,
        tags: node.tags.join(', '),
        total_price: node.totalPriceSet.shopMoney.amount,
        total_outstanding: node.totalOutstandingSet.shopMoney.amount,
        current_total_price: node.currentTotalPriceSet.shopMoney.amount,
        gateway: node.paymentGatewayNames[0] ?? null,
        payment_gateway_names: node.paymentGatewayNames,
        test: node.test,
        email: node.email ?? null,
        phone: node.phone ?? null,
        shipping_address: addr ? {
          name: addr.name ?? null,
          address1: addr.address1 ?? null,
          address2: addr.address2 ?? null,
          city: addr.city ?? null,
          province: addr.province ?? null,
          phone: addr.phone ?? null,
        } : null,
        billing_address: null,
        customer: node.customer ? {
          first_name: node.customer.firstName ?? null,
          last_name: node.customer.lastName ?? null,
          phone: node.customer.phone ?? null,
        } : null,
        line_items: node.lineItems.nodes.map(item => ({
          id: Number(item.id.split('/').pop()),
          title: item.title,
          sku: item.variant?.sku ?? item.sku ?? null,
          quantity: item.quantity,
          current_quantity: item.currentQuantity,
          price: item.discountedUnitPriceSet.shopMoney.amount,
          variant_title: item.variantTitle ?? null,
        })),
        note_attributes: attrs.map(a => ({ name: a.key, key: a.key, value: a.value ?? '' })),
      };

      const preview = await odooSyncService.previewOrder(fakeOrder as any);
      console.log(`\n  Odoo ready: ${preview.ready ? '✅ YES' : '❌ NO'}`);
      for (const p of preview.products) {
        console.log(`    • ${p.title} (sku=${p.sku}) → ${p.ready ? '✅ ready' : '❌ ' + p.reason}`);
      }
    } catch (e: any) {
      console.log(`\n  Odoo preview ERR: ${e.message}`);
    }
  }
}

await prisma.$disconnect();
