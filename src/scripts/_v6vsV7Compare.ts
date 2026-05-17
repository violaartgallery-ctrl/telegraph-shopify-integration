/**
 * V6 vs V7 - the core architectural difference
 */
import { prisma } from '../lib/prisma.js';

console.log('\n════════════════════════════════════════════════════════════');
console.log('   V6 vs V7 - الفرق المعماري');
console.log('════════════════════════════════════════════════════════════\n');

console.log('📚 OLD V6 FLOW (236 orders):');
console.log('  Order → Shipment → ⏳ wait Telegraph');
console.log('  Telegraph collects $ → Create SO + Invoice + Payment together');
console.log('  Status: sales-order-created OR paid');
console.log('  ✅ Invoice = guaranteed by the time SO is created\n');

console.log('🆕 NEW V7 FLOW (76 orders):');
console.log('  Order → Create SO IMMEDIATELY (Stage 1)');
console.log('       → Prepare stock (Stage 2)');
console.log('       → Confirm delivery in Odoo (Stage 3) → delivery-confirmed');
console.log('  ⏳ wait Telegraph to physically deliver + collect');
console.log('  Telegraph collects $ → sync-open-shipments creates invoice');
console.log('  ❌ V7 orders STUCK at delivery-confirmed until Telegraph collects\n');

// Calculate V7 timing
const v7Orders = await prisma.shipmentRecord.findMany({
  where: { odooSyncStatus: 'delivery-confirmed' },
  select: {
    shopifyOrderName: true,
    createdAt: true,
    accurateStatus: true,
    collectionStatus: true,
    deliveredAt: true
  }
});

const now = Date.now();
const stages: Record<string, number> = {
  'PENDING (not shipped yet)': 0,
  'In transit': 0,
  'Delivered (not collected)': 0,
  'Other': 0
};

const transitStatuses = ['طلب شحن', 'تم الاستلام بالمخزن', 'مناولة بين الفروع - صادر', 'قيد التوصيل', 'انتظار لاعادة التوصيل'];
const deliveredStatuses = ['تم التسليم', 'تم الارجاع للراسل', 'لم يتم التسليم'];

for (const o of v7Orders) {
  if (o.accurateStatus === 'PENDING') stages['PENDING (not shipped yet)']++;
  else if (transitStatuses.includes(o.accurateStatus ?? '')) stages['In transit']++;
  else if (deliveredStatuses.includes(o.accurateStatus ?? '')) stages['Delivered (not collected)']++;
  else stages['Other']++;
}

console.log('📦 Where are the 76 V7 orders RIGHT NOW (Telegraph side)?');
for (const [stage, count] of Object.entries(stages)) {
  const pct = (count / 76 * 100).toFixed(1);
  console.log(`  ${stage}: ${count} (${pct}%)`);
}

console.log('\n\n🎯 الواقع:');
console.log('  V7 orders اتعمل لها SO+delivery في Odoo بسرعة ✅');
console.log('  لكن لسه Telegraph بيشحن وبيوصل ⏳');
console.log('  لما Telegraph يحصّل الفلوس → invoice هيتعمل');
console.log('  المشكلة: عملية sync بطيئة + V7 orders جديدة');

// Calculate ages of V7 orders
console.log('\n\n📊 V7 orders age:');
const ageBuckets: Record<string, number> = { 'today': 0, '1-2 days': 0, '3-5 days': 0, '6+ days': 0 };
for (const o of v7Orders) {
  const ageHours = (now - o.createdAt.getTime()) / 3600000;
  if (ageHours < 24) ageBuckets.today++;
  else if (ageHours < 48) ageBuckets['1-2 days']++;
  else if (ageHours < 120) ageBuckets['3-5 days']++;
  else ageBuckets['6+ days']++;
}

for (const [bucket, count] of Object.entries(ageBuckets)) {
  console.log(`  ${bucket}: ${count}`);
}

console.log('\n  ℹ️  Telegraph عادة بياخد 1-3 أيام للتوصيل + تحصيل');
console.log('  ℹ️  لو الأوردر اتعمل اليوم → invoice المتوقع خلال 24-72 ساعة');

await prisma.$disconnect();
