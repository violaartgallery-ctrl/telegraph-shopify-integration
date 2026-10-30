import { signedResumeHeaders } from '../src/services/productionContinuation.js';

export default async () => {
  const origin = new URL(process.env.RECOVERY_PUBLIC_URL ?? '');
  if (origin.protocol !== 'https:' || !origin.hostname.endsWith('.netlify.app')) throw new Error('Invalid recovery origin');
  const interval = 30 * 60_000;
  const body = JSON.stringify({ slot: Math.floor(Date.now() / interval) * interval, mode: process.env.RECOVERY_LIVE === '1' ? 'ops' : 'probe' });
  const response = await fetch(new URL('/.netlify/functions/ops-background', origin), {
    method: 'POST', body, headers: signedResumeHeaders(body), signal: AbortSignal.timeout(20_000),
  });
  if (response.status !== 202) throw new Error(`Recovery ops dispatch HTTP ${response.status}`);
};
export const config = { schedule: '*/30 * * * *' };
