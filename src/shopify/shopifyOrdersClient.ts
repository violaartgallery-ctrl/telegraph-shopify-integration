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
  zip?: string | null;
  country?: string | null;
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
  discountedUnitPriceSet: MoneySet;
}

interface ShopifyGraphqlAttribute {
  key: string;
  value?: string | null;
}

interface ShopifyGraphqlOrder {
  id: string;
  legacyResourceId: string;
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
  };
}

interface GetOrderResponse {
  order: ShopifyGraphqlOrder | null;
}

const ORDER_FIELDS = `
  fragment TelegraphOrderFields on Order {
    id
    legacyResourceId
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
      zip
      country
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
      zip
      country
      phone
      company
    }
    customer {
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
        discountedUnitPriceSet {
          shopMoney {
            amount
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
        zip: address.zip,
        country: address.country,
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
    sku: item.sku ?? null,
    quantity: item.currentQuantity,
    current_quantity: item.currentQuantity,
    price: item.discountedUnitPriceSet.shopMoney.amount,
    variant_title: item.variantTitle
  }));

const mapOrder = (order: ShopifyGraphqlOrder): ShopifyOrder => ({
  id: Number.parseInt(order.legacyResourceId, 10),
  admin_graphql_api_id: order.id,
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
        first_name: order.customer.firstName,
        last_name: order.customer.lastName,
        phone: order.customer.phone,
        email: order.customer.email
      }
    : null,
  line_items: mapLineItems(order.lineItems.nodes)
});

export const shopifyOrdersClient = {
  listRecentOrders: async (first = 25): Promise<ShopifyOrder[]> => {
    const response = await requestShopifyAdmin<ListOrdersResponse>(LIST_ORDERS_QUERY, {
      first,
      query: 'fulfillment_status:unfulfilled'
    });
    return response.orders.nodes.map(mapOrder);
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
