import type { ShopifyOrder } from '../types/shopify.js';

const paidStatuses = new Set(['paid', 'partially_paid', 'authorized']);

const isCashOnDelivery = (order: ShopifyOrder): boolean => {
  const gateways = order.payment_gateway_names?.join(' ').toLowerCase() ?? '';
  return /cash|cod/.test(gateways) || order.gateway?.toLowerCase() === 'cash_on_delivery';
};

export const isOrderEligibleForShipment = (order: ShopifyOrder): boolean => {
  if (order.test) return false;
  if (order.fulfillment_status === 'fulfilled') return false;

  if (order.confirmed === false) {
    return false;
  }

  const financialStatus = (order.financial_status ?? '').toLowerCase();
  return paidStatuses.has(financialStatus) || (financialStatus === 'pending' && isCashOnDelivery(order));
};
