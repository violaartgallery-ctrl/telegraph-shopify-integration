const TELEGRAM_API = 'https://api.telegram.org';

const TELEGRAM_MAX_ATTEMPTS = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
): Promise<boolean> {
  return await telegramRequest('sendMessage', () => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, ...options }),
  }));
}

/** Send a message carrying a single inline button (e.g. "Continue"). */
export async function sendMessageWithButton(
  chatId: number | string,
  text: string,
  button: InlineButton,
  options: { parse_mode?: 'Markdown' | 'HTML' | 'MarkdownV2' } = {}
): Promise<boolean> {
  return await sendMessage(chatId, text, { ...options, reply_markup: { inline_keyboard: [[button]] } });
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
): Promise<boolean> {
  return await telegramRequest('sendDocument', () => {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    // Copy into a plain ArrayBuffer to satisfy strict BlobPart types
    const arrayBuffer = fileBytes.buffer.slice(
      fileBytes.byteOffset,
      fileBytes.byteOffset + fileBytes.byteLength
    ) as ArrayBuffer;
    form.append('document', new Blob([arrayBuffer], { type: 'application/octet-stream' }), filename);
    if (caption) form.append('caption', caption);

    return {
      method: 'POST',
      body: form,
    };
  });
}

/**
 * Telegram occasionally returns 429 while a large photo batch is being sent,
 * and may transiently return 5xx. Honour retry_after and retry those responses;
 * callers receive true only after Telegram confirms the send.
 */
async function telegramRequest(method: string, buildRequest: () => RequestInit): Promise<boolean> {
  let lastFailure = 'unknown error';
  for (let attempt = 0; attempt < TELEGRAM_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(botUrl(method), {
        ...buildRequest(),
        signal: AbortSignal.timeout(120_000),
      });
      const body = await response.text();
      if (response.ok) return true;

      lastFailure = `${response.status} ${body.slice(0, 500)}`;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === TELEGRAM_MAX_ATTEMPTS - 1) break;

      let retryAfterSeconds = 0;
      try {
        const parsed = JSON.parse(body) as { parameters?: { retry_after?: number } };
        retryAfterSeconds = Number(parsed.parameters?.retry_after ?? 0);
      } catch {
        // Non-JSON 5xx response: use the normal exponential delay below.
      }
      const delayMs = Math.min(
        30_000,
        retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 1000 * (2 ** attempt)
      );
      await sleep(delayMs);
    } catch (err) {
      lastFailure = String(err);
      if (attempt === TELEGRAM_MAX_ATTEMPTS - 1) break;
      await sleep(Math.min(8000, 1000 * (2 ** attempt)));
    }
  }

  console.error(`[telegram] ${method} failed after retries: ${lastFailure}`);
  return false;
}
