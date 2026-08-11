import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const PRODUCTION_CONTINUATION_TOPIC = 'viola-production-continuations';

export interface ProductionQueuePublishOptions {
  delaySeconds: number;
  retentionSeconds: number;
  idempotencyKey: string;
}

type ProductionQueuePublisher = (
  topic: string,
  payload: ProductionResumePayload,
  options: ProductionQueuePublishOptions
) => Promise<{ messageId: string | null }>;

let testQueuePublisher: ProductionQueuePublisher | undefined;

export interface ProductionResumePayload {
  chatId: number;
  batchId: string;
  delayMs?: number;
  /** Stable Neon cursor timestamp used to deduplicate repeated dispatches. */
  dispatchKey?: string;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseProductionResumePayload(value: unknown): ProductionResumePayload | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const chatId = Number(candidate.chatId);
  const batchId = typeof candidate.batchId === 'string' ? candidate.batchId.trim() : '';
  if (!Number.isSafeInteger(chatId) || !batchId || batchId.length > 160) return null;
  return { chatId, batchId };
}

export function setProductionQueuePublisherForTests(
  publisher: ProductionQueuePublisher | undefined
): void {
  testQueuePublisher = publisher;
}

async function publishToProductionQueue(
  topic: string,
  payload: ProductionResumePayload,
  options: ProductionQueuePublishOptions
): Promise<{ messageId: string | null }> {
  if (testQueuePublisher) return await testQueuePublisher(topic, payload, options);
  const { send } = await import('@vercel/queue');
  return await send(topic, payload, options);
}

/**
 * Publish the next durable segment without calling this Vercel deployment over
 * HTTP. Queue delivery starts a fresh root invocation, so Vercel recursion
 * protection cannot accumulate across a large batch.
 */
export async function scheduleProductionContinuation(payload: ProductionResumePayload): Promise<void> {
  const parsed = parseProductionResumePayload(payload);
  if (!parsed) throw new Error('Invalid production continuation payload');

  const delayMs = Math.min(30_000, Math.max(0, Number(payload.delayMs) || 0));
  const dispatchKey = String(payload.dispatchKey ?? randomUUID());
  const idempotencyDigest = createHash('sha256')
    .update(`${parsed.batchId}\0${dispatchKey}`)
    .digest('hex');
  const options: ProductionQueuePublishOptions = {
    delaySeconds: Math.ceil(delayMs / 1000),
    retentionSeconds: 24 * 60 * 60,
    idempotencyKey: `production_${idempotencyDigest}`,
  };

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await publishToProductionQueue(PRODUCTION_CONTINUATION_TOPIC, parsed, options);
      return;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 2) await sleep(500 * (2 ** attempt));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
