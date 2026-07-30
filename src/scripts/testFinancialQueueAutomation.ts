import assert from 'node:assert/strict';
import {
  buildOdooCollectionFingerprint,
  buildShopifyPaymentFingerprint,
  isCompletedCollectedDiscoveryReplay,
  isLegacyNonShopifyShipmentCode,
  planHistoricalDiscoveryPages
} from '../services/shipmentStatusSyncService.js';
import { classifyFinancialHealth } from '../services/shipmentRepository.js';
import { classifyCollectedInvoiceVerification } from '../odoo/odooSyncService.js';

assert.equal(isLegacyNonShopifyShipmentCode('VI00000169'), true);
assert.equal(isLegacyNonShopifyShipmentCode('vi00000999'), true);
assert.equal(isLegacyNonShopifyShipmentCode('VI0002417'), false);
assert.equal(isLegacyNonShopifyShipmentCode('VI0002759'), false);

assert.deepEqual(planHistoricalDiscoveryPages(2, 35, 2), {
  pages: [2, 3],
  nextPage: 4,
  scanComplete: false
});
assert.deepEqual(planHistoricalDiscoveryPages(35, 35, 3), {
  pages: [35],
  nextPage: 2,
  scanComplete: true
});
assert.deepEqual(planHistoricalDiscoveryPages(99, 35, 2), {
  pages: [2, 3],
  nextPage: 4,
  scanComplete: false
});
assert.deepEqual(planHistoricalDiscoveryPages(2, 1, 2), {
  pages: [],
  nextPage: 2,
  scanComplete: true
});
assert.deepEqual(planHistoricalDiscoveryPages(7, 35, 0), {
  pages: [],
  nextPage: 7,
  scanComplete: false
});

// Timeout/resume: page 2 completed, the request died before page 3, therefore
// the next request resumes at page 3 instead of restarting the history at page 1.
const interruptedPlan = planHistoricalDiscoveryPages(2, 35, 2);
const persistedAfterFirstPage = interruptedPlan.pages[0]! + 1;
assert.deepEqual(planHistoricalDiscoveryPages(persistedAfterFirstPage, 35, 2).pages, [3, 4]);

const paymentA = buildShopifyPaymentFingerprint(1_318);
const paymentReplay = buildShopifyPaymentFingerprint(1_318);
const paymentChanged = buildShopifyPaymentFingerprint(1_030);
assert.equal(paymentA, paymentReplay);
assert.notEqual(paymentA, paymentChanged);

const odooA = buildOdooCollectionFingerprint({
  code: 'VI0002725',
  collectedAmount: 1_318,
  deliveryFees: 76,
  customerDue: 1_242
});
const odooReplay = buildOdooCollectionFingerprint({
  code: 'vi0002725',
  collectedAmount: 1_318,
  deliveryFees: 76,
  customerDue: 1_242
});
const odooChanged = buildOdooCollectionFingerprint({
  code: 'VI0002725',
  collectedAmount: 1_318,
  deliveryFees: 80,
  customerDue: 1_238
});
assert.equal(odooA, odooReplay);
assert.notEqual(odooA, odooChanged);

const completedReplayRecord = {
  accurateStatus: 'delivered',
  accurateStatusCode: 'DTR',
  accurateReturnStatus: null,
  accurateReturnStatusCode: null,
  accurateIsTerminal: true,
  collectionStatus: 'collected',
  trackingUrl: 'https://example.test/VI0002725',
  collectedAmount: 1_318,
  pendingCollectionAmount: 0,
  returnedValue: 0,
  deliveryFees: 76,
  returnFees: 0,
  returningDueFees: 0,
  customerDue: 1_242,
  deliveredAt: new Date('2026-07-20T12:00:00.000Z'),
  returnSyncStatus: 'superseded',
  shopifyPaymentSyncStatus: 'completed',
  shopifyPaymentFingerprint: paymentA,
  odooSyncStatus: 'paid',
  odooCollectionSyncStatus: 'completed',
  odooCollectionFingerprint: odooA
};
const completedReplaySnapshot = {
  accurateStatus: 'delivered',
  accurateStatusCode: 'DTR',
  accurateReturnStatus: null,
  accurateReturnStatusCode: null,
  accurateIsTerminal: true,
  collectionStatus: 'collected',
  trackingUrl: 'https://example.test/VI0002725',
  collectedAmount: 1_318,
  pendingCollectionAmount: 0,
  returnedValue: 0,
  deliveryFees: 76,
  returnFees: 0,
  returningDueFees: 0,
  customerDue: 1_242,
  deliveredAt: new Date('2026-07-20T12:00:00.000Z')
};
assert.equal(isCompletedCollectedDiscoveryReplay({
  record: completedReplayRecord,
  snapshot: completedReplaySnapshot,
  shopifyFingerprint: paymentA,
  odooFingerprint: odooA
}), true);
assert.equal(isCompletedCollectedDiscoveryReplay({
  record: completedReplayRecord,
  snapshot: { ...completedReplaySnapshot, collectedAmount: 1_300 },
  shopifyFingerprint: buildShopifyPaymentFingerprint(1_300),
  odooFingerprint: odooA
}), false);
assert.equal(isCompletedCollectedDiscoveryReplay({
  record: { ...completedReplayRecord, returnSyncStatus: 'pending' },
  snapshot: completedReplaySnapshot,
  shopifyFingerprint: paymentA,
  odooFingerprint: odooA
}), false);

assert.equal(classifyFinancialHealth({ backlog: 0, manualReview: 0, stuck: 0, failed: 0 }), 'healthy');
assert.equal(classifyFinancialHealth({ backlog: 12, manualReview: 0, stuck: 0, failed: 0 }), 'backlog-warning');
assert.equal(classifyFinancialHealth({ backlog: 12, manualReview: 2, stuck: 0, failed: 0 }), 'manual-review');
assert.equal(classifyFinancialHealth({ backlog: 0, manualReview: 2, stuck: 1, failed: 0 }), 'hard-failure');

assert.deepEqual(classifyCollectedInvoiceVerification({
  targetAmount: 1_114,
  actualAmount: 1_114,
  residual: 0,
  paymentState: 'paid'
}), { complete: true });
assert.deepEqual(classifyCollectedInvoiceVerification({
  targetAmount: 1_114,
  actualAmount: 1_114,
  residual: 0,
  paymentState: 'reversed'
}), { complete: false, reason: 'odoo-invoice-payment-reversed' });
assert.deepEqual(classifyCollectedInvoiceVerification({
  targetAmount: 3_419,
  actualAmount: 3_418.99,
  residual: 0,
  paymentState: 'paid'
}), { complete: true });
assert.deepEqual(classifyCollectedInvoiceVerification({
  targetAmount: 343,
  actualAmount: 343.02,
  residual: 0.02,
  paymentState: 'partial'
}), { complete: false, reason: 'odoo-invoice-total-mismatch' });

console.log('Financial queue automation self-test passed.');
