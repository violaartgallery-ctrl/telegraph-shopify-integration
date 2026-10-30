import { createServer } from 'node:http';
import { InProcessRecoveryQueue } from './services/inProcessRecoveryQueue.js';

// Explicitly opt in. Merely starting this host never drains a financial queue.
const live = process.env.RECOVERY_LIVE === '1';
const port = Number(process.env.RECOVERY_PORT ?? 4171);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid recovery port');
delete process.env.VERCEL;
delete process.env.VERCEL_ENV;
process.env.OPS_SCHEDULER_ENABLED = 'false';
process.env.AYMAN_AGENT_URL = process.env.RECOVERY_AGENT_URL ?? 'http://127.0.0.1:4173';

const { createApp } = await import('./app.js');
const { createPersistentOpsScheduler } = await import('./services/opsScheduler.js');
const { setProductionQueuePublisher } = await import('./services/productionContinuation.js');
const { resumeProductionInvocation } = await import('./netlify/functions/run-production-background.js');
const { listRecoverableJobs } = await import('./services/productionJobStore.js');
const { prisma } = await import('./lib/prisma.js');
const report = (error: unknown) => console.error('[recovery-worker]', error instanceof Error ? error.message : 'Worker failed');

const production = new InProcessRecoveryQueue<{ chatId: number; batchId: string }>(
  async ({ chatId, batchId }) => { await resumeProductionInvocation(chatId, batchId, 0); }, report,
);
setProductionQueuePublisher(async (_topic, payload, options) => {
  if (!live) throw new Error('Recovery host is in diagnostic-only mode');
  production.enqueue(options.idempotencyKey, payload, options.delaySeconds * 1000);
  return { messageId: options.idempotencyKey };
});

let scheduler: ReturnType<typeof createPersistentOpsScheduler>;
const ops = new InProcessRecoveryQueue<Parameters<typeof scheduler.tick>[0]>(async tick => { await scheduler.tick(tick); }, report, 100);
scheduler = createPersistentOpsScheduler({
  enabled: () => live,
  publish: async (tick, options) => {
    ops.enqueue(options.idempotencyKey, tick, options.delaySeconds * 1000);
    return { messageId: options.idempotencyKey };
  },
});

const { app } = createApp();
const server = createServer((req, res) => {
  if (!live && req.url !== '/health' && req.url !== '/recovery-health') {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, mode: 'diagnostic-only' }));
    return;
  }
  if (req.url === '/recovery-health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, live, service: 'viola-telegraph-integration', productionWakeups: production.size, opsWakeups: ops.size }));
    return;
  }
  app(req, res);
});

let recovering = false;
async function recover(): Promise<void> {
  if (!live || recovering) return;
  recovering = true;
  try {
    await scheduler.ensure();
    const paused = await prisma.failedPayload.findFirst({ where: { source: 'bot_control', reason: 'bot_paused' } });
    if (paused) return;
    for (const { chatId, job } of await listRecoverableJobs()) {
      production.enqueue(`${chatId}:${job.batchId}:${job.updatedAt}`, { chatId, batchId: job.batchId });
    }
  } catch (error) { report(error); }
  finally { recovering = false; }
}
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ ok: true, service: 'viola-telegraph-integration', port, live })));
const watchdog = setInterval(() => { void recover(); }, 60_000);
void recover();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  clearInterval(watchdog); production.close(); ops.close(); server.close(() => { void prisma.$disconnect().finally(() => process.exit(0)); });
});
