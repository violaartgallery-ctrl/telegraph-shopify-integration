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
export function assertOdooShipmentSourceUnchanged(saved: ShopifyOrder, fresh: ShopifyOrder): void {
  const a = bindOdooShipmentAccountingSource(saved);
  const b = bindOdooShipmentAccountingSource(fresh);
  if (a.shopifyOrderId !== b.shopifyOrderId || a.orderName !== b.orderName || a.shippingHash !== b.shippingHash) {
    if(isApprovedBotFollowupAccountingPair(a,b))return;
    throw new Error(`AUTOMATION_REVIEW_REQUIRED: Accounting money/products/address/customization changed: ${saved.name}`);
  }
}
