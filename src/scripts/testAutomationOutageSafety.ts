import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { automationHoldReason, assertAutomationReleased, AutomationPausedError, isDatabaseQuotaError, opsControlRetry } from '../services/automationSafety.js';
import { OpsScheduler, OPS_INTERVALS, type OpsDependencies, type OpsLane, type OpsState } from '../services/opsScheduler.js';

let checks = 0;
function check(value: unknown, message?: string) { assert.ok(value, message); checks++; }
const quota = new Error('Your compute time quota is exceeded. Upgrade your plan or wait until next month.');
check(isDatabaseQuotaError(quota));
check(isDatabaseQuotaError({ cause: { meta: { database_error: 'compute allowance exhausted' } } }));
check(!isDatabaseQuotaError(new Error("Can't reach database server")));
check(!isDatabaseQuotaError(new Error('Unique constraint failed')));
const cycle: Record<string, unknown> = {}; cycle.cause = cycle;
check(!isDatabaseQuotaError(cycle));
assert.deepEqual(opsControlRetry(quota, 1), { acknowledge: true }); checks++;
assert.deepEqual(opsControlRetry(new Error('cold start'), 1), { afterSeconds: 300 }); checks++;
assert.deepEqual(opsControlRetry(new Error('cold start'), 2), { afterSeconds: 1800 }); checks++;
assert.deepEqual(opsControlRetry(new Error('cold start'), 3), { acknowledge: true }); checks++;

let now = 1_800_000_000_000;
let hold: string | undefined = 'operator-reconciliation-hold';
let dbCalls = 0, publications = 0, runs = 0;
const blocked = () => { dbCalls++; throw quota; };
const dependencies: OpsDependencies = {
  now: () => now, enabled: () => true, holdReason: () => hold,
  read: blocked, mutate: blocked,
  publish: async () => { publications++; }, run: async () => { runs++; },
};
const scheduler = new OpsScheduler(dependencies);
// 72h outage, 30-minute watchdog and all three lanes, no Neon/queue/API traffic.
for (let minute = 0; minute < 72 * 60; minute += 30) {
  now = 1_800_000_000_000 + minute * 60_000;
  assert.equal((await scheduler.ensure()).fallbackAllowed, false);
  assert.equal((await scheduler.health()).reason, hold);
  for (const lane of Object.keys(OPS_INTERVALS) as OpsLane[]) {
    const slot = Math.floor(now / OPS_INTERVALS[lane]) * OPS_INTERVALS[lane];
    assert.equal((await scheduler.tick({ version: 1, lane, slot })).skipped, hold);
  }
  checks += 5;
}
check(dbCalls === 0 && publications === 0 && runs === 0, 'hold must not depend on a working database');
// A quota encountered WITHOUT the operator flag still cannot extend recurrence.
hold = undefined;
const result = await scheduler.ensure();
check(result.reason === 'database-quota-exhausted' && !result.fallbackAllowed);
await assert.rejects(scheduler.tick({ version: 1, lane: 'financial', slot: now }), /quota/); checks++;
check(publications === 0 && runs === 0);
// Stale control messages do not touch database state at all.
const before = dbCalls;
assert.equal((await scheduler.tick({ version: 1, lane: 'financial', slot: now - 3 * OPS_INTERVALS.financial })).skipped, 'stale-control-tick'); checks++;
check(dbCalls === before);

// A cold/transient database can recover with the original leases and identities.
const states = new Map<OpsLane, OpsState>();
const healthy = new OpsScheduler({ ...dependencies,
  read: async (lane) => states.get(lane) ?? {},
  mutate: async (lane, change) => { const r = change(states.get(lane) ?? {}); states.set(lane, r.state); return r.result; },
});
await healthy.tick({ version: 1, lane: 'financial', slot: now });
check(publications === 1 && runs === 1);
await healthy.tick({ version: 1, lane: 'financial', slot: now });
check(publications === 1 && runs === 1, 'duplicate must not publish another recurrence');

const saved = process.env.OPS_AUTOMATION_HOLD;
try {
  process.env.OPS_AUTOMATION_HOLD = 'neon-quota-reconciliation-required';
  check(Boolean(automationHoldReason()));
  assert.throws(assertAutomationReleased, AutomationPausedError); checks++;
  delete process.env.OPS_AUTOMATION_HOLD;
  assertAutomationReleased(); checks++;
} finally {
  if (saved === undefined) delete process.env.OPS_AUTOMATION_HOLD; else process.env.OPS_AUTOMATION_HOLD = saved;
}
const workflow = readFileSync('.github/workflows/vercel-cron.yml', 'utf8');
check(workflow.includes("if: vars.OPS_AUTOMATION_HOLD != 'true'"));
check(workflow.includes("needs.scheduler.outputs.fallback_allowed == 'true'"));
check(!workflow.includes("needs.scheduler.outputs.primary_healthy != 'true'"));
const consumer = readFileSync('api/production-continuation-queue.ts', 'utf8');
check(consumer.includes('assertAutomationReleased();'));
check(consumer.includes('return { afterSeconds: 3600 }'), 'business continuations must not be acknowledged on outage');
console.log(JSON.stringify({ ok: true, checks, simulatedHours: 72, externalCalls: 0 }));
