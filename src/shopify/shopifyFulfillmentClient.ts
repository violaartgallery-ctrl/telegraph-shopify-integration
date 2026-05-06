import { requestShopifyAdmin } from './shopifyAdminGraphql.js';

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
  }): Promise<FulfillOrderResult> => {
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

    return {
      skipped: false,
      fulfillmentIds: response.fulfillmentCreate.fulfillment ? [response.fulfillmentCreate.fulfillment.id] : []
    };
  }
};
