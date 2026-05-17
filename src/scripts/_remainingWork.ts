/**
 * What's still in the queue and when will it finish?
 */
import { prisma } from '../lib/prisma.js';

console.log('\n════════════════════════════════════════════════════════════');
console.log('   الطابور المتبقي - كام و امتى يخلصوا');
console.log('════════════════════════════════════════════════════════════\n');

const now = Date.now();

// QUEUE 1: Odoo background queue (process-odoo-queue, runs every 1 min)
console.log('🔄 QUEUE 1: process-odoo-queue (كل دقيقة)\n');
const odooQueue = await prisma.shipmentRecord.count({
  where: {
    odooSyncStatus: {
      in: ['odoo-so-pending', 'odoo-so-creating', 'odoo-stock-pending',
            'odoo-stock-preparing', 'odoo-delivery-pending', 'odoo-delivery-confirming',
            'odoo-failed-retryable']
    }
  }
});
console.log(`  Pending: ${odooQueue} orders`);
console.log(`  ✅ فاضي — لو جاء order جديد هيتعمل خلال دقيقة\n`);

// QUEUE 2: Open shipments waiting for status update from Telegraph
console.log('🔄 QUEUE 2: sync-open-shipments (كل 15 دقيقة)\n');
const openShipments = await prisma.shipmentRecord.findMany({
  where: {
    accurateShipmentId: { not: null },
    OR: [
      { accurateIsTerminal: null },
      { accurateIsTerminal: false }
    ]
  },
  select: {
    shopifyOrderName: true,
    accurateShipmentCode: true,
    accurateStatus: true,
    collectionStatus: true,
    odooInvoiceName: true,
    lastSyncedAt: true
  },
  orderBy: { updatedAt: 'asc' }
});

console.log(`  Total active shipments: ${openShipments.length}`);

// Categorize by state
const categories = {
  '⏳ PENDING (لسه ما شُحنش)': 0,
  '🚚 In transit (في الطريق)': 0,
  '✅ Delivered + Collected (محتاج invoice)': 0,
  '⚠️ Delivered + NOT collected (محتاج تحصيل)': 0,
  '🔄 Returned (محتاج bill)': 0,
  '❓ Other': 0
};

const inTransitStatuses = ['طلب شحن', 'تم الاستلام بالمخزن', 'مناولة بين الفروع - صادر', 'قيد التوصيل', 'انتظار لاعادة التوصيل'];

for (const s of openShipments) {
  if (s.collectionStatus === 'collected' && !s.odooInvoiceName) {
    categories['✅ Delivered + Collected (محتاج invoice)']++;
  } else if (s.collectionStatus === 'delivered-not-collected') {
    categories['⚠️ Delivered + NOT collected (محتاج تحصيل)']++;
  } else if (s.collectionStatus === 'returned' || s.collectionStatus === 'returned-settled') {
    categories['🔄 Returned (محتاج bill)']++;
  } else if (s.accurateStatus === 'PENDING') {
    categories['⏳ PENDING (لسه ما شُحنش)']++;
  } else if (inTransitStatuses.includes(s.accurateStatus ?? '')) {
    categories['🚚 In transit (في الطريق)']++;
  } else {
    categories['❓ Other']++;
  }
}

console.log('\n  Breakdown:');
for (const [cat, count] of Object.entries(categories)) {
  if (count > 0) console.log(`    ${cat}: ${count}`);
}

// What needs IMMEDIATE action
console.log('\n\n🎯 محتاج action في الـ runs الجاية:\n');

// Collected but no invoice
const collectedNoInvoice = openShipments.filter(s => 
  s.collectionStatus === 'collected' && !s.odooInvoiceName
);
console.log(`  ${collectedNoInvoice.length} orders جاهزين لـ invoice creation`);
for (const s of collectedNoInvoice.slice(0, 5)) {
  console.log(`    ${s.shopifyOrderName}: ${s.accurateShipmentCode}`);
}

// Returns pending bill
const returnsNoBill = await prisma.shipmentRecord.findMany({
  where: {
    OR: [{ collectionStatus: 'returned' }, { collectionStatus: 'returned-settled' }],
    odooReturnBillId: null
  },
  select: { shopifyOrderName: true, returnedValue: true }
});
console.log(`\n  ${returnsNoBill.length} returns جاهزين لـ bill creation`);
for (const r of returnsNoBill.slice(0, 5)) {
  console.log(`    ${r.shopifyOrderName}: $${r.returnedValue}`);
}

// V7 orders waiting for Telegraph delivery
const v7Pending = openShipments.filter(s => 
  s.accurateStatus === 'PENDING' || inTransitStatuses.includes(s.accurateStatus ?? '')
);

console.log(`\n  ${v7Pending.length} orders بتنتظر Telegraph (مفيش action من جهتنا)`);

// Sync timing predictions
console.log('\n\n⏰ توقعات الزمن:\n');

const collectedCount = collectedNoInvoice.length;
const returnsCount = returnsNoBill.length;
const totalActionable = collectedCount + returnsCount;

console.log(`  بـ batch size 30 و كل 15 دقيقة:`);
console.log(`    Actionable orders الآن: ${totalActionable}`);
console.log(`    Runs needed: ${Math.ceil(totalActionable / 30)} run`);
console.log(`    Time to clear: ~${Math.ceil(totalActionable / 30) * 15} دقيقة`);

console.log(`\n  للأوردرز اللي بتنتظر Telegraph (${v7Pending.length} order):`);
console.log(`    Telegraph عادة 1-3 أيام لتسليم + تحصيل`);
console.log(`    أوتو هيتعمله sync كل 15 دقيقة لما Telegraph يعمل update`);

// Next sync time
const nextSync = new Date();
nextSync.setMinutes(Math.ceil(nextSync.getMinutes() / 15) * 15, 0, 0);
const minsToNext = Math.round((nextSync.getTime() - now) / 60000);
console.log(`\n  ⏱️  Next sync-open-shipments run: في ${minsToNext} دقيقة (${nextSync.toISOString().slice(11, 16)} UTC)`);

await prisma.$disconnect();
