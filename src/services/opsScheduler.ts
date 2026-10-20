import { randomUUID, timingSafeEqual } from 'node:crypto';

export const OPS_TOPIC = 'viola-ops-scheduler';
export const OPS_INTERVALS = { status: 600_000, discovery: 900_000, financial: 300_000 } as const;
export type OpsLane = keyof typeof OPS_INTERVALS;
export interface OpsTick { version: 1; lane: OpsLane; slot: number }
export interface OpsState {
  lastStartedAt?: number; lastSuccessAt?: number; completedSlot?: number;
  leaseUntil?: number; token?: string; nextAt?: number; lastError?: string;
}
export interface OpsDependencies {
  now(): number;
  enabled(): boolean;
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
  constructor(private readonly deps: OpsDependencies) {}

  private async publish(lane: OpsLane, slot: number): Promise<void> {
    const now = this.deps.now();
    await this.deps.publish({ version: 1, lane, slot }, {
      delaySeconds: Math.max(0, Math.ceil((slot - now) / 1000)),
      retentionSeconds: 86_400,
      idempotencyKey: `ops_${lane}_${slot}`,
    });
    await this.deps.mutate(lane, (s) => ({ state: { ...s, nextAt: Math.max(s.nextAt ?? 0, slot) }, result: undefined }));
  }

  async ensure(): Promise<{ enabled: boolean; primaryHealthy: boolean }> {
    if (!this.deps.enabled()) return { enabled: false, primaryHealthy: false };
    const now = this.deps.now();
    for (const lane of Object.keys(OPS_INTERVALS) as OpsLane[]) {
      // The same time slot is also used by the consumer: watchdogs cannot grow
      // independent recurring chains, even if GitHub and the daily cron overlap.
      const slot = Math.floor(now / OPS_INTERVALS[lane]) * OPS_INTERVALS[lane] + OPS_INTERVALS[lane];
      await this.publish(lane, slot);
    }
    const health = await this.health();
    return { enabled: true, primaryHealthy: health.ok };
  }

  async health() {
    const now = this.deps.now();
    const enabled = this.deps.enabled();
    const lanes = await Promise.all((Object.keys(OPS_INTERVALS) as OpsLane[]).map(async (lane) => {
      const state = await this.deps.read(lane);
      const healthy = Boolean(state.lastSuccessAt && now - state.lastSuccessAt < OPS_INTERVALS[lane] * 3);
      return { lane, healthy, ...state, token: undefined };
    }));
    return { ok: enabled && lanes.every((s) => s.healthy), enabled, checkedAt: new Date(now).toISOString(), lanes };
  }

  async tick(input: unknown): Promise<{ skipped?: string; result?: unknown }> {
    const tick = parseOpsTick(input);
    if (!tick) throw new Error('Invalid ops scheduler tick');
    if (!this.deps.enabled()) return { skipped: 'disabled-outside-production' };
    const now = this.deps.now();
    if (tick.slot > now + 30_000) throw new Error('Ops tick arrived before its scheduled slot');
    const interval = OPS_INTERVALS[tick.lane];
    const next = Math.max(tick.slot + interval, Math.floor(now / interval) * interval + interval);
    // Persist the next wake BEFORE doing any API work. A killed/failed worker
    // cannot break recurrence. At-least-once delivery is fenced by the lease.
    await this.publish(tick.lane, next);
    const token = randomUUID();
    const claimed = await this.deps.mutate(tick.lane, (s) => {
      if ((s.completedSlot ?? 0) >= tick.slot || (s.leaseUntil ?? 0) > now) return { state: s, result: false };
      return { state: { ...s, token, leaseUntil: now + 330_000, lastStartedAt: now }, result: true };
    });
    if (!claimed) return { skipped: 'completed-or-leased' };
    try {
      const result = await this.deps.run(tick.lane);
      await this.deps.mutate(tick.lane, (s) => ({
        state: s.token === token ? { ...s, completedSlot: tick.slot, lastSuccessAt: this.deps.now(), leaseUntil: 0, token: undefined, lastError: undefined } : s,
        result: undefined,
      }));
      return { result };
    } catch (error) {
      await this.deps.mutate(tick.lane, (s) => ({
        state: s.token === token ? { ...s, leaseUntil: 0, token: undefined, lastError: String(error).slice(0, 1000) } : s,
        result: undefined,
      }));
      throw error;
    }
  }
}

async function mutate<T>(lane: OpsLane, change: (state: OpsState) => { state: OpsState; result: T }): Promise<T> {
  const { basePrisma } = await import('../lib/prisma.js');
  return basePrisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `viola_ops_scheduler_${lane}`);
    const row = await tx.failedPayload.findFirst({ where: { source: 'ops_scheduler', reason: lane } });
    const current = row ? JSON.parse(row.payloadJson) as OpsState : {};
    const changed = change(current);
    const payloadJson = JSON.stringify(changed.state);
    if (row) await tx.failedPayload.update({ where: { id: row.id }, data: { payloadJson } });
    else await tx.failedPayload.create({ data: { source: 'ops_scheduler', reason: lane, payloadJson } });
    return changed.result;
  });
}

async function runLane(lane: OpsLane): Promise<unknown> {
  const { createAppServices } = await import('../app.js');
  const { shipmentStatusSyncService: sync, metaDeliveryService: meta, locationCatalogService } = createAppServices();
  if (lane === 'status') {
    const metaResult = await meta.processPending();
    const status = await sync.syncOpenShipments({ budgetMs: 70_000, batchSize: 100 });
    return { meta: metaResult, status };
  }
  if (lane === 'discovery') {
    await locationCatalogService.refreshIfStale();
    const collections = await sync.discoverCollectedShipmentsFromReports({ historyPages: 2, budgetMs: 70_000, apply: true, durableCursor: true });
    const returns = await sync.discoverReturnedShipmentsResumable({ historyPages: 2, budgetMs: 70_000, apply: true });
    return { collections, returns };
  }
  const { handler } = await import('../netlify/functions/process-odoo-queue-background.js');
  const queue = await handler({ batchSize: 5, budgetMs: 75_000, maxSteps: 15 });
  if (queue.statusCode !== 200) throw new Error('Odoo queue scheduler stage failed');
  const returns = await sync.processReturnQueue({ apply: true, limit: 10, budgetMs: 35_000 });
  const shopify = await sync.processShopifyPaymentQueue({ apply: true, limit: 12, budgetMs: 35_000, allowDiscounts: false });
  const collections = await sync.processOdooCollectionQueue({ apply: true, limit: 20, budgetMs: 50_000 });
  return { odoo: JSON.parse(queue.body), returns, shopify, collections };
}

export const opsScheduler = new OpsScheduler({
  now: Date.now,
  enabled: () => process.env.VERCEL_ENV === 'production' && process.env.OPS_SCHEDULER_ENABLED !== 'false',
  read: async (lane) => {
    const { basePrisma } = await import('../lib/prisma.js');
    const row = await basePrisma.failedPayload.findFirst({ where: { source: 'ops_scheduler', reason: lane } });
    return row ? JSON.parse(row.payloadJson) as OpsState : {};
  },
  mutate,
  publish: async (tick, options) => {
    const { send } = await import('@vercel/queue');
    return send(OPS_TOPIC, tick, options);
  },
  run: runLane,
});
