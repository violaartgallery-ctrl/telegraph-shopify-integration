import { waitUntil } from '@vercel/functions';
import { timingSafeEqual } from 'node:crypto';
import { previewOnlyConfig, manualRunConfig, isPreviewOperator, isFreshOwnerPreviewMessage, assertPreviewCursorInMode, assertProductionRunAllowed, type PreviewOnlyConfig } from '../../services/productionPreviewOnly.js';
import { answerCallbackQuery, sendMessage } from '../../telegram/telegramApi.js';
import { productionRecipientChatIds } from './run-production-background.js';
import { scheduleProductionContinuation } from '../../services/productionContinuation.js';
import {
  clearJob,
  createPreviewJob,
  loadJob,
  queueRun,
  ProductionTelegramUpdateReplayError,
  type JobCursor,
} from '../../services/productionJobStore.js';
import {
  isAllowed,
  getUser,
  getActiveUsers,
  forceRefresh,
} from '../../telegram/sheetsClient.js';

interface TelegramUser {
  id: number;
  first_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: string;
}

interface TelegramMessage {
  message_id: number;
  date?: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  from?: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface LambdaEvent {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body: string | null;
}

interface LambdaResult {
  statusCode: number;
  body: string;
}

const RUN_PHRASES = new Set(['شحن', 'اشحن', 'بوالص', 'اعمل الشحنات', 'اعمل الشحن']);
const PREVIEW_PHRASES = new Set([
  'بريفيو',
  'preview',
  'بريفو',
  'تجميعة',
  'التجميعة',
  'اعمل التجميعة',
  'اعمل التجميعه',
  'مستندات',
]);

function isTelegraphEnabled(): boolean {
  return process.env.TELEGRAPH_ENABLED?.trim().toLowerCase() === 'true';
}

async function triggerBackground(chatId: number, job: JobCursor): Promise<void> {
  const dispatch = scheduleProductionContinuation({
    chatId,
    batchId: job.batchId,
    dispatchKey: String(job.updatedAt),
  }).catch(async (error) => {
    console.error('[webhook] Failed to enqueue production pipeline:', error);
    await sendMessage(
      chatId,
      previewOnlyConfig()
        ? `🚨 تعذر إرسال استكمال Batch ${job.batchId}. الحالة محفوظة؛ استخدم /status ثم الدعم. الـwatchdog العام مقفول؛ لا تكرر الشحن.`
        : `🚨 تعذر وضع Batch ${job.batchId} في طابور التشغيل. الحالة محفوظة والـwatchdog هيحاول تلقائيًا.`
    );
  });
  if (process.env.PRODUCTION_CONTINUATION_TRANSPORT === 'netlify') {
    await dispatch;
    return;
  }
  try {
    waitUntil(dispatch);
  } catch (error) {
    console.error('[webhook] Failed to retain production queue publish:', error);
    void sendMessage(
      chatId,
      previewOnlyConfig()
        ? `🚨 تعذر إرسال استكمال Batch ${job.batchId}. الحالة محفوظة؛ استخدم /status ثم الدعم. الـwatchdog العام مقفول؛ لا تكرر الشحن.`
        : `🚨 تعذر وضع Batch ${job.batchId} في طابور التشغيل. الحالة محفوظة والـwatchdog هيحاول تلقائيًا.`
    );
  }
}

async function isBotPaused(): Promise<boolean> {
  const { prisma } = await import('../../lib/prisma.js');
  const row = await prisma.failedPayload.findFirst({
    where: { source: 'bot_control', reason: 'bot_paused' },
  });
  return Boolean(row);
}

function parseOrderArgument(fullText: string): string | undefined {
  const parts = fullText.trim().split(/\s+/);
  return parts[1]?.replace(/^#/, '').trim() || undefined;
}

async function ensureBotRunning(chatId: number): Promise<boolean> {
  const mode = previewOnlyConfig();
  if (mode) return isPreviewOperator(chatId, mode); // Does NOT clear the global /stop row.
  if (!(await isBotPaused())) return true;
  await sendMessage(chatId, '🛑 البوت متوقف (/stop). ابعت /resume الأول.');
  return false;
}

async function startPreview(chatId: number, orderId?: string, telegramUpdateId?: number): Promise<void> {
  if (!(await ensureBotRunning(chatId))) return;
  const result = await createPreviewJob(chatId, {
    orderId,
    pendingRun: false,
    recipientChatIds: productionRecipientChatIds(chatId),
    telegramUpdateId,
  });

  if (result.created) {
    await sendMessage(
      chatId,
      `⏳ بدأ Preview آلي${orderId ? ` للأوردر #${orderId}` : ''}.\nBatch: ${result.job.batchId}\nلو الوقت خلص هكمل لوحدي في request جديد.`
    );
    await triggerBackground(chatId, result.job);
    return;
  }

  if (result.job.status === 'preview_ready') {
    await sendMessage(
      chatId,
      previewOnlyConfig()
        ? `✅ Preview Batch ${result.job.batchId} مكتمل (${result.job.orderNumbers.length} أوردر). ${manualRunConfig() ? 'أرسل /run جديد للشحن؛ Odoo والطوابير المالية تظل مقفولة.' : 'Run مقفول. ابعت /cancel ثم /preview لاختبار جديد.'}`
        : `✅ Preview Batch ${result.job.batchId} مكتمل بالفعل (${result.job.orderNumbers.length} أوردر). ابعت /run لشحن نفس القائمة، أو /cancel لبدء Batch جديد.`
    );
  } else if (result.job.status === 'needs_review') {
    await sendMessage(
      chatId,
      `🛑 Batch ${result.job.batchId} محتاج مراجعة. آخر خطأ: ${result.job.lastError ?? 'غير متاح'}\nالتقدم محفوظ؛ ابعت رقم الـBatch للدعم أو /cancel بعد الاتفاق.`
    );
  } else {
    await sendMessage(
      chatId,
      `⏳ Batch ${result.job.batchId} شغال أو مستني إعادة محاولة تلقائية. مش مطلوب زر Continue، ومش هبدأ Batch متداخل.`
    );
    // If a prior self-request failed to dispatch, this harmless claim attempt
    // restarts a retrying job; a fresh running lease simply rejects it.
    await triggerBackground(chatId, result.job);
  }
}

async function startRun(chatId: number, orderId?: string, telegramUpdateId?: number,
  telegramFromId?: number, telegramMessageDate?: number): Promise<void> {
  if (!(await ensureBotRunning(chatId))) return;
  if (!isTelegraphEnabled()) {
    await sendMessage(chatId, '⛔ TELEGRAPH_ENABLED مش مفعّل؛ لن أبدأ شحنًا.');
    return;
  }

  const result = await queueRun(chatId, {
    orderId,
    recipientChatIds: productionRecipientChatIds(chatId),
    telegramUpdateId,
    telegramFromId,
    telegramMessageDate,
  });

  if (result.action === 'order_mismatch') {
    await sendMessage(
      chatId,
      `⚠️ الـBatch الحالي ${result.job.batchId} مخصص لقائمة مختلفة. استخدم /run بدون رقم لشحنه، أو /cancel ثم ابدأ الأوردر المطلوب.`
    );
    return;
  }
  if (result.action === 'needs_review') {
    await sendMessage(
      chatId,
      `🛑 Batch ${result.job.batchId} متوقف للمراجعة ولن أخمّن أو أشحن قبل التصحيح. آخر خطأ: ${result.job.lastError ?? 'غير متاح'}`
    );
    return;
  }
  if (result.action === 'already_running') {
    await sendMessage(
      chatId,
      `🚚 شحن Batch ${result.job.batchId} شغال بالفعل أو هيُعاد تلقائيًا. مفيش ضغطة Continue ومفيش شحنة هتتكرر.`
    );
    await triggerBackground(chatId, result.job);
    return;
  }
  if (result.action === 'created_preview') {
    await sendMessage(
      chatId,
      `🔒 مفيش Preview جاهز، فعملت بوابة أمان تلقائية: هثبت الأوردرات، أبعت كل الـPreview، وبعد اكتماله أبدأ الشحن لوحدي.\nBatch: ${result.job.batchId}`
    );
  } else if (result.action === 'queued_after_preview') {
    await sendMessage(
      chatId,
      `✅ /run اتسجل على Batch ${result.job.batchId}. هكمل الـPreview أولًا ثم أبدأ شحن نفس ${result.job.orderNumbers.length || 'قائمة'} الأوردرات تلقائيًا.`
    );
  } else {
    await sendMessage(
      chatId,
      `🚚 Preview مكتمل — اتصرح بشحن نفس ${result.job.orderNumbers.length} أوردر في Batch ${result.job.batchId}.` +
      (previewOnlyConfig() ? '\n⏳ Odoo إنتاج/محاسبة: intent جديد فقط، العمال والطوابير المالية لم تعمل.' : '')
    );
  }
  await triggerBackground(chatId, result.job);
}

async function statusMessage(chatId: number): Promise<void> {
  const job = await loadJob(chatId);
  if (!job) {
    await sendMessage(chatId, 'ℹ️ مفيش Batch نشط دلوقتي.');
    return;
  }
  const progress = job.kind === 'preview'
    ? `ملفات مؤكدة: ${job.sentArtifactKeys.length} — صور مؤكدة: ${job.sentPhotoKeys.length}`
    : `تم التعامل مع: ${job.processedOrderNames.length}/${job.orderNumbers.length} — يحتاج مراجعة: ${job.needsReviewOrderNames.length}`;
  await sendMessage(
    chatId,
    [
      `📍 Batch ${job.batchId}`,
      `المرحلة: ${job.kind === 'preview' ? 'Preview' : 'Shipping'}`,
      `الحالة: ${job.status}`,
      `الأوردرات المثبتة: ${job.orderNumbers.length}`,
      progress,
      `محاولات الخطأ المتتالية: ${job.attemptCount}`,
      ...(job.lastError ? [`آخر ملاحظة: ${job.lastError.slice(0, 250)}`] : []),
      ...(manualRunConfig() ? ['⏳ Odoo والمحاسبة: مهام جديدة مسجلة فقط، لم يتم تشغيل العمال أو الطوابير العامة.'] : []),
    ].join('\n')
  );
}

async function handleCommand(chatId: number, command: string, fullText: string, telegramUpdateId: number): Promise<void> {
  if (command === '/start') {
    const user = await getUser(chatId);
    const allowed = await isAllowed(chatId);
    const greeting = user ? `أهلاً ${user.name}! 👋` : 'أهلاً!';
    const access = allowed
      ? `✅ مصرّح ليك (${user?.role ?? 'user'})`
      : `⛔ مش موجود في قائمة المستخدمين\nChat ID بتاعك: ${chatId}`;
    await sendMessage(
      chatId,
      `${greeting}\n\n${access}\n\n` +
        `الأوامر:\n` +
        `• /preview — يثبت Batch ويرسل كل Word والليزر والصور والملخص\n` +
        `• /run — يشحن نفس الـBatch؛ ولو الـPreview ناقص يكمله آليًا أولًا\n` +
        `• /status — حالة وتقدم الـBatch\n` +
        `• /cancel — إلغاء الحالة المحفوظة بعد التأكد\n` +
        `• /users و /refresh — صلاحيات المستخدمين\n\n` +
        `عند timeout أو خطأ مؤقت البوت يكمل تلقائيًا في request جديد؛ مفيش زر Continue.\n` +
        `TELEGRAPH_ENABLED: ${isTelegraphEnabled() ? 'true ✅' : 'false ⛔'}`
    );
    return;
  }

  if (!(await isAllowed(chatId))) {
    await sendMessage(chatId, `مش مصرّح ليك.\nChat ID بتاعك: ${chatId}`);
    return;
  }

  if (command === '/stop') {
    const { prisma } = await import('../../lib/prisma.js');
    await prisma.failedPayload.deleteMany({ where: { source: 'bot_control' } });
    await prisma.failedPayload.create({ data: { source: 'bot_control', reason: 'bot_paused', payloadJson: '{}' } });
    await sendMessage(chatId, '🛑 البوت اتوقف عن قبول Batch جديد. ابعت /resume لتشغيله.');
    return;
  }

  if (command === '/resume') {
    const { prisma } = await import('../../lib/prisma.js');
    await prisma.failedPayload.deleteMany({ where: { source: 'bot_control' } });
    await sendMessage(chatId, '✅ البوت شغال تاني. أي Batch محفوظ يقدر يكمل تلقائيًا.');
    const job = await loadJob(chatId);
    if (job) await triggerBackground(chatId, job);
    return;
  }

  if (command === '/cancel') {
    const existing = await loadJob(chatId);
    await clearJob(chatId, telegramUpdateId);
    await sendMessage(
      chatId,
      existing
        ? `🗑️ اتلغت حالة Batch ${existing.batchId}. الشحنات التي أُنشئت قبل الإلغاء تظل محفوظة ولن تتكرر بسبب idempotency.`
        : 'ℹ️ مفيش Batch نشط لإلغائه.'
    );
    return;
  }

  if (command === '/status') {
    await statusMessage(chatId);
    return;
  }

  if (command === '/run') {
    await startRun(chatId, parseOrderArgument(fullText), telegramUpdateId);
    return;
  }

  if (command === '/preview') {
    await startPreview(chatId, parseOrderArgument(fullText), telegramUpdateId);
    return;
  }

  if (command === '/users') {
    const users = await getActiveUsers();
    await sendMessage(
      chatId,
      users.length
        ? ['👥 اليوزرز المصرّح ليهم:', ...users.map((user) => `• ${user.name} — ${user.telegram_id} (${user.role})`)].join('\n')
        : 'مفيش يوزرز في الشيت دلوقتي.'
    );
    return;
  }

  if (command === '/refresh') {
    const users = await forceRefresh();
    const active = users.filter((user) => user.active.toLowerCase() === 'true');
    await sendMessage(chatId, `✅ اتحدّث من الشيت\n${active.length} يوزر active`);
  }
}

/** While recovery is held, ONLY a new private allowlisted message may request a
 * Preview. No generic command/callback path or global resume is reachable. */
async function handleOwnerPreviewOnly(update: TelegramUpdate, mode: PreviewOnlyConfig): Promise<LambdaResult> {
  const message = update.message;
  if (!message || message.chat.type !== 'private' || !isFreshOwnerPreviewMessage({ chatId: message.chat.id,
    fromId: message.from?.id, date: message.date, updateId: update.update_id }, mode)) {
    return { statusCode: 200, body: 'ignored-owner-preview-only' };
  }
  const chatId = message.chat.id, text = (message.text ?? '').trim();
  const command = text.split(/\s/)[0]?.split('@')[0] ?? '';
  try {
    if (command === '/preview' || PREVIEW_PHRASES.has(text)) {
      const existing = await loadJob(chatId);
      if (existing) {
        try { assertPreviewCursorInMode(chatId, existing); }
        catch {
          await sendMessage(chatId, '🛑 فيه Batch قديم من إصدار مختلف. لن أستكمله أو أشحنه. لو كان Preview، استخدم /cancel ثم /preview لبدء اختبار جديد.');
          return { statusCode: 200, body: 'old-batch-held' };
        }
      }
      await startPreview(chatId, command === '/preview' ? parseOrderArgument(text) : undefined, update.update_id);
    } else if (command === '/run' && manualRunConfig()) {
      await startRun(chatId, parseOrderArgument(text), update.update_id, message.from?.id, message.date);
    } else if (command === '/status') {
      await statusMessage(chatId);
    } else if (command === '/cancel') {
      const existing = await loadJob(chatId);
      if (existing?.kind === 'run') {
        try { assertProductionRunAllowed({ chatId, cursor: existing }); }
        catch {
          await sendMessage(chatId, '🛑 دي مهمة شحن قديمة وتفضل مقفولة للمراجعة؛ وضع الاختبار لا يغيرها.');
          return { statusCode: 200, body: 'old-run-held' };
        }
      }
      await clearJob(chatId, update.update_id);
      await sendMessage(chatId, '🗑️ اتلغت حالة الـBatch المسموح بها وسجلها محفوظ. أي شحنة سابقة لا تُحذف؛ ابدأ NEW /preview قبل أي Run جديد.');
    } else {
      await sendMessage(chatId, manualRunConfig()
        ? '🧪 تشغيل يدوي للحسابين فقط.\n/preview — NEW ملفات وربط الشحن\n/run — أمر جديد بعد اكتمال نفس Preview فقط\n/status — الحالة\n/cancel — إلغاء Batch مسموح مع حفظ السجل\n🔒 Odoo والمحاسبة والطوابير العامة مقفولة.'
        : '🧪 البوت متاح لحسابك في وضع Preview فقط.\n/preview — ملفات الإنتاج\n/status — الحالة\n/cancel — إلغاء Preview\n🔒 Run والشحن والمحاسبة والطوابير التلقائية مقفولة.');
    }
  } catch (error) {
    if (error instanceof ProductionTelegramUpdateReplayError) return { statusCode: 200, body: 'duplicate-update' };
    // Acknowledge a failed owner request instead of making Telegram burn CPU
    // retrying while Neon is suspended. Never claim that a write didn't happen.
    console.error('[owner-preview] Request stopped safely', { error: error instanceof Error ? error.name : 'unknown' });
    await sendMessage(chatId, manualRunConfig()
      ? '🛑 تعذر إكمال الطلب. قد تكون الموافقة أو حالة الشحن محفوظة بالفعل؛ استخدم /status قبل أي طلب جديد ولا تكرر الشحن. عمال Odoo والمحاسبة والطوابير العامة لم يتم إطلاقهم.'
      : '🛑 تعذر إكمال طلب Preview. الحالة قد تكون محفوظة؛ استخدم /status قبل طلب جديد. لا شحن ولا محاسبة تم تشغيلهم.');
  }
  return { statusCode: 200, body: 'owner-preview-only' };
}

export const handler = async (event: LambdaEvent): Promise<LambdaResult> => {
  const secret = event.headers['x-telegram-bot-api-secret-token'];
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  // Missing configuration is not authorization. Fail before parsing updates,
  // touching Neon, sending a message, or publishing any continuation.
  if (!expectedSecret) return { statusCode: 503, body: 'Telegram webhook is not configured' };
  if (!secret || Buffer.byteLength(secret) !== Buffer.byteLength(expectedSecret)
      || !timingSafeEqual(Buffer.from(secret), Buffer.from(expectedSecret))) {
    return { statusCode: 401, body: 'Unauthorized' };
  }
  if (event.httpMethod !== 'POST' || !event.body) return { statusCode: 200, body: 'ok' };

  let update: TelegramUpdate;
  try {
    update = JSON.parse(event.body) as TelegramUpdate;
  } catch {
    return { statusCode: 200, body: 'ok' };
  }
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) {
    return { statusCode: 400, body: 'Invalid update_id' };
  }

  const previewMode = previewOnlyConfig();
  manualRunConfig(); // Explicit unsafe manual configuration fails before any effect.
  if (previewMode) return await handleOwnerPreviewOnly(update, previewMode);

  const callback = update.callback_query;
  if (callback) {
    await answerCallbackQuery(callback.id, 'الاستكمال بقى تلقائي');
    const chatId = callback.message?.chat.id;
    if (chatId && callback.data?.startsWith('cont:') && await isAllowed(chatId)) {
      const job = await loadJob(chatId);
      if (job) {
        await sendMessage(chatId, `✅ مش محتاج تدوس Continue تاني. Batch ${job.batchId} بيكمل تلقائيًا.`);
        await triggerBackground(chatId, job);
      } else {
        await sendMessage(chatId, 'ℹ️ الـBatch القديم انتهى أو اتلغى.');
      }
    }
    return { statusCode: 200, body: 'ok' };
  }

  const message = update.message;
  if (!message) return { statusCode: 200, body: 'ok' };
  const chatId = message.chat.id;
  const text = (message.text ?? '').trim();
  if (!text) return { statusCode: 200, body: 'ok' };

  try {
    if (text.startsWith('/')) {
      const command = text.split(' ')[0]!.split('@')[0]!;
      await handleCommand(chatId, command, text, update.update_id);
    } else if (!(await isAllowed(chatId))) {
      await sendMessage(chatId, `مش مصرّح ليك.\nChat ID بتاعك: ${chatId}`);
    } else if (RUN_PHRASES.has(text)) {
      await startRun(chatId, undefined, update.update_id);
    } else if (PREVIEW_PHRASES.has(text)) {
      await startPreview(chatId, undefined, update.update_id);
    }
  } catch (error) {
    // Already accepted (or older than /cancel): acknowledge without re-creating
    // a batch, sending another notification, or publishing a continuation.
    if (!(error instanceof ProductionTelegramUpdateReplayError)) throw error;
  }

  return { statusCode: 200, body: 'ok' };
};
