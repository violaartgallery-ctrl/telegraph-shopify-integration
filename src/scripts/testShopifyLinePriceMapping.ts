import 'dotenv/config';
import assert from 'node:assert/strict';
import { mapLineItems } from '../shopify/shopifyOrdersClient.js';
import { buildShipmentDescription } from '../services/accurateMapper.js';

const fixture = (gross: string, net: string, discount: string, qty = 1) => ({
  id: 'gid://shopify/LineItem/123', title: 'Wallet', quantity: qty, currentQuantity: qty,
  originalUnitPriceSet: { shopMoney: { amount: gross } },
  discountedUnitPriceSet: { shopMoney: { amount: net } },
  discountAllocations: [{ allocatedAmountSet: { shopMoney: { amount: discount } } }],
});
for (const input of [fixture('1000', '250', '750'), fixture('750', '600', '150'), fixture('100', '80', '40', 2), fixture('100', '100', '0')]) {
  const [line] = mapLineItems([input]);
  assert.equal(line!.price, input.originalUnitPriceSet.shopMoney.amount);
  const net = Number(line!.price) * line!.quantity - line!.discount_allocations!.reduce((sum, d) => sum + Number(d.amount), 0);
  assert.equal(net, Number(input.discountedUnitPriceSet.shopMoney.amount) * input.currentQuantity);
}
const discounted = mapLineItems([fixture('1000', '250', '750')]);
assert.match(buildShipmentDescription({ id: 1, name: '#1', order_number: 1, total_price: '250', line_items: discounted }), /Price: 250/,
  'Courier description must keep the same net product price');
console.log(JSON.stringify({ ok: true, cases: 4, discountsAppliedOnce: true, externalCalls: 0 }));
