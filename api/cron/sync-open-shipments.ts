// Vercel Cron → reuses the exact Netlify handler logic (status sync). Cron runs
// only on PRODUCTION deployments, so previews never double-process with Netlify.
import { handler } from '../../dist/netlify/functions/sync-open-shipments.js';

export default async function (_req: any, res: any) {
  const r = await handler();
  res.status(r.statusCode).send(r.body);
}
