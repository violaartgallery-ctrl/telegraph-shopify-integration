import { randomUUID, timingSafeEqual } from 'node:crypto';
import { isDatabaseQuotaError } from './automationSafety.js';
import { safeQueueConfig, safeQueueHoldReason, safeQueueReleaseRequested } from './safeQueuePolicy.js';

export const OPS_TOPIC = 'viola-ops-scheduler';
// PostgreSQL advisory locks return void. Project a supported scalar so Prisma
// can deserialize the result while keeping the lock in this transaction.
export const OPS_LOCK_SQL = 'SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext($1))';
export const OPS_INTERVALS = { status: 600_000, discovery: 900_000, financial: 300_000 } as const;
export type OpsLane = keyof typeof OPS_INTERVALS;

/** Which instants a lane may wake. Slots are epoch milliseconds. */
export interface OpsSchedule {
  isSlot(lane: OpsLane, slot: number): boolean;
  /** Latest slot at or before `at`. */
  floor(lane: OpsLane, at: number): number;
  /** First slot strictly after `after`. */
  next(lane: OpsLane, after: number): number;
}

export function fixedIntervalSchedule(intervals: Record<OpsLane, number>): OpsSchedule {
  return {
    isSlot: (lane, slot) => slot % intervals[lane] === 0,
    floor: (lane, at) => Math.floor(at / intervals[lane]) * intervals[lane],
    next: (lane, after) => Math.floor(after / intervals[lane]) * intervals[lane] + intervals[lane],
  };
}

// Neon suspends compute after 5 idle minutes, so independent 5/10/15-minute
// lanes kept it awake around the clock (528 wakes/day). Every lane now wakes on
// the same instants so Neon can sleep between bursts: every 30 minutes from
// 10:00 to 22:00 Cairo time (discovery hourly), every 2 hours overnight.
// Shopify/carrier webhooks and Telegram requests stay immediate.
const HALF_HOUR = 1_800_000;
const HOUR = 3_600_000;
const TWO_HOURS = 7_200_000;
export const CAIRO_DAY_HOURS = { start: 10, end: 22 } as const;
const cairoHour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', hourCycle: 'h23' });

function isCairoSlot(lane: OpsLane, slot: number): boolean {
  if (slot % HALF_HOUR !== 0) return false;
  const hour = Number(cairoHour.format(slot));
  // Overnight slots are even UTC hours, so they stay aligned with the 2-hourly
  // GitHub watchdog in both winter and Egyptian summer time.
  if (hour < CAIRO_DAY_HOURS.start || hour >= CAIRO_DAY_HOURS.end) return slot % TWO_HOURS === 0;
  return lane !== 'discovery' || slot % HOUR === 0;
}

export const cairoBusinessSchedule: OpsSchedule = {
  isSlot: isCairoSlot,
  floor: (lane, at) => { let slot = Math.floor(at / HALF_HOUR) * HALF_HOUR; while (!isCairoSlot(lane, slot)) slot -= HALF_HOUR; return slot; },
  next: (lane, after) => { let slot = Math.floor(after / HALF_HOUR) * HALF_HOUR + HALF_HOUR; while (!isCairoSlot(lane, slot)) slot += HALF_HOUR; return slot; },
};

export interface OpsTick { version: 1; lane: OpsLane; slot: number }
export interface OpsState {
  lastStartedAt?: number; lastSuccessAt?: number; completedSlot?: number;
  leaseUntil?: number; token?: string; nextAt?: number; lastError?: string;
  /** Observed lane resources, not an exact Vercel billing attribution. */
  lastDurationMs?: number; lastCpuMs?: number;
}
export interface OpsDependencies {
  intervals?: Record<OpsLane, number>;
  /** Overrides `intervals`; defaults to fixed OPS_INTERVALS. */
  schedule?: OpsSchedule;
  now(): number;
  /** Injectable for deterministic offline resource tests. Uses process-wide Node CPU by default. */
  cpuUsage?(): { user: number; system: number };
  enabled(): boolean;
  holdReason?(): string | undefined;
  /** Deployment-pinned queue chains must retire after an approved cutover. */
  active?(): Promise<boolean>;
  namespace?: string;
  read(lane: OpsLane): Promise<OpsState>;
  mutate<T>(lane: OpsLane, change: (state: OpsState) => { state: OpsState; result: T }): Promise<T>;
  publish(tick: OpsTick, options: { delaySeconds: number; retentionSeconds: number; idempotencyKey: string }): Promise<unknown>;
  run(lane: OpsLane): Promise<unknown>;
}

export function parseOpsTick(value: unknown): OpsTick | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.lane !== 'string' || !Object.hasOwn(OPS_INTERVALS, v.lane)) return null;
  if (!Number.isSafeInteger(v.slot) || Number(v.slot) <= 0) return null;
  const lane = v.lane as OpsLane;
  if (Number(v.slot) % OPS_INTERVALS[lane] !== 0) return null;
  return { version: 1, lane, slot: Number(v.slot) };
}

export function authorizedCron(header: string | undefined): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  const expected = secret ? `Bearer ${secret}` : '';
  return Boolean(expected && header && Buffer.byteLength(header) === Buffer.byteLength(expected)
    && timingSafeEqual(Buffer.from(header), Buffer.from(expected)));
}

export class OpsScheduler {
  private readonly schedule: OpsSchedule;

  constructor(private readonly deps: OpsDependencies) {
    this.schedule = deps.schedule ?? fixedIntervalSchedule(deps.intervals ?? OPS_INTERVALS);
  }

  /** Three of the longer surrounding gaps: two missed wakes, even across 2-hour night slots. */
  private staleAfter(lane: OpsLane, now: number): number {
    const current = this.schedule.floor(lane, now);
    const before = current - this.schedule.floor(lane, current - 1);
    return 3 * Math.max(before, this.schedule.next(lane, current) - current);
  }

  private async active(): Promise<boolean> {
    return this.deps.active ? await this.deps.active() : true;
  }

  private cpuUsage(): { user: number; system: number } | undefined {
    try {
      const value = this.deps.cpuUsage ? this.deps.cpuUsage()
        : typeof process.cpuUsage === 'function' ? process.cpuUsage() : undefined;
      return value && Number.isFinite(value.user) && Number.isFinite(value.system)
        && value.user >= 0 && value.system >= 0 ? value : undefined;
    } catch { return undefined; } // Diagnostics must never fail or repeat business work.
  }

  private async publish(lane: OpsLane, slot: number): Promise<boolean> {
    if (!await this.active()) return false;
    const now = this.deps.now();
    await this.deps.publish({ version: 1, lane, slot }, {
      delaySeconds: Math.max(0, Math.ceil((slot - now) / 1000)),
      retentionSeconds: 86_400,
      idempotencyKey: `ops_${this.deps.namespace ? this.deps.namespace+'_' : ''}${lane}_${slot}`,
    });
    if (!await this.active()) return false;
    await this.deps.mutate(lane, (s) => ({ state: { ...s, nextAt: Math.max(s.nextAt ?? 0, slot) }, result: undefined }));
    return true;
  }

  async ensure(): Promise<{ enabled: boolean; primaryHealthy: boolean; fallbackAllowed: boolean; reason?: string }> {
    const hold = this.deps.holdReason?.();
    if (hold || !this.deps.enabled()) return { enabled: false, primaryHealthy: false, fallbackAllowed: false, reason: hold ?? 'scheduler-disabled' };
    // Read coordination state BEFORE publishing anything. A failed database
    // must not create the next generation of recurring control messages.
    let health;
    try { health = await this.health(); }
    catch (error) {
      return { enabled: true, primaryHealthy: false, fallbackAllowed: false,
        reason: isDatabaseQuotaError(error) ? 'database-quota-exhausted' : 'dependency-unavailable' };
    }
    if(!health.enabled)return {enabled:false,primaryHealthy:false,fallbackAllowed:false,reason:'inactive-scheduler-release'};
    const now = this.deps.now();
    for (const lane of Object.keys(OPS_INTERVALS) as OpsLane[]) {
      // The same time slot is also used by the consumer: watchdogs cannot grow
      // independent recurring chains, even if GitHub and the daily cron overlap.
      const slot = this.schedule.floor(lane, now);
      if (!await this.publish(lane, slot)) return { enabled: false, primaryHealthy: false, fallbackAllowed: false, reason: 'inactive-scheduler-release' };
    }
    // Successful dispatch owns recovery. Never race the legacy drain against it.
    return { enabled: true, primaryHealthy: health.ok, fallbackAllowed: false };
  }

  /** Release maintenance: rebind only the NEXT natural slots to this exact
   * deployment. Unlike ensure(), this never dispatches work due now. */
  async ensureNext() {
    const hold = this.deps.holdReason?.();
    if (hold || !this.deps.enabled()) return { enabled: false, primaryHealthy: false,
      fallbackAllowed: false, futureOnly: true, reason: hold ?? 'scheduler-disabled' };
    let health;
    try { health = await this.health(); }
    catch (error) { return { enabled: false, primaryHealthy: false, fallbackAllowed: false,
      futureOnly: true, reason: isDatabaseQuotaError(error) ? 'database-quota-exhausted' : 'dependency-unavailable' }; }
    if (!health.enabled) return { enabled: false, primaryHealthy: false,
      fallbackAllowed: false, futureOnly: true, reason: 'inactive-scheduler-release' };
    const now = this.deps.now();
    const nextSlots = (Object.keys(OPS_INTERVALS) as OpsLane[]).map(lane => ({ lane,
      slot: this.schedule.next(lane, now) }));
    if (nextSlots.some(x => !this.schedule.isSlot(x.lane, x.slot) || x.slot <= now)) {
      throw new Error('Future-only maintenance requires exact future natural slots');
    }
    for (const { lane, slot } of nextSlots) {
      if (!await this.publish(lane, slot)) return { enabled: false, primaryHealthy: false,
        fallbackAllowed: false, futureOnly: true, reason: 'inactive-scheduler-release' };
    }
    return { enabled: true, primaryHealthy: health.ok, fallbackAllowed: false,
      futureOnly: true, nextSlots };
  }

  async health() {
    const now = this.deps.now();
    const enabled = this.deps.enabled();
    const hold = this.deps.holdReason?.();
    if (hold || !enabled) return { ok: false, enabled: false, checkedAt: new Date(now).toISOString(), lanes: [], reason: hold ?? 'scheduler-disabled' };
    if(!await this.active())return {ok:false,enabled:false,checkedAt:new Date(now).toISOString(),lanes:[],reason:'inactive-scheduler-release'};
    const lanes = await Promise.all((Object.keys(OPS_INTERVALS) as OpsLane[]).map(async (lane) => {
      const state = await this.deps.read(lane);
      const healthy = Boolean(state.lastSuccessAt && now - state.lastSuccessAt < this.staleAfter(lane, now));
      return { lane, healthy, ...state, token: undefined };
    }));
    if (!await this.active()) return { ok: false, enabled: false, checkedAt: new Date(now).toISOString(), lanes: [], reason: 'inactive-scheduler-release' };
    return { ok: enabled && lanes.every((s) => s.healthy), enabled, checkedAt: new Date(now).toISOString(), lanes };
  }

  async tick(input: unknown): Promise<{ skipped?: string; result?: unknown }> {
    const tick = parseOpsTick(input);
    if (!tick) throw new Error('Invalid ops scheduler tick');
    const hold = this.deps.holdReason?.();
    if (hold) return { skipped: hold };
    if (!this.deps.enabled()) return { skipped: 'disabled-outside-production' };
    // Ticks left over from an older cadence die out without touching Neon;
    // ensure() starts the current chain.
    if (!this.schedule.isSlot(tick.lane, tick.slot)) return { skipped: 'off-schedule-tick' };
    const now = this.deps.now();
    if (tick.slot > now + 30_000) throw new Error('Ops tick arrived before its scheduled slot');
    if (now - tick.slot >= 3 * (this.schedule.next(tick.lane, tick.slot) - tick.slot)) return { skipped: 'stale-control-tick' };
    if(!await this.active())return {skipped:'inactive-scheduler-release'};
    const next = this.schedule.next(tick.lane, Math.max(tick.slot, now));
    const token = randomUUID();
    const claimed = await this.deps.mutate(tick.lane, (s) => {
      if ((s.completedSlot ?? 0) >= tick.slot || (s.leaseUntil ?? 0) > now) return { state: s, result: false };
      return { state: { ...s, token, leaseUntil: now + 330_000, lastStartedAt: now }, result: true };
    });
    if (!claimed) return { skipped: 'completed-or-leased' };
    const resourceStartedAt = this.deps.now(), cpuStarted = this.cpuUsage();
    try {
      // The database lease must succeed before recurrence is extended. This is
      // still before business work; watchdog repairs a killed dispatcher.
      if (!await this.publish(tick.lane, next) || !await this.active()) return { skipped: 'inactive-scheduler-release' };
      const result = await this.deps.run(tick.lane);
      const cpuEnded = this.cpuUsage();
      const lastDurationMs = Math.max(0, this.deps.now() - resourceStartedAt);
      const lastCpuMs = cpuStarted && cpuEnded
        ? Math.round(Math.max(0, cpuEnded.user - cpuStarted.user + cpuEnded.system - cpuStarted.system)) / 1000
        : undefined;
      await this.deps.mutate(tick.lane, (s) => ({
        state: s.token === token ? { ...s, completedSlot: tick.slot, lastSuccessAt: this.deps.now(), leaseUntil: 0, token: undefined, lastError: undefined, lastDurationMs, lastCpuMs } : s,
        result: undefined,
      }));
      return { result };
    } catch (error) {
      // Quota cannot be repaired by another SQL query. A lease will expire;
      // preserve the original error if best-effort cleanup also fails.
      if (!isDatabaseQuotaError(error)) try { await this.deps.mutate(tick.lane, (s) => ({
        state: s.token === token ? { ...s, leaseUntil: 0, token: undefined, lastError: String(error).slice(0, 1000) } : s,
        result: undefined,
      })); } catch { /* do not mask the worker error or spin on failed cleanup */ }
      throw error;
    }
  }
}

export function schedulerStateReason(lane:OpsLane):string {const config=safeQueueConfig();return config?lane+'@'+config.epoch:lane;}
export async function schedulerReleaseIsActive():Promise<boolean>{
  const config=safeQueueConfig();if(!config)return true;
  const deploymentId=process.env.VERCEL_DEPLOYMENT_ID;if(!deploymentId)return false;
  const {basePrisma}=await import('../lib/prisma.js');const row=await basePrisma.failedPayload.findFirst({where:{source:'ops_scheduler_release',reason:'active'}});
  if(!row)return false;try{const p=JSON.parse(row.payloadJson);return p.version===1&&p.paused===false&&p.epoch===config.epoch&&p.proof===config.proof&&p.deploymentId===deploymentId;}catch{return false;}
}
async function mutate<T>(lane: OpsLane, change: (state: OpsState) => { state: OpsState; result: T }): Promise<T> {
  const { basePrisma } = await import('../lib/prisma.js');
  return basePrisma.$transaction(async (tx) => {
    const reason=schedulerStateReason(lane);
    await tx.$queryRawUnsafe(OPS_LOCK_SQL, `viola_ops_scheduler_${reason}`);
    const row = await tx.failedPayload.findFirst({ where: { source: 'ops_scheduler', reason } });
    const current = row ? JSON.parse(row.payloadJson) as OpsState : {};
    const changed = change(current);
    const payloadJson = JSON.stringify(changed.state);
    if (row) await tx.failedPayload.update({ where: { id: row.id }, data: { payloadJson } });
    else await tx.failedPayload.create({ data: { source: 'ops_scheduler', reason, payloadJson } });
    return changed.result;
  });
}

async function runLane(lane: OpsLane): Promise<unknown> {
  if (safeQueueHoldReason()) throw new Error('Automatic work is held');
  const laneStartedAt = Date.now();
  const { createAppServices } = await import('../app.js');
  const { shipmentStatusSyncService: sync, metaDeliveryService: meta, locationCatalogService } = createAppServices();
  const results: Record<string, unknown> = {};
  const errors: string[] = [];
  const attempt = async (name: string, run: () => Promise<unknown>, diagnosticOnly = false) => {
    try { results[name] = await run(); }
    catch (error) { if (isDatabaseQuotaError(error)) throw error; results[name] = { error: String(error).slice(0, 500) }; if (!diagnosticOnly) errors.push(name); }
  };
  const finish = () => { if (errors.length) throw new Error(`Ops lane stages failed: ${errors.join(', ')}`); return results; };
  // WhatsApp-only Odoo orders. Off unless WHATSAPP_ODOO_BRIDGE_ENABLED=true; when
  // off it touches nothing. Diagnostic-only: a bridge failure never fails the
  // lane, so the control message is never redelivered because of it.
  const bridgeOn = process.env.WHATSAPP_ODOO_BRIDGE_ENABLED?.trim().toLowerCase() === 'true';
  // While off: no stage, no import, lane output identical to before.
  const whatsappOdoo = async (run: (bridge: import('./whatsappOdooBridgeService.js').WhatsappOdooBridgeService) => Promise<unknown>) => {
    if (!bridgeOn) return;
    await attempt('whatsappOdoo', async () => {
      const { createWhatsappOdooBridge } = await import('./whatsappOdooBridgeRuntime.js');
      const bridge = await createWhatsappOdooBridge();
      return bridge ? await run(bridge) : { disabled: true };
    }, true);
  };
  if (lane === 'status') {
    // This capability authorizes accounting/status only. Never use it to replay
    // Meta deliveries or resume a human Telegram Preview/Run.
    if (!safeQueueReleaseRequested()) await attempt('meta', () => meta.processPending());
    await attempt('status', () => sync.syncOpenShipments({ budgetMs: 70_000, batchSize: 100 }));
    await whatsappOdoo(bridge => bridge.syncStatuses());
    if (!safeQueueReleaseRequested()) await attempt('productionRecovery', async () => {
      const { prisma } = await import('../lib/prisma.js');
      if (await prisma.failedPayload.findFirst({ where: { source: 'bot_control', reason: 'bot_paused' } })) return { paused: true };
      const { listRecoverableJobs } = await import('./productionJobStore.js');
      const { scheduleProductionContinuation } = await import('./productionContinuation.js');
      const jobs = await listRecoverableJobs();
      for (const { chatId, job } of jobs) await scheduleProductionContinuation({ chatId, batchId: job.batchId, dispatchKey: String(job.updatedAt) });
      return { dispatched: jobs.length };
    });
    return finish();
  }
  if (lane === 'discovery') {
    await attempt('locations', () => locationCatalogService.refreshIfStale(), true);
    await attempt('collections', () => sync.discoverCollectedShipmentsFromReports({ historyPages: 2, budgetMs: 70_000, apply: true, durableCursor: true }));
    await attempt('returns', () => sync.discoverReturnedShipmentsResumable({ historyPages: 2, budgetMs: 70_000, apply: true }));
    await whatsappOdoo(bridge => bridge.discover());
    return finish();
  }
  const { handler } = await import('../netlify/functions/process-odoo-queue-background.js');
  await attempt('odoo', async () => {
    const queue = await handler({ batchSize: 5, budgetMs: 75_000, maxSteps: 15 });
    if (queue.statusCode !== 200) {
      // The handler serializes failures instead of throwing. Retain quota
      // classification so attempt() stops the lane and the control consumer
      // acknowledges it, without propagating private database error text.
      let failure: unknown = queue.body;
      try { failure = JSON.parse(queue.body); } catch { /* Some failures are plain text. */ }
      if (isDatabaseQuotaError(failure)) throw new Error('Odoo queue stage failed: database quota exhausted');
      throw new Error('Odoo queue stage failed');
    }
    return JSON.parse(queue.body);
  });
  await attempt('returns', () => sync.processReturnQueue({ apply: true, limit: 10, budgetMs: 35_000 }));
  await attempt('shopify', () => sync.processShopifyPaymentQueue({ apply: true, limit: 12, budgetMs: 35_000, allowDiscounts: false }));
  await attempt('collections', () => sync.processOdooCollectionQueue({ apply: true, limit: 20, budgetMs: 50_000 }));
  // Only start bridge writes with time left inside the 300 s function and 330 s lease.
  const bridgeBudgetMs = Math.min(30_000, 230_000 - (Date.now() - laneStartedAt));
  if (bridgeBudgetMs >= 10_000) await whatsappOdoo(bridge => bridge.processActions({ limit: 3, budgetMs: bridgeBudgetMs }));
  else if (bridgeOn) results.whatsappOdoo = { skipped: 'lane-time-budget' };
  return finish();
}

export function createPersistentOpsScheduler(runtime: Pick<OpsDependencies, 'enabled' | 'publish' | 'intervals' | 'schedule'>): OpsScheduler {
  return new OpsScheduler({
  now: Date.now,
  holdReason: safeQueueHoldReason,
  active: schedulerReleaseIsActive,
  namespace: (()=>{try{return safeQueueConfig()?.epoch;}catch{return undefined;}})(),
  read: async (lane) => {
    const { basePrisma } = await import('../lib/prisma.js');
    const row = await basePrisma.failedPayload.findFirst({ where: { source: 'ops_scheduler', reason: schedulerStateReason(lane) } });
    return row ? JSON.parse(row.payloadJson) as OpsState : {};
  },
  mutate,
  ...runtime,
  run: runLane,
  });
}

export const opsScheduler = createPersistentOpsScheduler({
  enabled: () => (process.env.PRODUCTION_CONTINUATION_TRANSPORT === 'netlify'
    ? process.env.RECOVERY_LIVE === '1'
    : process.env.VERCEL_ENV === 'production') && process.env.OPS_SCHEDULER_ENABLED !== 'false',
  ...(process.env.PRODUCTION_CONTINUATION_TRANSPORT === 'netlify'
    ? { intervals: { status: 1_800_000, discovery: 1_800_000, financial: 1_800_000 } }
    : { schedule: cairoBusinessSchedule }),
  publish: async (tick, options) => {
    if (process.env.PRODUCTION_CONTINUATION_TRANSPORT === 'netlify') return { nativeSchedule: 'recovery-watchdog' };
    const { send } = await import('@vercel/queue');
    return send(OPS_TOPIC, tick, options);
  },
});
