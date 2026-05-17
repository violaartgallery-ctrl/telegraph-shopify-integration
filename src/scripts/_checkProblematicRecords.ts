/**
 * Check records with unauthorized errors and invoice failures
 */
import { prisma } from '../lib/prisma.js';

// Unauthorized shipments
const unauthorizedCodes = ['VI0000372', 'VI0000378', 'VI0000382', 'VI0000383'];
const unauth = await prisma.shipmentRecord.findMany({
  where: { accurateShipmentCode: { in: unauthorizedCodes } },
  select: {
    id: true, shopifyOrderName: true, accurateShipmentCode: true,
    accurateStatus: true, collectionStatus: true, odooSyncStatus: true,
    accurateIsTerminal: true
  }
});

console.log('\n══ Unauthorized shipments (old account) ══════════════════');
for (const r of unauth) {
  console.log(`  ${r.shopifyOrderName}: ${r.accurateShipmentCode} | status=${r.accurateStatus} | collection=${r.collectionStatus ?? 'null'} | terminal=${r.accurateIsTerminal ?? 'null'}`);
}

// Cannot create invoice orders
const invoiceFails = await prisma.failedPayload.findMany({
  where: {
    source: 'odoo-collected-sync',
    reason: { contains: 'No items are available to invoice' }
  },
  orderBy: { createdAt: 'desc' },
  take: 20
});

console.log('\n══ "Cannot create invoice" failures ══════════════════════');
const seen = new Set<string>();
for (const f of invoiceFails) {
  if (!f.externalId) continue;
  if (seen.has(f.externalId)) continue;
  seen.add(f.externalId);
  const rec = await prisma.shipmentRecord.findUnique({
    where: { shopifyOrderId: f.externalId },
    select: { shopifyOrderName: true, odooSyncStatus: true, odooSaleOrderName: true, odooInvoiceName: true }
  });
  console.log(`  ${rec?.shopifyOrderName ?? f.externalId}: odooStatus=${rec?.odooSyncStatus ?? '?'} | SO=${rec?.odooSaleOrderName ?? '?'} | invoice=${rec?.odooInvoiceName ?? 'none'}`);
}

await prisma.$disconnect();
