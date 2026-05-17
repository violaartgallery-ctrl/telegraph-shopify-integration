/**
 * One-time setup script: assigns matching SKU to Shopify + Odoo test product.
 *
 * Shopify product : 10477075366180  (gid://shopify/Product/10477075366180)
 * Odoo template   : 2800
 * SKU to assign   : VIOLA-TEST
 *
 * Writes:
 *   - Shopify variant SKU via productVariantUpdate mutation
 *   - Odoo product.product default_code via write()
 */

import { requestShopifyAdmin } from '../shopify/shopifyAdminGraphql.js';
import { OdooClient } from '../odoo/odooClient.js';
import { prisma } from '../lib/prisma.js';

const SHOPIFY_PRODUCT_GID = 'gid://shopify/Product/10477075366180';
const ODOO_TEMPLATE_ID = 2800;
const SKU = 'VIOLA-TEST';

// ─────────────────────────────────────────────
// 1. Read Shopify product → find first variant
// ─────────────────────────────────────────────
console.log('\n══ Shopify ══════════════════════════════════');

const shopifyData = await requestShopifyAdmin<{
  product: {
    title: string;
    variants: { edges: Array<{ node: { id: string; title: string; sku: string | null } }> };
  };
}>(`
  query GetProduct($id: ID!) {
    product(id: $id) {
      title
      variants(first: 5) {
        edges {
          node { id title sku }
        }
      }
    }
  }
`, { id: SHOPIFY_PRODUCT_GID });

const product = shopifyData.product;
console.log('  product title :', product.title);

const variants = product.variants.edges.map(e => e.node);
for (const v of variants) {
  console.log(`  variant: ${v.title} | id=${v.id} | sku=${v.sku ?? 'null'}`);
}

// Update all variants (usually just one for a test product)
for (const variant of variants) {
  if (variant.sku === SKU) {
    console.log(`  ✅ variant ${variant.id} already has SKU = ${SKU}, skipping`);
    continue;
  }

  const updateResult = await requestShopifyAdmin<{
    productVariantsBulkUpdate: {
      productVariants: Array<{ id: string; sku: string }> | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(`
    mutation UpdateVariantSku($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id sku }
        userErrors { field message }
      }
    }
  `, { productId: SHOPIFY_PRODUCT_GID, variants: [{ id: variant.id, inventoryItem: { sku: SKU } }] });

  const result = updateResult.productVariantsBulkUpdate;
  if (result.userErrors.length > 0) {
    console.error('  ❌ Shopify error:', result.userErrors);
  } else {
    const updated = result.productVariants?.[0];
    console.log(`  ✅ variant ${updated?.id} SKU set to: ${updated?.sku}`);
  }
}

// ─────────────────────────────────────────────
// 2. Read Odoo template 2800 → find product.product variants
// ─────────────────────────────────────────────
console.log('\n══ Odoo ══════════════════════════════════════');

const odooClient = new OdooClient();

const templateRecords = await odooClient.searchRead<{ id: number; name: string; default_code: string | false }>(
  'product.template',
  [['id', '=', ODOO_TEMPLATE_ID]],
  ['name', 'default_code'],
  { limit: 1 }
);

if (templateRecords.length === 0) {
  console.error(`  ❌ Odoo template ${ODOO_TEMPLATE_ID} not found`);
  await prisma.$disconnect();
  process.exit(1);
}
console.log(`  template: ${templateRecords[0].name} | default_code: ${templateRecords[0].default_code || 'null'}`);

const productVariants = await odooClient.searchRead<{ id: number; display_name: string; default_code: string | false }>(
  'product.product',
  [['product_tmpl_id', '=', ODOO_TEMPLATE_ID]],
  ['display_name', 'default_code'],
  { limit: 10 }
);

console.log(`  product.product variants (${productVariants.length}):`);
for (const pv of productVariants) {
  console.log(`    id=${pv.id} | name=${pv.display_name} | default_code=${pv.default_code || 'null'}`);
}

// Write SKU to all product.product variants
const idsToUpdate = productVariants
  .filter(pv => pv.default_code !== SKU)
  .map(pv => pv.id);

if (idsToUpdate.length === 0) {
  console.log(`  ✅ All Odoo variants already have default_code = ${SKU}, skipping`);
} else {
  const writeResult = await odooClient.executeKw<boolean>(
    'product.product',
    'write',
    [idsToUpdate, { default_code: SKU }]
  );
  if (writeResult) {
    console.log(`  ✅ Odoo variant ids ${idsToUpdate.join(', ')} default_code set to: ${SKU}`);
  } else {
    console.error('  ❌ Odoo write returned false');
  }
}

// ─────────────────────────────────────────────
// 3. Verify: re-read both
// ─────────────────────────────────────────────
console.log('\n══ Verification ══════════════════════════════');

const verifyShopify = await requestShopifyAdmin<{
  product: { variants: { edges: Array<{ node: { id: string; sku: string | null } }> } };
}>(`query GetProduct($id: ID!) { product(id: $id) { variants(first:5) { edges { node { id sku } } } } }`,
  { id: SHOPIFY_PRODUCT_GID });

for (const e of verifyShopify.product.variants.edges) {
  console.log(`  Shopify variant ${e.node.id} SKU: ${e.node.sku}`);
}

const verifyOdoo = await odooClient.searchRead<{ id: number; display_name: string; default_code: string | false }>(
  'product.product',
  [['product_tmpl_id', '=', ODOO_TEMPLATE_ID]],
  ['display_name', 'default_code'],
  { limit: 10 }
);
for (const pv of verifyOdoo) {
  console.log(`  Odoo product.product id=${pv.id} default_code: ${pv.default_code}`);
}

const shopifyOk = verifyShopify.product.variants.edges.every(e => e.node.sku === SKU);
const odooOk = verifyOdoo.every(pv => pv.default_code === SKU);
console.log(`\n  Shopify ✅: ${shopifyOk} | Odoo ✅: ${odooOk}`);

if (shopifyOk && odooOk) {
  console.log(`\n🎉 Both set to SKU = ${SKU}. Re-run preview script to confirm eligibility.\n`);
} else {
  console.error(`\n❌ Something didn't match. Check above.\n`);
}

await prisma.$disconnect();
