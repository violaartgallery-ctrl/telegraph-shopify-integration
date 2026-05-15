import { sendMessage } from '../../telegram/telegramApi.js';
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

async function triggerBackground(chatId: number, execute: boolean): Promise<void> {
  const url = `${siteUrl()}/.netlify/functions/run-production-background`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, execute }),
    });
  } catch (err) {
    console.error('[webhook] Failed to trigger background function:', err);
    await sendMessage(chatId, '❌ فيه مشكلة في تشغيل الـ pipeline. حاول تاني.');
  }
}

async function handleCommand(
  chatId: number,
  command: string
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

  if (command === '/run') {
    await sendMessage(chatId, '⏳ جاري تشغيل التجميعة (تنفيذ حقيقي)...');
    await triggerBackground(chatId, true);
    return;
  }

  if (command === '/preview') {
    await sendMessage(chatId, '⏳ جاري تشغيل البريفيو...');
    await triggerBackground(chatId, false);
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
    const command = text.split(' ')[0].split('@')[0];
    await handleCommand(chatId, command);
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
