import { buildShipmentDescription } from '../services/accurateMapper.js';
import type { ShopifyOrder } from '../types/shopify.js';

// Simulate #2794: Magic Wallet, original 999, order-level 20% discount = 199.80, qty 1.
const order = {
  name: '#2794', order_number: 2794,
  line_items: [{
    id: 1, title: 'Magic Wallet', variant_title: 'Dark brown',
    quantity: 1, current_quantity: 1,
    price: '999.00',
    discount_allocations: [{ amount: '199.80' }]
  }]
} as unknown as ShopifyOrder;

console.log('Description:');
console.log('  ' + buildShipmentDescription(order));
console.log('\nExpected: Magic Wallet - Dark brown x1 - Price: 799.2');

// Second case: no discount → original price unchanged
const order2 = {
  name: '#9999', order_number: 9999,
  line_items: [{ id: 2, title: 'Plain Wallet', quantity: 2, current_quantity: 2, price: '500.00', discount_allocations: [] }]
} as unknown as ShopifyOrder;
console.log('\nNo-discount case:');
console.log('  ' + buildShipmentDescription(order2));
console.log('  Expected: Plain Wallet x2 - Price: 500');

// Third: multi-qty with discount
const order3 = {
  name: '#8888', order_number: 8888,
  line_items: [{ id: 3, title: 'Bag', quantity: 2, current_quantity: 2, price: '1000.00', discount_allocations: [{ amount: '400.00' }] }]
} as unknown as ShopifyOrder;
console.log('\nMulti-qty discount case (2× 1000, -400 total):');
console.log('  ' + buildShipmentDescription(order3));
console.log('  Expected per-unit: (2000-400)/2 = 800');
