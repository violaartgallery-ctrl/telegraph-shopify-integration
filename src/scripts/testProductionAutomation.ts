import assert from 'node:assert/strict';
import {
  productionSourceFingerprint,
  type ProductionAgentResponse,
} from '../services/productionAgentClient.js';
import { createPreviewCursor } from '../services/productionJobStore.js';
import { sendCompleteProductionPreview } from '../services/productionPreviewService.js';
import { signedResumeHeaders, verifyResumeRequest } from '../services/productionContinuation.js';
import { SoftDeadlineError } from '../services/productionPipelineErrors.js';
import { printPhotoSourceUrl } from '../services/printSheet.js';

const originalFetch = globalThis.fetch;
const originalToken = process.env.TELEGRAM_BOT_TOKEN;
const originalAgent = process.env.AYMAN_AGENT_URL;
const originalResumeSecret = process.env.PRODUCTION_RESUME_SECRET;

const telegramMessages: string[] = [];
let telegramDocuments = 0;
let agentCalls = 0;
let savedSnapshot: ProductionAgentResponse | null = null;
const photoFetchCounts = new Map<string, number>();

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
    if (url.startsWith('https://photos.test/')) {
      photoFetchCounts.set(url, (photoFetchCounts.get(url) ?? 0) + 1);
      return new Response(Buffer.from(`photo:${url}`), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      });
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
    sourceSnapshot: {
      load: async () => savedSnapshot
        ? JSON.parse(JSON.stringify(savedSnapshot)) as ProductionAgentResponse
        : null,
      save: async (data) => {
        savedSnapshot = JSON.parse(JSON.stringify(data)) as ProductionAgentResponse;
      },
    },
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
  assert.equal(agentCalls, 1, 'continuations must reuse the immutable source snapshot');
  assert.ok(telegramMessages.some((message) => /[\u0600-\u06ff]/.test(message)), 'Arabic Telegram text must remain UTF-8');
  assert.ok(telegramMessages.every((message) => !message.includes('???') && !message.includes('\uFFFD')));

  // Large-batch resume simulation: 100 orders and 36 photos, split into short
  // invocations. Completed expensive stages must not be rebuilt and each photo
  // must be downloaded/sent exactly once per recipient across every resume.
  const largePayload: ProductionAgentResponse = {
    wordBase64: Buffer.from('large-word-document').toString('base64'),
    summary: { totalOrders: 100, productionEntries: 36, skippedItems: 0, warnings: 0 },
    warnings: [],
    ordersDetail: Array.from({ length: 100 }, (_, index) => ({
      order_name: `#LARGE-${index + 1}`,
      customer: `Customer ${index + 1}`,
      created_at: '2026-08-11T00:00:00Z',
      items: [],
    })),
    productionEntries: Array.from({ length: 36 }, (_, index) => ({
      display_product: 'Photo keychain',
      total_quantity: 1,
      customization_cleaned: [],
      photo_attachments: [{
        attachment_name: `photo-${index + 1}.jpg`,
        attachment_url: `https://photos.test/${index + 1}.jpg`,
        order_name: `#LARGE-${index + 1}`,
        comment_id: `comment-${index + 1}`,
      }],
    })),
  };
  const largeCursor = createPreviewCursor({ recipientChatIds: ['100', '200'] });
  largeCursor.orderNumbers = largePayload.ordersDetail.map((order) => order.order_name);
  largeCursor.sourceFingerprint = productionSourceFingerprint(largePayload);
  largeCursor.artifactManifest = {
    laserFileCount: 0,
    boxFileCount: 0,
    uniquePhotoCount: 36,
  };
  for (const recipient of largeCursor.recipientChatIds) {
    largeCursor.sentArtifactKeys.push(`${recipient}|word:${largeCursor.sourceFingerprint}`);
    largeCursor.sentArtifactKeys.push(`${recipient}|print-sheet:${largeCursor.sourceFingerprint}`);
  }

  const documentsBeforeLarge = telegramDocuments;
  let largeInvocations = 0;
  let largeCheckpoints = 0;
  while (true) {
    largeInvocations += 1;
    assert.ok(largeInvocations < 10, 'large preview must converge in bounded resumptions');
    try {
      await sendCompleteProductionPreview({
        chatId: 100,
        cursor: largeCursor,
        deadline: Date.now() + 120_000,
        maxPhotosPerInvocation: 7,
        checkpoint: async () => { largeCheckpoints += 1; },
        sourceSnapshot: {
          load: async () => JSON.parse(JSON.stringify(largePayload)) as ProductionAgentResponse,
          save: async () => { throw new Error('an existing immutable snapshot must not be replaced'); },
        },
      });
      break;
    } catch (error) {
      if (!(error instanceof SoftDeadlineError)) throw error;
    }
  }

  assert.equal(largeInvocations, 6, '36 photos at 7 per invocation must use six bounded segments');
  assert.equal(largeCursor.sentPhotoKeys.length, 72, '36 photos must reach both recipients once');
  assert.equal(photoFetchCounts.size, 36);
  assert.ok([...photoFetchCounts.values()].every((count) => count === 1), 'completed photos must never be downloaded again');
  assert.equal(
    telegramDocuments - documentsBeforeLarge,
    74,
    'only 72 individual photo sends plus two order-summary documents are new'
  );
  assert.equal(largeCursor.sentArtifactKeys.length, 8, 'pre-sent Word/PDF plus final summary artifacts remain idempotent');

  const body = JSON.stringify({ chatId: 100, batchId: cursor.batchId, delayMs: 0 });
  const headers = signedResumeHeaders(body, 1_000_000);
  assert.equal(verifyResumeRequest(headers, body, 1_000_100), true);
  assert.equal(verifyResumeRequest(headers, `${body} `, 1_000_100), false);
  assert.equal(verifyResumeRequest(headers, body, 1_000_000 + 6 * 60_000), false);

  const resized = printPhotoSourceUrl('https://cdn.shopify.com/s/files/photo.jpg?v=1');
  assert.equal(new URL(resized).searchParams.get('width'), '2400');
  assert.equal(
    printPhotoSourceUrl('https://example.com/photo.jpg'),
    'https://example.com/photo.jpg',
    'non-Shopify URLs must not be rewritten'
  );

  console.log(JSON.stringify({
    ok: true,
    orders: cursor.orderNumbers.length,
    confirmedArtifacts: cursor.sentArtifactKeys.length,
    telegramDocuments,
    utf8Arabic: true,
    signedContinuation: true,
    largeBatchOrders: largeCursor.orderNumbers.length,
    largeBatchPhotos: photoFetchCounts.size,
    largeBatchInvocations: largeInvocations,
    largeBatchCheckpoints: largeCheckpoints,
  }));
} finally {
  globalThis.fetch = originalFetch;
  process.env.TELEGRAM_BOT_TOKEN = originalToken;
  process.env.AYMAN_AGENT_URL = originalAgent;
  process.env.PRODUCTION_RESUME_SECRET = originalResumeSecret;
}
