/**
 * READ-ONLY verification: sample a handful of the just-actioned legacy orders
 * and confirm Shopify now shows the correct end state.
 */
import { shopifyStatusSyncClient } from '../shopify/shopifyStatusSyncClient.js';

const paySamples = [1009, 1010, 1013, 1030, 1546, 1432, 1318, 1410, 1071]; // includes 3 of the -90 "delivered" ones
const cancelSamples = [1081, 1066, 1098, 1603, 1607, 1564];

console.log('=== PAID samples (should be financial=paid) ===');
for (const n of paySamples) {
  const orders = await shopifyStatusSyncClient.fetchOrderPaymentState
    ? null : null;
  // fetchOrderPaymentState takes the internal id; we need to look up by name first.
  const found = await import('../shopify/shopifyOrdersClient.js').then((m) => m.shopifyOrdersClient.listRecentOrders(5, 'name:' + n));
  const o = found.find((x) => Number(String(x.name).replace(/\D/g, '')) === n);
  if (!o) { console.log('  #' + n + ': not found'); continue; }
  console.log('  #' + n + ': financial=' + o.financial_status + ' | total=' + o.total_price + ' | tags=' + (o.tags ?? ''));
}

console.log('\n=== CANCELLED samples (should be cancelled) ===');
for (const n of cancelSamples) {
  const found = await import('../shopify/shopifyOrdersClient.js').then((m) => m.shopifyOrdersClient.listRecentOrders(5, 'name:' + n));
  const o = found.find((x) => Number(String(x.name).replace(/\D/g, '')) === n);
  if (!o) { console.log('  #' + n + ': not found'); continue; }
  const cancelled = Boolean((o as { cancelled_at?: string }).cancelled_at);
  console.log('  #' + n + ': cancelled=' + cancelled + ' | financial=' + o.financial_status + ' | tags=' + (o.tags ?? ''));
}
