/**
 * One-time SKU sync:
 * Odoo product.template 2794 Photo Keychain
 * Shopify product 10423525081380 Photo keychain
 */
import { requestShopifyAdmin } from '../shopify/shopifyAdminGraphql.js';
import { OdooClient } from '../odoo/odooClient.js';
import { prisma } from '../lib/prisma.js';

const SHOPIFY_PRODUCT_GID = 'gid://shopify/Product/10423525081380';
const ODOO_TEMPLATE_ID = 2794;

const shopifySkuByColor: Record<string, string> = {
  Havan: 'KEY-PHO-DCM',
  Maroon: 'KEY-PHO-MRN',
  'Dark Navy': 'KEY-PHO-DNV',
  Green: 'KEY-PHO-GRN',
  Black: 'KEY-PHO-BLK',
  Brown: 'KEY-PHO-BRN'
};

const odooSkuByColorToken: Array<{ token: string; sku: string }> = [
  { token: '(Dark camel)', sku: 'KEY-PHO-DCM' },
  { token: '(Maroon Pull-up)', sku: 'KEY-PHO-MRN' },
  { token: '(Navy Pull-up)', sku: 'KEY-PHO-DNV' },
  { token: '(Green Pull-up)', sku: 'KEY-PHO-GRN' },
  { token: '(Black)', sku: 'KEY-PHO-BLK' },
  { token: '(Dark brown)', sku: 'KEY-PHO-BRN' }
];

const allSkus = [...new Set(Object.values(shopifySkuByColor))];
const odoo = new OdooClient();

const existing = await odoo.searchRead<any>(
  'product.product',
  [['default_code', 'in', allSkus]],
  ['display_name', 'default_code'],
  { limit: 100 }
);
const conflicts = existing.filter((row) => !String(row.display_name ?? '').startsWith('[KEY-PHO-'));
if (conflicts.length > 0) {
  console.error('SKU conflicts found in Odoo:');
  console.error(JSON.stringify(conflicts, null, 2));
  await prisma.$disconnect();
  process.exit(1);
}

console.log('Updating Shopify variants...');
const shopify = await requestShopifyAdmin<{
  product: {
    title: string;
    variants: {
      nodes: Array<{
        id: string;
        title: string;
        sku: string | null;
        selectedOptions: Array<{ name: string; value: string }>;
      }>;
    };
  } | null;
}>(`
  query Product($id: ID!) {
    product(id: $id) {
      title
      variants(first: 100) {
        nodes {
          id
          title
          sku
          selectedOptions { name value }
        }
      }
    }
  }
`, { id: SHOPIFY_PRODUCT_GID });

if (!shopify.product) {
  throw new Error('Shopify product not found');
}

const shopifyUpdates = shopify.product.variants.nodes.map((variant) => {
  const color = variant.selectedOptions.find((option) => option.name === 'Color')?.value ?? variant.title;
  const sku = shopifySkuByColor[color];
  if (!sku) throw new Error(`No Shopify SKU mapping for color "${color}"`);
  return { id: variant.id, inventoryItem: { sku } };
});

const shopifyResult = await requestShopifyAdmin<{
  productVariantsBulkUpdate: {
    productVariants: Array<{ id: string; sku: string | null }> | null;
    userErrors: Array<{ field?: string[] | null; message: string }>;
  };
}>(`
  mutation UpdateVariantSkus($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id sku }
      userErrors { field message }
    }
  }
`, { productId: SHOPIFY_PRODUCT_GID, variants: shopifyUpdates });

if (shopifyResult.productVariantsBulkUpdate.userErrors.length > 0) {
  throw new Error(`Shopify SKU update failed: ${JSON.stringify(shopifyResult.productVariantsBulkUpdate.userErrors)}`);
}
console.log(JSON.stringify(shopifyResult.productVariantsBulkUpdate.productVariants, null, 2));

console.log('\nUpdating Odoo variants...');
const odooVariants = await odoo.searchRead<any>(
  'product.product',
  [['product_tmpl_id', '=', ODOO_TEMPLATE_ID]],
  ['display_name', 'default_code'],
  { limit: 100, order: 'id asc' }
);

for (const variant of odooVariants) {
  const mapping = odooSkuByColorToken.find((entry) => String(variant.display_name).includes(entry.token));
  if (!mapping) {
    throw new Error(`No Odoo SKU mapping for variant ${variant.id}: ${variant.display_name}`);
  }
  if (variant.default_code !== mapping.sku) {
    const ok = await odoo.executeKw<boolean>('product.product', 'write', [[variant.id], { default_code: mapping.sku }]);
    if (!ok) throw new Error(`Odoo write failed for ${variant.display_name}`);
  }
  console.log(`  ${variant.id} ${variant.display_name} -> ${mapping.sku}`);
}

console.log('\nVerification...');
const verifyShopify = await requestShopifyAdmin<{
  product: {
    variants: {
      nodes: Array<{ id: string; title: string; sku: string | null; selectedOptions: Array<{ name: string; value: string }> }>;
    };
  } | null;
}>(`
  query Product($id: ID!) {
    product(id: $id) {
      variants(first: 100) {
        nodes { id title sku selectedOptions { name value } }
      }
    }
  }
`, { id: SHOPIFY_PRODUCT_GID });

for (const variant of verifyShopify.product?.variants.nodes ?? []) {
  const color = variant.selectedOptions.find((option) => option.name === 'Color')?.value ?? variant.title;
  console.log(`  Shopify ${color}: ${variant.sku}`);
}

const verifyOdoo = await odoo.searchRead<any>(
  'product.product',
  [['product_tmpl_id', '=', ODOO_TEMPLATE_ID]],
  ['display_name', 'default_code'],
  { limit: 100, order: 'id asc' }
);
for (const variant of verifyOdoo) {
  console.log(`  Odoo ${variant.display_name}: ${variant.default_code}`);
}

const shopifyOk = (verifyShopify.product?.variants.nodes ?? []).every((variant) => {
  const color = variant.selectedOptions.find((option) => option.name === 'Color')?.value ?? variant.title;
  return variant.sku === shopifySkuByColor[color];
});
const odooOk = verifyOdoo.every((variant) => {
  const mapping = odooSkuByColorToken.find((entry) => String(variant.display_name).includes(entry.token));
  return mapping && variant.default_code === mapping.sku;
});

console.log(`\nRESULT: Shopify=${shopifyOk ? 'OK' : 'FAILED'} Odoo=${odooOk ? 'OK' : 'FAILED'}`);
if (!shopifyOk || !odooOk) process.exitCode = 1;

await prisma.$disconnect();
