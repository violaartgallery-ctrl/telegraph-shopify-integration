const TELEGRAM_API = 'https://api.telegram.org';

function botUrl(method: string): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  return `${TELEGRAM_API}/bot${token}/${method}`;
}

// A single inline button. Pressing it sends a callback_query update (with
// `data`) to the webhook — used for the "Continue" button on a paused job.
export interface InlineButton {
  text: string;
  callback_data: string;
}

export async function sendMessage(
  chatId: number | string,
  text: string,
  options: {
    parse_mode?: 'Markdown' | 'HTML' | 'MarkdownV2';
    reply_markup?: { inline_keyboard: InlineButton[][] };
  } = {}
): Promise<void> {
  try {
    const response = await fetch(botUrl('sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, ...options }),
    });
    if (!response.ok) {
      const body = await response.text();
      console.error(`[telegram] sendMessage failed: ${response.status} ${body}`);
    }
  } catch (err) {
    console.error('[telegram] sendMessage error:', err);
  }
}

/** Send a message carrying a single inline button (e.g. "Continue"). */
export async function sendMessageWithButton(
  chatId: number | string,
  text: string,
  button: InlineButton,
  options: { parse_mode?: 'Markdown' | 'HTML' | 'MarkdownV2' } = {}
): Promise<void> {
  await sendMessage(chatId, text, { ...options, reply_markup: { inline_keyboard: [[button]] } });
}

/**
 * Acknowledge a callback_query so Telegram stops showing the button's loading
 * spinner. Optionally shows a brief toast to the user.
 */
export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  try {
    const response = await fetch(botUrl('answerCallbackQuery'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, ...(text ? { text } : {}) }),
    });
    if (!response.ok) {
      const body = await response.text();
      console.error(`[telegram] answerCallbackQuery failed: ${response.status} ${body}`);
    }
  } catch (err) {
    console.error('[telegram] answerCallbackQuery error:', err);
  }
}

export async function sendDocument(
  chatId: number | string,
  fileBytes: Buffer,
  filename: string,
  caption?: string
): Promise<void> {
  try {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    // Copy into a plain ArrayBuffer to satisfy strict BlobPart types
    const arrayBuffer = fileBytes.buffer.slice(
      fileBytes.byteOffset,
      fileBytes.byteOffset + fileBytes.byteLength
    ) as ArrayBuffer;
    form.append('document', new Blob([arrayBuffer], { type: 'application/octet-stream' }), filename);
    if (caption) form.append('caption', caption);

    const response = await fetch(botUrl('sendDocument'), {
      method: 'POST',
      body: form,
    });
    if (!response.ok) {
      const body = await response.text();
      console.error(`[telegram] sendDocument failed: ${response.status} ${body}`);
    }
  } catch (err) {
    console.error('[telegram] sendDocument error:', err);
  }
}
