/**
 * Check actual return charge values for the 5 orders
 */
import { prisma } from '../lib/prisma.js';

const orderNames = ['#1841', '#1810', '#1789', '#1876', '#1786'];

console.log('\n══ Return Charge Values ════════════════════════════\n');

for (const name of orderNames) {
  const r = await prisma.shipmentRecord.findFirst({
    where: { shopifyOrderName: name },
    select: {
      shopifyOrderName: true,
      collectionStatus: true,
      customerDue: true,
      returningDueFees: true,
      returnFees: true,
      returnedValue: true,
      deliveryFees: true,
      collectedAmount: true,
      pendingCollectionAmount: true
    }
  });
  
  if (!r) continue;
  
  // Apply calculation
  let charge = 0;
  let reason = '';
  if (r.customerDue !== null && r.customerDue !== undefined) {
    const cd = Number(r.customerDue);
    if (cd > 0) { charge = 0; reason = 'customerDue > 0 → no charge'; }
    else if (cd < 0) { charge = Math.abs(cd); reason = `customerDue < 0 → ${Math.abs(cd)}`; }
    else {
      const rdf = Number(r.returningDueFees ?? 0);
      if (rdf > 0) { charge = rdf; reason = `returningDueFees=${rdf}`; }
      else { charge = 0; reason = 'customerDue=0, returningDueFees=0'; }
    }
  }
  
  console.log(`  ${r.shopifyOrderName}:`);
  console.log(`    customerDue=${r.customerDue} | returningDueFees=${r.returningDueFees}`);
  console.log(`    returnFees=${r.returnFees} | returnedValue=${r.returnedValue}`);
  console.log(`    deliveryFees=${r.deliveryFees} | collected=${r.collectedAmount}`);
  console.log(`    👉 Calculated charge: $${charge}`);
  console.log(`    👉 Reason: ${reason}`);
  console.log('');
}

await prisma.$disconnect();
