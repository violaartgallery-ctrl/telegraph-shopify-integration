/**
 * Check for stuck processing records
 */
import { prisma } from '../lib/prisma.js';

// Check for stuck processing records
const processing = await prisma.shipmentRecord.findMany({
  where: {
    odooSyncStatus: {
      in: ['odoo-so-creating', 'odoo-stock-preparing', 'odoo-delivery-confirming']
    }
  },
  select: {
    id: true, shopifyOrderName: true, odooSyncStatus: true,
    odooAttemptCount: true, updatedAt: true
  }
});

console.log(`\n══ Stuck Processing Records (${processing.length}) ══════`);
for (const r of processing) {
  const stuckTime = Math.round((Date.now() - r.updatedAt.getTime()) / 1000 / 60);
  console.log(`  ${r.shopifyOrderName}: ${r.odooSyncStatus} (stuck ${stuckTime}min)`);
}

// Check failed records
const failed = await prisma.shipmentRecord.findMany({
  where: { odooSyncStatus: 'failed' },
  select: {
    id: true, shopifyOrderName: true, odooLastError: true,
    odooAttemptCount: true, updatedAt: true
  }
});

console.log(`\n══ Failed Records (${failed.length}) ══════`);
for (const r of failed) {
  console.log(`  ${r.shopifyOrderName}: attempts=${r.odooAttemptCount} | error=${r.odooLastError?.slice(0, 80) ?? 'none'}`);
}

await prisma.$disconnect();
