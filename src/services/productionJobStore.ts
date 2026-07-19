/**
 * Durable state for the Telegram production pipeline.
 *
 * Vercel gives every invocation a finite execution window. A production batch
 * therefore runs as a chain of invocations. Each invocation claims a lease,
 * checkpoints every externally-visible success, releases the lease, and asks
 * the next invocation to continue. The employee never has to press Continue.
 *
 * We intentionally keep this in FailedPayload, the existing Neon-backed JSON
 * store, so the rollout does not depend on a schema migration. PostgreSQL
 * advisory locks make create/claim/update operations atomic per Telegram chat.
 */
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { ShipResult } from './productionJobTypes.js';

type JobTransaction = Pick<Prisma.TransactionClient, '$queryRawUnsafe' | 'failedPayload'>;

export type ProductionJobStatus =
  | 'queued'
  | 'running'
  | 'retrying'
  | 'preview_ready'
  | 'needs_review';

interface JobCommon {
  version: 2;
  batchId: string;
  status: ProductionJobStatus;
  orderId?: string;
  /** Exact Shopify display names captured by the first preview fetch. */
  orderNumbers: string[];
  /** /run was requested and must start as soon as preview is complete. */
  pendingRun: boolean;
  /** Telegram destinations that must receive every preview artifact. */
  recipientChatIds: string[];
  attemptCount: number;
  lastError?: string;
  executionToken?: string;
  updatedAt: number;
}

export interface RunCursor extends JobCommon {
  kind: 'run';
  phase: 'shipping' | 'finalize';
  processedOrderNames: string[];
  createdShipmentIds: number[];
  results: ShipResult[];
  needsReviewOrderNames: string[];
  /** waybill/report/recovery messages confirmed by Telegram. */
  sentFinalArtifactKeys: string[];
}

export interface PreviewCursor extends JobCommon {
  kind: 'preview';
  /** `${recipientChatId}|${artifactKey}` entries confirmed by Telegram. */
  sentArtifactKeys: string[];
  /** `${recipientChatId}|${photoUrl}` entries confirmed by Telegram. */
  sentPhotoKeys: string[];
  /** Detects edits between continuation segments so a batch cannot mix versions. */
  sourceFingerprint?: string;
}

export type JobCursor = RunCursor | PreviewCursor;

export type QueueRunAction =
  | 'created_preview'
  | 'queued_after_preview'
  | 'started_run'
  | 'already_running'
  | 'needs_review'
  | 'order_mismatch';

const SOURCE = 'prod_job';
const HISTORY_SOURCE = 'prod_job_history';

// A running lease older than this is recoverable after an invocation crash.
export const JOB_STALE_MS = 330_000;

export class ProductionJobLeaseLostError extends Error {
  constructor() {
    super('Production job lease was lost or the batch was cancelled');
    this.name = 'ProductionJobLeaseLostError';
  }
}

async function db() {
  // Use the base client here so Prisma exposes its canonical TransactionClient
  // type. The job operations themselves are transactional and can be retried by
  // the automatic invocation chain if Neon is waking from sleep.
  const { basePrisma } = await import('../lib/prisma.js');
  return basePrisma;
}

function chatKey(chatId: number): string {
  return String(chatId);
}

function makeBatchId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

function normalizeOrderId(orderId?: string): string | undefined {
  const value = orderId?.replace(/^#/, '').trim();
  return value || undefined;
}

export function normalizeOrderName(value: string): string {
  const number = value.replace(/^#/, '').trim();
  return number ? `#${number}` : '';
}

function uniqueStrings(values: Array<string | number>): string[] {
  return [...new Set(values.map(String).map((value) => value.trim()).filter(Boolean))];
}

export function createPreviewCursor(options: {
  orderId?: string;
  pendingRun?: boolean;
  recipientChatIds: Array<string | number>;
}): PreviewCursor {
  const orderId = normalizeOrderId(options.orderId);
  return {
    version: 2,
    batchId: makeBatchId(),
    kind: 'preview',
    status: 'queued',
    ...(orderId ? { orderId } : {}),
    orderNumbers: [],
    pendingRun: Boolean(options.pendingRun),
    recipientChatIds: uniqueStrings(options.recipientChatIds),
    attemptCount: 0,
    sentArtifactKeys: [],
    sentPhotoKeys: [],
    updatedAt: Date.now(),
  };
}

export function runCursorFromPreview(preview: PreviewCursor): RunCursor {
  return {
    version: 2,
    batchId: preview.batchId,
    kind: 'run',
    status: 'queued',
    ...(preview.orderId ? { orderId: preview.orderId } : {}),
    orderNumbers: [...preview.orderNumbers],
    pendingRun: false,
    recipientChatIds: [...preview.recipientChatIds],
    attemptCount: 0,
    phase: 'shipping',
    processedOrderNames: [],
    createdShipmentIds: [],
    results: [],
    needsReviewOrderNames: [],
    sentFinalArtifactKeys: [],
    updatedAt: Date.now(),
  };
}

function parseCursor(payloadJson: string): JobCursor | null {
  try {
    const parsed = JSON.parse(payloadJson) as Partial<JobCursor> & Record<string, unknown>;
    if (parsed.version !== 2 || !parsed.batchId || !parsed.kind) return null;
    return parsed as JobCursor;
  } catch {
    return null;
  }
}

async function lockChat(transaction: JobTransaction, chatId: number): Promise<void> {
  // The SQL text is constant; the chat id remains a bound parameter.
  await transaction.$queryRawUnsafe(
    'SELECT 1 AS locked FROM pg_advisory_xact_lock($1::bigint)',
    chatKey(chatId)
  );
}

async function readLocked(
  transaction: JobTransaction,
  chatId: number
): Promise<{ id: number; cursor: JobCursor } | null> {
  const row = await transaction.failedPayload.findFirst({
    where: { source: SOURCE, reason: chatKey(chatId) },
    orderBy: { id: 'desc' },
  });
  if (!row) return null;
  const cursor = parseCursor(row.payloadJson);
  if (!cursor) {
    // A pre-v2 cursor cannot safely prove which Telegram sends succeeded. Remove
    // it instead of silently skipping artifacts based on ambiguous old state.
    await transaction.failedPayload.deleteMany({
      where: { source: SOURCE, reason: chatKey(chatId) },
    });
    return null;
  }
  return { id: row.id, cursor };
}

async function writeLocked(
  transaction: JobTransaction,
  chatId: number,
  cursor: JobCursor
): Promise<void> {
  cursor.updatedAt = Date.now();
  await transaction.failedPayload.deleteMany({
    where: { source: SOURCE, reason: chatKey(chatId) },
  });
  await transaction.failedPayload.create({
    data: {
      source: SOURCE,
      reason: chatKey(chatId),
      externalId: cursor.batchId,
      payloadJson: JSON.stringify(cursor),
    },
  });
}

export async function loadJob(chatId: number): Promise<JobCursor | null> {
  const prisma = await db();
  const row = await prisma.failedPayload.findFirst({
    where: { source: SOURCE, reason: chatKey(chatId) },
    orderBy: { id: 'desc' },
  });
  return row ? parseCursor(row.payloadJson) : null;
}

export async function listRecoverableJobs(): Promise<Array<{ chatId: number; job: JobCursor }>> {
  const prisma = await db();
  const rows = await prisma.failedPayload.findMany({
    where: { source: SOURCE },
    orderBy: { id: 'desc' },
  });
  const seenChats = new Set<string>();
  const recoverable: Array<{ chatId: number; job: JobCursor }> = [];
  for (const row of rows) {
    if (seenChats.has(row.reason)) continue;
    seenChats.add(row.reason);
    const job = parseCursor(row.payloadJson);
    const chatId = Number(row.reason);
    if (!job || !Number.isSafeInteger(chatId)) continue;
    const staleRunning = job.status === 'running' && Date.now() - job.updatedAt >= JOB_STALE_MS;
    if (job.status === 'queued' || job.status === 'retrying' || staleRunning) {
      recoverable.push({ chatId, job });
    }
  }
  return recoverable;
}

export async function createPreviewJob(
  chatId: number,
  options: { orderId?: string; pendingRun?: boolean; recipientChatIds: Array<string | number> }
): Promise<{ created: boolean; job: JobCursor }> {
  const prisma = await db();
  return await prisma.$transaction(async (transaction) => {
    await lockChat(transaction, chatId);
    const existing = await readLocked(transaction, chatId);
    if (existing) return { created: false, job: existing.cursor };

    const job = createPreviewCursor(options);
    await writeLocked(transaction, chatId, job);
    return { created: true, job };
  });
}

export async function queueRun(
  chatId: number,
  options: { orderId?: string; recipientChatIds: Array<string | number> }
): Promise<{ action: QueueRunAction; job: JobCursor }> {
  const prisma = await db();
  return await prisma.$transaction(async (transaction) => {
    await lockChat(transaction, chatId);
    const existing = await readLocked(transaction, chatId);
    const requestedOrderId = normalizeOrderId(options.orderId);

    if (!existing) {
      const job = createPreviewCursor({
        orderId: requestedOrderId,
        pendingRun: true,
        recipientChatIds: options.recipientChatIds,
      });
      await writeLocked(transaction, chatId, job);
      return { action: 'created_preview' as const, job };
    }

    const job = existing.cursor;
    if (requestedOrderId && normalizeOrderId(job.orderId) !== requestedOrderId) {
      return { action: 'order_mismatch' as const, job };
    }

    if (job.kind === 'run') {
      return { action: 'already_running' as const, job };
    }

    if (job.status === 'needs_review') {
      return { action: 'needs_review' as const, job };
    }

    job.recipientChatIds = uniqueStrings([...job.recipientChatIds, ...options.recipientChatIds]);
    if (job.status === 'preview_ready') {
      const run = runCursorFromPreview(job);
      await writeLocked(transaction, chatId, run);
      return { action: 'started_run' as const, job: run };
    }

    job.pendingRun = true;
    await writeLocked(transaction, chatId, job);
    return { action: 'queued_after_preview' as const, job };
  });
}

export async function claimJob(chatId: number, expectedBatchId?: string): Promise<JobCursor | null> {
  const prisma = await db();
  return await prisma.$transaction(async (transaction) => {
    await lockChat(transaction, chatId);
    const existing = await readLocked(transaction, chatId);
    if (!existing) return null;

    const job = existing.cursor;
    if (expectedBatchId && job.batchId !== expectedBatchId) return null;

    const runningAndFresh =
      job.status === 'running' && Date.now() - job.updatedAt < JOB_STALE_MS;
    if (runningAndFresh || job.status === 'preview_ready' || job.status === 'needs_review') {
      return null;
    }

    job.status = 'running';
    job.executionToken = randomUUID();
    job.lastError = undefined;
    await writeLocked(transaction, chatId, job);
    return job;
  });
}

/** Save progress only if this invocation still owns the lease. */
export async function checkpointJob(
  chatId: number,
  cursor: JobCursor,
  executionToken: string,
  options: { resetAttempts?: boolean } = { resetAttempts: true }
): Promise<JobCursor> {
  const prisma = await db();
  return await prisma.$transaction(async (transaction) => {
    await lockChat(transaction, chatId);
    const existing = await readLocked(transaction, chatId);
    if (
      !existing ||
      existing.cursor.batchId !== cursor.batchId ||
      existing.cursor.executionToken !== executionToken ||
      existing.cursor.status !== 'running'
    ) {
      throw new ProductionJobLeaseLostError();
    }

    // A concurrent /run may have set this flag while the invocation was doing
    // network work. Never overwrite that request with an older in-memory value.
    cursor.pendingRun = cursor.pendingRun || existing.cursor.pendingRun;
    cursor.executionToken = executionToken;
    cursor.status = 'running';
    if (options.resetAttempts !== false) cursor.attemptCount = 0;
    await writeLocked(transaction, chatId, cursor);
    return cursor;
  });
}

export async function retryJob(
  chatId: number,
  cursor: JobCursor,
  executionToken: string,
  error: unknown
): Promise<JobCursor> {
  const prisma = await db();
  return await prisma.$transaction(async (transaction) => {
    await lockChat(transaction, chatId);
    const existing = await readLocked(transaction, chatId);
    if (
      !existing ||
      existing.cursor.batchId !== cursor.batchId ||
      existing.cursor.executionToken !== executionToken
    ) {
      throw new ProductionJobLeaseLostError();
    }

    cursor.pendingRun = cursor.pendingRun || existing.cursor.pendingRun;
    cursor.status = 'retrying';
    cursor.executionToken = undefined;
    cursor.attemptCount = Math.max(cursor.attemptCount, existing.cursor.attemptCount) + 1;
    cursor.lastError = String(error).slice(0, 500);
    await writeLocked(transaction, chatId, cursor);
    return cursor;
  });
}

/** Release the lease at a normal soft deadline without counting it as a failure. */
export async function yieldJob(
  chatId: number,
  cursor: JobCursor,
  executionToken: string,
  reason: string
): Promise<JobCursor> {
  const prisma = await db();
  return await prisma.$transaction(async (transaction) => {
    await lockChat(transaction, chatId);
    const existing = await readLocked(transaction, chatId);
    if (
      !existing ||
      existing.cursor.batchId !== cursor.batchId ||
      existing.cursor.executionToken !== executionToken
    ) {
      throw new ProductionJobLeaseLostError();
    }

    cursor.pendingRun = cursor.pendingRun || existing.cursor.pendingRun;
    cursor.status = 'retrying';
    cursor.executionToken = undefined;
    cursor.lastError = reason.slice(0, 500);
    await writeLocked(transaction, chatId, cursor);
    return cursor;
  });
}

export async function finishPreview(
  chatId: number,
  cursor: PreviewCursor,
  executionToken: string
): Promise<JobCursor> {
  const prisma = await db();
  return await prisma.$transaction(async (transaction) => {
    await lockChat(transaction, chatId);
    const existing = await readLocked(transaction, chatId);
    if (
      !existing ||
      existing.cursor.batchId !== cursor.batchId ||
      existing.cursor.executionToken !== executionToken
    ) {
      throw new ProductionJobLeaseLostError();
    }

    cursor.pendingRun = cursor.pendingRun || existing.cursor.pendingRun;
    if (cursor.pendingRun) {
      const run = runCursorFromPreview(cursor);
      await writeLocked(transaction, chatId, run);
      return run;
    }

    cursor.status = 'preview_ready';
    cursor.executionToken = undefined;
    cursor.attemptCount = 0;
    cursor.lastError = undefined;
    await writeLocked(transaction, chatId, cursor);
    return cursor;
  });
}

export async function markNeedsReview(
  chatId: number,
  cursor: JobCursor,
  executionToken: string,
  error: unknown
): Promise<void> {
  const prisma = await db();
  await prisma.$transaction(async (transaction) => {
    await lockChat(transaction, chatId);
    const existing = await readLocked(transaction, chatId);
    if (
      !existing ||
      existing.cursor.batchId !== cursor.batchId ||
      existing.cursor.executionToken !== executionToken
    ) {
      throw new ProductionJobLeaseLostError();
    }
    cursor.pendingRun = cursor.pendingRun || existing.cursor.pendingRun;
    cursor.status = 'needs_review';
    cursor.executionToken = undefined;
    cursor.lastError = String(error).slice(0, 500);
    await writeLocked(transaction, chatId, cursor);
  });
}

export async function completeRun(
  chatId: number,
  cursor: RunCursor,
  executionToken: string
): Promise<void> {
  const prisma = await db();
  await prisma.$transaction(async (transaction) => {
    await lockChat(transaction, chatId);
    const existing = await readLocked(transaction, chatId);
    if (
      !existing ||
      existing.cursor.batchId !== cursor.batchId ||
      existing.cursor.executionToken !== executionToken
    ) {
      throw new ProductionJobLeaseLostError();
    }

    await transaction.failedPayload.create({
      data: {
        source: HISTORY_SOURCE,
        reason: cursor.batchId,
        externalId: chatKey(chatId),
        payloadJson: JSON.stringify({ ...cursor, status: 'completed', executionToken: undefined }),
      },
    });
    await transaction.failedPayload.deleteMany({
      where: { source: SOURCE, reason: chatKey(chatId) },
    });
  });
}

export async function clearJob(chatId: number): Promise<void> {
  const prisma = await db();
  await prisma.$transaction(async (transaction) => {
    await lockChat(transaction, chatId);
    await transaction.failedPayload.deleteMany({
      where: { source: SOURCE, reason: chatKey(chatId) },
    });
  });
}
