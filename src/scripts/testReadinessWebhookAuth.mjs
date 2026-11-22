// Actual webhook auth code, in-memory transpilation with every effect denied.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { timingSafeEqual } from 'node:crypto';
const require = createRequire(import.meta.url), ts = require('typescript');
const source = readFileSync(new URL('../netlify/functions/telegram-webhook.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
let effects = 0, checks = 0;
const denied = () => { effects++; throw new Error('Real effect denied'); };
class ReplayError extends Error {}
const modules = {
  '../../services/productionPreviewOnly.js': { previewOnlyConfig: () => undefined, manualRunConfig: () => undefined },
  '@vercel/functions': { waitUntil: denied }, 'node:crypto': { timingSafeEqual },
  '../../telegram/telegramApi.js': { answerCallbackQuery: denied, sendMessage: denied },
  './run-production-background.js': { productionRecipientChatIds: denied },
  '../../services/productionContinuation.js': { scheduleProductionContinuation: denied },
  '../../services/productionJobStore.js': { clearJob: denied, createPreviewJob: denied, loadJob: denied, queueRun: denied, ProductionTelegramUpdateReplayError: ReplayError },
  '../../telegram/sheetsClient.js': { isAllowed: denied, getUser: denied, getActiveUsers: denied, forceRefresh: denied },
};
const context = vm.createContext({ Buffer, console, process: { env: {} }, fetch: denied });
const module = { exports: {} };
new vm.Script(`(function(require,module,exports){${compiled.outputText}\n})`).runInContext(context)(id => {
  if (!(id in modules)) throw new Error(`Unapproved import ${id}`); return modules[id];
}, module, module.exports);
const handler = module.exports.handler;
const event = token => ({ httpMethod: 'POST', headers: token === undefined ? {} : { 'x-telegram-bot-api-secret-token': token }, body: JSON.stringify({ update_id: 1 }) });
for (const missing of [undefined, '', '   ']) {
  context.process.env.TELEGRAM_WEBHOOK_SECRET = missing;
  assert.equal((await handler(event('anything'))).statusCode, 503); checks++;
}
context.process.env.TELEGRAM_WEBHOOK_SECRET = 'synthetic-secret';
for (const wrong of [undefined, '', 'wrong', 'synthetic-secrex', 'سرّي']) {
  assert.equal((await handler(event(wrong))).statusCode, 401); checks++;
}
assert.equal((await handler(event('synthetic-secret'))).statusCode, 200); checks++;
assert.equal((await handler({ ...event('synthetic-secret'), body: '{invalid' })).statusCode, 200); checks++;
assert.equal((await handler({ ...event('synthetic-secret'), body: '{}' })).statusCode, 400); checks++;
assert.equal(effects, 0); checks++;
console.log(JSON.stringify({ ok: true, checks, actualEffects: effects, isolation: 'VM synthetic imports; no DB/network/queue' }));
