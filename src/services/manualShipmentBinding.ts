import { createHash } from 'node:crypto';
import type { ShopifyOrder } from '../types/shopify.js';

export interface ManualShipmentBinding {
  version: 1;
  shopifyOrderId: string;
  orderName: string;
  shippingHash: string;
}

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

/** Pure: excludes observational timestamps, but includes every input used by
 * shipping, eligibility, location, payment, product and customization mapping. */
export function bindManualShipment(order: ShopifyOrder): ManualShipmentBinding {
  const id = String(order.id);
  if (!Number.isSafeInteger(order.id) || order.id <= 0 || !/^[1-9]\d*$/.test(id) || !/^#\S+$/.test(order.name) || !Array.isArray(order.line_items)) {
    throw new Error('Invalid immutable Shopify shipment identity');
  }
  // The shared reader currently uses first:50. A full page cannot prove that
  // products were not truncated. Missing properties likewise means "not read",
  // not proof of no line-level customization. Never authorize an incomplete hash.
  if (order.line_items.length >= 50 || order.line_items.some(item => !Array.isArray(item.properties))) {
    throw new Error('Complete line-item properties and fewer than 50 lines are required for manual shipment binding');
  }
  // Fulfillment is checked on the fresh pre-processor read, not hashed: the
  // authorized operation itself fulfills Shopify, and later fences must still
  // validate money/products/address without rejecting that expected transition.
  const { created_at: _created, processed_at: _processed, updated_at: _updated, fulfillment_status: _fulfillment,
    browser_ip: _ip, landing_site: _landing, referring_site: _referrer,
    client_details: _client, ...critical } = order;
  return { version: 1, shopifyOrderId: id, orderName: order.name, shippingHash: hash(critical) };
}

export function manualShipmentBindingsHash(bindings: ManualShipmentBinding[]): string {
  return hash(bindings);
}

export function assertManualShipmentBindings(input: {
  orderNumbers: string[]; manualShipmentBindings?: ManualShipmentBinding[];
  manualShipmentBindingHash?: string;
}): asserts input is typeof input & { manualShipmentBindings: ManualShipmentBinding[]; manualShipmentBindingHash: string } {
  const bindings = input.manualShipmentBindings;
  if (!Array.isArray(bindings) || !bindings.length || bindings.length !== input.orderNumbers.length ||
      new Set(input.orderNumbers).size !== input.orderNumbers.length ||
      new Set(bindings.map(b => b.shopifyOrderId)).size !== bindings.length ||
      bindings.some((b, i) => b.version !== 1 || !/^[1-9]\d*$/.test(b.shopifyOrderId) ||
        b.orderName !== input.orderNumbers[i] || !/^[a-f0-9]{64}$/.test(b.shippingHash)) ||
      manualShipmentBindingsHash(bindings) !== input.manualShipmentBindingHash) {
    throw new Error('NEW Preview with immutable shipment bindings is required');
  }
}

export function assertManualShipmentUnchanged(binding: ManualShipmentBinding, order: ShopifyOrder): void {
  const actual = bindManualShipment(order);
  if (canonical(actual) !== canonical(binding)) throw new Error(`Shipping source changed since Preview: ${binding.orderName}`);
}
