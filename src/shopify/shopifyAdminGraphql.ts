import { env } from '../config/env.js';
import { shopifyAuth } from './shopifyAuth.js';

interface ShopifyGraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

const endpoint = (): string =>
  `https://${env.shopify.shopDomain}/admin/api/${env.shopify.apiVersion}/graphql.json`;

const sendRequest = async <T>(query: string, variables?: Record<string, unknown>): Promise<Response> =>
  await fetch(endpoint(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': await shopifyAuth.getAccessToken()
    },
    body: JSON.stringify({ query, variables })
  });

/**
 * REST endpoint helper for the few operations the GraphQL Admin API doesn't expose
 * on older API versions (e.g. `orderTransactionCreate` only exists from 2024-10+).
 */
export const requestShopifyAdminRest = async <T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
  hasRetried = false
): Promise<T> => {
  const url = `https://${env.shopify.shopDomain}/admin/api/${env.shopify.apiVersion}${path}`;
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': await shopifyAuth.getAccessToken()
    },
    body: init.body ? JSON.stringify(init.body) : undefined
  });

  if ((response.status === 401 || response.status === 403) && !hasRetried) {
    shopifyAuth.clearCachedToken();
    return await requestShopifyAdminRest<T>(path, init, true);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Shopify Admin REST ${init.method ?? 'GET'} ${path} failed with ${response.status}: ${text}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Shopify Admin REST ${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
};

export const requestShopifyAdmin = async <T>(
  query: string,
  variables?: Record<string, unknown>,
  hasRetried = false
): Promise<T> => {
  const response = await sendRequest<T>(query, variables);

  if ((response.status === 401 || response.status === 403) && !hasRetried) {
    shopifyAuth.clearCachedToken();
    return await requestShopifyAdmin<T>(query, variables, true);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Shopify Admin GraphQL request failed with ${response.status}: ${body}`);
  }

  const body = (await response.json()) as ShopifyGraphqlResponse<T>;
  if (body.errors?.length) {
    throw new Error(`Shopify Admin GraphQL errors: ${body.errors.map((entry) => entry.message).join('; ')}`);
  }

  if (!body.data) {
    throw new Error('Shopify Admin GraphQL returned no data');
  }

  return body.data;
};
