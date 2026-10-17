/** Offline tests: this script must never call or mutate an external service. */
import assert from 'node:assert/strict';
import { AccurateClient } from '../accurate/accurateClient.js';
import { AccurateZoneResolver } from '../accurate/zoneResolver.js';
import { AccurateMapper, buildShipmentDescription, buildShipmentNotes as buildPrintableShipmentNotes } from '../services/accurateMapper.js';
import { buildRefusalShippingNote, buildShipmentNotes, getOrderShippingCharge } from '../services/shipmentRefusalPolicy.js';
import type { ShopifyOrder } from '../types/shopify.js';

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Offline refusal-note test attempted a network request'); };

const base: ShopifyOrder = {
  id: 10001, name: '#10001', order_number: 10001, currency: 'EGP',
  total_price: '1080.00', total_outstanding: '1080.00', current_total_price: '1080.00',
  payment_gateway_names: ['Cash on Delivery (COD)'],
  shipping_address: { name: 'Test recipient', phone: '01000000000', address1: 'Test address' },
  note_attributes: [
    { name: 'Telegraph Governorate ID', value: '1' },
    { name: 'Telegraph Area ID', value: '2' }
  ],
  line_items: [{ id: 1, title: 'Test wallet', sku: null, quantity: 1, price: '1000.00', variant_title: 'Black' }],
  current_shipping_price_set: { shop_money: { amount: '80.00', currency_code: 'EGP' } }
};
const order = (fields: Partial<ShopifyOrder> = {}): ShopifyOrder => ({ ...structuredClone(base), ...fields });
const notice = 'في حالة رفض العميل استلام الشحنة، يجب سداد رسوم الشحن وقدرها 80 جنيه.';
let checks = 0;
const equal = (actual: unknown, expected: unknown, label: string) => {
  assert.deepEqual(actual, expected, label); checks++;
};
const webhook = (fields: Partial<ShopifyOrder> = {}) => order({ current_shipping_price_set: undefined, ...fields });

try {
  equal(buildRefusalShippingNote(order()), notice, 'Exact customer-refusal wording, amount, and currency');
  for (const amount of ['65', '120.50', '95']) {
    equal(buildRefusalShippingNote(order({ current_shipping_price_set: {
      shop_money: { amount, currency_code: 'EGP' }
    } })), `في حالة رفض العميل استلام الشحنة، يجب سداد رسوم الشحن وقدرها ${Number(amount)} جنيه.`,
    'Shipping fee remains dynamic and Egyptian wording ends at جنيه');
  }
  equal(getOrderShippingCharge(order()), { amount: 80, currency: 'EGP' }, 'GraphQL normalized shipping charge');
  equal(buildShipmentDescription(order()), `Test wallet - Black x1 - Price: 1000\n\n${notice}`, 'Description preserves product information');
  equal(buildShipmentNotes(order({ note: 'الاتصال قبل الوصول' })), `الاتصال قبل الوصول\n\n${notice}`, 'Existing instructions preserved');
  equal(buildShipmentNotes(order({ note: `الاتصال قبل الوصول\n\n${notice}` })), `الاتصال قبل الوصول\n\n${notice}`, 'Same notice is not duplicated');
  equal(buildPrintableShipmentNotes(order({ note: 'الاتصال قبل الوصول\nالجرس لا يعمل' })),
    `الاتصال قبل الوصول | الجرس لا يعمل | ${notice}`, 'Printable notes preserve instructions and the refusal fee on one line');
  equal(buildPrintableShipmentNotes(order({ note: notice })), notice, 'Printable notes do not duplicate the refusal notice');
  equal(buildRefusalShippingNote(order({ current_shipping_price_set: { shop_money: { amount: '0.00', currency_code: 'EGP' } },
    shipping_lines: [{ price: '80.00' }] })), undefined, 'Zero current shipping cannot fall back to old positive price');
  equal(buildShipmentNotes(order({ current_shipping_price_set: { shop_money: { amount: '0.00', currency_code: 'EGP' } }, note: 'تعليمات محفوظة' })), 'تعليمات محفوظة', 'Free shipping preserves existing notes');
  equal(buildRefusalShippingNote(webhook()), undefined, 'Unknown fee is never guessed from order total');
  equal(buildRefusalShippingNote(webhook({ shipping_lines: [] })), undefined, 'No shipping lines means no charge');

  equal(getOrderShippingCharge(webhook({ shipping_lines: [{ price: '90.00', discount_allocations: [{ amount: '30.00' }] }] })),
    { amount: 60, currency: 'EGP' }, 'Shipping-specific allocations deducted from original shipping');
  equal(getOrderShippingCharge(webhook({ shipping_lines: [{ price: '90.00', discounted_price: '60.00', discount_allocations: [{ amount: '30.00' }] }] })),
    { amount: 60, currency: 'EGP' }, 'Already discounted price is not discounted twice');
  equal(getOrderShippingCharge(webhook({ shipping_lines: [{ discounted_price: '60.00', current_discounted_price_set: {
    shop_money: { amount: '45.00', currency_code: 'EGP' }
  } }] })), { amount: 45, currency: 'EGP' }, 'Current webhook money set wins over older discounted price');
  equal(getOrderShippingCharge(webhook({ shipping_lines: [{ price: '90.00', discounted_price_set: {
    shop_money: { amount: '60.00', currency_code: 'EGP' }
  } }] })), { amount: 60, currency: 'EGP' }, 'Webhook discounted money set supported');
  const summed = getOrderShippingCharge(webhook({ shipping_lines: [{ price: '10.10' }, { price: '20.20' }, { price: '100.00', is_removed: true }] }));
  assert.ok(summed && Math.abs(summed.amount - 30.3) < 1e-9 && summed.currency === 'EGP', 'Only active shipping lines are summed');
  checks++;
  assert.ok(buildRefusalShippingNote(webhook({ shipping_lines: [{ price: '10.10' }, { price: '20.20' }] }))?.includes('30.3 جنيه.'));
  checks++;
  equal(buildRefusalShippingNote(webhook({ shipping_lines: [{ price: '90.00', discount_allocations: [{ amount: '90.00' }] }] })),
    undefined, 'Free-shipping discount generates no payment demand');

  for (const invalid of ['80oops', '-80', '', 'Infinity', 'NaN']) {
    equal(buildRefusalShippingNote(order({ current_shipping_price_set: { shop_money: { amount: invalid, currency_code: 'EGP' } } })),
      undefined, `Invalid amount is not used: ${invalid}`);
  }
  equal(buildRefusalShippingNote(order({ currency: undefined, current_shipping_price_set: { shop_money: { amount: '80.00' } } })),
    undefined, 'Missing currency is not assumed to be EGP');
  equal(getOrderShippingCharge(webhook({ shipping_lines: [{ price: '80', discounted_price_set: {} }] })),
    undefined, 'Malformed discounted money set cannot fall back to the original price');
  equal(getOrderShippingCharge(webhook({ shipping_lines: [{ discounted_price_set: { shop_money: { amount: '10', currency_code: 'SAR' } } }] })),
    undefined, 'Mixed currencies are not added');
  equal(getOrderShippingCharge(webhook({ shipping_lines: [{ price: '80', discount_allocations: [{ amount: 'wrong' }] }] })),
    undefined, 'Malformed discount cannot inflate the quoted shipping fee');
  assert.ok(buildRefusalShippingNote(order({ currency: 'SAR', current_shipping_price_set: { shop_money: { amount: '45.50', currency_code: 'SAR' } } }))?.includes('45.5 ريال سعودي'));
  checks++;
  assert.ok(buildRefusalShippingNote(order({ currency: 'KWD', current_shipping_price_set: { shop_money: { amount: '2.375', currency_code: 'KWD' } } }))?.includes('2.375 دينار كويتي'));
  checks++;

  const mapper = new AccurateMapper(new AccurateZoneResolver(new AccurateClient()));
  const cod = await mapper.mapOrderToShipment(order(), { shipmentCode: 'OFFLINE-ONLY' });
  equal(cod.notes, notice, 'Mapper places the note in notes');
  equal(cod.description, buildShipmentDescription(order()), 'Mapper uses the same note in description');
  equal(cod.price, 1080, 'COD amount is unchanged; no shipping fee is added again');
  equal(cod.recipientPhone, '+201000000000', 'Existing phone selection is unchanged');
  equal(cod.recipientZoneId, 1, 'Existing explicit governorate is unchanged');
  const international = await mapper.mapOrderToShipment(order({
    shipping_address: { ...base.shipping_address, phone: '+966538123456' }
  }));
  equal(international.notes, `Intl phone: +966538123456 | ${notice}`,
    'Refusal note preserves the existing international phone fallback');
  equal(international.recipientAddress, 'Test address | واتساب: +966538123456',
    'Refusal note does not change international address handling');
  const paid = await mapper.mapOrderToShipment(order({ financial_status: 'paid', total_outstanding: '0', payment_gateway_names: ['Kashier'] }));
  equal(paid.price, 0, 'Prepaid shipment still has zero COD collection');
  equal(paid.notes, notice, 'Prepaid note carries the same refusal policy');
  const free = await mapper.mapOrderToShipment(order({ current_shipping_price_set: { shop_money: { amount: '0', currency_code: 'EGP' } }, note: 'Existing note' }));
  equal(free.notes, 'Existing note', 'Free shipment preserves instructions without a demand');
  equal(free.description, 'Test wallet - Black x1 - Price: 1000', 'Free shipment product description is unchanged');
  await assert.rejects(mapper.mapOrderToShipment(order({ note_attributes: [] })), /missing Telegraph governorate\/area selection/);
  checks++;
  console.log(`PASS: ${checks} offline refusal-shipping-note checks; no external services called.`);
} finally {
  globalThis.fetch = originalFetch;
}
