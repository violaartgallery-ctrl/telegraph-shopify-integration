// Run: node --experimental-vm-modules src/scripts/testReadinessCancellation.mjs
// Actual scoped source runs only in a VM with synthetic imports. No handlers,
// dotenv, Prisma client, sockets, providers, Preview or live Run are dispatched.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const sources = {};
for (const name of ['services/productionJobStore', 'services/productionShippingService',
  'services/productionPipelineErrors', 'netlify/functions/telegram-webhook']) {
  sources[name] = await readFile(new URL(`${name}.ts`, root), 'utf8');
  const result = ts.transpileModule(sources[name], {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    reportDiagnostics: true,
  });
  assert.equal(result.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
}
let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log(`ok ${checks} - ${name}`); }
let rows = [], nextId = 1, queue = Promise.resolve(), failNextJobCreate = false,
  failNextHistoryCreate = false;
const clone = value => structuredClone(value);
const matches = (row, where) => Object.entries(where ?? {}).every(([k, v]) => row[k] === v);
const table = {
  async findMany({ where, orderBy } = {}) {
    const result = rows.filter(row => matches(row, where));
    result.sort((a, b) => orderBy?.id === 'asc' ? a.id - b.id : b.id - a.id);
    return clone(result);
  },
  async findFirst(args) { return (await table.findMany(args))[0] ?? null; },
  async deleteMany({ where }) {
    const before = rows.length; rows = rows.filter(row => !matches(row, where));
    return { count: before - rows.length };
  },
  async create({ data }) {
    if (failNextHistoryCreate && data.source === 'prod_job_history') {
      failNextHistoryCreate = false; throw new Error('synthetic audit persistence failure');
    }
    if (failNextJobCreate && data.source === 'prod_job') {
      failNextJobCreate = false; throw new Error('synthetic persistence failure');
    }
    const row = { id: nextId++, ...clone(data) }; rows.push(row); return clone(row);
  },
};
const fakeDb = {
  failedPayload: table,
  $transaction(fn) {
    const task = queue.then(async () => {
      const before = clone(rows);
      try { return await fn({ failedPayload: table, $queryRawUnsafe: async (sql) => {
        assert.match(sql, /^SELECT 1 AS locked FROM pg_advisory_xact_lock/); return [];
      } }); } catch (e) { rows = before; throw e; }
    });
    queue = task.catch(() => {}); return task;
  },
};
let sequence = 0, afterSleep = async () => {}, onLoad = async () => {},
  onProcess = async () => ({ skipped: false, accurateShipmentId: 700 }),
  onMessage = async () => {}, sends = [], calls = [], servicesCreated = 0;
const forbidden = () => { throw new Error('Real I/O forbidden'); };
let clockOffsetMs = 0;
class SyntheticDate extends Date {
  static now() { return Date.now() + clockOffsetMs; }
}
const context = vm.createContext({ Buffer, Date: SyntheticDate, console,
  process: { env: { TELEGRAPH_ENABLED: 'true' } }, fetch: forbidden,
  setTimeout: (fn) => { Promise.resolve().then(afterSleep).then(fn); return 0; },
});
const modules = new Map();
async function synthetic(key, values) {
  if (!modules.has(key)) {
    const m = new vm.SyntheticModule(Object.keys(values), function () {
      for (const [k, v] of Object.entries(values)) this.setExport(k, v);
    }, { context, identifier: key });
    await m.link(forbidden); await m.evaluate(); modules.set(key, m);
  }
  return modules.get(key);
}
async function resolve(specifier) {
  if (specifier === './manualShipmentBinding.js') return synthetic(specifier, {
    assertManualShipmentBindings: forbidden, assertManualShipmentUnchanged: forbidden,
    bindManualShipment: forbidden, manualShipmentBindingsHash: forbidden,
  });
  // This suite exercises normal-mode cancellation, not the separate Preview-only policy.
  if (specifier === './productionPreviewOnly.js') return synthetic(specifier, {
    previewOnlyConfig: () => undefined,
    manualRunConfig: () => undefined,
    isFreshOwnerPreviewMessage: () => false,
    isPreviewOperator: () => false,
    previewRecipientsMatch: () => false,
    assertPreviewCursorInMode: () => {},
    assertProductionRunAllowed: () => {},
  });
  if (specifier === 'node:crypto') return synthetic(specifier, {
    randomUUID: () => `${(++sequence).toString(16).padStart(8, '0')}-synthetic`,
  });
  if (specifier === '../lib/prisma.js') return synthetic(specifier, { basePrisma: fakeDb });
  if (specifier === './productionJobStore.js') return store;
  if (specifier === './productionPipelineErrors.js') return errors;
  if (specifier === '../telegram/telegramApi.js') return synthetic(specifier, {
    sendMessage: async (...args) => { sends.push(args); await onMessage(...args); return true; },
    sendDocument: async (...args) => { sends.push(args); return true; },
  });
  if (specifier === '../shopify/shopifyOrdersClient.js') return synthetic(specifier, {
    shopifyOrdersClient: { listAllMatchingOrders: async () => { await onLoad();
      return [{ name: '#SYNTHETIC-1' }, { name: '#SYNTHETIC-2' }]; } },
  });
  if (specifier === '../app.js') return synthetic(specifier, { createAppServices: () => {
    servicesCreated++; return { shopifyOrderProcessor: { process: async (order) => {
      calls.push(order.name); return await onProcess(order);
    } } };
  } });
  throw new Error(`Unapproved import blocked: ${specifier}`);
}
async function compile(name) {
  const m = new vm.SourceTextModule(ts.transpileModule(sources[name], {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText, { context, identifier: name, importModuleDynamically: resolve });
  await m.link(resolve); await m.evaluate(); return m;
}
const errors = await compile('services/productionPipelineErrors');
const store = await compile('services/productionJobStore');
const shipping = await compile('services/productionShippingService');
const s = store.namespace;
const replay = error => error.name === 'ProductionTelegramUpdateReplayError';
const lost = error => error.name === 'ProductionJobLeaseLostError';
const watermark = chatId => rows.find(r => r.source === 'prod_telegram_update' && r.reason === String(chatId));

await check('atomic concurrent duplicate accepts once', async () => {
  const results = await Promise.allSettled(Array.from({ length: 4 }, () =>
    s.createPreviewJob(1, { recipientChatIds: [1], telegramUpdateId: 10 })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  for (const r of results.filter(r => r.status === 'rejected')) assert.ok(replay(r.reason));
});
await check('cancel preserves success receipts and immutable snapshot; replay cannot recreate', async () => {
  let cursor = await s.claimJob(1);
  cursor.sentArtifactKeys.push('1|already-confirmed');
  await s.checkpointJob(1, cursor, cursor.executionToken);
  await table.create({ data: { source: 'prod_preview_snapshot', reason: cursor.batchId,
    externalId: '1', payloadJson: '{"synthetic":"immutable"}' } });
  await table.create({ data: { source: 'financial_receipt', reason: 'protected', payloadJson: '{}' } });
  await s.clearJob(1, 11);
  assert.equal(await s.loadJob(1), null);
  const tombstone = JSON.parse(rows.find(r => r.source === 'prod_job_history' && r.reason === cursor.batchId).payloadJson);
  assert.equal(tombstone.status, 'cancelled');
  assert.deepEqual(tombstone.sentArtifactKeys, ['1|already-confirmed']);
  assert.equal(tombstone.executionToken, undefined);
  await assert.rejects(s.createPreviewJob(1, { recipientChatIds: [1], telegramUpdateId: 10 }), replay);
  await assert.rejects(s.queueRun(1, { recipientChatIds: [1], telegramUpdateId: 9 }), replay);
  await assert.rejects(s.assertJobLease(1, cursor.batchId, cursor.executionToken), lost);
  await assert.rejects(s.checkpointJob(1, cursor, cursor.executionToken), lost);
  await s.createPreviewJob(1, { recipientChatIds: [1], telegramUpdateId: 12 });
  assert.ok(rows.some(r => r.source === 'prod_preview_snapshot' && r.reason === cursor.batchId));
  assert.ok(rows.some(r => r.source === 'financial_receipt'));
});
await check('empty cancellation is durable and fences older unseen commands', async () => {
  await s.clearJob(2, 30);
  assert.ok(rows.some(r => r.source === 'prod_job_history' && r.reason === 'cancelled-update:30'));
  await assert.rejects(s.queueRun(2, { recipientChatIds: [2], telegramUpdateId: 29 }), replay);
  await s.queueRun(2, { recipientChatIds: [2], telegramUpdateId: 31 });
});
await check('later batch completion retains older cancellation history and snapshot byte-for-byte', async () => {
  const originalHistory = clone(rows.find(r => r.source === 'prod_job_history' && r.externalId === '1'));
  const originalSnapshot = clone(rows.find(r => r.source === 'prod_preview_snapshot' && r.externalId === '1'));
  await s.queueRun(1, { recipientChatIds: [1], telegramUpdateId: 13 });
  const preview = await s.claimJob(1);
  await s.finishPreview(1, preview, preview.executionToken);
  const run = await s.claimJob(1);
  await s.completeRun(1, run, run.executionToken);
  assert.deepEqual(rows.find(r => r.id === originalHistory.id), originalHistory);
  assert.deepEqual(rows.find(r => r.id === originalSnapshot.id), originalSnapshot);
});
await check('write failure rolls dedup back: retry is not silently acknowledged', async () => {
  failNextJobCreate = true;
  await assert.rejects(s.createPreviewJob(3, { recipientChatIds: [3], telegramUpdateId: 50 }), /persistence failure/);
  assert.equal(watermark(3), undefined);
  assert.equal((await s.createPreviewJob(3, { recipientChatIds: [3], telegramUpdateId: 50 })).created, true);
});
await check('failed cancellation audit rolls back state and update barrier together', async () => {
  const before = await s.loadJob(3);
  failNextHistoryCreate = true;
  await assert.rejects(s.clearJob(3, 51), /audit persistence failure/);
  assert.deepEqual(await s.loadJob(3), before);
  assert.equal(JSON.parse(watermark(3).payloadJson).highWaterUpdateId, 50);
});
await check('malformed durable watermark fails closed without overwriting evidence', async () => {
  await table.create({ data: { source: 'prod_telegram_update', reason: '5', payloadJson: '{"version":99}' } });
  await assert.rejects(s.createPreviewJob(5, { recipientChatIds: [5], telegramUpdateId: 60 }), /operator review/);
  assert.equal(watermark(5).payloadJson, '{"version":99}');
  assert.equal(await s.loadJob(5), null);
});
await check('bounded watermark keeps oldest evicted update fenced across module reload', async () => {
  for (let id = 100; id < 175; id++) await s.createPreviewJob(4, { recipientChatIds: [4], telegramUpdateId: id });
  assert.equal(rows.filter(r => r.source === 'prod_telegram_update' && r.reason === '4').length, 1);
  assert.equal(JSON.parse(watermark(4).payloadJson).recent.length, 64);
  const restarted = (await compile('services/productionJobStore')).namespace;
  await assert.rejects(restarted.queueRun(4, { recipientChatIds: [4], telegramUpdateId: 100 }), replay);
});
await check('week-idle random lower IDs fail closed; wall-clock never clears cancellation barrier', async () => {
  await s.clearJob(6, 1000001);
  const originalWatermark = clone(watermark(6));
  const originalHistory = clone(rows.find(r => r.source === 'prod_job_history' && r.externalId === '6'));
  clockOffsetMs = 8 * 24 * 60 * 60 * 1000;
  try {
    // Deliberate conservative limitation: neither a fresh-looking lower ID nor
    // a delayed old command proves a new epoch without a validated envelope.
    await assert.rejects(s.createPreviewJob(6, { recipientChatIds: [6], telegramUpdateId: 42 }), replay);
    await assert.rejects(s.queueRun(6, { recipientChatIds: [6], telegramUpdateId: 1000000 }), replay);
    assert.equal(await s.loadJob(6), null);
    assert.deepEqual(watermark(6), originalWatermark);
    assert.deepEqual(rows.find(r => r.id === originalHistory.id), originalHistory);
  } finally { clockOffsetMs = 0; }
});
await check('missing, stale, replaced and non-running leases fail closed', async () => {
  await assert.rejects(s.assertJobLease(1, 'anything', undefined), lost);
  const cursor = await s.claimJob(3);
  await s.assertJobLease(3, cursor.batchId, cursor.executionToken);
  await assert.rejects(s.assertJobLease(3, cursor.batchId, 'replacement'), lost);
  const row = rows.find(r => r.source === 'prod_job' && r.reason === '3');
  const saved = JSON.parse(row.payloadJson);
  row.payloadJson = JSON.stringify({ ...saved, updatedAt: Date.now() - s.JOB_STALE_MS });
  await assert.rejects(s.assertJobLease(3, cursor.batchId, cursor.executionToken), lost);
  row.payloadJson = JSON.stringify({ ...saved, status: 'needs_review' });
  await assert.rejects(s.assertJobLease(3, cursor.batchId, cursor.executionToken), lost);
});

async function syntheticShipping(chatId, hooks = {}, phase = 'shipping') {
  sends = []; calls = []; servicesCreated = 0;
  onLoad = hooks.load ?? (async () => {});
  onProcess = hooks.process ?? (async () => ({ skipped: false, accurateShipmentId: 700 }));
  afterSleep = hooks.sleep ?? (async () => {});
  onMessage = hooks.message ?? (async () => {});
  await s.queueRun(chatId, { recipientChatIds: [chatId, chatId + 1000], telegramUpdateId: 1000 });
  const preview = await s.claimJob(chatId);
  preview.orderNumbers = ['#SYNTHETIC-1', '#SYNTHETIC-2'];
  await s.finishPreview(chatId, preview, preview.executionToken);
  const cursor = await s.claimJob(chatId);
  cursor.phase = phase;
  await s.checkpointJob(chatId, cursor, cursor.executionToken);
  return { cursor, run: () => shipping.namespace.createExactBatchShipments({ chatId, cursor,
    deadline: Date.now() + 60000,
    checkpoint: async () => { await s.checkpointJob(chatId, cursor, cursor.executionToken); },
  }) };
}
await check('cancel during slow source read blocks first processor operation', async () => {
  const job = await syntheticShipping(10, { load: () => s.clearJob(10, 1001) });
  await assert.rejects(job.run(), lost); assert.equal(calls.length, 0); assert.equal(servicesCreated, 0);
});
await check('cancel after first success preserves receipt and blocks next order/send', async () => {
  const job = await syntheticShipping(11, { message: async (_chat, text) => {
    if (text.includes('تم الشحن بنجاح')) await s.clearJob(11, 1001);
  } });
  await assert.rejects(job.run(), lost); assert.deepEqual(calls, ['#SYNTHETIC-1']);
  const history = JSON.parse(rows.find(r => r.source === 'prod_job_history' && r.reason === job.cursor.batchId).payloadJson);
  assert.deepEqual(history.createdShipmentIds, [700]); assert.equal(history.results[0].category, 'shipped');
});
await check('cancel during transient backoff blocks retry', async () => {
  const job = await syntheticShipping(12, { process: async () => { throw new Error('synthetic network timeout'); },
    sleep: () => s.clearJob(12, 1001) });
  await assert.rejects(job.run(), lost); assert.equal(calls.length, 1);
  assert.equal(job.cursor.needsReviewOrderNames.length, 0);
});
await check('final reports recheck lease for each recipient', async () => {
  const job = await syntheticShipping(13, { message: () => s.clearJob(13, 1001) }, 'finalize');
  await assert.rejects(job.run(), lost); assert.equal(sends.length, 1); assert.equal(calls.length, 0);
});
await check('webhook passes update IDs before acknowledgment; no live handler loaded', async () => {
  const text = sources['netlify/functions/telegram-webhook'];
  assert.match(text, /Number\.isSafeInteger\(update\?\.update_id\)/);
  assert.match(text, /handleCommand\(chatId, command, text, update.update_id\)/);
  assert.match(text, /startRun\(chatId, undefined, update.update_id\)/);
  assert.match(text, /startPreview\(chatId, undefined, update.update_id\)/);
  assert.match(text, /clearJob\(chatId, telegramUpdateId\)/);
  assert.equal((text.match(/    telegramUpdateId,/g) ?? []).length, 2);
  assert.match(text, /if \(!\(error instanceof ProductionTelegramUpdateReplayError\)\) throw error/);
});
console.log(JSON.stringify({ ok: true, checks, databaseConnections: 0, networkCalls: 0,
  liveHandlersLoaded: 0, realBusinessOperations: 0 }));
