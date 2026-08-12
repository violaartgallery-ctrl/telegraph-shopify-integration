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
  loadPreviewSourceSnapshot,
  markNeedsReview,
  queueRun,
  requeueNeedsReviewJob,
  retryJob,
  savePreviewSourceSnapshot,
  type PreviewCursor,
  type RunCursor,
  yieldJob,
} from '../services/productionJobStore.js';

// Reserved negative id: this never collides with a real Telegram chat in this app.
const chatId = -8_000_000_000_000_000;
const retryChatId = -8_000_000_000_000_001;
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
  await savePreviewSourceSnapshot(chatId, batchId, claimed.executionToken!, {
    wordBase64: Buffer.from('snapshot').toString('base64'),
    productionEntries: [],
    ordersDetail: [
      {
        order_name: '#TEST-1',
        customer: 'Test',
        created_at: '2026-07-25T00:00:00Z',
        items: [],
      },
    ],
    warnings: [],
  });
  assert.equal(
    (await loadPreviewSourceSnapshot(batchId))?.ordersDetail[0]?.order_name,
    '#TEST-1',
    'preview source snapshot must be durable'
  );

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
  assert.equal(
    await loadPreviewSourceSnapshot(batchId),
    null,
    'finished preview must remove its temporary source snapshot'
  );

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

  // A state-only checkpoint at the beginning of a resumed invocation must not
  // erase consecutive failures. Only real forward progress resets the counter.
  await clearJob(retryChatId);
  const retryPreview = (await createPreviewJob(retryChatId, {
    recipientChatIds: [retryChatId],
  })).job as PreviewCursor;
  const retryClaim1 = await claimJob(retryChatId, retryPreview.batchId) as PreviewCursor;
  await checkpointJob(retryChatId, retryClaim1, retryClaim1.executionToken!, { resetAttempts: false });
  const retry1 = await retryJob(retryChatId, retryClaim1, retryClaim1.executionToken!, 'temporary-1');
  assert.equal(retry1.attemptCount, 1);

  const retryClaim2 = await claimJob(retryChatId, retryPreview.batchId) as PreviewCursor;
  await checkpointJob(retryChatId, retryClaim2, retryClaim2.executionToken!, { resetAttempts: false });
  const retry2 = await retryJob(retryChatId, retryClaim2, retryClaim2.executionToken!, 'temporary-2');
  assert.equal(retry2.attemptCount, 2, 'a repeated error without progress must increment');

  const retryClaim3 = await claimJob(retryChatId, retryPreview.batchId) as PreviewCursor;
  retryClaim3.sentArtifactKeys.push(`${retryChatId}|word:test-progress`);
  const progressed = await checkpointJob(retryChatId, retryClaim3, retryClaim3.executionToken!);
  assert.equal(progressed.attemptCount, 0, 'confirmed external progress resets consecutive failures');

  await markNeedsReview(
    retryChatId,
    progressed,
    retryClaim3.executionToken!,
    'permanent missing photo'
  );
  assert.equal((await loadJob(retryChatId))?.status, 'needs_review');
  const requeued = await requeueNeedsReviewJob(retryChatId, retryPreview.batchId);
  assert.equal(requeued.status, 'retrying');
  assert.equal(requeued.attemptCount, 0);
  assert.equal(requeued.executionToken, undefined);

  console.log(JSON.stringify({ ok: true, batchId, checks: 18, retryCounterPersists: true }));
} finally {
  await clearJob(chatId);
  await clearJob(retryChatId);
  if (batchId) {
    await basePrisma.failedPayload.deleteMany({
      where: { source: 'prod_job_history', reason: batchId, externalId: String(chatId) },
    });
  }
  await basePrisma.$disconnect();
}
