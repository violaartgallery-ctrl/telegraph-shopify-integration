import { requestShopifyAdmin } from './shopifyAdminGraphql.js';
import { createHash } from 'node:crypto';
import type { ShopifyOrder } from '../types/shopify.js';
import { isOrderEligibleForShipment } from '../services/orderEligibility.js';

export interface ExistingShipmentIdentity {
  id: number;
  code: string;
  refNumber: string;
}
interface ReconciliationLine {
  id: string; remainingQuantity: number; totalQuantity: number; lineItem: { id: string };
}
interface ReconciliationSnapshot {
  order: null | {
    id: string; name: string; cancelledAt: string | null; test: boolean;
    displayFulfillmentStatus: string; displayFinancialStatus: string;
    refunds: Array<{ id: string }>;
    transactions: Array<{ id: string; kind: string; status: string }>;
    fulfillments: Array<{
      id: string; status: string;
      trackingInfo: Array<{ company: string | null; number: string | null; url: string | null }>;
      fulfillmentLineItems: { pageInfo: { hasNextPage: boolean }; nodes: Array<{ quantity: number; lineItem: { id: string } }> };
    }>;
    fulfillmentOrders: { pageInfo: { hasNextPage: boolean }; nodes: Array<{
      id: string; status: string; requestStatus: string;
      lineItems: { pageInfo: { hasNextPage: boolean }; nodes: ReconciliationLine[] };
    }> };
  };
}
export interface ExistingFulfillmentPlan {
  state: 'missing' | 'present';
  stateHash: string;
  fulfillmentIds: string[];
  lineItemsByFulfillmentOrder: Array<{
    fulfillmentOrderId: string;
    fulfillmentOrderLineItems: Array<{ id: string; quantity: number }>;
  }>;
}
const reconciliationHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reconciliationError = (): never => { throw new Error('Existing shipment fulfillment evidence is incomplete, partial, or conflicting; independent review required'); };
const safeQuantity = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const gid = (value: unknown, type: string): value is string => typeof value === 'string' && new RegExp('^gid://shopify/' + type + '/[1-9]\\d*$').test(value);
const dashboardUrl = (id: number): string => `https://system.telegraphex.com/admin/shipments/${id}`;

/** Strict full-order reconciliation only. No aggregate-status shortcut, no
 * partial remainder, location move, tracking update, or source rebasing. */
export function planExistingShipmentFulfillment(
  source: ShopifyOrder, shipment: ExistingShipmentIdentity, snapshot: ReconciliationSnapshot
): ExistingFulfillmentPlan {
  const order = snapshot?.order, orderId = `gid://shopify/Order/${source.id}`;
  if (!order || order.id !== orderId || order.name !== source.name || order.cancelledAt !== null || order.test !== false ||
      source.cancelled_at || source.test ||
      // Reuse native financial/confirmed/gateway policy, ignoring ONLY the own
      // fulfillment transition that this full proof is being used to verify.
      !isOrderEligibleForShipment({ ...source, fulfillment_status: null }) ||
      order.displayFinancialStatus?.toLowerCase() !== (source.financial_status ?? '').toLowerCase() ||
      !Array.isArray(order.refunds) || order.refunds.length !== 0 ||
      !Array.isArray(order.transactions) || order.transactions.length >= 100 ||
      order.transactions.some(t => !gid(t.id, 'OrderTransaction') || typeof t.kind !== 'string' || !t.kind ||
        typeof t.status !== 'string' || !t.status || /REFUND|VOID/.test(t.kind)) ||
      !Number.isSafeInteger(shipment.id) || shipment.id <= 0 ||
      !/^VI[0-9]+$/.test(shipment.code) || shipment.refNumber !== `Viola-${source.order_number}` ||
      !Array.isArray(source.line_items) || source.line_items.length >= 50 ||
      !Array.isArray(order.fulfillments) || order.fulfillments.length >= 100 ||
      order.fulfillmentOrders?.pageInfo?.hasNextPage !== false ||
      !Array.isArray(order.fulfillmentOrders.nodes)) return reconciliationError();
  const expected = new Map<string, number>();
  for (const line of source.line_items) {
    const id = `gid://shopify/LineItem/${line.id}`, quantity = line.current_quantity ?? line.quantity;
    if (!Number.isSafeInteger(line.id) || line.id <= 0 || !safeQuantity(quantity) ||
        !Array.isArray(line.properties) || expected.has(id)) return reconciliationError();
    if (quantity > 0) expected.set(id, quantity);
  }
  if (!expected.size) return reconciliationError();
  const coverage = new Map<string, number>();
  const add = (id: string, quantity: number): void => {
    if (!expected.has(id) || !safeQuantity(quantity) || quantity <= 0) reconciliationError();
    coverage.set(id, (coverage.get(id) ?? 0) + quantity);
  };
  const complete = (): boolean => expected.size === coverage.size && [...expected].every(([id, q]) => coverage.get(id) === q);
  const active = order.fulfillments.filter(f => f.status !== 'CANCELLED');
  const ids = new Set<string>();
  const remaining = order.fulfillmentOrders.nodes.flatMap(fo => {
    if (!gid(fo.id, 'FulfillmentOrder') || ids.has(fo.id) || fo.lineItems?.pageInfo?.hasNextPage !== false ||
        !Array.isArray(fo.lineItems.nodes)) return reconciliationError();
    ids.add(fo.id);
    return fo.lineItems.nodes.map(line => {
      if (!gid(line.id, 'FulfillmentOrderLineItem') || !gid(line.lineItem?.id, 'LineItem') ||
          !safeQuantity(line.remainingQuantity) || !safeQuantity(line.totalQuantity) ||
          line.remainingQuantity > line.totalQuantity) return reconciliationError();
      return { fo, line };
    }).filter(({ line }) => line.remainingQuantity > 0);
  });
  if (active.length) {
    if (order.displayFulfillmentStatus !== 'FULFILLED' || remaining.length) return reconciliationError();
    for (const f of active) {
      if (!gid(f.id, 'Fulfillment') || f.status !== 'SUCCESS' || f.trackingInfo?.length !== 1 ||
          f.trackingInfo[0].company !== 'Telegraph' || f.trackingInfo[0].number !== shipment.code ||
          (f.trackingInfo[0].url !== null && f.trackingInfo[0].url !== dashboardUrl(shipment.id)) ||
          f.fulfillmentLineItems?.pageInfo?.hasNextPage !== false || !Array.isArray(f.fulfillmentLineItems.nodes)) return reconciliationError();
      for (const line of f.fulfillmentLineItems.nodes) add(line.lineItem?.id, line.quantity);
    }
    if (new Set(active.map(f => f.id)).size !== active.length || !complete()) return reconciliationError();
    const fulfillmentIds = active.map(f => f.id).sort();
    return { state: 'present', stateHash: reconciliationHash({ orderId, shipment, fulfillmentIds, coverage: [...coverage].sort() }),
      fulfillmentIds, lineItemsByFulfillmentOrder: [] };
  }
  // Merchant fulfillment access does not imply read_locations permission.
  // One exact OPEN/UNSUBMITTED fulfillment order needs no location lookup;
  // any multi-FO missing repair remains review, even if addresses appear equal.
  if (order.displayFulfillmentStatus !== 'UNFULFILLED' || !remaining.length || order.fulfillmentOrders.nodes.length !== 1) return reconciliationError();
  const lineIds = new Set<string>();
  const plan = new Map<string, Array<{ id: string; quantity: number }>>();
  for (const { fo, line } of remaining) {
    if (fo.status !== 'OPEN' || fo.requestStatus !== 'UNSUBMITTED' || line.remainingQuantity !== line.totalQuantity ||
        lineIds.has(line.id)) return reconciliationError();
    lineIds.add(line.id);
    add(line.lineItem.id, line.remainingQuantity);
    const items = plan.get(fo.id) ?? [];
    items.push({ id: line.id, quantity: line.remainingQuantity });
    plan.set(fo.id, items);
  }
  if (!complete()) return reconciliationError();
  const lineItemsByFulfillmentOrder = [...plan].sort(([a], [b]) => a.localeCompare(b)).map(([id, items]) => ({
    fulfillmentOrderId: id, fulfillmentOrderLineItems: items.sort((a, b) => a.id.localeCompare(b.id))
  }));
  return { state: 'missing', stateHash: reconciliationHash({ orderId, shipment, lineItemsByFulfillmentOrder,
    coverage: [...coverage].sort() }), fulfillmentIds: [], lineItemsByFulfillmentOrder };
}

const EXISTING_FULFILLMENT_QUERY = `
  query TelegraphExistingShipmentFulfillment($id: ID!) {
    order(id: $id) {
      id name cancelledAt test displayFulfillmentStatus displayFinancialStatus
      refunds { id }
      transactions(first: 100) { id kind status }
      fulfillments(first: 100) {
        id status trackingInfo { company number url }
        fulfillmentLineItems(first: 100) { pageInfo { hasNextPage } nodes { quantity lineItem { id } } }
      }
      fulfillmentOrders(first: 20) {
        pageInfo { hasNextPage }
        nodes {
          id status requestStatus
          lineItems(first: 100) { pageInfo { hasNextPage } nodes { id remainingQuantity totalQuantity lineItem { id } } }
        }
      }
    }
  }
`;

export async function inspectExistingShipmentFulfillment(source: ShopifyOrder, shipment: ExistingShipmentIdentity): Promise<ExistingFulfillmentPlan> {
  const snapshot = await requestShopifyAdmin<ReconciliationSnapshot>(EXISTING_FULFILLMENT_QUERY, { id: `gid://shopify/Order/${source.id}` });
  return planExistingShipmentFulfillment(source, shipment, snapshot);
}

/** Low-level one-shot sink. The caller MUST own the distinct durable claim.
 * It cannot use the permissive ordinary fulfillOrder/aggregate skip path. */
export async function createExistingShipmentFulfillment(input: {
  source: ShopifyOrder; shipment: ExistingShipmentIdentity; expectedStateHash: string;
  beforeExternalAttempt: () => Promise<void>; assertOperationAllowed: () => Promise<void>;
}): Promise<FulfillOrderResult> {
  if (typeof input.beforeExternalAttempt !== 'function' || typeof input.assertOperationAllowed !== 'function') throw new Error('Durable fulfillment claim and human/source fences required');
  await input.assertOperationAllowed();
  const fresh = await inspectExistingShipmentFulfillment(input.source, input.shipment);
  if (fresh.stateHash !== input.expectedStateHash) throw new Error('Fulfillment plan changed; reopen human confirmation');
  if (fresh.state === 'present') return { skipped: true, reason: 'exact-existing-fulfillment', fulfillmentIds: fresh.fulfillmentIds };
  await input.beforeExternalAttempt();
  await input.assertOperationAllowed();
  // Intent persistence and the following native fences can yield. Refunds or
  // transaction changes during either must be observed BEFORE the write, not
  // merely caught by a post-write readback.
  const atSend = await inspectExistingShipmentFulfillment(input.source, input.shipment);
  if (atSend.state !== 'missing' || atSend.stateHash !== fresh.stateHash) throw new Error('Fulfillment/refund/transaction evidence changed after intent; do not retry');
  // The final full snapshot can itself outlive the lease/source/claim. Fence
  // again after that await and its validation, immediately before mutation.
  await input.assertOperationAllowed();
  const response = await requestShopifyAdmin<FulfillmentCreateResponse>(FULFILLMENT_CREATE_MUTATION, {
    fulfillment: { lineItemsByFulfillmentOrder: fresh.lineItemsByFulfillmentOrder, notifyCustomer: false,
      trackingInfo: { company: 'Telegraph', number: input.shipment.code, url: dashboardUrl(input.shipment.id) } },
    message: `Existing Telegraph shipment fulfillment reconciliation: ${input.shipment.code}`
  });
  const result = response?.fulfillmentCreate;
  if (!result || !Array.isArray(result.userErrors) || result.userErrors.length ||
      !gid(result.fulfillment?.id, 'Fulfillment') || result.fulfillment.status !== 'SUCCESS') {
    throw new Error('Shopify fulfillment write not independently confirmed; do not retry');
  }
  await input.assertOperationAllowed();
  const after = await inspectExistingShipmentFulfillment(input.source, input.shipment);
  if (after.state !== 'present' || !after.fulfillmentIds.includes(result.fulfillment.id)) throw new Error('Shopify fulfillment readback not exact; do not retry');
  return { skipped: false, fulfillmentIds: after.fulfillmentIds };
}

interface FulfillmentOrderLineItemNode {
  id: string;
  remainingQuantity: number;
}

interface FulfillmentOrderNode {
  id: string;
  status: string;
  requestStatus?: string | null;
  lineItems: {
    nodes: FulfillmentOrderLineItemNode[];
  };
}

interface OrderFulfillmentOrdersResponse {
  order: {
    id: string;
    name: string;
    displayFulfillmentStatus?: string | null;
    fulfillmentOrders: {
      nodes: FulfillmentOrderNode[];
    };
  } | null;
}

interface FulfillmentCreateResponse {
  fulfillmentCreate: {
    fulfillment: {
      id: string;
      status: string;
    } | null;
    userErrors: Array<{ field?: string[] | null; message: string }>;
  };
}

interface FulfillmentTrackingInput {
  company: string;
  number?: string;
  url?: string;
}

export interface FulfillOrderResult {
  skipped: boolean;
  reason?: string;
  fulfillmentIds: string[];
}

const ORDER_FULFILLMENT_ORDERS_QUERY = `
  query TelegraphOrderFulfillmentOrders($id: ID!) {
    order(id: $id) {
      id
      name
      displayFulfillmentStatus
      fulfillmentOrders(first: 20) {
        nodes {
          id
          status
          requestStatus
          lineItems(first: 100) {
            nodes {
              id
              remainingQuantity
            }
          }
        }
      }
    }
  }
`;

const FULFILLMENT_CREATE_MUTATION = `
  mutation TelegraphFulfillmentCreate($fulfillment: FulfillmentInput!, $message: String) {
    fulfillmentCreate(fulfillment: $fulfillment, message: $message) {
      fulfillment {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const closedStatuses = new Set(['CLOSED', 'CANCELLED']);

const toOrderGid = (id: string | number): string =>
  String(id).startsWith('gid://shopify/Order/') ? String(id) : `gid://shopify/Order/${id}`;

const buildLineItemsByFulfillmentOrder = (orders: FulfillmentOrderNode[]) =>
  orders
    .filter((order) => !closedStatuses.has(order.status))
    .map((order) => ({
      fulfillmentOrderId: order.id,
      fulfillmentOrderLineItems: order.lineItems.nodes
        .filter((item) => item.remainingQuantity > 0)
        .map((item) => ({
          id: item.id,
          quantity: item.remainingQuantity
        }))
    }))
    .filter((entry) => entry.fulfillmentOrderLineItems.length > 0);

export const shopifyFulfillmentClient = {
  fulfillOrder: async (input: {
    orderId: string | number;
    trackingNumber?: string | null;
    trackingUrl?: string | null;
    notifyCustomer?: boolean;
    assertOperationAllowed?: () => Promise<void>;
    beforeExternalAttempt?: () => Promise<void>;
  }): Promise<FulfillOrderResult> => {
    await input.assertOperationAllowed?.();
    const orderGid = toOrderGid(input.orderId);
    const orderResponse = await requestShopifyAdmin<OrderFulfillmentOrdersResponse>(ORDER_FULFILLMENT_ORDERS_QUERY, {
      id: orderGid
    });

    if (!orderResponse.order) {
      throw new Error(`Shopify order not found for fulfillment: ${orderGid}`);
    }

    if (orderResponse.order.displayFulfillmentStatus === 'FULFILLED') {
      return { skipped: true, reason: 'already-fulfilled', fulfillmentIds: [] };
    }

    const lineItemsByFulfillmentOrder = buildLineItemsByFulfillmentOrder(orderResponse.order.fulfillmentOrders.nodes);
    if (lineItemsByFulfillmentOrder.length === 0) {
      return { skipped: true, reason: 'no-fulfillable-line-items', fulfillmentIds: [] };
    }

    const trackingInfo: FulfillmentTrackingInput = {
      company: 'Telegraph'
    };

    if (input.trackingNumber) {
      trackingInfo.number = input.trackingNumber;
    }

    if (input.trackingUrl) {
      trackingInfo.url = input.trackingUrl;
    }

    // A cancellation while the read was in flight must fence the write too.
    await input.assertOperationAllowed?.();
    await input.beforeExternalAttempt?.();
    await input.assertOperationAllowed?.();
    const response = await requestShopifyAdmin<FulfillmentCreateResponse>(FULFILLMENT_CREATE_MUTATION, {
      fulfillment: {
        lineItemsByFulfillmentOrder,
        notifyCustomer: input.notifyCustomer ?? false,
        trackingInfo
      },
      message: input.trackingNumber
        ? `Telegraph shipment created: ${input.trackingNumber}`
        : 'Telegraph shipment created'
    });

    const userErrors = response.fulfillmentCreate.userErrors;
    if (userErrors.length > 0) {
      throw new Error(
        `Shopify fulfillmentCreate failed: ${userErrors
          .map((error) => `${error.field?.join('.') ?? 'fulfillment'} ${error.message}`)
          .join('; ')}`
      );
    }

    if (!gid(response.fulfillmentCreate.fulfillment?.id, 'Fulfillment') || response.fulfillmentCreate.fulfillment.status !== 'SUCCESS') {
      throw new Error('Shopify fulfillment response did not confirm an exact successful fulfillment; do not retry');
    }
    return {
      skipped: false,
      fulfillmentIds: [response.fulfillmentCreate.fulfillment.id]
    };
  }
};
