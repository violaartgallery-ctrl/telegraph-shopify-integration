/**
 * Undo the accidental marking-as-terminal for V7 shipments (VI0000400+)
 * that were wrongly marked terminal because account has write-only permissions.
 * These shipments are still active and should remain in the sync queue.
 */
import { prisma } from '../lib/prisma.js';

// Un-terminal records that were just marked (these are our own V7 shipments)
// Keep the old-account ones (VI0000372-383) as terminal since they're V6 leftovers
// with old account that truly can't be tracked
const result = await prisma.shipmentRecord.updateMany({
  where: {
    accurateIsTerminal: true,
    accurateShipmentCode: {
      in: ['VI0000400', 'VI0000401', 'VI0000402', 'VI0000403', 'VI0000404', 'VI0000405', 'VI0000406', 'VI0000407']
    }
  },
  data: {
    accurateIsTerminal: false,
    lastError: null
  }
});

console.log(`Un-marked ${result.count} V7 shipments from terminal status`);

// Show current terminal records
const terminal = await prisma.shipmentRecord.findMany({
  where: { accurateIsTerminal: true },
  select: { shopifyOrderName: true, accurateShipmentCode: true, lastError: true }
});

console.log(`\nCurrently terminal (${terminal.length} records):`);
for (const r of terminal) {
  console.log(`  ${r.shopifyOrderName}: ${r.accurateShipmentCode} — ${r.lastError?.slice(0, 80)}`);
}

await prisma.$disconnect();
