/**
 * READ-ONLY: poll the 8 recovered orphans until all reach delivery-confirmed
 * or a stuck/failed state is detected.
 */
import { prisma } from '../lib/prisma.js';

const NAMES = ['#1841', '#1897', '#1905', '#1912', '#1933', '#1952', '#1955', '#1966'];
const TARGET = 'delivery-confirmed';
const POLL_MS = 60_000;       // every 60s
const MAX_WAIT_MS = 25 * 60 * 1000; // 25 minutes max

const start = Date.now();
let tick = 0;
let lastSnapshot = '';

while (true) {
  tick++;
  const rows = await prisma.shipmentRecord.findMany({
    where: { shopifyOrderName: { in: NAMES } },
    select: { shopifyOrderName: true, odooSyncStatus: true, odooLastError: true, odooSaleOrderName: true, updatedAt: true }
  });
  rows.sort((a, b) => (a.shopifyOrderName ?? '').localeCompare(b.shopifyOrderName ?? ''));

  const elapsed = Math.round((Date.now() - start) / 1000);
  const counts: Record<string, number> = {};
  for (const r of rows) {
    const s = r.odooSyncStatus ?? 'null';
    counts[s] = (counts[s] || 0) + 1;
  }

  const snap = rows.map((r) => r.shopifyOrderName + '=' + r.odooSyncStatus).join('|');
  if (snap !== lastSnapshot) {
    console.log('\n=== Tick ' + tick + ' (t+' + elapsed + 's) ===');
    for (const r of rows) {
      const err = r.odooLastError ? ' | err: ' + r.odooLastError.slice(0, 60) : '';
      console.log('  ' + (r.shopifyOrderName ?? '?').padEnd(8) + ' | ' + (r.odooSyncStatus ?? 'null').padEnd(28) + ' | ' + (r.odooSaleOrderName ?? '?') + err);
    }
    const summary = Object.entries(counts).map(([s, c]) => s + '=' + c).join(', ');
    console.log('  summary: ' + summary);
    lastSnapshot = snap;
  }

  const allDone = rows.every((r) => r.odooSyncStatus === TARGET);
  const anyFailed = rows.some((r) => r.odooSyncStatus === 'failed' || r.odooSyncStatus === 'odoo-failed-retryable');

  if (allDone) {
    console.log('\n✅ ALL 8 reached ' + TARGET + ' after ' + elapsed + 's');
    break;
  }
  if (anyFailed) {
    console.log('\n❌ One or more orders entered a failed state. Stopping.');
    break;
  }
  if (Date.now() - start > MAX_WAIT_MS) {
    console.log('\n⏱️  Max wait elapsed (' + (MAX_WAIT_MS / 60_000) + ' min) without full completion.');
    break;
  }

  await new Promise((r) => setTimeout(r, POLL_MS));
}

await prisma.$disconnect();
