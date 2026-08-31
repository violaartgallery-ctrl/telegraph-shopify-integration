import { env } from '../config/env.js';
import type { AccurateZoneResolver } from '../accurate/zoneResolver.js';
import {
  AccurateMapper,
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

console.log(JSON.stringify({
  ok: true,
  senderPhone: input.senderPhone,
  senderMobile: input.senderMobile,
  notes: input.notes,
  description: input.description,
  refNumber: input.refNumber,
  piecesCount: input.piecesCount
}));
