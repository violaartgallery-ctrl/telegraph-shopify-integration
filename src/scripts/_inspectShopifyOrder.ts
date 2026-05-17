/**
 * Look at the actual order data to see why mark-as-paid fails
 */
import { prisma } from '../lib/prisma.js';

// Get the failing orders
const failingOrders = [
  '10579038994724',
  '10581274198308',
  '10577011015972',
  '10573911261476',
  '10576657580324'
];

console.log('\n════════════════════════════════════════════════════════════');
console.log('   تحليل الـ rawOrderJson للأوردرز الفاشلة');
console.log('════════════════════════════════════════════════════════════\n');

for (const orderId of failingOrders) {
  const record = await prisma.shipmentRecord.findUnique({
    where: { shopifyOrderId: orderId }
  });
  
  if (!record || !record.rawOrderJson) continue;
  
  const order = JSON.parse(record.rawOrderJson);
  
  console.log(`\n📦 ${record.shopifyOrderName} (${orderId}):`);
  console.log(`   financial_status: ${order.financial_status}`);
  console.log(`   total_price: ${order.total_price}`);
  console.log(`   currency: ${order.currency}`);
  console.log(`   transactions count: ${order.transactions?.length ?? 0}`);
  console.log(`   gateway: ${order.gateway || order.payment_gateway_names?.join(',') || 'none'}`);
  console.log(`   collected: $${record.collectedAmount}`);
  console.log(`   odoo invoice: ${record.odooInvoiceName ?? 'NONE'}`);
  
  if (order.transactions) {
    for (const tx of order.transactions.slice(0, 3)) {
      console.log(`     TX: ${tx.kind} | status=${tx.status} | amount=${tx.amount}`);
    }
  }
}

await prisma.$disconnect();
