// Vercel function → the production aggregation pipeline (Ayman agent + Telegram +
// shipments). maxDuration 800s covers the heavy run; for very large batches the
// 30-min beta can be enabled. Invoked by the Telegram webhook.
import { handler } from '../dist/netlify/functions/run-production-background.js';

export default async function (req: any, res: any) {
  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
  const r = await handler({ body });
  res.status(r.statusCode).send(r.body);
}
