// Read-only: fetch orders #2010 and #2011 from Shopify by order name
import { shopifyOrdersClient } from '../shopify/shopifyOrdersClient.js';
import { prisma } from '../lib/prisma.js';

// List recent orders and find #2010 / #2011
const orders = await shopifyOrdersClient.listRecentOrders(250);

const targets = orders.filter(o => o.name === '#2010' || o.name === '#2011' || o.order_number === 2010 || o.order_number === 2011);

if (targets.length === 0) {
  console.log('Orders #2010 and #2011 not found in last 250 orders.');
  console.log('Most recent order names:', orders.slice(0, 5).map(o => o.name).join(', '));
} else {
  for (const order of targets) {
    const record = await prisma.shipmentRecord.findUnique({ where: { shopifyOrderId: String(order.id) } });
    const addr = order.shipping_address ?? order.billing_address;
    console.log(`\n── ${order.name} ─────────────────────────────────────`);
    console.log('  shopify id        :', order.id);
    console.log('  financial status  :', order.financial_status);
    console.log('  customer          :', addr?.name ?? [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' '));
    console.log('  phone             :', addr?.phone ?? order.phone ?? order.customer?.phone);
    console.log('  city              :', addr?.city, '/', addr?.province);
    console.log('  total             :', order.total_price, order.currency);
    console.log('  tags              :', order.tags);
    console.log('  test order        :', order.test);
    console.log('  line items count  :', order.line_items?.length);
    console.log('  DB record         :', record
      ? `id=${record.id} | accurateStatus=${record.accurateStatus} | odooSyncStatus=${record.odooSyncStatus} | shipmentCode=${record.accurateShipmentCode}`
      : 'NOT IN DB — never processed');
  }
}

await prisma.$disconnect();
