import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { AccurateClient } from '../accurate/accurateClient.js';
import { prisma } from '../lib/prisma.js';
import { OdooClient } from '../odoo/odooClient.js';
import { OdooSaleReturnService } from '../odoo/odooSaleReturnService.js';
import { projectAccurateStatusToShopify } from '../services/accurateStatusMapper.js';
import {
  classifyOrderForCollectionReturn,
  shopifyCollectionReturnPolicyService,
  type ShopifyCollectionReturnCatalog
} from '../services/shopifyCollectionReturnPolicy.js';
import type { ShopifyOrder } from '../types/shopify.js';

const LEGACY_SHIPMENT_CODE = /^VI0{5}\d+$/i;

const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const normalizeOrderName = (value: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new Error('An empty Shopify order was supplied');
  return normalized.startsWith('#') ? normalized : `#${normalized}`;
};

const orderArgument = process.argv.find((arg) => arg.startsWith('--orders='));
if (!orderArgument) {
  throw new Error('Pass an explicit allow-list, for example --orders=#7498,#6890');
}
const orderNames = [...new Set(orderArgument.slice('--orders='.length).split(',').map(normalizeOrderName))];
if (orderNames.length === 0 || orderNames.length > 10) {
  throw new Error('The controlled runner requires between 1 and 10 explicitly named orders');
}

const apply = process.argv.includes('--apply');
const expectedFingerprint = process.argv
  .find((arg) => arg.startsWith('--expected-fingerprint='))
  ?.slice('--expected-fingerprint='.length);
if (apply && !expectedFingerprint) {
  throw new Error('--apply requires the exact fingerprint printed by a fresh preview');
}

const accurate = new AccurateClient();
const odoo = new OdooClient();
const saleReturnService = new OdooSaleReturnService(odoo);

type ShipmentRecord = NonNullable<Awaited<ReturnType<typeof findShipmentRecord>>>;

async function findShipmentRecord(orderName: string) {
  const records = await prisma.shipmentRecord.findMany({
    where: { shopifyOrderName: orderName },
    select: {
      id: true,
      shopifyOrderId: true,
      shopifyOrderNumber: true,
      shopifyOrderName: true,
      accurateShipmentId: true,
      accurateShipmentCode: true,
      accurateStatusCode: true,
      accurateReturnStatusCode: true,
      collectionStatus: true,
      odooSaleOrderId: true,
      odooSaleOrderName: true,
      returnSyncStatus: true,
      rawOrderJson: true
    }
  });
  if (records.length !== 1) {
    throw new Error(`${orderName}: expected one exact integration record, found ${records.length}`);
  }
  return records[0];
}

function parseStoredOrder(record: ShipmentRecord): ShopifyOrder {
  if (!record.rawOrderJson) throw new Error(`${record.shopifyOrderName}: stored Shopify order payload is missing`);
  const order = JSON.parse(record.rawOrderJson) as ShopifyOrder;
  if (String(order.id) !== record.shopifyOrderId || order.name !== record.shopifyOrderName) {
    throw new Error(`${record.shopifyOrderName}: stored Shopify order payload does not match the integration record`);
  }
  return order;
}

function assertDatabaseReturnEvidence(record: ShipmentRecord): void {
  if (!record.accurateShipmentCode) throw new Error(`${record.shopifyOrderName}: Telegraph shipment code is missing`);
  if (LEGACY_SHIPMENT_CODE.test(record.accurateShipmentCode)) {
    throw new Error(`${record.shopifyOrderName}: legacy Telegraph shipment is deliberately excluded`);
  }
  if (!['returned', 'returned-settled'].includes(record.collectionStatus ?? '')) {
    throw new Error(`${record.shopifyOrderName}: database does not classify the shipment as returned`);
  }
  if (!record.odooSaleOrderId) throw new Error(`${record.shopifyOrderName}: exact Odoo Sales Order link is missing`);
}

async function gatherCandidate(orderName: string, catalog: ShopifyCollectionReturnCatalog) {
  const record = await findShipmentRecord(orderName);
  assertDatabaseReturnEvidence(record);
  const order = parseStoredOrder(record);
  const collection = classifyOrderForCollectionReturn(order, catalog);
  if (!collection.eligible) {
    throw new Error(`${orderName}: collection decision is ${collection.classification}; exclusive is required`);
  }

  const shipment = await accurate.getShipment({ code: record.accurateShipmentCode! });
  if (!shipment || shipment.code !== record.accurateShipmentCode) {
    throw new Error(`${orderName}: live Telegraph lookup did not return the exact shipment code`);
  }
  if (record.accurateShipmentId && shipment.id !== record.accurateShipmentId) {
    throw new Error(`${orderName}: live Telegraph shipment ID does not match the integration record`);
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
    throw new Error(
      `${orderName}: live Telegraph state is ${projection.collectionStatus}, not a completed return ` +
      `(status=${shipment.status?.code ?? 'none'}, returnStatus=${shipment.returnStatus?.code ?? 'none'}, ` +
      `cancelled=${shipment.cancelled}, paidToCustomer=${shipment.paidToCustomer})`
    );
  }

  const odooPreview = await saleReturnService.preview(record.odooSaleOrderId!);
  if (odooPreview.status === 'needs-review') {
    throw new Error(`${orderName}: Odoo needs review: ${odooPreview.reason ?? 'unknown reason'}`);
  }

  const evidence = {
    orderName,
    integrationRecordId: record.id,
    shopifyOrderId: record.shopifyOrderId,
    shipmentId: shipment.id,
    shipmentCode: shipment.code,
    carrierStatusCode: shipment.status?.code ?? null,
    carrierReturnStatusCode: shipment.returnStatus?.code ?? null,
    carrierCollectionStatus: projection.collectionStatus,
    odooSaleOrderId: record.odooSaleOrderId,
    odooSaleOrderName: record.odooSaleOrderName,
    odooPreview,
    collection: {
      id: collection.collectionId,
      handle: collection.collectionHandle,
      classification: collection.classification,
      lines: collection.lines.map((line) => ({
        lineItemId: line.lineItemId,
        productId: line.productId,
        variantId: line.variantId,
        sku: line.sku,
        quantity: line.quantity,
        inCollection: line.inCollection,
        matchedBy: line.matchedBy
      }))
    },
    catalogProductIds: [...catalog.productIds].sort((left, right) => left - right)
  };

  return { record, evidence, fingerprint: hash(evidence) };
}

async function main(): Promise<void> {
  const catalog = await shopifyCollectionReturnPolicyService.getCatalog({ forceRefresh: true });
  const candidates = [];
  for (const orderName of orderNames) {
    candidates.push(await gatherCandidate(orderName, catalog));
  }
  const aggregateFingerprint = hash(candidates.map((candidate) => ({
    orderName: candidate.evidence.orderName,
    fingerprint: candidate.fingerprint
  })));

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'preview',
    collection: {
      id: catalog.collectionId,
      handle: catalog.handle,
      products: catalog.productIds.size,
      variants: catalog.variantIds.size,
      skus: catalog.skus.size
    },
    aggregateFingerprint,
    candidates: candidates.map((candidate) => ({
      fingerprint: candidate.fingerprint,
      ...candidate.evidence
    }))
  }, null, 2));

  if (!apply) return;
  if (aggregateFingerprint !== expectedFingerprint) {
    throw new Error('Preview fingerprint mismatch; no Odoo writes were attempted');
  }

  const results = [];
  for (const candidate of candidates) {
    // Re-read all three systems immediately before touching this Sales Order.
    const fresh = await gatherCandidate(candidate.evidence.orderName, catalog);
    if (fresh.fingerprint !== candidate.fingerprint) {
      throw new Error(`${candidate.evidence.orderName}: state changed after preview; stopped before this Odoo write`);
    }

    const result = await saleReturnService.execute(candidate.record.odooSaleOrderId!);
    const verified = await saleReturnService.preview(candidate.record.odooSaleOrderId!);
    assert.equal(verified.status, 'already-complete', `${candidate.evidence.orderName}: target Odoo state was not reached`);

    // Deliberately execute a second time. It must be a read-only idempotent no-op.
    const beforeSecondRun = verified.fingerprint;
    const secondRun = await saleReturnService.execute(candidate.record.odooSaleOrderId!);
    const afterSecondRun = await saleReturnService.preview(candidate.record.odooSaleOrderId!);
    assert.equal(afterSecondRun.fingerprint, beforeSecondRun, `${candidate.evidence.orderName}: second run changed Odoo`);
    assert.deepEqual(secondRun.createdReturnPickingIds, [], `${candidate.evidence.orderName}: duplicate return picking created`);
    assert.deepEqual(secondRun.resumedReturnPickingIds, [], `${candidate.evidence.orderName}: completed return was unexpectedly resumed`);
    assert.equal(secondRun.cancelledSaleOrder, false, `${candidate.evidence.orderName}: completed Sales Order was cancelled twice`);

    const touchedPickingIds = [...new Set([
      ...result.createdReturnPickingIds,
      ...result.resumedReturnPickingIds
    ])];
    const touchedPickings = touchedPickingIds.length
      ? await odoo.searchRead<{ id: number; name?: string; state?: string }>(
        'stock.picking',
        [['id', 'in', touchedPickingIds]],
        ['name', 'state'],
        { limit: 20, order: 'id asc' }
      )
      : [];

    results.push({
      orderName: candidate.evidence.orderName,
      shipmentCode: candidate.evidence.shipmentCode,
      odooSaleOrderId: candidate.record.odooSaleOrderId,
      odooSaleOrderName: result.saleOrderName,
      createdReturnPickings: touchedPickings,
      targetVerified: verified,
      secondRunWasNoOp: true
    });
  }

  console.log(JSON.stringify({ applied: true, results }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
