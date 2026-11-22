/**
 * NODE_DISABLE_COMPILE_CACHE=1 node src/scripts/testReadinessPreviewOnly.mjs
 * Offline only: read allowlisted TS, transpile in memory, execute in VM realms.
 * No business module is imported by Node, dotenv/client configuration is never
 * loaded, queues cannot deliver, Express cannot listen, and no files are made.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { posix } from 'node:path';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import vm from 'node:vm';

const ts = createRequire(import.meta.url)('typescript');
const root = new URL('../../', import.meta.url);
// QA-only external fixture: never add .github to the deployed source inventory.
const workflowFixturePath = process.env.READINESS_WORKFLOW_FIXTURE_PATH;
const paths = [
  'src/services/manualShipmentBinding.ts',
  'src/services/adminReadOnlyPolicy.ts',
  'src/services/automationSafety.ts', 'src/services/safeQueuePolicy.ts', 'src/services/productionPreviewOnly.ts',
  'src/services/productionJobStore.ts', 'src/services/productionContinuation.ts',
  'src/services/productionPipelineErrors.ts', 'src/services/productionPreviewService.ts',
  'src/services/previewShipmentExclusion.ts', 'src/services/orderEligibility.ts',
  'src/services/productionShippingService.ts', 'src/services/opsScheduler.ts',
  'src/netlify/functions/run-production-background.ts',
  'src/netlify/functions/telegram-webhook.ts', 'src/app.ts', 'api/owner-preview-queue.ts',
  'api/production-continuation-queue.ts',
];
const sources = new Map(paths.map(path => [path, readFileSync(new URL(path, root), 'utf8')]));
const compiled = new Map();
for (const [path, source] of sources) {
  const output = ts.transpileModule(source, { fileName: path, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } });
  assert.equal(output.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0, path);
  compiled.set(path, output.outputText);
}
const OWNER = 900001, OTHER = 900002, DATE = 1_800_000_000, UPDATE = 500;
const EPOCH = 'synthetic_epoch_20261101';
const envDefaults = {
  PRODUCTION_PREVIEW_ONLY: 'true', PRODUCTION_PREVIEW_OWNER_CHAT_ID: String(OWNER),
  PRODUCTION_PREVIEW_EPOCH: EPOCH, PRODUCTION_PREVIEW_NOT_BEFORE: String(DATE),
  PRODUCTION_PREVIEW_MIN_UPDATE_ID: String(UPDATE), TELEGRAM_WEBHOOK_SECRET: 'synthetic-secret',
  OPS_AUTOMATION_HOLD: 'synthetic-reconciliation-hold', TELEGRAPH_ENABLED: 'true',
  // Deliberately unsafe recipient input must not escape owner-only routing.
  PRODUCTION_RECIPIENT_CHAT_IDS: `${OTHER},900003`, VERCEL_ENV: 'production',
};
const clone = value => structuredClone(value);
const paused = error => error?.name === 'AutomationPausedError';
let checks = 0, failures = 0, deniedOperations = 0;
async function check(name, fn) {
  checks++;
  try { await fn(); console.log(`ok ${checks} - ${name}`); }
  catch (error) { failures++; console.error(`not ok ${checks} - ${name}\n${error.stack}`); }
}

function fixture(overrides = {}) {
  const env = { ...envDefaults, ...overrides };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const effects = { dbImports: 0, reads: 0, writes: 0, transactions: 0,
    mutations: [], messages: [], publications: [], sheets: 0, callbacks: 0, waits: 0, business: 0 };
  const retained = [];
  const protectedRows = [
    { id: 1, source: 'bot_control', reason: 'bot_paused', payloadJson: '{"held":true}' },
    { id: 2, source: 'financial_receipt', reason: 'protected', payloadJson: '{"immutable":true}' },
  ];
  let rows = clone(protectedRows), nextId = 3, serial = Promise.resolve(), uuid = 0;
  const deny = label => () => { deniedOperations++; throw new Error(`Offline test denied: ${label}`); };
  const business = () => { effects.business++; throw new Error('Synthetic business boundary must not be reached'); };
  const matches = (row, where = {}) => Object.entries(where).every(([key, value]) => row[key] === value);
  const table = {
    async findMany({ where, orderBy } = {}) {
      effects.reads++;
      return clone(rows.filter(row => matches(row, where)).sort((a, b) => orderBy?.id === 'asc' ? a.id - b.id : b.id - a.id));
    },
    async findFirst(args) { return (await table.findMany(args))[0] ?? null; },
    async deleteMany({ where }) {
      effects.writes++;
      effects.mutations.push({ operation: 'deleteMany', where: clone(where) });
      const before = rows.length; rows = rows.filter(row => !matches(row, where));
      return { count: before - rows.length };
    },
    async create({ data }) {
      effects.writes++;
      effects.mutations.push({ operation: 'create', data: clone(data) });
      const row = { id: nextId++, ...clone(data) }; rows.push(row); return clone(row);
    },
  };
  const fakeDb = { failedPayload: table,
    $transaction(fn) {
      effects.transactions++;
      const task = serial.then(async () => {
        const before = clone(rows);
        try { return await fn({ failedPayload: table, $queryRawUnsafe: async (sql, chatId) => {
          assert.equal(sql, 'SELECT 1 AS locked FROM pg_advisory_xact_lock($1::bigint)');
          assert.equal(typeof chatId, 'string'); return [];
        } }); } catch (error) { rows = before; throw error; }
      });
      serial = task.catch(() => {}); return task;
    },
  };
  // Lazy, actual guard execution keeps pure URL/policy checks free of DB imports.
  // A Preview test may seed ONLY these synthetic rows/attempts; no client loads.
  const previewLedger = { rows: [], attempts: [] };
  const previewDb = {
    shipmentRecord: { findMany: async () => { effects.reads++; return clone(previewLedger.rows); } },
    failedPayload: { findMany: async () => { effects.reads++; return clone(previewLedger.attempts); } },
  };
  const layers = [], routes = [], consumers = [];
  const fakeExpress = Object.assign(() => ({
    use: (...args) => layers.push(args),
    get: (path, ...handlers) => routes.push({ method: 'GET', path, handlers }),
    post: (path, ...handlers) => routes.push({ method: 'POST', path, handlers }),
    listen: deny('Express.listen'),
  }), { text: () => business, json: () => business, raw: () => business });
  class FakeService {}
  class FakeQueueClient {
    handleNodeCallback(callback, options) { consumers.push({ callback, options }); return business; }
  }
  const moduleCache = new Map();
  const context = vm.createContext({ Buffer, URL, Intl,
    process: { env }, console: { log() {}, warn() {}, error() {} },
    fetch: deny('fetch'), WebSocket: deny('WebSocket'),
    setTimeout: deny('timer'), clearTimeout: deny('timer'),
    AbortSignal: { timeout: deny('AbortSignal.timeout') },
  }, { codeGeneration: { strings: false, wasm: false } });
  const mocks = {
    'node:crypto': { createHash, createHmac, timingSafeEqual, randomUUID: () => `synthetic-${++uuid}` },
    '@vercel/functions': { waitUntil: promise => { effects.waits++; retained.push(promise); } },
    '@vercel/queue': { QueueClient: FakeQueueClient, send: async (...args) => {
      effects.publications.push(clone(args)); return { messageId: 'synthetic-message' };
    } },
    'express': fakeExpress,
    'src/telegram/telegramApi.ts': {
      sendMessage: async (...args) => { effects.messages.push(clone(args)); return true; },
      sendDocument: business,
      answerCallbackQuery: () => { effects.callbacks++; throw new Error('Callbacks must be ignored'); },
    },
    'src/telegram/sheetsClient.ts': Object.fromEntries(
      ['isAllowed', 'getUser', 'getActiveUsers', 'forceRefresh'].map(name => [name, () => {
        effects.sheets++; throw new Error('Sheet authorization must not be used in Preview-only mode');
      }])),
    'src/services/previewShipmentExclusion.ts': {
      previewShipmentScope: (...args) => load('src/services/previewShipmentExclusion.ts').previewShipmentScope(...args),
      assertPreviewPrimaryShipmentExclusion: (...args) => load('src/services/previewShipmentExclusion.ts').assertPreviewPrimaryShipmentExclusion(...args),
      assertPreviewFinancialSource: (...args) => load('src/services/previewShipmentExclusion.ts').assertPreviewFinancialSource(...args),
      PreviewShipmentExclusionError: function (...args) {
        return new (load('src/services/previewShipmentExclusion.ts').PreviewShipmentExclusionError)(...args);
      },
    },
    'src/services/productionAgentClient.ts': {
      extractOrderNumbers: business, fetchProductionBatch: business, productionSourceFingerprint: business,
    },
    'src/shopify/shopifyOrdersClient.ts': { shopifyOrdersClient: { listAllMatchingOrders: business } },
    'src/config/env.ts': { env: { metaDelivered: {}, shopify: { shopDomain: 'synthetic.invalid' } } },
    'src/lib/logger.ts': { logger: { error() {} } },
    'src/middleware/adminAuth.ts': { adminAuth: business },
  };
  for (const [path, name] of [
    ['accurate/accurateClient', 'AccurateClient'], ['accurate/zoneResolver', 'AccurateZoneResolver'],
    ['services/accurateMapper', 'AccurateMapper'], ['services/shopifyOrderProcessor', 'ShopifyOrderProcessor'],
    ['services/shipmentStatusSyncService', 'ShipmentStatusSyncService'], ['odoo/odooClient', 'OdooClient'],
    ['odoo/odooSyncService', 'OdooSyncService'], ['meta/metaDeliveryService', 'MetaDeliveryService'],
    ['services/locationCatalogService', 'LocationCatalogService'],
  ]) mocks[`src/${path}.ts`] = { [name]: FakeService };
  for (const [path, name] of [
    ['accurateWebhookRoute', 'createAccurateWebhookHandler'], ['adminAppRoute', 'createAdminAppRouter'],
    ['shopifyWebhookRoute', 'createShopifyWebhookHandler'], ['opsRoute', 'createOpsRouter'],
  ]) mocks[`src/routes/${path}.ts`] = { [name]: () => business };
  function load(path) {
    if (moduleCache.has(path)) return moduleCache.get(path).exports;
    assert.ok(compiled.has(path), `Source not allowlisted: ${path}`);
    const module = { exports: {} }; moduleCache.set(path, module);
    const restrictedRequire = specifier => {
      let target = specifier.startsWith('.')
        ? posix.normalize(posix.join(posix.dirname(path), specifier)).replace(/\.js$/, '.ts') : specifier;
      // The API source's dist imports are mapped ONLY to our in-memory source snapshots.
      if (target.startsWith('dist/')) target = `src/${target.slice(5)}`;
      if (target === 'src/lib/prisma.ts') { effects.dbImports++; return { basePrisma: fakeDb,
        prisma: path === 'src/services/previewShipmentExclusion.ts' ? previewDb : fakeDb }; }
      if (Object.hasOwn(mocks, target)) return mocks[target];
      if (compiled.has(target)) return load(target);
      return deny(`unapproved import ${target}`)();
    };
    new vm.Script(`(function(require,module,exports){${compiled.get(path)}\n})`, { filename: path })
      .runInContext(context)(restrictedRequire, module, module.exports);
    return module.exports;
  }
  const policy = load('src/services/productionPreviewOnly.ts');
  const safety = load('src/services/automationSafety.ts');
  const store = load('src/services/productionJobStore.ts');
  function cursor(patch = {}) {
    return { version: 2, batchId: 'synthetic-batch', kind: 'preview', status: 'queued',
      orderNumbers: ['#SYNTHETIC'], pendingRun: false, recipientChatIds: [String(OWNER)],
      previewOnlyEpoch: EPOCH, attemptCount: 0, updatedAt: Date.now(),
      sentArtifactKeys: [], sentPhotoKeys: [], ...patch };
  }
  function seed(job, chatId = OWNER) {
    rows.push({ id: nextId++, source: 'prod_job', reason: String(chatId),
      externalId: job.batchId, payloadJson: JSON.stringify(job) });
  }
  function seedSnapshot(batchId) {
    rows.push({ id: nextId++, source: 'prod_preview_snapshot', reason: batchId,
      externalId: String(OWNER), payloadJson: '{"synthetic":"immutable snapshot"}' });
  }
  const payload = (text = '/preview', patch = {}) => ({ update_id: UPDATE + 1,
    message: { message_id: 1, chat: { id: OWNER, type: 'private' }, from: { id: OWNER }, date: DATE, text }, ...patch });
  const event = (value, token = 'synthetic-secret') => ({ httpMethod: 'POST',
    headers: token === undefined ? {} : { 'x-telegram-bot-api-secret-token': token }, body: JSON.stringify(value) });
  const webhook = async value => {
    const response = await load('src/netlify/functions/telegram-webhook.ts').handler(event(value));
    await Promise.all(retained.splice(0));
    return response;
  };
  const idle = () => {
    assert.equal(effects.dbImports + effects.reads + effects.writes + effects.transactions, 0);
    assert.equal(effects.messages.length + effects.publications.length + effects.waits + effects.sheets + effects.callbacks + effects.business, 0);
    assert.deepEqual(rows, protectedRows);
  };
  const protectedIntact = () => {
    assert.deepEqual(rows.filter(row => protectedRows.some(protectedRow => protectedRow.id === row.id)), protectedRows);
    assert.equal(env.OPS_AUTOMATION_HOLD, overrides.OPS_AUTOMATION_HOLD === undefined && Object.hasOwn(overrides, 'OPS_AUTOMATION_HOLD')
      ? undefined : overrides.OPS_AUTOMATION_HOLD ?? envDefaults.OPS_AUTOMATION_HOLD);
  };
  return { load, env, effects, policy, safety, store, cursor, seed, seedSnapshot, payload, event, webhook, idle, mocks,
    protectedIntact, layers, routes, consumers, previewLedger, rows: () => clone(rows) };
}

await check('valid config is pure and normalizes the explicit mode', () => {
  const f = fixture({ PRODUCTION_PREVIEW_ONLY: ' TRUE ' });
  assert.deepEqual(clone(f.policy.previewOnlyConfig()), { ownerChatId: OWNER, allowedChatIds: [OWNER], recipientChatIds: [String(OWNER)], epoch: EPOCH, notBefore: DATE, minUpdateId: UPDATE });
  f.idle();
});
const invalidConfig = {
  PRODUCTION_PREVIEW_OWNER_CHAT_ID: [undefined, '', ' ', 'no', '0', '-1', '1.5', '9007199254740992'],
  PRODUCTION_PREVIEW_EPOCH: [undefined, '', 'short', 'x'.repeat(81), 'invalid/epoch_____'],
  PRODUCTION_PREVIEW_NOT_BEFORE: [undefined, '', ' ', 'no', '0', '-1', '1.5', 'Infinity'],
  PRODUCTION_PREVIEW_MIN_UPDATE_ID: [undefined, '', ' ', 'no', '-1', '1.5', '9007199254740992'],
};
for (const [key, values] of Object.entries(invalidConfig)) for (const value of values) {
  await check(`config ${key}=${JSON.stringify(value)} fails closed before effects`, async () => {
    const f = fixture({ [key]: value });
    assert.throws(() => f.policy.previewOnlyConfig(), /not configured safely/);
    await assert.rejects(f.policy.assertProductionInvocationAllowed(OWNER, 'synthetic-batch'), /not configured safely/);
    await assert.rejects(f.webhook(f.payload()), /not configured safely/);
    f.idle();
  });
}
for (const flag of [undefined, '', 'false', 'yes']) await check(`no explicit mode (${JSON.stringify(flag)}) cannot bypass global hold`, async () => {
  const f = fixture({ PRODUCTION_PREVIEW_ONLY: flag });
  assert.equal(f.policy.previewOnlyConfig(), undefined);
  assert.throws(f.policy.assertProductionRunAllowed, paused);
  await assert.rejects(f.policy.assertProductionInvocationAllowed(OWNER, 'synthetic-batch'), paused);
  f.idle();
});
await check('zero minimum update ID is a valid explicit boundary', () => {
  const f = fixture({ PRODUCTION_PREVIEW_MIN_UPDATE_ID: '0' });
  assert.equal(f.policy.previewOnlyConfig().minUpdateId, 0); f.idle();
});

const envelopeCases = [
  ['wrong chat', { chatId: OTHER }], ['wrong sender', { fromId: OTHER }], ['missing sender', { fromId: undefined }],
  ['string chat', { chatId: String(OWNER) }], ['string sender', { fromId: String(OWNER) }],
  ['old date', { date: DATE - 1 }], ['missing date', { date: undefined }], ['fractional date', { date: DATE + 0.5 }],
  ['string date', { date: String(DATE) }], ['unsafe date', { date: Number.MAX_SAFE_INTEGER + 1 }],
  ['boundary update', { updateId: UPDATE }], ['older update', { updateId: UPDATE - 1 }],
  ['missing update', { updateId: undefined }], ['fractional update', { updateId: UPDATE + 0.5 }],
  ['string update', { updateId: String(UPDATE + 1) }], ['unsafe update', { updateId: Number.MAX_SAFE_INTEGER + 1 }],
];
for (const [name, patch] of envelopeCases) await check(`owner envelope rejects ${name} without effects`, () => {
  const f = fixture();
  assert.equal(f.policy.isFreshOwnerPreviewMessage({ chatId: OWNER, fromId: OWNER, date: DATE, updateId: UPDATE + 1, ...patch }), false);
  f.idle();
});
await check('fresh owner message accepts exact date and strict next-update boundary', () => {
  const f = fixture();
  assert.equal(f.policy.isFreshOwnerPreviewMessage({ chatId: OWNER, fromId: OWNER, date: DATE, updateId: UPDATE + 1 }), true);
  f.idle();
});
for (const hold of ['synthetic-hold', undefined, '']) await check(`Run stays blocked with global hold=${JSON.stringify(hold)}`, async () => {
  const f = fixture({ OPS_AUTOMATION_HOLD: hold });
  assert.equal(f.safety.automationHoldReason(), 'operator-reconciliation-hold');
  assert.throws(f.safety.assertAutomationReleased, paused);
  assert.throws(f.policy.assertProductionRunAllowed, paused);
  assert.throws(() => f.store.runCursorFromPreview(f.cursor()), paused);
  await assert.rejects(f.store.queueRun(OWNER, { recipientChatIds: [OWNER], telegramUpdateId: UPDATE + 1 }), paused);
  await assert.rejects(f.load('src/services/productionShippingService.ts').createExactBatchShipments({ chatId: OWNER, cursor: f.cursor({ kind: 'run' }) }), paused);
  await assert.rejects(f.load('src/netlify/functions/run-production-background.ts').handler({ body: JSON.stringify({ chatId: OWNER, execute: true }) }), paused);
  f.idle();
});

const badCursors = [
  ['missing epoch', { previewOnlyEpoch: undefined }], ['old epoch', { previewOnlyEpoch: 'old_epoch_20261031' }],
  ['Run cursor', { kind: 'run' }], ['pending Run', { pendingRun: true }],
  ['other recipient', { recipientChatIds: [String(OTHER)] }], ['extra recipient', { recipientChatIds: [String(OWNER), String(OTHER)] }],
  ['no recipient', { recipientChatIds: [] }], ['numeric recipient', { recipientChatIds: [OWNER] }],
];
for (const [name, patch] of badCursors) await check(`${name} rejected by policy, invocation, continuation and claim without writes`, async () => {
  const f = fixture(); const job = f.cursor(patch); f.seed(job); const before = f.rows();
  assert.throws(() => f.policy.assertPreviewCursorInMode(OWNER, job), paused);
  await assert.rejects(f.policy.assertProductionInvocationAllowed(OWNER, job.batchId), paused);
  await assert.rejects(f.load('src/services/productionContinuation.ts').scheduleProductionContinuation({ chatId: OWNER, batchId: job.batchId }), paused);
  await assert.rejects(f.load('src/netlify/functions/run-production-background.ts').runPipeline(OWNER, job.batchId), paused);
  await assert.rejects(f.store.claimJob(OWNER, job.batchId), paused);
  assert.deepEqual(f.rows(), before); assert.equal(f.effects.writes, 0);
  assert.equal(f.effects.publications.length + f.effects.messages.length + f.effects.business, 0);
  f.protectedIntact();
});
for (const [name, chat, batch] of [['other chat', OTHER, 'synthetic-batch'], ['missing batch', OWNER, undefined]]) {
  await check(`invocation rejects ${name} before DB access`, async () => {
    const f = fixture(); await assert.rejects(f.policy.assertProductionInvocationAllowed(chat, batch), paused); f.idle();
  });
}
for (const missing of [true, false]) await check(`invocation rejects ${missing ? 'missing row' : 'mismatched batch'} without queue work`, async () => {
  const f = fixture(); if (!missing) f.seed(f.cursor()); const before = f.rows();
  await assert.rejects(f.policy.assertProductionInvocationAllowed(OWNER, 'other-batch'), paused);
  assert.deepEqual(f.rows(), before); assert.equal(f.effects.writes + f.effects.publications.length, 0);
});
await check('fresh epoch Preview is created, owner-only, claimable and publishable on dedicated topic', async () => {
  const f = fixture();
  const result = await f.webhook(f.payload('/preview #SYNTHETIC'));
  assert.equal(result.statusCode, 200); assert.equal(result.body, 'owner-preview-only');
  const saved = await f.store.loadJob(OWNER);
  assert.equal(saved.kind, 'preview'); assert.equal(saved.previewOnlyEpoch, EPOCH); assert.equal(saved.pendingRun, false);
  assert.equal(saved.orderId, 'SYNTHETIC'); assert.deepEqual(clone(saved.recipientChatIds), [String(OWNER)]);
  assert.equal(f.effects.publications.length, 1);
  const [topic, payload] = f.effects.publications[0];
  assert.equal(topic, f.policy.PREVIEW_ONLY_TOPIC); assert.equal(payload.chatId, OWNER); assert.equal(payload.batchId, saved.batchId);
  assert.ok(f.effects.messages.every(([chatId]) => chatId === OWNER));
  assert.equal(f.effects.sheets + f.effects.callbacks + f.effects.business, 0);
  await f.policy.assertProductionInvocationAllowed(OWNER, saved.batchId);
  const claimed = await f.store.claimJob(OWNER, saved.batchId);
  assert.equal(claimed.status, 'running'); assert.ok(claimed.executionToken);
  await f.store.assertJobLease(OWNER, saved.batchId, claimed.executionToken);
  const finished = await f.store.finishPreview(OWNER, claimed, claimed.executionToken);
  assert.equal(finished.kind, 'preview'); assert.equal(finished.status, 'preview_ready'); assert.equal(finished.pendingRun, false);
  f.protectedIntact();
});
await check('native creation rejects nonowner, pendingRun, stale update or extra recipient before DB', async () => {
  const f = fixture();
  for (const [chatId, patch] of [[OTHER, {}], [OWNER, { pendingRun: true }],
    [OWNER, { telegramUpdateId: undefined }], [OWNER, { telegramUpdateId: UPDATE }],
    [OWNER, { recipientChatIds: [OWNER, OTHER] }], [OWNER, { recipientChatIds: [OTHER] }]]) {
    await assert.rejects(f.store.createPreviewJob(chatId, { recipientChatIds: [OWNER], telegramUpdateId: UPDATE + 1, ...patch }), /fresh owner Preview/);
  }
  f.idle();
});
for (const side of ['stored', 'in-memory', 'both']) await check(`finishPreview cannot convert ${side} pendingRun or erase snapshot`, async () => {
  const f = fixture();
  const job = f.cursor({ status: 'running', executionToken: 'synthetic-lease', pendingRun: side !== 'in-memory' });
  f.seed(job); f.seedSnapshot(job.batchId); const before = f.rows();
  const memory = { ...job, pendingRun: side !== 'stored' };
  await assert.rejects(f.store.finishPreview(OWNER, memory, job.executionToken), paused);
  assert.deepEqual(f.rows(), before); assert.equal(f.effects.writes, 0);
  assert.equal(f.effects.publications.length + f.effects.business, 0); f.protectedIntact();
});
await check('legacy invalid cursor is preserved rather than silently deleted or replaced', async () => {
  const f = fixture(); f.seed({ version: 1, batchId: 'legacy', kind: 'preview' }); const before = f.rows();
  await assert.rejects(f.store.claimJob(OWNER, 'legacy'), /./);
  await assert.rejects(f.store.createPreviewJob(OWNER, { recipientChatIds: [OWNER], telegramUpdateId: UPDATE + 1 }), /./);
  assert.deepEqual(f.rows(), before);
  // Update acceptance precedes readLocked in the SAME transaction. Its dummy
  // watermark writes must roll back; neither the legacy job nor snapshot may
  // ever be deleted/replaced, even as an attempted mutation.
  assert.ok(f.effects.mutations.every(mutation =>
    (mutation.where?.source ?? mutation.data?.source) === 'prod_telegram_update'));
});

for (const text of ['/preview', '/status', '/cancel', '/run', '/resume', '/stop']) {
  for (const who of ['other chat', 'other sender', 'old date', 'old update']) {
    await check(`${text}: ${who} has zero effects`, async () => {
      const f = fixture(); const update = f.payload(text);
      if (who === 'other chat') update.message.chat.id = OTHER;
      if (who === 'other sender') update.message.from.id = OTHER;
      if (who === 'old date') update.message.date = DATE - 1;
      if (who === 'old update') update.update_id = UPDATE;
      assert.equal((await f.webhook(update)).body, 'ignored-owner-preview-only'); f.idle();
    });
  }
}
for (const fromId of [OWNER, OTHER]) await check(`callback from ${fromId} is ignored without answer, DB or queue`, async () => {
  const f = fixture(); const update = f.payload(); delete update.message;
  update.callback_query = { id: 'synthetic-callback', from: { id: fromId },
    message: f.payload().message, data: 'cont:old-batch' };
  assert.equal((await f.webhook(update)).body, 'ignored-owner-preview-only'); f.idle();
});
for (const text of ['/run', '/run #SYNTHETIC', '/resume', '/stop', 'شحن', 'اشحن', '/refresh', '/users']) {
  await check(`owner ${text} cannot alter DB, queues or global stop`, async () => {
    const f = fixture({ OPS_AUTOMATION_HOLD: undefined }); const before = f.rows();
    assert.equal((await f.webhook(f.payload(text))).statusCode, 200);
    assert.deepEqual(f.rows(), before); assert.equal(f.effects.dbImports + f.effects.writes + f.effects.reads + f.effects.transactions, 0);
    assert.equal(f.effects.publications.length + f.effects.sheets + f.effects.callbacks + f.effects.business, 0);
    assert.equal(f.effects.messages.length, 1); assert.equal(f.effects.messages[0][0], OWNER);
    assert.equal(f.safety.automationHoldReason(), 'operator-reconciliation-hold'); f.protectedIntact();
  });
}
await check('owner status can read but not mutate or dispatch', async () => {
  const f = fixture(); f.seed(f.cursor()); const before = f.rows();
  assert.equal((await f.webhook(f.payload('/status'))).statusCode, 200);
  assert.ok(f.effects.reads > 0); assert.equal(f.effects.writes + f.effects.transactions + f.effects.publications.length, 0);
  assert.deepEqual(f.rows(), before); assert.equal(f.effects.messages[0][0], OWNER); f.protectedIntact();
});
await check('owner cancel only cancels Preview and keeps durable history and global stop', async () => {
  const f = fixture(); const job = f.cursor(); f.seed(job);
  assert.equal((await f.webhook(f.payload('/cancel'))).statusCode, 200);
  assert.equal(await f.store.loadJob(OWNER), null);
  const history = f.rows().find(row => row.source === 'prod_job_history');
  assert.equal(JSON.parse(history.payloadJson).status, 'cancelled');
  assert.equal(JSON.parse(history.payloadJson).batchId, job.batchId);
  assert.equal(f.effects.publications.length, 0); f.protectedIntact();
});
await check('owner cancel cannot alter an old Run cursor', async () => {
  const f = fixture(); f.seed(f.cursor({ kind: 'run' })); const before = f.rows();
  await f.webhook(f.payload('/cancel')); assert.deepEqual(f.rows(), before);
  assert.equal(f.effects.writes + f.effects.publications.length, 0); f.protectedIntact();
});
for (const [name, patch] of badCursors) await check(`owner Preview holds ${name} without rescheduling`, async () => {
  const f = fixture(); f.seed(f.cursor(patch)); const before = f.rows();
  assert.equal((await f.webhook(f.payload())).body, 'old-batch-held');
  assert.deepEqual(f.rows(), before); assert.equal(f.effects.writes + f.effects.publications.length, 0);
});
await check('duplicate fresh owner Preview cannot republish or resend', async () => {
  const f = fixture(); await f.webhook(f.payload());
  const before = f.rows(), messages = f.effects.messages.length, publications = f.effects.publications.length;
  assert.equal((await f.webhook(f.payload())).body, 'duplicate-update');
  assert.deepEqual(f.rows(), before); assert.equal(f.effects.messages.length, messages); assert.equal(f.effects.publications.length, publications);
  f.protectedIntact();
});

for (const missing of [undefined, '', ' ']) await check(`missing webhook secret=${JSON.stringify(missing)} returns 503 before effects`, async () => {
  const f = fixture({ TELEGRAM_WEBHOOK_SECRET: missing });
  assert.equal((await f.webhook(f.payload())).statusCode, 503); f.idle();
});
for (const wrong of ['', 'wrong', 'synthetic-secrex', 'سرّي']) await check(`wrong webhook secret=${JSON.stringify(wrong)} returns 401 before effects`, async () => {
  const f = fixture(); const handler = f.load('src/netlify/functions/telegram-webhook.ts').handler;
  assert.equal((await handler(f.event(f.payload(), wrong))).statusCode, 401); f.idle();
});
await check('absent webhook header returns 401 before effects', async () => {
  const f = fixture(); const event = f.event(f.payload()); event.headers = {};
  assert.equal((await f.load('src/netlify/functions/telegram-webhook.ts').handler(event)).statusCode, 401); f.idle();
});

for (const hold of ['synthetic-hold', undefined]) await check(`isolated Express keeps all non-Preview mutations held (${JSON.stringify(hold)})`, () => {
  const f = fixture({ OPS_AUTOMATION_HOLD: hold }); f.load('src/app.ts').createApp();
  const guards = f.layers.filter(args => args.length === 1 && typeof args[0] === 'function' && args[0].length === 3);
  assert.equal(guards.length, 2); const guard = guards[1][0];
  const probe = (method, path) => {
    const response = { headers: {}, statusCode: undefined, body: undefined,
      setHeader(key, value) { this.headers[key] = value; },
      status(value) { this.statusCode = value; return this; }, json(value) { this.body = clone(value); return this; } };
    let next = 0; guard({ method, path }, response, () => next++); return { response, next };
  };
  for (const [method, path] of [
    ['POST', '/orders/run'], ['GET', '/orders/unknown'], ['POST', '/api/shipping'], ['GET', '/api/private'],
    ['POST', '/webhooks/accurate/shipment-status'], ['POST', '/webhooks/shopify/orders-create'],
    ['POST', '/internal/production/resume'], ['POST', '/telegram-webhook/extra'], ['PUT', '/telegram-webhook'],
  ]) {
    const { response, next } = probe(method, path); assert.equal(next, 0, `${method} ${path}`);
    assert.equal(response.statusCode, 503); assert.equal(response.body.reason, 'operator-reconciliation-hold');
    assert.equal(response.headers['Retry-After'], '3600');
  }
  assert.equal(probe('POST', '/telegram-webhook').next, 1);
  // Display routes advance to the unchanged adminAuth, not an executor.
  // Actual authentication/inert-action behavior is covered by the new route suite.
  assert.equal(probe('GET', '/orders').next, 1);
  assert.equal(probe('GET', '/api/orders').next, 1);
  f.env.PRODUCTION_PREVIEW_ONLY = 'false'; f.env.OPS_AUTOMATION_HOLD = 'synthetic-hold';
  assert.equal(probe('POST', '/telegram-webhook').response.statusCode, 503);
  f.env.PRODUCTION_PREVIEW_ONLY = 'true'; f.env.PRODUCTION_PREVIEW_EPOCH = 'bad';
  assert.throws(() => probe('POST', '/telegram-webhook'), /not configured safely/);
  assert.equal(f.effects.dbImports + f.effects.publications.length + f.effects.business, 0);
});
await check('mode alone holds real persistent scheduler ensure, health and all lane ticks', async () => {
  const f = fixture({ OPS_AUTOMATION_HOLD: undefined }); const scheduler = f.load('src/services/opsScheduler.ts').opsScheduler;
  assert.equal((await scheduler.ensure()).reason, 'operator-reconciliation-hold');
  assert.equal((await scheduler.health()).reason, 'operator-reconciliation-hold');
  for (const lane of ['status', 'discovery', 'financial']) {
    assert.equal((await scheduler.tick({ version: 1, lane, slot: 1_800_000_000_000 })).skipped, 'operator-reconciliation-hold');
  }
  f.idle();
});
await check('health reports manual Preview only, automatic work held and Run disabled with no global flag', () => {
  const f = fixture({ OPS_AUTOMATION_HOLD: undefined }); f.load('src/app.ts').createApp();
  const health = f.routes.find(route => route.method === 'GET' && route.path === '/health');
  let status, body;
  health.handlers[0]({}, { status(value) { status = value; return this; }, json(value) { body = clone(value); } });
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, manualPreviewOnly: true, automaticWorkHeld: true, runEnabled: false, automaticQueuesEnabled: false, shopifyManualShippingEnabled: false }); f.idle();
});
await check('normal production queue remains held before DB or pipeline load when mode alone is set', async () => {
  const f = fixture({ OPS_AUTOMATION_HOLD: undefined }); f.load('api/production-continuation-queue.ts');
  const { callback, options } = f.consumers[0]; let rejected;
  await assert.rejects(callback({ chatId: OWNER, batchId: 'synthetic-batch' }, { messageId: 'synthetic' }),
    error => { rejected = error; return paused(error); });
  assert.equal(options.retry(rejected, { deliveryCount: 1 }).afterSeconds, 3600); f.idle();
});
await check('dedicated queue consumer rejects missing mode, malformed and stale jobs without work', async () => {
  const f = fixture(); f.load('api/owner-preview-queue.ts'); assert.equal(f.consumers.length, 1);
  const { callback, options } = f.consumers[0];
  f.env.PRODUCTION_PREVIEW_ONLY = 'false'; await assert.rejects(callback({ chatId: OWNER, batchId: 'old' }), /not active/);
  f.env.PRODUCTION_PREVIEW_ONLY = 'true'; await assert.rejects(callback({}), /Invalid owner Preview payload/);
  const job = f.cursor({ previewOnlyEpoch: 'old_epoch_20261031' }); f.seed(job);
  let rejected;
  await assert.rejects(callback({ chatId: OWNER, batchId: job.batchId }), error => { rejected = error; return paused(error); });
  assert.equal(options.retry(rejected, { deliveryCount: 1 }).acknowledge, true);
  assert.equal(f.effects.writes + f.effects.publications.length + f.effects.messages.length + f.effects.business, 0);
  f.protectedIntact();
});

for (const host of ['viola-customization-admin.vercel.app', 'viola-customization-admin-violaaa.vercel.app',
  'viola-customization-admin.netlify.app', 'viola-customization-recovery.netlify.app']) {
  await check(`photo capability migration preserves key/query/hash from ${host}`, () => {
    const f = fixture(); const url = `https://${host}/app/uploaded-file?key=uploads%2Fsynthetic.png&token=a%2Bb#original`;
    const migrate = f.load('src/services/productionPreviewService.ts').currentPreviewPhotoUrl;
    assert.equal(migrate(url), 'https://app.violaleather.com/app/uploaded-file?key=uploads%2Fsynthetic.png&token=a%2Bb#original'); f.idle();
  });
}
for (const url of ['not a url', 'https://unrelated.invalid/app/uploaded-file?key=uploads/a.png',
  'https://viola-customization-admin.vercel.app/other?key=uploads/a.png',
  'https://viola-customization-admin.vercel.app/app/uploaded-file',
  'https://viola-customization-admin.vercel.app/app/uploaded-file?key=private/a.png',
  'https://viola-customization-admin.vercel.app/app/uploaded-file?key=uploads/../a.png',
  'https://name:password@viola-customization-admin.vercel.app/app/uploaded-file?key=uploads/a.png']) {
  await check(`photo migration refuses unrelated or unsafe capability ${url}`, () => {
    const f = fixture(); assert.equal(f.load('src/services/productionPreviewService.ts').currentPreviewPhotoUrl(url), url); f.idle();
  });
}

// Explicit two-operator release: only fixed configuration can expand access;
// generic normal-mode recipient settings never grant access or leak files.
const teamEnv = { PRODUCTION_PREVIEW_ALLOWED_CHAT_IDS: `${OWNER},${OTHER}`,
  PRODUCTION_PREVIEW_RECIPIENT_CHAT_IDS: `${OWNER},${OTHER}` };
await check('two-operator config is explicit, bounded and normalizes whitespace', () => {
  const f = fixture({ ...teamEnv, PRODUCTION_PREVIEW_ALLOWED_CHAT_IDS: ` ${OWNER}, ${OTHER} ` });
  assert.deepEqual(clone(f.policy.previewOnlyConfig().allowedChatIds), [OWNER, OTHER]);
  assert.deepEqual(clone(f.policy.previewOnlyConfig().recipientChatIds), [String(OWNER), String(OTHER)]); f.idle();
});
for (const ids of ['', ' ', `${OWNER},`, `${OWNER},${OTHER},900003`, `${OWNER},${OWNER}`,
  `${OTHER}`, `${OWNER},-1`, `${OWNER},1.5`, `${OWNER},9007199254740992`, `${OWNER},9e3`]) {
  for (const key of ['PRODUCTION_PREVIEW_ALLOWED_CHAT_IDS', 'PRODUCTION_PREVIEW_RECIPIENT_CHAT_IDS']) {
    await check(`team config rejects ${key}=${JSON.stringify(ids)} before any effects`, async () => {
      const f = fixture({ ...teamEnv, [key]: ids });
      assert.throws(() => f.policy.previewOnlyConfig(), /not configured safely/);
      await assert.rejects(f.webhook(f.payload()), /not configured safely/); f.idle();
    });
  }
}
for (const who of [OWNER, OTHER]) {
  await check(`operator ${who} creates fresh Preview for exactly both recipients`, async () => {
    const f = fixture(teamEnv), u = f.payload(); u.message.chat.id = who; u.message.from.id = who;
    assert.equal((await f.webhook(u)).body, 'owner-preview-only');
    const job = await f.store.loadJob(who); assert.ok(job);
    assert.deepEqual(clone(job.recipientChatIds), [String(OWNER), String(OTHER)]);
    assert.equal(job.pendingRun, false); assert.equal(job.kind, 'preview');
    await f.policy.assertProductionInvocationAllowed(who, job.batchId);
    const claimed = await f.store.claimJob(who, job.batchId); assert.equal(claimed.status, 'running');
    assert.equal(f.effects.business + f.effects.sheets + f.effects.callbacks, 0); f.protectedIntact();
  });
  for (const text of ['/run', '/resume', '/stop', 'شحن']) await check(`team operator ${who} ${text} never releases work`, async () => {
    const f = fixture({ ...teamEnv, OPS_AUTOMATION_HOLD: undefined }), u = f.payload(text);
    u.message.chat.id = who; u.message.from.id = who; await f.webhook(u);
    assert.equal(f.effects.reads + f.effects.writes + f.effects.transactions + f.effects.publications.length + f.effects.business, 0);
    assert.equal(f.safety.automationHoldReason(), 'operator-reconciliation-hold'); f.protectedIntact();
  });
}
for (const [label, patch] of [
  ['third chat', { chat: { id: 900003, type: 'private' }, from: { id: 900003 } }],
  ['forged sender', { chat: { id: OTHER, type: 'private' }, from: { id: OWNER } }],
  ['group message', { chat: { id: OTHER, type: 'group' }, from: { id: OTHER } }],
  ['old date', { chat: { id: OTHER, type: 'private' }, from: { id: OTHER }, date: DATE - 1 }],
]) await check(`team rejects ${label} without effects`, async () => {
  const f = fixture(teamEnv), u = f.payload(); Object.assign(u.message, patch);
  assert.equal((await f.webhook(u)).body, 'ignored-owner-preview-only'); f.idle();
});
for (const recipients of [[String(OWNER)], [String(OTHER)], [String(OWNER), '900003'],
  [String(OWNER), String(OTHER), '900003'], [String(OWNER), String(OWNER)], [OWNER, OTHER]]) {
  await check(`team rejects stale or widened cursor recipients ${JSON.stringify(recipients)}`, () => {
    const f = fixture(teamEnv); assert.throws(() => f.policy.assertPreviewCursorInMode(OTHER, f.cursor({ recipientChatIds: recipients })), paused); f.idle();
  });
}
await check('team old single-recipient epoch cannot inherit new release', async () => {
  const f = fixture(teamEnv); f.seed(f.cursor({ previewOnlyEpoch: 'old_epoch_20261101' }), OTHER);
  const before = f.rows(); await assert.rejects(f.policy.assertProductionInvocationAllowed(OTHER, 'synthetic-batch'), paused);
  assert.deepEqual(f.rows(), before); assert.equal(f.effects.writes, 0); f.protectedIntact();
});
for (const who of [OWNER, OTHER]) await check(`team operator ${who} cancel preserves unparseable legacy Run`, async () => {
  const f = fixture(teamEnv), u = f.payload('/cancel'); u.message.chat.id = who; u.message.from.id = who;
  f.seed({ version: 1, batchId: 'legacy-run', kind: 'run' }, who); const before = f.rows();
  await f.webhook(u); assert.deepEqual(f.rows(), before);
  assert.equal(f.effects.writes + f.effects.publications.length + f.effects.business, 0); f.protectedIntact();
});
for (const job of [{ version: 1, batchId: 'unknown', kind: 'preview' }, { kind: 'run' }]) {
  await check(`native Preview-only cancel preserves unknown stored cursor ${JSON.stringify(job)}`, async () => {
    const f = fixture(teamEnv); f.seed(job, OTHER); const before = f.rows();
    await assert.rejects(f.store.clearJob(OTHER, UPDATE + 1), /cannot modify/);
    assert.deepEqual(f.rows(), before); assert.equal(f.effects.writes, 0); f.protectedIntact();
  });
}

// Run the existing pure/injected regressions without importing their business
// dependencies into the host process. Their assertions and source are unchanged.
// Deliberately exclude DB tests, live routes and any test that starts a server.
const priorPaths = ['src/scripts/testAutomationOutageSafety.ts', 'src/scripts/testOpsCairoSchedule.ts',
  'src/scripts/testOpsScheduler.ts', 'src/scripts/testReadinessLocationHold.ts', 'src/scripts/testLocationCatalog.ts'];
const priorDependencies = new Map(['src/services/automationSafety.ts', 'src/services/safeQueuePolicy.ts', 'src/services/opsScheduler.ts',
  'src/services/locationCatalogService.ts'].map(path => [path, readFileSync(new URL(path, root), 'utf8')]));
async function runPrior(path) {
  let uuid = 0, timers = 0, assertionCount = 0;
  const noEffect = () => { throw new Error('Prior regression attempted a real dependency'); };
  // Count existing assertions without changing their implementation or values.
  const countedAssert = new Proxy(assert, { get(target, key) {
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? (...args) => { assertionCount++; return value(...args); } : value;
  } });
  const context = vm.createContext({ Buffer, URL, Intl, process: { env: {} },
    console: { log: (...args) => console.log(`prior ${path}:`, ...args), warn() {}, error() {} },
    fetch: noEffect, WebSocket: noEffect,
    setTimeout: callback => { assert.ok(++timers <= 1000, 'Bounded synthetic microtask timer'); Promise.resolve().then(callback); return 0; },
    clearTimeout: noEffect,
  }, { codeGeneration: { strings: false, wasm: false } });
  const cache = new Map();
  const readTargets = new Set(['.github/workflows/vercel-cron.yml', 'api/production-continuation-queue.ts']);
  function resolve(specifier, from) {
    if (specifier === 'node:assert/strict') return countedAssert;
    if (specifier === 'node:crypto') return { timingSafeEqual, randomUUID: () => `synthetic-prior-${++uuid}` };
    if (specifier === 'node:fs') return { readFileSync: (target, encoding) => {
      assert.ok(readTargets.has(target)); assert.equal(encoding, 'utf8');
      if (target === '.github/workflows/vercel-cron.yml') {
        assert.ok(typeof workflowFixturePath === 'string' && workflowFixturePath,
          'Set READINESS_WORKFLOW_FIXTURE_PATH to the QA-only watchdog copy outside release source');
        return readFileSync(workflowFixturePath, encoding);
      }
      return readFileSync(new URL(target, root), encoding);
    } };
    const target = posix.normalize(posix.join(posix.dirname(from), specifier)).replace(/\.js$/, '.ts');
    if (target === 'src/lib/prisma.ts') return { prisma: new Proxy({}, { get: noEffect }), basePrisma: new Proxy({}, { get: noEffect }) };
    if (target === 'src/lib/logger.ts') return { logger: { warn() {}, error() {} } };
    assert.ok(priorDependencies.has(target), `Prior test import not allowlisted: ${target}`);
    if (!cache.has(target)) {
      const module = { exports: {} }; cache.set(target, module);
      execute(target, priorDependencies.get(target), module, false);
    }
    return cache.get(target).exports;
  }
  function execute(name, source, module, async) {
    const result = ts.transpileModule(source, { fileName: name, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } });
    assert.equal(result.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
    return new vm.Script(`(${async ? 'async ' : ''}function(require,module,exports){${result.outputText}\n})`, { filename: name })
      .runInContext(context)(id => resolve(id, name), module, module.exports);
  }
  await execute(path, readFileSync(new URL(path, root), 'utf8'), { exports: {} }, true);
  assert.ok(assertionCount > 0, 'Existing assertions actually executed');
  console.log(JSON.stringify({ prior: path, assertionsExecuted: assertionCount, realIO: 0 }));
}
for (const path of priorPaths) await check(`unchanged prior regression in isolated VM: ${path}`, () => runPrior(path));
await check('source snapshots stayed current during this offline run', () => {
  for (const [path, source] of sources) assert.equal(readFileSync(new URL(path, root), 'utf8'), source, `Source changed during run; rerun: ${path}`);
});
assert.equal(deniedOperations, 0, 'No unexpected imports, real network, timers or servers attempted');
console.log(JSON.stringify({ ok: failures === 0, checks, failures, realDatabaseConnections: 0,
  realNetworkCalls: 0, realQueuePublications: 0, realPreviewRuns: 0, serversStarted: 0,
  sourceModules: paths.length, deniedOperations }));
if (failures) process.exitCode = 1;
// Reused only by the manual-Run VM suite; importing this harness also runs all
// unchanged default-manual-false regressions above. No business module is loaded.
export { fixture, OWNER, OTHER, DATE, UPDATE, EPOCH };
