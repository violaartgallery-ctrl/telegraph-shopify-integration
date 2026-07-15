import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

export const META_DELIVERED_EVENT_NAME = 'Delivered' as const;

type DateInput = Date | string | number | null | undefined;
type Stringish = string | number | null | undefined;

export interface MetaDeliveredEligibilityInput {
  shopifyOrderId: Stringish;
  shopifyCreatedAt: DateInput;
  deliveredAt: DateInput;
  cutoverAt: DateInput;
  statusCode?: Stringish;
  returnStatusCode?: Stringish;
  collectionStatus?: Stringish;
  cancelled?: boolean | null;
  cancelledAt?: DateInput;
  returnedAt?: DateInput;
  customerDue?: number | string | null;
  orderTest?: boolean | null;
  orderTags?: string | readonly string[] | null;
}

export type MetaDeliveredIneligibilityReason =
  | 'missing_shopify_order_id'
  | 'invalid_cutover_at'
  | 'invalid_shopify_created_at'
  | 'invalid_delivered_at'
  | 'test_order'
  | 'cancelled_order'
  | 'returned_order'
  | 'payment_review'
  | 'not_dtr'
  | 'not_collected'
  | 'delivery_before_order'
  | 'shopify_order_before_cutover'
  | 'delivery_before_cutover';

export type MetaDeliveredEligibilityResult =
  | {
      eligible: true;
      shopifyOrderId: string;
      shopifyCreatedAt: Date;
      deliveredAt: Date;
      cutoverAt: Date;
    }
  | {
      eligible: false;
      reason: MetaDeliveredIneligibilityReason;
    };

export interface MetaDeliveredAddress {
  first_name?: Stringish;
  firstName?: Stringish;
  last_name?: Stringish;
  lastName?: Stringish;
  name?: Stringish;
  city?: Stringish;
  province?: Stringish;
  province_code?: Stringish;
  provinceCode?: Stringish;
  zip?: Stringish;
  country?: Stringish;
  country_code?: Stringish;
  countryCode?: Stringish;
  phone?: Stringish;
}

export interface MetaDeliveredLineItem {
  id?: Stringish;
  variant_id?: Stringish;
  variantId?: Stringish;
  product_id?: Stringish;
  productId?: Stringish;
  sku?: Stringish;
  quantity?: number | string | null;
  current_quantity?: number | string | null;
  currentQuantity?: number | string | null;
  price?: number | string | null;
}

export interface MetaDeliveredNoteAttribute {
  name?: Stringish;
  key?: Stringish;
  value?: Stringish;
}

export interface MetaDeliveredShopifyOrderData {
  email?: Stringish;
  phone?: Stringish;
  total_price?: number | string | null;
  totalPrice?: number | string | null;
  current_total_price?: number | string | null;
  currentTotalPrice?: number | string | null;
  currency?: Stringish;
  shipping_address?: MetaDeliveredAddress | null;
  shippingAddress?: MetaDeliveredAddress | null;
  billing_address?: MetaDeliveredAddress | null;
  billingAddress?: MetaDeliveredAddress | null;
  customer?: {
    id?: Stringish;
    first_name?: Stringish;
    firstName?: Stringish;
    last_name?: Stringish;
    lastName?: Stringish;
    email?: Stringish;
    phone?: Stringish;
  } | null;
  line_items?: MetaDeliveredLineItem[] | null;
  lineItems?: MetaDeliveredLineItem[] | null;
  note_attributes?: MetaDeliveredNoteAttribute[] | null;
  noteAttributes?: MetaDeliveredNoteAttribute[] | null;
  browser_ip?: Stringish;
  browserIp?: Stringish;
  landing_site?: Stringish;
  landingSite?: Stringish;
  client_details?: {
    user_agent?: Stringish;
    userAgent?: Stringish;
  } | null;
  clientDetails?: {
    user_agent?: Stringish;
    userAgent?: Stringish;
  } | null;
  fbc?: Stringish;
  fbp?: Stringish;
}

export interface MetaDeliveredBuildInput extends MetaDeliveredEligibilityInput {
  order: MetaDeliveredShopifyOrderData;
  collectedAmount?: number | string | null;
  externalId?: Stringish;
  fbc?: Stringish;
  fbp?: Stringish;
  clientIpAddress?: Stringish;
  clientUserAgent?: Stringish;
  eventSourceUrl?: Stringish;
  defaultCountryCode?: Stringish;
  testEventCode?: Stringish;
}

export interface MetaUserData {
  em?: string[];
  ph?: string[];
  fn?: string[];
  ln?: string[];
  ct?: string[];
  st?: string[];
  zp?: string[];
  country?: string[];
  external_id?: string[];
  fbc?: string;
  fbp?: string;
  client_ip_address?: string;
  client_user_agent?: string;
}

export interface MetaContentItem {
  id: string;
  quantity: number;
  item_price?: number;
}

export interface MetaDeliveredCustomData {
  currency: string;
  value: number;
  order_id: string;
  content_type?: 'product';
  content_ids?: string[];
  contents?: MetaContentItem[];
  num_items?: number;
}

export interface MetaDeliveredEvent {
  event_name: typeof META_DELIVERED_EVENT_NAME;
  event_time: number;
  event_id: string;
  action_source: 'website';
  event_source_url?: string;
  original_event_data: {
    event_name: 'Purchase';
    event_time: number;
    order_id: string;
  };
  user_data: MetaUserData;
  custom_data: MetaDeliveredCustomData;
}

export interface MetaConversionsApiPayload {
  data: [MetaDeliveredEvent];
  test_event_code?: string;
}

export interface MetaMatchQuality {
  /** Internal coverage indicator only. This is not Meta's Event Match Quality score. */
  internalCoverageScore: number;
  grade: 'excellent' | 'strong' | 'fair' | 'weak';
  primaryIdentityPresent: boolean;
  hashedFields: string[];
  plaintextFields: string[];
  emailCount: number;
  phoneCount: number;
  warnings: string[];
}

export type MetaDeliveredBuildFailureReason =
  | MetaDeliveredIneligibilityReason
  | 'no_matchable_user_data'
  | 'invalid_test_event_code';

export type MetaDeliveredBuildResult =
  | {
      ok: false;
      reason: MetaDeliveredBuildFailureReason;
      eligibility: MetaDeliveredEligibilityResult;
    }
  | {
      ok: true;
      eligibility: Extract<MetaDeliveredEligibilityResult, { eligible: true }>;
      eventId: string;
      eventTime: number;
      payload: MetaConversionsApiPayload;
      payloadJson: string;
      payloadHash: string;
      matchQuality: MetaMatchQuality;
      valueSource: 'collected_amount' | 'order_total' | 'zero';
    };

const RETURN_STATUS_CODES = new Set(['RTRN', 'RTS', 'RJCT']);
const CANCEL_STATUS_CODES = new Set(['CANCELLED', 'CANCELED', 'CNCL', 'CNL']);
const RETURN_COLLECTION_STATUSES = new Set(['returned', 'returned-settled']);
const CANCEL_COLLECTION_STATUSES = new Set(['cancelled', 'canceled']);
const PAYMENT_REVIEW_COLLECTION_STATUSES = new Set(['payment-review', 'payment_review']);

const asTrimmedString = (value: Stringish): string | undefined => {
  if (value === null || value === undefined) return undefined;
  const result = String(value).normalize('NFKC').trim();
  return result.length > 0 ? result : undefined;
};

const parseRequiredDate = (value: DateInput): Date | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
};

const normalizeStatusCode = (value: Stringish): string => asTrimmedString(value)?.toUpperCase() ?? '';
const normalizeCollectionStatus = (value: Stringish): string => asTrimmedString(value)?.toLowerCase() ?? '';

const normalizedTags = (value: string | readonly string[] | null | undefined): Set<string> => {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return new Set(raw.map((tag) => tag.normalize('NFKC').trim().toLowerCase()).filter(Boolean));
};

const hasDateValue = (value: DateInput): boolean =>
  value !== null && value !== undefined && value !== '';

export const evaluateMetaDeliveredEligibility = (
  input: MetaDeliveredEligibilityInput
): MetaDeliveredEligibilityResult => {
  const shopifyOrderId = asTrimmedString(input.shopifyOrderId);
  if (!shopifyOrderId) return { eligible: false, reason: 'missing_shopify_order_id' };

  const cutoverAt = parseRequiredDate(input.cutoverAt);
  if (!cutoverAt) return { eligible: false, reason: 'invalid_cutover_at' };

  const shopifyCreatedAt = parseRequiredDate(input.shopifyCreatedAt);
  if (!shopifyCreatedAt) return { eligible: false, reason: 'invalid_shopify_created_at' };

  const deliveredAt = parseRequiredDate(input.deliveredAt);
  if (!deliveredAt) return { eligible: false, reason: 'invalid_delivered_at' };

  const tags = normalizedTags(input.orderTags);
  if (input.orderTest === true || tags.has('test') || tags.has('test-order')) {
    return { eligible: false, reason: 'test_order' };
  }

  const statusCode = normalizeStatusCode(input.statusCode);
  const returnStatusCode = normalizeStatusCode(input.returnStatusCode);
  const collectionStatus = normalizeCollectionStatus(input.collectionStatus);

  if (
    input.cancelled === true ||
    hasDateValue(input.cancelledAt) ||
    CANCEL_STATUS_CODES.has(statusCode) ||
    CANCEL_COLLECTION_STATUSES.has(collectionStatus) ||
    tags.has('cancelled') ||
    tags.has('canceled') ||
    tags.has('accurate-cancelled')
  ) {
    return { eligible: false, reason: 'cancelled_order' };
  }

  if (
    hasDateValue(input.returnedAt) ||
    RETURN_STATUS_CODES.has(statusCode) ||
    RETURN_STATUS_CODES.has(returnStatusCode) ||
    RETURN_COLLECTION_STATUSES.has(collectionStatus) ||
    tags.has('returned') ||
    tags.has('accurate-returned')
  ) {
    return { eligible: false, reason: 'returned_order' };
  }

  const customerDue = Number(input.customerDue);
  if (
    PAYMENT_REVIEW_COLLECTION_STATUSES.has(collectionStatus) ||
    (input.customerDue !== null && input.customerDue !== undefined && Number.isFinite(customerDue) && customerDue < 0) ||
    tags.has('accurate-payment-review')
  ) {
    return { eligible: false, reason: 'payment_review' };
  }

  if (statusCode !== 'DTR') return { eligible: false, reason: 'not_dtr' };
  if (collectionStatus !== 'collected') return { eligible: false, reason: 'not_collected' };

  // Both gates are intentional. They prevent old paid-as-delivered events and
  // pre-cutover in-flight orders from entering the clean Delivered cohort.
  if (shopifyCreatedAt.getTime() < cutoverAt.getTime()) {
    return { eligible: false, reason: 'shopify_order_before_cutover' };
  }
  if (deliveredAt.getTime() < cutoverAt.getTime()) {
    return { eligible: false, reason: 'delivery_before_cutover' };
  }
  if (deliveredAt.getTime() < shopifyCreatedAt.getTime()) {
    return { eligible: false, reason: 'delivery_before_order' };
  }

  return { eligible: true, shopifyOrderId, shopifyCreatedAt, deliveredAt, cutoverAt };
};

export const sha256 = (normalizedValue: string): string =>
  createHash('sha256').update(normalizedValue, 'utf8').digest('hex');

export const normalizeEmail = (value: Stringish): string | undefined => {
  const normalized = asTrimmedString(value)?.toLocaleLowerCase('en-US');
  if (!normalized || normalized.length > 254 || /\s/.test(normalized)) return undefined;
  const at = normalized.lastIndexOf('@');
  if (at <= 0 || at === normalized.length - 1 || !normalized.slice(at + 1).includes('.')) return undefined;
  return normalized;
};

/**
 * Meta expects phone digits including country code. Egyptian local, +20, 0020,
 * and already-normalized 20 formats intentionally collapse to one value.
 */
export const normalizePhoneE164Digits = (
  value: Stringish,
  defaultCountryCode: Stringish = 'EG'
): string | undefined => {
  const raw = asTrimmedString(value);
  if (!raw) return undefined;

  let digits = raw.replace(/\D/g, '');
  if (!digits) return undefined;
  if (digits.startsWith('00')) digits = digits.slice(2);

  const country = normalizeCountryCode(defaultCountryCode);
  if (country === 'eg') {
    // A common human-entered form is +20 (0)10..., which becomes 20010....
    if (digits.startsWith('200')) digits = `20${digits.slice(3)}`;
    if (digits.startsWith('0') && digits.length >= 9 && digits.length <= 11) {
      digits = `20${digits.slice(1)}`;
    } else if (/^1\d{9}$/.test(digits)) {
      digits = `20${digits}`;
    }
  }

  if (!/^[1-9]\d{7,14}$/.test(digits)) return undefined;
  return digits;
};

const normalizePersonOrPlace = (value: Stringish): string | undefined => {
  const normalized = asTrimmedString(value)
    ?.toLocaleLowerCase('en-US')
    .replace(/[\p{P}\p{S}\p{Z}]+/gu, '');
  return normalized || undefined;
};

export const normalizeFirstOrLastName = normalizePersonOrPlace;
export const normalizeCity = normalizePersonOrPlace;
export const normalizeState = normalizePersonOrPlace;

export const normalizePostalCode = (value: Stringish): string | undefined => {
  const normalized = asTrimmedString(value)
    ?.toLocaleLowerCase('en-US')
    .replace(/[\s-]+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
  return normalized || undefined;
};

export const normalizeCountryCode = (value: Stringish): string | undefined => {
  const normalized = asTrimmedString(value)?.toLocaleLowerCase('en-US');
  if (!normalized) return undefined;
  if (normalized === 'egypt' || normalized === 'egy' || normalized === 'مصر') return 'eg';
  return /^[a-z]{2}$/.test(normalized) ? normalized : undefined;
};

export const normalizeExternalId = (value: Stringish): string | undefined => {
  const normalized = asTrimmedString(value)?.toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
  if (!normalized || normalized.length > 256) return undefined;
  // REST webhooks use the numeric customer ID, while Admin GraphQL uses a GID.
  // Canonicalizing them is essential: otherwise the same customer hashes to two
  // unrelated external_id values depending on which ingestion path ran.
  const shopifyCustomerId = /^gid:\/\/shopify\/customer\/(\d+)$/.exec(normalized)?.[1];
  return shopifyCustomerId ?? normalized;
};

export const normalizeFbc = (value: Stringish): string | undefined => {
  const normalized = asTrimmedString(value);
  return normalized && /^fb\.[12]\.\d{10,16}\.[A-Za-z0-9_-]{6,}$/.test(normalized)
    ? normalized
    : undefined;
};

export const normalizeFbp = (value: Stringish): string | undefined => {
  const normalized = asTrimmedString(value);
  return normalized && /^fb\.[12]\.\d{10,16}\.\d{5,}$/.test(normalized)
    ? normalized
    : undefined;
};

const normalizeClientIp = (value: Stringish): string | undefined => {
  const candidate = asTrimmedString(value);
  if (!candidate || isIP(candidate) === 0) return undefined;

  const lower = candidate.toLowerCase();
  if (
    lower === '::' ||
    lower === '::1' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe80:')
  ) return undefined;

  if (isIP(candidate) === 4) {
    const [a, b] = candidate.split('.').map(Number);
    if (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    ) return undefined;
  }
  return candidate;
};

const normalizeClientUserAgent = (value: Stringish): string | undefined => {
  const candidate = asTrimmedString(value);
  if (!candidate || candidate.length < 5 || candidate.length > 2048) return undefined;
  if (['unknown', 'undefined', 'null', 'n/a'].includes(candidate.toLowerCase())) return undefined;
  return candidate;
};

const normalizeEventSourceUrl = (value: Stringish): string | undefined => {
  const candidate = asTrimmedString(value);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    url.username = '';
    url.password = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
};

const resolveEventSourceUrl = (
  baseValue: Stringish,
  ...candidates: Stringish[]
): string | undefined => {
  const baseUrl = normalizeEventSourceUrl(baseValue);
  for (const value of candidates) {
    const candidate = asTrimmedString(value);
    if (!candidate) continue;
    const absolute = normalizeEventSourceUrl(candidate);
    if (absolute) return absolute;
    if (!baseUrl) continue;
    try {
      const resolved = normalizeEventSourceUrl(new URL(candidate, baseUrl).toString());
      if (resolved) return resolved;
    } catch {
      // Try the next candidate, then the configured store URL fallback.
    }
  }
  return baseUrl;
};

const firstString = (...values: Stringish[]): string | undefined => {
  for (const value of values) {
    const candidate = asTrimmedString(value);
    if (candidate) return candidate;
  }
  return undefined;
};

const uniqueNormalized = (
  values: Stringish[],
  normalizer: (value: Stringish) => string | undefined
): string[] => {
  const result = new Set<string>();
  for (const value of values) {
    const normalized = normalizer(value);
    if (normalized) result.add(normalized);
  }
  return [...result];
};

const hashAll = (normalized: string[]): string[] | undefined =>
  normalized.length > 0 ? normalized.map(sha256) : undefined;

const splitFullName = (value: Stringish): { first?: string; last?: string } => {
  const parts = asTrimmedString(value)?.split(/\s+/).filter(Boolean) ?? [];
  if (parts.length === 0) return {};
  if (parts.length === 1) return { first: parts[0] };
  return { first: parts[0], last: parts[parts.length - 1] };
};

const readNoteAttribute = (
  attributes: MetaDeliveredNoteAttribute[] | null | undefined,
  names: string[]
): string | undefined => {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const attribute of attributes ?? []) {
    const key = firstString(attribute.key, attribute.name)?.toLowerCase();
    if (!key || !wanted.has(key)) continue;
    const value = asTrimmedString(attribute.value);
    if (value) return value;
  }
  return undefined;
};

const finiteNumber = (value: number | string | null | undefined): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const roundMoney = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

const normalizeCurrency = (value: Stringish): string => {
  const candidate = asTrimmedString(value)?.toUpperCase();
  return candidate && /^[A-Z]{3}$/.test(candidate) ? candidate : 'EGP';
};

const buildContents = (lineItems: MetaDeliveredLineItem[] | null | undefined): MetaContentItem[] => {
  const contents: MetaContentItem[] = [];
  for (const item of lineItems ?? []) {
    const id = firstString(item.variant_id, item.variantId, item.product_id, item.productId, item.sku, item.id);
    const quantityRaw = finiteNumber(item.current_quantity ?? item.currentQuantity ?? item.quantity);
    const quantity = quantityRaw === undefined ? 0 : Math.floor(quantityRaw);
    if (!id || quantity <= 0) continue;

    const price = finiteNumber(item.price);
    contents.push({
      id,
      quantity,
      ...(price !== undefined && price >= 0 ? { item_price: roundMoney(price) } : {})
    });
  }
  return contents;
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)])
    );
  }
  return value;
};

export const stableJsonStringify = (value: unknown): string => JSON.stringify(canonicalize(value));

const buildMatchQuality = (userData: MetaUserData): MetaMatchQuality => {
  const hashedFields = (['em', 'ph', 'fn', 'ln', 'ct', 'st', 'zp', 'country', 'external_id'] as const)
    .filter((field) => (userData[field]?.length ?? 0) > 0);
  const plaintextFields = (['fbc', 'fbp', 'client_ip_address', 'client_user_agent'] as const)
    .filter((field) => Boolean(userData[field]));

  let score = 0;
  if (userData.em?.length) score += 25;
  if (userData.ph?.length) score += 25;
  if (userData.external_id?.length) score += 15;
  if (userData.fbc) score += 15;
  if (userData.fbp) score += 10;
  if (userData.client_ip_address && userData.client_user_agent) score += 10;
  if (userData.fn?.length && userData.ln?.length) score += 5;
  if (userData.ct?.length || userData.st?.length || userData.zp?.length || userData.country?.length) score += 5;
  score = Math.min(100, score);

  const warnings: string[] = [];
  if (!userData.em?.length) warnings.push('missing_email');
  if (!userData.ph?.length) warnings.push('missing_phone');
  if (!userData.external_id?.length) warnings.push('missing_external_id');
  if (!userData.fbc && !userData.fbp) warnings.push('missing_browser_ids');
  if (Boolean(userData.client_ip_address) !== Boolean(userData.client_user_agent)) {
    warnings.push('incomplete_ip_user_agent_pair');
  }

  return {
    internalCoverageScore: score,
    grade: score >= 75 ? 'excellent' : score >= 55 ? 'strong' : score >= 30 ? 'fair' : 'weak',
    primaryIdentityPresent: Boolean(userData.em?.length || userData.ph?.length || userData.external_id?.length),
    hashedFields,
    plaintextFields,
    emailCount: userData.em?.length ?? 0,
    phoneCount: userData.ph?.length ?? 0,
    warnings
  };
};

const hasMinimumMatchSignal = (userData: MetaUserData): boolean =>
  Boolean(
    userData.em?.length ||
    userData.ph?.length ||
    userData.external_id?.length ||
    userData.fbc ||
    userData.fbp ||
    (userData.client_ip_address && userData.client_user_agent)
  );

const validTestEventCode = (value: Stringish): string | undefined => {
  const candidate = asTrimmedString(value);
  return candidate && /^TEST[A-Za-z0-9_-]{1,64}$/.test(candidate) ? candidate : undefined;
};

export const buildMetaDeliveredPayload = (input: MetaDeliveredBuildInput): MetaDeliveredBuildResult => {
  const eligibility = evaluateMetaDeliveredEligibility(input);
  if (!eligibility.eligible) return { ok: false, reason: eligibility.reason, eligibility };

  const order = input.order;
  const shipping = order.shipping_address ?? order.shippingAddress ?? undefined;
  const billing = order.billing_address ?? order.billingAddress ?? undefined;
  const customer = order.customer ?? undefined;
  const noteAttributes = order.note_attributes ?? order.noteAttributes;

  const emails = uniqueNormalized([order.email, customer?.email], normalizeEmail);
  const phones = uniqueNormalized(
    [shipping?.phone, billing?.phone, order.phone, customer?.phone],
    (value) => normalizePhoneE164Digits(value, input.defaultCountryCode ?? 'EG')
  );

  const shippingName = splitFullName(shipping?.name);
  const billingName = splitFullName(billing?.name);
  const firstName = firstString(
    shipping?.first_name,
    shipping?.firstName,
    billing?.first_name,
    billing?.firstName,
    customer?.first_name,
    customer?.firstName,
    shippingName.first,
    billingName.first
  );
  const lastName = firstString(
    shipping?.last_name,
    shipping?.lastName,
    billing?.last_name,
    billing?.lastName,
    customer?.last_name,
    customer?.lastName,
    shippingName.last,
    billingName.last
  );

  // Address selection is deliberately field-by-field. An empty shipping object
  // must never suppress populated billing/customer fields.
  const city = firstString(shipping?.city, billing?.city);
  const state = firstString(
    shipping?.province_code,
    shipping?.provinceCode,
    shipping?.province,
    billing?.province_code,
    billing?.provinceCode,
    billing?.province
  );
  const postalCode = firstString(shipping?.zip, billing?.zip);
  const country = firstString(
    shipping?.country_code,
    shipping?.countryCode,
    billing?.country_code,
    billing?.countryCode,
    shipping?.country,
    billing?.country,
    input.defaultCountryCode ?? 'EG'
  );

  const normalizedFirstName = normalizeFirstOrLastName(firstName);
  const normalizedLastName = normalizeFirstOrLastName(lastName);
  const normalizedCity = normalizeCity(city);
  const normalizedState = normalizeState(state);
  const normalizedPostalCode = normalizePostalCode(postalCode);
  const normalizedCountry = normalizeCountryCode(country);
  const normalizedExternalId = normalizeExternalId(input.externalId ?? customer?.id);

  const fbc = normalizeFbc(
    input.fbc ?? order.fbc ?? readNoteAttribute(noteAttributes, ['_fbc', 'fbc', 'fb_fbc'])
  );
  const fbp = normalizeFbp(
    input.fbp ?? order.fbp ?? readNoteAttribute(noteAttributes, ['_fbp', 'fbp', 'fb_fbp'])
  );
  const clientIpAddress = normalizeClientIp(
    input.clientIpAddress ?? order.browser_ip ?? order.browserIp
  );
  const clientDetails = order.client_details ?? order.clientDetails;
  const clientUserAgent = normalizeClientUserAgent(
    input.clientUserAgent ?? clientDetails?.user_agent ?? clientDetails?.userAgent
  );

  const userData: MetaUserData = {
    ...(hashAll(emails) ? { em: hashAll(emails) } : {}),
    ...(hashAll(phones) ? { ph: hashAll(phones) } : {}),
    ...(normalizedFirstName ? { fn: [sha256(normalizedFirstName)] } : {}),
    ...(normalizedLastName ? { ln: [sha256(normalizedLastName)] } : {}),
    ...(normalizedCity ? { ct: [sha256(normalizedCity)] } : {}),
    ...(normalizedState ? { st: [sha256(normalizedState)] } : {}),
    ...(normalizedPostalCode ? { zp: [sha256(normalizedPostalCode)] } : {}),
    ...(normalizedCountry ? { country: [sha256(normalizedCountry)] } : {}),
    ...(normalizedExternalId ? { external_id: [sha256(normalizedExternalId)] } : {}),
    ...(fbc ? { fbc } : {}),
    ...(fbp ? { fbp } : {}),
    ...(clientIpAddress ? { client_ip_address: clientIpAddress } : {}),
    ...(clientUserAgent ? { client_user_agent: clientUserAgent } : {})
  };

  if (!hasMinimumMatchSignal(userData)) {
    return { ok: false, reason: 'no_matchable_user_data', eligibility };
  }

  const testEventCodeInput = asTrimmedString(input.testEventCode);
  const testEventCode = validTestEventCode(input.testEventCode);
  if (testEventCodeInput && !testEventCode) {
    return { ok: false, reason: 'invalid_test_event_code', eligibility };
  }

  const collectedAmount = finiteNumber(input.collectedAmount);
  const orderTotal = finiteNumber(
    order.current_total_price ?? order.currentTotalPrice ?? order.total_price ?? order.totalPrice
  );
  const valueSource = collectedAmount !== undefined && collectedAmount > 0
    ? 'collected_amount'
    : orderTotal !== undefined && orderTotal >= 0
      ? 'order_total'
      : 'zero';
  const value = roundMoney(
    valueSource === 'collected_amount' ? collectedAmount! : valueSource === 'order_total' ? orderTotal! : 0
  );

  const lineItems = order.line_items ?? order.lineItems;
  const contents = buildContents(lineItems);
  const eventSourceUrl = resolveEventSourceUrl(
    input.eventSourceUrl,
    readNoteAttribute(noteAttributes, ['_event_source_url', 'event_source_url']),
    order.landing_site,
    order.landingSite
  );
  const eventId = `viola:delivered:${eligibility.shopifyOrderId}`;
  const eventTime = Math.floor(eligibility.deliveredAt.getTime() / 1000);
  const purchaseTime = Math.floor(eligibility.shopifyCreatedAt.getTime() / 1000);

  const customData: MetaDeliveredCustomData = {
    currency: normalizeCurrency(order.currency),
    value,
    order_id: eligibility.shopifyOrderId,
    ...(contents.length > 0
      ? {
          content_type: 'product',
          content_ids: [...new Set(contents.map((item) => item.id))],
          contents,
          num_items: contents.reduce((total, item) => total + item.quantity, 0)
        }
      : {})
  };

  const event: MetaDeliveredEvent = {
    event_name: META_DELIVERED_EVENT_NAME,
    event_time: eventTime,
    event_id: eventId,
    action_source: 'website',
    ...(eventSourceUrl ? { event_source_url: eventSourceUrl } : {}),
    // Meta uses original_event_data to associate delayed post-purchase events
    // with the acquisition event. We intentionally omit event_id because the
    // browser Purchase event ID is not available here and must never be guessed.
    original_event_data: {
      event_name: 'Purchase',
      event_time: purchaseTime,
      order_id: eligibility.shopifyOrderId
    },
    user_data: userData,
    custom_data: customData
  };
  const payload: MetaConversionsApiPayload = {
    data: [event],
    ...(testEventCode ? { test_event_code: testEventCode } : {})
  };
  const payloadJson = stableJsonStringify(payload);

  return {
    ok: true,
    eligibility,
    eventId,
    eventTime,
    payload,
    payloadJson,
    payloadHash: sha256(payloadJson),
    matchQuality: buildMatchQuality(userData),
    valueSource
  };
};
