import assert from 'node:assert/strict';
import { createPreviewCursor } from '../services/productionJobStore.js';
import { sendCompleteProductionPreview } from '../services/productionPreviewService.js';
import { signedResumeHeaders, verifyResumeRequest } from '../services/productionContinuation.js';

const originalFetch = globalThis.fetch;
const originalToken = process.env.TELEGRAM_BOT_TOKEN;
const originalAgent = process.env.AYMAN_AGENT_URL;
const originalResumeSecret = process.env.PRODUCTION_RESUME_SECRET;

const telegramMessages: string[] = [];
let telegramDocuments = 0;
let agentCalls = 0;

const agentPayload = {
  wordBase64: Buffer.from('test-word-document').toString('base64'),
  summary: { totalOrders: 2, productionEntries: 0, skippedItems: 0, warnings: 0 },
  warnings: [],
  productionEntries: [],
  ordersDetail: [
    { order_name: '#TEST-1', customer: 'أحمد', created_at: '2026-07-19T10:00:00Z', items: [] },
    { order_name: '#TEST-2', customer: 'أيمن', created_at: '2026-07-19T10:01:00Z', items: [] },
  ],
};

try {
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.AYMAN_AGENT_URL = 'https://agent.test';
  process.env.PRODUCTION_RESUME_SECRET = 'test-resume-secret-with-enough-entropy';

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://agent.test/api/production') {
      agentCalls += 1;
      return new Response(JSON.stringify(agentPayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/sendMessage')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { text?: string };
      telegramMessages.push(body.text ?? '');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.includes('/sendDocument')) {
      telegramDocuments += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`Unexpected test fetch: ${url}`);
  };

  const cursor = createPreviewCursor({
    recipientChatIds: ['100', '200'],
  });
  let checkpoints = 0;
  const run = async () => await sendCompleteProductionPreview({
    chatId: 100,
    cursor,
    deadline: Date.now() + 120_000,
    checkpoint: async () => { checkpoints += 1; },
  });

  await run();
  assert.deepEqual(cursor.orderNumbers, ['#TEST-1', '#TEST-2']);
  assert.equal(telegramDocuments, 4, 'Word + orders-summary must reach both recipients');
  assert.equal(cursor.sentArtifactKeys.length, 6, 'two documents + summary x two recipients');
  const firstCheckpointCount = checkpoints;

  await run();
  assert.equal(telegramDocuments, 4, 'a resumed preview must not resend confirmed documents');
  assert.equal(cursor.sentArtifactKeys.length, 6, 'confirmed artifact keys must stay unique');
  assert.equal(checkpoints, firstCheckpointCount + 1, 'second run only checkpoints the verified source snapshot');
  assert.equal(agentCalls, 2, 'each invocation revalidates the exact order snapshot');
  assert.ok(telegramMessages.some((message) => /[\u0600-\u06ff]/.test(message)), 'Arabic Telegram text must remain UTF-8');
  assert.ok(telegramMessages.every((message) => !message.includes('???') && !message.includes('\uFFFD')));

  const body = JSON.stringify({ chatId: 100, batchId: cursor.batchId, delayMs: 0 });
  const headers = signedResumeHeaders(body, 1_000_000);
  assert.equal(verifyResumeRequest(headers, body, 1_000_100), true);
  assert.equal(verifyResumeRequest(headers, `${body} `, 1_000_100), false);
  assert.equal(verifyResumeRequest(headers, body, 1_000_000 + 6 * 60_000), false);

  console.log(JSON.stringify({
    ok: true,
    orders: cursor.orderNumbers.length,
    confirmedArtifacts: cursor.sentArtifactKeys.length,
    telegramDocuments,
    utf8Arabic: true,
    signedContinuation: true,
  }));
} finally {
  globalThis.fetch = originalFetch;
  process.env.TELEGRAM_BOT_TOKEN = originalToken;
  process.env.AYMAN_AGENT_URL = originalAgent;
  process.env.PRODUCTION_RESUME_SECRET = originalResumeSecret;
}
