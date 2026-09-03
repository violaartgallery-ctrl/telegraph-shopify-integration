import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

import { AccurateClient } from '../accurate/accurateClient.js';
import { prisma } from '../lib/prisma.js';
import { OdooClient } from '../odoo/odooClient.js';
import {
  OdooSaleReturnReviewError,
  OdooSaleReturnService,
  type OdooSaleReturnPreview
} from '../odoo/odooSaleReturnService.js';
import { projectAccurateStatusToShopify } from '../services/accurateStatusMapper.js';
import {
  classifyOrderForCollectionReturn,
  shopifyCollectionReturnPolicyService,
  type ShopifyCollectionReturnCatalog
} from '../services/shopifyCollectionReturnPolicy.js';
import type { ShopifyOrder } from '../types/shopify.js';

const LEGACY_SHIPMENT_CODE = /^VI0{5}\d+$/i;
const SAFE_BUCKET = 'safe-stock-return-and-cancel';

type ClassificationDetail = {
  bucket: string;
  order: string | null;
  shipmentCode: string | null;
  returnedAt: string | null;
  integration: {
    recordId: number;
    linkedSaleOrderId: number | null;
  };
};

type ClassificationReport = {
  checkedAt: string;
  mode: string;
  details: ClassificationDetail[];
};

type BackfillStatus = 'completed' | 'already-complete' | 'held' | 'retryable';

type BackfillEntry = {
  status: BackfillStatus;
  attempts: number;
  updatedAt: string;
  shipmentCode: string | null;
  odooSaleOrderId: number | null;
  reason?: string;
  createdReturnPickingIds?: number[];
  resumedReturnPickingIds?: number[];
  cancelledSaleOrder?: boolean;
};

type BackfillState = {
  version: 1;
  sourceCheckedAt: string;
  startedAt: string;
  updatedAt: string;
  entries: Record<string, BackfillEntry>;
};

type ShipmentRecord = NonNullable<Awaited<ReturnType<typeof findShipmentRecord>>>;

class HoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HoldError';
  }
}

const argumentValue = (name: string): string | undefined =>
  process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);

const inputArgument = argumentValue('input');
if (!inputArgument) {
  throw new Error('--input is required and must point to a fresh Odoo classification JSON report');
}

const inputPath = resolve(inputArgument);
const statePath = resolve(argumentValue('state') ?? 'tmp/new-arrivals-odoo-return-backfill-state.json');
const apply = process.argv.includes('--apply');
const requestedLimit = Number(argumentValue('limit') ?? '5');
if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 25) {
  throw new Error('--limit must be an integer between 1 and 25');
}

const accurate = new AccurateClient();
const odoo = new OdooClient();
const saleReturnService = new OdooSaleReturnService(odoo);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

async function findShipmentRecord(orderName: string) {
  const records = await prisma.shipmentRecord.findMany({
    where: { shopifyOrderName: orderName },
    select: {
      id: true,
      shopifyOrderId: true,
      shopifyOrderName: true,
      accurateShipmentId: true,
      accurateShipmentCode: true,
      collectionStatus: true,
      odooSaleOrderId: true,
      rawOrderJson: true
    }
  });
  if (records.length !== 1) {
    throw new HoldError(`${orderName}: expected one exact integration record, found ${records.length}`);
  }
  return records[0];
}

function parseStoredOrder(record: ShipmentRecord): ShopifyOrder {
  if (!record.rawOrderJson) {
    throw new HoldError(`${record.shopifyOrderName}: stored Shopify order payload is missing`);
  }
  let order: ShopifyOrder;
  try {
    order = JSON.parse(record.rawOrderJson) as ShopifyOrder;
  } catch {
    throw new HoldError(`${record.shopifyOrderName}: stored Shopify order payload is invalid`);
  }
  if (String(order.id) !== record.shopifyOrderId || order.name !== record.shopifyOrderName) {
    throw new HoldError(`${record.shopifyOrderName}: Shopify order payload does not match the integration record`);
  }
  return order;
}

function assertDatabaseEvidence(record: ShipmentRecord, expected: ClassificationDetail): void {
  if (record.id !== expected.integration.recordId) {
    throw new HoldError(`${expected.order}: integration record changed after the audit`);
  }
  if (!record.accurateShipmentCode || record.accurateShipmentCode !== expected.shipmentCode) {
    throw new HoldError(`${expected.order}: Telegraph shipment code changed after the audit`);
  }
  if (LEGACY_SHIPMENT_CODE.test(record.accurateShipmentCode)) {
    throw new HoldError(`${expected.order}: legacy Telegraph shipment is excluded`);
  }
  if (!['returned', 'returned-settled'].includes(record.collectionStatus ?? '')) {
    throw new HoldError(`${expected.order}: database no longer classifies the shipment as returned`);
  }
  if (!record.odooSaleOrderId || record.odooSaleOrderId !== expected.integration.linkedSaleOrderId) {
    throw new HoldError(`${expected.order}: exact Odoo Sales Order link changed or is missing`);
  }
}

async function gatherFreshEvidence(
  expected: ClassificationDetail,
  catalog: ShopifyCollectionReturnCatalog
): Promise<{ record: ShipmentRecord; preview: OdooSaleReturnPreview }> {
  if (!expected.order) throw new HoldError('Audit candidate is missing its Shopify order name');
  const record = await findShipmentRecord(expected.order);
  assertDatabaseEvidence(record, expected);

  const order = parseStoredOrder(record);
  const collection = classifyOrderForCollectionReturn(order, catalog);
  if (!collection.eligible) {
    throw new HoldError(
      `${expected.order}: current collection decision is ${collection.classification}; exclusive is required`
    );
  }

  const shipment = await accurate.getShipment({ code: record.accurateShipmentCode! });
  if (!shipment || shipment.code !== record.accurateShipmentCode) {
    throw new HoldError(`${expected.order}: live Telegraph lookup did not return the exact shipment code`);
  }
  if (record.accurateShipmentId && shipment.id !== record.accurateShipmentId) {
    throw new HoldError(`${expected.order}: live Telegraph shipment ID does not match the integration record`);
  }

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
  if (!['returned', 'returned-settled'].includes(projection.collectionStatus)) {
    throw new HoldError(
      `${expected.order}: live Telegraph state is ${projection.collectionStatus}, not a completed return ` +
      `(status=${shipment.status?.code ?? 'none'}, returnStatus=${shipment.returnStatus?.code ?? 'none'})`
    );
  }

  const preview = await saleReturnService.preview(record.odooSaleOrderId!);
  if (preview.status === 'needs-review') {
    throw new HoldError(`${expected.order}: Odoo needs review: ${preview.reason ?? 'unknown reason'}`);
  }
  return { record, preview };
}

async function readState(sourceCheckedAt: string): Promise<BackfillState> {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8')) as BackfillState;
    if (parsed.version !== 1 || !parsed.entries) throw new Error('unsupported state format');
    if (parsed.sourceCheckedAt !== sourceCheckedAt) {
      throw new Error(
        `Backfill state belongs to audit ${parsed.sourceCheckedAt}; use a new --state path for ${sourceCheckedAt}`
      );
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const now = new Date().toISOString();
    return { version: 1, sourceCheckedAt, startedAt: now, updatedAt: now, entries: {} };
  }
}

async function writeState(state: BackfillState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await mkdir(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(state, null, 2), 'utf8');
  await rename(temporaryPath, statePath);
}

function recordResult(
  state: BackfillState,
  expected: ClassificationDetail,
  status: BackfillStatus,
  values: Omit<BackfillEntry, 'status' | 'attempts' | 'updatedAt' | 'shipmentCode'>
): void {
  const orderName = expected.order!;
  state.entries[orderName] = {
    status,
    attempts: (state.entries[orderName]?.attempts ?? 0) + 1,
    updatedAt: new Date().toISOString(),
    shipmentCode: expected.shipmentCode,
    ...values
  };
}

async function main(): Promise<void> {
  const report = JSON.parse(await readFile(inputPath, 'utf8')) as ClassificationReport;
  if (report.mode !== 'READ_ONLY' || !Array.isArray(report.details)) {
    throw new Error('The input is not a read-only Odoo classification report');
  }
  const candidates = report.details.filter((detail) => detail.bucket === SAFE_BUCKET && detail.order);
  const state = await readState(report.checkedAt);
  const terminalStatuses = new Set<BackfillStatus>(['completed', 'already-complete', 'held']);
  const pending = candidates
    .filter((candidate) => !terminalStatuses.has(state.entries[candidate.order!]?.status))
    .sort((left, right) => {
      const leftAttempts = state.entries[left.order!]?.attempts ?? 0;
      const rightAttempts = state.entries[right.order!]?.attempts ?? 0;
      return leftAttempts - rightAttempts;
    })
    .slice(0, requestedLimit);

  const catalog = await shopifyCollectionReturnPolicyService.getCatalog({ forceRefresh: true });
  console.log(JSON.stringify({
    event: 'backfill-start',
    mode: apply ? 'apply' : 'preview',
    sourceCheckedAt: report.checkedAt,
    safeAuditCandidates: candidates.length,
    selected: pending.length,
    previouslyTerminal: candidates.filter((candidate) =>
      terminalStatuses.has(state.entries[candidate.order!]?.status)
    ).length,
    collectionProducts: catalog.productIds.size,
    statePath
  }));

  for (const expected of pending) {
    const orderName = expected.order!;
    try {
      const fresh = await gatherFreshEvidence(expected, catalog);
      if (fresh.preview.status === 'already-complete') {
        if (apply) {
          recordResult(state, expected, 'already-complete', {
            odooSaleOrderId: fresh.record.odooSaleOrderId
          });
          await writeState(state);
        }
        console.log(JSON.stringify({ event: 'order', order: orderName, status: 'already-complete' }));
        continue;
      }

      if (!apply) {
        console.log(JSON.stringify({
          event: 'order',
          order: orderName,
          status: 'ready',
          shipmentCode: fresh.record.accurateShipmentCode,
          odooSaleOrderId: fresh.record.odooSaleOrderId
        }));
        continue;
      }

      const result = await saleReturnService.execute(fresh.record.odooSaleOrderId!);
      const verified = await saleReturnService.preview(fresh.record.odooSaleOrderId!);
      if (verified.status !== 'already-complete') {
        throw new Error(`${orderName}: Odoo target verification failed: ${verified.reason ?? verified.status}`);
      }
      recordResult(state, expected, 'completed', {
        odooSaleOrderId: fresh.record.odooSaleOrderId,
        createdReturnPickingIds: result.createdReturnPickingIds,
        resumedReturnPickingIds: result.resumedReturnPickingIds,
        cancelledSaleOrder: result.cancelledSaleOrder
      });
      await writeState(state);
      console.log(JSON.stringify({
        event: 'order',
        order: orderName,
        status: 'completed',
        shipmentCode: fresh.record.accurateShipmentCode,
        odooSaleOrderId: fresh.record.odooSaleOrderId,
        createdReturnPickingIds: result.createdReturnPickingIds,
        resumedReturnPickingIds: result.resumedReturnPickingIds,
        cancelledSaleOrder: result.cancelledSaleOrder
      }));
    } catch (error) {
      const held = error instanceof HoldError || error instanceof OdooSaleReturnReviewError;
      if (apply) {
        recordResult(state, expected, held ? 'held' : 'retryable', {
          odooSaleOrderId: expected.integration.linkedSaleOrderId,
          reason: errorMessage(error)
        });
        await writeState(state);
      }
      console.log(JSON.stringify({
        event: 'order',
        order: orderName,
        status: held ? 'held' : 'retryable',
        reason: errorMessage(error)
      }));
    }
  }

  const counts = Object.values(state.entries).reduce<Record<string, number>>((totals, entry) => {
    totals[entry.status] = (totals[entry.status] ?? 0) + 1;
    return totals;
  }, {});
  const remaining = candidates.filter((candidate) => {
    const status = state.entries[candidate.order!]?.status;
    return !terminalStatuses.has(status);
  }).length;
  console.log(JSON.stringify({
    event: 'backfill-summary',
    mode: apply ? 'apply' : 'preview',
    attempted: pending.length,
    counts,
    remaining
  }));
}

main()
  .catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
