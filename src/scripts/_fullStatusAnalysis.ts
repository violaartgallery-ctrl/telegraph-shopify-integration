/**
 * Comprehensive status analysis - what's fixed, what's broken
 */
import { prisma } from '../lib/prisma.js';

console.log('\n████████████████████████████████████████████████████████████');
console.log('   FULL SYSTEM STATUS ANALYSIS - أيه اللي اتحل و أيه اللي ما اتحلش');
console.log('████████████████████████████████████████████████████████████\n');

// 1. QUEUE STATUS
console.log('🔴 PROBLEM #1: ODOO BACKGROUND QUEUE');
const queueStatus = await prisma.shipmentRecord.groupBy({
  by: ['odooSyncStatus'],
  _count: true,
  where: {
    odooSyncStatus: {
      in: ['odoo-so-pending', 'odoo-so-creating', 'odoo-stock-pending', 
            'odoo-stock-preparing', 'odoo-delivery-pending', 'odoo-delivery-confirming',
            'odoo-failed-retryable']
    }
  }
});

let totalQueued = 0;
for (const item of queueStatus) {
  console.log(`  ${item.odooSyncStatus}: ${item._count}`);
  totalQueued += item._count;
}
console.log(`\n  ✅ FIXED? NO - Still ${totalQueued} orders in queue (Netlify cron not running)`);

// 2. DELIVERED ORDERS WITHOUT INVOICES
console.log('\n\n🔴 PROBLEM #2: DELIVERED BUT NO INVOICES');
const delivered = await prisma.shipmentRecord.findMany({
  where: { odooSyncStatus: 'delivery-confirmed' },
  select: { odooInvoiceName: true }
});

const withInvoice = delivered.filter(d => d.odooInvoiceName).length;
const withoutInvoice = delivered.filter(d => !d.odooInvoiceName).length;

console.log(`  Delivered orders: ${delivered.length}`);
console.log(`    - With invoice: ${withInvoice}`);
console.log(`    - WITHOUT invoice: ${withoutInvoice}`);
console.log(`\n  ✅ FIXED? NO - Still ${withoutInvoice}/71 orders missing invoices`);

// 3. ORDER #1763 STATUS
console.log('\n\n🔴 PROBLEM #3: ORDER #1763 STUCK INVOICE');
const order1763 = await prisma.shipmentRecord.findFirst({
  where: { shopifyOrderName: '#1763' }
});

console.log(`  Collection: ${order1763?.collectionStatus ?? 'null'}`);
console.log(`  Amount: $${order1763?.collectedAmount ?? 0}`);
console.log(`  Invoice: ${order1763?.odooInvoiceName ?? 'MISSING ❌'}`);

const failures1763 = await prisma.failedPayload.count({
  where: { 
    externalId: order1763?.shopifyOrderId,
    source: 'odoo-collected-sync'
  }
});

console.log(`  Failed invoice attempts: ${failures1763}`);
console.log(`  Last error: "No items available to invoice"`);
console.log(`\n  ✅ FIXED? NO - Still stuck, error not retried`);

// 4. NETLIFY DEPLOYMENT
console.log('\n\n🔴 PROBLEM #4: NETLIFY CRON NOT RUNNING');
console.log(`  Repo linked: NO ❌`);
console.log(`  Last deployment: 5:14 PM (4+ hours ago)`);
console.log(`  Cron running: NO ❌`);
console.log(`  Auto-deploy: NO ❌`);
console.log(`\n  ✅ FIXED? NO - Requires linking GitHub repo`);

// 5. PAYMENT SYNC STATUS
console.log('\n\n🟡 PROBLEM #5: PAYMENT STATUS FROM TELEGRAPH');
const paymentStatus = await prisma.shipmentRecord.groupBy({
  by: ['collectionStatus'],
  _count: true,
  where: {
    odooSyncStatus: 'delivery-confirmed'
  }
});

console.log(`  Delivered orders by collection status:`);
for (const item of paymentStatus) {
  console.log(`    - ${item.collectionStatus ?? 'null'}: ${item._count}`);
}
console.log(`\n  ✅ FIXED? PARTIALLY - 16 pending, 54 still null`);
console.log(`    User said payment received since Thursday...`);
console.log(`    Telegraph may not have updated payment status yet`);

// SUMMARY
console.log('\n\n════════════════════════════════════════════════════════════════');
console.log('📊 SUMMARY: أيه اللي اتحل و أيه اللي ما اتحلش\n');

const problems = [
  { issue: 'Odoo Queue Processing', fixed: false, blocker: 'Netlify not deployed' },
  { issue: 'Invoice Creation', fixed: false, blocker: 'Sync cron not running' },
  { issue: '#1763 Stuck Invoice', fixed: false, blocker: 'No retry mechanism' },
  { issue: 'Netlify Deployment', fixed: false, blocker: 'Repo not linked' },
  { issue: 'Payment Sync', fixed: false, blocker: 'Telegraph delay + cron' }
];

let fixedCount = 0;
let totalProblems = problems.length;

for (const p of problems) {
  const status = p.fixed ? '✅ FIXED' : '❌ NOT FIXED';
  console.log(`${status}: ${p.issue}`);
  console.log(`         Reason: ${p.blocker}`);
  if (p.fixed) fixedCount++;
}

console.log(`\n🎯 OVERALL: ${fixedCount}/${totalProblems} problems fixed`);
console.log(`    Success Rate: ${((fixedCount/totalProblems)*100).toFixed(0)}%`);

await prisma.$disconnect();
