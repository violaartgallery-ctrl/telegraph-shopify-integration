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
import type { ProductionAgentResponse } from './productionAgentClient.js';
import type { ShipResult } from './productionJobTypes.js';
import { previewOnlyConfig, manualRunConfig, isFreshOwnerPreviewMessage, isPreviewOperator, previewRecipientsMatch, assertPreviewCursorInMode, assertProductionRunAllowed } from './productionPreviewOnly.js';
import { assertManualShipmentBindings, type ManualShipmentBinding } from './manualShipmentBinding.js';

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
  /** Explicit owner-only release epoch; never inferred for an old cursor. */
  previewOnlyEpoch?: string;
  sourceFingerprint?: string;
  previewReadyAt?: number;
  manualShipmentBindings?: ManualShipmentBinding[];
  manualShipmentBindingHash?: string;
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
  manualRunEpoch?: string;
  manualRunApprovedBy?: number;
  manualRunApprovedUpdateId?: number;
  manualRunMessageDate?: number;
  manualRunApprovedAt?: number;
  manualRunApprovedBatchId?: string;
  manualRunApprovalBindingHash?: string;
  manualRunApprovalSourceFingerprint?: string;
}

export interface PreviewCursor extends JobCommon {
  kind: 'preview';
  /** `${recipientChatId}|${artifactKey}` entries confirmed by Telegram. */
  sentArtifactKeys: string[];
  /** `${recipientChatId}|${photoUrl}` entries confirmed by Telegram. */
  sentPhotoKeys: string[];
  /** Source photo URLs that returned a permanent 404/410 and require review. */
  unavailablePhotoUrls?: string[];
  /** Detects edits between continuation segments so a batch cannot mix versions. */
  sourceFingerprint?: string;
  /** Counts captured after expensive artifact generation so completed stages can be skipped. */
  artifactManifest?: {
    laserFileCount: number;
    boxFileCount: number;
    uniquePhotoCount: number;
  };
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
const PREVIEW_SNAPSHOT_SOURCE = 'prod_preview_snapshot';
const TELEGRAM_UPDATE_SOURCE = 'prod_telegram_update';
const TELEGRAM_UPDATE_HISTORY_LIMIT = 64;

export class ProductionTelegramUpdateReplayError extends Error {
  constructor() {
    super('Production Telegram update was already accepted or predates the cancellation barrier');
    this.name = 'ProductionTelegramUpdateReplayError';
  }
}

/** Called under the chat lock, in the SAME transaction as the command's state change.
 * A single watermark and at most 64 audit entries per chat bound storage without
 * making evicted update IDs executable again. Older/out-of-order commands fail
 * closed. LIMITATION: Telegram may choose a new random update_id after a week
 * without updates. A legitimate lower ID will also be rejected until an explicit,
 * audited operator epoch reset/migration preserves the old cancellation barrier.
 * No reset procedure is provided here; NEVER expire/reset this watermark based
 * only on elapsed wall-clock time (that would make old cancelled updates valid).
 */
async function acceptTelegramUpdate(
  transaction: JobTransaction,
  chatId: number,
  updateId: number | undefined,
  action: 'preview' | 'run' | 'cancel',
  readOnly = false
): Promise<void> {
  // Internal/support callers have no Telegram envelope. Webhook callers must
  // supply a validated update_id; this is not a replacement for authorization.
  if (updateId === undefined) return;
  if (!Number.isSafeInteger(updateId) || updateId < 0) throw new Error('Invalid Telegram update_id');
  const row = await transaction.failedPayload.findFirst({
    where: { source: TELEGRAM_UPDATE_SOURCE, reason: chatKey(chatId) },
    orderBy: { id: 'desc' },
  });
  let recent: Array<{ updateId: number; action: string; acceptedAt: number }> = [];
  if (row) {
    const saved = JSON.parse(row.payloadJson);
    if (saved.version !== 1 || !Number.isSafeInteger(saved.highWaterUpdateId) ||
        saved.highWaterUpdateId < 0 || !Array.isArray(saved.recent)) {
      throw new Error('Invalid production Telegram update watermark; operator review required');
    }
    if (updateId <= saved.highWaterUpdateId) throw new ProductionTelegramUpdateReplayError();
    recent = saved.recent.slice(-(TELEGRAM_UPDATE_HISTORY_LIMIT - 1));
  }
  if (readOnly) return;
  recent.push({ updateId, action, acceptedAt: Date.now() });
  await transaction.failedPayload.deleteMany({
    where: { source: TELEGRAM_UPDATE_SOURCE, reason: chatKey(chatId) },
  });
  await transaction.failedPayload.create({ data: {
    source: TELEGRAM_UPDATE_SOURCE,
    reason: chatKey(chatId),
    externalId: String(updateId),
    payloadJson: JSON.stringify({ version: 1, highWaterUpdateId: updateId, recent }),
  } });
}

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
  const previewMode = previewOnlyConfig();
  return {
    version: 2,
    ...(previewMode ? { previewOnlyEpoch: previewMode.epoch } : {}),
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
    unavailablePhotoUrls: [],
    updatedAt: Date.now(),
  };
}

export function runCursorFromPreview(preview: PreviewCursor, approval?: Pick<RunCursor,
  'manualRunEpoch' | 'manualRunApprovedBy' | 'manualRunApprovedUpdateId' | 'manualRunMessageDate' | 'manualRunApprovedAt'>): RunCursor {
  if (!approval) assertProductionRunAllowed();
  const run: RunCursor = {
    version: 2,
    batchId: preview.batchId,
    kind: 'run',
    status: 'queued',
    ...(preview.orderId ? { orderId: preview.orderId } : {}),
    orderNumbers: [...preview.orderNumbers],
    pendingRun: false,
    recipientChatIds: [...preview.recipientChatIds],
    ...(approval ? { ...approval, previewOnlyEpoch: preview.previewOnlyEpoch,
      sourceFingerprint: preview.sourceFingerprint, previewReadyAt: preview.previewReadyAt,
      manualShipmentBindings: preview.manualShipmentBindings?.map(binding => ({ ...binding })),
      manualShipmentBindingHash: preview.manualShipmentBindingHash,
      manualRunApprovedBatchId: preview.batchId,
      manualRunApprovalBindingHash: preview.manualShipmentBindingHash,
      manualRunApprovalSourceFingerprint: preview.sourceFingerprint } : {}),
    attemptCount: 0,
    phase: 'shipping',
    processedOrderNames: [],
    createdShipmentIds: [],
    results: [],
    needsReviewOrderNames: [],
    sentFinalArtifactKeys: [],
    updatedAt: Date.now(),
  };
  if (approval) assertProductionRunAllowed({ chatId: Number(approval.manualRunApprovedBy), cursor: run });
  return run;
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
    if (previewOnlyConfig()) throw new Error('Legacy production cursor requires operator review; it was preserved');
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

/** Fence each next operation, including after slow reads/backoff. This cannot
 * revoke a provider request already in flight or atomically fence that provider.
 * A failed/missing read must propagate; it must never grant permission to work.
 */
export async function assertJobLease(
  chatId: number,
  batchId: string,
  executionToken: string | undefined
): Promise<void> {
  if (!executionToken) throw new ProductionJobLeaseLostError();
  const current = await loadJob(chatId);
  if (!current || current.batchId !== batchId || current.executionToken !== executionToken ||
      current.status !== 'running' || !Number.isFinite(current.updatedAt) ||
      Date.now() - current.updatedAt >= JOB_STALE_MS) {
    throw new ProductionJobLeaseLostError();
  }
  assertPreviewCursorInMode(chatId, current);
}

function parsePreviewSnapshot(payloadJson: string): ProductionAgentResponse | null {
  try {
    const parsed = JSON.parse(payloadJson) as Partial<ProductionAgentResponse>;
    if (
      typeof parsed.wordBase64 !== 'string' ||
      !Array.isArray(parsed.productionEntries) ||
      !Array.isArray(parsed.ordersDetail) ||
      !Array.isArray(parsed.warnings)
    ) {
      return null;
    }
    return parsed as ProductionAgentResponse;
  } catch {
    return null;
  }
}

/**
 * Return the immutable source captured before the first Telegram artifact was
 * sent. Continuations must use this exact payload so file indexes cannot drift.
 */
export async function loadPreviewSourceSnapshot(
  batchId: string
): Promise<ProductionAgentResponse | null> {
  const prisma = await db();
  const row = await prisma.failedPayload.findFirst({
    where: { source: PREVIEW_SNAPSHOT_SOURCE, reason: batchId },
    orderBy: { id: 'desc' },
  });
  if (!row) return null;
  const snapshot = parsePreviewSnapshot(row.payloadJson);
  if (!snapshot) throw new Error(`Preview source snapshot ${batchId} is invalid`);
  return snapshot;
}

/**
 * Persist the source only while this invocation still owns the preview lease.
 * The snapshot is written before any Telegram document is sent.
 */
export async function savePreviewSourceSnapshot(
  chatId: number,
  batchId: string,
  executionToken: string,
  data: ProductionAgentResponse
): Promise<void> {
  const prisma = await db();
  await prisma.$transaction(async (transaction) => {
    await lockChat(transaction, chatId);
    const existing = await readLocked(transaction, chatId);
    if (
      !existing ||
      existing.cursor.kind !== 'preview' ||
      existing.cursor.batchId !== batchId ||
      existing.cursor.executionToken !== executionToken ||
      existing.cursor.status !== 'running'
    ) {
      throw new ProductionJobLeaseLostError();
    }

    await transaction.failedPayload.deleteMany({
      where: { source: PREVIEW_SNAPSHOT_SOURCE, reason: batchId },
    });
    await transaction.failedPayload.create({
      data: {
        source: PREVIEW_SNAPSHOT_SOURCE,
        reason: batchId,
        externalId: chatKey(chatId),
        payloadJson: JSON.stringify(data),
      },
    });
  });
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
  options: { orderId?: string; pendingRun?: boolean; recipientChatIds: Array<string | number>; telegramUpdateId?: number }
): Promise<{ created: boolean; job: JobCursor }> {
  const mode = previewOnlyConfig();
  if (mode && (!isPreviewOperator(chatId, mode) || options.pendingRun ||
      !Number.isSafeInteger(options.telegramUpdateId) || Number(options.telegramUpdateId) <= mode.minUpdateId ||
      !previewRecipientsMatch(options.recipientChatIds.map(String), mode))) {
    throw new Error('Only a fresh owner Preview is authorized');
  }
  const prisma = await db();
  return await prisma.$transaction(async (transaction) => {
    await lockChat(transaction, chatId);
    await acceptTelegramUpdate(transaction, chatId, options.telegramUpdateId, 'preview');
    const existing = await readLocked(transaction, chatId);
    if (existing) {
      assertPreviewCursorInMode(chatId, existing.cursor);
      if (mode && existing.cursor.kind !== 'preview') throw new Error('An approved Run is already active; Preview cannot replace or restart it');
      return { created: false, job: existing.cursor };
    }

    // Cancelled batches' source snapshots are immutable recovery evidence.
    const job = createPreviewCursor(options);
    await writeLocked(transaction, chatId, job);
    return { created: true, job };
  });
}

export async function queueRun(
  chatId: number,
  options: { orderId?: string; recipientChatIds: Array<string | number>; telegramUpdateId?: number;
    telegramFromId?: number; telegramMessageDate?: number }
): Promise<{ action: QueueRunAction; job: JobCursor }> {
  const mode = previewOnlyConfig(), manual = manualRunConfig();
  if (mode) {
    if (!manual) assertProductionRunAllowed();
    if (!manual || !isFreshOwnerPreviewMessage({ chatId, fromId: options.telegramFromId,
      date: options.telegramMessageDate, updateId: Number(options.telegramUpdateId) }, mode) ||
      Number(options.telegramUpdateId) <= manual.minUpdateId || Number(options.telegramMessageDate) < manual.notBefore ||
      !previewRecipientsMatch(options.recipientChatIds.map(String), mode)) {
      throw new Error('Only a fresh private authorized manual /run is permitted');
    }
  } else assertProductionRunAllowed();
  const prisma = await db();
  return await prisma.$transaction(async (transaction) => {
    await lockChat(transaction, chatId);
    const existing = await readLocked(transaction, chatId);
    const requestedOrderId = normalizeOrderId(options.orderId);
    if (mode && manual) {
      await acceptTelegramUpdate(transaction, chatId, options.telegramUpdateId, 'run', true);
      if (!existing || existing.cursor.kind !== 'preview' || existing.cursor.status !== 'preview_ready') {
        throw new Error('A NEW completed Preview is required before manual /run; no Run was queued');
      }
      const preview = existing.cursor;
      assertPreviewCursorInMode(chatId, preview);
      assertManualShipmentBindings(preview);
      if (preview.pendingRun || !Number.isSafeInteger(preview.previewReadyAt) ||
          Number(options.telegramMessageDate) < Number(preview.previewReadyAt) ||
          !/^[a-f0-9]{64}$/.test(preview.sourceFingerprint ?? '') ||
          (requestedOrderId && requestedOrderId !== normalizeOrderId(preview.orderId))) {
        throw new Error('Manual /run must follow completion of the exact NEW Preview');
      }
      await acceptTelegramUpdate(transaction, chatId, options.telegramUpdateId, 'run');
      const run = runCursorFromPreview(preview, { manualRunEpoch: manual.epoch, manualRunApprovedBy: chatId,
        manualRunApprovedUpdateId: options.telegramUpdateId, manualRunMessageDate: options.telegramMessageDate,
        manualRunApprovedAt: Date.now() });
      await writeLocked(transaction, chatId, run);
      return { action: 'started_run' as const, job: run };
    }
    await acceptTelegramUpdate(transaction, chatId, options.telegramUpdateId, 'run');

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
    assertPreviewCursorInMode(chatId, job);

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
    assertPreviewCursorInMode(chatId, existing.cursor);
    assertPreviewCursorInMode(chatId, cursor);
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

/**
 * Support-only recovery after the cause of a needs-review stop is understood.
 * Preserves every confirmed artifact/photo and only makes the same batch
 * claimable again; it never creates a new batch or marks work as successful.
 */
export async function requeueNeedsReviewJob(
  chatId: number,
  batchId: string
): Promise<JobCursor> {
  const prisma = await db();
  return await prisma.$transaction(async (transaction) => {
    await lockChat(transaction, chatId);
    const existing = await readLocked(transaction, chatId);
    if (
      !existing ||
      existing.cursor.batchId !== batchId ||
      existing.cursor.status !== 'needs_review'
    ) {
      throw new Error(`Production batch ${batchId} is not waiting for review`);
    }

    const cursor = existing.cursor;
    cursor.status = 'retrying';
    cursor.executionToken = undefined;
    cursor.attemptCount = 0;
    cursor.lastError = undefined;
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

    assertPreviewCursorInMode(chatId, existing.cursor);
    assertPreviewCursorInMode(chatId, cursor);
    cursor.pendingRun = cursor.pendingRun || existing.cursor.pendingRun;
    if (cursor.pendingRun) {
      const run = runCursorFromPreview(cursor);
      await writeLocked(transaction, chatId, run);
      await transaction.failedPayload.deleteMany({
        where: { source: PREVIEW_SNAPSHOT_SOURCE, reason: cursor.batchId },
      });
      return run;
    }

    cursor.status = 'preview_ready';
    if (manualRunConfig()) {
      assertManualShipmentBindings(cursor);
      cursor.previewReadyAt = Math.ceil(Date.now() / 1000);
    }
    cursor.executionToken = undefined;
    cursor.attemptCount = 0;
    cursor.lastError = undefined;
    await writeLocked(transaction, chatId, cursor);
    if (!manualRunConfig()) await transaction.failedPayload.deleteMany({
      where: { source: PREVIEW_SNAPSHOT_SOURCE, reason: cursor.batchId },
    });
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
    if (!manualRunConfig()) await transaction.failedPayload.deleteMany({
      where: { source: PREVIEW_SNAPSHOT_SOURCE, reason: cursor.batchId },
    });
  });
}

export async function clearJob(chatId: number, telegramUpdateId?: number): Promise<void> {
  const prisma = await db();
  await prisma.$transaction(async (transaction) => {
    await lockChat(transaction, chatId);
    const rows = await transaction.failedPayload.findMany({
      where: { source: SOURCE, reason: chatKey(chatId) },
      orderBy: { id: 'asc' },
    });
    const mode = previewOnlyConfig();
    if (mode && (!isPreviewOperator(chatId, mode) || rows.some(row => {
      const cursor = parseCursor(row.payloadJson);
      if (!cursor) return true;
      if (cursor.kind === 'preview') return false; // Old valid v2 Preview may be cancelled after an epoch change.
      try { assertProductionRunAllowed({ chatId, cursor }); return false; }
      catch { return true; }
    }))) {
      throw new Error('Preview-only cancellation cannot modify a held Run or unknown legacy job');
    }
    await acceptTelegramUpdate(transaction, chatId, telegramUpdateId, 'cancel');
    if (!rows.length && telegramUpdateId !== undefined) {
      await transaction.failedPayload.create({ data: {
        source: HISTORY_SOURCE,
        reason: `cancelled-update:${telegramUpdateId}`,
        externalId: chatKey(chatId),
        payloadJson: JSON.stringify({
          status: 'cancelled',
          noActiveJob: true,
          cancelledAt: Date.now(),
          cancelledByTelegramUpdateId: telegramUpdateId,
        }),
      } });
    }
    for (const row of rows) {
      const cursor = parseCursor(row.payloadJson);
      await transaction.failedPayload.create({ data: {
        source: HISTORY_SOURCE,
        reason: cursor?.batchId ?? row.externalId ?? `cancelled-row-${row.id}`,
        externalId: chatKey(chatId),
        payloadJson: JSON.stringify({
          ...(cursor ?? { originalPayloadJson: row.payloadJson }),
          status: 'cancelled',
          executionToken: undefined,
          cancelledAt: Date.now(),
          ...(telegramUpdateId === undefined ? {} : { cancelledByTelegramUpdateId: telegramUpdateId }),
        }),
      } });
    }
    await transaction.failedPayload.deleteMany({
      where: { source: SOURCE, reason: chatKey(chatId) },
    });
    // Keep history, snapshots, dedup barriers and all shipment/accounting records.
  });
}
