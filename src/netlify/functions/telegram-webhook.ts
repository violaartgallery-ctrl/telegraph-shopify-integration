import { waitUntil } from '@vercel/functions';
import { sendMessage, sendMessageWithButton, answerCallbackQuery } from '../../telegram/telegramApi.js';
import { runPipeline } from './run-production-background.js';
import { loadJob, saveJob, clearJob, JOB_STALE_MS } from '../../services/productionJobStore.js';
import {
  isAllowed,
  getUser,
  getActiveUsers,
  forceRefresh,
} from '../../telegram/sheetsClient.js';

// ── Types ─────────────────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

// /run = create shipments (البوالص). /preview = production documents (التجميعة).
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

function siteUrl(): string {
  return (process.env.URL ?? '').replace(/\/$/, '');
}

async function triggerBackground(
  chatId: number,
  execute: boolean,
  orderId?: string,
  resume = false
): Promise<void> {
  // Vercel has no separate 15-min background function. We ack Telegram fast and
  // let the production pipeline keep running AFTER the HTTP response via
  // waitUntil() (kept alive up to the function maxDuration, 300s). The pipeline
  // checkpoints itself: at a ~4-min soft deadline it saves where it stopped and
  // sends a "Continue" button, so nothing is ever truncated by the hard limit.
  // resume=true continues a previously-paused job from its saved cursor.
  try {
    waitUntil(runPipeline(chatId, execute, orderId, resume));
  } catch (err) {
    console.error('[webhook] Failed to schedule pipeline:', err);
    await sendMessage(chatId, '❌ فيه مشكلة في تشغيل الـ pipeline. حاول تاني.');
  }
}

// Is the bot paused via /stop? (the 'bot_control'/'bot_paused' flag). This is
// what makes /stop actually block /run and /preview.
async function isBotPaused(): Promise<boolean> {
  const { prisma } = await import('../../lib/prisma.js');
  const row = await prisma.failedPayload.findFirst({
    where: { source: 'bot_control', reason: 'bot_paused' },
  });
  return Boolean(row);
}

// Gate a FRESH /run or /preview: refuse if the bot is paused, and never clobber
// an in-progress/paused job (that would lose its shipment ids + progress) —
// offer Continue instead. A stale 'running' job (crashed) is discarded so a new
// run can start. Returns true only when it's safe to start fresh.
async function canStartFresh(chatId: number): Promise<boolean> {
  if (await isBotPaused()) {
    await sendMessage(chatId, '🛑 البوت متوقف (/stop). ابعت /resume الأول عشان تشغّله.');
    return false;
  }
  const existing = await loadJob(chatId);
  if (existing && Date.now() - existing.updatedAt < JOB_STALE_MS) {
    const kind = existing.kind === 'run' ? 'شحن' : 'تجميعة';
    await sendMessageWithButton(
      chatId,
      `⚠️ فيه ${kind} لسه شغّال أو موقوف. دوس إكمال تكمّله، أو ابعت /cancel عشان تلغيه وتبدأ من الأول.`,
      { text: '▶️ إكمال (Continue)', callback_data: `cont:${existing.kind}` }
    );
    return false;
  }
  if (existing) await clearJob(chatId); // stale/dead job → discard, allow fresh
  return true;
}

// Handle the "Continue" button press on a paused job.
async function handleContinue(chatId: number, data: string): Promise<void> {
  if (await isBotPaused()) {
    await sendMessage(chatId, '🛑 البوت متوقف (/stop). ابعت /resume الأول.');
    return;
  }
  const execute = data === 'cont:run';
  const job = await loadJob(chatId);
  if (!job) {
    await sendMessage(chatId, 'ℹ️ مفيش حاجة موقوفة أكمّلها. ابعت /run أو /preview من الأول.');
    return;
  }
  // Guard against double-press while a segment is genuinely still running (a
  // 'running' job older than JOB_STALE_MS is treated as crashed → resumable).
  if (job.status === 'running' && Date.now() - job.updatedAt < JOB_STALE_MS) {
    await sendMessage(chatId, '⏳ لسه بشتغل على الجزء الحالي — استنّى لما أطلب Continue تاني.');
    return;
  }
  // Claim the job (mark running now) BEFORE returning, so a fast second press
  // sees 'running' and is rejected by the guard above — shrinks the race window.
  job.status = 'running';
  await saveJob(chatId, job);
  await sendMessage(chatId, '▶️ بكمّل من مكان الوقوف...');
  await triggerBackground(chatId, execute, undefined, true);
}

async function handleCommand(
  chatId: number,
  command: string,
  fullText: string
): Promise<void> {
  if (command === '/start') {
    const user = await getUser(chatId);
    const allowed = await isAllowed(chatId);
    const greeting = user ? `أهلاً ${user.name}! 👋` : 'أهلاً!';
    const access = allowed
      ? `✅ مصرّح ليك (${user?.role ?? 'user'})`
      : `⛔ مش موجود في قائمة المستخدمين\nChat ID بتاعك: \`${chatId}\``;

    await sendMessage(
      chatId,
      `${greeting}\n\n${access}\n\n` +
        `الأوامر:\n` +
        `• *بريفيو* أو /preview — المستندات (Word + ليزر + صور) للمصنع\n` +
        `• *شحن* أو /run — إنشاء الشحنات (البوالص) + لينك الطباعة\n` +
        `• /cancel — إلغاء أي تجميعة/شحن موقوف والبدء من جديد\n` +
        `• /users — اليوزرز المصرّح ليهم\n` +
        `• /refresh — تحديث قائمة اليوزرز من الشيت\n\n` +
        `لو الشغل كتير، البوت هيوقف قبل حد الوقت ويبعتلك زرار *إكمال* — دوسه يكمّل من نفس المكان.\n\n` +
        `TELEGRAPH\\_ENABLED: \`${isTelegraphEnabled() ? 'true ✅' : 'false ⛔'}\``,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (!(await isAllowed(chatId))) {
    await sendMessage(
      chatId,
      `مش مصرّح ليك.\nChat ID بتاعك: \`${chatId}\`\nاطلب من الـ owner يضيفك في الشيت.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (command === '/stop') {
    const { prisma } = await import('../../lib/prisma.js');
    await prisma.failedPayload.deleteMany({ where: { source: 'bot_control' } });
    await prisma.failedPayload.create({ data: { source: 'bot_control', reason: 'bot_paused', payloadJson: '{}' } });
    await sendMessage(chatId, '🛑 البوت اتوقف — مش هيقبل /run أو /preview.\nابعت /resume عشان تشغله تاني.');
    return;
  }

  if (command === '/resume') {
    const { prisma } = await import('../../lib/prisma.js');
    await prisma.failedPayload.deleteMany({ where: { source: 'bot_control' } });
    await sendMessage(chatId, '✅ البوت شغال تاني — ابعت /run أو /preview.');
    return;
  }

  if (command === '/cancel') {
    await clearJob(chatId);
    await sendMessage(chatId, '🗑️ اتلغت أي تجميعة/شحن موقوف. تقدر تبعت /run أو /preview من الأول.');
    return;
  }

  if (command === '/run') {
    if (!(await canStartFresh(chatId))) return;
    const parts = fullText.trim().split(/\s+/);
    const orderArg = parts[1] ? parts[1].replace(/^#/, '') : undefined;
    const orderLabel = orderArg ? ` (أوردر #${orderArg} فقط)` : '';
    await sendMessage(chatId, `⏳ جاري إنشاء الشحنات (البوالص)${orderLabel}...`);
    await triggerBackground(chatId, true, orderArg);
    return;
  }

  if (command === '/preview') {
    if (!(await canStartFresh(chatId))) return;
    const parts = fullText.trim().split(/\s+/);
    const orderArg = parts[1] ? parts[1].replace(/^#/, '') : undefined;
    const orderLabel = orderArg ? ` (أوردر #${orderArg} فقط)` : '';
    await sendMessage(chatId, `⏳ جاري تجهيز المستندات${orderLabel}...`);
    await triggerBackground(chatId, false, orderArg);
    return;
  }

  if (command === '/users') {
    const users = await getActiveUsers();
    if (!users.length) {
      await sendMessage(chatId, 'مفيش يوزرز في الشيت دلوقتي.');
      return;
    }
    const lines = ['👥 *اليوزرز المصرّح ليهم:*'];
    for (const u of users) {
      lines.push(`• ${u.name} — \`${u.telegram_id}\` (${u.role})`);
    }
    await sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
    return;
  }

  if (command === '/refresh') {
    const users = await forceRefresh();
    const active = users.filter((u) => u.active.toLowerCase() === 'true');
    await sendMessage(chatId, `✅ اتحدّث من الشيت\n${active.length} يوزر active`);
    return;
  }
}

// ── Main handler ───────────────────────────────────────────────────────────────

interface LambdaEvent {
  httpMethod: string;
  headers: Record<string, string | undefined>;
  body: string | null;
}

interface LambdaResult {
  statusCode: number;
  body: string;
}

export const handler = async (event: LambdaEvent): Promise<LambdaResult> => {
  // Validate Telegram webhook secret
  const secret = event.headers['x-telegram-bot-api-secret-token'];
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expectedSecret && secret !== expectedSecret) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  if (event.httpMethod !== 'POST' || !event.body) {
    return { statusCode: 200, body: 'ok' };
  }

  let update: TelegramUpdate;
  try {
    update = JSON.parse(event.body) as TelegramUpdate;
  } catch {
    return { statusCode: 200, body: 'ok' };
  }

  // Inline-button press (the "Continue" button on a paused job).
  const callback = update.callback_query;
  if (callback) {
    await answerCallbackQuery(callback.id); // stop the button's loading spinner
    const cbChatId = callback.message?.chat.id;
    const data = callback.data ?? '';
    if (cbChatId && data.startsWith('cont:')) {
      if (await isAllowed(cbChatId)) {
        await handleContinue(cbChatId, data);
      } else {
        await sendMessage(cbChatId, `مش مصرّح ليك.\nChat ID بتاعك: \`${cbChatId}\``, { parse_mode: 'Markdown' });
      }
    }
    return { statusCode: 200, body: 'ok' };
  }

  const message = update.message;
  if (!message) return { statusCode: 200, body: 'ok' };

  const chatId = message.chat.id;
  const text = (message.text ?? '').trim();

  if (!text) return { statusCode: 200, body: 'ok' };

  if (text.startsWith('/')) {
    const command = text.split(' ')[0]!.split('@')[0]!;
    await handleCommand(chatId, command, text);
  } else {
    if (!(await isAllowed(chatId))) {
      await sendMessage(
        chatId,
        `مش مصرّح ليك.\nChat ID بتاعك: \`${chatId}\``,
        { parse_mode: 'Markdown' }
      );
    } else if (RUN_PHRASES.has(text)) {
      if (await canStartFresh(chatId)) {
        await sendMessage(chatId, '⏳ جاري إنشاء الشحنات (البوالص)...');
        await triggerBackground(chatId, true);
      }
    } else if (PREVIEW_PHRASES.has(text)) {
      if (await canStartFresh(chatId)) {
        await sendMessage(chatId, '⏳ جاري تجهيز المستندات...');
        await triggerBackground(chatId, false);
      }
    }
  }

  return { statusCode: 200, body: 'ok' };
};
