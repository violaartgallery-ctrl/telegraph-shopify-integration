/**
 * Smoke test (read-only + unit-style) for everything that was fixed in this session.
 *
 * 1. Unit: isTransientNetworkError covers the actual error strings we've seen.
 * 2. Unit: calculateNetMerchantDue gives the right numbers for known orders.
 * 3. Unit: OdooClient retry logic exists and wraps rpc().
 * 4. Unit: ensureSalesOrder option signature accepts skipDbStatusUpdate.
 * 5. Unit: V7 queue + admin routes pass skipDbStatusUpdate:true.
 * 6. Live (read-only): no V7 orphans currently stuck.
 * 7. Live (read-only): no `failed` records with recoverable shape.
 * 8. Live (read-only): no partial invoices on net-due records.
 * 9. Live (read-only): the known 8+1+10 batches are healthy.
 * 10. Live (read-only): queue health snapshot.
 *
 * No writes. Pure verification.
 */
import { readFileSync } from 'node:fs';
import { prisma } from '../lib/prisma.js';
import { OdooClient } from '../odoo/odooClient.js';
import {
  calculateNetMerchantDue,
  calculateMerchantInvoiceTarget,
  isTransientNetworkError
} from '../odoo/odooSyncService.js';

const odoo = new OdooClient();

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, hint?: string) {
  if (ok) {
    pass++;
    console.log('  ✅ ' + label);
  } else {
    fail++;
    failures.push(label + (hint ? ' — ' + hint : ''));
    console.log('  ❌ ' + label + (hint ? ' — ' + hint : ''));
  }
}

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  SMOKE TEST — everything fixed in this session');
console.log('══════════════════════════════════════════════════════════════\n');

// ─── Unit tests ──────────────────────────────────────────────────────
console.log('🧪 1. isTransientNetworkError');
const transientCases = ['fetch failed', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'socket hang up', 'network unreachable', '503 Service Unavailable', '504 Gateway Timeout', 'ECONNREFUSED'];
for (const m of transientCases) check(m, isTransientNetworkError(m));
const nonTransientCases = ['Invalid field "x"', 'Validation error: SKU required', 'No items available to invoice', 'Access Denied'];
for (const m of nonTransientCases) check('not transient: "' + m + '"', !isTransientNetworkError(m));

console.log('\n🧪 2. calculateNetMerchantDue');
check('670 − 71 = 599',          calculateNetMerchantDue({ collectedAmount: 670, deliveryFees: 71 }) === 599);
check('1450 − 76 = 1374',        calculateNetMerchantDue({ collectedAmount: 1450, deliveryFees: 76 }) === 1374);
check('null collected → null',   calculateNetMerchantDue({ collectedAmount: null,  deliveryFees: 71 }) === null);
check('null deliveryFees → null', calculateNetMerchantDue({ collectedAmount: 670,  deliveryFees: null }) === null);
check('negative net → null',     calculateNetMerchantDue({ collectedAmount: 50,   deliveryFees: 71 }) === null);

// ─── Source-code shape checks ────────────────────────────────────────
console.log('\n🧪 3. OdooClient retry');
const odooClientSrc = readFileSync('src/odoo/odooClient.ts', 'utf8');
check('isTransientRpcError exists', odooClientSrc.includes('isTransientRpcError'));
check('rpcOnce method extracted',   odooClientSrc.includes('rpcOnce'));
check('rpc() loops with retry',     /for \(let i = 0; i < attempts/.test(odooClientSrc));
check('exponential backoff used',   /Math\.pow\(2, i\)/.test(odooClientSrc));

console.log('\n🧪 4. ensureSalesOrder signature');
const syncSrc = readFileSync('src/odoo/odooSyncService.ts', 'utf8');
check('skipDbStatusUpdate option declared', /skipDbStatusUpdate\?: boolean/.test(syncSrc));
check('writeSaleOrderLink switches by skipDbStatusUpdate', /if \(options\.skipDbStatusUpdate\)/.test(syncSrc));
check('isTransientNetworkError used in catch', /isTransientNetworkError\(message\)/.test(syncSrc));
check('button_draft fallback exists', /button_draft/.test(syncSrc));
check('adjustDraftInvoiceLinesToTotal exists', /adjustDraftInvoiceLinesToTotal/.test(syncSrc));

console.log('\n🧪 5. Admin + cron callers pass skipDbStatusUpdate');
const adminSrc = readFileSync('src/routes/adminAppRoute.ts', 'utf8');
const queueSrc = readFileSync('src/netlify/functions/process-odoo-queue.ts', 'utf8');
const adminMatches = adminSrc.match(/skipDbStatusUpdate: true/g) ?? [];
const queueMatches = queueSrc.match(/skipDbStatusUpdate: true/g) ?? [];
check('adminAppRoute has 3 callers protected', adminMatches.length >= 3, 'found ' + adminMatches.length);
check('process-odoo-queue has all stages protected', queueMatches.length >= 3, 'found ' + queueMatches.length);
const syncCollectedHasFlag = /syncCollectedShipment[\s\S]+?ensureSalesOrder[\s\S]+?skipDbStatusUpdate: true/.test(syncSrc);
check('syncCollectedShipment passes skipDbStatusUpdate', syncCollectedHasFlag);

// ─── Live read-only checks ───────────────────────────────────────────
console.log('\n🩺 6. No V7 orphans currently stuck');
const orphanCount = await prisma.shipmentRecord.count({
  where: {
    odooSyncStatus: 'sales-order-created',
    accurateShipmentId: { not: null },
    odooSaleOrderId: { not: null },
    odooInvoiceId: null,
    odooPaymentId: null,
    odooSalePaymentId: null,
    NOT: { OR: [
      { collectionStatus: 'collected' },
      { collectionStatus: 'returned' },
      { collectionStatus: 'returned-settled' },
      { collectionStatus: 'payment-review' }
    ]}
  }
});
check('0 V7 orphans in DB', orphanCount === 0, 'found ' + orphanCount);

console.log('\n🩺 7. No recoverable failed records');
const failedRecoverable = await prisma.shipmentRecord.count({
  where: {
    odooSyncStatus: 'failed',
    accurateShipmentId: { not: null },
    odooInvoiceId: null,
    odooAttemptCount: { lt: 5 }
  }
});
check('0 recoverable failed records', failedRecoverable === 0, 'found ' + failedRecoverable);

console.log('\n🩺 8. No partial invoices on net-due records');
const paidRecs = await prisma.shipmentRecord.findMany({
  where: { odooSyncStatus: { in: ['paid', 'paid-existing'] }, odooInvoiceId: { not: null } },
  select: { shopifyOrderName: true, odooInvoiceId: true, collectedAmount: true, deliveryFees: true, customerDue: true }
});
const invIds = paidRecs.map((r) => r.odooInvoiceId!);
const invs = invIds.length === 0 ? [] : await odoo.searchRead<{ id: number; name?: string; payment_state?: string; amount_total?: number }>(
  'account.move',
  [['id', 'in', invIds]],
  ['name', 'payment_state', 'amount_total'],
  { limit: invIds.length }
);
const invMap = new Map(invs.map((i) => [i.id, i]));
let partial = 0;
const partialDetails: string[] = [];
for (const r of paidRecs) {
  const inv = invMap.get(r.odooInvoiceId!);
  if (!inv || inv.payment_state === 'paid') continue;
  // Use the unified merchant invoice target (matches what the live code now writes).
  const net = calculateMerchantInvoiceTarget({ collectedAmount: r.collectedAmount, deliveryFees: r.deliveryFees, customerDue: (r as { customerDue?: number | null }).customerDue });
  if (net === null) continue;
  if (Number(inv.amount_total ?? 0) > net + 0.01) {
    partial++;
    partialDetails.push((r.shopifyOrderName ?? '?') + '/' + inv.name);
  }
}
check('0 partial invoices', partial === 0, partial > 0 ? partialDetails.join(', ') : '');

console.log('\n🩺 9. Known recovered batches are at delivery-confirmed');
const knownBatch = ['#2036', '#2038', '#2040', '#2042', '#2043', '#2044', '#2047', '#2048', '#2049', '#2051', '#2080', '#2083', '#2086', '#2087', '#2088', '#2091', '#2097', '#2098', '#2104', '#1900'];
const recovered = await prisma.shipmentRecord.findMany({
  where: { shopifyOrderName: { in: knownBatch } },
  select: { shopifyOrderName: true, odooSyncStatus: true }
});
const notHealthy = recovered.filter((r) => r.odooSyncStatus !== 'delivery-confirmed' && r.odooSyncStatus !== 'paid' && r.odooSyncStatus !== 'paid-existing');
check(knownBatch.length + ' recovered records at delivery-confirmed/paid', notHealthy.length === 0, notHealthy.map((r) => (r.shopifyOrderName ?? '?') + '=' + r.odooSyncStatus).join(', '));

console.log('\n🩺 10. Queue health snapshot');
const states = await prisma.shipmentRecord.groupBy({
  by: ['odooSyncStatus'],
  _count: true,
  where: {
    odooSyncStatus: {
      in: ['odoo-so-pending', 'odoo-so-creating', 'odoo-stock-pending', 'odoo-stock-preparing',
            'odoo-delivery-pending', 'odoo-delivery-confirming', 'odoo-failed-retryable', 'failed']
    }
  }
});
let unhealthy = 0;
console.log('  Active queue states:');
for (const s of states) {
  const c = s._count;
  console.log('    ' + s.odooSyncStatus + ': ' + c);
  if (s.odooSyncStatus === 'failed') unhealthy += c;
}
check('0 records in `failed` state', unhealthy === 0, 'found ' + unhealthy);

// ─── Verdict ─────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('  Verdict');
console.log('══════════════════════════════════════════════════════════════');
console.log('  Passed: ' + pass);
console.log('  Failed: ' + fail);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  • ' + f);
}
console.log(fail === 0 ? '\n🟢 ALL GREEN' : '\n🔴 ISSUES FOUND');

await prisma.$disconnect();
process.exit(fail === 0 ? 0 : 1);
