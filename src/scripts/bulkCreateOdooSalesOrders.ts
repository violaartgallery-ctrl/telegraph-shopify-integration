import { env } from '../config/env.js';
import { OdooClient } from '../odoo/odooClient.js';
import { OdooSyncService } from '../odoo/odooSyncService.js';
import { requestShopifyAdmin } from '../shopify/shopifyAdminGraphql.js';
import type { ShopifyAddress, ShopifyLineItem, ShopifyOrder } from '../types/shopify.js';

interface MoneySet {
  shopMoney: {
    amount: string;
  };
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
  customAttributes?: Array<{ key: string; value?: string | null }>;
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
  variant?: {
    id: string;
    sku?: string | null;
    title?: string | null;
  } | null;
  discountedUnitPriceSet: MoneySet;
}

interface OrdersResponse {
  orders: {
    nodes: ShopifyGraphqlOrder[];
  };
}

const ORDER_FIELDS = `
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
  totalPriceSet { shopMoney { amount } }
  totalOutstandingSet { shopMoney { amount } }
  currentTotalPriceSet { shopMoney { amount } }
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
  lineItems(first: 100) {
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
      }
      discountedUnitPriceSet { shopMoney { amount } }
    }
  }
`;

const SHOPIFY_ORDER_QUERY = `
  query OrdersByName($query: String!) {
    orders(first: 5, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        ${ORDER_FIELDS}
      }
    }
  }
`;

const normalizeOrderName = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Order number cannot be empty');
  return trimmed.startsWith('#') ? trimmed : `#${trimmed.replace(/\D/g, '')}`;
};

const parseArgs = (args: string[]): { orderNames: string[]; execute: boolean } => {
  const orderNames = new Set<string>();
  let execute = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--execute') {
      execute = true;
      continue;
    }

    if (arg === '--orders') {
      const raw = args[index + 1];
      if (!raw) throw new Error('--orders requires a comma-separated value');
      for (const entry of raw.split(',')) {
        orderNames.add(normalizeOrderName(entry));
      }
      index += 1;
      continue;
    }

    if (arg === '--from') {
      const from = Number.parseInt(args[index + 1] ?? '', 10);
      const toIndex = args.indexOf('--to');
      const to = Number.parseInt(toIndex >= 0 ? args[toIndex + 1] ?? '' : '', 10);
      if (Number.isNaN(from) || Number.isNaN(to)) {
        throw new Error('--from must be used with --to, for example --from 1760 --to 1821');
      }
      const start = Math.min(from, to);
      const end = Math.max(from, to);
      for (let orderNumber = start; orderNumber <= end; orderNumber += 1) {
        orderNames.add(`#${orderNumber}`);
      }
      index += 1;
      continue;
    }
  }

  if (orderNames.size === 0) {
    throw new Error('Use --orders "#1816,#1817" or --from 1760 --to 1821');
  }

  return { orderNames: [...orderNames], execute };
};

const mapFinancialStatus = (status?: string | null): string | null =>
  status ? status.toLowerCase().replace(/ /g, '_') : null;

const mapFulfillmentStatus = (status?: string | null): string | null =>
  status && status !== 'UNFULFILLED' ? status.toLowerCase().replace(/ /g, '_') : null;

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
    sku: item.sku ?? item.variant?.sku ?? null,
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

const findShopifyOrder = async (orderName: string): Promise<ShopifyOrder | undefined> => {
  const response = await requestShopifyAdmin<OrdersResponse>(SHOPIFY_ORDER_QUERY, {
    query: `name:${orderName}`
  });
  const exact = response.orders.nodes.find((order) => order.name === orderName);
  return exact ? mapOrder(exact) : undefined;
};

const odooReference = (order: ShopifyOrder): string =>
  `${order.name} / ${env.orderReferencePrefix}-${order.order_number}`;

const main = async (): Promise<void> => {
  const { orderNames, execute } = parseArgs(process.argv.slice(2));
  const odooClient = new OdooClient();
  const odooSyncService = new OdooSyncService(odooClient);
  const report = [];

  for (const orderName of orderNames) {
    const order = await findShopifyOrder(orderName);
    if (!order) {
      report.push({ order: orderName, status: 'not-found' });
      continue;
    }

    const preview = await odooSyncService.previewOrder(order);
    const [existingSaleOrder] = await odooClient.searchRead<{ id: number; name?: string }>(
      'sale.order',
      ['|', ['client_order_ref', '=', odooReference(order)], ['origin', '=', order.name]],
      ['name'],
      { limit: 1, order: 'id desc' }
    );

    if (existingSaleOrder?.name) {
      report.push({
        order: order.name,
        status: 'already-exists',
        saleOrderName: existingSaleOrder.name,
        reference: odooReference(order)
      });
      continue;
    }

    if (!preview.ready) {
      report.push({
        order: order.name,
        status: 'not-ready',
        reference: preview.reference,
        customer: preview.customer,
        products: preview.products
      });
      continue;
    }

    if (!execute) {
      report.push({
        order: order.name,
        status: 'ready-dry-run',
        reference: preview.reference,
        products: preview.products.map((product) => ({
          title: product.title,
          sku: product.sku,
          odooProductId: product.odooProductId
        }))
      });
      continue;
    }

    const result = await odooSyncService.ensureSalesOrder(order);
    report.push({
      order: order.name,
      status: result.created ? 'created' : 'already-synced',
      saleOrderId: result.id,
      saleOrderName: result.name,
      reference: preview.reference
    });
  }

  const summary = report.reduce<Record<string, number>>((accumulator, item) => {
    accumulator[item.status] = (accumulator[item.status] ?? 0) + 1;
    return accumulator;
  }, {});

  console.log(JSON.stringify({ execute, total: report.length, summary, report }, null, 2));
};

await main();
