import { createHash, randomUUID } from 'node:crypto';
import { basePrisma } from '../lib/prisma.js';
import { ValidationError } from '../lib/errors.js';
import { assertAdminShipmentAuthorization, type AdminShipmentAuthorization } from './adminShippingSafety.js';
import type { ManualShipmentAuthorization } from './manualShippingSafety.js';
import { bindManualShipment, assertManualShipmentUnchanged, type ManualShipmentBinding } from './manualShipmentBinding.js';
import type { ShopifyOrder } from '../types/shopify.js';
import { inspectExistingShipmentFulfillment, createExistingShipmentFulfillment,
  type ExistingShipmentIdentity } from '../shopify/shopifyFulfillmentClient.js';

export const EXISTING_FULFILLMENT_CLAIM_SOURCE = 'shopify_existing_fulfillment_claim';
const OWNER_REPAIR = 'owner_existing_fulfillment_repair';
export const FULFILLMENT_REVIEW_REASON = 'SHOPIFY_FULFILLMENT_PENDING_REVIEW';
function fail(message: string): never { throw new ValidationError(message); }
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type ClaimRow = { id: number; source: string; reason: string; externalId: string | null; payloadJson: string };
type GuardDb = Pick<typeof basePrisma, 'failedPayload' | 'shipmentRecord'>;
export interface ExistingFulfillmentAuthority {
  manual?: ManualShipmentAuthorization;
  admin?: AdminShipmentAuthorization;
  binding: ManualShipmentBinding;
  assertOperationAllowed: () => Promise<void>;
}
const parse = (row: ClaimRow): Record<string, unknown> => {
  try { const p = JSON.parse(row.payloadJson); if (p && !Array.isArray(p) && p.version === 1) return p; } catch { /* fail closed */ }
  return fail('Malformed durable fulfillment/shipment intent; independent review required');
};

/** SAME current native human authority; no new token, endpoint, env, or generic
 * hold bypass. The supplied fence must include the native lease and FRESH source
 * comparison to this exact saved Preview/admin binding on every invocation. */
async function human(orderId: string, authority: ExistingFulfillmentAuthority): Promise<void> {
  const { manual, admin, binding } = authority;
  if (Boolean(manual) === Boolean(admin) || typeof authority.assertOperationAllowed !== 'function' ||
      binding?.version !== 1 || binding.shopifyOrderId !== orderId || !/^[a-f0-9]{64}$/.test(binding.shippingHash)) {
    fail('Explicit current native human authorization and saved source binding required');
  }
  if (admin) {
    assertAdminShipmentAuthorization(admin, orderId);
    if (hash(admin.binding) !== hash(binding)) fail('Admin fulfillment source binding changed');
  } else {
    const a = manual!, allowed = (process.env.PRODUCTION_PREVIEW_ALLOWED_CHAT_IDS ?? '').split(',').map(v => Number(v.trim()));
    if (process.env.PRODUCTION_MANUAL_RUN_ENABLED?.trim().toLowerCase() !== 'true' ||
        !Number.isSafeInteger(a.chatId) || !allowed.includes(a.chatId) || !a.batchId ||
        a.epoch !== process.env.PRODUCTION_MANUAL_RUN_EPOCH?.trim() || !Number.isSafeInteger(a.updateId) ||
        !Number.isSafeInteger(Number(process.env.PRODUCTION_MANUAL_RUN_MIN_UPDATE_ID)) ||
        a.updateId <= Number(process.env.PRODUCTION_MANUAL_RUN_MIN_UPDATE_ID)) fail('Native human Run authority is stale or invalid');
  }
  await authority.assertOperationAllowed();
}

const priorClaims = (db: GuardDb, orderId: string) => db.failedPayload.findMany({ where: {
  source: { in: [EXISTING_FULFILLMENT_CLAIM_SOURCE, OWNER_REPAIR] }, reason: orderId }, orderBy: { id: 'asc' } });

function boundaryProof(p: Record<string, unknown>, orderId: string, shipment: ExistingShipmentIdentity): boolean {
  const proof = p.boundaryProof as Record<string, unknown> | undefined;
  return Boolean(proof && proof.version === 1 && proof.kind === 'carrier-recorded-before-fulfillment' &&
    proof.orderId === orderId && proof.shipmentId === shipment.id && proof.shipmentCode === shipment.code &&
    proof.refNumber === shipment.refNumber && proof.requestAttempted === false &&
    typeof proof.sourceHash === 'string' && /^[a-f0-9]{64}$/.test(proof.sourceHash) &&
    typeof proof.carrierClaimId === 'number' && Number.isSafeInteger(proof.carrierClaimId) && proof.carrierClaimId > 0 &&
    typeof proof.carrierTokenHash === 'string' && /^[a-f0-9]{64}$/.test(proof.carrierTokenHash) &&
    p.boundaryProofHash === hash(proof) && p.orderId === orderId && p.shipmentId === shipment.id &&
    p.shipmentCode === shipment.code && p.refNumber === shipment.refNumber && p.sourceHash === proof.sourceHash &&
    p.carrierClaimId === proof.carrierClaimId && p.carrierTokenHash === proof.carrierTokenHash);
}

export async function existingFulfillmentBoundaryLink(id: number, orderId: string, shipment: ExistingShipmentIdentity): Promise<{ boundaryClaimId: number; boundaryProofHash: string }> {
  const row = await basePrisma.failedPayload.findUnique({ where: { id } });
  if (!row || row.source !== EXISTING_FULFILLMENT_CLAIM_SOURCE || row.reason !== orderId || row.externalId !== shipment.code) fail('Missing exact durable fulfillment boundary link');
  const p = parse(row);
  if (!boundaryProof(p, orderId, shipment)) fail('Invalid durable no-attempt proof');
  return { boundaryClaimId: row.id, boundaryProofHash: p.boundaryProofHash as string };
}

async function guards(db: GuardDb, orderId: string, shipment: ExistingShipmentIdentity,
  boundary?: Record<string, unknown>, completedReadOnly = false): Promise<void> {
  const holds = await db.failedPayload.findMany({ where: { externalId: orderId,
    source: { in: ['ops_record_hold', 'ops_completion_receipt', 'shopify-fulfillment-create', 'automatic_operation_claim'] } } });
  for (const row of holds) {
    if (row.source === 'shopify-fulfillment-create') {
      // A bare requestAttempted:false diagnostic is not authority. It must name
      // this exact order/carrier tuple AND link a valid immutable durable proof.
      try {
        const d = JSON.parse(row.payloadJson);
        if (d.requestAttempted === false && String(d.orderId) === orderId && d.shipmentId === shipment.id &&
            d.shipmentCode === shipment.code && Number.isSafeInteger(d.boundaryClaimId) && d.boundaryClaimId > 0) {
          const linked = await db.failedPayload.findUnique({ where: { id: d.boundaryClaimId } });
          if (linked && linked.source === EXISTING_FULFILLMENT_CLAIM_SOURCE && linked.reason === orderId && linked.externalId === shipment.code) {
            const p = parse(linked);
            if (d.boundaryProofHash === p.boundaryProofHash && boundaryProof(p, orderId, shipment)) continue;
          }
        }
      } catch { /* Malformed/legacy/no-link evidence stays held below. */ }
    }
    if (row.source !== 'automatic_operation_claim') fail('Owner/completion hold or prior failed/unknown fulfillment remains protected');
    const p = parse(row);
    if (!['completed', 'no-external-attempt'].includes(String(p.status)) ||
        typeof p.requestAttempted !== 'boolean' || (p.status === 'no-external-attempt' && p.requestAttempted !== false) ||
        typeof p.recordId !== 'number' || !Number.isSafeInteger(p.recordId) || p.recordId <= 0 ||
        row.reason !== p.key || typeof p.key !== 'string' || !/^(production|return|collection|shopify|status):\S+/.test(p.key) ||
        typeof p.token !== 'string' || !p.token || typeof p.epoch !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(p.epoch) ||
        typeof p.at !== 'string' || !Number.isFinite(Date.parse(p.at)) ||
        (p.status === 'completed' && (typeof p.completedAt !== 'string' || !Number.isFinite(Date.parse(p.completedAt)))) ||
        (p.status === 'no-external-attempt' && (typeof p.stoppedAt !== 'string' || !Number.isFinite(Date.parse(p.stoppedAt)) || !p.reason))) {
      fail('Active or uncertain native operation remains protected');
    }
  }
  if (completedReadOnly) return;
  const carrierClaims = await db.failedPayload.findMany({ where: { source: 'manual_shipment_claim', reason: orderId } });
  for (const row of carrierClaims) {
    const p = parse(row);
    if (p.orderId !== orderId || typeof p.requestAttempted !== 'boolean' || typeof p.token !== 'string' || !p.token) fail('Original carrier claim identity is invalid');
    if (p.status === 'no-external-attempt' && p.requestAttempted === false) continue;
    if (p.status === 'completed' && p.shipmentId === shipment.id && p.shipmentCode === shipment.code) continue;
    // Only a runtime receipt durably saved immediately AFTER markCreated and
    // BEFORE any Shopify attempt proves this narrow boundary. Generic old
    // needs-review/unknown claims do NOT become permission after a new Run.
    if (p.status === 'needs-review' && p.requestAttempted === true &&
        boundary?.boundary === 'carrier-recorded-before-fulfillment' && boundary.requestAttempted === false &&
        boundaryProof(boundary, orderId, shipment) &&
        boundary.carrierClaimId === row.id && boundary.carrierTokenHash === hash(p.token) &&
        boundary.shipmentId === shipment.id && boundary.shipmentCode === shipment.code) continue;
    fail('Original carrier claim is unfinished/uncertain without exact no-fulfillment-attempt boundary proof');
  }
}

/** Metadata receipt only; called immediately after the in-flight carrier result
 * is recorded, BEFORE a deadline/lease fence can interrupt the Shopify stage.
 * No carrier claim is altered. A failed/ambiguous receipt write stops execution. */
export async function recordCreatedShipmentFulfillmentBoundary(input: {
  orderId: string; shipment: ExistingShipmentIdentity; authority: ExistingFulfillmentAuthority;
}): Promise<number> {
  const { orderId, shipment, authority } = input;
  // Do not call the operation/deadline fence here: this records an ALREADY
  // completed carrier write, it does not authorize another external operation.
  if (!/^[1-9]\d*$/.test(orderId) || authority.binding?.shopifyOrderId !== orderId) fail('Invalid fulfillment boundary identity');
  return await basePrisma.$transaction(async tx => {
    await tx.$queryRawUnsafe('SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext($1))', 'manual-shipment:' + orderId);
    if ((await priorClaims(tx, orderId)).length) fail('Existing fulfillment intent already exists; do not overwrite it');
    const native = await tx.failedPayload.findMany({ where: { source: 'manual_shipment_claim', reason: orderId } });
    const own = native.filter(row => { const p = parse(row); return ((p.status === 'external-attempt' && p.requestAttempted === true) ||
      (p.status === 'claimed' && p.requestAttempted === false)) &&
      hash(p.authorization) === hash(authority.manual ?? authority.admin); });
    if (own.length !== 1) fail('Exact current carrier intent required for boundary receipt');
    const record = await tx.shipmentRecord.findUnique({ where: { shopifyOrderId: orderId } });
    if (!record || record.accurateShipmentId !== shipment.id || record.accurateShipmentCode !== shipment.code ||
        authority.binding.orderName !== record.shopifyOrderName || shipment.refNumber !== 'Viola-' + record.shopifyOrderNumber) {
      fail('Carrier identity must be durably recorded before fulfillment boundary');
    }
    const p = parse(own[0]);
    const proof = { version: 1, kind: 'carrier-recorded-before-fulfillment', orderId,
      shipmentId: shipment.id, shipmentCode: shipment.code, refNumber: shipment.refNumber,
      sourceHash: authority.binding.shippingHash, carrierClaimId: own[0].id,
      carrierTokenHash: hash(p.token), requestAttempted: false };
    const row = await tx.failedPayload.create({ data: { source: EXISTING_FULFILLMENT_CLAIM_SOURCE,
      reason: orderId, externalId: shipment.code, payloadJson: JSON.stringify({ version: 1,
        orderId, shipmentId: shipment.id, shipmentCode: shipment.code, refNumber: shipment.refNumber,
        sourceHash: authority.binding.shippingHash, boundary: 'carrier-recorded-before-fulfillment',
        boundaryProof: proof, boundaryProofHash: hash(proof),
        carrierClaimId: own[0].id, carrierTokenHash: hash(p.token), requestAttempted: false,
        status: 'no-external-attempt', at: new Date().toISOString() }) } });
    return row.id;
  });
}

/** Normal first fulfillment marks the SAME separate intent before send, so a
 * process crash/unknown result cannot later turn into a duplicate repair. */
export async function markCreatedShipmentFulfillmentAttempt(id: number): Promise<void> {
  const row = await basePrisma.failedPayload.findUnique({ where: { id } });
  if (!row || row.source !== EXISTING_FULFILLMENT_CLAIM_SOURCE) fail('Missing durable fulfillment boundary');
  const p = parse(row);
  if (p.status !== 'no-external-attempt' || p.requestAttempted !== false) fail('Fulfillment was already attempted; do not retry');
  const result = await basePrisma.failedPayload.updateMany({ where: { id, payloadJson: row.payloadJson },
    data: { payloadJson: JSON.stringify({ ...p, status: 'external-attempt', requestAttempted: true,
      attemptedAt: new Date().toISOString() }) } });
  if (result.count !== 1) fail('Fulfillment boundary ownership changed; do not retry');
}

export async function completeCreatedShipmentFulfillment(id: number, order: ShopifyOrder, shipment: ExistingShipmentIdentity): Promise<void> {
  const verified = await inspectExistingShipmentFulfillment(order, shipment);
  if (verified.state !== 'present') fail('Full exact Shopify fulfillment readback is required');
  const row = await basePrisma.failedPayload.findUnique({ where: { id } });
  if (!row || row.source !== EXISTING_FULFILLMENT_CLAIM_SOURCE || row.reason !== String(order.id) || row.externalId !== shipment.code) fail('Fulfillment intent identity changed');
  const p = parse(row);
  if (!['no-external-attempt', 'external-attempt'].includes(String(p.status)) || p.shipmentId !== shipment.id || p.shipmentCode !== shipment.code) fail('Fulfillment intent is not owned');
  const result = await basePrisma.failedPayload.updateMany({ where: { id, payloadJson: row.payloadJson }, data: {
    payloadJson: JSON.stringify({ ...p, status: 'completed', fulfillmentIds: verified.fulfillmentIds, completedAt: new Date().toISOString() }) } });
  if (result.count !== 1) fail('Fulfillment completion CAS lost; do not retry');
}

/** Narrow post-carrier metadata only; never overwrite a newer owner error or
 * alter carrier identity/status, raw source, financial fields, or queue state. */
export async function noteExistingFulfillmentReview(orderId: string, shipment: ExistingShipmentIdentity): Promise<void> {
  const changed = await basePrisma.shipmentRecord.updateMany({ where: { shopifyOrderId: orderId,
    accurateShipmentId: shipment.id, accurateShipmentCode: shipment.code,
    OR: [{ lastError: null }, { lastError: { startsWith: FULFILLMENT_REVIEW_REASON } }] },
    data: { lastError: FULFILLMENT_REVIEW_REASON } });
  if (changed.count !== 1) fail('Existing shipment review metadata changed; original identity was preserved');
}

/** Only the verified duplicate branch calls this repair. Never carrier-create,
 * accounting requeue, stock write, original claim reset, or source rebasing. */
export async function reconcileExistingShipmentFulfillment(input: {
  order: ShopifyOrder; shipment: ExistingShipmentIdentity; authority: ExistingFulfillmentAuthority;
}): Promise<{ skipped: boolean; reason?: string; fulfillmentIds: string[] }> {
  const { order, shipment, authority } = input, orderId = String(order.id);
  let rawHash: string | undefined;
  let recordId: number | undefined, rawSource: string | undefined;
  const fence = async (diagnosticReadOnly = false): Promise<void> => {
    await human(orderId, authority);
    const r = await basePrisma.shipmentRecord.findUnique({ where: { shopifyOrderId: orderId } });
    if (!r || r.accurateShipmentId !== shipment.id || r.accurateShipmentCode !== shipment.code ||
        r.shopifyOrderName !== order.name || r.shopifyOrderNumber !== String(order.order_number) ||
        r.odooSyncStatus === 'needs-review' || (!diagnosticReadOnly && r.lastError && r.lastError !== FULFILLMENT_REVIEW_REASON) ||
        r.returnedAt || r.accurateReturnStatusCode || r.accurateReturnStatus || r.returnSyncStatus || !r.rawOrderJson) fail('Primary shipment/source is changed or held');
    const currentHash = hash(r.rawOrderJson);
    if (recordId !== undefined && recordId !== r.id) fail('Primary shipment record changed; do not rebase');
    if (rawHash !== undefined && currentHash !== rawHash) fail('Stored shipment source changed; no rebase is allowed');
    recordId = r.id;
    rawSource = r.rawOrderJson;
    rawHash = currentHash;
  };
  // A completed owner repair may be observed without erasing the historical
  // carrier/soft-deadline diagnostic. Unknown diagnostics still block WRITES.
  await fence(true);
  const plan = await inspectExistingShipmentFulfillment(order, shipment);
  const row = await basePrisma.$transaction(async tx => {
    for (const key of ['manual-shipment:' + orderId, 'automatic-order:' + orderId]) {
      await tx.$queryRawUnsafe('SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext($1))', key);
    }
    const prior = await priorClaims(tx, orderId);
    if (prior.some(r => r.externalId !== shipment.code)) fail('Existing fulfillment claim has a different carrier code');
    // Completed owner/runtime repairs are READ-ONLY under fresh exact tracking
    // and full-line proof. They never need to reopen the original carrier claim.
    if (prior.length && prior.every(r => parse(r).status === 'completed') && plan.state === 'present') {
      await guards(tx, orderId, shipment, undefined, true);
      return null;
    }
    if (prior.length > 1) fail('Multiple fulfillment intents require independent review');
    const old = prior[0], p = old ? parse(old) : undefined;
    if (old && (old.source !== EXISTING_FULFILLMENT_CLAIM_SOURCE || p?.status !== 'no-external-attempt' ||
        p.requestAttempted !== false || p.orderId !== orderId || p.shipmentId !== shipment.id ||
        p.shipmentCode !== shipment.code || p.refNumber !== shipment.refNumber || p.sourceHash !== authority.binding.shippingHash ||
        (p.boundary !== undefined && (p.boundary !== 'carrier-recorded-before-fulfillment' ||
          !boundaryProof(p, orderId, shipment) ||
          typeof p.carrierClaimId !== 'number' || !Number.isSafeInteger(p.carrierClaimId) || p.carrierClaimId <= 0 ||
          typeof p.carrierTokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(p.carrierTokenHash))))) {
      fail('Failed/unknown/prior fulfillment attempt is not retryable');
    }
    const record = await tx.shipmentRecord.findUnique({ where: { shopifyOrderId: orderId } });
    if (!record || hash(record.rawOrderJson) !== rawHash || record.accurateShipmentId !== shipment.id ||
        record.accurateShipmentCode !== shipment.code ||
        (record.lastError && record.lastError !== FULFILLMENT_REVIEW_REASON)) fail('Stored shipment identity/source changed or remains held before claim');
    if (!p?.boundary) {
      // Legacy paths require exact original commercial/customization source;
      // a newly generated Preview is NOT approval to rebase a shipped order.
      assertManualShipmentUnchanged(bindManualShipment(JSON.parse(record.rawOrderJson!)), order);
    }
    await guards(tx, orderId, shipment, p);
    if (plan.state === 'present') return null;
    const next = JSON.stringify({ ...(p ?? {}), version: 1, orderId, shipmentId: shipment.id,
      shipmentCode: shipment.code, refNumber: shipment.refNumber, sourceHash: authority.binding.shippingHash,
      stateHash: plan.stateHash, authorization: authority.manual ?? authority.admin,
      token: randomUUID(), status: 'claimed', requestAttempted: false, at: new Date().toISOString() });
    if (old) {
      const changed = await tx.failedPayload.updateMany({ where: { id: old.id, payloadJson: old.payloadJson }, data: { payloadJson: next } });
      if (changed.count !== 1) fail('Fulfillment claim changed concurrently');
      return { ...old, payloadJson: next };
    }
    return await tx.failedPayload.create({ data: { source: EXISTING_FULFILLMENT_CLAIM_SOURCE,
      reason: orderId, externalId: shipment.code, payloadJson: next } });
  });
  if (!row) return { skipped: true, reason: 'exact-existing-fulfillment', fulfillmentIds: plan.fulfillmentIds };
  let owned = row.payloadJson, attempted = false, closed = false, completed = false;
  const cas = async (fields: object): Promise<void> => {
    const next = JSON.stringify({ ...JSON.parse(owned), ...fields });
    const result = await basePrisma.failedPayload.updateMany({ where: { id: row.id,
      source: EXISTING_FULFILLMENT_CLAIM_SOURCE, reason: orderId, externalId: shipment.code,
      payloadJson: owned }, data: { payloadJson: next } });
    if (result.count !== 1) fail('Fulfillment intent ownership lost; do not retry');
    owned = next;
  };
  const ownedFence = async (): Promise<void> => {
    if (closed) fail('Fulfillment operation closed');
    await fence();
    const current = await basePrisma.failedPayload.findUnique({ where: { id: row.id } });
    if (!current || current.payloadJson !== owned) fail('Fulfillment intent was replaced; do not retry');
    await guards(basePrisma, orderId, shipment, JSON.parse(row.payloadJson));
  };
  try {
    const result = await createExistingShipmentFulfillment({ source: order, shipment,
      expectedStateHash: plan.stateHash, assertOperationAllowed: ownedFence, beforeExternalAttempt: async () => {
        await ownedFence();
        attempted = true; // BEFORE CAS: ambiguous intent persistence is NEVER proven no-attempt.
        await cas({ status: 'external-attempt', requestAttempted: true });
      } });
    closed = true;
    await cas({ status: 'completed', requestAttempted: attempted, fulfillmentIds: result.fulfillmentIds, completedAt: new Date().toISOString() });
    completed = true;
    if (!result.skipped) {
      // Clear ONLY our exact diagnostic after a newly verified fulfillment.
      // Tuple + original source + exact marker CAS cannot clear an owner error,
      // financial/stock status, hold, original carrier claim, or remapped row.
      await basePrisma.shipmentRecord.updateMany({ where: { id: recordId!, shopifyOrderId: orderId,
        shopifyOrderName: order.name, shopifyOrderNumber: String(order.order_number),
        accurateShipmentId: shipment.id, accurateShipmentCode: shipment.code,
        rawOrderJson: rawSource!, lastError: FULFILLMENT_REVIEW_REASON }, data: { lastError: null } });
    }
    return result;
  } catch (error) {
    closed = true;
    // A failed/ambiguous UI-marker cleanup is metadata-only. Never downgrade a
    // verified completed fulfillment claim or repeat the provider operation.
    if (completed) throw error;
    try { await cas({ status: attempted ? 'needs-review' : 'no-external-attempt', requestAttempted: attempted, stoppedAt: new Date().toISOString() }); } catch { /* Original intent remains blocking. */ }
    if (attempted) fail('Fulfillment outcome requires independent review; never retry automatically');
    throw error;
  }
}
