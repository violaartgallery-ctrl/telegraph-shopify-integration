// Vercel Cron → collections-from-reports sync (permanent collection fix).
import { handler } from '../../dist/netlify/functions/sync-collections-from-reports.js';

export default async function (_req: any, res: any) {
  const r = await handler();
  res.status(r.statusCode).send(r.body);
}
