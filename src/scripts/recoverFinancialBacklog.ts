/**
 * Guarded one-time recovery for the financial backlog discovered on 2026-07-20.
 *
 * Default mode is read-only. Applying requires the exact SHA-256 fingerprint
 * printed by a fresh preview:
 *
 *   npm run recovery:financial-preview
 *   npx tsx src/scripts/recoverFinancialBacklog.ts --apply --expected-fingerprint=<sha256>
 *
 * The fingerprint covers the Shopify SKU, the unique Odoo SKU match, every
 * failed order selected for requeue, and every Shopify payment selected for
 * requeue. Any state drift therefore stops the apply before the first write.
 */
import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { OdooClient, type OdooRecord } from '../odoo/odooClient.js';
import { buildShopifyPaymentFingerprint } from '../services/shipmentStatusSyncService.js';
import { shipmentRepository } from '../services/shipmentRepository.js';
import { requestShopifyAdmin } from '../shopify/shopifyAdminGraphql.js';
import { shopifyOrdersClient } from '../shopify/shopifyOrdersClient.js';
import type { ShopifyLineItem, ShopifyOrder } from '../types/shopify.js';

const SHOPIFY_PRODUCT_ID = '10495568085284';
const SHOPIFY_PRODUCT_GID = `gid://shopify/Product/${SHOPIFY_PRODUCT_ID}`;
const SHOPIFY_VARIANT_ID = '54282649403684';
const SHOPIFY_VARIANT_GID = `gid://shopify/ProductVariant/${SHOPIFY_VARIANT_ID}`;
const EXPECTED_PRODUCT_TITLE = 'The Leather Travel Set';
const EXPECTED_VARIANT_TITLE = 'Maroon';
const TARGET_SKU = 'PAS-BLANK-MRN';
const EXPECTED_ODOO_PRODUCT_ID = 13152;
const EXPECTED_FAILED_ORDER_NAMES = ['#2886', '#3015', '#3175', '#3354', '#3424'];
const FAILED_SKU_ERROR = `Shopify line "${EXPECTED_PRODUCT_TITLE}" has no SKU`;
const RETURNED_CODES = new Set(['RTRN', 'RTS', 'RJCT']);

const apply = process.argv.includes('--apply');
const expectedFingerprint = process.argv
  .find((arg) => arg.startsWith('--expected-fingerprint='))
  ?.slice('--expected-fingerprint='.length)
  .trim();

interface ProductVariantNode {
  id: string;
  title: string;
  sku?: string | null;
  inventoryItem?: { sku?: string | null } | null;
}

interface ProductResponse {
  product: {
    id: string;
    title: string;
    variants: { nodes: ProductVariantNode[] };
  } | null;
}

interface PaymentStateNode {
  id: string;
  legacyResourceId: string;
  name: string;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  currentTotalPriceSet: { shopMoney: { amount: string } };
  totalReceivedSet: { shopMoney: { amount: string } };
  totalOutstandingSet: { shopMoney: { amount: string } };
}

interface PaymentNodesResponse {
  nodes: Array<PaymentStateNode | null>;
}

interface OdooProduct extends OdooRecord {
  display_name?: string;
  default_code?: string | false;
  active?: boolean;
  product_tmpl_id?: [number, string] | false;
}

interface OdooSaleOrder extends OdooRecord {
  name?: string;
  client_order_ref?: string | false;
  origin?: string | false;
  state?: string;
}

const amount = (value: string | number | null | undefined): number => Number(value ?? 0);
const activeLineItems = (order: ShopifyOrder): ShopifyLineItem[] =>
  order.line_items.filter((line) => Number(line.current_quantity ?? line.quantity) > 0);
const lineSku = (line: ShopifyLineItem): string => line.sku?.trim() ?? '';
const orderReference = (order: ShopifyOrder): string =>
  `${order.name} / ${env.orderReferencePrefix}-${order.order_number}`;

const stableHash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const sameStrings = (left: string[], right: string[]): boolean =>
  [...left].sort().join('|') === [...right].sort().join('|');

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const inspectRecoveryOrder = async (
  record: {
    id: number;
    shopifyOrderId: string;
    shopifyOrderName: string | null;
    collectionStatus: string | null;
    collectedAmount: number | null;
    accurateReturnStatusCode: string | null;
    odooSaleOrderId: number | null;
    odooInvoiceId: number | null;
  },
  odoo: OdooClient
): Promise<{ order: ShopifyOrder; existingSaleOrders: OdooSaleOrder[]; targetLineIds: number[] }> => {
  assert(record.shopifyOrderName, `Recovery record ${record.id} has no Shopify order name`);
  assert(record.collectionStatus === 'collected', `${record.shopifyOrderName} is no longer collected`);
  assert(amount(record.collectedAmount) > 0, `${record.shopifyOrderName} has no positive collected amount`);
  assert(!RETURNED_CODES.has(record.accurateReturnStatusCode?.trim().toUpperCase() ?? ''),
    `${record.shopifyOrderName} now has an explicit return status`);
  assert(record.odooSaleOrderId === null && record.odooInvoiceId === null,
    `${record.shopifyOrderName} already has an Odoo sale order or invoice link`);

  const order = await shopifyOrdersClient.getOrderByLegacyId(record.shopifyOrderId);
  assert(String(order.id) === record.shopifyOrderId, `${record.shopifyOrderName} Shopify id changed unexpectedly`);
  assert(order.name === record.shopifyOrderName, `${record.shopifyOrderName} Shopify name mismatch`);
  assert(!order.cancelled_at, `${record.shopifyOrderName} is cancelled in Shopify`);

  const activeLines = activeLineItems(order);
  const targetLines = activeLines.filter((line) => String(line.variant_id ?? '') === SHOPIFY_VARIANT_ID);
  assert(targetLines.length > 0, `${record.shopifyOrderName} has no active exact Maroon variant line`);
  assert(targetLines.every((line) =>
    line.title === EXPECTED_PRODUCT_TITLE &&
    line.variant_title === EXPECTED_VARIANT_TITLE &&
    (!lineSku(line) || lineSku(line) === TARGET_SKU)
  ), `${record.shopifyOrderName} target variant identity/title/SKU did not match`);
  assert(activeLines.filter((line) => !lineSku(line)).every((line) =>
    String(line.variant_id ?? '') === SHOPIFY_VARIANT_ID
  ), `${record.shopifyOrderName} has a different active line with a missing SKU`);

  const reference = orderReference(order);
  const existingSaleOrders = await odoo.searchRead<OdooSaleOrder>(
    'sale.order',
    ['&', ['state', '!=', 'cancel'], '|', ['client_order_ref', '=', reference], ['origin', '=', order.name]],
    ['name', 'client_order_ref', 'origin', 'state'],
    { limit: 5, order: 'id desc' }
  );
  assert(existingSaleOrders.length === 0,
    `${record.shopifyOrderName} already exists in Odoo but is not linked in the database`);

  return { order, existingSaleOrders, targetLineIds: targetLines.map((line) => line.id) };
};

const fetchPaymentStates = async (legacyIds: string[]): Promise<Map<string, PaymentStateNode | null>> => {
  const states = new Map<string, PaymentStateNode | null>();
  for (let offset = 0; offset < legacyIds.length; offset += 75) {
    const batch = legacyIds.slice(offset, offset + 75);
    const response = await requestShopifyAdmin<PaymentNodesResponse>(`
      query FinancialRecoveryStates($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Order {
            id
            legacyResourceId
            name
            cancelledAt
            displayFinancialStatus
            currentTotalPriceSet { shopMoney { amount } }
            totalReceivedSet { shopMoney { amount } }
            totalOutstandingSet { shopMoney { amount } }
          }
        }
      }
    `, { ids: batch.map((id) => `gid://shopify/Order/${id}`) });
    response.nodes.forEach((node, index) => states.set(batch[index]!, node));
    if (offset + 75 < legacyIds.length) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return states;
};

const main = async (): Promise<void> => {
  const odoo = new OdooClient();
  const product = await requestShopifyAdmin<ProductResponse>(`
    query FinancialRecoveryProduct($id: ID!) {
      product(id: $id) {
        id
        title
        variants(first: 100) {
          nodes { id title sku inventoryItem { sku } }
        }
      }
    }
  `, { id: SHOPIFY_PRODUCT_GID });
  assert(product.product?.id === SHOPIFY_PRODUCT_GID, 'Expected Shopify product was not found');
  assert(product.product.title === EXPECTED_PRODUCT_TITLE,
    `Unexpected Shopify product title: ${product.product.title}`);
  const targetVariant = product.product.variants.nodes.find((variant) => variant.id === SHOPIFY_VARIANT_GID);
  assert(targetVariant, 'Expected Shopify Maroon variant was not found');
  assert(targetVariant.title === EXPECTED_VARIANT_TITLE,
    `Unexpected target variant title: ${targetVariant.title}`);
  const currentTargetSku = targetVariant.sku?.trim() || targetVariant.inventoryItem?.sku?.trim() || null;
  assert(currentTargetSku === null || currentTargetSku === TARGET_SKU,
    `Target variant already has a different SKU: ${currentTargetSku}`);

  const odooProducts = await odoo.searchRead<OdooProduct>(
    'product.product',
    [['default_code', '=', TARGET_SKU]],
    ['display_name', 'default_code', 'active', 'product_tmpl_id'],
    { limit: 10, order: 'id asc' }
  );
  assert(odooProducts.length === 1, `Expected one active Odoo product for ${TARGET_SKU}, found ${odooProducts.length}`);
  const odooProduct = odooProducts[0]!;
  assert(odooProduct.id === EXPECTED_ODOO_PRODUCT_ID,
    `Odoo SKU ${TARGET_SKU} resolved to unexpected product id ${odooProduct.id}`);
  assert(odooProduct.active !== false && odooProduct.default_code === TARGET_SKU,
    `Odoo product ${odooProduct.id} is inactive or has a different SKU`);
  assert(/passport cover/i.test(odooProduct.display_name ?? ''),
    `Odoo product ${odooProduct.id} has an unexpected name: ${odooProduct.display_name ?? ''}`);

  const failedRecords = await prisma.shipmentRecord.findMany({
    where: { odooSyncStatus: 'failed', odooLastError: FAILED_SKU_ERROR },
    select: {
      id: true,
      shopifyOrderId: true,
      shopifyOrderName: true,
      collectionStatus: true,
      collectedAmount: true,
      accurateReturnStatusCode: true,
      odooSaleOrderId: true,
      odooInvoiceId: true
    },
    orderBy: { id: 'asc' }
  });
  const failedNames = failedRecords.map((record) => record.shopifyOrderName ?? '');
  assert(sameStrings(failedNames, EXPECTED_FAILED_ORDER_NAMES),
    `Failed-order set drifted. Expected ${EXPECTED_FAILED_ORDER_NAMES.join(', ')}, found ${failedNames.join(', ')}`);

  const recoveryOrders = [];
  for (const record of failedRecords) {
    const inspection = await inspectRecoveryOrder(record, odoo);
    recoveryOrders.push({ record, ...inspection });
  }

  const collectedRecords = await prisma.shipmentRecord.findMany({
    where: { collectionStatus: 'collected', collectedAmount: { gt: 0 } },
    select: {
      id: true,
      shopifyOrderId: true,
      shopifyOrderName: true,
      collectedAmount: true,
      accurateStatusCode: true,
      accurateReturnStatusCode: true
    },
    orderBy: { id: 'asc' }
  });
  const paymentStates = await fetchPaymentStates(collectedRecords.map((record) => record.shopifyOrderId));
  const missingShopifyOrders: string[] = [];
  const unsafePaymentStates: Array<{ order: string; status: string | null; received: number; outstanding: number }> = [];
  const paymentCandidates: Array<{
    id: number;
    shopifyOrderId: string;
    order: string;
    collectedAmount: number;
    status: string;
    total: number;
    received: number;
    outstanding: number;
  }> = [];

  for (const record of collectedRecords) {
    const state = paymentStates.get(record.shopifyOrderId);
    if (!state) {
      missingShopifyOrders.push(record.shopifyOrderName ?? record.shopifyOrderId);
      continue;
    }
    const status = state.displayFinancialStatus?.trim().toUpperCase() ?? null;
    const received = amount(state.totalReceivedSet?.shopMoney?.amount);
    const outstanding = amount(state.totalOutstandingSet?.shopMoney?.amount);
    const total = amount(state.currentTotalPriceSet?.shopMoney?.amount);
    const isExplicitReturn = RETURNED_CODES.has(record.accurateStatusCode?.trim().toUpperCase() ?? '') ||
      RETURNED_CODES.has(record.accurateReturnStatusCode?.trim().toUpperCase() ?? '');
    if (state.cancelledAt || outstanding <= 0.01 || isExplicitReturn) continue;
    if (status !== 'PENDING' || received > 0.01 || total <= 0 || amount(record.collectedAmount) > total + 0.01) {
      unsafePaymentStates.push({
        order: state.name,
        status,
        received,
        outstanding
      });
      continue;
    }
    paymentCandidates.push({
      id: record.id,
      shopifyOrderId: record.shopifyOrderId,
      order: state.name,
      collectedAmount: amount(record.collectedAmount),
      status,
      total,
      received,
      outstanding
    });
  }

  const previewState = {
    targetSku: {
      productId: SHOPIFY_PRODUCT_ID,
      variantId: SHOPIFY_VARIANT_ID,
      current: currentTargetSku,
      desired: TARGET_SKU,
      odooProductId: odooProduct.id,
      odooProductName: odooProduct.display_name ?? null
    },
    failedOrders: recoveryOrders.map(({ record, order, targetLineIds, existingSaleOrders }) => ({
      recordId: record.id,
      orderId: record.shopifyOrderId,
      order: record.shopifyOrderName,
      targetLineIds,
      targetVariantIds: activeLineItems(order)
        .filter((line) => String(line.variant_id ?? '') === SHOPIFY_VARIANT_ID)
        .map((line) => String(line.variant_id)),
      existingSaleOrderIds: existingSaleOrders.map((saleOrder) => saleOrder.id)
    })),
    paymentCandidates,
    missingShopifyOrders,
    unsafePaymentStates
  };
  const recoveryFingerprint = stableHash(previewState);

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'preview',
    recoveryFingerprint,
    summary: {
      skuNeedsUpdate: currentTargetSku !== TARGET_SKU,
      odooSkuMatches: odooProducts.length,
      failedOrdersToRequeue: recoveryOrders.length,
      collectedOrdersChecked: collectedRecords.length,
      shopifyPaymentsToQueue: paymentCandidates.length,
      missingShopifyOrders: missingShopifyOrders.length,
      unsafePaymentStates: unsafePaymentStates.length
    },
    preview: previewState
  }, null, 2));

  if (!apply) return;
  assert(expectedFingerprint, '--apply requires --expected-fingerprint from a fresh preview');
  assert(expectedFingerprint === recoveryFingerprint,
    `Recovery fingerprint changed. Expected ${expectedFingerprint}, current ${recoveryFingerprint}`);
  assert(missingShopifyOrders.length === 0,
    `Cannot apply while ${missingShopifyOrders.length} Shopify orders are missing`);
  assert(unsafePaymentStates.length === 0,
    `Cannot apply while ${unsafePaymentStates.length} payment states need review`);

  if (currentTargetSku !== TARGET_SKU) {
    const update = await requestShopifyAdmin<{
      productVariantsBulkUpdate: {
        productVariants: Array<{ id: string; sku?: string | null }>;
        userErrors: Array<{ field?: string[] | null; message: string }>;
      };
    }>(`
      mutation FinancialRecoverySku($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id sku }
          userErrors { field message }
        }
      }
    `, {
      productId: SHOPIFY_PRODUCT_GID,
      variants: [{ id: SHOPIFY_VARIANT_GID, inventoryItem: { sku: TARGET_SKU } }]
    });
    assert(update.productVariantsBulkUpdate.userErrors.length === 0,
      `Shopify SKU update failed: ${JSON.stringify(update.productVariantsBulkUpdate.userErrors)}`);
  }

  const verifyProduct = await requestShopifyAdmin<ProductResponse>(`
    query VerifyFinancialRecoveryProduct($id: ID!) {
      product(id: $id) {
        id
        title
        variants(first: 100) { nodes { id title sku inventoryItem { sku } } }
      }
    }
  `, { id: SHOPIFY_PRODUCT_GID });
  const verifiedVariant = verifyProduct.product?.variants.nodes.find((variant) => variant.id === SHOPIFY_VARIANT_GID);
  const verifiedSku = verifiedVariant?.sku?.trim() || verifiedVariant?.inventoryItem?.sku?.trim() || null;
  assert(verifiedSku === TARGET_SKU, `Shopify SKU verification failed; current value is ${verifiedSku}`);

  let requeuedOdoo = 0;
  for (const recovery of recoveryOrders) {
    const refreshedOrder = await shopifyOrdersClient.getOrderByLegacyId(recovery.record.shopifyOrderId);
    const targetLines = activeLineItems(refreshedOrder)
      .filter((line) => String(line.variant_id ?? '') === SHOPIFY_VARIANT_ID);
    assert(targetLines.length > 0 && targetLines.every((line) => lineSku(line) === TARGET_SKU),
      `${recovery.record.shopifyOrderName} did not refresh with the verified SKU`);
    const updated = await prisma.shipmentRecord.updateMany({
      where: {
        id: recovery.record.id,
        odooSyncStatus: 'failed',
        odooLastError: FAILED_SKU_ERROR,
        odooSaleOrderId: null,
        odooInvoiceId: null
      },
      data: {
        rawOrderJson: JSON.stringify(refreshedOrder),
        odooSyncStatus: 'odoo-so-pending',
        odooLastError: null,
        odooAttemptCount: 0,
        odooRetryAt: null,
        odooSyncedAt: new Date()
      }
    });
    assert(updated.count === 1, `${recovery.record.shopifyOrderName} changed before Odoo requeue`);
    requeuedOdoo += updated.count;
  }

  let queuedShopifyPayments = 0;
  for (const candidate of paymentCandidates) {
    if (await shipmentRepository.queueShopifyPaymentSync(
      candidate.id,
      buildShopifyPaymentFingerprint(candidate.collectedAmount)
    )) {
      queuedShopifyPayments++;
    }
  }

  console.log(JSON.stringify({
    applied: true,
    verifiedSku,
    requeuedOdoo,
    queuedShopifyPayments,
    paymentCandidates: paymentCandidates.length
  }, null, 2));
};

try {
  await main();
} finally {
  await prisma.$disconnect();
}
