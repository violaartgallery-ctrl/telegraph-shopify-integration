import assert from 'node:assert/strict';
import { OpsScheduler, cairoBusinessSchedule as schedule, parseOpsTick, type OpsLane, type OpsState, type OpsTick } from '../services/opsScheduler.js';

let checks = 0;
function check(value: unknown, message?: string) { assert.ok(value, message); checks++; }
const HOUR = 3_600_000;
const lanes: OpsLane[] = ['status', 'discovery', 'financial'];
const cairoTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const cairoDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' });
const slotsBetween = (lane: OpsLane, from: number, to: number) => {
  const slots: number[] = [];
  for (let slot = schedule.next(lane, from - 1); slot < to; slot = schedule.next(lane, slot)) slots.push(slot);
  return slots;
};
const perCairoDay = (lane: OpsLane, from: number, to: number) => {
  const counts = new Map<string, number>();
  for (const slot of slotsBetween(lane, from, to)) counts.set(cairoDate.format(slot), (counts.get(cairoDate.format(slot)) ?? 0) + 1);
  return counts;
};

// December is Egyptian standard time (UTC+2): 08:00 UTC is 10:00 Cairo.
const tenAm = Date.UTC(2026, 11, 1, 8);
assert.equal(cairoTime.format(tenAm), '10:00', 'test fixture assumes Cairo UTC+2 in December');
check(schedule.isSlot('status', tenAm) && schedule.isSlot('financial', tenAm) && schedule.isSlot('discovery', tenAm), 'day starts at 10:00 for every lane');
check(schedule.isSlot('status', tenAm + HOUR / 2) && !schedule.isSlot('discovery', tenAm + HOUR / 2), 'status every 30 min, discovery hourly');
check(!schedule.isSlot('status', tenAm - HOUR / 2), '09:30 Cairo is overnight and not an even UTC hour');
check(schedule.isSlot('status', tenAm - 2 * HOUR), '08:00 Cairo is a 2-hour overnight wake');
check(!schedule.isSlot('status', tenAm + 12.5 * HOUR) && schedule.isSlot('status', tenAm + 14 * HOUR), 'no 22:30 wake; next is 00:00');
check(!schedule.isSlot('financial', tenAm + 5 * 60_000), 'old 5-minute slots are off schedule');

// Exactly 30 shared wakes per normal day, winter and Egyptian summer time.
for (const [label, from] of [['2026-12-01', Date.UTC(2026, 10, 29)], ['2026-07-01', Date.UTC(2026, 5, 29)]] as const) {
  const to = from + 4 * 24 * HOUR;
  assert.equal(perCairoDay('status', from, to).get(label), 30, `${label} status`); checks++;
  assert.equal(perCairoDay('financial', from, to).get(label), 30, `${label} financial`); checks++;
  assert.equal(perCairoDay('discovery', from, to).get(label), 18, `${label} discovery`); checks++;
}

// DST changes (24 April and 29 October 2026) never break the slot invariants.
for (const [from, to] of [[Date.UTC(2026, 3, 22), Date.UTC(2026, 3, 27)], [Date.UTC(2026, 9, 27), Date.UTC(2026, 10, 1)], [Date.UTC(2026, 10, 29), Date.UTC(2026, 11, 3)]]) {
  for (const lane of lanes) {
    for (let at = from; at < to; at += 7 * 60_000) {
      const floor = schedule.floor(lane, at), next = schedule.next(lane, at);
      assert.ok(schedule.isSlot(lane, floor) && floor <= at && next > at && schedule.isSlot(lane, next) && schedule.next(lane, floor) > at, `${lane} ${new Date(at).toISOString()}`);
    }
    const slots = slotsBetween(lane, from, to);
    check(slots.every((slot, i) => i === 0 || slot - slots[i - 1]! <= 2 * HOUR), `${lane} never waits more than 2 hours`);
    check(slots.every((slot) => parseOpsTick({ version: 1, lane, slot })), `${lane} slots pass queue validation`);
  }
  const status = new Set(slotsBetween('status', from, to));
  check(slotsBetween('financial', from, to).every((slot) => status.has(slot)) && slotsBetween('discovery', from, to).every((slot) => status.has(slot)), 'all lanes wake together');
  for (const label of new Set(slotsBetween('status', from, to).map((slot) => cairoDate.format(slot)))) {
    const count = perCairoDay('status', from - 24 * HOUR, to + 24 * HOUR).get(label)!;
    assert.ok(count >= 29 && count <= 31, `${label} has ${count} wakes`);
  }
  checks++;
}

// Scheduler wiring: shared wakes, aligned recurrence, old ticks die out without Neon.
let now = tenAm + 5 * 60_000;
let dbCalls = 0;
const states = new Map<OpsLane, OpsState>();
const published: OpsTick[] = [];
const scheduler = new OpsScheduler({
  schedule, now: () => now, enabled: () => true,
  read: async (lane) => { dbCalls++; return states.get(lane) ?? {}; },
  mutate: async (lane, change) => { dbCalls++; const r = change(states.get(lane) ?? {}); states.set(lane, r.state); return r.result; },
  publish: async (tick) => { published.push(tick); },
  run: async () => ({ ok: true }),
});
await scheduler.ensure();
check(published.length === 3 && published.every((tick) => tick.slot === tenAm), 'ensure republishes the shared 10:00 wake');
published.length = 0;
await scheduler.tick({ version: 1, lane: 'status', slot: tenAm });
await scheduler.tick({ version: 1, lane: 'discovery', slot: tenAm });
check(published[0]!.slot === tenAm + HOUR / 2 && published[1]!.slot === tenAm + HOUR, 'next status 10:30, next discovery 11:00');
const before = dbCalls;
assert.deepEqual(await scheduler.tick({ version: 1, lane: 'financial', slot: tenAm + 5 * 60_000 }), { skipped: 'off-schedule-tick' }); checks++;
check(dbCalls === before, 'old-cadence ticks never touch Neon');

now = tenAm + 13 * HOUR + 10 * 60_000; // 23:10 Cairo
published.length = 0;
await scheduler.ensure();
check(published.every((tick) => tick.slot === tenAm + 12 * HOUR), 'overnight floor is the 22:00 wake');
published.length = 0;
await scheduler.tick({ version: 1, lane: 'status', slot: tenAm + 12 * HOUR });
check(published[0]!.slot === tenAm + 14 * HOUR, 'next overnight wake is 00:00, not 22:30');
now = tenAm + 15.5 * HOUR; // 01:30 Cairo
check((await scheduler.health()).lanes.find((l) => l.lane === 'status')!.healthy, 'one 2-hour gap is healthy');
now = tenAm + 20 * HOUR; // 06:00 Cairo, missed 00:00/02:00/04:00
check(!(await scheduler.health()).lanes.find((l) => l.lane === 'status')!.healthy, 'three missed night wakes are unhealthy');

// One full Cairo day driven only by the durable chain: 30 wakes, 78 lane runs.
const dayStart = Date.UTC(2026, 11, 1, 22); // 00:00 Cairo, 2 December
const dayEnd = dayStart + 24 * HOUR;
const queue: OpsTick[] = [];
const runs: Record<OpsLane, number> = { status: 0, discovery: 0, financial: 0 };
const wakes = new Set<number>();
const simStates = new Map<OpsLane, OpsState>();
let clock = dayStart;
const sim = new OpsScheduler({
  schedule, now: () => clock, enabled: () => true,
  read: async (lane) => simStates.get(lane) ?? {},
  mutate: async (lane, change) => { const r = change(simStates.get(lane) ?? {}); simStates.set(lane, r.state); return r.result; },
  publish: async (tick) => { queue.push(tick); },
  run: async (lane) => { runs[lane]++; wakes.add(clock); return { ok: true }; },
});
await sim.ensure();
while (queue.length) {
  queue.sort((a, b) => a.slot - b.slot);
  const tick = queue.shift()!;
  if (tick.slot >= dayEnd) continue;
  clock = Math.max(clock, tick.slot);
  await sim.tick(tick);
}
assert.deepEqual(runs, { status: 30, discovery: 18, financial: 30 }); checks++;
check(wakes.size === 30, 'one shared wake per slot instead of 528 lane slots');

console.log(JSON.stringify({ ok: true, checks, wakesPerDay: wakes.size, laneRunsPerDay: runs, externalCalls: 0 }));
