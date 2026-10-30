import { verifyResumeRequest } from '../src/services/productionContinuation.js';
import { createPersistentOpsScheduler, type OpsLane } from '../src/services/opsScheduler.js';
import { getStore } from '@netlify/blobs';

export default async (request: Request, context: {deploy:{id:string}}) => {
  const body = await request.text();
  if (!verifyResumeRequest(Object.fromEntries(request.headers), body)) return;
  const probe = JSON.parse(body).mode === 'probe';
  const previous = await getStore('hosting-recovery-readiness').get('latest',{type:'json'}) as {deployId?:string}|null;
  if (probe || previous?.deployId !== context.deploy.id) {
    const readiness = (await import('./recovery-readiness.mjs')).default;
    await readiness.deploySucceeded({ deploy: { id: context.deploy.id, context: 'production' } });
  }
  if (probe) return;
  if (process.env.RECOVERY_LIVE !== '1') return;
  const interval = 30 * 60_000;
  const slot = Number(JSON.parse(body).slot);
  if (!Number.isSafeInteger(slot) || slot % interval || Math.abs(Date.now() - slot) > interval * 2) throw new Error('Invalid recovery ops slot');
  // Native published Netlify cron is the durable next wake. Neon leases and
  // completed slots remain the single shared source of idempotency.
  const scheduler = createPersistentOpsScheduler({
    enabled: () => process.env.RECOVERY_LIVE === '1',
    intervals: { status: interval, discovery: interval, financial: interval },
    publish: async () => ({ nativeSchedule: 'recovery-watchdog' }),
  });
  const failed: string[] = [];
  for (const lane of ['status', 'discovery', 'financial'] as OpsLane[]) {
    try { await scheduler.tick({ version: 1, lane, slot }); }
    catch { failed.push(lane); }
  }
  if (failed.length) throw new Error(`Recovery ops lanes failed: ${failed.join(',')}`);
};
export const config = { background: true };
