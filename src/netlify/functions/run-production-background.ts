/**
 * Automatic, resumable production pipeline.
 *
 * Every invocation owns a short Neon-backed lease. Before Vercel's hard timeout
 * it checkpoints progress and signs a request that starts a fresh invocation.
 * No employee Continue button is involved.
 */
import { sendMessage } from '../../telegram/telegramApi.js';
import {
  checkpointJob,
  claimJob,
  completeRun,
  createPreviewJob,
  finishPreview,
  markNeedsReview,
  ProductionJobLeaseLostError,
  retryJob,
  type JobCursor,
  type PreviewCursor,
  type RunCursor,
  yieldJob,
} from '../../services/productionJobStore.js';
import { scheduleProductionContinuation } from '../../services/productionContinuation.js';
import { sendCompleteProductionPreview } from '../../services/productionPreviewService.js';
import { createExactBatchShipments } from '../../services/productionShippingService.js';
import {
  PermanentProductionError,
  SoftDeadlineError,
} from '../../services/productionPipelineErrors.js';

interface LambdaEvent { body: string | null }
interface LambdaResult { statusCode: number; body: string }
interface JobPayload { chatId: number; execute: boolean; orderId?: string }

const DEFAULT_PRODUCTION_RECIPIENT_CHAT_IDS = ['6776051391', '8615245657'];
const DEFAULT_JOB_DEADLINE_MS = 235_000;
const DEFAULT_MAX_AUTO_RETRIES = 8;

function numericEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function jobDeadlineMs(): number {
  return numericEnv('PRODUCTION_JOB_DEADLINE_MS', DEFAULT_JOB_DEADLINE_MS, 5_000, 250_000);
}

function maxAutoRetries(): number {
  return numericEnv('PRODUCTION_MAX_AUTO_RETRIES', DEFAULT_MAX_AUTO_RETRIES, 1, 20);
}

export function productionRecipientChatIds(triggerChatId: number): string[] {
  const configured = process.env.PRODUCTION_RECIPIENT_CHAT_IDS?.trim();
  const recipients = configured ? configured.split(',') : DEFAULT_PRODUCTION_RECIPIENT_CHAT_IDS;
  return [...new Set([String(triggerChatId), ...recipients.map((value) => value.trim())].filter(Boolean))];
}

function retryDelayMs(attempt: number): number {
  return Math.min(30_000, 2_000 * (2 ** Math.max(0, attempt - 1)));
}

async function scheduleNext(chatId: number, batchId: string, delayMs = 0): Promise<boolean> {
  try {
    await scheduleProductionContinuation({ chatId, batchId, delayMs });
    return true;
  } catch (error) {
    console.error('[production] Failed to dispatch automatic continuation', {
      chatId,
      batchId,
      error: String(error),
    });
    await sendMessage(
      chatId,
      `🚨 Batch ${batchId}\nفشل إطلاق الـrequest التالي تلقائيًا. التقدم محفوظ في Neon، والـwatchdog هيحاول يشغله تاني. ابعت رقم الـBatch للدعم لو التنبيه اتكرر.`
    );
    return false;
  }
}

function copyCheckpointState(target: JobCursor, saved: JobCursor): void {
  // pendingRun can be changed concurrently by the employee while this invocation
  // is sending a file. Copying the stored value keeps that request in memory too.
  target.pendingRun = saved.pendingRun;
  target.attemptCount = saved.attemptCount;
  target.updatedAt = saved.updatedAt;
}

export async function runPipeline(chatId: number, expectedBatchId?: string): Promise<void> {
  const cursor = await claimJob(chatId, expectedBatchId);
  if (!cursor?.executionToken) return;

  const executionToken = cursor.executionToken;
  const deadline = Date.now() + jobDeadlineMs();
  const checkpoint = async (): Promise<void> => {
    const saved = await checkpointJob(chatId, cursor, executionToken);
    copyCheckpointState(cursor, saved);
  };

  try {
    if (cursor.kind === 'preview') {
      await sendCompleteProductionPreview({
        chatId,
        cursor,
        deadline,
        checkpoint,
      });

      await sendMessage(
        chatId,
        `✅ Preview Batch ${cursor.batchId} اكتمل بالكامل: كل الملفات والصور والملخص اتأكد إرسالهم.`
      );
      const next = await finishPreview(chatId, cursor, executionToken);
      if (next.kind === 'run') {
        await sendMessage(chatId, `🚚 طلب /run متسجل — هبدأ شحن نفس الـ${next.orderNumbers.length} أوردر تلقائيًا.`);
        await scheduleNext(chatId, next.batchId);
      } else {
        await sendMessage(chatId, '🔒 الأوردرات اتثبتت. ابعت /run وقت ما تكون جاهز؛ الشحن هيستخدم نفس الـBatch بالضبط.');
      }
      return;
    }

    await createExactBatchShipments({
      chatId,
      cursor,
      deadline,
      checkpoint,
    });
    await completeRun(chatId, cursor, executionToken);
    await sendMessage(chatId, `✅ Batch ${cursor.batchId} خلص بالكامل واتحفظ تقريره.`);
  } catch (error) {
    if (error instanceof ProductionJobLeaseLostError) {
      // /cancel or another valid lease won. Stop silently; never recreate state.
      return;
    }

    if (error instanceof SoftDeadlineError) {
      try {
        const saved = await yieldJob(chatId, cursor, executionToken, error.progress);
        await sendMessage(
          chatId,
          `⏳ وصلت لنقطة النقل الآمنة في Batch ${saved.batchId}. التقدم محفوظ وهكمل تلقائيًا في request جديد — مش مطلوب منك تعمل حاجة.`
        );
        await scheduleNext(chatId, saved.batchId);
      } catch (leaseError) {
        if (!(leaseError instanceof ProductionJobLeaseLostError)) throw leaseError;
      }
      return;
    }

    if (error instanceof PermanentProductionError) {
      try {
        await markNeedsReview(chatId, cursor, executionToken, error.message);
        await sendMessage(
          chatId,
          `🛑 Batch ${cursor.batchId} اتوقف بأمان للمراجعة، ومفيش خطوة ناقصة اتعلمت إنها نجحت.\nالسبب: ${error.message}\nابعت رقم الـBatch للدعم؛ وبعد التصحيح نكمل من الحالة المحفوظة أو نستخدم /cancel.`
        );
      } catch (leaseError) {
        if (!(leaseError instanceof ProductionJobLeaseLostError)) throw leaseError;
      }
      return;
    }

    try {
      const nextAttempt = cursor.attemptCount + 1;
      if (nextAttempt > maxAutoRetries()) {
        await markNeedsReview(chatId, cursor, executionToken, error);
        await sendMessage(
          chatId,
          `🛑 Batch ${cursor.batchId} محفوظ، لكنه فشل ${cursor.attemptCount + 1} مرات متتالية.\nآخر خطأ: ${String(error).slice(0, 300)}\nابعت رقم الـBatch للدعم للمراجعة؛ لن أخمّن أو أكرر شحنة.`
        );
        return;
      }

      const saved = await retryJob(chatId, cursor, executionToken, error);
      const delayMs = retryDelayMs(saved.attemptCount);
      await sendMessage(
        chatId,
        `🔄 خطأ مؤقت في Batch ${saved.batchId} (محاولة ${saved.attemptCount}/${maxAutoRetries()}). التقدم محفوظ وهعيد المحاولة تلقائيًا بعد ${Math.ceil(delayMs / 1000)} ثانية.`
      );
      await scheduleNext(chatId, saved.batchId, delayMs);
    } catch (leaseError) {
      if (!(leaseError instanceof ProductionJobLeaseLostError)) throw leaseError;
    }
  }
}

/** Called by the signed internal Vercel endpoint. */
export async function resumeProductionInvocation(
  chatId: number,
  batchId: string,
  delayMs = 0
): Promise<void> {
  const boundedDelay = Math.min(30_000, Math.max(0, Number(delayMs) || 0));
  if (boundedDelay) {
    await new Promise((resolve) => setTimeout(resolve, boundedDelay));
  }
  await runPipeline(chatId, batchId);
}

// Compatibility entrypoint for any old direct invocation. It now creates the
// same preview-first durable workflow instead of running a second code path.
export const handler = async (event: LambdaEvent): Promise<LambdaResult> => {
  if (!event.body) return { statusCode: 400, body: 'Missing body' };
  let payload: JobPayload;
  try {
    payload = JSON.parse(event.body) as JobPayload;
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const created = await createPreviewJob(payload.chatId, {
    orderId: payload.orderId,
    pendingRun: payload.execute,
    recipientChatIds: productionRecipientChatIds(payload.chatId),
  });
  await runPipeline(payload.chatId, created.job.batchId);
  return { statusCode: 202, body: 'ok' };
};
