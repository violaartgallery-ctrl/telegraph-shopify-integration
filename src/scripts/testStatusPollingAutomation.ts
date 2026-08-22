import assert from 'node:assert/strict';
import {
  isCollectedAfterPaidReturnChargeConflict,
  mergeAccurateSnapshot
} from '../services/shipmentRepository.js';
import { projectPersistedAccurateState } from '../services/shipmentStatusSyncService.js';
import {
  STATUS_POLL_QUARANTINE_PREFIX,
  STATUS_POLL_RETRY_PREFIX,
  buildStatusPollingQuarantineReason,
  buildStatusPollingRetryReason,
  isOlderThanStatusPollingCutoff,
  isStatusPollingDiagnostic,
  isStatusPollingQuarantined
} from '../services/statusPollingPolicy.js';

const preservedCollection = mergeAccurateSnapshot({
  accurateStatus: 'delivered',
  accurateStatusCode: 'DTR',
  accurateIsTerminal: false,
  collectionStatus: 'collected',
  collectedAmount: 750
}, {
  accurateStatus: 'delivered',
  accurateStatusCode: 'DTR',
  accurateIsTerminal: true,
  collectionStatus: 'collected',
  collectedAmount: 750
});

assert.equal(preservedCollection.collectionStatus, 'collected');
assert.equal(preservedCollection.accurateIsTerminal, true);

const staleOrdinaryLookup = mergeAccurateSnapshot({
  accurateStatus: 'delivered',
  accurateStatusCode: 'DTR',
  accurateIsTerminal: true,
  collectionStatus: 'collected',
  collectedAmount: 920
}, {
  accurateStatus: 'delivered',
  accurateStatusCode: 'DTR',
  accurateIsTerminal: false,
  collectionStatus: 'delivered-not-collected',
  collectedAmount: 920,
  customerDue: 849
});
const staleOrdinaryDecision = projectPersistedAccurateState(staleOrdinaryLookup);
assert.equal(staleOrdinaryLookup.collectionStatus, 'collected');
assert.equal(staleOrdinaryDecision.collectionStatus, 'collected');
assert.equal(staleOrdinaryDecision.isTerminal, true);

const explicitReturn = mergeAccurateSnapshot({
  accurateStatus: 'delivered',
  accurateStatusCode: 'DTR',
  accurateIsTerminal: true,
  collectionStatus: 'collected',
  collectedAmount: 750
}, {
  accurateStatus: 'returned',
  accurateStatusCode: 'RTRN',
  accurateIsTerminal: true,
  collectionStatus: 'returned',
  collectedAmount: 0
});

assert.equal(explicitReturn.collectionStatus, 'returned');
assert.equal(explicitReturn.accurateStatusCode, 'RTRN');

assert.equal(isCollectedAfterPaidReturnChargeConflict('returned-charge-paid'), true);
assert.equal(isCollectedAfterPaidReturnChargeConflict(' RETURNED-CHARGE-PAID '), true);
assert.equal(isCollectedAfterPaidReturnChargeConflict('paid'), false);
assert.equal(isCollectedAfterPaidReturnChargeConflict(null), false);

const retry = buildStatusPollingRetryReason(' exact lookup   missed ');
const quarantined = buildStatusPollingQuarantineReason('complete catalog scan missed the code');
assert.equal(retry.startsWith(STATUS_POLL_RETRY_PREFIX), true);
assert.equal(quarantined.startsWith(STATUS_POLL_QUARANTINE_PREFIX), true);
assert.equal(isStatusPollingDiagnostic(retry), true);
assert.equal(isStatusPollingDiagnostic(quarantined), true);
assert.equal(isStatusPollingQuarantined(retry), false);
assert.equal(isStatusPollingQuarantined(quarantined), true);
assert.equal(isStatusPollingDiagnostic('ordinary shipment error'), false);

const cutoff = new Date('2026-08-08T00:00:00.000Z');
assert.equal(isOlderThanStatusPollingCutoff(
  new Date('2026-07-01T00:00:00.000Z'),
  new Date('2026-08-07T23:59:59.000Z'),
  cutoff
), true);
assert.equal(isOlderThanStatusPollingCutoff(
  new Date('2026-07-01T00:00:00.000Z'),
  new Date('2026-08-08T00:00:00.000Z'),
  cutoff
), false);

console.log('Status polling automation self-test passed.');
