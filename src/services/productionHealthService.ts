import { requestShopifyAdmin } from '../shopify/shopifyAdminGraphql.js';

export interface ProductionHealthResult {
  ok: boolean;
  checkedAt: string;
  theme: {
    ok: boolean;
    selectorPresent: boolean;
    usesNetlify: boolean;
    assetUrl?: string;
    governorates?: number;
    areas?: number;
    error?: string;
  };
  validation: {
    ok: boolean;
    id?: string;
    enabled?: boolean;
    blockOnFailure?: boolean;
    error?: string;
  };
  vercelFallback: {
    ok: boolean;
    governorates?: number;
    areas?: number;
    error?: string;
  };
}

const VALIDATION_TITLE = 'Require valid Telegraph governorate and area';

function countLocations(payload: unknown): { governorates: number; areas: number } {
  const locations = (payload as { locations?: Array<{ subzones?: unknown[] }> })?.locations;
  if (!Array.isArray(locations)) throw new Error('locations array is missing');
  return {
    governorates: locations.length,
    areas: locations.reduce((sum, location) => sum + (Array.isArray(location.subzones) ? location.subzones.length : 0), 0),
  };
}

function healthyLocationCounts(counts: { governorates: number; areas: number }): boolean {
  return counts.governorates >= 29 && counts.areas >= 333;
}

function storefrontUrl(): string {
  return (process.env.SHOPIFY_STOREFRONT_URL?.trim() || 'https://violaleather.com').replace(/\/$/, '');
}

function productionBaseUrl(): string {
  return (process.env.PRODUCTION_BASE_URL?.trim() || 'https://viola-telegraph-integration.vercel.app').replace(/\/$/, '');
}

async function checkTheme(): Promise<ProductionHealthResult['theme']> {
  try {
    const response = await fetch(`${storefrontUrl()}/cart?telegraph_health=${Date.now()}`, {
      headers: {
        // Shopify may return 503 to non-browser user agents on storefront HTML.
        'User-Agent': 'Mozilla/5.0 (compatible; ViolaProductionHealth/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`cart HTTP ${response.status}`);
    const html = await response.text();
    const rendered = html.replace(/\\\//g, '/');
    const selectorPresent =
      rendered.includes('telegraph-location') &&
      rendered.includes('Telegraph Governorate ID') &&
      rendered.includes('Telegraph Area ID');
    const usesNetlify = /netlify/i.test(rendered);
    const match = rendered.match(/(?:https?:)?\/\/[^"'\s]*telegraph-locations\.json[^"'\s<]*/i)
      ?? rendered.match(/\/cdn\/shop\/[^"'\s]*telegraph-locations\.json[^"'\s<]*/i);
    if (!match) throw new Error('rendered cart did not expose telegraph-locations.json');
    const rawAssetUrl = match[0];
    const assetUrl = rawAssetUrl.startsWith('//')
      ? `https:${rawAssetUrl}`
      : rawAssetUrl.startsWith('/')
        ? `${storefrontUrl()}${rawAssetUrl}`
        : rawAssetUrl;
    const assetResponse = await fetch(assetUrl, { signal: AbortSignal.timeout(20_000) });
    if (!assetResponse.ok) throw new Error(`locations asset HTTP ${assetResponse.status}`);
    const counts = countLocations(await assetResponse.json());
    return {
      ok: selectorPresent && !usesNetlify && healthyLocationCounts(counts),
      selectorPresent,
      usesNetlify,
      assetUrl,
      ...counts,
    };
  } catch (error) {
    return {
      ok: false,
      selectorPresent: false,
      usesNetlify: false,
      error: String(error).slice(0, 400),
    };
  }
}

async function checkValidation(): Promise<ProductionHealthResult['validation']> {
  try {
    const data = await requestShopifyAdmin<{
      validations: {
        nodes: Array<{
          id: string;
          title: string;
          enabled: boolean;
          blockOnFailure: boolean;
          shopifyFunction?: { title?: string | null; apiType?: string | null } | null;
        }>;
      };
    }>(`
      query TelegraphValidationHealth {
        validations(first: 50) {
          nodes {
            id
            title
            enabled
            blockOnFailure
            shopifyFunction { title apiType }
          }
        }
      }
    `);
    const rule = data.validations.nodes.find((node) => node.title === VALIDATION_TITLE);
    const ok = Boolean(
      rule?.enabled &&
      rule.blockOnFailure &&
      rule.shopifyFunction?.apiType === 'cart_checkout_validation'
    );
    return {
      ok,
      ...(rule ? {
        id: rule.id,
        enabled: rule.enabled,
        blockOnFailure: rule.blockOnFailure,
      } : { error: 'validation rule is missing' }),
    };
  } catch (error) {
    return { ok: false, error: String(error).slice(0, 400) };
  }
}

async function checkVercelFallback(): Promise<ProductionHealthResult['vercelFallback']> {
  try {
    const response = await fetch(`${productionBaseUrl()}/api/accurate/locations`, {
      headers: { 'User-Agent': 'ViolaProductionHealth/1.0' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`fallback HTTP ${response.status}`);
    const counts = countLocations(await response.json());
    return { ok: healthyLocationCounts(counts), ...counts };
  } catch (error) {
    return { ok: false, error: String(error).slice(0, 400) };
  }
}

export async function checkProductionHealth(): Promise<ProductionHealthResult> {
  const [theme, validation, vercelFallback] = await Promise.all([
    checkTheme(),
    checkValidation(),
    checkVercelFallback(),
  ]);
  return {
    ok: theme.ok && validation.ok && vercelFallback.ok,
    checkedAt: new Date().toISOString(),
    theme,
    validation,
    vercelFallback,
  };
}
