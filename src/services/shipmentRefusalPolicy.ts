import type { ShopifyOrder } from '../types/shopify.js';

interface ShippingCharge {
  amount: number;
  currency: string;
}

const parseAmount = (value: unknown): number | undefined => {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim())) return undefined;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
};

const currencyCode = (value?: string | null): string | undefined => {
  const code = value?.trim().toUpperCase();
  return code && /^[A-Z]{3}$/.test(code) ? code : undefined;
};

/** Only order shipping data is used: never order total, COD, or carrier fees. */
export const getOrderShippingCharge = (order: ShopifyOrder): ShippingCharge | undefined => {
  const current = order.current_shipping_price_set;
  if (current !== undefined && current !== null) {
    const amount = parseAmount(current.shop_money?.amount);
    const currency = currencyCode(current.shop_money?.currency_code ?? order.currency);
    // An explicit zero is authoritative (free/refunded shipping). Do not fall
    // back to an older, positive original shipping price.
    return amount !== undefined && currency ? { amount, currency } : undefined;
  }

  // orders/create webhooks use snake_case shipping_lines rather than the
  // normalized GraphQL aggregate. Discounted values already include discounts.
  if (!Array.isArray(order.shipping_lines)) return undefined;
  let amount = 0;
  let currency = currencyCode(order.currency);
  for (const line of order.shipping_lines.filter(item => !item.is_removed)) {
    const discountedSet = line.current_discounted_price_set ?? line.discounted_price_set;
    if (discountedSet && !discountedSet.shop_money) return undefined;
    const money = discountedSet?.shop_money ?? line.price_set?.shop_money;
    const lineCurrency = currencyCode(money?.currency_code ?? order.currency);
    if (!lineCurrency || (currency && lineCurrency !== currency)) return undefined;
    currency = lineCurrency;

    const discounted = discountedSet !== undefined && discountedSet !== null
      ? discountedSet.shop_money?.amount : line.discounted_price;
    let lineAmount: number | undefined;
    if (discountedSet || (line.discounted_price !== undefined && line.discounted_price !== null)) {
      lineAmount = parseAmount(discounted);
    } else {
      lineAmount = parseAmount(line.price_set?.shop_money?.amount ?? line.price);
      if (lineAmount === undefined) return undefined;
      let discount = 0;
      for (const allocation of line.discount_allocations ?? []) {
        const allocationMoney = allocation.amount_set?.shop_money;
        const allocationCurrency = currencyCode(allocationMoney?.currency_code ?? lineCurrency);
        const allocationAmount = parseAmount(allocationMoney?.amount ?? allocation.amount);
        if (allocationCurrency !== lineCurrency || allocationAmount === undefined) return undefined;
        discount += allocationAmount;
      }
      lineAmount = Math.max(0, lineAmount - discount);
    }
    if (lineAmount === undefined) return undefined;
    amount += lineAmount;
  }
  return currency && Number.isFinite(amount) ? { amount, currency } : undefined;
};

const currencyNames: Record<string, string> = {
  EGP: 'جنيه', SAR: 'ريال سعودي', AED: 'درهم إماراتي',
  KWD: 'دينار كويتي', QAR: 'ريال قطري', BHD: 'دينار بحريني',
  OMR: 'ريال عماني', USD: 'دولار أمريكي', EUR: 'يورو'
};

export const buildRefusalShippingNote = (order: ShopifyOrder): string | undefined => {
  const charge = getOrderShippingCharge(order);
  if (!charge || charge.amount <= 0) return undefined;
  const amount = new Intl.NumberFormat('en-US', {
    useGrouping: false, maximumFractionDigits: 3
  }).format(charge.amount);
  if (amount === '0') return undefined;
  return `في حالة رفض العميل استلام الشحنة، يجب سداد رسوم الشحن وقدرها ${amount} ${currencyNames[charge.currency] ?? charge.currency}.`;
};

/** Preserve customer instructions and avoid duplicating an identical notice. */
export const buildShipmentNotes = (order: ShopifyOrder): string | undefined => {
  const existing = order.note?.trim();
  const refusal = buildRefusalShippingNote(order);
  if (!refusal || existing?.includes(refusal)) return existing || undefined;
  return [existing, refusal].filter(Boolean).join('\n\n');
};
