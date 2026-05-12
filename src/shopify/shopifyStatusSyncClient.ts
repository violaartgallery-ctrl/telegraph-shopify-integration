import { env } from '../config/env.js';
import { requestShopifyAdmin } from './shopifyAdminGraphql.js';

const METAFIELDS_SET_MUTATION = `
  mutation SetAccurateMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors {
        field
        message
      }
    }
  }
`;

const TAGS_ADD_MUTATION = `
  mutation AddOrderTags($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors {
        field
        message
      }
    }
  }
`;

const TAGS_REMOVE_MUTATION = `
  mutation RemoveOrderTags($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      userErrors {
        field
        message
      }
    }
  }
`;

const toOrderGid = (id: string | number): string => `gid://shopify/Order/${id}`;

const statusTagsToReplace = [
  'accurate-cancelled',
  'accurate-delivered',
  'accurate-collected',
  'accurate-delivered-not-collected',
  'accurate-payment-review',
  'accurate-returned',
  'accurate-returned-settled',
  'accurate-returned-unsettled',
  'accurate-out-for-delivery',
  'accurate-redelivery-pending',
  'accurate-delivery-exception',
  'accurate-return-in-transit',
  'accurate-received',
  'accurate-scheduled',
  'accurate-pkr',
  'accurate-pkm',
  'accurate-pkh',
  'accurate-pkd',
  'accurate-prp',
  'accurate-bmr',
  'accurate-bmt',
  'accurate-std',
  'accurate-dtr',
  'accurate-dex',
  'accurate-htr',
  'accurate-rtrn',
  'accurate-rts',
  'accurate-rjct',
  'accurate-unknown'
];

export interface ShopifyStatusUpdateInput {
  orderId: string | number;
  shipmentStatus: string;
  collectionStatus: string;
  collectedAmount?: number | null;
  returnedValue?: number | null;
  trackingUrl?: string | null;
  tags: string[];
  syncSummary: string;
}

export const shopifyStatusSyncClient = {
  syncShipmentState: async (input: ShopifyStatusUpdateInput): Promise<void> => {
    const ownerId = toOrderGid(input.orderId);
    const metafields = [
      {
        ownerId,
        namespace: env.shopify.statusMetafieldNamespace,
        key: env.shopify.statusMetafieldKey,
        type: 'single_line_text_field',
        value: input.shipmentStatus
      },
      {
        ownerId,
        namespace: env.shopify.statusMetafieldNamespace,
        key: env.shopify.collectionMetafieldKey,
        type: 'single_line_text_field',
        value: input.collectionStatus
      },
      {
        ownerId,
        namespace: env.shopify.statusMetafieldNamespace,
        key: env.shopify.collectedAmountMetafieldKey,
        type: 'number_decimal',
        value: String(input.collectedAmount ?? 0)
      },
      {
        ownerId,
        namespace: env.shopify.statusMetafieldNamespace,
        key: env.shopify.returnedValueMetafieldKey,
        type: 'number_decimal',
        value: String(input.returnedValue ?? 0)
      },
      {
        ownerId,
        namespace: env.shopify.statusMetafieldNamespace,
        key: env.shopify.syncSummaryMetafieldKey,
        type: 'multi_line_text_field',
        value: input.syncSummary
      }
    ];

    if (input.trackingUrl) {
      metafields.push({
        ownerId,
        namespace: env.shopify.statusMetafieldNamespace,
        key: env.shopify.trackingUrlMetafieldKey,
        type: 'single_line_text_field',
        value: input.trackingUrl
      });
    }

    const metafieldsResponse = await requestShopifyAdmin<{
      metafieldsSet: { userErrors: Array<{ message: string }> };
    }>(METAFIELDS_SET_MUTATION, { metafields });

    if (metafieldsResponse.metafieldsSet.userErrors.length > 0) {
      throw new Error(metafieldsResponse.metafieldsSet.userErrors.map((entry) => entry.message).join('; '));
    }

    const removeTagsResponse = await requestShopifyAdmin<{
      tagsRemove: { userErrors: Array<{ message: string }> };
    }>(TAGS_REMOVE_MUTATION, { id: ownerId, tags: statusTagsToReplace });

    if (removeTagsResponse.tagsRemove.userErrors.length > 0) {
      throw new Error(removeTagsResponse.tagsRemove.userErrors.map((entry) => entry.message).join('; '));
    }

    const tagsResponse = await requestShopifyAdmin<{
      tagsAdd: { userErrors: Array<{ message: string }> };
    }>(TAGS_ADD_MUTATION, { id: ownerId, tags: input.tags });

    if (tagsResponse.tagsAdd.userErrors.length > 0) {
      throw new Error(tagsResponse.tagsAdd.userErrors.map((entry) => entry.message).join('; '));
    }
  }
};
