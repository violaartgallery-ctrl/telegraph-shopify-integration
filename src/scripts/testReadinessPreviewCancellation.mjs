// node --experimental-vm-modules src/scripts/testReadinessPreviewCancellation.mjs
// In-memory execution of the actual Preview service and assertJobLease only.
// All imports except pure crypto/TypeScript are synthetic; no handlers, real
// generation algorithms, Prisma clients, dotenv or provider/network I/O load.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const root = new URL('../services/', import.meta.url);
const sources = {};
for (const name of ['productionPreviewService', 'productionJobStore', 'productionPipelineErrors',
  'previewShipmentExclusion', 'orderEligibility']) {
  sources[name] = await readFile(new URL(`${name}.ts`, root), 'utf8');
}
const clone = value => structuredClone(value);
const photoUrl = 'https://synthetic.invalid/photo.png';
const fixture = {
  wordBase64: Buffer.from('synthetic-word').toString('base64'),
  productionEntries: [
    { display_product: 'Wallet', display_color: 'Black',
      source_orders: [{ order_name: '#900001', order_id: 'gid://shopify/Order/900001' }], photo_attachments: [
      { attachment_url: photoUrl, order_name: '#900001', position_label: 'inside' },
    ] },
    { display_product: 'Gift box', source_orders: [{ order_name: '#900001', order_id: 'gid://shopify/Order/900001' }], photo_attachments: [] },
  ],
  ordersDetail: [{ order_name: '#900001', items: [] }], warnings: [],
};
let cursor, live, data, hooks, sends, checkpoints, reads, generation, sourceLoads,
  sourceFetches, sourceSaves, fetches, bodyReads;
const noop = async () => {};
function reset() {
  cursor = { version: 2, kind: 'preview', batchId: 'synthetic-batch', status: 'running',
    executionToken: 'synthetic-lease', orderNumbers: ['#900001'], pendingRun: false,
    recipientChatIds: ['1', '2'], sentArtifactKeys: [], sentPhotoKeys: [],
    sourceFingerprint: 'fixed-fingerprint', unavailablePhotoUrls: [], attemptCount: 0, updatedAt: Date.now() };
  live = clone(cursor); data = clone(fixture);
  hooks = { read: noop, load: noop, fetchSource: noop, save: noop, checkpoint: noop,
    send: noop, laser: noop, box: noop, pdf: noop, summary: noop, fetch: noop, body: noop, sleep: noop };
  sends = []; checkpoints = []; reads = []; generation = [];
  sourceLoads = 0; sourceFetches = 0; sourceSaves = 0; fetches = 0; bodyReads = 0;
}
const cancel = () => { live = null; };
const forbidden = () => { throw new Error('Unapproved real operation'); };
const context = vm.createContext({ Buffer, Date, URL, console,
  process: { env: {} }, AbortSignal: { timeout: () => undefined },
  setTimeout: callback => { Promise.resolve().then(() => hooks.sleep()).then(callback); return 0; },
  fetch: async url => {
    assert.equal(url, photoUrl); fetches++; const override = await hooks.fetch();
    if (override) return override;
    return { ok: true, status: 200, arrayBuffer: async () => {
      bodyReads++; await hooks.body(); return Uint8Array.from([1, 2, 3]).buffer;
    } };
  },
});
const modules = new Map();
async function synthetic(key, values) {
  if (!modules.has(key)) {
    const m = new vm.SyntheticModule(Object.keys(values), function () {
      for (const [k, value] of Object.entries(values)) this.setExport(k, value);
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
  // Preserve the existing normal-mode lease/cancellation scenarios.
  if (specifier === './productionPreviewOnly.js') return synthetic(specifier, {
    previewOnlyConfig: () => undefined,
    manualRunConfig: () => undefined,
    isFreshOwnerPreviewMessage: () => false,
    isPreviewOperator: () => false,
    previewRecipientsMatch: () => false,
    assertPreviewCursorInMode: () => {},
    assertProductionRunAllowed: () => {},
  });
  if (specifier === 'node:crypto') return synthetic(specifier, { createHash, randomUUID: forbidden });
  if (specifier === './productionJobStore.js') return store;
  if (specifier === './productionPipelineErrors.js') return errors;
  if (specifier === './orderEligibility.js') return eligibility;
  if (specifier === './previewShipmentExclusion.js') return exclusion;
  if (specifier === '../shopify/shopifyOrdersClient.js') return synthetic(specifier, {
    shopifyOrdersClient: { listAllMatchingOrders: async () => [{ id: 900001, name: '#900001',
      order_number: 900001, confirmed: true, test: false, cancelled_at: null, fulfillment_status: null,
      financial_status: 'pending', gateway: 'cash_on_delivery', payment_gateway_names: ['cash_on_delivery'] }] },
  });
  if (specifier === '../lib/prisma.js') return synthetic(specifier, {
    // Actual exclusion helper reads an intentionally clean, in-memory ledger.
    // No write methods or real client exist; lease reads below remain separate.
    prisma: { shipmentRecord: { findMany: async () => [] }, failedPayload: { findMany: async () => [] } },
    basePrisma: {
    failedPayload: { findFirst: async args => {
      reads.push(clone(args)); await hooks.read();
      return live ? { payloadJson: JSON.stringify(live) } : null;
    } },
  } });
  if (specifier === '../telegram/telegramApi.js') return synthetic(specifier, {
    sendMessage: async (recipient, text) => {
      sends.push({ type: 'text', recipient, text }); await hooks.send(sends.at(-1)); return true;
    },
    sendDocument: async (recipient, buffer, filename, caption) => {
      sends.push({ type: 'document', recipient, buffer: Buffer.from(buffer), filename, caption });
      await hooks.send(sends.at(-1)); return true;
    },
  });
  if (specifier === './productionAgentClient.js') return synthetic(specifier, {
    extractOrderNumbers: () => ['#900001'],
    productionSourceFingerprint: () => 'fixed-fingerprint',
    fetchProductionBatch: async () => { sourceFetches++; await hooks.fetchSource(); return clone(data); },
  });
  if (specifier === './aiWriter.js') return synthetic(specifier, {
    buildBoxGridBuffers: async entries => {
      generation.push({ type: 'box', entries: clone(entries) });
      await hooks.box(); return [Buffer.from('synthetic-box')];
    },
  });
  if (specifier === './laser/laserFiles.js') return synthetic(specifier, {
    laserPhotoUrls: () => [],
    buildLaserArtifacts: async (entries, _photos, options) => {
      generation.push({ type: 'laser', entries: clone(entries), options: clone(options) });
      await hooks.laser();
      return [{ buffer: Buffer.from('synthetic-laser'), kind: 'wallet', label: 'Synthetic wallet' }];
    },
  });
  if (specifier === './printSheet.js') return synthetic(specifier, {
    kindForProduct: () => 'wallet', printPhotoSourceUrl: url => url,
    buildPrintSheetPdf: async photos => {
      generation.push({ type: 'pdf', count: photos.length, sources: clone(photos.map(photo => photo.source)) }); await hooks.pdf(photos);
      return Buffer.from('synthetic-pdf');
    },
  });
  if (specifier === './orderSummaryWriter.js') return synthetic(specifier, {
    buildOrdersSummaryBuffer: async orders => {
      generation.push({ type: 'summary', count: orders.length }); await hooks.summary();
      return Buffer.from('synthetic-summary');
    },
  });
  throw new Error(`Unapproved import blocked: ${specifier}`);
}
async function compile(name) {
  const transpiled = ts.transpileModule(sources[name], { reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
  assert.equal(transpiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  const m = new vm.SourceTextModule(transpiled.outputText, {
    context, identifier: name, importModuleDynamically: resolve,
  });
  await m.link(resolve); await m.evaluate(); return m;
}
const errors = await compile('productionPipelineErrors');
const store = await compile('productionJobStore');
const eligibility = await compile('orderEligibility');
const exclusion = await compile('previewShipmentExclusion');
const preview = await compile('productionPreviewService');
const lost = error => error.name === 'ProductionJobLeaseLostError';
async function run(snapshotPresent = true) {
  return preview.namespace.sendCompleteProductionPreview({
    chatId: 1, cursor, deadline: Date.now() + 60000,
    checkpoint: async () => {
      await store.namespace.assertJobLease(1, cursor.batchId, cursor.executionToken);
      checkpoints.push(clone(cursor)); live = clone(cursor); await hooks.checkpoint();
    },
    sourceSnapshot: {
      load: async () => { sourceLoads++; await hooks.load(); return snapshotPresent ? clone(data) : null; },
      save: async () => { sourceSaves++; await hooks.save(); },
    },
  });
}
function markArtifacts(keys) {
  for (const key of keys) for (const recipient of cursor.recipientChatIds) {
    cursor.sentArtifactKeys.push(`${recipient}|${key}:fixed-fingerprint`);
  }
  cursor.artifactManifest = { laserFileCount: 1, boxFileCount: 1, uniquePhotoCount: 1 };
}
const earlyArtifacts = ['word', 'laser:1', 'box:1'];
const allDocs = [...earlyArtifacts, 'print-sheet', 'orders-summary'];
let checks = 0;
async function check(name, fn) { reset(); await fn(); checks++; console.log(`ok ${checks} - ${name}`); }

await check('cancelled entry makes no source read or external operation', async () => {
  cancel(); await assert.rejects(run(), lost);
  assert.equal(sourceLoads + sourceFetches + fetches + sends.length, 0);
});
await check('lease read failure fails closed before any work', async () => {
  hooks.read = async () => { throw new Error('synthetic lease store unavailable'); };
  await assert.rejects(run(), /lease store unavailable/); assert.equal(sends.length, 0);
});
await check('cancel during slow snapshot read prevents source fetch and sends', async () => {
  hooks.load = cancel; await assert.rejects(run(false), lost);
  assert.equal(sourceLoads, 1); assert.equal(sourceFetches + sourceSaves + sends.length, 0);
});
await check('cancel during slow source fetch prevents snapshot save and sends', async () => {
  hooks.fetchSource = cancel; await assert.rejects(run(false), lost);
  assert.equal(sourceFetches, 1); assert.equal(sourceSaves + sends.length, 0);
});
await check('cancel during snapshot save prevents first artifact', async () => {
  hooks.save = cancel; await assert.rejects(run(false), lost);
  assert.equal(sourceSaves, 1); assert.equal(sends.length, 0);
});
await check('initial progress send cannot be followed by reads after cancellation', async () => {
  cursor.orderNumbers = []; hooks.send = cancel;
  await assert.rejects(run(), lost); assert.equal(sends.length, 1); assert.equal(sourceLoads, 0);
});
await check('each document recipient is fenced after prior confirmed receipt', async () => {
  hooks.checkpoint = () => { if (cursor.sentArtifactKeys.length === 1) cancel(); };
  await assert.rejects(run(), lost); assert.equal(sends.length, 1);
  assert.equal(sends[0].recipient, '1');
  assert.deepEqual(cursor.sentArtifactKeys, ['1|word:fixed-fingerprint']);
  assert.deepEqual(checkpoints.at(-1).sentArtifactKeys, cursor.sentArtifactKeys);
});
await check('cancel after slow laser generation prevents next generation and laser send', async () => {
  hooks.laser = cancel; await assert.rejects(run(), lost);
  assert.deepEqual(generation.map(g => g.type), ['laser']);
  assert.ok(sends.every(send => !send.filename?.endsWith('.ai')));
});
await check('cancel after slow box generation prevents generated artifact sends', async () => {
  hooks.box = cancel; await assert.rejects(run(), lost);
  assert.deepEqual(generation.map(g => g.type), ['laser', 'box']);
  assert.ok(sends.every(send => !send.filename?.endsWith('.ai')));
});
await check('photo retry revalidates after backoff, without another download', async () => {
  markArtifacts(allDocs);
  hooks.fetch = async () => { throw new Error('synthetic network timeout'); };
  hooks.sleep = cancel;
  await assert.rejects(run(), lost); assert.equal(fetches, 1); assert.equal(sends.length, 0);
  assert.deepEqual(clone(cursor.unavailablePhotoUrls), []);
});
await check('cancel during fetch prevents body read and recipient send', async () => {
  markArtifacts(allDocs); hooks.fetch = cancel;
  await assert.rejects(run(), lost); assert.equal(fetches, 1); assert.equal(bodyReads, 0);
  assert.equal(sends.length, 0);
});
await check('cancel during slow body read prevents send without retrying cancellation', async () => {
  markArtifacts(allDocs); hooks.body = cancel;
  await assert.rejects(run(), lost); assert.equal(fetches, 1); assert.equal(bodyReads, 1);
  assert.equal(sends.length, 0); assert.deepEqual(clone(cursor.unavailablePhotoUrls), []);
});
await check('each photo recipient is fenced and prior confirmation retained', async () => {
  markArtifacts(allDocs);
  hooks.checkpoint = () => { if (cursor.sentPhotoKeys.length) cancel(); };
  await assert.rejects(run(), lost); assert.equal(sends.length, 1);
  assert.deepEqual(cursor.sentPhotoKeys, [`1|${photoUrl}`]);
  assert.deepEqual(checkpoints.at(-1).sentPhotoKeys, cursor.sentPhotoKeys);
});
await check('print-sheet download retries also fence cancellation', async () => {
  markArtifacts(earlyArtifacts); data.productionEntries[0].photo_attachments[0].position_label = '';
  hooks.fetch = async () => { throw new Error('synthetic network timeout'); }; hooks.sleep = cancel;
  await assert.rejects(run(), lost); assert.equal(fetches, 1); assert.equal(generation.length, 0);
});
await check('slow print-sheet generation is fenced before PDF delivery', async () => {
  markArtifacts(earlyArtifacts); data.productionEntries[0].photo_attachments[0].position_label = '';
  hooks.pdf = cancel; await assert.rejects(run(), lost);
  assert.equal(fetches, 1); assert.equal(sends.length, 0);
});
await check('slow orders-summary generation is fenced before its delivery', async () => {
  markArtifacts([...earlyArtifacts, 'print-sheet']); cursor.sentPhotoKeys = [`1|${photoUrl}`, `2|${photoUrl}`];
  hooks.summary = cancel; await assert.rejects(run(), lost); assert.equal(sends.length, 0);
});
await check('plain-text summary is fenced per recipient', async () => {
  markArtifacts(allDocs); cursor.sentPhotoKeys = [`1|${photoUrl}`, `2|${photoUrl}`];
  hooks.checkpoint = () => { if (cursor.sentArtifactKeys.some(key => key.includes('|summary:'))) cancel(); };
  await assert.rejects(run(), lost); assert.equal(sends.length, 1); assert.equal(sends[0].type, 'text');
});
await check('active lease preserves original keys, generation inputs and artifact bytes', async () => {
  await run();
  const digest = createHash('sha256').update('').digest('hex').slice(0, 12);
  const expected = ['word:fixed-fingerprint', 'laser:1:fixed-fingerprint', 'box:1:fixed-fingerprint',
    'orders-summary:fixed-fingerprint', `summary:fixed-fingerprint:${digest}`];
  assert.deepEqual(cursor.sentArtifactKeys, expected.flatMap(key => ['1', '2'].map(id => `${id}|${key}`)));
  assert.deepEqual(cursor.sentPhotoKeys, [`1|${photoUrl}`, `2|${photoUrl}`]);
  assert.deepEqual(generation[0], { type: 'laser', entries: fixture.productionEntries, options: { maxBytes: 1500000 } });
  assert.deepEqual(generation[1], { type: 'box', entries: fixture.productionEntries });
  assert.equal(sends.find(send => send.filename?.endsWith('.ai')).buffer.toString(), 'synthetic-laser');
  assert.equal(fetches, 1); assert.ok(reads.length > sends.length);
  for (const read of reads) assert.deepEqual(read.where, { source: 'prod_job', reason: '1' });
});
await check('print photo source retains exact order/product and stable print number', async () => {
  markArtifacts(earlyArtifacts); data.productionEntries[0].photo_attachments[0].position_label = '';
  await run(); assert.deepEqual(generation.find(g => g.type === 'pdf').sources,
    [{ orderName: '#900001', product: 'Wallet Black', photoNumber: 1 }]);
});
await check('bad print photo permanently blocks completion without losing prior receipts', async () => {
  markArtifacts(earlyArtifacts); const before = clone(cursor.sentArtifactKeys);
  data.productionEntries[0].photo_attachments[0].position_label = '';
  hooks.pdf = async photos => { throw new errors.namespace.PrintPhotoDecodeError(photos[0].source); };
  await assert.rejects(run(), error => error instanceof errors.namespace.PermanentProductionError &&
    error.message.includes('#900001'));
  assert.equal(sends.length, 0); assert.deepEqual(cursor.sentArtifactKeys, before);
  assert.equal(cursor.sentPhotoKeys.length, 0); assert.equal(cursor.attemptCount, 0);
  assert.deepEqual(clone(cursor.unavailablePhotoUrls), []);
});
await check('print HTTP404 is permanent with order context, never omitted', async () => {
  markArtifacts(earlyArtifacts); data.productionEntries[0].photo_attachments[0].position_label = '';
  hooks.fetch = async () => ({ ok: false, status: 404 });
  await assert.rejects(run(), error => error instanceof errors.namespace.PermanentProductionError &&
    /#900001/.test(error.message) && /HTTP 404/.test(error.message));
  assert.equal(fetches, 1); assert.equal(bodyReads, 0); assert.equal(sends.length, 0);
  assert.deepEqual(clone(cursor.unavailablePhotoUrls), []);
});
await check('print transport failure retains bounded retries and is not called corrupt data', async () => {
  markArtifacts(earlyArtifacts); data.productionEntries[0].photo_attachments[0].position_label = '';
  hooks.fetch = async () => { throw new Error('synthetic network timeout'); };
  await assert.rejects(run(), error => !(error instanceof errors.namespace.PermanentProductionError) &&
    /synthetic network timeout/.test(error.message));
  assert.equal(fetches, 3); assert.equal(sends.length, 0); assert.equal(generation.length, 0);
});
console.log(JSON.stringify({ ok: true, checks, realNetworkCalls: 0, databaseConnections: 0,
  liveHandlersLoaded: 0, realGenerationModulesLoaded: 0 }));
