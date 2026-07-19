import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ProductionResumePayload {
  chatId: number;
  batchId: string;
  delayMs?: number;
}

const SIGNATURE_HEADER = 'x-production-resume-signature';
const TIMESTAMP_HEADER = 'x-production-resume-timestamp';
const MAX_SIGNATURE_AGE_MS = 5 * 60_000;

function secret(): string {
  const value = process.env.PRODUCTION_RESUME_SECRET?.trim();
  if (!value) throw new Error('PRODUCTION_RESUME_SECRET is not configured');
  return value;
}

function signature(timestamp: string, body: string): string {
  return createHmac('sha256', secret()).update(`${timestamp}.${body}`).digest('hex');
}

export function signedResumeHeaders(body: string, now = Date.now()): Record<string, string> {
  const timestamp = String(now);
  return {
    'Content-Type': 'application/json',
    [TIMESTAMP_HEADER]: timestamp,
    [SIGNATURE_HEADER]: signature(timestamp, body),
  };
}

export function verifyResumeRequest(
  headers: Record<string, string | string[] | undefined>,
  body: string,
  now = Date.now()
): boolean {
  const rawTimestamp = headers[TIMESTAMP_HEADER];
  const rawSignature = headers[SIGNATURE_HEADER];
  const timestamp = Array.isArray(rawTimestamp) ? rawTimestamp[0] : rawTimestamp;
  const received = Array.isArray(rawSignature) ? rawSignature[0] : rawSignature;
  if (!timestamp || !received || !/^\d+$/.test(timestamp) || !/^[a-f0-9]{64}$/i.test(received)) {
    return false;
  }
  if (Math.abs(now - Number(timestamp)) > MAX_SIGNATURE_AGE_MS) return false;

  let expected: string;
  try {
    expected = signature(timestamp, body);
  } catch {
    return false;
  }
  return timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
}

function continuationBaseUrl(): string {
  const explicit = process.env.PRODUCTION_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');

  // VERCEL_URL points at the exact deployment currently executing, which keeps
  // a continuation on the same version during a rollout.
  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (vercelUrl) return `https://${vercelUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;

  const siteUrl = process.env.URL?.trim();
  if (siteUrl) return siteUrl.replace(/\/$/, '');
  throw new Error('PRODUCTION_BASE_URL/VERCEL_URL/URL is not configured');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Start a fresh Vercel invocation for the same durable batch. */
export async function scheduleProductionContinuation(payload: ProductionResumePayload): Promise<void> {
  const body = JSON.stringify(payload);
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${continuationBaseUrl()}/internal/production/resume`, {
        method: 'POST',
        headers: signedResumeHeaders(body),
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) return;
      lastError = new Error(`Continuation HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 2) await sleep(500 * (2 ** attempt));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
