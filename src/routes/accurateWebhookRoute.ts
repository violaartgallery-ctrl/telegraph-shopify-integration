import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { failedPayloadService } from '../services/failedPayloadService.js';
import { constantTimeTextEqual } from '../services/shopifyAdminAuth.js';
import type { ShipmentStatusSyncService } from '../services/shipmentStatusSyncService.js';
import { shipmentRepository } from '../services/shipmentRepository.js';

interface AccurateWebhookRecord {
  id: number;
  shopifyOrderId: string;
  accurateShipmentId: number | null;
  accurateShipmentCode: string | null;
}

export interface AccurateWebhookDependencies {
  webhookSecret: string;
  findByReference: (reference: string) => Promise<AccurateWebhookRecord | null>;
  saveFailedPayload: (params: {
    source: string;
    externalId?: string;
    reason: string;
    payload: unknown;
  }) => Promise<unknown>;
}

const defaultDependencies: AccurateWebhookDependencies = {
  webhookSecret: env.accurate.webhookSecret,
  findByReference: shipmentRepository.findByReference,
  saveFailedPayload: failedPayloadService.save
};

const MAX_REFERENCE_LENGTH = 256;
const MAX_CODE_LENGTH = 128;
const MAX_SECRET_LENGTH = 4096;

const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const boundedText = (value: unknown, maxLength: number): string => {
  if (typeof value !== 'string' || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Invalid callback identity');
  }
  const text = value.trim();
  if (!text) throw new Error('Empty callback identity');
  return text;
};

// Only explicit decimal integers are accepted. Number([id]), booleans,
// fractions, exponents and unsafe integers must never become identity matches.
const shipmentId = (value: unknown): number => {
  if (positiveInteger(value)) return value;
  if (typeof value === 'string' && value.length <= 16 && /^[0-9]+$/.test(value)) {
    const number = Number(value);
    if (positiveInteger(number)) return number;
  }
  throw new Error('Invalid callback shipmentId');
};

interface CallbackIdentity {
  references: string[];
  shipmentId?: number;
  shipmentCode?: string;
}

const callbackIdentity = (body: unknown): CallbackIdentity => {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(body))) {
    throw new Error('Expected a JSON object');
  }
  const payload = body as Record<string, unknown>;
  const references: string[] = [];
  for (const key of ['refNumber', 'externalReference']) {
    const value = payload[key];
    if (value == null) continue;
    const reference = positiveInteger(value) ? String(value) : boundedText(value, MAX_REFERENCE_LENGTH);
    if (!references.includes(reference)) references.push(reference);
  }
  const id = payload.shipmentId == null ? undefined : shipmentId(payload.shipmentId);
  const code = payload.shipmentCode == null ? undefined : boundedText(payload.shipmentCode, MAX_CODE_LENGTH);
  if (references.length === 0 && id === undefined && code === undefined) {
    throw new Error('Missing callback identity');
  }
  return { references, shipmentId: id, shipmentCode: code };
};

let accurateSecretWarnedOnce = false;

export const createAccurateWebhookHandler =
  (
    statusSyncService: Pick<ShipmentStatusSyncService, 'syncRecord'>,
    dependencies: AccurateWebhookDependencies = defaultDependencies
  ) =>
  async (request: Request, response: Response): Promise<void> => {
    // PR46 fail-closed authentication, before any repository/provider effect.
    // Prefer the header; query support is retained for existing integrations.
    const webhookSecret = dependencies.webhookSecret;
    if (typeof webhookSecret !== 'string' || !webhookSecret.trim() || webhookSecret.length > MAX_SECRET_LENGTH) {
      if (!accurateSecretWarnedOnce) {
        logger.warn('Accurate webhook is disabled until ACCURATE_WEBHOOK_SECRET is configured.');
        accurateSecretWarnedOnce = true;
      }
      response.status(503).json({ ok: false, message: 'Accurate webhook is not configured' });
      return;
    }

    const queryProvided = request.query['webhookSecret'];
    const provided = request.header('x-accurate-webhook-secret') ?? queryProvided;
    if (typeof provided !== 'string' || !provided || provided.length > MAX_SECRET_LENGTH ||
        !constantTimeTextEqual(provided, webhookSecret)) {
      response.status(401).json({ ok: false, message: 'Invalid or missing Accurate webhook secret' });
      return;
    }

    let identity: CallbackIdentity;
    try {
      if (!request.is('application/json')) throw new Error('Expected application/json');
      identity = callbackIdentity(request.body);
    } catch {
      // Malformed events are not actionable failure jobs and must not consume
      // Neon rows. Never persist raw bodies, headers, status or money fields.
      response.status(400).json({ ok: false, message: 'Invalid Accurate callback payload' });
      return;
    }

    const reference = identity.references[0] ?? identity.shipmentCode ?? String(identity.shipmentId);
    let recordId: number | undefined;
    let stage = 'lookup';
    try {
      const record = await dependencies.findByReference(reference);
      if (!record) {
        // Preserve the asynchronous acknowledgement, without inserting an
        // unbounded FailedPayload row for every unknown reference or retry.
        response.status(202).json({ ok: true, matched: false });
        return;
      }
      recordId = record.id;

      let conflict: string | undefined;
      if (record.accurateShipmentId != null && !positiveInteger(record.accurateShipmentId) ||
          record.accurateShipmentCode != null &&
            (typeof record.accurateShipmentCode !== 'string' || !record.accurateShipmentCode.trim()) ||
          record.accurateShipmentId == null && record.accurateShipmentCode == null) {
        conflict = 'Stored shipment identity is missing or invalid';
      } else if (identity.shipmentId !== undefined && record.accurateShipmentId != null &&
                 identity.shipmentId !== record.accurateShipmentId) {
        conflict = 'Callback shipmentId does not match the stored shipment';
      } else if (identity.shipmentCode !== undefined && record.accurateShipmentCode != null &&
                 identity.shipmentCode !== record.accurateShipmentCode) {
        conflict = 'Callback shipmentCode does not match the stored shipment';
      }
      // Two order-reference aliases must resolve to the same local record;
      // precedence alone must not hide a second conflicting order identity.
      if (!conflict && identity.references.length > 1) {
        const alternate = await dependencies.findByReference(identity.references[1]!);
        if (!alternate || alternate.id !== record.id) conflict = 'Callback order references do not match';
      }
      if (conflict) {
        stage = 'review';
        await dependencies.saveFailedPayload({
          source: 'accurate-shipment-status',
          externalId: reference,
          reason: conflict,
          payload: { recordId: record.id, ...identity }
        });
        response.status(409).json({ ok: false, matched: true, message: 'Shipment identity mismatch' });
        return;
      }

      // Callback state/IDs are hints only. The existing native guarded service
      // re-reads Telegraph using stored identity and retains all lane holds.
      stage = 'sync';
      await statusSyncService.syncRecord({
        id: record.id,
        shopifyOrderId: record.shopifyOrderId,
        accurateShipmentId: record.accurateShipmentId ?? undefined,
        accurateShipmentCode: record.accurateShipmentCode ?? undefined
      });

      response.status(200).json({ ok: true, matched: true });
    } catch {
      // Express 4 does not catch rejected async handlers. Do not retry a sync,
      // attempt another DB error write, or log provider errors/raw secrets.
      logger.error('Accurate webhook processing failed', { stage, recordId });
      response.status(500).json({ ok: false, matched: recordId !== undefined });
    }
  };
