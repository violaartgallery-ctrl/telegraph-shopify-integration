import type { ShopifyOrder } from '../types/shopify.js';
import { bindManualShipment,type ManualShipmentBinding } from './manualShipmentBinding.js';

// Exact tags owned by shopifyStatusSyncClient, not an open-ended prefix rule.
const managedTags = new Set([
  'accurate', 'accurate-cancelled', 'accurate-delivered', 'accurate-collected',
  'accurate-delivered-not-collected', 'accurate-payment-review', 'accurate-returned',
  'accurate-returned-settled', 'accurate-returned-unsettled', 'accurate-out-for-delivery',
  'accurate-redelivery-pending', 'accurate-delivery-exception', 'accurate-return-in-transit',
  'accurate-received', 'accurate-scheduled', 'accurate-pkr', 'accurate-pkm', 'accurate-pkh',
  'accurate-pkd', 'accurate-prp', 'accurate-bmr', 'accurate-bmt', 'accurate-std',
  'accurate-dtr', 'accurate-dex', 'accurate-htr', 'accurate-rtrn', 'accurate-rts',
  'accurate-rjct', 'accurate-unknown', 'needs-collection-followup'
]);
const routingKeys = new Set([
  'telegraph governorate id', 'telegraph governorate', 'telegraph area id', 'telegraph area'
]);

/** Accounting ONLY, after exact live carrier identity verification. Status tags
 * are written by our own poller; four routing attributes may exist only in the
 * owner's saved shipping overlay. Neither is an Odoo money/product/address input.
 * Never use this comparison to authorize shipping or rewrite the original snapshot.
 * The strict Preview/Run binding is deliberately unchanged. */
export function bindOdooShipmentAccountingSource(order: ShopifyOrder): ManualShipmentBinding {
    if (order.tags != null && typeof order.tags !== 'string') {
      throw new Error('AUTOMATION_REVIEW_REQUIRED: Invalid accounting source tags');
    }
    if (order.note_attributes != null && !Array.isArray(order.note_attributes)) {
      throw new Error('AUTOMATION_REVIEW_REQUIRED: Invalid accounting source attributes');
    }
    return bindManualShipment({
      ...order,
      tags: [...new Set((order.tags ?? '').split(',').map(t => t.trim())
        .filter(t => t && !managedTags.has(t)))].sort().join(', '),
      note_attributes: (order.note_attributes ?? []).filter(attribute => {
        const key = attribute.name ?? attribute.key;
        if (typeof key !== 'string') {
          throw new Error('AUTOMATION_REVIEW_REQUIRED: Invalid accounting attribute identity');
        }
        return !routingKeys.has(key.trim().toLowerCase());
      })
    });
}

// Owner approved ONLY these two legacy overwrites. Hashes bind every accounting
// input after the existing observational projection, not just the note text.
// No stored source, shipping hash, claim or order is rewritten by this rule.
const approvedBotFollowupPairs = [
  {id:'18979158622500',name:'#13949',savedHash:'038f59d3a2fa24cae30c9e9aaa92650926ca2097951a279905e5e9faddd1d30b',botHash:'2ee5c83c1bf6b09b9783d600b99d9b07d82f9fbc8ca9639b5700ccf67e0b8c0c'},
  {id:'18979330392356',name:'#13955',savedHash:'61e99f8f834c56f76654b07daf80047c7ed5b5ea6117645a069185eecc6888db',botHash:'d8ae9f977d2680ff9d42c986c14293e522dac0e21c738545ae71404eddd77890'}
] as const;
export function isApprovedBotFollowupAccountingPair(a:ManualShipmentBinding,b:ManualShipmentBinding):boolean {
  return a.version===1&&b.version===1&&a.shopifyOrderId===b.shopifyOrderId&&a.orderName===b.orderName&&approvedBotFollowupPairs.some(p=>p.id===a.shopifyOrderId&&p.name===a.orderName&&p.savedHash===a.shippingHash&&p.botHash===b.shippingHash);
}
/** Owner rule 12 (2026-11-25), opt-in: for Odoo accounting only, ignore notes,
 * tags, names, addresses and line customization. Products, quantities, prices,
 * discounts, shipping, tax, currency, financial status and cancellation still
 * bind. Never used for shipping, Preview/Run or the strict manual binding. */
export const accountingMoneyOnlySourceEnabled = (): boolean =>
  process.env.OPS_ACCOUNTING_MONEY_ONLY_SOURCE?.trim().toLowerCase() === 'true';

const moneyCents = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('AUTOMATION_REVIEW_REQUIRED: Invalid accounting money value');
  return Math.round(n * 100);
};

export interface OdooAccountingMoneyBinding { version: 1; shopifyOrderId: string; orderName: string; moneyKey: string; lineCount: number }

export function bindOdooAccountingMoney(order: ShopifyOrder): OdooAccountingMoneyBinding {
  const o = order as ShopifyOrder & Record<string, any>;
  const id = String(o.id);
  if (!/^[1-9]\d*$/.test(id) || typeof o.name !== 'string' || !/^#\S+$/.test(o.name) || !Array.isArray(o.line_items) || o.line_items.length >= 250) {
    throw new Error('AUTOMATION_REVIEW_REQUIRED: Invalid accounting money identity');
  }
  if (o.shipping_lines != null && !Array.isArray(o.shipping_lines)) throw new Error('AUTOMATION_REVIEW_REQUIRED: Invalid accounting shipping lines');
  const lines = o.line_items.map((l: Record<string, any>) => {
    const quantity = Number(l.current_quantity ?? l.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error('AUTOMATION_REVIEW_REQUIRED: Invalid accounting line quantity');
    return { product: l.product_id ?? null, variant: l.variant_id ?? null, sku: l.sku ?? null, quantity,
      price: moneyCents(l.price), discount: moneyCents(l.total_discount ?? 0) };
  }).filter((l: { quantity: number }) => l.quantity > 0)
    .sort((a: any, b: any) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const shipping = (o.shipping_lines ?? []).reduce((sum: number, s: Record<string, any>) => sum + (moneyCents(s.discounted_price ?? s.price) ?? 0), 0);
  const money = {
    // Pending/authorized/paid are the same accounting input for the SO: our own COD payment
    // record moves pending -> paid. Refunds, voids and partial states still differ.
    currency: o.currency ?? null, financialStatus: ['pending', 'authorized', 'paid'].includes(String(o.financial_status ?? '')) ? 'open-or-paid' : (o.financial_status ?? null),
    cancelled: Boolean(o.cancelled_at), test: Boolean(o.test),
    total: moneyCents(o.current_total_price ?? o.total_price), subtotal: moneyCents(o.current_subtotal_price ?? o.subtotal_price),
    discounts: moneyCents(o.current_total_discounts ?? o.total_discounts), tax: moneyCents(o.current_total_tax ?? o.total_tax),
    shipping, lines,
  };
  if (money.total === null) throw new Error('AUTOMATION_REVIEW_REQUIRED: Missing accounting order total');
  // Canonical text, compared exactly (this module stays free of crypto imports).
  return { version: 1, shopifyOrderId: id, orderName: o.name, moneyKey: JSON.stringify(money), lineCount: lines.length };
}

/** True only when both orders are the same order with identical accounting money inputs. */
export function accountingMoneyUnchanged(saved: ShopifyOrder, fresh: ShopifyOrder): boolean {
  try {
    const a = bindOdooAccountingMoney(saved), b = bindOdooAccountingMoney(fresh);
    return a.shopifyOrderId === b.shopifyOrderId && a.orderName === b.orderName && a.lineCount > 0 && a.moneyKey === b.moneyKey;
  } catch { return false; }
}

/** Production (Odoo SO) source fence: the strict check, then the opt-in money-only rule. */
export function assertOdooProductionSourceUnchanged(saved: ShopifyOrder, fresh: ShopifyOrder): void {
  try { assertOdooShipmentSourceUnchanged(saved, fresh); }
  catch (error) {
    if (accountingMoneyOnlySourceEnabled() && accountingMoneyUnchanged(saved, fresh)) return;
    throw error;
  }
}

export function assertOdooShipmentSourceUnchanged(saved: ShopifyOrder, fresh: ShopifyOrder): void {
  const a = bindOdooShipmentAccountingSource(saved);
  const b = bindOdooShipmentAccountingSource(fresh);
  if (a.shopifyOrderId !== b.shopifyOrderId || a.orderName !== b.orderName || a.shippingHash !== b.shippingHash) {
    if(isApprovedBotFollowupAccountingPair(a,b))return;
    throw new Error(`AUTOMATION_REVIEW_REQUIRED: Accounting money/products/address/customization changed: ${saved.name}`);
  }
}
