import { createHash } from 'node:crypto';

import type { OdooClient, OdooRecord } from './odooClient.js';

type OdooRpcClient = Pick<OdooClient, 'searchRead' | 'create' | 'call'>;

type Relation = [number, string] | number | false;

interface SaleOrderRecord extends OdooRecord {
  name?: string;
  state?: string;
  amount_total?: number;
  invoice_ids?: number[];
  picking_ids?: number[];
  order_line?: number[];
  client_order_ref?: string | false;
  origin?: string | false;
}

interface SaleOrderLineRecord extends OdooRecord {
  product_id?: Relation;
  product_uom_qty?: number;
  qty_delivered?: number;
  qty_invoiced?: number;
}

interface PickingRecord extends OdooRecord {
  name?: string;
  state?: string;
  location_id?: Relation;
  location_dest_id?: Relation;
  origin?: string | false;
  move_ids?: number[];
}

interface MoveRecord extends OdooRecord {
  name?: string;
  state?: string;
  product_id?: Relation;
  product_uom?: Relation;
  product_uom_qty?: number;
  quantity?: number;
  picked?: boolean;
  to_refund?: boolean;
  move_line_ids?: number[];
  picking_id?: Relation;
  origin_returned_move_id?: Relation;
  returned_move_ids?: number[];
  location_id?: Relation;
  location_dest_id?: Relation;
}

interface InvoiceRecord extends OdooRecord {
  name?: string;
  move_type?: string;
  state?: string;
  payment_state?: string;
  amount_total?: number;
  amount_residual?: number;
  invoice_origin?: string | false;
  reversed_entry_id?: Relation;
  journal_id?: Relation;
  company_id?: Relation;
  date?: string;
}

export interface OdooSaleReturnSnapshot {
  saleOrder: SaleOrderRecord;
  saleOrderLines: SaleOrderLineRecord[];
  pickings: PickingRecord[];
  moves: MoveRecord[];
  invoices: InvoiceRecord[];
}

export interface OdooSaleReturnPreview {
  status: 'ready' | 'already-complete' | 'needs-review';
  reason?: string;
  fingerprint: string;
  saleOrderId: number;
  saleOrderName: string;
  saleOrderState: string;
  customerPhaseComplete: boolean;
  internalPhaseComplete: boolean;
  deliveredQuantityZero: boolean;
  activeInvoiceCount: number;
  openReturnPickingIds: number[];
}

export interface OdooSaleReturnResult extends OdooSaleReturnPreview {
  createdReturnPickingIds: number[];
  resumedReturnPickingIds: number[];
  cancelledSaleOrder: boolean;
  createdCreditNoteIds?: number[];
}

export class OdooSaleReturnReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OdooSaleReturnReviewError';
  }
}

const relationId = (value?: Relation): number | null =>
  Array.isArray(value) ? value[0] : typeof value === 'number' ? value : null;

const relationName = (value?: Relation): string =>
  Array.isArray(value) ? value[1] : '';

const quantity = (move: MoveRecord): number => Number(move.quantity ?? move.product_uom_qty ?? 0);
const plannedQuantity = (move: MoveRecord): number => Number(move.product_uom_qty ?? move.quantity ?? 0);
const tolerance = 0.0001;

const uniqueById = <T extends { id: number }>(rows: T[]): T[] =>
  [...new Map(rows.map((row) => [row.id, row])).values()].sort((left, right) => left.id - right.id);

const isOriginalPicking = (picking: PickingRecord, saleOrderName: string): boolean =>
  picking.origin === saleOrderName;

const isCustomerDelivery = (picking: PickingRecord): boolean =>
  !/customers/i.test(relationName(picking.location_id)) && /customers/i.test(relationName(picking.location_dest_id));

const isInternalPick = (picking: PickingRecord): boolean =>
  /stock/i.test(relationName(picking.location_id)) &&
  !/customers/i.test(relationName(picking.location_dest_id));

const moveOriginalId = (move: MoveRecord): number | null => relationId(move.origin_returned_move_id);

const activeInvoices = (snapshot: OdooSaleReturnSnapshot): InvoiceRecord[] =>
  snapshot.invoices.filter((invoice) =>
    ['out_invoice', 'out_refund'].includes(invoice.move_type ?? '') && invoice.state !== 'cancel'
  );

// A posted customer invoice plus posted credit note(s) that reverse the exact
// gross amount is a complete accounting reversal. The original customer
// payment deliberately remains visible as customer credit until an actual cash
// refund is recorded; deleting or cancelling that real payment would corrupt
// the bank/cash history.
const blockingInvoices = (snapshot: OdooSaleReturnSnapshot): InvoiceRecord[] => {
  const invoices = activeInvoices(snapshot);
  const originals = new Map(
    invoices.filter((invoice) => invoice.move_type === 'out_invoice').map((invoice) => [invoice.id, invoice])
  );
  const refundTotals = new Map<number, number>();
  for (const refund of invoices.filter((invoice) => invoice.move_type === 'out_refund' && invoice.state === 'posted')) {
    const originalId = relationId(refund.reversed_entry_id);
    if (!originalId) continue;
    refundTotals.set(originalId, (refundTotals.get(originalId) ?? 0) + Number(refund.amount_total ?? 0));
  }
  const fullyReversed = new Set<number>();
  for (const [id, invoice] of originals) {
    if (Math.abs((refundTotals.get(id) ?? 0) - Number(invoice.amount_total ?? 0)) <= 0.01) {
      fullyReversed.add(id);
    }
  }
  return invoices.filter((invoice) => {
    if (invoice.move_type === 'out_invoice') return !fullyReversed.has(invoice.id);
    const originalId = relationId(invoice.reversed_entry_id);
    return !originalId || !fullyReversed.has(originalId);
  });
};

const originalPickingsForPhase = (
  snapshot: OdooSaleReturnSnapshot,
  phase: 'customer' | 'internal'
): PickingRecord[] => snapshot.pickings.filter((picking) =>
  isOriginalPicking(picking, snapshot.saleOrder.name ?? '') &&
  picking.state === 'done' &&
  (phase === 'customer' ? isCustomerDelivery(picking) : isInternalPick(picking))
);

const originalMovesForPicking = (snapshot: OdooSaleReturnSnapshot, pickingId: number): MoveRecord[] =>
  snapshot.moves.filter((move) =>
    relationId(move.picking_id) === pickingId &&
    !moveOriginalId(move) &&
    move.state === 'done' &&
    quantity(move) > tolerance
  );

const returnMovesForOriginal = (snapshot: OdooSaleReturnSnapshot, originalMoveId: number): MoveRecord[] =>
  snapshot.moves.filter((move) => moveOriginalId(move) === originalMoveId && move.state !== 'cancel');

const doneReturnedQuantity = (snapshot: OdooSaleReturnSnapshot, originalMoveId: number): number =>
  returnMovesForOriginal(snapshot, originalMoveId)
    .filter((move) => move.state === 'done')
    .reduce((total, move) => total + quantity(move), 0);

const phaseComplete = (snapshot: OdooSaleReturnSnapshot, phase: 'customer' | 'internal'): boolean => {
  const pickings = originalPickingsForPhase(snapshot, phase);
  if (pickings.length === 0) return false;
  const moves = pickings.flatMap((picking) => originalMovesForPicking(snapshot, picking.id));
  return moves.length > 0 && moves.every((move) =>
    doneReturnedQuantity(snapshot, move.id) + tolerance >= quantity(move)
  );
};

const hasOverReturn = (snapshot: OdooSaleReturnSnapshot): boolean => {
  const originals = snapshot.moves.filter((move) => !moveOriginalId(move) && move.state === 'done');
  return originals.some((move) => doneReturnedQuantity(snapshot, move.id) > quantity(move) + tolerance);
};

const openReturnPickingIds = (snapshot: OdooSaleReturnSnapshot): number[] => {
  const ids = snapshot.moves
    .filter((move) => moveOriginalId(move) && !['done', 'cancel'].includes(move.state ?? ''))
    .map((move) => relationId(move.picking_id))
    .filter((id): id is number => id !== null);
  return [...new Set(ids)].sort((left, right) => left - right);
};

const snapshotFingerprint = (snapshot: OdooSaleReturnSnapshot): string => {
  const payload = {
    saleOrder: {
      id: snapshot.saleOrder.id,
      name: snapshot.saleOrder.name,
      state: snapshot.saleOrder.state,
      amountTotal: snapshot.saleOrder.amount_total,
      reference: snapshot.saleOrder.client_order_ref,
      origin: snapshot.saleOrder.origin
    },
    lines: snapshot.saleOrderLines.map((line) => ({
      id: line.id,
      ordered: line.product_uom_qty,
      delivered: line.qty_delivered,
      invoiced: line.qty_invoiced
    })),
    pickings: snapshot.pickings.map((picking) => ({
      id: picking.id,
      name: picking.name,
      state: picking.state,
      source: relationId(picking.location_id),
      destination: relationId(picking.location_dest_id),
      origin: picking.origin
    })),
    moves: snapshot.moves.map((move) => ({
      id: move.id,
      state: move.state,
      quantity: quantity(move),
      pickingId: relationId(move.picking_id),
      returnedFrom: moveOriginalId(move)
    })),
    invoices: activeInvoices(snapshot).map((invoice) => ({
      id: invoice.id,
      type: invoice.move_type,
      state: invoice.state,
      paymentState: invoice.payment_state,
      total: invoice.amount_total,
      residual: invoice.amount_residual
    }))
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
};

export const classifyOdooSaleReturnSnapshot = (snapshot: OdooSaleReturnSnapshot): OdooSaleReturnPreview => {
  const saleOrderName = snapshot.saleOrder.name ?? String(snapshot.saleOrder.id);
  const customerPhaseComplete = phaseComplete(snapshot, 'customer');
  const internalPhaseComplete = phaseComplete(snapshot, 'internal');
  const deliveredQuantityZero = snapshot.saleOrderLines.length > 0 &&
    snapshot.saleOrderLines.every((line) => Math.abs(Number(line.qty_delivered ?? 0)) <= tolerance);
  const invoices = blockingInvoices(snapshot);
  const base = {
    fingerprint: snapshotFingerprint(snapshot),
    saleOrderId: snapshot.saleOrder.id,
    saleOrderName,
    saleOrderState: snapshot.saleOrder.state ?? '',
    customerPhaseComplete,
    internalPhaseComplete,
    deliveredQuantityZero,
    activeInvoiceCount: invoices.length,
    openReturnPickingIds: openReturnPickingIds(snapshot)
  };

  // Check this before accepting an otherwise complete-looking cancelled SO.
  // A duplicate/oversized return must never be hidden by the idempotency path.
  if (hasOverReturn(snapshot)) {
    return { ...base, status: 'needs-review', reason: 'Odoo contains an over-returned stock move' };
  }
  if (
    snapshot.saleOrder.state === 'cancel' &&
    customerPhaseComplete &&
    internalPhaseComplete &&
    deliveredQuantityZero &&
    invoices.length === 0
  ) {
    return { ...base, status: 'already-complete' };
  }
  if (invoices.length > 0) {
    const paid = invoices.some((invoice) =>
      ['paid', 'in_payment'].includes(invoice.payment_state ?? '') ||
      Number(invoice.amount_residual ?? 0) < Number(invoice.amount_total ?? 0) - 0.01
    );
    return {
      ...base,
      status: 'needs-review',
      reason: paid
        ? 'Customer invoice has a payment or partial payment'
        : 'Customer invoice/credit note exists and must be reversed safely'
    };
  }
  if (!['sale', 'cancel'].includes(snapshot.saleOrder.state ?? '')) {
    return { ...base, status: 'needs-review', reason: `Unsupported Sales Order state: ${snapshot.saleOrder.state ?? 'missing'}` };
  }
  if (snapshot.saleOrderLines.length === 0) {
    return { ...base, status: 'needs-review', reason: 'Sales Order has no lines' };
  }
  if (snapshot.saleOrderLines.some((line) => Math.abs(Number(line.qty_invoiced ?? 0)) > tolerance)) {
    return { ...base, status: 'needs-review', reason: 'Sales Order lines still contain invoiced quantities' };
  }
  if (originalPickingsForPhase(snapshot, 'customer').length === 0) {
    return { ...base, status: 'needs-review', reason: 'Completed customer delivery picking is missing' };
  }
  if (originalPickingsForPhase(snapshot, 'internal').length === 0) {
    return { ...base, status: 'needs-review', reason: 'Completed internal picking is missing' };
  }
  return { ...base, status: 'ready' };
};

export class OdooSaleReturnService {
  private returnCreationMethod?: 'create_returns' | 'action_create_returns';

  constructor(private readonly odoo: OdooRpcClient) {}

  async preview(saleOrderId: number): Promise<OdooSaleReturnPreview> {
    return classifyOdooSaleReturnSnapshot(await this.readSnapshot(saleOrderId));
  }

  async execute(saleOrderId: number): Promise<OdooSaleReturnResult> {
    const initial = await this.preview(saleOrderId);
    if (initial.status === 'needs-review') {
      throw new OdooSaleReturnReviewError(initial.reason ?? 'Odoo Sales Order return needs review');
    }
    if (initial.status === 'already-complete') {
      return {
        ...initial,
        createdReturnPickingIds: [],
        resumedReturnPickingIds: [],
        cancelledSaleOrder: false
      };
    }

    const createdReturnPickingIds: number[] = [];
    const resumedReturnPickingIds: number[] = [];
    await this.processPhase(saleOrderId, 'customer', createdReturnPickingIds, resumedReturnPickingIds);
    await this.processPhase(saleOrderId, 'internal', createdReturnPickingIds, resumedReturnPickingIds);

    let snapshot = await this.readSnapshot(saleOrderId);
    let preview = classifyOdooSaleReturnSnapshot(snapshot);
    if (!preview.customerPhaseComplete || !preview.internalPhaseComplete || !preview.deliveredQuantityZero) {
      throw new Error(
        `Odoo return verification failed for ${preview.saleOrderName}: ` +
        `customer=${preview.customerPhaseComplete}, internal=${preview.internalPhaseComplete}, deliveredZero=${preview.deliveredQuantityZero}`
      );
    }

    let cancelledSaleOrder = false;
    if (snapshot.saleOrder.state !== 'cancel') {
      // Odoo 16/17 normally opens an interactive cancellation wizard for a
      // confirmed order. This context invokes the same safe cancellation path
      // without sending customer email or waiting for a human modal.
      await this.odoo.call('sale.order', 'action_cancel', [[saleOrderId]], {
        context: { disable_cancel_warning: true }
      });
      cancelledSaleOrder = true;
    }

    snapshot = await this.readSnapshot(saleOrderId);
    preview = classifyOdooSaleReturnSnapshot(snapshot);
    if (preview.status !== 'already-complete') {
      throw new Error(`Odoo Sales Order return did not reach the target state: ${preview.reason ?? preview.status}`);
    }
    return {
      ...preview,
      createdReturnPickingIds,
      resumedReturnPickingIds,
      cancelledSaleOrder
    };
  }

  /**
   * Accounting-safe return for an exact carrier-confirmed return. Customer
   * invoices are reversed with full posted credit notes; real cash/bank
   * payments are deliberately kept so they remain visible as customer credit
   * until an actual cash refund is recorded.
   */
  async reverseAccountingAndExecute(
    saleOrderId: number,
    options: { reason: string; reversalDate?: string }
  ): Promise<OdooSaleReturnResult> {
    let snapshot = await this.readSnapshot(saleOrderId);
    const initial = classifyOdooSaleReturnSnapshot(snapshot);
    if (initial.status === 'already-complete' || initial.status === 'ready') {
      return await this.execute(saleOrderId);
    }

    const invoices = activeInvoices(snapshot);
    const originals = invoices.filter((invoice) => invoice.move_type === 'out_invoice');
    const standaloneRefunds = invoices.filter((invoice) =>
      invoice.move_type === 'out_refund' && !relationId(invoice.reversed_entry_id)
    );
    if (originals.length === 0 || standaloneRefunds.length > 0) {
      throw new OdooSaleReturnReviewError(initial.reason ?? 'Customer accounting cannot be reversed automatically');
    }

    const createdCreditNoteIds: number[] = [];
    for (const invoice of originals) {
      if (invoice.state !== 'posted') {
        throw new OdooSaleReturnReviewError(`Customer invoice ${invoice.name ?? invoice.id} is not posted`);
      }
      const refunds = invoices.filter((candidate) =>
        candidate.move_type === 'out_refund' &&
        relationId(candidate.reversed_entry_id) === invoice.id &&
        candidate.state !== 'cancel'
      );
      const postedRefundTotal = refunds
        .filter((refund) => refund.state === 'posted')
        .reduce((total, refund) => total + Number(refund.amount_total ?? 0), 0);
      const invoiceTotal = Number(invoice.amount_total ?? 0);
      if (postedRefundTotal > invoiceTotal + 0.01) {
        throw new OdooSaleReturnReviewError(`Credit notes exceed invoice ${invoice.name ?? invoice.id}`);
      }
      if (Math.abs(postedRefundTotal - invoiceTotal) <= 0.01) continue;
      if (refunds.length > 0 || postedRefundTotal > 0.01) {
        throw new OdooSaleReturnReviewError(`Invoice ${invoice.name ?? invoice.id} has a partial or draft credit note`);
      }

      const journalId = relationId(invoice.journal_id);
      const companyId = relationId(invoice.company_id);
      const reversalDate = options.reversalDate ?? new Date().toISOString().slice(0, 10);
      if (!journalId || !companyId) {
        throw new OdooSaleReturnReviewError(`Invoice ${invoice.name ?? invoice.id} accounting metadata is incomplete`);
      }
      const wizardId = await this.odoo.create('account.move.reversal', {
        move_ids: [[6, 0, [invoice.id]]],
        date: reversalDate,
        reason: options.reason.slice(0, 200),
        journal_id: journalId,
        company_id: companyId
      });
      await this.odoo.call('account.move.reversal', 'reverse_moves', [[wizardId]], {
        context: { active_model: 'account.move', active_ids: [invoice.id], active_id: invoice.id }
      });
      let creditNotes = await this.odoo.searchRead<InvoiceRecord>(
        'account.move',
        [['move_type', '=', 'out_refund'], ['reversed_entry_id', '=', invoice.id], ['state', '!=', 'cancel']],
        ['name', 'move_type', 'state', 'payment_state', 'amount_total', 'amount_residual', 'invoice_origin', 'reversed_entry_id', 'journal_id', 'company_id', 'date'],
        { limit: 10, order: 'id asc' }
      );
      if (creditNotes.length !== 1) {
        throw new Error(`Expected one credit note for ${invoice.name ?? invoice.id}, found ${creditNotes.length}`);
      }
      if (creditNotes[0]!.state === 'draft') {
        await this.odoo.call('account.move', 'action_post', [[creditNotes[0]!.id]]);
        creditNotes = await this.odoo.searchRead<InvoiceRecord>(
          'account.move', [['id', '=', creditNotes[0]!.id]],
          ['name', 'move_type', 'state', 'payment_state', 'amount_total', 'amount_residual', 'invoice_origin', 'reversed_entry_id', 'journal_id', 'company_id', 'date'],
          { limit: 1 }
        );
      }
      const creditNote = creditNotes[0];
      if (
        !creditNote || creditNote.state !== 'posted' ||
        relationId(creditNote.reversed_entry_id) !== invoice.id ||
        Math.abs(Number(creditNote.amount_total ?? 0) - invoiceTotal) > 0.01
      ) {
        throw new Error(`Credit note verification failed for ${invoice.name ?? invoice.id}`);
      }
      createdCreditNoteIds.push(creditNote.id);
    }

    snapshot = await this.readSnapshot(saleOrderId);
    const afterAccounting = classifyOdooSaleReturnSnapshot(snapshot);
    if (afterAccounting.status !== 'ready') {
      throw new OdooSaleReturnReviewError(
        `Sales Order is not ready after accounting reversal: ${afterAccounting.reason ?? afterAccounting.status}`
      );
    }
    const result = await this.execute(saleOrderId);
    return { ...result, createdCreditNoteIds };
  }

  private async processPhase(
    saleOrderId: number,
    phase: 'customer' | 'internal',
    created: number[],
    resumed: number[]
  ): Promise<void> {
    let snapshot = await this.readSnapshot(saleOrderId);
    if (phaseComplete(snapshot, phase)) return;

    const phaseOriginalMoveIds = new Set(
      originalPickingsForPhase(snapshot, phase)
        .flatMap((picking) => originalMovesForPicking(snapshot, picking.id))
        .map((move) => move.id)
    );
    const openPickingIds = [...new Set(snapshot.moves
      .filter((move) => {
        const originalId = moveOriginalId(move);
        return originalId !== null && phaseOriginalMoveIds.has(originalId) &&
          !['done', 'cancel'].includes(move.state ?? '');
      })
      .map((move) => relationId(move.picking_id))
      .filter((id): id is number => id !== null))];

    this.assertOpenReturnsSafe(snapshot, phase, phaseOriginalMoveIds);

    for (const pickingId of openPickingIds) {
      await this.validatePicking(pickingId);
      resumed.push(pickingId);
    }

    snapshot = await this.readSnapshot(saleOrderId);
    for (const picking of originalPickingsForPhase(snapshot, phase)) {
      const outstanding = originalMovesForPicking(snapshot, picking.id).some((move) =>
        doneReturnedQuantity(snapshot, move.id) + tolerance < quantity(move)
      );
      if (!outstanding) continue;
      const returnPickingId = await this.createReturnPicking(snapshot, picking);
      snapshot = await this.readSnapshot(saleOrderId);
      this.assertOpenReturnsSafe(snapshot, phase, phaseOriginalMoveIds);
      await this.validatePicking(returnPickingId);
      created.push(returnPickingId);
      snapshot = await this.readSnapshot(saleOrderId);
    }

    if (!phaseComplete(snapshot, phase)) {
      throw new Error(`Odoo ${phase} return phase did not complete for Sales Order ${saleOrderId}`);
    }
  }

  private assertOpenReturnsSafe(
    snapshot: OdooSaleReturnSnapshot,
    phase: 'customer' | 'internal',
    phaseOriginalMoveIds: ReadonlySet<number>
  ): void {
    const originals = new Map(
      originalPickingsForPhase(snapshot, phase)
        .flatMap((picking) => originalMovesForPicking(snapshot, picking.id))
        .map((move) => [move.id, move] as const)
    );
    const openTotals = new Map<number, number>();

    for (const move of snapshot.moves) {
      const originalId = moveOriginalId(move);
      if (originalId === null || !phaseOriginalMoveIds.has(originalId) || ['done', 'cancel'].includes(move.state ?? '')) {
        continue;
      }
      const original = originals.get(originalId);
      if (!original) throw new OdooSaleReturnReviewError(`Open return references unknown move ${originalId}`);
      if (move.to_refund !== true) {
        throw new OdooSaleReturnReviewError(`Open return move ${move.id} is not linked to delivered quantity`);
      }
      if (relationId(move.product_id) !== relationId(original.product_id)) {
        throw new OdooSaleReturnReviewError(`Open return move ${move.id} has an unexpected product`);
      }
      const planned = plannedQuantity(move);
      if (planned <= tolerance) {
        throw new OdooSaleReturnReviewError(`Open return move ${move.id} has no positive quantity`);
      }
      openTotals.set(originalId, (openTotals.get(originalId) ?? 0) + planned);
    }

    for (const [originalId, openTotal] of openTotals) {
      const original = originals.get(originalId)!;
      const total = doneReturnedQuantity(snapshot, originalId) + openTotal;
      if (total > quantity(original) + tolerance) {
        throw new OdooSaleReturnReviewError(
          `Open Odoo returns would exceed original move ${originalId}: planned=${total}, original=${quantity(original)}`
        );
      }
    }
  }

  private async createReturnPicking(snapshot: OdooSaleReturnSnapshot, picking: PickingRecord): Promise<number> {
    const originalMoves = originalMovesForPicking(snapshot, picking.id);
    const remainingByMove = new Map(originalMoves.map((move) => [
      move.id,
      Math.max(0, quantity(move) - doneReturnedQuantity(snapshot, move.id))
    ]));
    const context = {
      active_model: 'stock.picking',
      active_ids: [picking.id],
      active_id: picking.id
    };
    const onchange = await this.odoo.call<{ value?: Record<string, unknown> }>(
      'stock.return.picking',
      'onchange',
      [
        [],
        { picking_id: picking.id, product_return_moves: [] },
        ['picking_id'],
        {
          picking_id: {},
          location_id: {},
          company_id: {},
          move_dest_exists: {},
          original_location_id: {},
          parent_location_id: {},
          product_return_moves: {
            fields: {
              product_id: {},
              quantity: {},
              uom_id: {},
              move_id: {},
              to_refund: {}
            }
          }
        }
      ],
      { context }
    );
    const values = onchange.value ?? {};
    const commands = Array.isArray(values.product_return_moves) ? values.product_return_moves : [];
    const selected: Array<[number, number, Record<string, unknown>]> = [];
    const seenMoves = new Set<number>();

    for (const command of commands) {
      if (!Array.isArray(command) || typeof command[2] !== 'object' || !command[2]) continue;
      const line = command[2] as Record<string, unknown>;
      const moveId = relationId(line.move_id as Relation);
      if (!moveId || !remainingByMove.has(moveId)) continue;
      const remaining = remainingByMove.get(moveId) ?? 0;
      if (remaining <= tolerance) continue;
      const suggested = Number(line.quantity ?? 0);
      if (Math.abs(suggested - remaining) > tolerance) {
        throw new OdooSaleReturnReviewError(
          `Odoo return quantity mismatch for move ${moveId}: suggested=${suggested}, expected=${remaining}`
        );
      }
      selected.push([0, 0, { ...line, quantity: remaining, to_refund: true }]);
      seenMoves.add(moveId);
    }

    const missing = [...remainingByMove.entries()]
      .filter(([, remaining]) => remaining > tolerance)
      .map(([moveId]) => moveId)
      .filter((moveId) => !seenMoves.has(moveId));
    if (missing.length > 0) {
      throw new OdooSaleReturnReviewError(`Odoo return wizard omitted outstanding moves: ${missing.join(', ')}`);
    }
    if (selected.length === 0) {
      throw new Error(`Odoo return wizard has no quantities for picking ${picking.name ?? picking.id}`);
    }

    const wizardId = await this.odoo.create('stock.return.picking', {
      picking_id: picking.id,
      ...(typeof values.location_id === 'number' ? { location_id: values.location_id } : {}),
      product_return_moves: selected
    }, context);
    const action = await this.createReturnFromWizard(wizardId, context);
    const returnPickingId = this.extractPickingId(action);
    if (!returnPickingId) {
      throw new Error(`Odoo created a return for ${picking.name ?? picking.id} but did not return its picking ID`);
    }

    const [created] = await this.odoo.searchRead<PickingRecord>(
      'stock.picking',
      [['id', '=', returnPickingId]],
      ['name', 'state', 'location_id', 'location_dest_id', 'origin', 'move_ids'],
      { limit: 1 }
    );
    if (!created) throw new Error(`Odoo return picking ${returnPickingId} cannot be read back`);
    if (
      relationId(created.location_id) !== relationId(picking.location_dest_id) ||
      relationId(created.location_dest_id) !== relationId(picking.location_id)
    ) {
      throw new OdooSaleReturnReviewError(`Odoo return picking ${created.name ?? returnPickingId} has unexpected locations`);
    }
    return returnPickingId;
  }

  private async createReturnFromWizard(
    wizardId: number,
    context: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const methods: Array<'create_returns' | 'action_create_returns'> = this.returnCreationMethod
      ? [this.returnCreationMethod]
      : ['create_returns', 'action_create_returns'];
    let missingMethodError: unknown;
    for (const method of methods) {
      try {
        const action = await this.odoo.call<Record<string, unknown>>(
          'stock.return.picking',
          method,
          [[wizardId]],
          { context }
        );
        this.returnCreationMethod = method;
        return action;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Odoo 15-17 calls this button create_returns; Odoo 18+ renamed it to
        // action_create_returns. A missing method cannot have changed stock, so
        // this is the only error for which trying the alternate name is safe.
        if (!/method ['"]?(?:create_returns|action_create_returns)['"]? does not exist/i.test(message)) {
          throw error;
        }
        missingMethodError = error;
      }
    }
    throw missingMethodError ?? new Error('Odoo return creation method is unavailable');
  }

  private extractPickingId(action: Record<string, unknown>): number | null {
    if (typeof action.res_id === 'number') return action.res_id;
    if (!Array.isArray(action.domain)) return null;
    for (const clause of action.domain) {
      if (!Array.isArray(clause) || clause[0] !== 'id') continue;
      if (clause[1] === '=' && typeof clause[2] === 'number') return clause[2];
      if (clause[1] === 'in' && Array.isArray(clause[2]) && typeof clause[2][0] === 'number') return clause[2][0];
    }
    return null;
  }

  private async validatePicking(pickingId: number): Promise<void> {
    let [picking] = await this.odoo.searchRead<PickingRecord>(
      'stock.picking',
      [['id', '=', pickingId]],
      ['name', 'state', 'location_id', 'location_dest_id', 'origin', 'move_ids'],
      { limit: 1 }
    );
    if (!picking) throw new Error(`Odoo picking ${pickingId} not found`);
    if (picking.state === 'done') return;
    if (picking.state === 'cancel') throw new OdooSaleReturnReviewError(`Odoo return picking ${picking.name ?? pickingId} is cancelled`);

    await this.odoo.call('stock.picking', 'action_assign', [[pickingId]]);
    const moves = await this.odoo.searchRead<MoveRecord>(
      'stock.move',
      [['id', 'in', picking.move_ids ?? []]],
      [
        'name', 'state', 'product_id', 'product_uom', 'product_uom_qty', 'quantity',
        'picked', 'move_line_ids', 'picking_id', 'origin_returned_move_id',
        'returned_move_ids', 'location_id', 'location_dest_id'
      ],
      { limit: 200, order: 'id asc' }
    );
    for (const move of moves) {
      const moveQuantity = Number(move.product_uom_qty ?? move.quantity ?? 0);
      if (moveQuantity <= tolerance) continue;
      if (!move.move_line_ids?.length) {
        const productId = relationId(move.product_id);
        const productUomId = relationId(move.product_uom);
        const locationId = relationId(move.location_id);
        const locationDestId = relationId(move.location_dest_id);
        if (!productId || !productUomId || !locationId || !locationDestId) {
          throw new Error(`Cannot create move line for Odoo return move ${move.id}`);
        }
        await this.odoo.create('stock.move.line', {
          picking_id: pickingId,
          move_id: move.id,
          product_id: productId,
          product_uom_id: productUomId,
          quantity: moveQuantity,
          location_id: locationId,
          location_dest_id: locationDestId
        });
      }
      await this.odoo.call('stock.move', 'write', [[move.id], { quantity: moveQuantity, picked: true }]);
    }

    const result = await this.odoo.call<unknown>('stock.picking', 'button_validate', [[pickingId]]);
    await this.processWizardResult(result);
    [picking] = await this.odoo.searchRead<PickingRecord>(
      'stock.picking',
      [['id', '=', pickingId]],
      ['name', 'state', 'location_id', 'location_dest_id', 'origin', 'move_ids'],
      { limit: 1 }
    );
    if (!picking || picking.state !== 'done') {
      throw new Error(`Odoo return picking ${picking?.name ?? pickingId} did not reach done state`);
    }
  }

  private async processWizardResult(result: unknown): Promise<void> {
    if (!result || typeof result !== 'object') return;
    const action = result as { res_model?: string; res_id?: number; context?: Record<string, unknown> };
    if (action.res_model === 'stock.immediate.transfer' && action.res_id) {
      await this.odoo.call('stock.immediate.transfer', 'process', [[action.res_id]], { context: action.context ?? {} });
    } else if (action.res_model === 'stock.backorder.confirmation' && action.res_id) {
      await this.odoo.call('stock.backorder.confirmation', 'process', [[action.res_id]], { context: action.context ?? {} });
    }
  }

  private async readSnapshot(saleOrderId: number): Promise<OdooSaleReturnSnapshot> {
    const [saleOrder] = await this.odoo.searchRead<SaleOrderRecord>(
      'sale.order',
      [['id', '=', saleOrderId]],
      ['name', 'state', 'amount_total', 'invoice_ids', 'picking_ids', 'order_line', 'client_order_ref', 'origin'],
      { limit: 1 }
    );
    if (!saleOrder) throw new OdooSaleReturnReviewError(`Odoo Sales Order not found: ${saleOrderId}`);

    const [saleOrderLines, initialPickings] = await Promise.all([
      saleOrder.order_line?.length
        ? this.odoo.searchRead<SaleOrderLineRecord>(
          'sale.order.line',
          [['id', 'in', saleOrder.order_line]],
          ['product_id', 'product_uom_qty', 'qty_delivered', 'qty_invoiced'],
          { limit: 500, order: 'id asc' }
        )
        : Promise.resolve([]),
      saleOrder.picking_ids?.length
        ? this.odoo.searchRead<PickingRecord>(
          'stock.picking',
          [['id', 'in', saleOrder.picking_ids]],
          ['name', 'state', 'location_id', 'location_dest_id', 'origin', 'move_ids'],
          { limit: 500, order: 'id asc' }
        )
        : Promise.resolve([])
    ]);

    const initialMoveIds = initialPickings.flatMap((picking) => picking.move_ids ?? []);
    const initialMoves = initialMoveIds.length
      ? await this.odoo.searchRead<MoveRecord>(
        'stock.move',
        [['id', 'in', initialMoveIds]],
        [
          'name', 'state', 'product_id', 'product_uom', 'product_uom_qty', 'quantity',
          'picked', 'to_refund', 'move_line_ids', 'picking_id', 'origin_returned_move_id',
          'returned_move_ids', 'location_id', 'location_dest_id'
        ],
        { limit: 1000, order: 'id asc' }
      )
      : [];
    const originalMoveIds = initialMoves.filter((move) => !moveOriginalId(move)).map((move) => move.id);
    const returnMoves = originalMoveIds.length
      ? await this.odoo.searchRead<MoveRecord>(
        'stock.move',
        [['origin_returned_move_id', 'in', originalMoveIds]],
        [
          'name', 'state', 'product_id', 'product_uom', 'product_uom_qty', 'quantity',
          'picked', 'to_refund', 'move_line_ids', 'picking_id', 'origin_returned_move_id',
          'returned_move_ids', 'location_id', 'location_dest_id'
        ],
        { limit: 1000, order: 'id asc' }
      )
      : [];
    const additionalPickingIds = returnMoves
      .map((move) => relationId(move.picking_id))
      .filter((id): id is number => id !== null && !initialPickings.some((picking) => picking.id === id));
    const additionalPickings = additionalPickingIds.length
      ? await this.odoo.searchRead<PickingRecord>(
        'stock.picking',
        [['id', 'in', additionalPickingIds]],
        ['name', 'state', 'location_id', 'location_dest_id', 'origin', 'move_ids'],
        { limit: 500, order: 'id asc' }
      )
      : [];

    const invoiceDomain: unknown[] = saleOrder.invoice_ids?.length
      ? ['|', ['id', 'in', saleOrder.invoice_ids], ['invoice_origin', '=', saleOrder.name]]
      : [['invoice_origin', '=', saleOrder.name]];
    const invoices = await this.odoo.searchRead<InvoiceRecord>(
      'account.move',
      invoiceDomain,
      [
        'name', 'move_type', 'state', 'payment_state', 'amount_total', 'amount_residual',
        'invoice_origin', 'reversed_entry_id', 'journal_id', 'company_id', 'date'
      ],
      { limit: 500, order: 'id asc' }
    );

    return {
      saleOrder,
      saleOrderLines: uniqueById(saleOrderLines),
      pickings: uniqueById([...initialPickings, ...additionalPickings]),
      moves: uniqueById([...initialMoves, ...returnMoves]),
      invoices: uniqueById(invoices)
    };
  }
}
