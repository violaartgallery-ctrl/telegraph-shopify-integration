import { env } from '../config/env.js';
import type { AccurateZoneResolver } from '../accurate/zoneResolver.js';
import {
  AccurateMapper,
  buildPhone,
  buildShipmentDescription,
  buildShipmentNotes
} from '../services/accurateMapper.js';
import type { ShopifyOrder } from '../types/shopify.js';

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

const order: ShopifyOrder = {
  id: 900001,
  name: '#900001',
  order_number: 900001,
  note: 'السطر الأول\n  السطر الثاني   فيه مسافات  \r\n\r\nالسطر الثالث',
  total_price: '780.00',
  total_outstanding: '780.00',
  gateway: 'cash_on_delivery',
  shipping_address: {
    name: 'Test Customer',
    address1: 'Test address',
    city: 'Cairo',
    province: 'Cairo',
    phone: '01000000000'
  },
  line_items: [
    {
      id: 1,
      title: 'Easy Carry Wallet',
      sku: null,
      quantity: 1,
      current_quantity: 1,
      price: '780.00',
      variant_title: 'Black'
    }
  ]
};

assert(
  buildShipmentNotes(order) === 'السطر الأول | السطر الثاني فيه مسافات | السطر الثالث',
  'Shopify note must be flattened into one readable line'
);
assert(
  buildShipmentNotes({ ...order, note: ' \n \r\n ' }) === undefined,
  'blank Shopify note must remain omitted'
);

const zoneResolver = {
  resolve: async () => ({ zoneId: 1, subzoneId: 2 })
} as unknown as AccurateZoneResolver;
const input = await new AccurateMapper(zoneResolver).mapOrderToShipment(order, {
  requireTelegraphLocation: false,
  shipmentCode: 'VI-WAYBILL-TEST'
});

assert(input.notes === buildShipmentNotes(order), 'mapped shipment must include the flattened Shopify note');
assert(input.senderPhone === env.accurate.senderPhone, 'senderPhone mapping must remain environment-driven');
assert(input.senderMobile === env.accurate.senderMobile, 'senderMobile mapping must remain environment-driven');
assert(input.description === buildShipmentDescription(order), 'product description must remain unchanged');
assert(input.refNumber === `${env.orderReferencePrefix}-${order.order_number}`, 'Shopify reference must remain unchanged');
assert(input.piecesCount === 1, 'pieces count must remain unchanged');
assert(input.recipientPhone === '+201000000000', 'Egypt recipient phone must be sent in E.164 format');
assert(input.recipientMobile === input.recipientPhone, 'recipient phone/mobile must use the same canonical value');

const internationalOrder: ShopifyOrder = {
  ...order,
  id: 900002,
  name: '#900002',
  order_number: 900002,
  shipping_address: {
    ...order.shipping_address,
    country_code: 'EG',
    phone: '+966 53 812 3456'
  }
};
const internationalInput = await new AccurateMapper(zoneResolver).mapOrderToShipment(internationalOrder, {
  requireTelegraphLocation: false,
  shipmentCode: 'VI-WAYBILL-INTL-TEST'
});

assert(buildPhone(internationalOrder) === '+966538123456', 'foreign country code must survive Shopify mapping');
assert(internationalInput.recipientPhone === '+966538123456', 'Telegraph phone must receive the full country code');
assert(internationalInput.recipientMobile === '+966538123456', 'Telegraph mobile must receive the full country code');
assert(
  internationalInput.notes?.startsWith('Intl phone: +966538123456 | ') === true,
  'printable notes must preserve the full international number before Shopify notes'
);
assert(internationalInput.senderPhone === input.senderPhone, 'international handling must not change senderPhone');
assert(internationalInput.senderMobile === input.senderMobile, 'international handling must not change senderMobile');

console.log(JSON.stringify({
  ok: true,
  senderPhone: input.senderPhone,
  senderMobile: input.senderMobile,
  notes: input.notes,
  description: input.description,
  refNumber: input.refNumber,
  piecesCount: input.piecesCount,
  recipientPhoneNormalization: true,
  internationalPhoneFallback: true
}));
