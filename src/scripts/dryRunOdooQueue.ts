/**
 * DRY-RUN ONLY — reads the next 2 Odoo queue records and prints exactly
 * what the real queue processor WOULD do, without changing anything.
 *
 * SAFE: zero writes. No Odoo, no Shopify, no Telegraph, no DB mutations.
 *
 * Usage:
 *   npx tsx src/scripts/dryRunOdooQueue.ts
 *   npm run queue:dry-run
 */

import { prisma } from '../lib/prisma.js';

// ── Mirrors findPendingOdooQueue selection criteria ───────────────────────────
// (Uses Prisma directly so we can confirm it is read-only and nothing is called
//  through the repository layer that might accidentally write.)
const findQueue = async (limit: number) =>
  prisma.shipmentRecord.findMany({
    where: {
      accurateShipmentId: { not: null },
      rawOrderJson: { not: null },
      OR: [
        { odooSyncStatus: 'odoo-so-pending' },
        { odooSyncStatus: 'odoo-stock-pending' },
        { odooSyncStatus: 'odoo-delivery-pending' },
        {
          odooSyncStatus: 'odoo-failed-retryable',
          OR: [
            { odooRetryAt: null },
            { odooRetryAt: { lte: new Date() } }
          ]
        }
      ]
    },
    orderBy: [
      { odooRetryAt: 'asc' },
      { createdAt: 'asc' }
    ],
    take: limit,
    select: {
      id: true,
      shopifyOrderId: true,
      shopifyOrderNumber: true,
      shopifyOrderName: true,
      accurateShipmentId: true,
      accurateShipmentCode: true,
      accurateStatus: true,
      odooSyncStatus: true,
      odooLastError: true,
      odooAttemptCount: true,
      odooRetryAt: true,
      odooSaleOrderId: true,
      odooSaleOrderName: true,
      createdAt: true,
      updatedAt: true
      // rawOrderJson deliberately excluded from select — avoids printing megabytes
    }
  });

// ── Stage routing (mirrors process-odoo-queue.ts logic exactly) ───────────────
const PROCESSING_STATUS_MAP: Record<string, string> = {
  'odoo-so-pending':       'odoo-so-creating',
  'odoo-stock-pending':    'odoo-stock-preparing',
  'odoo-delivery-pending': 'odoo-delivery-confirming'
};

const NEXT_STATUS_MAP: Record<string, string> = {
  'odoo-so-pending':       'odoo-stock-pending',
  'odoo-stock-pending':    'odoo-delivery-pending',
  'odoo-delivery-pending': 'delivery-confirmed'
};

const ODOO_METHOD_MAP: Record<string, string> = {
  'odoo-so-pending':       'ensureSalesOrder(order, { prepareStock: false })',
  'odoo-stock-pending':    'prepareSalesOrderStock(saleOrderId)',
  'odoo-delivery-pending': 'confirmSalesOrderDelivery(saleOrderId)'
};

const cleanError = (err: string | null | undefined): string =>
  err ? err.replace(/^RETRY_FROM:[^|]+\|/, '') : '';

const formatRetryAt = (d: Date | null | undefined): string => {
  if (!d) return 'n/a';
  const diffMin = Math.round((d.getTime() - Date.now()) / 60_000);
  if (diffMin <= 0) return `OVERDUE (${d.toISOString()})`;
  return `in ${diffMin}m (${d.toISOString()})`;
};

type QRecord = Awaited<ReturnType<typeof findQueue>>[number];

const analyzeRecord = (record: QRecord): object => {
  const currentDbStatus = record.odooSyncStatus ?? 'odoo-so-pending';

  // Determine stage to run and claim-from status
  let stageToRun: string;
  let claimFromStatus: string;
  let retryFromParsed: string | null = null;

  if (currentDbStatus === 'odoo-failed-retryable') {
    const match = record.odooLastError?.match(/^RETRY_FROM:([^|]+)\|/);
    retryFromParsed = match?.[1] ?? null;
    stageToRun = retryFromParsed ?? 'odoo-so-pending';
    claimFromStatus = 'odoo-failed-retryable';
  } else {
    stageToRun = currentDbStatus;
    claimFromStatus = currentDbStatus;
  }

  const processingStatus = PROCESSING_STATUS_MAP[stageToRun] ?? '(unknown — would skip)';
  const nextStatusOnSuccess = NEXT_STATUS_MAP[stageToRun] ?? '(unknown)';
  const odooMethodToCall = ODOO_METHOD_MAP[stageToRun] ?? '(unknown — would log warn and skip)';
  const isUnknownStage = !(stageToRun in PROCESSING_STATUS_MAP);
  const maxAttemptsExceeded = (record.odooAttemptCount ?? 0) >= 5;
  const needsSaleOrderRecovery =
    (stageToRun === 'odoo-stock-pending' || stageToRun === 'odoo-delivery-pending') &&
    !record.odooSaleOrderId;

  return {
    // ── Identity
    orderName:        record.shopifyOrderName,
    orderNumber:      record.shopifyOrderNumber,
    shopifyOrderId:   record.shopifyOrderId,
    telegraphCode:    record.accurateShipmentCode,
    telegraphStatus:  record.accurateStatus,
    dbRecordId:       record.id,

    // ── Current Odoo state
    currentDbStatus,
    odooSaleOrderId:   record.odooSaleOrderId ?? null,
    odooSaleOrderName: record.odooSaleOrderName ?? null,
    odooAttemptCount:  record.odooAttemptCount ?? 0,
    odooRetryAt:       formatRetryAt(record.odooRetryAt),
    lastError:         cleanError(record.odooLastError) || null,
    retryFromParsed,

    // ── What the queue processor would do
    claimFromStatus,
    processingStatus,
    stageToRun,
    odooMethodToCall,
    nextStatusOnSuccess,
    needsSaleOrderRecovery,

    // ── Blockers
    wouldSkip: maxAttemptsExceeded || isUnknownStage,
    skipReason: maxAttemptsExceeded
      ? `Max attempts (${record.odooAttemptCount}/5) — would mark permanently failed`
      : isUnknownStage
        ? `Unknown stage '${stageToRun}' — would log warn and skip`
        : null,

    // ── Recovery note
    recoveryNote: needsSaleOrderRecovery
      ? 'odooSaleOrderId missing — would call ensureSalesOrder() first (idempotent), then updateOdooSaleOrderLink(), then proceed with stage'
      : null,

    // ── Timestamps
    createdAt:  record.createdAt.toISOString(),
    updatedAt:  record.updatedAt.toISOString()
  };
};

// ── Main ──────────────────────────────────────────────────────────────────────
const main = async () => {
  console.log('');
  console.log('════════════════════════════════════════════════════════════');
  console.log('  DRY-RUN: Odoo Queue Processor — READ ONLY, NO WRITES');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Timestamp : ${new Date().toISOString()}`);
  console.log(`  Looking   : next 2 records from Odoo queue`);
  console.log('');

  const records = await findQueue(2);

  if (records.length === 0) {
    console.log('  ⚠️  No queue records found.');
    console.log('  Possible reasons:');
    console.log('    - No orders with odooSyncStatus in [odoo-so-pending, odoo-stock-pending,');
    console.log('      odoo-delivery-pending, odoo-failed-retryable (due now)]');
    console.log('    - All pending records have a future odooRetryAt');
    console.log('    - accurateShipmentId or rawOrderJson is null for all candidates');
    console.log('');
    console.log('  DRY-RUN COMPLETE — 0 records found. Nothing would be processed.');
    return;
  }

  console.log(`  Found ${records.length} record(s) in queue.\n`);

  const analyses = records.map(analyzeRecord);

  for (let i = 0; i < analyses.length; i++) {
    const a = analyses[i] as Record<string, unknown>;
    console.log(`────────────────────────────────────────────────────────────`);
    console.log(`  Record ${i + 1} of ${analyses.length}`);
    console.log(`────────────────────────────────────────────────────────────`);
    console.log(`  Order Name          : ${a['orderName'] ?? '(none)'}`);
    console.log(`  Order Number        : ${a['orderNumber'] ?? '(none)'}`);
    console.log(`  Shopify Order ID    : ${a['shopifyOrderId']}`);
    console.log(`  DB Record ID        : ${a['dbRecordId']}`);
    console.log(`  Telegraph Code      : ${a['telegraphCode'] ?? '(none)'}`);
    console.log(`  Telegraph Status    : ${a['telegraphStatus'] ?? '(none)'}`);
    console.log('');
    console.log(`  ── Odoo State ──`);
    console.log(`  Current DB Status   : ${a['currentDbStatus']}`);
    console.log(`  Sale Order ID       : ${a['odooSaleOrderId'] ?? '(missing)'}`);
    console.log(`  Sale Order Name     : ${a['odooSaleOrderName'] ?? '(missing)'}`);
    console.log(`  Attempt Count       : ${a['odooAttemptCount']}/5`);
    console.log(`  Retry At            : ${a['odooRetryAt']}`);
    console.log(`  Last Error          : ${a['lastError'] ?? '(none)'}`);
    if (a['retryFromParsed']) {
      console.log(`  RETRY_FROM parsed   : ${a['retryFromParsed']}`);
    }
    console.log('');
    console.log(`  ── What Would Happen ──`);
    if (a['wouldSkip']) {
      console.log(`  ⛔ WOULD SKIP — ${a['skipReason']}`);
    } else {
      console.log(`  Claim From Status   : ${a['claimFromStatus']}`);
      console.log(`  → Processing Status : ${a['processingStatus']}`);
      console.log(`  Stage To Run        : ${a['stageToRun']}`);
      console.log(`  Odoo Method         : ${a['odooMethodToCall']}`);
      if (a['needsSaleOrderRecovery']) {
        console.log(`  ⚠️  RECOVERY NEEDED  : ${a['recoveryNote']}`);
      }
      console.log(`  → Next Status       : ${a['nextStatusOnSuccess']}`);
    }
    console.log('');
    console.log(`  Timestamps          : created=${a['createdAt']}  updated=${a['updatedAt']}`);
    console.log('');
  }

  console.log(`════════════════════════════════════════════════════════════`);
  console.log(`  DRY-RUN COMPLETE`);
  console.log(`  Records found   : ${records.length}`);
  console.log(`  Would process   : ${analyses.filter((a: any) => !a.wouldSkip).length}`);
  console.log(`  Would skip      : ${analyses.filter((a: any) => a.wouldSkip).length}`);
  console.log(`  Writes made     : 0 (read-only)`);
  console.log(`════════════════════════════════════════════════════════════`);
  console.log('');

  // Machine-readable JSON summary at the end
  console.log('── JSON Summary ─────────────────────────────────────────────');
  console.log(JSON.stringify({ dryRun: true, recordsFound: records.length, records: analyses }, null, 2));
};

main()
  .catch((error: unknown) => {
    console.error('[dryRunOdooQueue] Error:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
