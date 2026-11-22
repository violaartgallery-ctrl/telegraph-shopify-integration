import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { basePrisma } from '../lib/prisma.js';
import { safeQueueConfig, safeQueueReleaseRequested } from './safeQueuePolicy.js';

export type AutomaticLane = 'production' | 'return' | 'collection' | 'shopify' | 'status';
export class AutomaticOperationReviewError extends Error {
  constructor(message = 'Automatic operation requires independent review; do not retry') {
    super(message);
    this.name = 'AutomaticOperationReviewError';
  }
}
const CLAIM = 'automatic_operation_claim', HOLD = 'ops_record_hold', CLOSED = 'ops_completion_receipt';
const LANES: AutomaticLane[] = ['production', 'return', 'collection', 'shopify', 'status'];
type ClaimStatus = 'claimed' | 'started' | 'completed' | 'needs-review' | 'no-external-attempt';
interface ClaimPayload {
  version: 1;
  recordId: number;
  key: string;
  epoch: string;
  fingerprint: string | null;
  token: string;
  status: ClaimStatus;
  requestAttempted: boolean;
  at: string;
  [field: string]: unknown;
}
interface OperationContext {
  recordId: number;
  shopifyOrderId: string;
  lane: AutomaticLane;
  key: string;
  claimId: number;
  token: string;
  epoch: string;
  payloadJson: string;
  attempted: boolean;
  closed: boolean;
  ownershipLost?: boolean;
  halted?: string;
  firstWrite?: Promise<void>;
}
const scope = new AsyncLocalStorage<OperationContext>();
const enabled = () => Boolean(safeQueueConfig());
const validRecordId = (id: unknown): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
const validOrderId = (id: unknown): id is string => typeof id === 'string' && /^[1-9]\d*$/.test(id);
const validLane = (lane: unknown): lane is AutomaticLane => LANES.includes(lane as AutomaticLane);

function parse(raw: string): Record<string, unknown> {
  try {
    const p = JSON.parse(raw);
    if (p && !Array.isArray(p) && p.version === 1 && Array.isArray(p.lanes) && p.lanes.length > 0 &&
        p.lanes.every((lane: unknown) => lane === '*' || validLane(lane))) return p;
  } catch { /* Malformed evidence never means permission. */ }
  throw new AutomaticOperationReviewError('Invalid durable queue hold; independent review required');
}
const applies = (p: Record<string, unknown>, lane: AutomaticLane) => (p.lanes as unknown[]).some(v => v === '*' || v === lane);

function parseClaim(raw: string): ClaimPayload {
  try {
    const p = JSON.parse(raw);
    const separator = typeof p?.key === 'string' ? p.key.indexOf(':') : -1;
    const validDate = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
    if (p && !Array.isArray(p) && p.version === 1 && validRecordId(p.recordId) &&
        separator > 0 && validLane(p.key.slice(0, separator)) && p.key.slice(separator + 1).trim() &&
        typeof p.epoch === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(p.epoch) &&
        typeof p.token === 'string' && p.token.trim() &&
        (p.fingerprint === null || (typeof p.fingerprint === 'string' && p.fingerprint.length > 0)) &&
        ['claimed', 'started', 'completed', 'needs-review', 'no-external-attempt'].includes(p.status) &&
        typeof p.requestAttempted === 'boolean' && validDate(p.at) &&
        (p.status !== 'claimed' || !p.requestAttempted) &&
        (p.status !== 'started' || p.requestAttempted) &&
        (p.status !== 'no-external-attempt' || !p.requestAttempted) &&
        (p.status !== 'completed' || validDate(p.completedAt)) &&
        (!['needs-review', 'no-external-attempt'].includes(p.status) ||
          (validDate(p.stoppedAt) && typeof p.reason === 'string' && p.reason.length > 0))) return p as ClaimPayload;
  } catch { /* Includes syntactically valid but incomplete/non-object payloads. */ }
  throw new AutomaticOperationReviewError('Invalid durable financial claim; independent review required');
}

export function haltAutomaticOperation(reason: string): void {
  const current = scope.getStore();
  if (current) current.halted = reason;
}
export function automaticOperationContext(): { recordId: number; shopifyOrderId: string; lane: AutomaticLane } | undefined {
  const c = scope.getStore();
  return c && !c.closed ? { recordId: c.recordId, shopifyOrderId: c.shopifyOrderId, lane: c.lane } : undefined;
}
export async function blockedAutomaticOrderIds(lane: AutomaticLane): Promise<string[]> {
  if (!enabled()) return [];
  if (!validLane(lane)) throw new AutomaticOperationReviewError('Invalid automatic lane');
  const rows = await basePrisma.failedPayload.findMany({ where: { source: { in: [HOLD, CLOSED] } } });
  const ids: string[] = [];
  for (const row of rows) {
    if (!applies(parse(row.payloadJson), lane)) continue;
    if (!validOrderId(row.externalId)) throw new AutomaticOperationReviewError('Durable queue hold lacks an exact Shopify identity');
    ids.push(row.externalId);
  }
  return [...new Set(ids)];
}
export async function automaticRecordBlocked(recordId: number, lane: AutomaticLane): Promise<boolean> {
  if (!enabled()) return false;
  if (!validRecordId(recordId) || !validLane(lane)) return true;
  const r = await basePrisma.shipmentRecord.findUnique({ where: { id: recordId }, select: { shopifyOrderId: true } });
  if (!r || !validOrderId(r.shopifyOrderId)) return true;
  const rows = await basePrisma.failedPayload.findMany({ where: { source: { in: [HOLD, CLOSED] }, externalId: r.shopifyOrderId } });
  return rows.some(row => applies(parse(row.payloadJson), lane));
}

async function setReview(c: OperationContext, reason: string): Promise<void> {
  const statusField = c.lane === 'return' ? 'returnSyncStatus' : c.lane === 'collection' ? 'odooCollectionSyncStatus'
    : c.lane === 'shopify' ? 'shopifyPaymentSyncStatus' : 'odooSyncStatus';
  const active = statusField === 'odooSyncStatus'
    ? ['odoo-so-pending', 'odoo-so-creating', 'odoo-stock-pending', 'odoo-stock-preparing', 'odoo-delivery-pending',
      'odoo-delivery-confirming', 'odoo-paid-invoice-pending', 'odoo-paid-invoice-processing', 'odoo-failed-retryable']
    : ['pending', 'processing', 'retryable', 'failed'];
  const data = c.lane === 'return' ? { returnSyncStatus: 'needs-review', returnSyncLastError: reason, returnSyncRetryAt: null, returnSyncClaimedAt: null }
    : c.lane === 'collection' ? { odooCollectionSyncStatus: 'needs-review', odooCollectionLastError: reason, odooCollectionRetryAt: null, odooCollectionClaimedAt: null }
    : c.lane === 'shopify' ? { shopifyPaymentSyncStatus: 'needs-review', shopifyPaymentLastError: reason, shopifyPaymentRetryAt: null, shopifyPaymentClaimedAt: null }
    : { odooSyncStatus: 'needs-review', odooLastError: reason, odooRetryAt: null };
  // Never rewrite a remapped record, a completed lane, or a newer review hold.
  await basePrisma.shipmentRecord.updateMany({
    where: { id: c.recordId, shopifyOrderId: c.shopifyOrderId, OR: [{ [statusField]: null }, { [statusField]: { in: active } }] }, data,
  });
}

function loseOwnership(c: OperationContext, reason: string): never {
  c.ownershipLost = true;
  c.halted = reason;
  throw new AutomaticOperationReviewError(reason);
}
function assertOpen(c: OperationContext): void {
  if (c.closed || c.halted) throw new AutomaticOperationReviewError('Financial operation is closed or halted');
}
async function assertIdentity(c: OperationContext): Promise<void> {
  const record = await basePrisma.shipmentRecord.findUnique({ where: { id: c.recordId }, select: { shopifyOrderId: true } });
  if (!record || !validOrderId(record.shopifyOrderId) || record.shopifyOrderId !== c.shopifyOrderId) {
    loseOwnership(c, 'Primary Shopify identity changed; independent review required');
  }
}
async function assertOwnedClaim(c: OperationContext): Promise<ClaimPayload> {
  const row = await basePrisma.failedPayload.findUnique({ where: { id: c.claimId } });
  if (!row || row.source !== CLAIM || row.externalId !== c.shopifyOrderId || row.reason !== c.key || row.payloadJson !== c.payloadJson) {
    loseOwnership(c, 'Financial intent missing or replaced; independent review required');
  }
  let p: ClaimPayload;
  try { p = parseClaim(row.payloadJson); }
  catch { return loseOwnership(c, 'Financial intent is invalid; independent review required'); }
  if (p.token !== c.token || p.key !== c.key || p.epoch !== c.epoch || p.recordId !== c.recordId ||
      p.status !== (c.attempted ? 'started' : 'claimed') || p.requestAttempted !== c.attempted) {
    loseOwnership(c, 'Financial claim replaced; independent review required');
  }
  return p;
}
async function changeOwnedClaim(c: OperationContext, fields: Record<string, unknown>): Promise<void> {
  const next = JSON.stringify({ ...parseClaim(c.payloadJson), ...fields });
  const changed = await basePrisma.failedPayload.updateMany({
    where: { id: c.claimId, source: CLAIM, externalId: c.shopifyOrderId, reason: c.key, payloadJson: c.payloadJson },
    data: { payloadJson: next },
  });
  if (changed.count !== 1) loseOwnership(c, 'Financial intent CAS lost; independent review required');
  c.payloadJson = next;
}
async function persistReview(c: OperationContext, reason: string): Promise<void> {
  // Independent attempts: a failed claim update must not suppress the hold.
  try {
    await basePrisma.failedPayload.create({ data: {
      source: HOLD, externalId: c.shopifyOrderId, reason: 'uncertain-operation:' + c.key,
      payloadJson: JSON.stringify({ version: 1, lanes: ['*'], recordId: c.recordId, reason, claimId: c.claimId }),
    } });
  } catch { /* The original claimed/started/replaced intent remains blocking. */ }
  try { await setReview(c, reason); } catch { /* Never free a durable claim. */ }
}

// Serializes all destinations for the exact SAME Shopify order. A claim never
// expires into permission; no-external-attempt is the only reclaimable state.
export async function withAutomaticOperation<T>(
  input: { recordId: number; lane: AutomaticLane; key: string; fingerprint?: string }, action: () => Promise<T>
): Promise<T> {
  const parent = scope.getStore();
  if (parent) assertOpen(parent);
  if (!enabled()) return await action();
  if (!validRecordId(input.recordId) || !validLane(input.lane) || typeof input.key !== 'string' || !input.key.trim() ||
      (input.fingerprint !== undefined && (typeof input.fingerprint !== 'string' || !input.fingerprint))) {
    throw new AutomaticOperationReviewError('Invalid automatic operation identity');
  }
  // Capture one identity, then check its holds under its lock. A second
  // pre-transaction read must not silently authorize a different Shopify ID.
  const record = await basePrisma.shipmentRecord.findUnique({ where: { id: input.recordId }, select: { shopifyOrderId: true } });
  if (!record || !validOrderId(record.shopifyOrderId)) throw new AutomaticOperationReviewError('Missing exact primary Shopify identity');
  const shopifyOrderId = record.shopifyOrderId, config = safeQueueConfig()!, token = randomUUID(), key = input.lane + ':' + input.key;
  const claim = await basePrisma.$transaction(async tx => {
    await tx.$queryRawUnsafe('SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext($1))', 'automatic-order:' + shopifyOrderId);
    // Do NOT substitute a new ID after obtaining a lock for the old identity.
    const locked = await tx.shipmentRecord.findUnique({ where: { id: input.recordId }, select: { shopifyOrderId: true } });
    if (!locked || !validOrderId(locked.shopifyOrderId) || locked.shopifyOrderId !== shopifyOrderId) {
      throw new AutomaticOperationReviewError('Primary Shopify identity changed before claim');
    }
    const holds = await tx.failedPayload.findMany({ where: { source: { in: [HOLD, CLOSED] }, externalId: shopifyOrderId } });
    if (holds.some(r => applies(parse(r.payloadJson), input.lane))) throw new AutomaticOperationReviewError('Durable owner/completion hold');
    const prior = await tx.failedPayload.findMany({ where: { source: CLAIM, externalId: shopifyOrderId } });
    for (const row of prior) {
      const p = parseClaim(row.payloadJson);
      if (!validRecordId(row.id) || row.reason !== p.key) throw new AutomaticOperationReviewError('Invalid durable financial claim identity');
      if (p.status !== 'no-external-attempt' && (p.key === key || p.status !== 'completed')) {
        throw new AutomaticOperationReviewError('Existing completed or uncertain financial operation; independent review required');
      }
    }
    return await tx.failedPayload.create({ data: {
      source: CLAIM, externalId: shopifyOrderId, reason: key,
      payloadJson: JSON.stringify({ version: 1, recordId: input.recordId, key, epoch: config.epoch,
        fingerprint: input.fingerprint ?? null, token, status: 'claimed', requestAttempted: false, at: new Date().toISOString() }),
    } });
  }, { timeout: 30000, maxWait: 15000 });
  const current: OperationContext = { recordId: input.recordId, lane: input.lane, key, shopifyOrderId,
    claimId: claim.id, token, epoch: config.epoch, payloadJson: claim.payloadJson, attempted: false, closed: false };
  try {
    await assertIdentity(current);
    const result = await scope.run(current, action);
    // Close before awaiting any final bookkeeping. Detached descendants cannot
    // reuse the resolved firstWrite promise once their parent action returns.
    current.closed = true;
    await current.firstWrite;
    if (current.halted) throw new AutomaticOperationReviewError('Unknown financial write outcome; independent review required');
    await assertIdentity(current);
    await changeOwnedClaim(current, { status: 'completed', requestAttempted: current.attempted, completedAt: new Date().toISOString() });
    return result;
  } catch (error) {
    current.closed = true;
    try { await current.firstWrite; } catch { /* Keep original failure and durable intent. */ }
    let review = current.attempted || Boolean(current.halted) || Boolean(current.ownershipLost);
    let reason = review ? 'AUTOMATION_OUTCOME_REVIEW: financial/stock operation may already exist; never replay' : String(error).slice(0, 500);
    if (!current.ownershipLost) {
      try {
        await changeOwnedClaim(current, { status: review ? 'needs-review' : 'no-external-attempt',
          requestAttempted: current.attempted, reason, stoppedAt: new Date().toISOString() });
      } catch {
        // A lost CAS means another durable state won. Do not overwrite it or
        // classify the order as proven no-external-attempt.
        if (current.ownershipLost) {
          review = true;
          reason = 'AUTOMATION_OUTCOME_REVIEW: claim ownership changed; never replay';
        }
      }
    }
    if (review) {
      await persistReview(current, reason);
      throw new AutomaticOperationReviewError(reason);
    }
    throw error;
  } finally {
    current.closed = true;
  }
}

async function beforeWrite(): Promise<void> {
  const current = scope.getStore();
  if (current) assertOpen(current);
  if (!enabled()) {
    if (current) throw new AutomaticOperationReviewError('Automatic financial release is no longer enabled');
    return;
  }
  if (!current) throw new AutomaticOperationReviewError('Financial write lacks a current non-halted durable operation');
  if (safeQueueConfig()?.epoch !== current.epoch) throw new AutomaticOperationReviewError('Financial release epoch changed');
  await assertIdentity(current);
  assertOpen(current);
  current.firstWrite ??= (async () => {
    await assertOwnedClaim(current);
    assertOpen(current);
    await changeOwnedClaim(current, { status: 'started', requestAttempted: true });
    current.attempted = true;
  })();
  await current.firstWrite;
  assertOpen(current);
  // A cached first-write promise is not current ownership authorization.
  await assertIdentity(current);
  await assertOwnedClaim(current);
  assertOpen(current);
}
export async function beforeAutomaticOdooWrite(_model: string, _method: string): Promise<void> { await beforeWrite(); }
/** Unrelated manual shipping remains on its own authorization/lease fences. */
export async function beforeAutomaticShopifyWrite(): Promise<void> { if (scope.getStore()) await beforeWrite(); }
export function automaticQueueSafetyActive(): boolean { return safeQueueReleaseRequested(); }
