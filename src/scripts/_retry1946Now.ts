import { prisma } from '../lib/prisma.js';

const result = await prisma.shipmentRecord.update({
  where: { shopifyOrderId: '10589568336164' },
  data: {
    odooRetryAt: new Date(Date.now() - 60_000),
    odooAttemptCount: 0
  },
  select: {
    shopifyOrderName: true,
    odooSyncStatus: true,
    odooLastError: true,
    odooRetryAt: true,
    odooAttemptCount: true
  }
});

console.log(result);
await prisma.$disconnect();
