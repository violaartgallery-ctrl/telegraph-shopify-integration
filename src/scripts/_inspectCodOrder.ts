import { prisma } from '../lib/prisma.js';

const r = await prisma.shipmentRecord.findFirst({
  where: { shopifyOrderName: '#2580' },
  select: { shopifyOrderId: true, rawOrderJson: true, collectedAmount: true }
});
if (!r?.rawOrderJson) { console.log('not found'); process.exit(0); }

const order = JSON.parse(r.rawOrderJson);
console.log('Order:', '#2580');
console.log('  financial_status: ', order.financial_status);
console.log('  total_price:      ', order.total_price);
console.log('  gateway:          ', order.gateway || order.payment_gateway_names?.join(','));
console.log('  transactions:     ', order.transactions?.length ?? 0);
console.log('  current_total_set:', order.current_total_set?.shop_money?.amount);
console.log('\nCollected from Telegraph:', r.collectedAmount);

await prisma.$disconnect();
