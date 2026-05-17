/**
 * READ+WRITE test: verifies recoverStuckProcessingRecords works correctly.
 *
 * Uses order #1988 (already delivery-confirmed) as guinea pig:
 * 1. Forces it into 'odoo-stock-preparing' with an old odooSyncedAt
 * 2. Calls recoverStuckProcessingRecords(0) — threshold 0 minutes = recover everything
 * 3. Verifies it came back to 'odoo-stock-pending'
 * 4. Restores it to 'delivery-confirmed'
 */

import { prisma } from '../lib/prisma.js';
import { shipmentRepository } from '../services/shipmentRepository.js';

const ORDER_NAME = '#1988';

// ── Step 1: Find the record ───────────────────────────────────────────────────
const record = await prisma.shipmentRecord.findFirst({ where: { shopifyOrderName: ORDER_NAME } });
if (!record) { console.error('❌ Record not found'); process.exit(1); }

console.log(`\nUsing record id=${record.id} (${ORDER_NAME})`);
console.log(`  original status: ${record.odooSyncStatus}`);

// ── Step 2: Force into stuck state (old timestamp) ───────────────────────────
const STUCK_TS = new Date(Date.now() - 15 * 60_000); // 15 minutes ago
await prisma.shipmentRecord.update({
  where: { id: record.id },
  data: { odooSyncStatus: 'odoo-stock-preparing', odooSyncedAt: STUCK_TS }
});
console.log(`\n  Forced to: odoo-stock-preparing  (odooSyncedAt = 15 min ago)`);

// Verify stuck state
const afterStuck = await prisma.shipmentRecord.findUnique({ where: { id: record.id }, select: { odooSyncStatus: true, odooSyncedAt: true } });
console.log(`  Verified  : ${afterStuck?.odooSyncStatus} at ${afterStuck?.odooSyncedAt?.toISOString()}`);

// ── Step 3: Run recovery (threshold = 0 = recover anything > 0 minutes old) ──
console.log('\n  Running recoverStuckProcessingRecords(0)...');
const recovered = await shipmentRepository.recoverStuckProcessingRecords(0);
console.log(`  Recovered : ${recovered} record(s)`);

// ── Step 4: Verify recovery ────────────────────────────────────────────────────
const afterRecovery = await prisma.shipmentRecord.findUnique({ where: { id: record.id }, select: { odooSyncStatus: true } });
const recoveryOk = afterRecovery?.odooSyncStatus === 'odoo-stock-pending';
console.log(`  Status now: ${afterRecovery?.odooSyncStatus}  ${recoveryOk ? '✅ CORRECT' : '❌ WRONG — expected odoo-stock-pending'}`);

// ── Test odoo-so-creating recovery ──────────────────────────────────────────
await prisma.shipmentRecord.update({
  where: { id: record.id },
  data: { odooSyncStatus: 'odoo-so-creating', odooSyncedAt: STUCK_TS }
});
const r2 = await shipmentRepository.recoverStuckProcessingRecords(0);
const after2 = await prisma.shipmentRecord.findUnique({ where: { id: record.id }, select: { odooSyncStatus: true } });
console.log(`\n  odoo-so-creating → ${after2?.odooSyncStatus}  ${after2?.odooSyncStatus === 'odoo-so-pending' ? '✅' : '❌'} (recovered ${r2})`);

// ── Test odoo-delivery-confirming recovery ────────────────────────────────────
await prisma.shipmentRecord.update({
  where: { id: record.id },
  data: { odooSyncStatus: 'odoo-delivery-confirming', odooSyncedAt: STUCK_TS }
});
const r3 = await shipmentRepository.recoverStuckProcessingRecords(0);
const after3 = await prisma.shipmentRecord.findUnique({ where: { id: record.id }, select: { odooSyncStatus: true } });
console.log(`  odoo-delivery-confirming → ${after3?.odooSyncStatus}  ${after3?.odooSyncStatus === 'odoo-delivery-pending' ? '✅' : '❌'} (recovered ${r3})`);

// ── Test: fresh stuck record (< 10 min) should NOT be recovered ──────────────
await prisma.shipmentRecord.update({
  where: { id: record.id },
  data: { odooSyncStatus: 'odoo-stock-preparing', odooSyncedAt: new Date() } // now = fresh
});
const r4 = await shipmentRepository.recoverStuckProcessingRecords(10); // threshold = 10 min
const after4 = await prisma.shipmentRecord.findUnique({ where: { id: record.id }, select: { odooSyncStatus: true } });
console.log(`\n  Fresh odoo-stock-preparing (threshold 10min) → ${after4?.odooSyncStatus}  ${after4?.odooSyncStatus === 'odoo-stock-preparing' ? '✅ NOT recovered (correct)' : '❌ Was recovered (wrong)'} (recovered ${r4})`);

// ── Step 5: Restore original state ────────────────────────────────────────────
await prisma.shipmentRecord.update({
  where: { id: record.id },
  data: {
    odooSyncStatus: record.odooSyncStatus,
    odooSyncedAt: record.odooSyncedAt
  }
});
const restored = await prisma.shipmentRecord.findUnique({ where: { id: record.id }, select: { odooSyncStatus: true } });
console.log(`\n  Restored to: ${restored?.odooSyncStatus}  ✅`);

console.log('\n══ recoverStuckProcessingRecords TEST COMPLETE ══\n');

await prisma.$disconnect();
