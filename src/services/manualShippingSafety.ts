import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { ValidationError } from '../lib/errors.js';

export interface ManualShipmentAuthorization {
  chatId: number;
  batchId: string;
  epoch: string;
  updateId: number;
}
export interface ManualShipmentClaim {
  beforeExternalAttempt(): Promise<void>;
}
const SOURCE = 'manual_shipment_claim';

/** No lease auto-expiry: an unknown carrier write is never permission to
 * allocate another shipment. Recovery requires independent source evidence. */
export async function withManualShipmentClaim<T extends { accurateShipmentId?: number; accurateShipmentCode?: string }>(
  orderId: string,
  authorization: ManualShipmentAuthorization,
  assertAllowed: () => Promise<void>,
  action: (claim: ManualShipmentClaim) => Promise<T>
): Promise<T> {
  const allowed = (process.env.PRODUCTION_PREVIEW_ALLOWED_CHAT_IDS ?? '').split(',').map(v => Number(v.trim()));
  if (!/^\d+$/.test(orderId) || process.env.PRODUCTION_MANUAL_RUN_ENABLED?.trim().toLowerCase() !== 'true' ||
      !Number.isSafeInteger(authorization.chatId) || !allowed.includes(authorization.chatId) ||
      !authorization.batchId || authorization.epoch !== process.env.PRODUCTION_MANUAL_RUN_EPOCH?.trim() ||
      !Number.isSafeInteger(authorization.updateId) || authorization.updateId <= Number(process.env.PRODUCTION_MANUAL_RUN_MIN_UPDATE_ID)) {
    throw new ValidationError('Manual shipment authorization is invalid; manual review required');
  }
  return await withDurableShipmentClaim(orderId, authorization, authorization.batchId, assertAllowed, action);
}

/** Shared durable order lock/claim, not an authorization bypass. Entry points
 * must validate their distinct human authority before entering this primitive. */
export async function withDurableShipmentClaim<T extends { accurateShipmentId?: number; accurateShipmentCode?: string }>(
  orderId: string,
  authorization: object,
  externalId: string,
  assertAllowed: () => Promise<void>,
  action: (claim: ManualShipmentClaim) => Promise<T>
): Promise<T> {
  if (!/^[1-9]\d*$/.test(orderId) || !externalId) throw new ValidationError('Invalid durable shipment identity');
  await assertAllowed();
  const token = randomUUID(), reason = orderId;
  const base = { version: 1, orderId, authorization, token, requestAttempted: false,
    status: 'claimed', at: new Date().toISOString() };
  const claim = await prisma.$transaction(async tx => {
    await tx.$queryRawUnsafe('SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext($1))', 'manual-shipment:' + orderId);
    const previous = await tx.failedPayload.findMany({ where: { source: SOURCE, reason }, orderBy: { id: 'asc' } });
    if (previous.some(row => {
      try { const p = JSON.parse(row.payloadJson); return p.status !== 'no-external-attempt' || p.requestAttempted !== false; }
      catch { return true; }
    })) throw new ValidationError('Shipment order already has a durable claim or unknown write; manual review required');
    return await tx.failedPayload.create({ data: { source: SOURCE, reason,
      externalId, payloadJson: JSON.stringify(base) } });
  });
  let attempted = false;
  try {
    const result = await action({ beforeExternalAttempt: async () => {
      await assertAllowed();
      // Persist intent BEFORE the request; if this write is ambiguous the
      // request is not sent, and future attempts remain safely held.
      const changed = await prisma.failedPayload.updateMany({ where: {
        id: claim.id, source: SOURCE, reason, payloadJson: JSON.stringify(base),
      }, data: { payloadJson: JSON.stringify({ ...base, requestAttempted: true, status: 'external-attempt' }) } });
      if (changed.count !== 1) throw new ValidationError('Manual shipment claim was lost; manual review required');
      attempted = true;
      await assertAllowed();
    } });
    await prisma.failedPayload.update({ where: { id: claim.id }, data: { payloadJson: JSON.stringify({ ...base,
      requestAttempted: attempted, status: 'completed', shipmentId: result.accurateShipmentId,
      shipmentCode: result.accurateShipmentCode, completedAt: new Date().toISOString() }) } });
    return result;
  } catch (error) {
    // Never delete or silently reclaim a started operation. A failure of this
    // audit write leaves the original claim intact, not a free shipping slot.
    try { await prisma.failedPayload.update({ where: { id: claim.id }, data: { payloadJson: JSON.stringify({ ...base,
      requestAttempted: attempted, status: attempted ? 'needs-review' : 'no-external-attempt',
      stoppedAt: new Date().toISOString() }) } }); } catch { /* Original durable claim remains authoritative. */ }
    if (attempted) throw new ValidationError('Shipment operation requires manual review; its reserved code and receipts were preserved');
    throw error;
  }
}
