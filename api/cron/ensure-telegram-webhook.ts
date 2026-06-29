// Vercel Cron → keeps the Telegram webhook registered. NOTE: on Vercel this must
// point the webhook at the Vercel URL + /api/telegram-webhook (handled via env at
// cutover) — until then it stays aligned with whatever TELEGRAM_WEBHOOK_URL says.
import { handler } from '../../dist/netlify/functions/ensure-telegram-webhook.js';

export default async function (_req: any, res: any) {
  const r = await handler();
  res.status(r.statusCode).send(r.body);
}
