/**
 * Resumable-job checkpoint store for the Telegram production bot.
 *
 * Both /run (shipments) and /preview (documents+photos) can exceed Vercel's
 * 300s function limit on a busy day. Instead of racing the clock, the pipeline
 * stops cleanly at a soft deadline (~4 min), saves WHERE it stopped here, and
 * sends the user a "Continue" button. Pressing it resumes from this cursor —
 * so work is never lost and never truncated by a hard timeout.
 *
 * State lives in the FailedPayload table (the bot's existing key-value store,
 * already used for bot_control) keyed by source='prod_job' + reason=chatId, so
 * no schema migration is needed. One active job per chat.
 */
import type { ShipResult } from './productionJobTypes.js';

// One row per chat. status drives the Continue guard; updatedAt lets a crashed
// 'running' job (never cleanly paused) be treated as resumable after a while.
interface JobCommon {
  status: 'running' | 'paused';
  orderId?: string;
  updatedAt: number;
}

export interface RunCursor extends JobCommon {
  kind: 'run';
  phase: 'shipping' | 'finalize';
  processedOrderNames: string[]; // orders already shipped/skipped (resume skips these)
  createdShipmentIds: number[]; // accumulated across segments → full waybill link
  results: ShipResult[]; // accumulated per-order outcomes → full final report
}

export interface PreviewCursor extends JobCommon {
  kind: 'preview';
  // Document steps already sent: 0=none 1=word 2=laser+box 3=print-sheet.
  docStep: number;
  // URLs of photos already sent — identity-based (NOT a positional index), so a
  // re-fetch that reorders/adds/removes photos between segments can never skip
  // or mis-caption a photo. Already-sent URLs are simply not sent again.
  sentPhotoUrls: string[];
  summaryDone: boolean; // orders-summary + final summary already sent
}

export type JobCursor = RunCursor | PreviewCursor;

const SOURCE = 'prod_job';

// A 'running' job older than this (ms) is assumed dead (function crashed before
// it could pause) and may be resumed. Comfortably above the 300s function cap.
export const JOB_STALE_MS = 330_000;

async function db() {
  const { prisma } = await import('../lib/prisma.js');
  return prisma;
}

export async function loadJob(chatId: number): Promise<JobCursor | null> {
  const prisma = await db();
  const row = await prisma.failedPayload.findFirst({
    where: { source: SOURCE, reason: String(chatId) },
    orderBy: { id: 'desc' },
  });
  if (!row) return null;
  try {
    return JSON.parse(row.payloadJson) as JobCursor;
  } catch {
    return null;
  }
}

export async function saveJob(chatId: number, cursor: JobCursor): Promise<void> {
  const prisma = await db();
  cursor.updatedAt = Date.now();
  const payloadJson = JSON.stringify(cursor);
  // Upsert-by-replace: one row per chat.
  await prisma.failedPayload.deleteMany({ where: { source: SOURCE, reason: String(chatId) } });
  await prisma.failedPayload.create({
    data: { source: SOURCE, reason: String(chatId), payloadJson },
  });
}

export async function clearJob(chatId: number): Promise<void> {
  const prisma = await db();
  await prisma.failedPayload.deleteMany({ where: { source: SOURCE, reason: String(chatId) } });
}
