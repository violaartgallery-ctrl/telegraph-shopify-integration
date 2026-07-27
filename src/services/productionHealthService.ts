import { requestShopifyAdmin } from '../shopify/shopifyAdminGraphql.js';

export interface ProductionHealthResult {
  ok: boolean;
  checkedAt: string;
  policy: 'open-checkout';
  theme: {
    ok: boolean;
    cartReachable: boolean;
    selectorPresent: boolean;
    usesNetlify: boolean;
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
      /name=["']attributes\[Telegraph (?:Governorate|Area) ID\]["']/i.test(rendered);
    const usesNetlify = /netlify/i.test(rendered);
    return {
      // Current storefront policy intentionally keeps checkout open and does not
      // render the retired Telegraph governorate/area gate.
      ok: !selectorPresent && !usesNetlify,
      cartReachable: true,
      selectorPresent,
      usesNetlify,
    };
  } catch (error) {
    return {
      ok: false,
      cartReachable: false,
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
    // The location validation is deliberately disabled while checkout remains
    // open. A missing or disabled rule is healthy; an enabled rule can block
    // customers and must fail this monitor.
    const ok = !rule?.enabled;
    return {
      ok,
      ...(rule ? {
        id: rule.id,
        enabled: rule.enabled,
        blockOnFailure: rule.blockOnFailure,
      } : {}),
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
    // The Vercel locations endpoint is kept as a diagnostic only. It is not in
    // the customer journey and must never make the open checkout look unhealthy.
    ok: theme.ok && validation.ok,
    checkedAt: new Date().toISOString(),
    policy: 'open-checkout',
    theme,
    validation,
    vercelFallback,
  };
}
