import { env } from '../config/env.js';
import { shopifyAuth } from './shopifyAuth.js';
import {beforeAutomaticShopifyWrite,haltAutomaticOperation,automaticOperationContext,AutomaticOperationReviewError} from '../services/automaticOperationSafety.js';

interface ShopifyGraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

const endpoint = (): string =>
  `https://${env.shopify.shopDomain}/admin/api/${env.shopify.apiVersion}/graphql.json`;

const writeUncertain=(error:unknown):never=>{if(automaticOperationContext()){haltAutomaticOperation('SHOPIFY_WRITE_OUTCOME_UNKNOWN');throw new AutomaticOperationReviewError('Shopify write outcome unknown; independent review required');}throw error;};
const sendRequest = async <T>(query: string, variables?: Record<string, unknown>): Promise<Response> => {
  const token=await shopifyAuth.getAccessToken(),mutation=/\bmutation\b/.test(query);
  if(mutation)await beforeAutomaticShopifyWrite();
  try{return await fetch(endpoint(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token
    },
    body: JSON.stringify({ query, variables })
  });}catch(error){if(mutation)writeUncertain(error);throw error;}
};

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
  const token=await shopifyAuth.getAccessToken(),mutation=!['GET','HEAD'].includes((init.method??'GET').toUpperCase());
  if(mutation)await beforeAutomaticShopifyWrite();
  let response:Response;try{response = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token
    },
    body: init.body ? JSON.stringify(init.body) : undefined
  });}catch(error){if(mutation)writeUncertain(error);throw error;}

  if ((response.status === 401 || response.status === 403) && !hasRetried && !mutation) {
    shopifyAuth.clearCachedToken();
    return await requestShopifyAdminRest<T>(path, init, true);
  }

  let text:string;try{text=await response.text();}catch(error){if(mutation)writeUncertain(error);throw error;}
  if (!response.ok) {
    if(mutation)writeUncertain(new Error('Shopify REST write not confirmed'));
    throw new Error(`Shopify Admin REST ${init.method ?? 'GET'} ${path} failed with ${response.status}: ${text}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    if(mutation)writeUncertain(new Error('Shopify REST write response not verified'));
    throw new Error(`Shopify Admin REST ${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
};

export const requestShopifyAdmin = async <T>(
  query: string,
  variables?: Record<string, unknown>,
  hasRetried = false
): Promise<T> => {
  const response = await sendRequest<T>(query, variables);
  const mutation=/\bmutation\b/.test(query);

  if ((response.status === 401 || response.status === 403) && !hasRetried && !mutation) {
    shopifyAuth.clearCachedToken();
    return await requestShopifyAdmin<T>(query, variables, true);
  }

  if (!response.ok) {
    if(mutation)writeUncertain(new Error('Shopify GraphQL write not confirmed'));
    const body = await response.text();
    throw new Error(`Shopify Admin GraphQL request failed with ${response.status}: ${body}`);
  }

  let body:ShopifyGraphqlResponse<T>;try{body=(await response.json()) as ShopifyGraphqlResponse<T>;}catch(error){if(mutation)writeUncertain(error);throw error;}
  if(!body||typeof body!=='object'||Array.isArray(body)){if(mutation)writeUncertain(new Error('Shopify mutation response shape is invalid'));throw new Error('Shopify GraphQL invalid response shape');}
  if (body.errors?.length) {
    if(mutation)writeUncertain(new Error('Shopify mutation returned execution errors'));
    throw new Error(`Shopify Admin GraphQL errors: ${body.errors.map((entry) => entry.message).join('; ')}`);
  }

  if (!body.data) {
    if(mutation)writeUncertain(new Error('Shopify mutation returned no verified data'));
    throw new Error('Shopify Admin GraphQL returned no data');
  }

  return body.data;
};
