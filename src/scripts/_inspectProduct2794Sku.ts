import { requestShopifyAdmin } from '../shopify/shopifyAdminGraphql.js';
import { OdooClient } from '../odoo/odooClient.js';
import { prisma } from '../lib/prisma.js';

const SHOPIFY_PRODUCT_GID = 'gid://shopify/Product/10423525081380';
const ODOO_TEMPLATE_ID = 2794;

const shopify = await requestShopifyAdmin<{
  product: {
    id: string;
    title: string;
    options: Array<{ name: string; values: string[] }>;
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
      id
      title
      options { name values }
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

console.log('\nSHOPIFY');
console.log(JSON.stringify(shopify.product, null, 2));

const odoo = new OdooClient();
const templates = await odoo.searchRead<any>(
  'product.template',
  [['id', '=', ODOO_TEMPLATE_ID]],
  ['name', 'default_code', 'attribute_line_ids', 'product_variant_ids'],
  { limit: 1 }
);
console.log('\nODOO TEMPLATE');
console.log(JSON.stringify(templates[0] ?? null, null, 2));

const variants = await odoo.searchRead<any>(
  'product.product',
  [['product_tmpl_id', '=', ODOO_TEMPLATE_ID]],
  ['display_name', 'default_code', 'product_template_attribute_value_ids'],
  { limit: 100, order: 'id asc' }
);
console.log('\nODOO VARIANTS');
console.log(JSON.stringify(variants, null, 2));

await prisma.$disconnect();
