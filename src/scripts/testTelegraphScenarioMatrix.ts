import { projectAccurateStatusToShopify } from '../services/accurateStatusMapper.js';
import { calculateTelegraphMerchantPaymentAmount, calculateTelegraphReturnCharge } from '../odoo/odooSyncService.js';

interface Scenario {
  name: string;
  statusCode: string;
  collected?: boolean;
  paidToCustomer?: boolean;
  cancelled?: boolean;
  customerDue?: number;
  expectedCollectionStatus: string;
  expectedTerminal: boolean;
  expectedTags: string[];
}

const assert = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

const scenarios: Scenario[] = [
  {
    name: 'pickup request',
    statusCode: 'PKR',
    expectedCollectionStatus: 'pending',
    expectedTerminal: false,
    expectedTags: ['accurate-pkr']
  },
  {
    name: 'received in warehouse',
    statusCode: 'RITS',
    expectedCollectionStatus: 'pending',
    expectedTerminal: false,
    expectedTags: ['accurate-received']
  },
  {
    name: 'branch transfer',
    statusCode: 'BMT',
    expectedCollectionStatus: 'pending',
    expectedTerminal: false,
    expectedTags: ['accurate-scheduled']
  },
  {
    name: 'out for delivery',
    statusCode: 'OTD',
    expectedCollectionStatus: 'pending',
    expectedTerminal: false,
    expectedTags: ['accurate-out-for-delivery']
  },
  {
    name: 'delivery exception',
    statusCode: 'DEX',
    expectedCollectionStatus: 'pending',
    expectedTerminal: false,
    expectedTags: ['accurate-delivery-exception']
  },
  {
    name: 'waiting for redelivery',
    statusCode: 'HTR',
    expectedCollectionStatus: 'pending',
    expectedTerminal: false,
    expectedTags: ['accurate-redelivery-pending']
  },
  {
    name: 'delivered but not collected',
    statusCode: 'DTR',
    collected: false,
    expectedCollectionStatus: 'delivered-not-collected',
    expectedTerminal: false,
    expectedTags: ['accurate-delivered', 'accurate-delivered-not-collected']
  },
  {
    name: 'delivered and collected',
    statusCode: 'DTR',
    collected: true,
    expectedCollectionStatus: 'collected',
    expectedTerminal: true,
    expectedTags: ['accurate-delivered', 'accurate-collected']
  },
  {
    name: 'delivered but needs payment review',
    statusCode: 'DTR',
    collected: true,
    customerDue: -67,
    expectedCollectionStatus: 'payment-review',
    expectedTerminal: true,
    expectedTags: ['accurate-delivered', 'accurate-payment-review']
  },
  {
    name: 'returned not settled',
    statusCode: 'RTRN',
    paidToCustomer: false,
    expectedCollectionStatus: 'returned',
    expectedTerminal: true,
    expectedTags: ['accurate-returned', 'accurate-returned-unsettled']
  },
  {
    name: 'returned settled',
    statusCode: 'RTRN',
    paidToCustomer: true,
    expectedCollectionStatus: 'returned-settled',
    expectedTerminal: true,
    expectedTags: ['accurate-returned', 'accurate-returned-settled']
  },
  {
    name: 'rejected',
    statusCode: 'RJCT',
    expectedCollectionStatus: 'returned',
    expectedTerminal: true,
    expectedTags: ['accurate-returned', 'accurate-returned-unsettled']
  },
  {
    name: 'manual cancelled flag',
    statusCode: 'PKR',
    cancelled: true,
    expectedCollectionStatus: 'cancelled',
    expectedTerminal: true,
    expectedTags: ['accurate-cancelled']
  }
];

for (const scenario of scenarios) {
  const projection = projectAccurateStatusToShopify({
    statusCode: scenario.statusCode,
    statusName: scenario.name,
    collected: scenario.collected,
    paidToCustomer: scenario.paidToCustomer,
    cancelled: scenario.cancelled,
    customerDue: scenario.customerDue
  });

  assert(
    projection.collectionStatus === scenario.expectedCollectionStatus,
    `${scenario.name}: expected collectionStatus ${scenario.expectedCollectionStatus}, got ${projection.collectionStatus}`
  );
  assert(
    projection.isTerminal === scenario.expectedTerminal,
    `${scenario.name}: expected terminal ${scenario.expectedTerminal}, got ${projection.isTerminal}`
  );
  for (const tag of scenario.expectedTags) {
    assert(projection.tags.includes(tag), `${scenario.name}: missing tag ${tag}`);
  }
}

const returnChargeCases = [
  { name: 'customer paid enough, no company charge', input: { customerDue: 11, returningDueFees: 65, returnFees: 65 }, expected: 0 },
  { name: 'return charge on us from customerDue', input: { customerDue: -65, returningDueFees: 65, returnFees: 65 }, expected: 65 },
  { name: 'fully neutral return', input: { customerDue: 0, returningDueFees: 0, returnFees: 65 }, expected: 0 },
  { name: 'legacy negative returnedValue fallback', input: { returnedValue: -90 }, expected: 90 },
  { name: 'legacy returningDueFees fallback when customerDue missing', input: { returningDueFees: 76, returnFees: 65 }, expected: 76 }
];

for (const testCase of returnChargeCases) {
  const actual = calculateTelegraphReturnCharge(testCase.input);
  assert(actual === testCase.expected, `${testCase.name}: expected ${testCase.expected}, got ${actual}`);
}

const paymentAmountCases = [
  { name: 'net merchant due after delivery fees', input: { residual: 1200, collectedAmount: 1270, deliveryFees: 71 }, expected: 1199 },
  { name: 'delivery fees exceed collected amount', input: { residual: 1200, collectedAmount: 50, deliveryFees: 71 }, expected: 0 },
  { name: 'zero delivery fees', input: { residual: 1200, collectedAmount: 1200, deliveryFees: 0 }, expected: 1200 },
  { name: 'missing delivery fees does not overpay', input: { residual: 1200, collectedAmount: 1270, deliveryFees: null }, expected: 0 },
  { name: 'missing collected amount does not overpay', input: { residual: 1200, collectedAmount: null, deliveryFees: 71 }, expected: 0 },
  { name: 'already smaller residual caps payment', input: { residual: 500, collectedAmount: 1270, deliveryFees: 71 }, expected: 500 },
  { name: 'explicit positive customer due wins', input: { residual: 1200, collectedAmount: 1270, deliveryFees: 71, customerDue: 1199 }, expected: 1199 },
  { name: 'negative customer due without safe collected data does not pay', input: { residual: 1200, collectedAmount: null, deliveryFees: 71, customerDue: -67 }, expected: 0 }
];

for (const testCase of paymentAmountCases) {
  const actual = calculateTelegraphMerchantPaymentAmount(testCase.input);
  assert(actual === testCase.expected, `${testCase.name}: expected ${testCase.expected}, got ${actual}`);
}

console.log(JSON.stringify({
  ok: true,
  statusScenarios: scenarios.length,
  returnChargeScenarios: returnChargeCases.length,
  paymentAmountScenarios: paymentAmountCases.length
}, null, 2));
