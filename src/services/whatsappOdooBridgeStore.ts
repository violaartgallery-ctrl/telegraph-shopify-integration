import type { BridgeLinkState } from './whatsappOdooBridgePolicy.js';

export interface BridgeLink {
  id: number;
  accurateShipmentId: number;
  accurateShipmentCode: string;
  carrierRefNumber: string;
  odooSaleOrderId: number | null;
  odooSaleOrderName: string | null;
  matchMethod: string | null;
  state: string;
  reviewReason: string | null;
  reviewNotifiedAt: Date | null;
  plannedAction: string | null;
  soAmountTotal: number | null;
  soPartnerId: number | null;
  soFingerprint: string | null;
  carrierStatusCode: string | null;
  carrierReturnStatusCode: string | null;
  carrierCancelled: boolean | null;
  carrierCollected: boolean | null;
  carrierPaidToCustomer: boolean | null;
  carrierPrice: number | null;
  collectedAmount: number | null;
  customerDue: number | null;
  deliveryFees: number | null;
  returnFees: number | null;
  returnedValue: number | null;
  carrierFingerprint: string | null;
  returnObservedAt: Date | null;
  returnFingerprint: string | null;
  merchantTarget: number | null;
  odooInvoiceId: number | null;
  odooInvoiceName: string | null;
  odooPaymentId: number | null;
  stockDoneAt: Date | null;
  invoicedAt: Date | null;
  paidAt: Date | null;
  returnedAt: Date | null;
  matchCheckedAt: Date | null;
  lastSyncedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}

export type BridgeLinkCreate = Pick<BridgeLink, 'accurateShipmentId' | 'accurateShipmentCode' | 'carrierRefNumber'> &
  Partial<Omit<BridgeLink, 'id' | 'createdAt' | 'state'>> & { state: BridgeLinkState };
export type BridgeLinkPatch = Partial<Omit<BridgeLink, 'id' | 'createdAt' | 'accurateShipmentId' | 'accurateShipmentCode'>>;

export type OperationStatus = 'claimed' | 'started' | 'completed' | 'needs-review' | 'no-external-attempt';
export interface BridgeOperationRow {
  id: number;
  linkId: number;
  key: string;
  epoch: string;
  token: string;
  status: OperationStatus;
  requestAttempted: boolean;
}

export class BridgeClaimRefusedError extends Error {
  constructor(message: string) { super(message); this.name = 'BridgeClaimRefusedError'; }
}

/** Persistence used by the bridge. The Prisma version is below; tests use an in-memory one. */
export interface BridgeStore {
  findLinksByCodes(codes: string[]): Promise<BridgeLink[]>;
  findLinkBySaleOrderId(saleOrderId: number): Promise<BridgeLink | null>;
  getLink(id: number): Promise<BridgeLink | null>;
  /** Returns null when the waybill (or the SO) is already registered. */
  createLink(data: BridgeLinkCreate): Promise<BridgeLink | null>;
  /** Compare-and-set on `state` when expectedState is given. */
  updateLink(id: number, expectedState: string | null, patch: BridgeLinkPatch): Promise<boolean>;
  listLinks(states: string[], limit: number): Promise<BridgeLink[]>;
  /** True when a Shopify ShipmentRecord already owns this waybill code. */
  shopifyRecordUsesCode(code: string): Promise<boolean>;
  /** Owner/support hold (FailedPayload source whatsapp_odoo_hold, externalId = SO name or waybill code). */
  holdApplies(link: Pick<BridgeLink, 'accurateShipmentCode' | 'carrierRefNumber'>): Promise<boolean>;
  /**
   * Atomically claim step `key` for the link. Refused when the link is held or
   * not in `expectedState`, when any other claim of this link is unfinished
   * or uncertain, or when this key was already attempted.
   */
  claimOperation(input: { linkId: number; key: string; expectedState: string; fingerprint: string | null; epoch: string; token: string }): Promise<BridgeOperationRow>;
  /** CAS on (id, token, fromStatus). */
  changeOperation(id: number, token: string, fromStatus: OperationStatus,
    patch: { status: OperationStatus; requestAttempted?: boolean; reason?: string | null }): Promise<boolean>;
  readOperation(id: number): Promise<BridgeOperationRow | null>;
}

const HOLD_SOURCE = 'whatsapp_odoo_hold';
const UNFINISHED: OperationStatus[] = ['claimed', 'started', 'needs-review'];

export function createPrismaBridgeStore(): BridgeStore {
  const db = async () => (await import('../lib/prisma.js')).basePrisma;
  const isUnique = (error: unknown) => (error as { code?: string })?.code === 'P2002';
  return {
    async findLinksByCodes(codes) {
      if (codes.length === 0) return [];
      return await (await db()).whatsappOdooLink.findMany({ where: { accurateShipmentCode: { in: codes } } });
    },
    async findLinkBySaleOrderId(saleOrderId) {
      return await (await db()).whatsappOdooLink.findUnique({ where: { odooSaleOrderId: saleOrderId } });
    },
    async getLink(id) {
      return await (await db()).whatsappOdooLink.findUnique({ where: { id } });
    },
    async createLink(data) {
      try { return await (await db()).whatsappOdooLink.create({ data }); }
      catch (error) { if (isUnique(error)) return null; throw error; }
    },
    async updateLink(id, expectedState, patch) {
      const where = expectedState === null ? { id } : { id, state: expectedState };
      return (await (await db()).whatsappOdooLink.updateMany({ where, data: patch })).count === 1;
    },
    async listLinks(states, limit) {
      return await (await db()).whatsappOdooLink.findMany({
        where: { state: { in: states } }, orderBy: [{ lastSyncedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }], take: limit,
      });
    },
    async shopifyRecordUsesCode(code) {
      const found = await (await db()).shipmentRecord.findFirst({
        where: { OR: [{ accurateShipmentCode: code }, { plannedShipmentCode: code }] }, select: { id: true },
      });
      return Boolean(found);
    },
    async holdApplies(link) {
      const found = await (await db()).failedPayload.findFirst({
        where: { source: HOLD_SOURCE, externalId: { in: [link.carrierRefNumber, link.accurateShipmentCode] } }, select: { id: true },
      });
      return Boolean(found);
    },
    async claimOperation(input) {
      const prisma = await db();
      return await prisma.$transaction(async tx => {
        await tx.$queryRawUnsafe('SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext($1))', 'whatsapp-odoo-link:' + input.linkId);
        const link = await tx.whatsappOdooLink.findUnique({ where: { id: input.linkId } });
        if (!link || link.state !== input.expectedState) throw new BridgeClaimRefusedError('Link state changed before claim');
        const hold = await tx.failedPayload.findFirst({
          where: { source: HOLD_SOURCE, externalId: { in: [link.carrierRefNumber, link.accurateShipmentCode] } }, select: { id: true },
        });
        if (hold) throw new BridgeClaimRefusedError('Durable owner hold');
        const prior = await tx.whatsappOdooOperation.findMany({ where: { linkId: input.linkId } });
        if (prior.some(p => UNFINISHED.includes(p.status as OperationStatus))) throw new BridgeClaimRefusedError('Unfinished or uncertain operation exists');
        const same = prior.find(p => p.key === input.key);
        const data = { epoch: input.epoch, token: input.token, fingerprint: input.fingerprint, status: 'claimed',
          requestAttempted: false, reason: null, claimedAt: new Date(), startedAt: null, finishedAt: null };
        if (same) {
          if (same.status !== 'no-external-attempt') throw new BridgeClaimRefusedError('Step already attempted');
          const changed = await tx.whatsappOdooOperation.updateMany({ where: { id: same.id, status: 'no-external-attempt' }, data });
          if (changed.count !== 1) throw new BridgeClaimRefusedError('Claim CAS lost');
          return { ...same, ...data } as BridgeOperationRow;
        }
        return await tx.whatsappOdooOperation.create({ data: { linkId: input.linkId, key: input.key, ...data } }) as BridgeOperationRow;
      }, { timeout: 30_000, maxWait: 15_000 });
    },
    async changeOperation(id, token, fromStatus, patch) {
      const now = new Date();
      const data = {
        status: patch.status,
        ...(patch.requestAttempted !== undefined ? { requestAttempted: patch.requestAttempted } : {}),
        ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
        ...(patch.status === 'started' ? { startedAt: now } : {}),
        ...(['completed', 'needs-review', 'no-external-attempt'].includes(patch.status) ? { finishedAt: now } : {}),
      };
      return (await (await db()).whatsappOdooOperation.updateMany({ where: { id, token, status: fromStatus }, data })).count === 1;
    },
    async readOperation(id) {
      return await (await db()).whatsappOdooOperation.findUnique({ where: { id } }) as BridgeOperationRow | null;
    },
  };
}
