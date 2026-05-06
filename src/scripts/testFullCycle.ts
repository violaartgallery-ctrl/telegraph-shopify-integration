import { AccurateClient } from '../accurate/accurateClient.js';
import { AccurateZoneResolver } from '../accurate/zoneResolver.js';
import { requestShopifyAdmin } from '../shopify/shopifyAdminGraphql.js';
import { shopifyOrdersClient } from '../shopify/shopifyOrdersClient.js';
import { AccurateMapper } from '../services/accurateMapper.js';
import { ShopifyOrderProcessor } from '../services/shopifyOrderProcessor.js';
import { shipmentRepository } from '../services/shipmentRepository.js';
import { env } from '../config/env.js';

const productLegacyId = process.env.TEST_SHOPIFY_PRODUCT_ID ?? '8129317240925';
const productGid = productLegacyId.startsWith('gid://')
  ? productLegacyId
  : `gid://shopify/Product/${productLegacyId}`;

interface ProductVariantResponse {
  product: {
    id: string;
    title: string;
    variants: {
      nodes: Array<{
        id: string;
        title: string;
        price: string;
      }>;
    };
  } | null;
}

interface OrderCreateResponse {
  orderCreate: {
    userErrors: Array<{ field?: string[] | null; message: string }>;
    order: {
      id: string;
      legacyResourceId: string;
      name: string;
    } | null;
  };
}

const PRODUCT_VARIANT_QUERY = `
  query ProductForTelegraphTest($id: ID!) {
    product(id: $id) {
      id
      title
      variants(first: 1) {
        nodes {
          id
          title
          price
        }
      }
    }
  }
`;

const ORDER_CREATE_MUTATION = `
  mutation CreateTelegraphTestOrder($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
    orderCreate(order: $order, options: $options) {
      userErrors {
        field
        message
      }
      order {
        id
        legacyResourceId
        name
      }
    }
  }
`;

const moneyBag = (amount: string) => ({
  shopMoney: {
    amount,
    currencyCode: 'EGP'
  }
});

const productResponse = await requestShopifyAdmin<ProductVariantResponse>(PRODUCT_VARIANT_QUERY, {
  id: productGid
});

const variant = productResponse.product?.variants.nodes[0];
if (!productResponse.product || !variant) {
  throw new Error(`Could not find a variant for Shopify product ${productLegacyId}`);
}

const orderResponse = await requestShopifyAdmin<OrderCreateResponse>(ORDER_CREATE_MUTATION, {
  order: {
    email: 'telegraph-test@loomlac.local',
    phone: '+201123490784',
    financialStatus: 'PENDING',
    currency: 'EGP',
    presentmentCurrency: 'EGP',
    sourceName: 'telegraph-integration-test',
    tags: ['telegraph-test', 'accurate-test'],
    note: `Telegraph integration full-cycle test for product ${productLegacyId}`,
    shippingAddress: {
      firstName: 'Telegraph',
      lastName: 'Test',
      phone: '+201123490784',
      address1: '82 ش وديع باشور السيوف شماعة الدور 7 شقة 31',
      address2: 'السيوف',
      city: 'الاسكندرية',
      countryCode: 'EG'
    },
    billingAddress: {
      firstName: 'Telegraph',
      lastName: 'Test',
      phone: '+201123490784',
      address1: '82 ش وديع باشور السيوف شماعة الدور 7 شقة 31',
      address2: 'السيوف',
      city: 'الاسكندرية',
      countryCode: 'EG'
    },
    lineItems: [
      {
        variantId: variant.id,
        quantity: 1,
        requiresShipping: true
      }
    ],
    shippingLines: [
      {
        title: 'Telegraph Shipping',
        code: 'telegraph',
        source: 'telegraph',
        priceSet: moneyBag('0.00')
      }
    ],
    transactions: [
      {
        kind: 'SALE',
        status: 'PENDING',
        gateway: 'Cash on Delivery (COD)',
        amountSet: moneyBag(variant.price),
        test: false
      }
    ]
  },
  options: {
    sendReceipt: false,
    sendFulfillmentReceipt: false
  }
});

const userErrors = orderResponse.orderCreate.userErrors;
if (userErrors.length > 0) {
  throw new Error(`Shopify orderCreate failed: ${userErrors.map((error) => `${error.field?.join('.') ?? 'order'} ${error.message}`).join('; ')}`);
}

const createdOrder = orderResponse.orderCreate.order;
if (!createdOrder) {
  throw new Error('Shopify orderCreate returned no order');
}

const order = await shopifyOrdersClient.getOrderByGid(createdOrder.id);
const accurateClient = new AccurateClient();
const mapper = new AccurateMapper(new AccurateZoneResolver(accurateClient));
const processor = new ShopifyOrderProcessor(accurateClient, mapper);
const result = await processor.process(order, { source: 'test-full-cycle' });
const record = await shipmentRepository.findByShopifyOrderId(String(order.id));

console.log('Full cycle succeeded');
console.log(`Shopify order: ${createdOrder.name} (${createdOrder.legacyResourceId})`);
console.log(`Product: ${productResponse.product.title}`);
console.log(`Variant: ${variant.title} (${variant.id})`);
console.log(`Shipment skipped: ${result.skipped ? result.reason ?? 'yes' : 'no'}`);
console.log(`Accurate shipment id: ${record?.accurateShipmentId ?? '-'}`);
console.log(`Accurate shipment code: ${record?.accurateShipmentCode ?? '-'}`);
console.log(`Accurate status: ${record?.accurateStatus ?? '-'}`);
console.log(`Shopify shop: ${env.shopify.shopDomain}`);
