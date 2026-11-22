import { randomUUID } from 'node:crypto';
import { AutomaticOperationReviewError, automaticOperationContext } from './automaticOperationSafety.js';
import { safeQueueConfig } from './safeQueuePolicy.js';
import { whatsappOdooScope, type WhatsappOdooWriteContext } from './whatsappOdooScope.js';
import type { BridgeStore } from './whatsappOdooBridgeStore.js';

/**
 * Durable single-attempt operation for one WhatsApp bridge step.
 *
 * Mirrors withAutomaticOperation: claimed -> started (persisted BEFORE the
 * first Odoo write is sent) -> completed. Failures before any write become
 * no-external-attempt (the only reclaimable state); anything after a write,
 * a halted transport or a lost claim becomes needs-review and is never retried.
 */
export interface BridgeOperationDeps {
  store: BridgeStore;
  /** Current safe-queue epoch; undefined means writes are not released. */
  epoch?: () => string | undefined;
  /** Called once when the outcome needs independent review. */
  onReview?: (reason: string) => Promise<void>;
}

interface Context extends WhatsappOdooWriteContext {
  attempted: boolean;
  ownershipLost?: boolean;
  firstWrite?: Promise<void>;
}

export const BRIDGE_REVIEW_PREFIX = 'WHATSAPP_BRIDGE_OUTCOME_REVIEW';

export async function withWhatsappOdooOperation<T>(
  deps: BridgeOperationDeps,
  input: { linkId: number; key: string; expectedState: string; fingerprint?: string | null },
  action: () => Promise<T>,
): Promise<T> {
  if (whatsappOdooScope.getStore() || automaticOperationContext()) {
    throw new AutomaticOperationReviewError('Nested WhatsApp bridge operation is not allowed');
  }
  const currentEpoch = deps.epoch ?? (() => { try { return safeQueueConfig()?.epoch; } catch { return undefined; } });
  const epoch = currentEpoch();
  if (!epoch) throw new AutomaticOperationReviewError('WhatsApp bridge writes require the safe-queue release epoch');
  const token = randomUUID();
  const claim = await deps.store.claimOperation({
    linkId: input.linkId, key: input.key, expectedState: input.expectedState,
    fingerprint: input.fingerprint ?? null, epoch, token,
  });
  const store = deps.store;
  const lose = (c: Context, reason: string): never => {
    c.ownershipLost = true;
    c.halted = reason;
    throw new AutomaticOperationReviewError(reason);
  };
  const ctx: Context = {
    linkId: input.linkId, key: input.key, closed: false, attempted: false,
    async beforeWrite() {
      if (ctx.closed || ctx.halted) throw new AutomaticOperationReviewError('WhatsApp bridge operation is closed or halted');
      if (currentEpoch() !== epoch) throw new AutomaticOperationReviewError('Safe-queue epoch changed; WhatsApp bridge write refused');
      ctx.firstWrite ??= (async () => {
        const started = await store.changeOperation(claim.id, token, 'claimed', { status: 'started', requestAttempted: true });
        if (!started) lose(ctx, 'WhatsApp bridge claim replaced before first write');
        ctx.attempted = true;
      })();
      await ctx.firstWrite;
      if (ctx.closed || ctx.halted) throw new AutomaticOperationReviewError('WhatsApp bridge operation is closed or halted');
      const row = await store.readOperation(claim.id);
      if (!row || row.token !== token || row.status !== 'started' || !row.requestAttempted) lose(ctx, 'WhatsApp bridge claim ownership lost');
    },
  };

  try {
    const result = await whatsappOdooScope.run(ctx, action);
    ctx.closed = true;
    await ctx.firstWrite;
    if (ctx.halted) throw new AutomaticOperationReviewError('Unknown Odoo write outcome in WhatsApp bridge step');
    const done = await store.changeOperation(claim.id, token, ctx.attempted ? 'started' : 'claimed',
      { status: 'completed', requestAttempted: ctx.attempted });
    if (!done) lose(ctx, 'WhatsApp bridge completion CAS lost');
    return result;
  } catch (error) {
    ctx.closed = true;
    try { await ctx.firstWrite; } catch { /* keep the original failure */ }
    let review = ctx.attempted || Boolean(ctx.halted) || Boolean(ctx.ownershipLost);
    let reason = review
      ? `${BRIDGE_REVIEW_PREFIX}: Odoo write may already exist; never replay (${String((error as Error)?.message ?? error).slice(0, 200)})`
      : String((error as Error)?.message ?? error).slice(0, 500);
    if (!ctx.ownershipLost) {
      const changed = await store.changeOperation(claim.id, token, ctx.attempted ? 'started' : 'claimed',
        { status: review ? 'needs-review' : 'no-external-attempt', requestAttempted: ctx.attempted, reason })
        .catch(() => false);
      if (!changed && !review) {
        // Another state won; never classify it as a proven no-attempt.
        review = true;
        reason = `${BRIDGE_REVIEW_PREFIX}: claim state changed; never replay`;
      }
    }
    if (review) {
      try { await deps.onReview?.(reason); } catch { /* the uncertain claim still blocks */ }
      throw new AutomaticOperationReviewError(reason);
    }
    throw error;
  } finally {
    ctx.closed = true;
  }
}
