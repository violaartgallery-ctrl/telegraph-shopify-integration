import { parseProductionResumePayload, verifyResumeRequest } from '../src/services/productionContinuation.js';

export default async (request: Request) => {
  const body = await request.text();
  if (process.env.RECOVERY_LIVE !== '1' || !verifyResumeRequest(Object.fromEntries(request.headers), body)) return;
  const raw = JSON.parse(body);
  const payload = parseProductionResumePayload(raw);
  if (!payload) throw new Error('Invalid production continuation');
  const { resumeProductionInvocation } = await import('../src/netlify/functions/run-production-background.js');
  await resumeProductionInvocation(payload.chatId, payload.batchId, Math.min(30_000, Math.max(0, Number(raw.delayMs) || 0)));
};
export const config = { background: true };
