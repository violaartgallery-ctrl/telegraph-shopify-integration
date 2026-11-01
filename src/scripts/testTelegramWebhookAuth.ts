/** Offline tests: the webhook must reject unauthenticated updates before any network or database call. */
import assert from 'node:assert/strict';
import { handler } from '../netlify/functions/telegram-webhook.js';

let networkCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  networkCalls++;
  throw new Error('Offline Telegram webhook test attempted a network request');
};

const SECRET = 'telegram-webhook-test-secret';
const runUpdate = JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: 6776051391, type: 'private' }, text: 'شحن' } });
const event = (headers: Record<string, string | undefined>, body: string | null = runUpdate, httpMethod = 'POST') =>
  ({ httpMethod, headers, body });

let checks = 0;
const check = (condition: boolean, label: string) => { assert.ok(condition, label); checks++; };

delete process.env.TELEGRAM_WEBHOOK_SECRET;
let result = await handler(event({ 'x-telegram-bot-api-secret-token': SECRET }));
check(result.statusCode === 503, 'missing TELEGRAM_WEBHOOK_SECRET must fail closed');

process.env.TELEGRAM_WEBHOOK_SECRET = '   ';
result = await handler(event({}));
check(result.statusCode === 503, 'a blank secret counts as not configured');

process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
for (const provided of [undefined, '', 'wrong', `${SECRET}x`, SECRET.slice(0, -1)]) {
  result = await handler(event({ 'x-telegram-bot-api-secret-token': provided }));
  check(result.statusCode === 401, `secret ${JSON.stringify(provided)} is rejected`);
}
check(networkCalls === 0, 'rejected updates never reach Telegram, the sheet or the job queue');

// Authenticated updates that carry no work return before any side effect.
result = await handler(event({ 'x-telegram-bot-api-secret-token': SECRET }, JSON.stringify({ update_id: 2 })));
check(result.statusCode === 200, 'authenticated empty update is acknowledged');
result = await handler(event({ 'x-telegram-bot-api-secret-token': SECRET }, null, 'GET'));
check(result.statusCode === 200, 'authenticated non-POST is acknowledged');
result = await handler(event({ 'x-telegram-bot-api-secret-token': SECRET }, '{not json'));
check(result.statusCode === 200, 'authenticated malformed body is acknowledged without work');
check(networkCalls === 0, 'no-op updates make no external call');

globalThis.fetch = originalFetch;
console.log(JSON.stringify({ ok: true, checks, externalCalls: networkCalls }));
