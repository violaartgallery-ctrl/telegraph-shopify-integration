import 'dotenv/config';
import { AccurateClient, type AccurateShipmentSummary } from '../accurate/accurateClient.js';
import { prisma } from '../lib/prisma.js';
import { createAppServices } from '../app.js';
import { projectAccurateStatusToShopify } from '../services/accurateStatusMapper.js';
import {
  isLegacyNonShopifyShipmentCode,
  type StatusPollingRecordRef
} from '../services/shipmentStatusSyncService.js';
import { shipmentRepository, type AccurateSnapshotData } from '../services/shipmentRepository.js';
import {
  isOlderThanStatusPollingCutoff,
  isStatusPollingDiagnostic,
  isStatusPollingQuarantined
} from '../services/statusPollingPolicy.js';

type ActionKind = 'repair-terminal-flag' | 'sync' | 'quarantine';

const getArg = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
};

const apply = process.argv.includes('--apply');
const retrySince = getArg('retry-since') ? new Date(getArg('retry-since')!) : undefined;
if (retrySince && !Number.isFinite(retrySince.getTime())) throw new Error('Invalid retry-since timestamp');
const requestedAction = (getArg('action') ?? 'all') as ActionKind | 'all';
const limitArg = Number.parseInt(getArg('limit') ?? '', 10);
const limit = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : Number.POSITIVE_INFINITY;
const safeAgeDaysArg = Number.parseInt(getArg('safe-age-days') ?? '7', 10);
const safeAgeDays = Number.isFinite(safeAgeDaysArg) && safeAgeDaysArg >= 1 ? safeAgeDaysArg : 7;
const requestedCodes = new Set(
  (getArg('codes') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
);

if (!['all', 'repair-terminal-flag', 'sync', 'quarantine'].includes(requestedAction)) {
  throw new Error(`Unsupported --action=${requestedAction}`);
}

const normalizedNumber = (value?: number | null): string | null =>
  value === undefined || value === null || !Number.isFinite(Number(value))
    ? null
    : Number(value).toFixed(2);

const normalizedCode = (value?: string | null): string => value?.trim().toUpperCase() ?? '';

const actualDates = (shipment: AccurateShipmentSummary): Pick<AccurateSnapshotData, 'deliveredAt' | 'returnedAt'> => {
  if (!shipment.deliveredOrReturnedDate) return {};
  const value = new Date(shipment.deliveredOrReturnedDate);
  if (Number.isNaN(value.getTime())) return {};
  const statusCode = normalizedCode(shipment.status?.code);
  const returnCode = normalizedCode(shipment.returnStatus?.code);
  if (['RTRN', 'RTS', 'RJCT'].includes(statusCode) || ['RTRN', 'RTS', 'RJCT'].includes(returnCode)) {
    return { returnedAt: value };
  }
  return statusCode === 'DTR' ? { deliveredAt: value } : {};
};

const snapshotFor = (shipment: AccurateShipmentSummary): AccurateSnapshotData => {
  const projection = projectAccurateStatusToShopify({
    statusCode: shipment.status?.code,
    statusName: shipment.status?.name,
    returnStatusCode: shipment.returnStatus?.code,
    returnStatusName: shipment.returnStatus?.name,
    collected: shipment.collected,
    paidToCustomer: shipment.paidToCustomer,
    cancelled: shipment.cancelled,
    customerDue: shipment.customerDue
  });
  return {
    accurateStatus: projection.shipmentStatus,
    accurateStatusCode: shipment.status?.code ?? null,
    accurateReturnStatus: shipment.returnStatus?.name ?? shipment.returnStatus?.code ?? null,
    accurateReturnStatusCode: shipment.returnStatus?.code ?? null,
    accurateIsTerminal: projection.isTerminal,
    collectionStatus: projection.collectionStatus,
    trackingUrl: shipment.trackingUrl,
    collectedAmount: shipment.collectedAmount,
    pendingCollectionAmount: shipment.pendingCollectionAmount,
    returnedValue: shipment.returnedValue,
    deliveryFees: shipment.deliveryFees,
    returnFees: shipment.returnFees,
    returningDueFees: shipment.returningDueFees,
    customerDue: shipment.customerDue,
    ...actualDates(shipment)
  };
};

const sameSnapshot = (current: Record<string, unknown>, incoming: AccurateSnapshotData): boolean =>
  normalizedCode(current.accurateStatusCode as string | null) === normalizedCode(incoming.accurateStatusCode) &&
  normalizedCode(current.accurateReturnStatusCode as string | null) === normalizedCode(incoming.accurateReturnStatusCode) &&
  current.accurateIsTerminal === incoming.accurateIsTerminal &&
  (current.collectionStatus ?? null) === (incoming.collectionStatus ?? null) &&
  (current.trackingUrl ?? null) === (incoming.trackingUrl ?? null) &&
  normalizedNumber(current.collectedAmount as number | null) === normalizedNumber(incoming.collectedAmount) &&
  normalizedNumber(current.pendingCollectionAmount as number | null) === normalizedNumber(incoming.pendingCollectionAmount) &&
  normalizedNumber(current.returnedValue as number | null) === normalizedNumber(incoming.returnedValue) &&
  normalizedNumber(current.deliveryFees as number | null) === normalizedNumber(incoming.deliveryFees) &&
  normalizedNumber(current.returnFees as number | null) === normalizedNumber(incoming.returnFees) &&
  normalizedNumber(current.returningDueFees as number | null) === normalizedNumber(incoming.returningDueFees) &&
  normalizedNumber(current.customerDue as number | null) === normalizedNumber(incoming.customerDue) &&
  !isStatusPollingDiagnostic(current.lastError as string | null);

const terminalRepairOnly = (current: Record<string, unknown>, incoming: AccurateSnapshotData): boolean => {
  const destinationTerminal = ['completed', 'needs-review'];
  return normalizedCode(current.accurateStatusCode as string | null) === 'DTR' &&
    normalizedCode(incoming.accurateStatusCode) === 'DTR' &&
    current.collectionStatus === 'collected' &&
    incoming.collectionStatus === 'collected' &&
    current.accurateIsTerminal !== true &&
    incoming.accurateIsTerminal === true &&
    normalizedNumber(current.collectedAmount as number | null) === normalizedNumber(incoming.collectedAmount) &&
    normalizedNumber(current.deliveryFees as number | null) === normalizedNumber(incoming.deliveryFees) &&
    normalizedNumber(current.customerDue as number | null) === normalizedNumber(incoming.customerDue) &&
    destinationTerminal.includes(String(current.shopifyPaymentSyncStatus ?? '')) &&
    destinationTerminal.includes(String(current.odooCollectionSyncStatus ?? '')) &&
    ['paid', 'paid-existing'].includes(String(current.odooSyncStatus ?? ''));
};

const main = async () => {
  const startedAt = new Date();
  const cutoff = new Date(startedAt.getTime() - safeAgeDays * 24 * 60 * 60 * 1_000);
  const accurateClient = new AccurateClient();
  const { shipmentStatusSyncService } = createAppServices();
  const rows = await prisma.shipmentRecord.findMany({
    where: {
      accurateShipmentId: { not: null },
      OR: [
        { accurateIsTerminal: null }, { accurateIsTerminal: false },
        ...(retrySince ? [{ lastSyncedAt: { gte: retrySince } }] : [])
      ]
    },
    orderBy: { id: 'asc' }
  });

  // The catalog must finish completely before any missing shipment can be
  // quarantined. A partial/timeout scan therefore performs zero unsafe writes.
  const first = await accurateClient.listShipments({}, 100, 1);
  const lastPage = first.paginatorInfo?.lastPage ?? 1;
  const expectedTotal = first.paginatorInfo?.total;
  if (!expectedTotal || expectedTotal < 1 || !Number.isInteger(lastPage) || lastPage < 1) {
    throw new Error('Invalid/zero Telegraph catalog; no reconciliation is allowed');
  }
  const carrierByCode = new Map<string, AccurateShipmentSummary>();
  const addPage = (response: typeof first, page: number) => {
    if (response.paginatorInfo.total !== expectedTotal || response.paginatorInfo.lastPage !== lastPage ||
      response.paginatorInfo.currentPage !== page || response.data.length !== response.paginatorInfo.count ||
      response.paginatorInfo.hasMorePages !== (page < lastPage)) {
      throw new Error('Telegraph catalog changed or is incomplete; no reconciliation is allowed');
    }
    for (const shipment of response.data) {
      if (!shipment.code || carrierByCode.has(shipment.code)) throw new Error('Missing/duplicate carrier code; no reconciliation is allowed');
      carrierByCode.set(shipment.code, shipment);
    }
  };
  addPage(first, 1);
  for (let start = 2; start <= lastPage; start += 4) {
    const pages = Array.from({ length: Math.min(4, lastPage - start + 1) }, (_, offset) => start + offset);
    const responses = await Promise.all(pages.map((page) => accurateClient.listShipments({}, 100, page)));
    responses.forEach((response, index) => addPage(response, pages[index]!));
    console.error(`Telegraph catalog ${pages.at(-1)}/${lastPage}`);
  }
  if (carrierByCode.size !== expectedTotal) throw new Error('Carrier catalog total did not verify; no reconciliation is allowed');

  const candidates: Array<{
    kind: ActionKind;
    record: typeof rows[number];
    shipment?: AccurateShipmentSummary;
    snapshot?: AccurateSnapshotData;
    reason: string;
  }> = [];
  let currentWithoutChange = 0;
  let missingTooNew = 0;
  let legacy = 0;

  for (const record of rows) {
    const code = record.accurateShipmentCode?.trim() ?? '';
    if (requestedCodes.size > 0 && !requestedCodes.has(code)) continue;
    if (!code) continue;
    if (isLegacyNonShopifyShipmentCode(code)) {
      legacy += 1;
      if (isStatusPollingQuarantined(record.lastError)) {
        currentWithoutChange += 1;
        continue;
      }
      candidates.push({
        kind: 'quarantine',
        record,
        reason: 'Legacy VI + five-zero shipment is excluded from Shopify automation'
      });
      continue;
    }
    const shipment = carrierByCode.get(code);
    if (!shipment) {
      if (isStatusPollingQuarantined(record.lastError)) {
        currentWithoutChange += 1;
        continue;
      }
      if (isOlderThanStatusPollingCutoff(record.createdAt, record.shopifyCreatedAt, cutoff)) {
        candidates.push({
          kind: 'quarantine',
          record,
          reason: `Exact code was absent from a complete ${lastPage}-page Telegraph catalog scan at ${startedAt.toISOString()}`
        });
      } else {
        missingTooNew += 1;
      }
      continue;
    }
    const snapshot = snapshotFor(shipment);
    if (terminalRepairOnly(record, snapshot)) {
      candidates.push({
        kind: 'repair-terminal-flag',
        record,
        shipment,
        snapshot,
        reason: 'Confirmed DTR + collected record has a stale non-terminal flag'
      });
      continue;
    }
    if (!sameSnapshot(record, snapshot) || (retrySince && record.lastSyncedAt && record.lastSyncedAt >= retrySince)) {
      candidates.push({
        kind: 'sync',
        record,
        shipment,
        snapshot,
        reason: `${record.accurateStatusCode ?? 'none'}/${record.collectionStatus ?? 'none'} -> ${snapshot.accurateStatusCode ?? 'none'}/${snapshot.collectionStatus ?? 'none'}`
      });
    } else {
      currentWithoutChange += 1;
    }
  }

  const selected = candidates
    .filter((candidate) => requestedAction === 'all' || candidate.kind === requestedAction)
    .slice(0, limit);
  const counts = Object.fromEntries(
    (['repair-terminal-flag', 'sync', 'quarantine'] as ActionKind[])
      .map((kind) => [kind, candidates.filter((candidate) => candidate.kind === kind).length])
  );
  const applied = { repaired: 0, synced: 0, quarantined: 0, failed: 0 };
  const failures: Array<{ order: string | null; code: string | null; reason: string }> = [];
  const audit = apply ? await prisma.failedPayload.create({ data: {
    source: 'status-polling-recovery-audit', reason: startedAt.toISOString(),
    payloadJson: JSON.stringify({ phase: 'before', expectedTotal, selected: selected.map((c) => ({ id: c.record.id, order: c.record.shopifyOrderName, code: c.record.accurateShipmentCode, kind: c.kind })) })
  } }) : null;

  if (apply) {
    const processCandidate = async (candidate: typeof selected[number]) => {
      try {
        if (candidate.kind === 'repair-terminal-flag') {
          await shipmentRepository.updateAccurateSnapshot(candidate.record.id, candidate.snapshot!);
          applied.repaired += 1;
        } else if (candidate.kind === 'quarantine') {
          if (await shipmentRepository.quarantineStatusPollingRecord(
            candidate.record.id,
            candidate.record.accurateShipmentCode!,
            candidate.reason
          )) applied.quarantined += 1;
        } else {
          const ref: StatusPollingRecordRef = {
            id: candidate.record.id,
            shopifyOrderId: candidate.record.shopifyOrderId,
            accurateShipmentId: candidate.record.accurateShipmentId,
            accurateShipmentCode: candidate.record.accurateShipmentCode
          };
          const result = await shipmentStatusSyncService.syncResolvedShipment(ref, candidate.shipment!);
          if (result === 'synced') applied.synced += 1;
        }
      } catch (error) {
        applied.failed += 1;
        failures.push({
          order: candidate.record.shopifyOrderName,
          code: candidate.record.accurateShipmentCode,
          reason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
        });
      }
    };
    // A single local worker may perform several parallel queries internally.
    // Keep record concurrency at one so it cannot exhaust Neon's small pool.
    for (const candidate of selected) await processCandidate(candidate);
    await prisma.failedPayload.update({ where: { id: audit!.id }, data: { payloadJson: JSON.stringify({
      phase: 'completed', expectedTotal, applied, failures,
      selected: selected.map((c) => ({ id: c.record.id, order: c.record.shopifyOrderName, code: c.record.accurateShipmentCode, kind: c.kind }))
    }) } });
  }

  console.log(JSON.stringify({
    apply,
    auditId: audit?.id,
    requestedAction,
    limit: Number.isFinite(limit) ? limit : null,
    safeAgeDays,
    scanned: { dbOpen: rows.length, carrierCodes: carrierByCode.size, carrierPages: lastPage },
    candidates: counts,
    selected: selected.length,
    currentWithoutChange,
    missingTooNew,
    recentMissing: rows.filter((r) => r.accurateShipmentCode && !carrierByCode.has(r.accurateShipmentCode) &&
      !isOlderThanStatusPollingCutoff(r.createdAt, r.shopifyCreatedAt, cutoff))
      .map((r) => ({ order: r.shopifyOrderName, code: r.accurateShipmentCode })),
    legacy,
    applied,
    failures
  }, null, 2));

  await prisma.$disconnect();
  if (applied.failed > 0) process.exitCode = 1;
};

void main();
