import { shopifyStatusSyncClient } from '../shopify/shopifyStatusSyncClient.js';
import { prisma } from '../lib/prisma.js';

const r = await prisma.shipmentRecord.findFirst({
  where: { shopifyOrderName: '#1879' },
  select: { shopifyOrderId: true, collectionStatus: true }
});
console.log('DB record:', r);

if (r?.shopifyOrderId) {
  const state = await shopifyStatusSyncClient.fetchOrderPaymentState(r.shopifyOrderId);
  console.log('\nShopify state:');
  console.log(JSON.stringify(state, null, 2));
}

await prisma.$disconnect();
