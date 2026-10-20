import assert from 'node:assert/strict';
import { OpsScheduler, OPS_INTERVALS, authorizedCron, parseOpsTick, type OpsState, type OpsLane, type OpsTick } from '../services/opsScheduler.js';

let now = 1_800_000_000_000;
let enabled = true;
const states = new Map<OpsLane, OpsState>();
const messages: Array<{ tick: OpsTick; delaySeconds: number; retentionSeconds: number; idempotencyKey: string }> = [];
let runs = 0;
let failure = false;
let publishFailure = false;
let hold: Promise<void> | undefined;
const scheduler = new OpsScheduler({
  now: () => now, enabled: () => enabled,
  read: async (lane) => states.get(lane) ?? {},
  mutate: async (lane, change) => { const r = change(states.get(lane) ?? {}); states.set(lane, r.state); return r.result; },
  publish: async (tick, options) => { if (publishFailure) throw Error('queue unavailable'); messages.push({ tick, ...options }); },
  run: async () => { assert.ok(messages.length > 0, 'the next wake must be durable before work begins'); runs++; if (hold) await hold; if (failure) throw Error('service unavailable'); return { ok: true }; },
});

assert.equal(parseOpsTick(null), null);
assert.equal(parseOpsTick({ version: 1, lane: 'constructor', slot: now }), null);
assert.equal(parseOpsTick({ version: 1, lane: 'financial', slot: 1 }), null);
assert.equal(parseOpsTick({ version: 2, lane: 'financial', slot: now }), null);
assert.deepEqual(parseOpsTick({ version: 1, lane: 'financial', slot: now }), { version: 1, lane: 'financial', slot: now });
await scheduler.ensure(); await scheduler.ensure();
assert.equal(messages.length, 6);
assert.equal(messages[0]!.idempotencyKey, messages[3]!.idempotencyKey);
assert.ok(messages.every((m) => m.retentionSeconds === 86400 && m.delaySeconds === 0));
assert.equal((await scheduler.health()).ok, false, 'publishing is not evidence of successful work');

let release!: () => void;
hold = new Promise<void>((resolve) => { release = resolve; });
const tick = { version: 1 as const, lane: 'financial' as const, slot: now };
const first = scheduler.tick(tick);
while (runs === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
assert.deepEqual(await scheduler.tick(tick), { skipped: 'completed-or-leased' });
assert.equal(runs, 1);
release(); await first; hold = undefined;
assert.deepEqual(await scheduler.tick(tick), { skipped: 'completed-or-leased' });
assert.equal(runs, 1);
assert.equal(states.get('financial')!.completedSlot, tick.slot);
assert.equal(states.get('financial')!.token, undefined);
assert.equal((await scheduler.health()).lanes.find((l) => l.lane === 'financial')!.healthy, true);

now += OPS_INTERVALS.financial;
failure = true;
await assert.rejects(scheduler.tick({ ...tick, slot: now }), /service unavailable/);
assert.equal(states.get('financial')!.leaseUntil, 0);
assert.ok(states.get('financial')!.nextAt! > now, 'work failure must not break recurrence');
failure = false;
await scheduler.tick({ ...tick, slot: now });
assert.equal(states.get('financial')!.lastError, undefined);
const before = runs;
now += OPS_INTERVALS.financial;
publishFailure = true;
await assert.rejects(scheduler.tick({ ...tick, slot: now }), /queue unavailable/);
assert.equal(runs, before, 'never execute if the next wake cannot be made durable');
publishFailure = false;
enabled = false;
const sent = messages.length;
assert.deepEqual(await scheduler.tick({ ...tick, slot: now }), { skipped: 'disabled-outside-production' });
await scheduler.ensure(); assert.equal(messages.length, sent);
assert.equal((await scheduler.health()).ok, false);
enabled = true;
await assert.rejects(scheduler.tick({ ...tick, slot: now + OPS_INTERVALS.financial }), /before its scheduled slot/);
now += OPS_INTERVALS.financial * 4;
assert.equal((await scheduler.health()).lanes.find((l) => l.lane === 'financial')!.healthy, false);

const old = process.env.CRON_SECRET;
delete process.env.CRON_SECRET; assert.equal(authorizedCron('Bearer anything'), false);
process.env.CRON_SECRET = 'test-only-secret';
assert.equal(authorizedCron(undefined), false);
assert.equal(authorizedCron('Bearer test-only-secret'), true);
assert.equal(authorizedCron('Bearer wrong'), false);
if (old === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = old;
console.log(JSON.stringify({ ok: true, checks: 31, lanes: Object.keys(OPS_INTERVALS), externalCalls: 0 }));
