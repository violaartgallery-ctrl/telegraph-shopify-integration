import 'dotenv/config';
import assert from 'node:assert/strict';
import { basePrisma } from '../lib/prisma.js';
import {
  checkpointJob,
  claimJob,
  clearJob,
  completeRun,
  createPreviewJob,
  finishPreview,
  loadJob,
  queueRun,
  type PreviewCursor,
  type RunCursor,
  yieldJob,
} from '../services/productionJobStore.js';

// Reserved negative id: this never collides with a real Telegram chat in this app.
const chatId = -8_000_000_000_000_000;
let batchId = '';

try {
  await clearJob(chatId);

  const creates = await Promise.all(
    Array.from({ length: 8 }, () => createPreviewJob(chatId, {
      recipientChatIds: [chatId, 6776051391],
    }))
  );
  assert.equal(creates.filter((result) => result.created).length, 1, 'only one concurrent create may win');
  const preview = creates[0]!.job as PreviewCursor;
  batchId = preview.batchId;

  const claimed = await claimJob(chatId, batchId) as PreviewCursor | null;
  assert.ok(claimed?.executionToken, 'preview lease must be claimed');

  const queuedRun = await queueRun(chatId, { recipientChatIds: [chatId] });
  assert.equal(queuedRun.action, 'queued_after_preview');

  // Simulate the running invocation holding an older pendingRun=false copy.
  claimed.pendingRun = false;
  claimed.orderNumbers = ['#TEST-1', '#TEST-2'];
  claimed.sentArtifactKeys.push(`${chatId}|word:test`);
  const checkpointed = await checkpointJob(chatId, claimed, claimed.executionToken!);
  assert.equal(checkpointed.pendingRun, true, 'checkpoint must preserve concurrent /run');

  const transitioned = await finishPreview(
    chatId,
    checkpointed as PreviewCursor,
    claimed.executionToken!
  );
  assert.equal(transitioned.kind, 'run');
  assert.deepEqual(transitioned.orderNumbers, ['#TEST-1', '#TEST-2']);

  const claims = await Promise.all(
    Array.from({ length: 8 }, () => claimJob(chatId, batchId))
  );
  const winners = claims.filter(Boolean) as RunCursor[];
  assert.equal(winners.length, 1, 'only one concurrent continuation may own the lease');

  const run = winners[0]!;
  run.processedOrderNames.push('#TEST-1');
  run.results.push({ orderName: '#TEST-1', ok: true, category: 'shipped' });
  await checkpointJob(chatId, run, run.executionToken!);
  const yielded = await yieldJob(chatId, run, run.executionToken!, 'forced soft deadline');
  assert.equal(yielded.status, 'retrying');

  const resumed = await claimJob(chatId, batchId) as RunCursor | null;
  assert.ok(resumed?.executionToken);
  assert.deepEqual(resumed.processedOrderNames, ['#TEST-1']);
  resumed.processedOrderNames.push('#TEST-2');
  resumed.results.push({ orderName: '#TEST-2', ok: false, category: 'needs_review', reason: 'test' });
  await completeRun(chatId, resumed, resumed.executionToken!);
  assert.equal(await loadJob(chatId), null, 'completed run must leave no active job');

  const history = await basePrisma.failedPayload.findMany({
    where: { source: 'prod_job_history', reason: batchId, externalId: String(chatId) },
  });
  assert.equal(history.length, 1, 'completion history must be durable');
  console.log(JSON.stringify({ ok: true, batchId, checks: 9 }));
} finally {
  await clearJob(chatId);
  if (batchId) {
    await basePrisma.failedPayload.deleteMany({
      where: { source: 'prod_job_history', reason: batchId, externalId: String(chatId) },
    });
  }
  await basePrisma.$disconnect();
}
