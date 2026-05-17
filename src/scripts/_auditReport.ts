/**
 * READ-ONLY audit report
 * - Shopify mark-as-paid failures
 * - Photo Keychain SKU investigation
 * - Failed records summary
 */
import { prisma } from '../lib/prisma.js';

console.log('\n████████████████████████████████████████████████████████████');
console.log('   READ-ONLY AUDIT REPORT');
console.log('████████████████████████████████████████████████████████████\n');

// ──────────────────────────────────────────────────────────────────
// TASK 3: Shopify mark-as-paid failures
// ──────────────────────────────────────────────────────────────────
console.log('🔍 TASK 3: Shopify mark-as-paid failures\n');

const shopifyFails = await prisma.failedPayload.findMany({
  where: { source: 'shopify-mark-as-paid' },
  orderBy: { createdAt: 'desc' }
});

console.log(`  Total failures: ${shopifyFails.length}`);

// Get unique order numbers
const uniqueOrders = new Set<string>();
const reasons = new Map<string, number>();
for (const f of shopifyFails) {
  if (f.externalId) uniqueOrders.add(f.externalId);
  const key = f.reason.slice(0, 100);
  reasons.set(key, (reasons.get(key) || 0) + 1);
}

console.log(`  Unique orders affected: ${uniqueOrders.size}`);
console.log('\n  Exact userErrors:');
for (const [reason, count] of reasons) {
  console.log(`    ${count}× "${reason}"`);
}

// Sample order numbers (look up shopifyOrderName)
console.log('\n  Sample order numbers (last 5):');
for (const f of shopifyFails.slice(0, 5)) {
  if (!f.externalId) continue;
  const r = await prisma.shipmentRecord.findUnique({
    where: { shopifyOrderId: f.externalId },
    select: { shopifyOrderName: true, collectedAmount: true }
  });
  console.log(`    ${r?.shopifyOrderName ?? f.externalId}: $${r?.collectedAmount ?? '?'}`);
}

console.log('\n  Likely cause: COD orders have financial_status=pending but 0 transactions');
console.log('  Shopify orderMarkAsPaid requires existing pending transaction');
console.log('  Recommended next action: discuss alternative — NOT implemented yet');

// ──────────────────────────────────────────────────────────────────
// TASK 4: Photo Keychain SKU
// ──────────────────────────────────────────────────────────────────
console.log('\n\n🔍 TASK 4: Photo Keychain SKU inspection\n');

const skuFails = await prisma.failedPayload.findMany({
  where: { reason: { contains: 'Photo keychain' } },
  orderBy: { createdAt: 'desc' }
});

console.log(`  Total SKU-related failures: ${skuFails.length}`);

// Get sample orders to inspect line item details
const sampleOrderIds = [...new Set(skuFails.map(f => f.externalId).filter(Boolean))].slice(0, 3);
console.log(`  Unique orders blocked: ${sampleOrderIds.length}`);

for (const orderId of sampleOrderIds) {
  const r = await prisma.shipmentRecord.findUnique({
    where: { shopifyOrderId: orderId! },
    select: { shopifyOrderName: true, rawOrderJson: true }
  });
  if (!r?.rawOrderJson) continue;
  const order = JSON.parse(r.rawOrderJson);
  console.log(`\n  ${r.shopifyOrderName}:`);
  for (const item of order.line_items ?? []) {
    if (/photo.*keychain|keychain.*photo/i.test(item.title ?? '')) {
      console.log(`    Line item: "${item.title}"`);
      console.log(`      product_id: ${item.product_id ?? 'null'}`);
      console.log(`      variant_id: ${item.variant_id ?? 'null'}`);
      console.log(`      SKU: ${item.sku ?? 'NULL/EMPTY ❌'}`);
      console.log(`      vendor: ${item.vendor ?? 'null'}`);
    }
  }
}

console.log('\n  Safe to update? NO — needs human confirmation');
console.log('  Action required: Manually set SKU in Shopify product admin');

// ──────────────────────────────────────────────────────────────────
// TASK 5: Failed records summary
// ──────────────────────────────────────────────────────────────────
console.log('\n\n🔍 TASK 5: Failed/Problem records summary\n');

// Group by source
const allFailures = await prisma.failedPayload.groupBy({
  by: ['source'],
  _count: true,
  orderBy: { _count: { source: 'desc' } }
});

console.log('  Failed payloads by source:');
for (const f of allFailures) {
  console.log(`    ${f.source}: ${f._count}`);
}

// Status-based problems
const odooFailedRetryable = await prisma.shipmentRecord.count({
  where: { odooSyncStatus: 'odoo-failed-retryable' }
});
const odooFailed = await prisma.shipmentRecord.count({
  where: { odooSyncStatus: 'failed' }
});
const paymentReview = await prisma.shipmentRecord.count({
  where: { collectionStatus: 'payment-review' }
});
const deliveredNotCollected = await prisma.shipmentRecord.count({
  where: { collectionStatus: 'delivered-not-collected' }
});
const terminal = await prisma.shipmentRecord.count({
  where: { accurateIsTerminal: true }
});

console.log('\n  Problem record counts:');
console.log(`    Odoo failed (permanent): ${odooFailed}`);
console.log(`    Odoo failed (retryable): ${odooFailedRetryable}`);
console.log(`    Payment review needed: ${paymentReview}`);
console.log(`    Delivered NOT collected: ${deliveredNotCollected}`);
console.log(`    Terminal (excluded): ${terminal}`);

// Top examples for each
console.log('\n  Top examples (delivered-not-collected):');
const dncSample = await prisma.shipmentRecord.findMany({
  where: { collectionStatus: 'delivered-not-collected' },
  select: { shopifyOrderName: true, customerDue: true, deliveredAt: true },
  orderBy: { deliveredAt: 'desc' },
  take: 3
});
for (const r of dncSample) {
  console.log(`    ${r.shopifyOrderName}: customerDue=$${r.customerDue} | delivered=${r.deliveredAt?.toISOString().slice(0,10)}`);
}

const paymentReviewSample = await prisma.shipmentRecord.findMany({
  where: { collectionStatus: 'payment-review' },
  select: { shopifyOrderName: true, customerDue: true },
  take: 3
});
console.log('\n  Top examples (payment-review):');
for (const r of paymentReviewSample) {
  console.log(`    ${r.shopifyOrderName}: customerDue=$${r.customerDue}`);
}

await prisma.$disconnect();
