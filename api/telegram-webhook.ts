// Vercel function → Telegram webhook receiver. Passes body + headers (the secret
// token header is verified inside the handler). NOTE: the handler triggers the
// production pipeline via an internal fetch whose path is Netlify-specific today;
// that path is adapted via env at cutover (RUN_PRODUCTION trigger).
import { handler } from '../dist/netlify/functions/telegram-webhook.js';

export default async function (req: any, res: any) {
  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
  const r = await (handler as any)({ body, headers: req.headers });
  res.status(r.statusCode).send(r.body);
}
