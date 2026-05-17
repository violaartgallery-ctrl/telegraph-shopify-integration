import { requestShopifyAdmin } from '../shopify/shopifyAdminGraphql.js';
import { OdooClient } from '../odoo/odooClient.js';
import { prisma } from '../lib/prisma.js';

const SHOPIFY_PRODUCT_GID = 'gid://shopify/Product/10478184071460';
const ODOO_TEMPLATE_ID = 2368;
const SKU = 'BOX-FLP-LRG';

const odoo = new OdooClient();

const conflicts = await odoo.searchRead<any>(
  'product.product',
  [['default_code', '=', SKU]],
  ['display_name', 'default_code'],
  { limit: 10 }
);
if (conflicts.length > 0 && !conflicts.some((row) => String(row.display_name ?? '').includes('Large Flip Box'))) {
  console.error('Odoo SKU conflict:', JSON.stringify(conflicts, null, 2));
  await prisma.$disconnect();
  process.exit(1);
}

const shopify = await requestShopifyAdmin<any>(`
  query Product($id: ID!) {
    product(id: $id) {
      title
      variants(first: 10) {
        nodes { id title sku }
      }
    }
  }
`, { id: SHOPIFY_PRODUCT_GID });

if (!shopify.product) throw new Error('Shopify product not found');
const variants = shopify.product.variants.nodes;
if (variants.length !== 1) throw new Error(`Expected 1 Shopify variant, found ${variants.length}`);

const shopifyResult = await requestShopifyAdmin<any>(`
  mutation UpdateVariantSku($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id sku }
      userErrors { field message }
    }
  }
`, {
  productId: SHOPIFY_PRODUCT_GID,
  variants: [{ id: variants[0].id, inventoryItem: { sku: SKU } }]
});
if (shopifyResult.productVariantsBulkUpdate.userErrors.length) {
  throw new Error(`Shopify update failed: ${JSON.stringify(shopifyResult.productVariantsBulkUpdate.userErrors)}`);
}

const odooVariants = await odoo.searchRead<any>(
  'product.product',
  [['product_tmpl_id', '=', ODOO_TEMPLATE_ID]],
  ['display_name', 'default_code'],
  { limit: 10 }
);
if (odooVariants.length !== 1) throw new Error(`Expected 1 Odoo variant, found ${odooVariants.length}`);
const ok = await odoo.executeKw<boolean>('product.product', 'write', [[odooVariants[0].id], { default_code: SKU }]);
if (!ok) throw new Error('Odoo write returned false');

const verifyShopify = await requestShopifyAdmin<any>(`
  query Product($id: ID!) {
    product(id: $id) { variants(first: 10) { nodes { id title sku } } }
  }
`, { id: SHOPIFY_PRODUCT_GID });
const verifyOdoo = await odoo.searchRead<any>(
  'product.product',
  [['product_tmpl_id', '=', ODOO_TEMPLATE_ID]],
  ['display_name', 'default_code'],
  { limit: 10 }
);

console.log('Shopify:', JSON.stringify(verifyShopify.product.variants.nodes, null, 2));
console.log('Odoo:', JSON.stringify(verifyOdoo, null, 2));

const shopifyOk = verifyShopify.product.variants.nodes.every((variant: any) => variant.sku === SKU);
const odooOk = verifyOdoo.every((variant: any) => variant.default_code === SKU);
console.log(`RESULT: Shopify=${shopifyOk ? 'OK' : 'FAILED'} Odoo=${odooOk ? 'OK' : 'FAILED'} SKU=${SKU}`);
if (!shopifyOk || !odooOk) process.exitCode = 1;

await prisma.$disconnect();
