const WEBHOOK_PATH = '/telegram-webhook';

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface WebhookInfo {
  url?: string;
  pending_update_count?: number;
  last_error_message?: string;
}

interface LambdaResult {
  statusCode: number;
  body: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function productionSiteUrl(): string {
  const configured = process.env.TELEGRAM_WEBHOOK_URL?.trim();
  if (configured) return configured.replace(/\/$/, '');

  const siteUrl = process.env.URL?.trim();
  if (!siteUrl) throw new Error('URL is not set');
  return `${siteUrl.replace(/\/$/, '')}${WEBHOOK_PATH}`;
}

async function telegramApi<T>(
  token: string,
  method: string,
  payload?: Record<string, unknown>
): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  const data = (await response.json()) as TelegramApiResponse<T>;
  if (!response.ok || !data.ok || data.result === undefined) {
    throw new Error(data.description ?? `Telegram ${method} failed`);
  }
  return data.result;
}

export const handler = async (): Promise<LambdaResult> => {
  try {
    const token = requiredEnv('TELEGRAM_BOT_TOKEN');
    const secret = requiredEnv('TELEGRAM_WEBHOOK_SECRET');
    const webhookUrl = productionSiteUrl();

    const before = await telegramApi<WebhookInfo>(token, 'getWebhookInfo');
    const shouldReset =
      before.url !== webhookUrl ||
      (before.last_error_message ?? '').toLowerCase().includes('unauthorized');

    if (shouldReset) {
      await telegramApi(token, 'setWebhook', {
        url: webhookUrl,
        secret_token: secret,
        allowed_updates: ['message'],
        drop_pending_updates: false,
      });
    }

    const after = await telegramApi<WebhookInfo>(token, 'getWebhookInfo');
    console.log(
      JSON.stringify({
        ok: true,
        action: shouldReset ? 'restored' : 'unchanged',
        urlOk: after.url === webhookUrl,
        pending: after.pending_update_count ?? 0,
        lastError: after.last_error_message ?? '',
      })
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        action: shouldReset ? 'restored' : 'unchanged',
        urlOk: after.url === webhookUrl,
        pending: after.pending_update_count ?? 0,
        lastError: after.last_error_message ?? '',
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ensure-telegram-webhook] failed:', message);
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: message }),
    };
  }
};
