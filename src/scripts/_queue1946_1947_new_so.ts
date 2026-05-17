/**
 * One-time: the linked Odoo Sales Orders for #1946/#1947 were cancelled.
 * Keep the fresh Telegraph shipments, clear only Odoo links, and enqueue
 * the records so V7 queue creates new non-cancelled Sales Orders.
 */
import { prisma } from '../lib/prisma.js';

const ids = ['10589568336164', '10589613588772'];

for (const shopifyOrderId of ids) {
  const before = await prisma.shipmentRecord.findUnique({
    where: { shopifyOrderId },
    select: {
      shopifyOrderName: true,
      accurateShipmentCode: true,
      odooSaleOrderName: true,
      odooSyncStatus: true
    }
  });

  console.log(`\n${before?.shopifyOrderName ?? shopifyOrderId}`);
  console.log(`  shipment : ${before?.accurateShipmentCode ?? 'NULL'}`);
  console.log(`  old Odoo : ${before?.odooSaleOrderName ?? 'NULL'} / ${before?.odooSyncStatus ?? 'NULL'}`);

  const after = await prisma.shipmentRecord.update({
    where: { shopifyOrderId },
    data: {
      odooSaleOrderId: null,
      odooSaleOrderName: null,
      odooSyncStatus: 'odoo-so-pending',
      odooLastError: null,
      odooAttemptCount: 0,
      odooRetryAt: null,
      odooSyncedAt: new Date()
    },
    select: {
      shopifyOrderName: true,
      accurateShipmentCode: true,
      odooSaleOrderName: true,
      odooSyncStatus: true
    }
  });

  console.log(`  queued   : ${after.accurateShipmentCode ?? 'NULL'} / ${after.odooSyncStatus}`);
}

await prisma.$disconnect();
