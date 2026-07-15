import {
  buildMetaDeliveredPayload,
  evaluateMetaDeliveredEligibility,
  normalizeEmail,
  normalizeExternalId,
  normalizePhoneE164Digits,
  sha256
} from '../meta/metaDeliveredPayload.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  assert(Object.is(actual, expected), `${message}: expected ${String(expected)}, got ${String(actual)}`);
};

const CUTOVER = '2026-07-15T12:00:00.000Z';
const CREATED = '2026-07-15T12:00:01.000Z';
const DELIVERED = '2026-07-25T08:09:10.987Z';

const eligibleBase = {
  shopifyOrderId: '6000000000001',
  shopifyCreatedAt: CREATED,
  deliveredAt: DELIVERED,
  cutoverAt: CUTOVER,
  statusCode: 'DTR',
  collectionStatus: 'collected',
  customerDue: 999,
  orderTest: false
};

const eligibilityFailures = [
  { name: 'missing order id', patch: { shopifyOrderId: ' ' }, reason: 'missing_shopify_order_id' },
  { name: 'invalid cutover', patch: { cutoverAt: 'bad-date' }, reason: 'invalid_cutover_at' },
  { name: 'invalid created at', patch: { shopifyCreatedAt: null }, reason: 'invalid_shopify_created_at' },
  { name: 'invalid delivered at', patch: { deliveredAt: null }, reason: 'invalid_delivered_at' },
  { name: 'Shopify test order', patch: { orderTest: true }, reason: 'test_order' },
  { name: 'test tag', patch: { orderTags: 'vip, test-order' }, reason: 'test_order' },
  { name: 'cancel flag', patch: { cancelled: true }, reason: 'cancelled_order' },
  { name: 'cancel timestamp', patch: { cancelledAt: '2026-07-20T00:00:00Z' }, reason: 'cancelled_order' },
  { name: 'cancel tag', patch: { orderTags: ['accurate-cancelled'] }, reason: 'cancelled_order' },
  { name: 'returned status', patch: { statusCode: 'RTRN' }, reason: 'returned_order' },
  { name: 'return status', patch: { returnStatusCode: 'RTS' }, reason: 'returned_order' },
  { name: 'returned timestamp', patch: { returnedAt: '2026-07-30T00:00:00Z' }, reason: 'returned_order' },
  { name: 'payment review state', patch: { collectionStatus: 'payment-review' }, reason: 'payment_review' },
  { name: 'negative customer due', patch: { customerDue: -1 }, reason: 'payment_review' },
  { name: 'not delivered', patch: { statusCode: 'OTD' }, reason: 'not_dtr' },
  { name: 'not collected', patch: { collectionStatus: 'delivered-not-collected' }, reason: 'not_collected' },
  {
    name: 'delivery timestamp before order creation',
    patch: { deliveredAt: '2026-07-15T12:00:00.500Z', shopifyCreatedAt: '2026-07-15T12:00:01.000Z' },
    reason: 'delivery_before_order'
  },
  {
    name: 'pre-cutover Shopify order even when delivery is new',
    patch: { shopifyCreatedAt: '2026-07-15T11:59:59.999Z' },
    reason: 'shopify_order_before_cutover'
  },
  {
    name: 'pre-cutover delivery',
    patch: { deliveredAt: '2026-07-15T11:59:59.999Z' },
    reason: 'delivery_before_cutover'
  }
] as const;

const eligible = evaluateMetaDeliveredEligibility(eligibleBase);
assert(eligible.eligible, 'DTR + collected post-cutover order must be eligible');

for (const scenario of eligibilityFailures) {
  const result = evaluateMetaDeliveredEligibility({ ...eligibleBase, ...scenario.patch });
  assert(!result.eligible, `${scenario.name}: unexpectedly eligible`);
  assertEqual(result.reason, scenario.reason, scenario.name);
}

const phoneVariants = ['01012345678', '+20 10 1234 5678', '00201012345678', '201012345678', '+20 (0)10-1234-5678'];
const normalizedPhones = phoneVariants.map((phone) => normalizePhoneE164Digits(phone));
for (const phone of normalizedPhones) assertEqual(phone, '201012345678', 'Egypt phone equivalence');
assertEqual(new Set(normalizedPhones).size, 1, 'Egypt phone variants must deduplicate');
assertEqual(normalizePhoneE164Digits('123'), undefined, 'invalid short phone must be rejected');
assertEqual(normalizeEmail('  CUSTOMER@Example.COM '), 'customer@example.com', 'email normalization');
assertEqual(normalizeEmail('not-an-email'), undefined, 'invalid email must be rejected');
assertEqual(
  normalizeExternalId('gid://shopify/Customer/12345'),
  normalizeExternalId(12345),
  'Shopify REST and GraphQL customer IDs must hash identically'
);

const richInput = {
  ...eligibleBase,
  order: {
    email: ' OWNER@Example.COM ',
    phone: '01012345678',
    total_price: '1500.00',
    current_total_price: '1499.50',
    currency: 'egp',
    shipping_address: {},
    billing_address: {
      first_name: '  Ahmed ',
      last_name: 'EL-Sayed',
      city: 'New Cairo',
      province_code: 'C',
      zip: '11-835',
      country: 'Egypt',
      phone: '+20 10 1234 5678'
    },
    customer: {
      id: 'gid://shopify/Customer/12345',
      first_name: 'fallback-first',
      last_name: 'fallback-last',
      email: 'owner@example.com',
      phone: '00201012345678'
    },
    line_items: [
      { id: 1, variant_id: 987, product_id: 654, quantity: 2, price: '749.75' },
      { id: 2, sku: 'SKU-2', quantity: 1, current_quantity: 0, price: '10' }
    ],
    note_attributes: [
      { name: '_fbc', value: 'fb.1.1721044800000.Abc_def-123' },
      { key: '_fbp', value: 'fb.1.1721044800000.1234567890' },
      { name: '_event_source_url', value: 'https://viola.example/products/bag?utm_source=meta#details' }
    ],
    browser_ip: '8.8.8.8',
    client_details: { user_agent: 'Mozilla/5.0 (Scenario Test)' }
  },
  collectedAmount: '1270.129',
  testEventCode: 'TEST12345'
};

const built = buildMetaDeliveredPayload(richInput);
assert(built.ok, `rich event should build, got ${built.ok ? 'ok' : built.reason}`);
assertEqual(built.payload.data[0].original_event_data.event_name, 'Purchase', 'original event name');
assertEqual(
  built.payload.data[0].original_event_data.event_time,
  Math.floor(new Date(CREATED).getTime() / 1000),
  'original purchase timestamp'
);
assertEqual(built.payload.data[0].original_event_data.order_id, eligibleBase.shopifyOrderId, 'original order ID');
assert(!('event_id' in built.payload.data[0].original_event_data), 'unknown Purchase event ID must not be invented');

const relativeSourceBuilt = buildMetaDeliveredPayload({
  ...richInput,
  testEventCode: undefined,
  eventSourceUrl: 'https://violaleather.com',
  order: {
    ...richInput.order,
    landing_site: '/products/wallet?utm_source=meta',
    note_attributes: [{ name: '_event_source_url', value: 'javascript:invalid' }]
  }
});
assert(relativeSourceBuilt.ok, 'relative Shopify landing page should build');
assertEqual(
  relativeSourceBuilt.payload.data[0].event_source_url,
  'https://violaleather.com/products/wallet?utm_source=meta',
  'relative landing URL resolution with invalid earlier candidate'
);
const event = built.payload.data[0];

assertEqual(event.event_name, 'Delivered', 'event name');
assertEqual(event.event_id, 'viola:delivered:6000000000001', 'stable event id');
assertEqual(event.event_time, Math.floor(new Date(DELIVERED).getTime() / 1000), 'actual delivery event time');
assertEqual(event.action_source, 'website', 'action source');
assertEqual(event.event_source_url, 'https://viola.example/products/bag?utm_source=meta', 'safe source URL');
assertEqual(built.payload.test_event_code, 'TEST12345', 'test event code');
assertEqual(event.custom_data.currency, 'EGP', 'currency normalization');
assertEqual(event.custom_data.value, 1270.13, 'collected amount and money rounding');
assertEqual(built.valueSource, 'collected_amount', 'value source');
assertEqual(event.custom_data.order_id, '6000000000001', 'custom order id');
assertEqual(event.custom_data.content_ids?.[0], '987', 'variant content id');
assertEqual(event.custom_data.contents?.[0]?.quantity, 2, 'content quantity');
assertEqual(event.custom_data.num_items, 2, 'zero-current-quantity item omitted');

assertEqual(event.user_data.em?.length, 1, 'normalized duplicate email must deduplicate');
assertEqual(event.user_data.ph?.length, 1, 'normalized duplicate phones must deduplicate');
assertEqual(event.user_data.em?.[0], sha256('owner@example.com'), 'email hash');
assertEqual(event.user_data.ph?.[0], sha256('201012345678'), 'phone hash');
assertEqual(event.user_data.fn?.[0], sha256('ahmed'), 'billing first name fallback hash');
assertEqual(event.user_data.ln?.[0], sha256('elsayed'), 'billing last name fallback hash');
assertEqual(event.user_data.ct?.[0], sha256('newcairo'), 'billing city fallback hash');
assertEqual(event.user_data.st?.[0], sha256('c'), 'state code hash');
assertEqual(event.user_data.zp?.[0], sha256('11835'), 'postal hash');
assertEqual(event.user_data.country?.[0], sha256('eg'), 'country hash');
assertEqual(event.user_data.external_id?.[0], sha256('12345'), 'canonical customer external id hash');
assertEqual(event.user_data.fbc, 'fb.1.1721044800000.Abc_def-123', 'valid fbc remains plaintext');
assertEqual(event.user_data.fbp, 'fb.1.1721044800000.1234567890', 'valid fbp remains plaintext');
assertEqual(event.user_data.client_ip_address, '8.8.8.8', 'public client IP remains plaintext');
assertEqual(event.user_data.client_user_agent, 'Mozilla/5.0 (Scenario Test)', 'user agent remains plaintext');
assertEqual(built.matchQuality.grade, 'excellent', 'rich payload matching grade');
assertEqual(built.matchQuality.emailCount, 1, 'match report email count');
assertEqual(built.matchQuality.phoneCount, 1, 'match report phone count');

const rebuilt = buildMetaDeliveredPayload(richInput);
assert(rebuilt.ok, 'same event must rebuild');
assertEqual(rebuilt.payloadJson, built.payloadJson, 'payload JSON must be deterministic');
assertEqual(rebuilt.payloadHash, built.payloadHash, 'payload hash must be deterministic');

const changedTime = buildMetaDeliveredPayload({
  ...richInput,
  deliveredAt: '2026-07-25T08:09:11.000Z'
});
assert(changedTime.ok, 'changed delivery time event must build');
assertEqual(changedTime.eventId, built.eventId, 'event ID must depend only on Shopify order ID');
assert(changedTime.payloadHash !== built.payloadHash, 'actual event-time change must change immutable payload hash');

const invalidBrowserIds = buildMetaDeliveredPayload({
  ...eligibleBase,
  order: {
    phone: '01012345678',
    fbc: 'bad-fbc',
    fbp: 'bad-fbp',
    browser_ip: '127.0.0.1',
    client_details: { user_agent: 'unknown' }
  }
});
assert(invalidBrowserIds.ok, 'phone-only event should still build');
assertEqual(invalidBrowserIds.payload.data[0].user_data.fbc, undefined, 'invalid fbc omitted');
assertEqual(invalidBrowserIds.payload.data[0].user_data.fbp, undefined, 'invalid fbp omitted');
assertEqual(invalidBrowserIds.payload.data[0].user_data.client_ip_address, undefined, 'private IP omitted');
assertEqual(invalidBrowserIds.payload.data[0].user_data.client_user_agent, undefined, 'placeholder UA omitted');

const noMatch = buildMetaDeliveredPayload({ ...eligibleBase, order: {} });
assert(!noMatch.ok, 'event with no meaningful matching signal must not build');
assertEqual(noMatch.reason, 'no_matchable_user_data', 'no-match failure reason');

const invalidTestCode = buildMetaDeliveredPayload({
  ...eligibleBase,
  order: { phone: '01012345678' },
  testEventCode: 'wrong code'
});
assert(!invalidTestCode.ok, 'invalid test code must not silently become live');
assertEqual(invalidTestCode.reason, 'invalid_test_event_code', 'invalid test code failure reason');

const totalFallback = buildMetaDeliveredPayload({
  ...eligibleBase,
  order: { phone: '01012345678', total_price: '999.99', currency: 'EGP' },
  collectedAmount: null
});
assert(totalFallback.ok, 'order total fallback event should build');
assertEqual(totalFallback.valueSource, 'order_total', 'order total fallback source');
assertEqual(totalFallback.payload.data[0].custom_data.value, 999.99, 'order total fallback value');

console.log(JSON.stringify({
  ok: true,
  eligibilityPassScenarios: 1,
  eligibilityRejectScenarios: eligibilityFailures.length,
  egyptPhoneEquivalentFormats: phoneVariants.length,
  payloadAssertions: 42,
  deterministicPayload: true,
  noRawEmailOrPhoneInPayload: !built.payloadJson.includes('owner@example.com') && !built.payloadJson.includes('201012345678')
}, null, 2));
