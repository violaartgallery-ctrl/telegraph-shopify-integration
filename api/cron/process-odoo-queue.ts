// Vercel Cron → drains the whole Odoo queue. maxDuration 800s (13min) covers the
// drainer's budget, so no separate trigger/background split is needed on Vercel.
import { handler } from '../../dist/netlify/functions/process-odoo-queue-background.js';

export default async function (_req: any, res: any) {
  const r = await handler();
  res.status(r.statusCode).send(r.body);
}
