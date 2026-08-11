import assert from 'node:assert/strict';
import {
  PRODUCTION_CONTINUATION_TOPIC,
  parseProductionResumePayload,
  scheduleProductionContinuation,
  setProductionQueuePublisherForTests,
  type ProductionQueuePublishOptions,
  type ProductionResumePayload,
} from '../services/productionContinuation.js';

interface PublishedMessage {
  topic: string;
  payload: ProductionResumePayload;
  options: ProductionQueuePublishOptions;
}

const published: PublishedMessage[] = [];
const originalFetch = globalThis.fetch;

try {
  // A continuation must go through the durable queue. Any accidental HTTP
  // self-call makes this test fail immediately.
  globalThis.fetch = async () => {
    throw new Error('production continuation must not call fetch directly');
  };
  setProductionQueuePublisherForTests(async (topic, payload, options) => {
    published.push({ topic, payload, options });
    return { messageId: `test-${published.length}` };
  });

  const first = {
    chatId: 6776051391,
    batchId: '20260811T081726Z-095f3df6',
    delayMs: 2_001,
    dispatchKey: '1786436810000',
  };
  await scheduleProductionContinuation(first);
  await scheduleProductionContinuation(first);
  await scheduleProductionContinuation({ ...first, dispatchKey: '1786436811000' });

  assert.equal(published.length, 3);
  assert.ok(published.every((item) => item.topic === PRODUCTION_CONTINUATION_TOPIC));
  assert.deepEqual(published[0]!.payload, {
    chatId: first.chatId,
    batchId: first.batchId,
  });
  assert.equal(published[0]!.options.delaySeconds, 3);
  assert.equal(published[0]!.options.retentionSeconds, 24 * 60 * 60);
  assert.equal(
    published[0]!.options.idempotencyKey,
    published[1]!.options.idempotencyKey,
    'the same durable cursor state must deduplicate duplicate dispatches'
  );
  assert.notEqual(
    published[0]!.options.idempotencyKey,
    published[2]!.options.idempotencyKey,
    'new cursor progress must be allowed to enqueue the next continuation'
  );
  assert.ok(
    published[0]!.options.idempotencyKey.length <= 80,
    'queue idempotency keys must stay bounded even if a source identifier is long'
  );

  const retryKeys: string[] = [];
  let retryAttempts = 0;
  setProductionQueuePublisherForTests(async (_topic, _payload, options) => {
    retryAttempts += 1;
    retryKeys.push(options.idempotencyKey);
    if (retryAttempts < 3) throw new Error('simulated transient queue outage');
    return { messageId: 'retry-success' };
  });
  await scheduleProductionContinuation({
    chatId: first.chatId,
    batchId: first.batchId,
    dispatchKey: 'same-progress-during-retry',
  });
  assert.equal(retryAttempts, 3, 'transient queue publishing must retry three times');
  assert.equal(new Set(retryKeys).size, 1, 'all publish retries must use the same idempotency key');

  assert.deepEqual(
    parseProductionResumePayload({ chatId: first.chatId, batchId: first.batchId }),
    { chatId: first.chatId, batchId: first.batchId }
  );
  assert.equal(parseProductionResumePayload({ chatId: 'not-a-number', batchId: first.batchId }), null);
  assert.equal(parseProductionResumePayload({ chatId: first.chatId, batchId: '' }), null);

  console.log(JSON.stringify({
    ok: true,
    transport: 'durable-queue',
    selfHttpCalls: 0,
    duplicateDispatchKeyStable: true,
    newProgressDispatches: true,
    transientPublishRetries: retryAttempts,
  }));
} finally {
  setProductionQueuePublisherForTests(undefined);
  globalThis.fetch = originalFetch;
}
