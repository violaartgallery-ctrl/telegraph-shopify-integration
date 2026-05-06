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
