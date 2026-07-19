import 'dotenv/config';
import { requestShopifyAdmin } from '../shopify/shopifyAdminGraphql.js';

const TITLE = 'Require valid Telegraph governorate and area';
const FUNCTION_HANDLE = 'require-telegraph-location';

interface ValidationNode {
  id: string;
  title: string;
  enabled: boolean;
  blockOnFailure: boolean;
  shopifyFunction?: {
    id?: string;
    title?: string | null;
    apiType?: string | null;
  } | null;
}

interface MutationPayload {
  validation: ValidationNode | null;
  userErrors: Array<{ field?: string[] | null; message: string }>;
}

async function listValidations(): Promise<ValidationNode[]> {
  const data = await requestShopifyAdmin<{ validations: { nodes: ValidationNode[] } }>(`
    query TelegraphValidations {
      validations(first: 50) {
        nodes {
          id
          title
          enabled
          blockOnFailure
          shopifyFunction { id title apiType }
        }
      }
    }
  `);
  return data.validations.nodes;
}

function assertMutation(payload: MutationPayload, operation: string): ValidationNode {
  if (payload.userErrors.length) {
    throw new Error(`${operation}: ${payload.userErrors.map((error) => error.message).join('; ')}`);
  }
  if (!payload.validation) throw new Error(`${operation} returned no validation`);
  return payload.validation;
}

const matches = (await listValidations()).filter((validation) => validation.title === TITLE);
if (matches.length > 1) {
  throw new Error(`Found ${matches.length} duplicate validation rules named "${TITLE}"`);
}

let validation = matches[0];
let action: 'created' | 'updated' | 'unchanged';
if (!validation) {
  const data = await requestShopifyAdmin<{ validationCreate: MutationPayload }>(`
    mutation CreateTelegraphValidation($validation: ValidationCreateInput!) {
      validationCreate(validation: $validation) {
        validation {
          id title enabled blockOnFailure
          shopifyFunction { id title apiType }
        }
        userErrors { field message }
      }
    }
  `, {
    validation: {
      title: TITLE,
      functionHandle: FUNCTION_HANDLE,
      enable: true,
      blockOnFailure: true,
    },
  });
  validation = assertMutation(data.validationCreate, 'validationCreate');
  action = 'created';
} else if (!validation.enabled || !validation.blockOnFailure) {
  const data = await requestShopifyAdmin<{ validationUpdate: MutationPayload }>(`
    mutation UpdateTelegraphValidation($id: ID!, $validation: ValidationUpdateInput!) {
      validationUpdate(id: $id, validation: $validation) {
        validation {
          id title enabled blockOnFailure
          shopifyFunction { id title apiType }
        }
        userErrors { field message }
      }
    }
  `, {
    id: validation.id,
    validation: { title: TITLE, enable: true, blockOnFailure: true },
  });
  validation = assertMutation(data.validationUpdate, 'validationUpdate');
  action = 'updated';
} else {
  action = 'unchanged';
}

if (
  !validation.enabled ||
  !validation.blockOnFailure ||
  validation.shopifyFunction?.apiType !== 'cart_checkout_validation'
) {
  throw new Error(`Validation verification failed: ${JSON.stringify(validation)}`);
}

console.log(JSON.stringify({
  ok: true,
  action,
  id: validation.id,
  enabled: validation.enabled,
  blockOnFailure: validation.blockOnFailure,
  functionTitle: validation.shopifyFunction?.title,
  apiType: validation.shopifyFunction?.apiType,
}));
