import { env } from '../config/env.js';
import { requestShopifyAdmin } from '../shopify/shopifyAdminGraphql.js';
import type { ShopifyLineItem, ShopifyOrder } from '../types/shopify.js';

export interface ShopifyCollectionReturnCatalog {
  collectionId: string;
  handle: string;
  title: string;
  productIds: ReadonlySet<number>;
  variantIds: ReadonlySet<number>;
  skus: ReadonlySet<string>;
  fetchedAt: Date;
}

export interface CollectionReturnLineDecision {
  lineItemId: number;
  productId: number | null;
  variantId: number | null;
  sku: string | null;
  quantity: number;
  inCollection: boolean | null;
  matchedBy: 'product-id' | 'variant-id' | 'sku' | null;
}

export interface CollectionReturnDecision {
  classification: 'exclusive' | 'mixed' | 'none' | 'empty' | 'indeterminate';
  eligible: boolean;
  collectionId: string;
  collectionHandle: string;
  lines: CollectionReturnLineDecision[];
}

interface CollectionProductNode {
  id: string;
  legacyResourceId: string;
  variants: {
    nodes: Array<{ id: string; legacyResourceId: string; sku?: string | null }>;
    pageInfo: { hasNextPage: boolean; endCursor?: string | null };
  };
}

interface CollectionPageResponse {
  collectionByHandle: {
    id: string;
    title: string;
    handle: string;
    products: {
      nodes: CollectionProductNode[];
      pageInfo: { hasNextPage: boolean; endCursor?: string | null };
    };
  } | null;
}

interface VariantPageResponse {
  product: {
    variants: {
      nodes: Array<{ id: string; legacyResourceId: string; sku?: string | null }>;
      pageInfo: { hasNextPage: boolean; endCursor?: string | null };
    };
  } | null;
}

const COLLECTION_PAGE_QUERY = `
  query OdooReturnCollection($handle: String!, $after: String) {
    collectionByHandle(handle: $handle) {
      id
      title
      handle
      products(first: 100, after: $after) {
        nodes {
          id
          legacyResourceId
          variants(first: 100) {
            nodes { id legacyResourceId sku }
            pageInfo { hasNextPage endCursor }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const VARIANT_PAGE_QUERY = `
  query OdooReturnCollectionProductVariants($id: ID!, $after: String) {
    product(id: $id) {
      variants(first: 100, after: $after) {
        nodes { id legacyResourceId sku }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const normalizeSku = (value?: string | null): string | null => {
  const normalized = value?.trim().toUpperCase();
  return normalized || null;
};

const numericId = (value?: string | number | null): number | null => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== 'string') return null;
  const digits = value.match(/\d+$/)?.[0];
  if (!digits) return null;
  const parsed = Number(digits);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

// Return eligibility is based on what was originally ordered/shipped. Shopify
// can reduce current_quantity to zero after the existing cancellation flow,
// which must not erase the product identity before Odoo processes the return.
const orderedLines = (order: ShopifyOrder): ShopifyLineItem[] =>
  order.line_items.filter((line) => Number(line.quantity) > 0);

export const classifyOrderForCollectionReturn = (
  order: ShopifyOrder,
  catalog: ShopifyCollectionReturnCatalog
): CollectionReturnDecision => {
  const lines = orderedLines(order).map<CollectionReturnLineDecision>((line) => {
    const productId = numericId(line.product_id);
    const variantId = numericId(line.variant_id);
    const sku = normalizeSku(line.sku);

    // Stable Shopify IDs are authoritative. SKU is only a fallback for legacy
    // snapshots where Shopify did not persist product/variant IDs.
    if (productId !== null) {
      return {
        lineItemId: line.id,
        productId,
        variantId,
        sku,
        quantity: line.quantity,
        inCollection: catalog.productIds.has(productId),
        matchedBy: catalog.productIds.has(productId) ? 'product-id' : null
      };
    }
    if (variantId !== null) {
      return {
        lineItemId: line.id,
        productId,
        variantId,
        sku,
        quantity: line.quantity,
        inCollection: catalog.variantIds.has(variantId),
        matchedBy: catalog.variantIds.has(variantId) ? 'variant-id' : null
      };
    }
    if (sku) {
      return {
        lineItemId: line.id,
        productId,
        variantId,
        sku,
        quantity: line.quantity,
        inCollection: catalog.skus.has(sku),
        matchedBy: catalog.skus.has(sku) ? 'sku' : null
      };
    }
    return {
      lineItemId: line.id,
      productId,
      variantId,
      sku,
      quantity: line.quantity,
      inCollection: null,
      matchedBy: null
    };
  });

  let classification: CollectionReturnDecision['classification'];
  if (lines.length === 0) classification = 'empty';
  else if (lines.some((line) => line.inCollection === null)) classification = 'indeterminate';
  else if (lines.every((line) => line.inCollection === true)) classification = 'exclusive';
  else if (lines.some((line) => line.inCollection === true)) classification = 'mixed';
  else classification = 'none';

  return {
    classification,
    eligible: classification === 'exclusive',
    collectionId: catalog.collectionId,
    collectionHandle: catalog.handle,
    lines
  };
};

export class ShopifyCollectionReturnPolicyService {
  private cached?: { catalog: ShopifyCollectionReturnCatalog; expiresAt: number };

  constructor(
    private readonly handle = env.shopify.odooReturnCollectionHandle,
    private readonly cacheTtlMs = 5 * 60_000
  ) {}

  async evaluate(order: ShopifyOrder): Promise<CollectionReturnDecision> {
    return classifyOrderForCollectionReturn(order, await this.getCatalog());
  }

  async getCatalog(options: { forceRefresh?: boolean } = {}): Promise<ShopifyCollectionReturnCatalog> {
    const now = Date.now();
    if (!options.forceRefresh && this.cached && this.cached.expiresAt > now) {
      return this.cached.catalog;
    }

    const productIds = new Set<number>();
    const variantIds = new Set<number>();
    const skus = new Set<string>();
    let after: string | null = null;
    let collectionIdentity: { id: string; title: string; handle: string } | null = null;

    do {
      const response: CollectionPageResponse = await requestShopifyAdmin<CollectionPageResponse>(
        COLLECTION_PAGE_QUERY,
        { handle: this.handle, after }
      );
      if (!response.collectionByHandle) {
        throw new Error(`Shopify return collection not found: ${this.handle}`);
      }
      const collection = response.collectionByHandle;
      collectionIdentity = { id: collection.id, title: collection.title, handle: collection.handle };

      for (const product of collection.products.nodes) {
        const productId = numericId(product.legacyResourceId);
        if (!productId) throw new Error(`Invalid Shopify product ID in ${this.handle}: ${product.legacyResourceId}`);
        productIds.add(productId);
        for (const variant of product.variants.nodes) {
          const variantId = numericId(variant.legacyResourceId);
          if (variantId) variantIds.add(variantId);
          const sku = normalizeSku(variant.sku);
          if (sku) skus.add(sku);
        }

        let variantAfter = product.variants.pageInfo.hasNextPage
          ? product.variants.pageInfo.endCursor ?? null
          : null;
        while (variantAfter) {
          const variantResponse: VariantPageResponse = await requestShopifyAdmin<VariantPageResponse>(
            VARIANT_PAGE_QUERY,
            { id: product.id, after: variantAfter }
          );
          if (!variantResponse.product) throw new Error(`Shopify product disappeared while reading ${product.id}`);
          for (const variant of variantResponse.product.variants.nodes) {
            const variantId = numericId(variant.legacyResourceId);
            if (variantId) variantIds.add(variantId);
            const sku = normalizeSku(variant.sku);
            if (sku) skus.add(sku);
          }
          variantAfter = variantResponse.product.variants.pageInfo.hasNextPage
            ? variantResponse.product.variants.pageInfo.endCursor ?? null
            : null;
        }
      }

      after = collection.products.pageInfo.hasNextPage
        ? collection.products.pageInfo.endCursor ?? null
        : null;
    } while (after);

    if (!collectionIdentity || productIds.size === 0) {
      throw new Error(`Shopify return collection is empty: ${this.handle}`);
    }

    const catalog: ShopifyCollectionReturnCatalog = {
      collectionId: collectionIdentity.id,
      handle: collectionIdentity.handle,
      title: collectionIdentity.title,
      productIds,
      variantIds,
      skus,
      fetchedAt: new Date()
    };
    this.cached = { catalog, expiresAt: now + this.cacheTtlMs };
    return catalog;
  }
}

export const shopifyCollectionReturnPolicyService = new ShopifyCollectionReturnPolicyService();
