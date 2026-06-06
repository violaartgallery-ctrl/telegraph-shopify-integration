import { env } from '../config/env.js';
import { requestShopifyAdmin } from './shopifyAdminGraphql.js';

const METAFIELDS_SET_MUTATION = `
  mutation SetAccurateMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors {
        field
        message
      }
    }
  }
`;

const TAGS_ADD_MUTATION = `
  mutation AddOrderTags($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors {
        field
        message
      }
    }
  }
`;

const TAGS_REMOVE_MUTATION = `
  mutation RemoveOrderTags($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      userErrors {
        field
        message
      }
    }
  }
`;

const ORDER_MARK_AS_PAID_MUTATION = `
  mutation TelegraphOrderMarkAsPaid($input: OrderMarkAsPaidInput!) {
    orderMarkAsPaid(input: $input) {
      order {
        id
        displayFinancialStatus
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// Phase 1 — works for COD orders that have no pending transaction.
// orderMarkAsPaid requires an existing authorization/pending transaction to capture,
// which COD orders never have. orderTransactionCreate inserts a fresh SALE transaction
// directly so Shopify recognises the order as paid.
const ORDER_TRANSACTION_CREATE_MUTATION = `
  mutation TelegraphOrderTransactionCreate($input: OrderTransactionInput!) {
    orderTransactionCreate(input: $input) {
      transaction {
        id
        status
        kind
        amountSet { shopMoney { amount currencyCode } }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const ORDER_PAYMENT_STATE_QUERY = `
  query OrderPaymentState($id: ID!) {
    order(id: $id) {
      id
      name
      cancelledAt
      displayFinancialStatus
      currencyCode
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      totalReceivedSet { shopMoney { amount } }
      totalOutstandingSet { shopMoney { amount } }
      fulfillments(first: 10) { id status }
      transactions(first: 20) { id kind status amountSet { shopMoney { amount } } }
    }
  }
`;

// Phase 1 (Case B) — order edit + discount + commit.
const ORDER_EDIT_BEGIN_MUTATION = `
  mutation TelegraphOrderEditBegin($id: ID!) {
    orderEditBegin(id: $id) {
      calculatedOrder { id lineItems(first: 50) { edges { node { id quantity } } } }
      userErrors { field message }
    }
  }
`;

const ORDER_EDIT_ADD_LINE_DISCOUNT_MUTATION = `
  mutation TelegraphOrderEditAddDiscount($id: ID!, $lineItemId: ID!, $discount: OrderEditAppliedDiscountInput!) {
    orderEditAddLineItemDiscount(id: $id, lineItemId: $lineItemId, discount: $discount) {
      calculatedLineItem { id }
      userErrors { field message }
    }
  }
`;

const ORDER_EDIT_COMMIT_MUTATION = `
  mutation TelegraphOrderEditCommit($id: ID!, $notifyCustomer: Boolean!, $staffNote: String) {
    orderEditCommit(id: $id, notifyCustomer: $notifyCustomer, staffNote: $staffNote) {
      order { id currentTotalPriceSet { shopMoney { amount } } }
      userErrors { field message }
    }
  }
`;

// Phase 2 — returns / cancellations.
const ORDER_CANCEL_MUTATION = `
  mutation TelegraphOrderCancel($orderId: ID!, $reason: OrderCancelReason!, $refund: Boolean!, $restock: Boolean!, $notifyCustomer: Boolean!, $staffNote: String) {
    orderCancel(orderId: $orderId, reason: $reason, refund: $refund, restock: $restock, notifyCustomer: $notifyCustomer, staffNote: $staffNote) {
      job { id done }
      orderCancelUserErrors { field message }
      userErrors { field message }
    }
  }
`;

const FULFILLMENT_CANCEL_MUTATION = `
  mutation TelegraphFulfillmentCancel($id: ID!) {
    fulfillmentCancel(id: $id) {
      fulfillment { id status }
      userErrors { field message }
    }
  }
`;

// Phase 2 — flagging.
const ORDER_UPDATE_MUTATION = `
  mutation TelegraphOrderUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id note tags }
      userErrors { field message }
    }
  }
`;

const toOrderGid = (id: string | number): string => `gid://shopify/Order/${id}`;

const statusTagsToReplace = [
  'accurate-cancelled',
  'accurate-delivered',
  'accurate-collected',
  'accurate-delivered-not-collected',
  'accurate-payment-review',
  'accurate-returned',
  'accurate-returned-settled',
  'accurate-returned-unsettled',
  'accurate-out-for-delivery',
  'accurate-redelivery-pending',
  'accurate-delivery-exception',
  'accurate-return-in-transit',
  'accurate-received',
  'accurate-scheduled',
  'accurate-pkr',
  'accurate-pkm',
  'accurate-pkh',
  'accurate-pkd',
  'accurate-prp',
  'accurate-bmr',
  'accurate-bmt',
  'accurate-std',
  'accurate-dtr',
  'accurate-dex',
  'accurate-htr',
  'accurate-rtrn',
  'accurate-rts',
  'accurate-rjct',
  'accurate-unknown'
];

export interface MarkOrderAsPaidResult {
  skipped: boolean;
  reason?: string;
  financialStatus?: string;
}

export interface ShopifyStatusUpdateInput {
  orderId: string | number;
  shipmentStatus: string;
  collectionStatus: string;
  collectedAmount?: number | null;
  returnedValue?: number | null;
  trackingUrl?: string | null;
  tags: string[];
  syncSummary: string;
}

export const shopifyStatusSyncClient = {
  syncShipmentState: async (input: ShopifyStatusUpdateInput): Promise<void> => {
    const ownerId = toOrderGid(input.orderId);
    const metafields = [
      {
        ownerId,
        namespace: env.shopify.statusMetafieldNamespace,
        key: env.shopify.statusMetafieldKey,
        type: 'single_line_text_field',
        value: input.shipmentStatus
      },
      {
        ownerId,
        namespace: env.shopify.statusMetafieldNamespace,
        key: env.shopify.collectionMetafieldKey,
        type: 'single_line_text_field',
        value: input.collectionStatus
      },
      {
        ownerId,
        namespace: env.shopify.statusMetafieldNamespace,
        key: env.shopify.collectedAmountMetafieldKey,
        type: 'number_decimal',
        value: String(input.collectedAmount ?? 0)
      },
      {
        ownerId,
        namespace: env.shopify.statusMetafieldNamespace,
        key: env.shopify.returnedValueMetafieldKey,
        type: 'number_decimal',
        value: String(input.returnedValue ?? 0)
      },
      {
        ownerId,
        namespace: env.shopify.statusMetafieldNamespace,
        key: env.shopify.syncSummaryMetafieldKey,
        type: 'multi_line_text_field',
        value: input.syncSummary
      }
    ];

    if (input.trackingUrl) {
      metafields.push({
        ownerId,
        namespace: env.shopify.statusMetafieldNamespace,
        key: env.shopify.trackingUrlMetafieldKey,
        type: 'single_line_text_field',
        value: input.trackingUrl
      });
    }

    const metafieldsResponse = await requestShopifyAdmin<{
      metafieldsSet: { userErrors: Array<{ message: string }> };
    }>(METAFIELDS_SET_MUTATION, { metafields });

    if (metafieldsResponse.metafieldsSet.userErrors.length > 0) {
      throw new Error(metafieldsResponse.metafieldsSet.userErrors.map((entry) => entry.message).join('; '));
    }

    const removeTagsResponse = await requestShopifyAdmin<{
      tagsRemove: { userErrors: Array<{ message: string }> };
    }>(TAGS_REMOVE_MUTATION, { id: ownerId, tags: statusTagsToReplace });

    if (removeTagsResponse.tagsRemove.userErrors.length > 0) {
      throw new Error(removeTagsResponse.tagsRemove.userErrors.map((entry) => entry.message).join('; '));
    }

    const tagsResponse = await requestShopifyAdmin<{
      tagsAdd: { userErrors: Array<{ message: string }> };
    }>(TAGS_ADD_MUTATION, { id: ownerId, tags: input.tags });

    if (tagsResponse.tagsAdd.userErrors.length > 0) {
      throw new Error(tagsResponse.tagsAdd.userErrors.map((entry) => entry.message).join('; '));
    }
  },

  /**
   * @deprecated Kept for backward-compat. Prefer `recordCustomerPayment` which works
   * for COD orders too. New callers should not use this.
   */
  markOrderAsPaid: async (orderId: string | number): Promise<MarkOrderAsPaidResult> => {
    const ownerId = toOrderGid(orderId);

    const response = await requestShopifyAdmin<{
      orderMarkAsPaid: {
        order: { id: string; displayFinancialStatus: string } | null;
        userErrors: Array<{ field?: string[] | null; message: string }>;
      };
    }>(ORDER_MARK_AS_PAID_MUTATION, { input: { id: ownerId } });

    const userErrors = response.orderMarkAsPaid.userErrors;
    if (userErrors.length > 0) {
      const messages = userErrors.map((entry) => entry.message).join('; ');
      if (/already paid/i.test(messages)) {
        return { skipped: true, reason: 'already-paid' };
      }
      throw new Error(`Shopify orderMarkAsPaid failed: ${messages}`);
    }

    return {
      skipped: false,
      financialStatus: response.orderMarkAsPaid.order?.displayFinancialStatus
    };
  },

  /**
   * Read the Shopify order's current payment state (price, received, outstanding,
   * cancelled, transactions). Used by `recordCustomerPayment` for idempotency.
   */
  fetchOrderPaymentState: async (orderId: string | number): Promise<{
    cancelledAt: string | null;
    displayFinancialStatus: string | null;
    currencyCode: string | null;
    totalPrice: number;
    totalReceived: number;
    totalOutstanding: number;
    fulfillments: Array<{ id: string; status: string | null }>;
    transactions: Array<{ id: string; kind: string; status: string; amount: number }>;
  } | null> => {
    const ownerId = toOrderGid(orderId);
    const response = await requestShopifyAdmin<{
      order: {
        id: string;
        cancelledAt: string | null;
        displayFinancialStatus: string | null;
        currencyCode: string | null;
        currentTotalPriceSet: { shopMoney: { amount: string } };
        totalReceivedSet: { shopMoney: { amount: string } };
        totalOutstandingSet: { shopMoney: { amount: string } };
        fulfillments: Array<{ id: string; status: string | null }>;
        transactions: Array<{ id: string; kind: string; status: string; amountSet: { shopMoney: { amount: string } } }>;
      } | null;
    }>(ORDER_PAYMENT_STATE_QUERY, { id: ownerId });
    if (!response.order) return null;
    return {
      cancelledAt: response.order.cancelledAt,
      displayFinancialStatus: response.order.displayFinancialStatus,
      currencyCode: response.order.currencyCode,
      totalPrice: Number(response.order.currentTotalPriceSet?.shopMoney?.amount ?? 0),
      totalReceived: Number(response.order.totalReceivedSet?.shopMoney?.amount ?? 0),
      totalOutstanding: Number(response.order.totalOutstandingSet?.shopMoney?.amount ?? 0),
      fulfillments: response.order.fulfillments ?? [],
      transactions: (response.order.transactions ?? []).map((t) => ({
        id: t.id, kind: t.kind, status: t.status,
        amount: Number(t.amountSet?.shopMoney?.amount ?? 0)
      }))
    };
  },

  /**
   * Phase 1: record the customer's COD payment as a SALE transaction.
   *
   * Logic:
   *   - If already paid (cancelled or financial_status=paid) → skip.
   *   - If amount >= total → simple SALE transaction for amount.
   *   - If amount <  total → returns { needsDiscount, gap } so caller can
   *     add the gap as a discount before paying. We don't auto-edit here to
   *     keep transactional ownership clear.
   */
  recordCustomerPayment: async (params: {
    orderId: string | number;
    amount: number;
    gateway?: string;
  }): Promise<{ skipped: boolean; reason?: string; transactionId?: string; needsDiscountFor?: number; total?: number }> => {
    const ownerId = toOrderGid(params.orderId);
    const state = await shopifyStatusSyncClient.fetchOrderPaymentState(params.orderId);
    if (!state) return { skipped: true, reason: 'order-not-found' };
    if (state.cancelledAt) return { skipped: true, reason: 'order-cancelled' };
    if (state.displayFinancialStatus && /paid/i.test(state.displayFinancialStatus) && state.totalOutstanding <= 0.01) {
      return { skipped: true, reason: 'already-paid' };
    }

    const amount = Number(params.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { skipped: true, reason: 'invalid-amount' };
    }

    const gap = Number((state.totalPrice - amount).toFixed(2));
    if (gap > 0.01) {
      // Caller must add a discount first, then call again with the new (post-discount) total.
      return { skipped: true, reason: 'needs-discount', needsDiscountFor: gap, total: state.totalPrice };
    }

    const captureAmount = Math.min(amount, Math.max(state.totalOutstanding, state.totalPrice));
    const response = await requestShopifyAdmin<{
      orderTransactionCreate: {
        transaction: { id: string; status: string; kind: string } | null;
        userErrors: Array<{ field?: string[] | null; message: string }>;
      };
    }>(ORDER_TRANSACTION_CREATE_MUTATION, {
      input: {
        orderId: ownerId,
        kind: 'SALE',
        status: 'SUCCESS',
        amount: captureAmount.toFixed(2),
        gateway: params.gateway ?? 'Cash on Delivery (COD)',
        parentId: null
      }
    });
    const errs = response.orderTransactionCreate.userErrors;
    if (errs.length > 0) {
      const msg = errs.map((e) => e.message).join('; ');
      if (/already paid|cannot.*paid/i.test(msg)) {
        return { skipped: true, reason: 'already-paid' };
      }
      throw new Error(`orderTransactionCreate failed: ${msg}`);
    }
    return { skipped: false, transactionId: response.orderTransactionCreate.transaction?.id };
  },

  /**
   * Phase 1 (Case B): collected < shopifyTotal.
   * Begin an order edit, add a line-item discount equal to the gap on the first
   * product line, commit the edit, then create a SALE transaction for the
   * (now-discounted) total.
   *
   * The discount is concentrated on the first line for simplicity; total still
   * reduces by exactly `discountAmount`, which is what matters for reporting.
   */
  applyOrderDiscountAndPay: async (params: {
    orderId: string | number;
    discountAmount: number;
    paymentAmount: number;
    discountDescription?: string;
    gateway?: string;
  }): Promise<{ transactionId?: string; calculatedOrderId?: string }> => {
    const ownerId = toOrderGid(params.orderId);

    // 1. Begin edit — also returns the calculatedOrder with line item ids.
    const begin = await requestShopifyAdmin<{
      orderEditBegin: {
        calculatedOrder: {
          id: string;
          lineItems: { edges: Array<{ node: { id: string; quantity: number } }> };
        } | null;
        userErrors: Array<{ field?: string[] | null; message: string }>;
      };
    }>(ORDER_EDIT_BEGIN_MUTATION, { id: ownerId });
    if (begin.orderEditBegin.userErrors.length > 0) {
      throw new Error('orderEditBegin: ' + begin.orderEditBegin.userErrors.map((e) => e.message).join('; '));
    }
    const calc = begin.orderEditBegin.calculatedOrder;
    if (!calc) throw new Error('orderEditBegin returned no calculatedOrder');
    const firstLineId = calc.lineItems.edges?.[0]?.node?.id;
    if (!firstLineId) throw new Error('orderEditBegin: order has no line items to discount');

    // 2. Add the discount as a fixed amount on the first line.
    const add = await requestShopifyAdmin<{
      orderEditAddLineItemDiscount: {
        calculatedLineItem: { id: string } | null;
        userErrors: Array<{ field?: string[] | null; message: string }>;
      };
    }>(ORDER_EDIT_ADD_LINE_DISCOUNT_MUTATION, {
      id: calc.id,
      lineItemId: firstLineId,
      discount: {
        fixedValue: { amount: Number(params.discountAmount).toFixed(2) },
        description: params.discountDescription ?? 'Telegraph collection adjustment'
      }
    });
    if (add.orderEditAddLineItemDiscount.userErrors.length > 0) {
      throw new Error('orderEditAddLineItemDiscount: ' + add.orderEditAddLineItemDiscount.userErrors.map((e) => e.message).join('; '));
    }

    // 3. Commit the edit so the order total drops by `discountAmount`.
    const commit = await requestShopifyAdmin<{
      orderEditCommit: {
        order: { id: string; currentTotalPriceSet: { shopMoney: { amount: string } } } | null;
        userErrors: Array<{ field?: string[] | null; message: string }>;
      };
    }>(ORDER_EDIT_COMMIT_MUTATION, {
      id: calc.id,
      notifyCustomer: false,
      staffNote: params.discountDescription ?? 'Telegraph collection adjustment'
    });
    if (commit.orderEditCommit.userErrors.length > 0) {
      throw new Error('orderEditCommit: ' + commit.orderEditCommit.userErrors.map((e) => e.message).join('; '));
    }

    // 4. Create the SALE transaction for the actual collected amount.
    const tx = await requestShopifyAdmin<{
      orderTransactionCreate: {
        transaction: { id: string; status: string; kind: string } | null;
        userErrors: Array<{ field?: string[] | null; message: string }>;
      };
    }>(ORDER_TRANSACTION_CREATE_MUTATION, {
      input: {
        orderId: ownerId,
        kind: 'SALE',
        status: 'SUCCESS',
        amount: Number(params.paymentAmount).toFixed(2),
        gateway: params.gateway ?? 'Cash on Delivery (COD)',
        parentId: null
      }
    });
    if (tx.orderTransactionCreate.userErrors.length > 0) {
      throw new Error('orderTransactionCreate after edit: ' + tx.orderTransactionCreate.userErrors.map((e) => e.message).join('; '));
    }

    return {
      transactionId: tx.orderTransactionCreate.transaction?.id,
      calculatedOrderId: calc.id
    };
  },

  /**
   * Phase 2: cancel an order (used for returned / returned-settled).
   *
   * Skips if the order is already cancelled. Reason defaults to "OTHER" because
   * Telegraph returns don't fit any of Shopify's predefined enums neatly.
   */
  cancelOrder: async (params: {
    orderId: string | number;
    reason?: 'CUSTOMER' | 'DECLINED' | 'FRAUD' | 'INVENTORY' | 'OTHER' | 'STAFF';
    refund?: boolean;
    restock?: boolean;
    notifyCustomer?: boolean;
    staffNote?: string;
  }): Promise<{ skipped: boolean; reason?: string }> => {
    const ownerId = toOrderGid(params.orderId);
    const state = await shopifyStatusSyncClient.fetchOrderPaymentState(params.orderId);
    if (!state) return { skipped: true, reason: 'order-not-found' };
    if (state.cancelledAt) return { skipped: true, reason: 'already-cancelled' };

    const response = await requestShopifyAdmin<{
      orderCancel: {
        job: { id: string; done: boolean } | null;
        orderCancelUserErrors: Array<{ field?: string[] | null; message: string }>;
        userErrors: Array<{ field?: string[] | null; message: string }>;
      };
    }>(ORDER_CANCEL_MUTATION, {
      orderId: ownerId,
      reason: params.reason ?? 'OTHER',
      refund: params.refund ?? false,
      restock: params.restock ?? true,
      notifyCustomer: params.notifyCustomer ?? false,
      staffNote: params.staffNote ?? null
    });
    const errs = [
      ...(response.orderCancel.orderCancelUserErrors ?? []),
      ...(response.orderCancel.userErrors ?? [])
    ];
    if (errs.length > 0) throw new Error(`orderCancel failed: ${errs.map((e) => e.message).join('; ')}`);
    return { skipped: false };
  },

  /**
   * Phase 2: flag an order without cancelling it. Used for delivered-not-collected
   * (customer already has the product, so we can't cancel — but we must surface it
   * for human follow-up).
   */
  flagOrderForFollowUp: async (params: {
    orderId: string | number;
    note: string;
    tag?: string;
  }): Promise<{ skipped: boolean; reason?: string }> => {
    const ownerId = toOrderGid(params.orderId);
    const tagsToAdd = params.tag ? [params.tag] : ['needs-collection-followup'];
    // Add the tag.
    const tagsResp = await requestShopifyAdmin<{
      tagsAdd: { userErrors: Array<{ message: string }> };
    }>(TAGS_ADD_MUTATION, { id: ownerId, tags: tagsToAdd });
    if (tagsResp.tagsAdd.userErrors.length > 0) {
      throw new Error('flagOrderForFollowUp tagsAdd: ' + tagsResp.tagsAdd.userErrors.map((e) => e.message).join('; '));
    }
    // Append the note.
    const updResp = await requestShopifyAdmin<{
      orderUpdate: { order: { id: string; note: string | null; tags: string[] } | null; userErrors: Array<{ message: string }> };
    }>(ORDER_UPDATE_MUTATION, { input: { id: ownerId, note: params.note } });
    if (updResp.orderUpdate.userErrors.length > 0) {
      throw new Error('flagOrderForFollowUp orderUpdate: ' + updResp.orderUpdate.userErrors.map((e) => e.message).join('; '));
    }
    return { skipped: false };
  }
};
