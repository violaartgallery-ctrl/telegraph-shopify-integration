/**
 * Backfill the historical Shopify orders that the OLD orderMarkAsPaid logic
 * couldn't handle. Walks each record once, calling the new Phase 1 / Phase 2
 * helpers directly. No Odoo writes; only Shopify-side actions.
 *
 * Categories:
 *   1. collected → recordCustomerPayment (with discount if needed)
 *   2. returned / returned-settled → cancelOrder
 *   3. delivered-not-collected → flagOrderForFollowUp
 *
 * Dry-run by default. Pass DRY=0 to apply.
 */
import { prisma } from '../lib/prisma.js';
import { shopifyStatusSyncClient } from '../shopify/shopifyStatusSyncClient.js';

const DRY = process.env.DRY !== '0';
const BATCH_LIMIT = Number(process.env.LIMIT ?? 100);

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  SHOPIFY LIFECYCLE BACKFILL  (' + (DRY ? 'DRY RUN' : 'WRITE') + ')');
console.log('══════════════════════════════════════════════════════════════\n');

const counters = { collectedPaid: 0, collectedDiscount: 0, returnedCancelled: 0, dncFlagged: 0, skipped: 0, failed: 0 };
const fails: string[] = [];

async function doCollected(): Promise<void> {
  const rows = await prisma.shipmentRecord.findMany({
    where: { collectionStatus: 'collected', shopifyOrderId: { not: '' } },
    select: { id: true, shopifyOrderId: true, shopifyOrderName: true, collectedAmount: true },
    take: BATCH_LIMIT
  });
  console.log('\n[collected] candidates: ' + rows.length);

  for (const r of rows) {
    const amount = Number(r.collectedAmount ?? 0);
    if (!amount || amount <= 0) { counters.skipped++; continue; }

    if (DRY) {
      const state = await shopifyStatusSyncClient.fetchOrderPaymentState(r.shopifyOrderId);
      if (!state || state.cancelledAt) { counters.skipped++; continue; }
      if (state.displayFinancialStatus && /paid/i.test(state.displayFinancialStatus) && state.totalOutstanding <= 0.01) { counters.skipped++; continue; }
      const gap = Number((state.totalPrice - amount).toFixed(2));
      if (gap > 0.01) { counters.collectedDiscount++; console.log('  [dry] ' + r.shopifyOrderName + ' → discount ' + gap + ' + pay ' + amount); }
      else { counters.collectedPaid++; console.log('  [dry] ' + r.shopifyOrderName + ' → pay ' + amount); }
      continue;
    }

    try {
      const result = await shopifyStatusSyncClient.recordCustomerPayment({
        orderId: r.shopifyOrderId, amount
      });
      if (result.skipped) {
        if (result.reason === 'needs-discount' && result.needsDiscountFor && result.total) {
          await shopifyStatusSyncClient.applyOrderDiscountAndPay({
            orderId: r.shopifyOrderId,
            discountAmount: result.needsDiscountFor,
            paymentAmount: amount,
            discountDescription: 'Telegraph collection adjustment'
          });
          counters.collectedDiscount++;
          console.log('  ✅ ' + r.shopifyOrderName + ' discount ' + result.needsDiscountFor + ' + pay ' + amount);
        } else {
          counters.skipped++;
        }
      } else {
        counters.collectedPaid++;
        console.log('  ✅ ' + r.shopifyOrderName + ' paid ' + amount);
      }
    } catch (e) {
      counters.failed++;
      const msg = e instanceof Error ? e.message : String(e);
      fails.push(r.shopifyOrderName + ': ' + msg);
      console.log('  ❌ ' + r.shopifyOrderName + ' — ' + msg);
    }
  }
}

async function doReturned(): Promise<void> {
  const rows = await prisma.shipmentRecord.findMany({
    where: { OR: [{ collectionStatus: 'returned' }, { collectionStatus: 'returned-settled' }], shopifyOrderId: { not: '' } },
    select: { id: true, shopifyOrderId: true, shopifyOrderName: true, collectionStatus: true },
    take: BATCH_LIMIT
  });
  console.log('\n[returned] candidates: ' + rows.length);

  for (const r of rows) {
    if (DRY) {
      const state = await shopifyStatusSyncClient.fetchOrderPaymentState(r.shopifyOrderId);
      if (!state) { counters.skipped++; continue; }
      if (state.cancelledAt) { counters.skipped++; continue; }
      counters.returnedCancelled++;
      console.log('  [dry] ' + r.shopifyOrderName + ' → cancel (' + r.collectionStatus + ')');
      continue;
    }
    try {
      const result = await shopifyStatusSyncClient.cancelOrder({
        orderId: r.shopifyOrderId,
        reason: 'OTHER',
        refund: false,
        restock: true,
        notifyCustomer: false,
        staffNote: 'Telegraph returned shipment (' + r.collectionStatus + ')'
      });
      if (result.skipped) counters.skipped++;
      else { counters.returnedCancelled++; console.log('  ✅ ' + r.shopifyOrderName + ' cancelled'); }
    } catch (e) {
      counters.failed++;
      const msg = e instanceof Error ? e.message : String(e);
      fails.push(r.shopifyOrderName + ': ' + msg);
      console.log('  ❌ ' + r.shopifyOrderName + ' — ' + msg);
    }
  }
}

async function doDnc(): Promise<void> {
  const rows = await prisma.shipmentRecord.findMany({
    where: { collectionStatus: 'delivered-not-collected', shopifyOrderId: { not: '' } },
    select: { id: true, shopifyOrderId: true, shopifyOrderName: true },
    take: BATCH_LIMIT
  });
  console.log('\n[delivered-not-collected] candidates: ' + rows.length);

  for (const r of rows) {
    if (DRY) { counters.dncFlagged++; console.log('  [dry] ' + r.shopifyOrderName + ' → flag'); continue; }
    try {
      await shopifyStatusSyncClient.flagOrderForFollowUp({
        orderId: r.shopifyOrderId,
        note: '⚠️ Telegraph delivered but customer did not pay. Business follow-up required.',
        tag: 'needs-collection-followup'
      });
      counters.dncFlagged++;
      console.log('  ✅ ' + r.shopifyOrderName + ' flagged');
    } catch (e) {
      counters.failed++;
      const msg = e instanceof Error ? e.message : String(e);
      fails.push(r.shopifyOrderName + ': ' + msg);
      console.log('  ❌ ' + r.shopifyOrderName + ' — ' + msg);
    }
  }
}

await doCollected();
await doReturned();
await doDnc();

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  Summary');
console.log('══════════════════════════════════════════════════════════════');
console.log('  collected paid (no discount): ' + counters.collectedPaid);
console.log('  collected paid + discount:    ' + counters.collectedDiscount);
console.log('  returned cancelled:           ' + counters.returnedCancelled);
console.log('  dnc flagged:                  ' + counters.dncFlagged);
console.log('  skipped (idempotent):         ' + counters.skipped);
console.log('  failed:                       ' + counters.failed);
if (fails.length > 0) { console.log('\nFailures:'); for (const f of fails.slice(0, 20)) console.log('  ' + f); }

await prisma.$disconnect();
