import { createHash } from 'node:crypto';
import { AutomaticOperationReviewError } from './automaticOperationSafety.js';
import {
  ACTIVE_STATES, BRIDGE_CODE_PATTERN, carrierFingerprint, cents, decideCarrierAction, isBridgeCandidate,
  isCarrierReturn, matchSaleOrder, planInvoice, relationId, returnCode, reviewMessage, saleOrderFingerprint,
  sameMoney, statusCode,
  type BridgeCarrierShipment, type BridgeConfig, type BridgeInvoice, type BridgeLinkState,
  type BridgeSaleOrder, type BridgeSaleOrderLine,
} from './whatsappOdooBridgePolicy.js';
import { BridgeClaimRefusedError, type BridgeLink, type BridgeLinkPatch, type BridgeStore } from './whatsappOdooBridgeStore.js';
import { withWhatsappOdooOperation } from './whatsappOdooOperation.js';

export interface BridgeCarrierPort {
  /** Newest shipments first (page 1 = most recent). */
  listRecent(page: number): Promise<{ data: BridgeCarrierShipment[]; hasMorePages: boolean }>;
  listByIds(ids: number[]): Promise<BridgeCarrierShipment[]>;
}

export interface BridgePicking { id: number; state?: string | null; location_dest_id?: [number, string] | number | false | null }
export interface BridgePayment {
  id: number;
  state?: string | null;
  amount?: number | null;
  journal_id?: [number, string] | number | false | null;
  partner_id?: [number, string] | number | false | null;
  payment_type?: string | null;
  reconciled_invoice_ids?: number[];
}

export interface BridgeOdooPort {
  findSaleOrdersByName(name: string): Promise<BridgeSaleOrder[]>;
  findSaleOrdersReferencingCode(code: string): Promise<Array<Pick<BridgeSaleOrder, 'id' | 'name'>>>;
  readSaleOrder(id: number): Promise<BridgeSaleOrder | null>;
  readLines(ids: number[]): Promise<BridgeSaleOrderLine[]>;
  readPickings(ids: number[]): Promise<BridgePicking[]>;
  readInvoices(so: BridgeSaleOrder): Promise<BridgeInvoice[]>;
  readInvoice(id: number): Promise<BridgeInvoice | null>;
  readJournal(id: number): Promise<{ id: number; type?: string | null } | null>;
  readPayment(id: number): Promise<BridgePayment | null>;
  /** Writes (must run inside a bridge operation). */
  deliverStock(saleOrderId: number): Promise<void>;
  createMerchantNetInvoice(saleOrderId: number, target: number): Promise<BridgeInvoice>;
  /** Returns the created payment id, or undefined when Odoo did not say. */
  registerPayment(invoiceId: number, amount: number, journalId: number, memo: string): Promise<number | undefined>;
  previewReturn(saleOrderId: number): Promise<{ status: string; reason?: string }>;
  executeReturn(saleOrderId: number): Promise<{ status: string; reason?: string }>;
}

export interface BridgeNotifier { send(chatIds: string[], text: string): Promise<void> }

export interface BridgeDeps {
  config: BridgeConfig;
  store: BridgeStore;
  carrier: BridgeCarrierPort;
  odoo: BridgeOdooPort;
  notifier: BridgeNotifier;
  /** Cash journal used for COD settlements (Odoo journal 7). */
  paymentJournalId: number | undefined;
  now?: () => number;
  epoch?: () => string | undefined;
}

const MAX_NEW_PER_RUN = 10;
const MAX_REMATCH_PER_RUN = 5;
const REMATCH_EVERY_MS = 55 * 60_000;
const ACTIONABLE = ['deliver-stock', 'settle', 'pay', 'return'];

const reasonOf = (error: unknown) => String((error as Error)?.message ?? error).slice(0, 300);

/** Fields of a carrier return that must stay unchanged through the grace period. */
export const returnFingerprint = (s: BridgeCarrierShipment) => createHash('sha256')
  .update(JSON.stringify(['wa-return-v1', s.id, s.code, statusCode(s), returnCode(s), cents(s.collectedAmount)])).digest('hex');

const snapshot = (s: BridgeCarrierShipment): BridgeLinkPatch => ({
  carrierStatusCode: statusCode(s) || null,
  carrierReturnStatusCode: returnCode(s) || null,
  carrierCancelled: Boolean(s.cancelled),
  carrierCollected: Boolean(s.collected),
  carrierPaidToCustomer: Boolean(s.paidToCustomer),
  carrierPrice: s.price ?? null,
  collectedAmount: s.collectedAmount ?? null,
  customerDue: s.customerDue ?? null,
  deliveryFees: s.deliveryFees ?? null,
  returnFees: s.returnFees ?? null,
  returnedValue: s.returnedValue ?? null,
  carrierFingerprint: carrierFingerprint(s),
});

export class WhatsappOdooBridgeService {
  private readonly now: () => number;

  constructor(private readonly deps: BridgeDeps) {
    this.now = deps.now ?? Date.now;
  }

  private get config() { return this.deps.config; }
  private get applying() { return this.config.enabled && this.config.mode === 'apply'; }

  // ---------------------------------------------------------------- discovery

  async discover(): Promise<Record<string, unknown>> {
    if (!this.config.enabled) return { disabled: true };
    const summary = { scanned: 0, candidates: 0, registered: 0, unmatched: 0, reviews: 0, known: 0, rematched: 0 };
    const seen = new Map<string, BridgeCarrierShipment>();
    for (let page = 1; page <= this.config.discoveryPages; page++) {
      const result = await this.deps.carrier.listRecent(page);
      summary.scanned += result.data.length;
      for (const row of result.data) if (isBridgeCandidate(row)) seen.set(row.code, row);
      if (!result.hasMorePages) break;
    }
    summary.candidates = seen.size;
    const known = new Set((await this.deps.store.findLinksByCodes([...seen.keys()])).map(l => l.accurateShipmentCode));
    summary.known = known.size;
    let budget = MAX_NEW_PER_RUN;
    for (const shipment of seen.values()) {
      if (known.has(shipment.code) || budget-- <= 0) continue;
      const state = await this.register(shipment);
      if (state === 'linked') summary.registered++;
      else if (state === 'unmatched') summary.unmatched++;
      else if (state === 'needs-review') summary.reviews++;
    }
    summary.rematched = await this.rematchUnmatched();
    return summary;
  }

  /** Registers one never-seen candidate. Reads only (Odoo + Neon insert). */
  private async register(shipment: BridgeCarrierShipment): Promise<BridgeLinkState | null> {
    const base = {
      accurateShipmentId: shipment.id, accurateShipmentCode: shipment.code,
      carrierRefNumber: shipment.refNumber ?? '', matchCheckedAt: new Date(this.now()),
      lastSyncedAt: new Date(this.now()), ...snapshot(shipment),
    };
    if (await this.deps.store.shopifyRecordUsesCode(shipment.code)) {
      const link = await this.deps.store.createLink({ ...base, state: 'needs-review', reviewReason: 'waybill-owned-by-shopify-order' });
      if (link) await this.notifyReview(link);
      return link ? 'needs-review' : null;
    }
    const match = await this.evaluateMatch(shipment);
    if (match.result.kind === 'linked') {
      const so = match.so!;
      const other = await this.deps.store.findLinkBySaleOrderId(so.id);
      if (other) {
        const link = await this.deps.store.createLink({ ...base, state: 'needs-review', odooSaleOrderName: so.name,
          reviewReason: `sale-order-already-linked-to-${other.accurateShipmentCode}` });
        if (link) await this.notifyReview(link);
        return link ? 'needs-review' : null;
      }
      const link = await this.deps.store.createLink({ ...base, state: 'linked', odooSaleOrderId: so.id, odooSaleOrderName: so.name,
        matchMethod: match.result.matchMethod, soAmountTotal: match.result.amountTotal, soPartnerId: relationId(so.partner_id),
        soFingerprint: saleOrderFingerprint(so, match.lines),
        plannedAction: decideCarrierAction({ state: 'linked', shipment, soAmountTotal: match.result.amountTotal,
          maxCustomerShipping: this.config.maxCustomerShipping }).kind });
      return link ? 'linked' : null;
    }
    const state: BridgeLinkState = match.result.kind === 'unmatched' ? 'unmatched' : 'needs-review';
    const link = await this.deps.store.createLink({ ...base, state, reviewReason: match.result.reason,
      odooSaleOrderName: match.so?.name ?? null });
    if (link && state === 'needs-review') await this.notifyReview(link);
    return link ? state : null;
  }

  private async evaluateMatch(shipment: BridgeCarrierShipment) {
    const ref = shipment.refNumber ?? '';
    const saleOrders = await this.deps.odoo.findSaleOrdersByName(ref);
    const sosReferencingCode = BRIDGE_CODE_PATTERN.test(shipment.code)
      ? await this.deps.odoo.findSaleOrdersReferencingCode(shipment.code) : [];
    const so = saleOrders.length === 1 ? saleOrders[0]! : undefined;
    const lines = so?.order_line?.length ? await this.deps.odoo.readLines(so.order_line) : [];
    const result = matchSaleOrder({ shipment, saleOrders, sosReferencingCode, lines, config: this.config });
    return { result, so, lines };
  }

  private async rematchUnmatched(): Promise<number> {
    const due = (await this.deps.store.listLinks(['unmatched'], 50))
      .filter(l => !l.matchCheckedAt || this.now() - l.matchCheckedAt.getTime() >= REMATCH_EVERY_MS)
      .slice(0, MAX_REMATCH_PER_RUN);
    if (due.length === 0) return 0;
    const live = await this.deps.carrier.listByIds(due.map(l => l.accurateShipmentId));
    let changed = 0;
    for (const link of due) {
      const shipment = live.find(s => s.id === link.accurateShipmentId);
      const at = new Date(this.now());
      if (!shipment || shipment.code !== link.accurateShipmentCode || shipment.refNumber !== link.carrierRefNumber) {
        await this.markReview(link, 'carrier-identity-changed-or-not-visible');
        changed++;
        continue;
      }
      const match = await this.evaluateMatch(shipment);
      if (match.result.kind === 'linked') {
        const so = match.so!;
        if (await this.deps.store.findLinkBySaleOrderId(so.id)) {
          await this.markReview(link, 'sale-order-already-linked-to-another-waybill');
        } else {
          await this.deps.store.updateLink(link.id, 'unmatched', { state: 'linked', odooSaleOrderId: so.id, odooSaleOrderName: so.name,
            matchMethod: match.result.matchMethod, soAmountTotal: match.result.amountTotal, soPartnerId: relationId(so.partner_id),
            soFingerprint: saleOrderFingerprint(so, match.lines), reviewReason: null, matchCheckedAt: at, lastSyncedAt: at, ...snapshot(shipment) });
        }
        changed++;
      } else if (match.result.kind === 'review') {
        await this.markReview(link, match.result.reason);
        changed++;
      } else if (this.now() - link.createdAt.getTime() > this.config.unmatchedTimeoutMs) {
        await this.markReview(link, `unmatched-timeout:${match.result.reason}`);
        changed++;
      } else {
        await this.deps.store.updateLink(link.id, 'unmatched', { reviewReason: match.result.reason, matchCheckedAt: at });
      }
    }
    return changed;
  }

  // ------------------------------------------------------------ status sync

  /** One carrier read for up to 100 open links; plans the next action. No Odoo writes. */
  async syncStatuses(): Promise<Record<string, unknown>> {
    if (!this.config.enabled) return { disabled: true };
    const links = await this.deps.store.listLinks(ACTIVE_STATES, 100);
    if (links.length === 0) return { links: 0 };
    const live = await this.deps.carrier.listByIds(links.map(l => l.accurateShipmentId));
    const summary = { links: links.length, updated: 0, notVisible: 0, reviews: 0, actionable: 0 };
    for (const link of links) {
      const shipment = live.find(s => s.id === link.accurateShipmentId);
      const at = new Date(this.now());
      if (!shipment) {
        summary.notVisible++;
        await this.deps.store.updateLink(link.id, link.state, { lastSyncedAt: at, lastError: 'carrier-waybill-not-visible' });
        continue;
      }
      if (shipment.code !== link.accurateShipmentCode || shipment.refNumber !== link.carrierRefNumber) {
        summary.reviews++;
        await this.markReview(link, 'carrier-identity-changed');
        continue;
      }
      const patch: BridgeLinkPatch = { ...snapshot(shipment), lastSyncedAt: at, lastError: null };
      if (isCarrierReturn(shipment)) {
        const fp = returnFingerprint(shipment);
        if (link.returnFingerprint !== fp) { patch.returnFingerprint = fp; patch.returnObservedAt = at; }
      } else if (link.returnFingerprint || link.returnObservedAt) {
        patch.returnFingerprint = null;
        patch.returnObservedAt = null;
      }
      const decision = this.plan(link.state as BridgeLinkState, shipment, link);
      if (decision.kind === 'review') {
        summary.reviews++;
        if (!this.applying) {
          // Observe mode never progresses links, so a lifecycle review here is
          // only a planned note; the state stays unchanged for apply mode.
          await this.deps.store.updateLink(link.id, link.state, { ...patch, plannedAction: `review:${decision.reason}` });
          continue;
        }
        await this.deps.store.updateLink(link.id, link.state, patch);
        await this.markReview(link, decision.reason);
        continue;
      }
      patch.plannedAction = decision.kind === 'wait' ? `wait:${decision.reason}` : decision.kind;
      if (ACTIONABLE.includes(decision.kind)) summary.actionable++;
      if (await this.deps.store.updateLink(link.id, link.state, patch)) summary.updated++;
    }
    return summary;
  }

  private plan(state: BridgeLinkState, shipment: BridgeCarrierShipment, link: Pick<BridgeLink, 'soAmountTotal'>):
    ReturnType<typeof decideCarrierAction> | { kind: 'pay'; target: number } {
    const decision = decideCarrierAction({ state: state === 'invoiced' ? 'stock-done' : state, shipment,
      soAmountTotal: Number(link.soAmountTotal), maxCustomerShipping: this.config.maxCustomerShipping });
    if (state !== 'invoiced') return decision;
    if (decision.kind === 'settle') return { kind: 'pay', target: decision.target };
    if (decision.kind === 'return') return { kind: 'review', reason: 'carrier-return-after-invoice' };
    return decision;
  }

  // ---------------------------------------------------------------- actions

  /** Executes planned steps with fresh carrier + Odoo reads. Apply mode only. */
  async processActions(options: { limit?: number; budgetMs?: number } = {}): Promise<Record<string, unknown>> {
    if (!this.config.enabled) return { disabled: true };
    const links = (await this.deps.store.listLinks(ACTIVE_STATES, 100))
      .filter(l => ACTIONABLE.includes(l.plannedAction ?? ''));
    if (!this.applying) return { observe: true, planned: links.map(l => `${l.carrierRefNumber}:${l.plannedAction}`) };
    if (!this.deps.epoch?.()) return { held: 'safe-queue-epoch-missing', planned: links.length };
    const started = this.now(), limit = options.limit ?? 5, budgetMs = options.budgetMs ?? 45_000;
    const summary: Record<string, number> = { planned: links.length, done: 0, waiting: 0, reviews: 0, skipped: 0, failed: 0 };
    for (const link of links.slice(0, limit)) {
      if (this.now() - started > budgetMs) break;
      try {
        const outcome = await this.executeLink(link);
        summary[outcome] = (summary[outcome] ?? 0) + 1;
      } catch (error) {
        if (error instanceof AutomaticOperationReviewError) {
          summary.reviews++;
          const fresh = await this.deps.store.getLink(link.id);
          if (fresh && fresh.state !== 'needs-review') await this.markReview(fresh, reasonOf(error));
        } else if (error instanceof BridgeClaimRefusedError) {
          summary.skipped++;
        } else {
          summary.failed++;
          await this.deps.store.updateLink(link.id, null, { lastError: reasonOf(error) });
        }
      }
    }
    return summary;
  }

  private async executeLink(initial: BridgeLink): Promise<'done' | 'waiting' | 'reviews' | 'skipped'> {
    let link = initial;
    if (await this.deps.store.holdApplies(link)) return 'skipped';
    const shipment = await this.freshShipment(link);
    if (!shipment) return 'waiting';
    const so = await this.verifiedSaleOrder(link);
    let outcome: 'done' | 'waiting' | 'reviews' | 'skipped' = 'waiting';
    // A single run may advance stock -> invoice -> payment, each its own claim.
    for (let step = 0; step < 3; step++) {
      const decision = this.plan(link.state as BridgeLinkState, shipment, link);
      if (decision.kind === 'review') { await this.markReview(link, decision.reason); return 'reviews'; }
      if (decision.kind === 'wait') {
        await this.deps.store.updateLink(link.id, link.state, { plannedAction: `wait:${decision.reason}` });
        return outcome;
      }
      let next: BridgeLink | null = null;
      if (decision.kind === 'deliver-stock') next = await this.deliverStock(link, so, shipment);
      else if (decision.kind === 'settle') next = await this.invoice(link, so, shipment, decision.target);
      else if (decision.kind === 'pay') next = await this.pay(link, shipment, decision.target);
      else if (decision.kind === 'return') next = await this.returnStock(link, so, shipment);
      if (!next) return outcome;
      outcome = 'done';
      link = next;
      if (!ACTIVE_STATES.includes(link.state as BridgeLinkState)) return outcome;
    }
    return outcome;
  }

  private async freshShipment(link: BridgeLink): Promise<BridgeCarrierShipment | null> {
    const rows = (await this.deps.carrier.listByIds([link.accurateShipmentId])).filter(s => s.id === link.accurateShipmentId);
    if (rows.length !== 1) return null;
    const s = rows[0]!;
    if (s.code !== link.accurateShipmentCode || s.refNumber !== link.carrierRefNumber) {
      throw new AutomaticOperationReviewError('carrier-identity-changed');
    }
    return s;
  }

  /** The SO must still be exactly what was linked (lines, totals, partner, references). */
  private async verifiedSaleOrder(link: BridgeLink): Promise<BridgeSaleOrder> {
    if (!link.odooSaleOrderId) throw new AutomaticOperationReviewError('link-has-no-sale-order');
    const so = await this.deps.odoo.readSaleOrder(link.odooSaleOrderId);
    if (!so || so.name !== link.odooSaleOrderName || so.name !== link.carrierRefNumber) throw new AutomaticOperationReviewError('sale-order-identity-changed');
    if (so.state !== 'sale') throw new AutomaticOperationReviewError(`sale-order-state-${so.state || 'missing'}`);
    const lines = await this.deps.odoo.readLines(so.order_line ?? []);
    if (saleOrderFingerprint(so, lines) !== link.soFingerprint) throw new AutomaticOperationReviewError('sale-order-changed-after-link');
    const refs = await this.deps.odoo.findSaleOrdersReferencingCode(link.accurateShipmentCode);
    if (refs.some(r => r.id !== so.id)) throw new AutomaticOperationReviewError('waybill-code-on-another-sale-order');
    for (const field of [so.origin, so.client_order_ref]) {
      const value = typeof field === 'string' ? field.trim() : '';
      if (value && value !== link.accurateShipmentCode) throw new AutomaticOperationReviewError('sale-order-reference-names-another-waybill');
    }
    return so;
  }

  private async pickingsDone(so: BridgeSaleOrder): Promise<boolean> {
    const pickings = (await this.deps.odoo.readPickings(so.picking_ids ?? [])).filter(p => p.state !== 'cancel');
    const customer = pickings.filter(p => /customers/i.test(Array.isArray(p.location_dest_id) ? p.location_dest_id[1] : ''));
    return pickings.length > 0 && customer.length > 0 && pickings.every(p => p.state === 'done');
  }

  private op<T>(link: BridgeLink, key: string, shipment: BridgeCarrierShipment, action: () => Promise<T>): Promise<T> {
    return withWhatsappOdooOperation({ store: this.deps.store, epoch: this.deps.epoch,
      onReview: async reason => { const fresh = await this.deps.store.getLink(link.id); if (fresh) await this.markReview(fresh, reason); } },
    { linkId: link.id, key, expectedState: link.state, fingerprint: carrierFingerprint(shipment) }, action);
  }

  private async advance(link: BridgeLink, to: BridgeLinkState, patch: BridgeLinkPatch): Promise<BridgeLink> {
    const ok = await this.deps.store.updateLink(link.id, link.state, { ...patch, state: to, plannedAction: null, lastError: null });
    if (!ok) throw new BridgeClaimRefusedError('Link state changed concurrently');
    return (await this.deps.store.getLink(link.id))!;
  }

  private async deliverStock(link: BridgeLink, so: BridgeSaleOrder, shipment: BridgeCarrierShipment): Promise<BridgeLink> {
    const at = new Date(this.now());
    if (await this.pickingsDone(so)) return await this.advance(link, 'stock-done', { stockDoneAt: at });
    await this.op(link, 'stock:v1', shipment, async () => {
      await this.deps.odoo.deliverStock(so.id);
      if (!await this.pickingsDone(so)) throw new Error('Odoo pickings are not all done after delivery');
    });
    return await this.advance(link, 'stock-done', { stockDoneAt: at });
  }

  private async invoice(link: BridgeLink, so: BridgeSaleOrder, shipment: BridgeCarrierShipment, target: number): Promise<BridgeLink | null> {
    if (!await this.pickingsDone(so)) { await this.markReview(link, 'stock-delivery-reverted-before-invoice'); return null; }
    const plan = planInvoice(await this.deps.odoo.readInvoices(so), target);
    const at = new Date(this.now());
    if (plan.kind === 'review') { await this.markReview(link, plan.reason); return null; }
    if (plan.kind === 'adopt-paid') {
      return await this.advance(link, 'paid', { odooInvoiceId: plan.invoice.id, odooInvoiceName: plan.invoice.name ?? null,
        merchantTarget: target, invoicedAt: at, paidAt: at, reviewReason: 'invoice-paid-outside-bridge' });
    }
    if (plan.kind === 'adopt-unpaid') {
      return await this.advance(link, 'invoiced', { odooInvoiceId: plan.invoice.id, odooInvoiceName: plan.invoice.name ?? null,
        merchantTarget: target, invoicedAt: at });
    }
    const invoice = await this.op(link, 'invoice:v1', shipment, async () => {
      const created = await this.deps.odoo.createMerchantNetInvoice(so.id, target);
      const read = await this.deps.odoo.readInvoice(created.id);
      if (!read || read.move_type !== 'out_invoice' || read.state !== 'posted' || !sameMoney(read.amount_total, target) ||
          read.invoice_origin !== so.name) throw new Error('Created invoice does not match the merchant-net target');
      return read;
    });
    return await this.advance(link, 'invoiced', { odooInvoiceId: invoice.id, odooInvoiceName: invoice.name ?? null,
      merchantTarget: target, invoicedAt: at });
  }

  private async pay(link: BridgeLink, shipment: BridgeCarrierShipment, target: number): Promise<BridgeLink | null> {
    const journalId = this.deps.paymentJournalId;
    if (!journalId || !link.odooInvoiceId || !sameMoney(link.merchantTarget, target)) {
      await this.markReview(link, !journalId ? 'payment-journal-not-configured' : 'merchant-net-changed-after-invoice');
      return null;
    }
    const journal = await this.deps.odoo.readJournal(journalId);
    if (journal?.type !== 'cash') { await this.markReview(link, 'payment-journal-is-not-cash'); return null; }
    const invoice = await this.deps.odoo.readInvoice(link.odooInvoiceId);
    const at = new Date(this.now());
    if (!invoice || invoice.state !== 'posted' || !sameMoney(invoice.amount_total, target)) {
      await this.markReview(link, 'invoice-changed-before-payment');
      return null;
    }
    if (['paid', 'in_payment'].includes(invoice.payment_state ?? '') && cents(invoice.amount_residual) === 0) {
      return await this.advance(link, 'paid', { paidAt: at, reviewReason: 'invoice-paid-outside-bridge' });
    }
    if (invoice.payment_state !== 'not_paid' || !sameMoney(invoice.amount_residual, target)) {
      await this.markReview(link, 'invoice-partially-paid-before-bridge-payment');
      return null;
    }
    const partnerId = relationId(invoice.commercial_partner_id) ?? relationId(invoice.partner_id);
    const paymentId = await this.op(link, 'payment:v1', shipment, async () => {
      const id = await this.deps.odoo.registerPayment(invoice.id, target, journalId, `${link.carrierRefNumber} / ${link.accurateShipmentCode}`);
      if (!id) throw new Error('Odoo did not return the payment id');
      const payment = await this.deps.odoo.readPayment(id);
      const paid = await this.deps.odoo.readInvoice(invoice.id);
      const reconciled = payment?.reconciled_invoice_ids ?? [];
      if (!payment || payment.state !== 'posted' || payment.payment_type !== 'inbound' || relationId(payment.journal_id) !== journalId ||
          !sameMoney(payment.amount, target) || (partnerId !== null && relationId(payment.partner_id) !== partnerId) ||
          reconciled.length !== 1 || reconciled[0] !== invoice.id ||
          !paid || !['paid', 'in_payment'].includes(paid.payment_state ?? '') || cents(paid.amount_residual) !== 0) {
        throw new Error('Payment readback is not an exact single Cash settlement of this invoice');
      }
      return id;
    });
    return await this.advance(link, 'paid', { odooPaymentId: paymentId, paidAt: at });
  }

  private async returnStock(link: BridgeLink, so: BridgeSaleOrder, shipment: BridgeCarrierShipment): Promise<BridgeLink | null> {
    const fp = returnFingerprint(shipment);
    if (!link.returnObservedAt || link.returnFingerprint !== fp ||
        this.now() - link.returnObservedAt.getTime() < this.config.returnGraceMs) {
      await this.deps.store.updateLink(link.id, link.state, { plannedAction: 'wait:return-grace' });
      return null;
    }
    const invoices = (await this.deps.odoo.readInvoices(so)).filter(i => i.state !== 'cancel');
    if (invoices.length > 0) { await this.markReview(link, 'carrier-return-but-sale-order-invoiced'); return null; }
    const at = new Date(this.now());
    const preview = await this.deps.odoo.previewReturn(so.id);
    if (preview.status === 'needs-review') { await this.markReview(link, `odoo-return-preview:${preview.reason ?? 'needs-review'}`); return null; }
    if (preview.status !== 'already-complete') {
      await this.op(link, 'return:v1', shipment, async () => {
        const result = await this.deps.odoo.executeReturn(so.id);
        if (result.status !== 'already-complete') throw new Error(`Odoo return did not complete: ${result.reason ?? result.status}`);
      });
    }
    return await this.advance(link, 'returned', { returnedAt: at });
  }

  // ------------------------------------------------------------------ review

  private async markReview(link: BridgeLink, reason: string): Promise<void> {
    if (link.state === 'needs-review') return;
    const ok = await this.deps.store.updateLink(link.id, link.state, { state: 'needs-review', reviewReason: reason.slice(0, 500), plannedAction: null });
    if (!ok) return;
    const fresh = await this.deps.store.getLink(link.id);
    if (fresh) await this.notifyReview(fresh);
  }

  /** Telegram notice once per link, apply mode only (observe mode is silent). */
  private async notifyReview(link: BridgeLink): Promise<void> {
    if (!this.applying || link.reviewNotifiedAt || this.config.alertChatIds.length === 0) return;
    try {
      await this.deps.notifier.send(this.config.alertChatIds, reviewMessage(link));
      await this.deps.store.updateLink(link.id, 'needs-review', { reviewNotifiedAt: new Date(this.now()) });
    } catch { /* Best effort: a failed notice never changes accounting state; the review stays in Neon (reviewNotifiedAt null). */ }
  }
}
