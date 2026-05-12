import dotenv from 'dotenv';

dotenv.config();

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const optionalInt = (name: string): number | undefined => {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer`);
  }
  return parsed;
};

const optionalFloat = (name: string): number | undefined => {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a number`);
  }
  return parsed;
};

const optionalBool = (name: string): boolean => {
  const value = process.env[name];
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
};

const optionalString = (name: string): string => process.env[name] ?? '';

const productIdMap = (() => {
  const raw = process.env.ACCURATE_PRODUCT_ID_MAP_JSON;
  if (!raw) return {} as Record<string, number>;
  const parsed = JSON.parse(raw) as Record<string, number>;
  return parsed;
})();

export const env = {
  port: optionalInt('PORT') ?? 3000,
  logLevel: process.env.LOG_LEVEL ?? 'info',
  databaseUrl: required('DATABASE_URL'),
  syncOpenShipmentsIntervalMs: optionalInt('SYNC_OPEN_SHIPMENTS_INTERVAL_MS') ?? 600_000,
  syncOpenShipmentsBatchSize: optionalInt('SYNC_OPEN_SHIPMENTS_BATCH_SIZE') ?? 10,
  // Time budget (ms) for a single sync-open-shipments run before Netlify timeout.
  // Default 20 000 ms leaves ~6 s buffer from the Netlify 26 s function limit.
  syncTimeBudgetMs: optionalInt('SYNC_TIME_BUDGET_MS') ?? 20_000,
  // Admin UI protection — required to call sensitive admin routes.
  // If empty the routes remain open with a startup warning (backward compat).
  adminSecretToken: optionalString('ADMIN_SECRET_TOKEN'),
  shipmentCodePrefix: process.env.SHIPMENT_CODE_PREFIX,
  shipmentCodeStart: optionalInt('SHIPMENT_CODE_START') ?? 1,
  orderReferencePrefix: process.env.ORDER_REFERENCE_PREFIX ?? 'Loomlac',
  shopify: {
    shopDomain: required('SHOPIFY_SHOP_DOMAIN'),
    clientId: required('SHOPIFY_CLIENT_ID'),
    clientSecret: required('SHOPIFY_CLIENT_SECRET'),
    webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET ?? required('SHOPIFY_CLIENT_SECRET'),
    apiVersion: process.env.SHOPIFY_API_VERSION ?? '2025-10',
    statusMetafieldNamespace: process.env.SHOPIFY_STATUS_METAFIELD_NAMESPACE ?? 'accurate',
    statusMetafieldKey: process.env.SHOPIFY_STATUS_METAFIELD_KEY ?? 'shipment_status',
    collectionMetafieldKey: process.env.SHOPIFY_COLLECTION_METAFIELD_KEY ?? 'collection_status',
    collectedAmountMetafieldKey: process.env.SHOPIFY_COLLECTED_AMOUNT_METAFIELD_KEY ?? 'collected_amount',
    returnedValueMetafieldKey: process.env.SHOPIFY_RETURNED_VALUE_METAFIELD_KEY ?? 'returned_value',
    trackingUrlMetafieldKey: process.env.SHOPIFY_TRACKING_URL_METAFIELD_KEY ?? 'tracking_url',
    syncSummaryMetafieldKey: process.env.SHOPIFY_SYNC_SUMMARY_METAFIELD_KEY ?? 'sync_summary'
  },
  accurate: {
    // Shared secret for incoming Accurate/Telegraph webhook calls.
    // If empty the endpoint accepts any caller with a startup warning (backward compat).
    webhookSecret: optionalString('ACCURATE_WEBHOOK_SECRET'),
    endpoint: required('ACCURATE_GRAPHQL_ENDPOINT'),
    username: required('ACCURATE_USERNAME'),
    password: required('ACCURATE_PASSWORD'),
    defaultBranchId: optionalInt('ACCURATE_DEFAULT_BRANCH_ID'),
    defaultServiceId: optionalInt('ACCURATE_DEFAULT_SERVICE_ID'),
    defaultCustomerId: optionalInt('ACCURATE_DEFAULT_CUSTOMER_ID'),
    defaultShipmentType: required('ACCURATE_DEFAULT_SHIPMENT_TYPE'),
    defaultPaymentType: required('ACCURATE_DEFAULT_PAYMENT_TYPE'),
    defaultRecipientZoneId: optionalInt('ACCURATE_DEFAULT_RECIPIENT_ZONE_ID'),
    defaultRecipientSubzoneId: optionalInt('ACCURATE_DEFAULT_RECIPIENT_SUBZONE_ID'),
    senderName: process.env.ACCURATE_SENDER_NAME,
    senderPhone: process.env.ACCURATE_SENDER_PHONE,
    senderMobile: process.env.ACCURATE_SENDER_MOBILE,
    senderAddress: process.env.ACCURATE_SENDER_ADDRESS,
    senderPostalCode: process.env.ACCURATE_SENDER_POSTAL_CODE,
    senderZoneId: optionalInt('ACCURATE_SENDER_ZONE_ID'),
    senderSubzoneId: optionalInt('ACCURATE_SENDER_SUBZONE_ID'),
    defaultPriceType: process.env.ACCURATE_DEFAULT_PRICE_TYPE ?? 'INCLD',
    defaultOpenableCode: process.env.ACCURATE_DEFAULT_OPENABLE_CODE,
    defaultPiecesCount: optionalInt('ACCURATE_DEFAULT_PIECES_COUNT') ?? 1,
    defaultWeight: optionalFloat('ACCURATE_DEFAULT_WEIGHT'),
    productIdMap,
    defaultProductTypeCode: process.env.ACCURATE_DEFAULT_PRODUCT_TYPE_CODE
  },
  odoo: {
    enabled: optionalBool('ODOO_SYNC_ENABLED'),
    url: process.env.ODOO_URL?.replace(/\/$/, ''),
    db: process.env.ODOO_DB,
    username: process.env.ODOO_USERNAME,
    password: process.env.ODOO_PASSWORD,
    paymentJournalId: optionalInt('ODOO_PAYMENT_JOURNAL_ID'),
    // Odoo account ID for the expense line on Telegraph return-charge vendor bills.
    // REQUIRED when Odoo sync is enabled and returns are expected.
    // Run: Settings → Chart of Accounts, find the appropriate expense account, note its ID.
    returnChargeAccountId: optionalInt('ODOO_RETURN_CHARGE_ACCOUNT_ID')
  }
};

export type AppEnv = typeof env;
