import assert from 'node:assert/strict';

import {
  classifyOdooSaleReturnSnapshot,
  OdooSaleReturnService,
  type OdooSaleReturnSnapshot
} from '../odoo/odooSaleReturnService.js';
import {
  classifyOrderForCollectionReturn,
  type ShopifyCollectionReturnCatalog
} from '../services/shopifyCollectionReturnPolicy.js';
import type { ShopifyOrder } from '../types/shopify.js';

const catalog: ShopifyCollectionReturnCatalog = {
  collectionId: 'gid://shopify/Collection/1',
  handle: 'new-arrivals',
  title: 'New arrivals',
  productIds: new Set([101, 102]),
  variantIds: new Set([1001, 1002]),
  skus: new Set(['NEW-A', 'NEW-B']),
  fetchedAt: new Date('2026-09-03T00:00:00.000Z')
};

const order = (lineItems: ShopifyOrder['line_items']): ShopifyOrder => ({
  id: 1,
  name: '#1',
  order_number: 1,
  total_price: '100',
  line_items: lineItems
});
const line = (id: number, productId: number | null, sku: string): ShopifyOrder['line_items'][number] => ({
  id,
  title: sku,
  sku,
  quantity: 1,
  current_quantity: 1,
  price: '100',
  product_id: productId,
  variant_id: productId ? productId * 10 : null
});

assert.equal(
  classifyOrderForCollectionReturn(order([line(1, 101, 'NEW-A')]), catalog).classification,
  'exclusive'
);
assert.equal(
  classifyOrderForCollectionReturn(order([line(1, 101, 'NEW-A'), line(2, 999, 'OLD')]), catalog).classification,
  'mixed'
);
assert.equal(
  classifyOrderForCollectionReturn(order([line(1, 999, 'NEW-A')]), catalog).classification,
  'none',
  'Product ID must win over a coincidentally reused SKU'
);
assert.equal(
  classifyOrderForCollectionReturn(order([line(1, null, 'NEW-A')]), catalog).classification,
  'exclusive',
  'SKU fallback is allowed only when Shopify IDs are unavailable'
);
const cancelledShopifyLine = line(1, 101, 'NEW-A');
cancelledShopifyLine.current_quantity = 0;
assert.equal(
  classifyOrderForCollectionReturn(order([cancelledShopifyLine]), catalog).classification,
  'exclusive',
  'A Shopify cancellation must not erase the originally shipped product identity'
);

const baseSnapshot = (): OdooSaleReturnSnapshot => ({
  saleOrder: {
    id: 10,
    name: 'S10',
    state: 'sale',
    amount_total: 100,
    invoice_ids: [],
    picking_ids: [20, 21],
    order_line: [30]
  },
  saleOrderLines: [{
    id: 30,
    product_id: [40, 'Product'],
    product_uom_qty: 1,
    qty_delivered: 1,
    qty_invoiced: 0
  }],
  pickings: [
    {
      id: 20,
      name: 'WH/PICK/1',
      state: 'done',
      location_id: [8, 'WH/Stock'],
      location_dest_id: [11, 'WH/Output'],
      origin: 'S10',
      move_ids: [50]
    },
    {
      id: 21,
      name: 'WH/OUT/1',
      state: 'done',
      location_id: [11, 'WH/Output'],
      location_dest_id: [5, 'Partners/Customers'],
      origin: 'S10',
      move_ids: [51]
    }
  ],
  moves: [
    {
      id: 50,
      state: 'done',
      product_id: [40, 'Product'],
      product_uom_qty: 1,
      quantity: 1,
      picking_id: [20, 'WH/PICK/1'],
      returned_move_ids: [],
      location_id: [8, 'WH/Stock'],
      location_dest_id: [11, 'WH/Output']
    },
    {
      id: 51,
      state: 'done',
      product_id: [40, 'Product'],
      product_uom_qty: 1,
      quantity: 1,
      picking_id: [21, 'WH/OUT/1'],
      returned_move_ids: [],
      location_id: [11, 'WH/Output'],
      location_dest_id: [5, 'Partners/Customers']
    }
  ],
  invoices: []
});

const ready = classifyOdooSaleReturnSnapshot(baseSnapshot());
assert.equal(ready.status, 'ready');
assert.equal(ready.customerPhaseComplete, false);
assert.equal(ready.internalPhaseComplete, false);

const interrupted = baseSnapshot();
interrupted.pickings.push({
  id: 22,
  name: 'WH/IN/1',
  state: 'assigned',
  location_id: [5, 'Partners/Customers'],
  location_dest_id: [11, 'WH/Output'],
  origin: 'Return of WH/OUT/1',
  move_ids: [52]
});
interrupted.moves.push({
  id: 52,
  state: 'assigned',
  product_id: [40, 'Product'],
  product_uom_qty: 1,
  quantity: 0,
  picking_id: [22, 'WH/IN/1'],
  origin_returned_move_id: [51, 'Product'],
  location_id: [5, 'Partners/Customers'],
  location_dest_id: [11, 'WH/Output']
});
const interruptedPreview = classifyOdooSaleReturnSnapshot(interrupted);
assert.equal(interruptedPreview.status, 'ready');
assert.deepEqual(interruptedPreview.openReturnPickingIds, [22]);

const complete = baseSnapshot();
complete.saleOrder.state = 'cancel';
complete.saleOrderLines[0].qty_delivered = 0;
complete.pickings.push(
  {
    id: 22,
    name: 'WH/IN/1',
    state: 'done',
    location_id: [5, 'Partners/Customers'],
    location_dest_id: [11, 'WH/Output'],
    origin: 'Return of WH/OUT/1',
    move_ids: [52]
  },
  {
    id: 23,
    name: 'WH/PICK/2',
    state: 'done',
    location_id: [11, 'WH/Output'],
    location_dest_id: [8, 'WH/Stock'],
    origin: 'Return of WH/PICK/1',
    move_ids: [53]
  }
);
complete.moves.push(
  {
    id: 52,
    state: 'done',
    product_id: [40, 'Product'],
    product_uom_qty: 1,
    quantity: 1,
    picking_id: [22, 'WH/IN/1'],
    origin_returned_move_id: [51, 'Product'],
    location_id: [5, 'Partners/Customers'],
    location_dest_id: [11, 'WH/Output']
  },
  {
    id: 53,
    state: 'done',
    product_id: [40, 'Product'],
    product_uom_qty: 1,
    quantity: 1,
    picking_id: [23, 'WH/PICK/2'],
    origin_returned_move_id: [50, 'Product'],
    location_id: [11, 'WH/Output'],
    location_dest_id: [8, 'WH/Stock']
  }
);
complete.moves[0].returned_move_ids = [53];
complete.moves[1].returned_move_ids = [52];
const completePreview = classifyOdooSaleReturnSnapshot(complete);
assert.equal(completePreview.status, 'already-complete');
assert.equal(completePreview.customerPhaseComplete, true);
assert.equal(completePreview.internalPhaseComplete, true);
assert.equal(completePreview.deliveredQuantityZero, true);

const paid = baseSnapshot();
paid.invoices.push({
  id: 60,
  name: 'INV/1',
  move_type: 'out_invoice',
  state: 'posted',
  payment_state: 'paid',
  amount_total: 100,
  amount_residual: 0
});
const paidPreview = classifyOdooSaleReturnSnapshot(paid);
assert.equal(paidPreview.status, 'needs-review');
assert.match(paidPreview.reason ?? '', /payment/i);

const overReturned = structuredClone(complete);
overReturned.moves.find((move) => move.id === 52)!.quantity = 2;
overReturned.saleOrder.state = 'sale';
const overReturnedPreview = classifyOdooSaleReturnSnapshot(overReturned);
assert.equal(overReturnedPreview.status, 'needs-review');
assert.match(overReturnedPreview.reason ?? '', /over-returned/i);

class FakeOdooReturnRpc {
  private saleState = 'sale';
  private delivered = 1;
  private nextPickingId = 100;
  private nextMoveId = 200;
  private nextWizardId = 300;
  private readonly wizards = new Map<number, Record<string, unknown>>();
  private failNextValidation: boolean;
  private readonly actionOnly: boolean;
  readonly pickings = new Map<number, Record<string, unknown>>([
    [20, {
      id: 20,
      name: 'WH/PICK/1',
      state: 'done',
      location_id: [8, 'WH/Stock'],
      location_dest_id: [11, 'WH/Output'],
      origin: 'S10',
      move_ids: [50]
    }],
    [21, {
      id: 21,
      name: 'WH/OUT/1',
      state: 'done',
      location_id: [11, 'WH/Output'],
      location_dest_id: [5, 'Partners/Customers'],
      origin: 'S10',
      move_ids: [51]
    }]
  ]);
  readonly moves = new Map<number, Record<string, unknown>>([
    [50, {
      id: 50,
      state: 'done',
      product_id: [40, 'Product'],
      product_uom: [1, 'Units'],
      product_uom_qty: 1,
      quantity: 1,
      picked: true,
      to_refund: false,
      move_line_ids: [500],
      picking_id: [20, 'WH/PICK/1'],
      origin_returned_move_id: false,
      returned_move_ids: [],
      location_id: [8, 'WH/Stock'],
      location_dest_id: [11, 'WH/Output']
    }],
    [51, {
      id: 51,
      state: 'done',
      product_id: [40, 'Product'],
      product_uom: [1, 'Units'],
      product_uom_qty: 1,
      quantity: 1,
      picked: true,
      to_refund: false,
      move_line_ids: [501],
      picking_id: [21, 'WH/OUT/1'],
      origin_returned_move_id: false,
      returned_move_ids: [],
      location_id: [11, 'WH/Output'],
      location_dest_id: [5, 'Partners/Customers']
    }]
  ]);
  cancelCalls = 0;

  constructor(options: { failFirstValidation?: boolean; actionOnly?: boolean } = {}) {
    this.failNextValidation = options.failFirstValidation ?? false;
    this.actionOnly = options.actionOnly ?? false;
  }

  private relationId(value: unknown): number | null {
    return Array.isArray(value) && typeof value[0] === 'number'
      ? value[0]
      : typeof value === 'number' ? value : null;
  }

  private clause(domain: unknown[], field: string): unknown[] | undefined {
    return domain.find((entry) => Array.isArray(entry) && entry[0] === field) as unknown[] | undefined;
  }

  async searchRead<T extends { id: number }>(
    model: string,
    domain: unknown[],
    _fields: string[],
    _options: { limit?: number; order?: string; context?: Record<string, unknown> } = {}
  ): Promise<T[]> {
    if (model === 'sale.order') {
      return [{
        id: 10,
        name: 'S10',
        state: this.saleState,
        amount_total: 100,
        invoice_ids: [],
        picking_ids: [20, 21],
        order_line: [30]
      } as unknown as T];
    }
    if (model === 'sale.order.line') {
      return [{
        id: 30,
        product_id: [40, 'Product'],
        product_uom_qty: 1,
        qty_delivered: this.delivered,
        qty_invoiced: 0
      } as unknown as T];
    }
    if (model === 'account.move') return [];

    let rows: Record<string, unknown>[];
    if (model === 'stock.picking') rows = [...this.pickings.values()];
    else if (model === 'stock.move') rows = [...this.moves.values()];
    else throw new Error(`Unexpected fake search_read model: ${model}`);

    const idClause = this.clause(domain, 'id');
    if (idClause) {
      const wanted = idClause[1] === 'in' ? idClause[2] as number[] : [idClause[2] as number];
      rows = rows.filter((row) => wanted.includes(row.id as number));
    }
    const returnedClause = this.clause(domain, 'origin_returned_move_id');
    if (returnedClause) {
      const wanted = returnedClause[2] as number[];
      rows = rows.filter((row) => wanted.includes(this.relationId(row.origin_returned_move_id) ?? -1));
    }
    return rows.map((row) => ({ ...row } as T));
  }

  async create(model: string, values: Record<string, unknown>): Promise<number> {
    if (model === 'stock.return.picking') {
      const id = this.nextWizardId++;
      this.wizards.set(id, values);
      return id;
    }
    if (model === 'stock.move.line') return this.nextMoveId++;
    throw new Error(`Unexpected fake create model: ${model}`);
  }

  async call<T = unknown>(
    model: string,
    method: string,
    args: unknown[],
    kwargs: Record<string, unknown> = {}
  ): Promise<T> {
    if (model === 'stock.return.picking' && method === 'onchange') {
      const values = args[1] as { picking_id: number };
      const picking = this.pickings.get(values.picking_id)!;
      const originalMoveId = (picking.move_ids as number[])[0];
      const originalMove = this.moves.get(originalMoveId)!;
      return {
        value: {
          location_id: this.relationId(picking.location_id),
          product_return_moves: [[0, 0, {
            product_id: originalMove.product_id,
            quantity: 1,
            uom_id: originalMove.product_uom,
            move_id: originalMoveId,
            to_refund: true
          }]]
        }
      } as T;
    }
    if (model === 'stock.return.picking' && ['create_returns', 'action_create_returns'].includes(method)) {
      if (method === 'create_returns' && this.actionOnly) {
        throw new Error("The method 'create_returns' does not exist on the model 'stock.return.picking'");
      }
      const wizardId = (args[0] as number[])[0];
      const wizard = this.wizards.get(wizardId)!;
      const originalPicking = this.pickings.get(wizard.picking_id as number)!;
      const command = (wizard.product_return_moves as Array<[number, number, Record<string, unknown>]>)[0][2];
      const originalMoveId = this.relationId(command.move_id)!;
      const originalMove = this.moves.get(originalMoveId)!;
      const pickingId = this.nextPickingId++;
      const moveId = this.nextMoveId++;
      const name = `RETURN/${pickingId}`;
      this.pickings.set(pickingId, {
        id: pickingId,
        name,
        state: 'confirmed',
        location_id: originalPicking.location_dest_id,
        location_dest_id: originalPicking.location_id,
        origin: `Return of ${originalPicking.name as string}`,
        move_ids: [moveId]
      });
      this.moves.set(moveId, {
        id: moveId,
        state: 'confirmed',
        product_id: originalMove.product_id,
        product_uom: originalMove.product_uom,
        product_uom_qty: command.quantity,
        quantity: 0,
        picked: false,
        to_refund: command.to_refund,
        move_line_ids: [],
        picking_id: [pickingId, name],
        origin_returned_move_id: [originalMoveId, 'Product'],
        returned_move_ids: [],
        location_id: originalPicking.location_dest_id,
        location_dest_id: originalPicking.location_id
      });
      (originalMove.returned_move_ids as number[]).push(moveId);
      return { res_id: pickingId } as T;
    }
    if (model === 'stock.picking' && method === 'action_assign') return true as T;
    if (model === 'stock.move' && method === 'write') {
      const moveId = (args[0] as number[])[0];
      Object.assign(this.moves.get(moveId)!, args[1]);
      return true as T;
    }
    if (model === 'stock.picking' && method === 'button_validate') {
      if (this.failNextValidation) {
        this.failNextValidation = false;
        throw new Error('Simulated connection reset after return creation');
      }
      const pickingId = (args[0] as number[])[0];
      const picking = this.pickings.get(pickingId)!;
      picking.state = 'done';
      for (const moveId of picking.move_ids as number[]) this.moves.get(moveId)!.state = 'done';
      if ((picking.location_id as [number, string])[1].includes('Customers')) this.delivered = 0;
      return true as T;
    }
    if (model === 'sale.order' && method === 'action_cancel') {
      const context = (kwargs.context ?? {}) as Record<string, unknown>;
      if (context.disable_cancel_warning !== true) {
        return { res_model: 'sale.order.cancel', type: 'ir.actions.act_window' } as T;
      }
      this.saleState = 'cancel';
      this.cancelCalls++;
      return true as T;
    }
    throw new Error(`Unexpected fake call: ${model}.${method}`);
  }
}

const fake = new FakeOdooReturnRpc();
const fakeService = new OdooSaleReturnService(fake);
const firstExecution = await fakeService.execute(10);
assert.equal(firstExecution.status, 'already-complete');
assert.equal(firstExecution.createdReturnPickingIds.length, 2);
assert.equal(firstExecution.cancelledSaleOrder, true);
assert.equal(fake.cancelCalls, 1);
const fakePickingCount = fake.pickings.size;
const secondExecution = await fakeService.execute(10);
assert.equal(secondExecution.status, 'already-complete');
assert.deepEqual(secondExecution.createdReturnPickingIds, []);
assert.equal(secondExecution.cancelledSaleOrder, false);
assert.equal(fake.pickings.size, fakePickingCount, 'Idempotent retry created duplicate pickings');
assert.equal(fake.cancelCalls, 1, 'Idempotent retry cancelled the Sales Order twice');

const interruptedFake = new FakeOdooReturnRpc({ failFirstValidation: true });
const interruptedService = new OdooSaleReturnService(interruptedFake);
await assert.rejects(interruptedService.execute(10), /Simulated connection reset/);
assert.equal(interruptedFake.pickings.size, 3, 'Interrupted run should leave exactly one resumable return');
const resumedExecution = await interruptedService.execute(10);
assert.equal(resumedExecution.status, 'already-complete');
assert.equal(resumedExecution.resumedReturnPickingIds.length, 1);
assert.equal(resumedExecution.createdReturnPickingIds.length, 1);
assert.equal(interruptedFake.pickings.size, 4, 'Resume should not duplicate the first return');

const newerOdooFake = new FakeOdooReturnRpc({ actionOnly: true });
const newerOdooResult = await new OdooSaleReturnService(newerOdooFake).execute(10);
assert.equal(newerOdooResult.status, 'already-complete', 'Odoo action_create_returns fallback failed');

console.log('Odoo Sales Order return automation self-test passed.');
