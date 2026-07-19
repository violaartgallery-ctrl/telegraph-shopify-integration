import { requestShopifyAdmin } from './shopifyAdminGraphql.js';
import type { ShopifyAddress, ShopifyLineItem, ShopifyOrder } from '../types/shopify.js';

interface MoneySet {
  shopMoney: {
    amount: string;
  };
}

interface ShopifyGraphqlAddress {
  firstName?: string | null;
  lastName?: string | null;
  name?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  provinceCode?: string | null;
  zip?: string | null;
  country?: string | null;
  countryCodeV2?: string | null;
  phone?: string | null;
  company?: string | null;
}

interface ShopifyGraphqlLineItem {
  id: string;
  title: string;
  sku?: string | null;
  quantity: number;
  currentQuantity: number;
  variantTitle?: string | null;
  variant?: {
    id: string;
    sku?: string | null;
    title?: string | null;
    product?: {
      id: string;
    } | null;
  } | null;
  discountedUnitPriceSet: MoneySet;
  discountAllocations?: Array<{
    allocatedAmountSet: MoneySet;
  }>;
}

interface ShopifyGraphqlAttribute {
  key: string;
  value?: string | null;
}

interface ShopifyGraphqlOrder {
  id: string;
  legacyResourceId: string;
  createdAt: string;
  cancelledAt?: string | null;
  name: string;
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
  confirmed?: boolean | null;
  email?: string | null;
  phone?: string | null;
  test?: boolean | null;
  tags?: string[];
  note?: string | null;
  customAttributes?: ShopifyGraphqlAttribute[];
  paymentGatewayNames?: string[];
  totalPriceSet: MoneySet;
  totalOutstandingSet?: MoneySet;
  currentTotalPriceSet?: MoneySet;
  shippingAddress?: ShopifyGraphqlAddress | null;
  billingAddress?: ShopifyGraphqlAddress | null;
  customer?: {
    id: string;
    firstName?: string | null;
    lastName?: string | null;
    phone?: string | null;
    email?: string | null;
  } | null;
  lineItems: {
    nodes: ShopifyGraphqlLineItem[];
  };
}

interface ListOrdersResponse {
  orders: {
    nodes: ShopifyGraphqlOrder[];
    pageInfo?: {
      hasNextPage: boolean;
      endCursor?: string | null;
    };
  };
}

interface GetOrderResponse {
  order: ShopifyGraphqlOrder | null;
}

const ORDER_FIELDS = `
  fragment TelegraphOrderFields on Order {
    id
    legacyResourceId
    createdAt
    cancelledAt
    name
    displayFinancialStatus
    displayFulfillmentStatus
    confirmed
    email
    phone
    test
    tags
    note
    customAttributes {
      key
      value
    }
    paymentGatewayNames
    totalPriceSet {
      shopMoney {
        amount
      }
    }
    totalOutstandingSet {
      shopMoney {
        amount
      }
    }
    currentTotalPriceSet {
      shopMoney {
        amount
      }
    }
    shippingAddress {
      firstName
      lastName
      name
      address1
      address2
      city
      province
      provinceCode
      zip
      country
      countryCodeV2
      phone
      company
    }
    billingAddress {
      firstName
      lastName
      name
      address1
      address2
      city
      province
      provinceCode
      zip
      country
      countryCodeV2
      phone
      company
    }
    customer {
      id
      firstName
      lastName
      phone
      email
    }
    lineItems(first: 50) {
      nodes {
        id
        title
        sku
        quantity
        currentQuantity
        variantTitle
        variant {
          id
          sku
          title
          product {
            id
          }
        }
        discountedUnitPriceSet {
          shopMoney {
            amount
          }
        }
        discountAllocations {
          allocatedAmountSet {
            shopMoney {
              amount
            }
          }
        }
      }
    }
  }
`;

const LIST_ORDERS_QUERY = `
  ${ORDER_FIELDS}
  query TelegraphOrders($first: Int!, $query: String) {
    orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        ...TelegraphOrderFields
      }
    }
  }
`;

const LIST_ALL_ORDERS_QUERY = `
  ${ORDER_FIELDS}
  query TelegraphAllOrders($first: Int!, $query: String, $after: String) {
    orders(first: $first, query: $query, after: $after, sortKey: CREATED_AT, reverse: true) {
      nodes {
        ...TelegraphOrderFields
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const GET_ORDER_QUERY = `
  ${ORDER_FIELDS}
  query TelegraphOrder($id: ID!) {
    order(id: $id) {
      ...TelegraphOrderFields
    }
  }
`;

const mapFinancialStatus = (status?: string | null): string | null =>
  status ? status.toLowerCase().replace(/ /g, '_') : null;

const mapFulfillmentStatus = (status?: string | null): string | null => {
  if (!status || status === 'UNFULFILLED') return null;
  return status.toLowerCase().replace(/ /g, '_');
};

const mapAddress = (address?: ShopifyGraphqlAddress | null): ShopifyAddress | null =>
  address
    ? {
        first_name: address.firstName,
        last_name: address.lastName,
        name: address.name,
        address1: address.address1,
        address2: address.address2,
        city: address.city,
        province: address.province,
        province_code: address.provinceCode,
        zip: address.zip,
        country: address.country,
        country_code: address.countryCodeV2,
        phone: address.phone,
        company: address.company
      }
    : null;

const parseOrderNumber = (order: ShopifyGraphqlOrder): number => {
  const fromName = Number.parseInt(order.name.replace(/\D/g, ''), 10);
  if (!Number.isNaN(fromName)) return fromName;
  const fromId = Number.parseInt(order.legacyResourceId, 10);
  return Number.isNaN(fromId) ? 0 : fromId;
};

const mapLineItems = (lineItems: ShopifyGraphqlLineItem[]): ShopifyLineItem[] =>
  lineItems.map((item) => ({
    id: Number.parseInt(item.id.replace(/\D/g, ''), 10),
    title: item.title,
    sku: item.sku ?? item.variant?.sku ?? null,
    quantity: item.currentQuantity,
    current_quantity: item.currentQuantity,
    price: item.discountedUnitPriceSet.shopMoney.amount,
    variant_title: item.variantTitle,
    variant_id: item.variant ? Number.parseInt(item.variant.id.replace(/\D/g, ''), 10) : null,
    product_id: item.variant?.product
      ? Number.parseInt(item.variant.product.id.replace(/\D/g, ''), 10)
      : null,
    discount_allocations: item.discountAllocations?.map((allocation) => ({
      amount: allocation.allocatedAmountSet.shopMoney.amount
    }))
  }));

const mapOrder = (order: ShopifyGraphqlOrder): ShopifyOrder => ({
  id: Number.parseInt(order.legacyResourceId, 10),
  admin_graphql_api_id: order.id,
  created_at: order.createdAt,
  cancelled_at: order.cancelledAt,
  name: order.name,
  order_number: parseOrderNumber(order),
  financial_status: mapFinancialStatus(order.displayFinancialStatus),
  fulfillment_status: mapFulfillmentStatus(order.displayFulfillmentStatus),
  confirmed: order.confirmed,
  note: order.note,
  note_attributes: order.customAttributes?.map((attribute) => ({
    name: attribute.key,
    key: attribute.key,
    value: attribute.value
  })),
  tags: order.tags?.join(', '),
  total_price: order.totalPriceSet.shopMoney.amount,
  total_outstanding: order.totalOutstandingSet?.shopMoney.amount,
  current_total_price: order.currentTotalPriceSet?.shopMoney.amount,
  gateway: order.paymentGatewayNames?.[0],
  payment_gateway_names: order.paymentGatewayNames,
  test: order.test ?? false,
  email: order.email,
  phone: order.phone,
  shipping_address: mapAddress(order.shippingAddress),
  billing_address: mapAddress(order.billingAddress),
  customer: order.customer
    ? {
        id: order.customer.id,
        first_name: order.customer.firstName,
        last_name: order.customer.lastName,
        phone: order.customer.phone,
        email: order.customer.email
      }
    : null,
  line_items: mapLineItems(order.lineItems.nodes)
});

export const shopifyOrdersClient = {
  listRecentOrders: async (first = 25, query = 'fulfillment_status:unfulfilled'): Promise<ShopifyOrder[]> => {
    const response = await requestShopifyAdmin<ListOrdersResponse>(LIST_ORDERS_QUERY, {
      first,
      query
    });
    return response.orders.nodes.map(mapOrder);
  },

  /** Read every matching order page, bounded to protect accidental broad scans. */
  listAllMatchingOrders: async (
    query: string,
    options: { pageSize?: number; maxOrders?: number } = {}
  ): Promise<ShopifyOrder[]> => {
    const pageSize = Math.min(250, Math.max(1, options.pageSize ?? 250));
    const maxOrders = Math.max(pageSize, options.maxOrders ?? 1000);
    const orders: ShopifyOrder[] = [];
    let after: string | null = null;

    while (orders.length < maxOrders) {
      const response: ListOrdersResponse = await requestShopifyAdmin<ListOrdersResponse>(LIST_ALL_ORDERS_QUERY, {
        first: Math.min(pageSize, maxOrders - orders.length),
        query,
        after,
      });
      orders.push(...response.orders.nodes.map(mapOrder));
      if (!response.orders.pageInfo?.hasNextPage || !response.orders.pageInfo.endCursor) break;
      after = response.orders.pageInfo.endCursor;
    }
    return orders;
  },

  getOrderByGid: async (id: string): Promise<ShopifyOrder> => {
    const response = await requestShopifyAdmin<GetOrderResponse>(GET_ORDER_QUERY, { id });
    if (!response.order) {
      throw new Error(`Shopify order not found: ${id}`);
    }
    return mapOrder(response.order);
  },

  getOrderByLegacyId: async (legacyId: string): Promise<ShopifyOrder> =>
    await shopifyOrdersClient.getOrderByGid(`gid://shopify/Order/${legacyId}`)
};
