/**
 * Deep analysis of order #1763 - collected but no invoice
 */
import { prisma } from '../lib/prisma.js';

// Get the record
const record = await prisma.shipmentRecord.findFirst({
  where: { shopifyOrderName: '#1763' }
});

if (!record) {
  console.log('Order #1763 not found');
  await prisma.$disconnect();
  process.exit(1);
}

console.log(`\n══ ORDER #1763 DETAILED ANALYSIS ════════════════════════\n`);
console.log(`General Info:`);
console.log(`  shopifyOrderName: ${record.shopifyOrderName}`);
console.log(`  odooSyncStatus: ${record.odooSyncStatus}`);
console.log(`  odooSaleOrderName: ${record.odooSaleOrderName}`);
console.log(`  odooInvoiceName: ${record.odooInvoiceName ?? 'MISSING ❌'}`);

console.log(`\nTelegraph/Collection Info:`);
console.log(`  accurateShipmentCode: ${record.accurateShipmentCode}`);
console.log(`  collectionStatus: ${record.collectionStatus}`);
console.log(`  collectedAmount: $${record.collectedAmount ?? 0}`);
console.log(`  deliveredAt: ${record.deliveredAt?.toISOString() ?? 'unknown'}`);

console.log(`\nOdoo Sync Info:`);
console.log(`  odooSyncStatus: ${record.odooSyncStatus}`);
console.log(`  odooLastError: ${record.odooLastError ?? 'none'}`);
console.log(`  odooAttemptCount: ${record.odooAttemptCount}`);
console.log(`  odooSyncedAt: ${record.odooSyncedAt?.toISOString()}`);

// Check failed payloads
const failures = await prisma.failedPayload.findMany({
  where: { externalId: record.shopifyOrderId },
  orderBy: { createdAt: 'desc' }
});

console.log(`\nFailed Payloads (${failures.length}):`);
for (const f of failures.slice(0, 5)) {
  console.log(`  ${f.createdAt.toISOString().slice(0, 16)} | source=${f.source}`);
  console.log(`    → ${f.reason}`);
}

await prisma.$disconnect();
