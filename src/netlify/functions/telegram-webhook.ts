import { waitUntil } from '@vercel/functions';
import { sendMessage } from '../../telegram/telegramApi.js';
import { runPipeline } from './run-production-background.js';
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

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const RUN_PHRASES = new Set([
  'اعمل التجميعة',
  'اعمل التجميعه',
  'اعمل',
  'ابدأ',
  'شغل',
]);

const PREVIEW_PHRASES = new Set(['بريفيو', 'preview', 'بريفو']);

function isTelegraphEnabled(): boolean {
  return process.env.TELEGRAPH_ENABLED?.trim().toLowerCase() === 'true';
}

function siteUrl(): string {
  return (process.env.URL ?? '').replace(/\/$/, '');
}

async function triggerBackground(chatId: number, execute: boolean, orderId?: string): Promise<void> {
  // Vercel has no separate 15-min background function. We ack Telegram fast and
  // let the production pipeline keep running AFTER the HTTP response via
  // waitUntil() (kept alive up to the function maxDuration, 300s). runPipeline is
  // idempotent (shipment creation skips orders that already have a shipment), so
  // if a large /run is cut at the time limit, re-sending /run safely continues.
  try {
    waitUntil(runPipeline(chatId, execute, orderId));
  } catch (err) {
    console.error('[webhook] Failed to schedule pipeline:', err);
    await sendMessage(chatId, '❌ فيه مشكلة في تشغيل الـ pipeline. حاول تاني.');
  }
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
        `• *اعمل التجميعة* أو /run — تجميعة + شحن كامل\n` +
        `• *بريفيو* أو /preview — تجميعة بدون شحن حقيقي\n` +
        `• /users — اليوزرز المصرّح ليهم\n` +
        `• /refresh — تحديث قائمة اليوزرز من الشيت\n\n` +
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

  if (command === '/run') {
    const parts = fullText.trim().split(/\s+/);
    const orderArg = parts[1] ? parts[1].replace(/^#/, '') : undefined;
    const orderLabel = orderArg ? ` (أوردر #${orderArg} فقط)` : '';
    await sendMessage(chatId, `⏳ جاري تشغيل التجميعة (تنفيذ حقيقي)${orderLabel}...`);
    await triggerBackground(chatId, true, orderArg);
    return;
  }

  if (command === '/preview') {
    const parts = fullText.trim().split(/\s+/);
    const orderArg = parts[1] ? parts[1].replace(/^#/, '') : undefined;
    const orderLabel = orderArg ? ` (أوردر #${orderArg} فقط)` : '';
    await sendMessage(chatId, `⏳ جاري تشغيل البريفيو${orderLabel}...`);
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
      await sendMessage(chatId, '⏳ جاري تشغيل التجميعة (تنفيذ حقيقي)...');
      await triggerBackground(chatId, true);
    } else if (PREVIEW_PHRASES.has(text)) {
      await sendMessage(chatId, '⏳ جاري تشغيل البريفيو...');
      await triggerBackground(chatId, false);
    }
  }

  return { statusCode: 200, body: 'ok' };
};
