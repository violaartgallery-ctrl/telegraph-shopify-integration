import { createHash } from 'node:crypto';
import { normalizeOrderName } from './productionJobStore.js';

export interface PhotoAttachment {
  attachment_name: string;
  attachment_url: string;
  order_name: string;
  comment_id: string;
  position_label?: string | null;
}

export interface ProductionEntry {
  display_product: string;
  display_color?: string;
  total_quantity: number;
  warnings?: string[];
  photo_attachments?: PhotoAttachment[];
  [key: string]: unknown;
}

export interface ProductionOrderDetail {
  order_name: string;
  customer: string;
  created_at: string;
  items: Array<{
    product: string;
    color: string;
    variant: string;
    quantity: number;
    customizations: Array<[string, string]>;
    photo_urls: string[];
  }>;
}

export interface ProductionAgentResponse {
  wordBase64: string;
  ordersDetail: ProductionOrderDetail[];
  productionEntries: ProductionEntry[];
  summary?: {
    totalOrders?: number;
    productionEntries?: number;
    skippedItems?: number;
    warnings?: number;
  };
  warnings: string[];
}

function agentUrl(): string {
  return (process.env.AYMAN_AGENT_URL ?? 'https://viola-production-agent.vercel.app').replace(/\/$/, '');
}

export async function fetchProductionBatch(options: {
  orderId?: string;
  orderNumbers?: string[];
}): Promise<ProductionAgentResponse> {
  const secret = process.env.AYMAN_AGENT_SECRET?.trim() ?? '';
  const response = await fetch(`${agentUrl()}/api/production`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { 'X-Agent-Secret': secret } : {}),
    },
    body: JSON.stringify({
      mode: 'execute',
      skipPhotos: true,
      ...(options.orderNumbers?.length
        ? { orderNumbers: options.orderNumbers }
        : options.orderId
          ? { orderId: options.orderId }
          : {}),
    }),
    signal: AbortSignal.timeout(240_000),
  });

  if (!response.ok) {
    throw new Error(`Ayman Agent HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }

  let raw: Partial<ProductionAgentResponse>;
  try {
    raw = await response.json() as Partial<ProductionAgentResponse>;
  } catch {
    throw new Error('Ayman Agent returned invalid JSON');
  }

  if (!raw.wordBase64 || !Array.isArray(raw.productionEntries) || !Array.isArray(raw.ordersDetail)) {
    throw new Error(`Ayman Agent returned an incomplete payload: ${JSON.stringify(raw.summary ?? {})}`);
  }

  const data: ProductionAgentResponse = {
    wordBase64: raw.wordBase64,
    productionEntries: raw.productionEntries,
    ordersDetail: raw.ordersDetail,
    summary: raw.summary,
    warnings: Array.isArray(raw.warnings) ? raw.warnings.map(String) : [],
  };

  const actualNames = extractOrderNumbers(data);
  const expectedNames = (options.orderNumbers ?? []).map(normalizeOrderName).filter(Boolean);
  if (expectedNames.length) {
    const actual = new Set(actualNames);
    const missing = expectedNames.filter((name) => !actual.has(name));
    if (missing.length) {
      throw new Error(`Ayman Agent did not return ${missing.length} requested orders: ${missing.slice(0, 10).join(', ')}`);
    }
  } else {
    const reportedCount = Number(data.summary?.totalOrders ?? actualNames.length);
    if (reportedCount !== actualNames.length) {
      throw new Error(`Ayman Agent order snapshot mismatch: summary=${reportedCount}, details=${actualNames.length}`);
    }
  }

  return data;
}

export function extractOrderNumbers(data: ProductionAgentResponse): string[] {
  return [...new Set(
    data.ordersDetail
      .map((order) => normalizeOrderName(order.order_name))
      .filter(Boolean)
  )];
}

/** Stable digest used to prevent mixed-version artifacts across invocations. */
export function productionSourceFingerprint(data: ProductionAgentResponse): string {
  const source = JSON.stringify({
    orderNames: extractOrderNumbers(data),
    ordersDetail: data.ordersDetail,
    productionEntries: data.productionEntries,
    warnings: data.warnings,
  });
  return createHash('sha256').update(source).digest('hex');
}
