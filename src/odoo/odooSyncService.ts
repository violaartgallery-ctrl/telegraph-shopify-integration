import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { shipmentRepository } from '../services/shipmentRepository.js';
import type { ShopifyLineItem, ShopifyOrder } from '../types/shopify.js';
import { OdooClient, type OdooRecord } from './odooClient.js';

interface PartnerRecord extends OdooRecord {
  name?: string;
  mobile?: string | false;
  phone?: string | false;
  email?: string | false;
}

interface ProductRecord extends OdooRecord {
  display_name?: string;
  default_code?: string | false;
}

interface InvoiceRecord extends OdooRecord {
  name?: string;
  state?: string;
  move_type?: string;
  invoice_origin?: string | false;
  amount_residual?: number;
  amount_total?: number;
  payment_state?: string;
}

interface PaymentRecord extends OdooRecord {
  name?: string;
}

interface ManufacturingOrderRecord extends OdooRecord {
  name?: string;
  state?: string;
  product_qty?: number;
  qty_producing?: number;
}

interface StockPickingRecord extends OdooRecord {
  name?: string;
  state?: string;
  location_id?: [number, string] | false;
  location_dest_id?: [number, string] | false;
  move_ids?: number[];
}

interface StockMoveRecord extends OdooRecord {
  product_id?: [number, string] | number;
  product_uom?: [number, string] | number;
  product_uom_qty?: number;
  quantity?: number;
  picked?: boolean;
  move_line_ids?: number[];
  location_id?: [number, string] | number;
  location_dest_id?: [number, string] | number;
}

export const calculateTelegraphReturnCharge = (shipment: {
  customerDue?: number | null;
  returningDueFees?: number | null;
  returnFees?: number | null;
  returnedValue?: number | null;
}): number => {
  if (shipment.customerDue !== undefined && shipment.customerDue !== null) {
    const customerDue = Number(shipment.customerDue);
    if (customerDue > 0) {
      return 0;
    }
    if (customerDue < 0) {
      return Math.abs(customerDue);
    }
  }

  const returningDueFees = Number(shipment.returningDueFees ?? 0);
  if (returningDueFees > 0) {
    return returningDueFees;
  }

  if (shipment.customerDue !== undefined && shipment.customerDue !== null) {
    return 0;
  }

  const returnFees = Number(shipment.returnFees ?? 0);
  if (returnFees > 0) {
    return returnFees;
  }

  const returnedValue = Number(shipment.returnedValue ?? 0);
  return returnedValue < 0 ? Math.abs(returnedValue) : 0;
};

export const calculateTelegraphMerchantPaymentAmount = (params: {
  residual: number;
  collectedAmount?: number | null;
  deliveryFees?: number | null;
  customerDue?: number | null;
}): number => {
  const residual = Number(params.residual);
  if (!Number.isFinite(residual) || residual <= 0) {
    return 0;
  }

  const customerDue = Number(params.customerDue);
  if (Number.isFinite(customerDue) && customerDue > 0) {
    return Math.min(residual, customerDue);
  }

  if (params.collectedAmount === undefined || params.collectedAmount === null || params.deliveryFees === undefined || params.deliveryFees === null) {
    return 0;
  }

  const collectedAmount = Number(params.collectedAmount);
  const deliveryFees = Number(params.deliveryFees);
  if (!Number.isFinite(collectedAmount) || collectedAmount <= 0 || !Number.isFinite(deliveryFees) || deliveryFees < 0) {
    return 0;
  }

  const netMerchantDue = collectedAmount - deliveryFees;
  return netMerchantDue > 0 ? Math.min(residual, netMerchantDue) : 0;
};

const activeLineItems = (order: ShopifyOrder): ShopifyLineItem[] =>
  order.line_items.filter((line) => (line.current_quantity ?? line.quantity) > 0);

const itemQuantity = (line: ShopifyLineItem): number => line.current_quantity ?? line.quantity;

const lineDiscountPercent = (line: ShopifyLineItem): number => {
  const quantity = itemQuantity(line);
  const unitPrice = Number.parseFloat(line.price);
  const allocatedDiscount = (line.discount_allocations ?? [])
    .reduce((total, allocation) => total + Number.parseFloat(allocation.amount || '0'), 0);
  const gross = unitPrice * quantity;
  if (!quantity || !Number.isFinite(gross) || gross <= 0 || allocatedDiscount <= 0) {
    return 0;
  }
  return Math.min(100, Number(((allocatedDiscount / gross) * 100).toFixed(4)));
};

const digitsOnly = (value?: string | null): string => (value ?? '').replace(/\D/g, '');

const compactPhoneSearch = (value?: string | null): string | undefined => {
  const digits = digitsOnly(value);
  if (!digits) return undefined;
  return digits.length > 10 ? digits.slice(-10) : digits;
};

const orderReference = (order: ShopifyOrder): string =>
  `${order.name} / ${env.orderReferencePrefix}-${order.order_number}`;

const customerName = (order: ShopifyOrder): string => {
  const addressName = order.shipping_address?.name ?? order.billing_address?.name;
  if (addressName) return addressName;
  const customerParts = [order.customer?.first_name, order.customer?.last_name].filter(Boolean);
  if (customerParts.length > 0) return customerParts.join(' ');
  return order.email ?? order.name;
};

const customerPhone = (order: ShopifyOrder): string =>
  (
    order.shipping_address?.phone ??
    order.phone ??
    order.customer?.phone ??
    order.billing_address?.phone ??
    ''
  ).trim();

const customerEmail = (order: ShopifyOrder): string | undefined =>
  order.email ?? order.customer?.email ?? undefined;

const customerAddress = (order: ShopifyOrder) => order.shipping_address ?? order.billing_address;

const salesOrderNote = (order: ShopifyOrder, shipment?: { accurateShipmentCode?: string | null; trackingUrl?: string | null }): string =>
  [
    `Shopify order: ${order.name}`,
    `Shopify order id: ${order.id}`,
    `Reference: ${orderReference(order)}`,
    shipment?.accurateShipmentCode ? `Telegraph shipment: ${shipment.accurateShipmentCode}` : undefined,
    shipment?.trackingUrl ? `Tracking URL: ${shipment.trackingUrl}` : undefined
  ]
    .filter(Boolean)
    .join('\n');

const sleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, ms));

export class OdooSyncService {
  constructor(private readonly odooClient: OdooClient) {}

  private assertEnabled(): void {
    if (!env.odoo.enabled) {
      throw new Error('Odoo sync is disabled. Set ODOO_SYNC_ENABLED=true to use it.');
    }
  }

  async checkConnection(): Promise<{ uid: number }> {
    this.assertEnabled();
    return { uid: await this.odooClient.login() };
  }

  async listPaymentJournals(): Promise<Array<{ id: number; name?: string; type?: string; code?: string }>> {
    this.assertEnabled();
    return await this.odooClient.searchRead('account.journal', [['type', 'in', ['cash', 'bank']]], [
      'name',
      'type',
      'code'
    ], { limit: 50, order: 'name asc' });
  }

  async previewOrder(order: ShopifyOrder): Promise<{
    reference: string;
    customer: { ready: boolean; name: string; phone?: string; email?: string };
    products: Array<{ title: string; sku?: string | null; ready: boolean; odooProductId?: number; reason?: string }>;
    ready: boolean;
  }> {
    this.assertEnabled();
    const products = [];
    for (const line of activeLineItems(order)) {
      const sku = line.sku?.trim();
      if (!sku) {
        products.push({ title: line.title, sku, ready: false, reason: 'missing-shopify-sku' });
        continue;
      }
      const product = await this.findProductBySku(sku);
      products.push({
        title: line.title,
        sku,
        ready: Boolean(product),
        odooProductId: product?.id,
        reason: product ? undefined : 'odoo-product-not-found'
      });
    }

    return {
      reference: orderReference(order),
      customer: {
        ready: Boolean(customerName(order) && customerPhone(order)),
        name: customerName(order),
        phone: customerPhone(order),
        email: customerEmail(order)
      },
      products,
      ready: products.every((entry) => entry.ready) && Boolean(customerName(order) && customerPhone(order))
    };
  }

  async ensureSalesOrder(
    order: ShopifyOrder,
    shipment?: { accurateShipmentCode?: string | null; trackingUrl?: string | null },
    options: { prepareStock?: boolean } = {}
  ): Promise<{ id: number; name: string; created: boolean }> {
    this.assertEnabled();
    const shouldPrepareStock = options.prepareStock ?? true;
    const record = await shipmentRepository.findByShopifyOrderId(String(order.id));
    if (record?.odooSaleOrderId && record.odooSaleOrderName) {
      if (shouldPrepareStock) {
        await this.prepareSalesOrderStock(record.odooSaleOrderId);
      }
      return { id: record.odooSaleOrderId, name: record.odooSaleOrderName, created: false };
    }

    await shipmentRepository.createPending(order);
    const existingSaleOrder = await this.findExistingSaleOrder(order);
    if (existingSaleOrder?.name) {
      await shipmentRepository.updateOdooSalesOrder(String(order.id), {
        saleOrderId: existingSaleOrder.id,
        saleOrderName: existingSaleOrder.name,
        status: 'sales-order-existing'
      });
      if (shouldPrepareStock) {
        await this.prepareSalesOrderStock(existingSaleOrder.id);
      }
      return { id: existingSaleOrder.id, name: existingSaleOrder.name, created: false };
    }

    const claimed = await shipmentRepository.claimOdooSalesOrderCreation(String(order.id));
    if (!claimed) {
      const createdByParallelRun = await this.waitForParallelSaleOrderCreation(String(order.id), order);
      if (createdByParallelRun) {
        if (shouldPrepareStock) {
          await this.prepareSalesOrderStock(createdByParallelRun.id);
        }
        return {
          id: createdByParallelRun.id,
          name: createdByParallelRun.name,
          created: false
        };
      }

      throw new Error(`Odoo Sales Order creation is already running for ${order.name}; retry shortly`);
    }

    try {
      const existingSaleOrderAfterClaim = await this.findExistingSaleOrder(order);
      if (existingSaleOrderAfterClaim?.name) {
        await shipmentRepository.updateOdooSalesOrder(String(order.id), {
          saleOrderId: existingSaleOrderAfterClaim.id,
          saleOrderName: existingSaleOrderAfterClaim.name,
          status: 'sales-order-existing'
        });
        if (shouldPrepareStock) {
          await this.prepareSalesOrderStock(existingSaleOrderAfterClaim.id);
        }
        return {
          id: existingSaleOrderAfterClaim.id,
          name: existingSaleOrderAfterClaim.name,
          created: false
        };
      }

      const [partnerId, orderLines] = await Promise.all([
        this.findOrCreatePartner(order),
        this.buildSaleOrderLines(order)
      ]);
      const saleOrderId = await this.odooClient.create('sale.order', {
        partner_id: partnerId,
        client_order_ref: orderReference(order),
        origin: order.name,
        note: salesOrderNote(order, shipment),
        order_line: orderLines
      });

      await this.odooClient.call('sale.order', 'action_confirm', [[saleOrderId]]);
      const [saleOrder] = await this.odooClient.searchRead<OdooRecord & { name?: string }>(
        'sale.order',
        [['id', '=', saleOrderId]],
        ['name'],
        { limit: 1 }
      );
      const saleOrderName = saleOrder?.name ?? String(saleOrderId);

      await shipmentRepository.updateOdooSalesOrder(String(order.id), {
        saleOrderId,
        saleOrderName,
        status: 'sales-order-created'
      });
      if (shouldPrepareStock) {
        await this.prepareSalesOrderStock(saleOrderId);
      }

      return { id: saleOrderId, name: saleOrderName, created: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Odoo sales order error';
      await shipmentRepository.markOdooFailed(String(order.id), message);
      throw error;
    }
  }

  private async waitForParallelSaleOrderCreation(
    shopifyOrderId: string,
    order: ShopifyOrder
  ): Promise<(OdooRecord & { name: string }) | undefined> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await sleep(1000);

      const record = await shipmentRepository.findByShopifyOrderId(shopifyOrderId);
      if (record?.odooSaleOrderId && record.odooSaleOrderName) {
        return { id: record.odooSaleOrderId, name: record.odooSaleOrderName };
      }

      const existingSaleOrder = await this.findExistingSaleOrder(order);
      if (existingSaleOrder?.name) {
        await shipmentRepository.updateOdooSalesOrder(shopifyOrderId, {
          saleOrderId: existingSaleOrder.id,
          saleOrderName: existingSaleOrder.name,
          status: 'sales-order-existing'
        });
        return { id: existingSaleOrder.id, name: existingSaleOrder.name };
      }
    }

    return undefined;
  }

  async prepareSalesOrderStock(saleOrderId: number): Promise<void> {
    this.assertEnabled();
    const saleOrder = await this.getSaleOrderForOperations(saleOrderId);
    await this.completeManufacturingForSaleOrder(saleOrder);
    await this.validatePickingsForSaleOrder(saleOrder, 'internal');
  }

  async confirmSalesOrderDelivery(saleOrderId: number): Promise<void> {
    this.assertEnabled();
    const saleOrder = await this.getSaleOrderForOperations(saleOrderId);
    await this.validatePickingsForSaleOrder(saleOrder, 'customer');
  }

  /**
   * Optimized combined: fetches the SO once then completes manufacturing,
   * validates internal pickings, and validates customer pickings in one pass.
   * Saves one extra getSaleOrderForOperations round-trip vs calling
   * prepareSalesOrderStock + confirmSalesOrderDelivery separately.
   */
  async prepareSalesOrderAndConfirmDelivery(saleOrderId: number): Promise<void> {
    this.assertEnabled();
    const saleOrder = await this.getSaleOrderForOperations(saleOrderId);
    await this.completeManufacturingForSaleOrder(saleOrder);
    await this.validatePickingsForSaleOrder(saleOrder, 'internal');
    await this.validatePickingsForSaleOrder(saleOrder, 'customer');
  }

  async syncCollectedShipment(recordId: number): Promise<void> {
    this.assertEnabled();
    const record = await shipmentRepository.findById(recordId);
    if (!record?.rawOrderJson) {
      throw new Error(`Shipment record ${recordId} has no raw Shopify order JSON`);
    }
    const existingSalePaymentId = record.odooSalePaymentId ?? (record.odooSyncStatus === 'paid' ? record.odooPaymentId : null);
    if (existingSalePaymentId) {
      return;
    }

    const order = JSON.parse(record.rawOrderJson) as ShopifyOrder;
    // prepareStock: false — delivery is already confirmed by the time a shipment is collected.
    // Skips manufacturing + picking validation (already done) saving ~5-8 s of Odoo calls.
    const saleOrder = await this.ensureSalesOrder(order, record, { prepareStock: false });
    const invoice = await this.findOrCreatePostedSaleInvoice(String(order.id), saleOrder.id);

    if (!env.odoo.paymentJournalId) {
      await shipmentRepository.markOdooFailed(String(order.id), 'ODOO_PAYMENT_JOURNAL_ID is required to register payment');
      throw new Error('ODOO_PAYMENT_JOURNAL_ID is required to register payment');
    }

    const residual = Number(invoice.amount_residual ?? 0);
    if (residual <= 0 || invoice.payment_state === 'paid') {
      await shipmentRepository.markOdooInvoicePaid(String(order.id), {
        invoiceId: invoice.id,
        invoiceName: invoice.name ?? String(invoice.id),
        paymentId: record.odooSalePaymentId ?? record.odooPaymentId ?? null,
        status: 'paid-existing'
      });
      return;
    }

    // BUG-1 FIX: Use net merchant due (collectedAmount - deliveryFees) NOT gross collectedAmount.
    // Telegraph retains the delivery fee from cash collected on behalf of the merchant.
    // Only the net amount reaches the merchant and should be registered as invoice payment.
    // Example: collectedAmount=1270, deliveryFees=71 → netMerchantDue=1199 EGP registered.
    const amount = calculateTelegraphMerchantPaymentAmount({
      residual,
      collectedAmount: record.collectedAmount,
      deliveryFees: record.deliveryFees,
      customerDue: record.customerDue
    });
    if (amount <= 0) {
      await shipmentRepository.updateOdooInvoice(String(order.id), {
        invoiceId: invoice.id,
        invoiceName: invoice.name ?? String(invoice.id),
        status: 'invoice-posted-awaiting-payment'
      });
      return;
    }

    const payment = await this.registerPayment(invoice.id, amount, env.odoo.paymentJournalId, orderReference(order));
    await shipmentRepository.updateOdooPayment(String(order.id), {
      paymentId: payment.id,
      status: 'paid'
    });
    logger.info('Odoo invoice payment synced', {
      shopifyOrderId: order.id,
      saleOrderId: saleOrder.id,
      invoiceId: invoice.id,
      paymentId: payment.id,
      collectedAmount: record.collectedAmount,
      deliveryFees: record.deliveryFees,
      customerDue: record.customerDue,
      registeredAmount: amount
    });
  }

  async syncReturnedShipmentCharge(recordId: number): Promise<void> {
    this.assertEnabled();
    const record = await shipmentRepository.findById(recordId);
    if (!record?.rawOrderJson) {
      throw new Error(`Shipment record ${recordId} has no raw Shopify order JSON`);
    }

    const returnCharge = calculateTelegraphReturnCharge(record);
    if (returnCharge <= 0) {
      logger.info('Returned shipment has no charge to sync to Odoo', { recordId });
      return;
    }
    if (!env.odoo.paymentJournalId) {
      await shipmentRepository.markOdooFailed(record.shopifyOrderId, 'ODOO_PAYMENT_JOURNAL_ID is required to pay return charge');
      throw new Error('ODOO_PAYMENT_JOURNAL_ID is required to pay return charge');
    }

    const order = JSON.parse(record.rawOrderJson) as ShopifyOrder;
    const reference = `Return shipping charge ${orderReference(order)}`;
    const [existingBill] = await this.odooClient.searchRead<InvoiceRecord>(
      'account.move',
      [['move_type', '=', 'in_invoice'], ['ref', '=', reference]],
      ['name', 'state', 'payment_state', 'amount_residual'],
      { limit: 1, order: 'id desc' }
    );
    const bill = existingBill ?? await this.createReturnShippingBill(reference, returnCharge);
    if (bill.state === 'draft') {
      await this.odooClient.call('account.move', 'action_post', [[bill.id]]);
      bill.state = 'posted';
    }

    if (Number(bill.amount_residual ?? 0) === 0) {
      await shipmentRepository.updateOdooReturnCharge(record.shopifyOrderId, {
        billId: bill.id,
        paymentId: record.odooReturnPaymentId ?? record.odooPaymentId ?? null,
        status: 'returned-charge-paid'
      });
      return;
    }

    const payment = await this.registerPayment(bill.id, Math.min(Number(bill.amount_residual ?? returnCharge), returnCharge), env.odoo.paymentJournalId, reference);
    await shipmentRepository.updateOdooReturnCharge(record.shopifyOrderId, {
      billId: bill.id,
      paymentId: payment.id,
      status: 'returned-charge-paid'
    });
    logger.info('Odoo return shipping charge paid', {
      shopifyOrderId: order.id,
      billId: bill.id,
      paymentId: payment.id,
      amount: returnCharge
    });
  }

  private async findOrCreatePartner(order: ShopifyOrder): Promise<number> {
    const phone = customerPhone(order);
    const phoneSearch = compactPhoneSearch(phone);
    const email = customerEmail(order);
    const domain: unknown[] = phoneSearch && email
      ? ['|', '|', ['mobile', 'ilike', phoneSearch], ['phone', 'ilike', phoneSearch], ['email', '=', email]]
      : phoneSearch
        ? ['|', ['mobile', 'ilike', phoneSearch], ['phone', 'ilike', phoneSearch]]
        : email
          ? [['email', '=', email]]
          : [['name', '=', customerName(order)]];

    const existing = await this.odooClient.searchRead<PartnerRecord>('res.partner', domain, [
      'name',
      'mobile',
      'phone',
      'email'
    ], { limit: 1 });

    if (existing[0]) {
      return existing[0].id;
    }

    const address = customerAddress(order);
    return await this.odooClient.create('res.partner', {
      name: customerName(order),
      mobile: phone,
      phone,
      email: email ?? false,
      street: address?.address1 ?? false,
      street2: address?.address2 ?? false,
      city: address?.city ?? false,
      zip: address?.zip ?? false,
      customer_rank: 1,
      ref: orderReference(order)
    });
  }

  private async findProductBySku(sku: string): Promise<ProductRecord | undefined> {
    const products = await this.odooClient.searchRead<ProductRecord>('product.product', [['default_code', '=', sku]], [
      'display_name',
      'default_code'
    ], { limit: 2 });

    if (products.length > 1) {
      throw new Error(`Multiple Odoo products found for SKU ${sku}`);
    }
    return products[0];
  }

  private async getSaleOrderForOperations(saleOrderId: number): Promise<OdooRecord & { name?: string; picking_ids?: number[]; mrp_production_ids?: number[] }> {
    const [saleOrder] = await this.odooClient.searchRead<OdooRecord & {
      name?: string;
      picking_ids?: number[];
      mrp_production_ids?: number[];
    }>(
      'sale.order',
      [['id', '=', saleOrderId]],
      ['name', 'picking_ids', 'mrp_production_ids'],
      { limit: 1 }
    );
    if (!saleOrder) {
      throw new Error(`Odoo sale order not found: ${saleOrderId}`);
    }
    return saleOrder;
  }

  private async completeManufacturingForSaleOrder(saleOrder: { name?: string; mrp_production_ids?: number[] }): Promise<void> {
    const rootMos = saleOrder.mrp_production_ids?.length
      ? await this.odooClient.searchRead<ManufacturingOrderRecord>(
        'mrp.production',
        [['id', 'in', saleOrder.mrp_production_ids]],
        ['name', 'state', 'product_qty', 'qty_producing'],
        { limit: 100, order: 'id asc' }
      )
      : await this.odooClient.searchRead<ManufacturingOrderRecord>(
        'mrp.production',
        [['origin', '=', saleOrder.name]],
        ['name', 'state', 'product_qty', 'qty_producing'],
        { limit: 100, order: 'id asc' }
      );

    // Process root MOs in parallel — each gets its own visited set so independent trees
    // don't block each other. Shared sub-MOs may be processed twice but the
    // ['done','cancel'] guard in completeManufacturingOrder makes that safe.
    await Promise.all(rootMos.map((mo) => this.completeManufacturingTree(mo, new Set<number>())));
  }

  private async completeManufacturingTree(mo: ManufacturingOrderRecord, visited: Set<number>): Promise<void> {
    if (visited.has(mo.id)) return;
    visited.add(mo.id);

    const children = mo.name
      ? await this.odooClient.searchRead<ManufacturingOrderRecord>(
        'mrp.production',
        [['origin', '=', mo.name]],
        ['name', 'state', 'product_qty', 'qty_producing'],
        { limit: 100, order: 'id asc' }
      )
      : [];

    for (const child of children) {
      await this.completeManufacturingTree(child, visited);
    }

    await this.completeManufacturingOrder(mo);
  }

  private async completeManufacturingOrder(mo: ManufacturingOrderRecord): Promise<void> {
    if (['done', 'cancel'].includes(mo.state ?? '')) return;

    const quantity = Number(mo.product_qty ?? 0);
    if (quantity <= 0) {
      throw new Error(`Odoo manufacturing order ${mo.name ?? mo.id} has no quantity to produce`);
    }

    if (mo.state === 'draft') {
      await this.odooClient.call('mrp.production', 'action_confirm', [[mo.id]]);
    }

    await this.odooClient.call('mrp.production', 'action_assign', [[mo.id]]);
    await this.odooClient.call('mrp.production', 'write', [[mo.id], { qty_producing: quantity }]);

    const result = await this.odooClient.call<unknown>('mrp.production', 'button_mark_done', [[mo.id]]);
    await this.processOdooWizardResult(result);
  }

  private async validatePickingsForSaleOrder(
    saleOrder: { name?: string; picking_ids?: number[] },
    mode: 'internal' | 'customer'
  ): Promise<void> {
    const pickings = saleOrder.picking_ids?.length
      ? await this.odooClient.searchRead<StockPickingRecord>(
        'stock.picking',
        [['id', 'in', saleOrder.picking_ids]],
        ['name', 'state', 'location_id', 'location_dest_id', 'move_ids'],
        { limit: 100, order: 'id asc' }
      )
      : await this.odooClient.searchRead<StockPickingRecord>(
        'stock.picking',
        [['origin', '=', saleOrder.name]],
        ['name', 'state', 'location_id', 'location_dest_id', 'move_ids'],
        { limit: 100, order: 'id asc' }
      );

    const filtered = pickings.filter((picking) => {
      const destination = Array.isArray(picking.location_dest_id) ? picking.location_dest_id[1] : '';
      const source = Array.isArray(picking.location_id) ? picking.location_id[1] : '';
      if (mode === 'customer') return /customers/i.test(destination);
      return !/customers/i.test(destination) && /stock/i.test(source);
    });

    // Pickings of the same phase are independent — validate them in parallel
    await Promise.all(filtered.map((picking) => this.validatePicking(picking)));
  }

  private async validatePicking(picking: StockPickingRecord): Promise<void> {
    if (['done', 'cancel'].includes(picking.state ?? '')) return;

    await this.odooClient.call('stock.picking', 'action_assign', [[picking.id]]);

    const moves = await this.odooClient.searchRead<StockMoveRecord>(
      'stock.move',
      [['id', 'in', picking.move_ids ?? []]],
      ['product_id', 'product_uom', 'product_uom_qty', 'quantity', 'picked', 'move_line_ids', 'location_id', 'location_dest_id'],
      { limit: 100 }
    );

    // Process each move in parallel — they are independent within the same picking
    await Promise.all(moves.map(async (move) => {
      const quantity = Number(move.quantity || move.product_uom_qty || 0);
      if (quantity <= 0) return;
      if (!move.move_line_ids?.length) {
        await this.createMoveLineForMove(picking.id, move, quantity);
      }
      await this.odooClient.call('stock.move', 'write', [[move.id], { quantity, picked: true }]);
    }));

    const result = await this.odooClient.call<unknown>('stock.picking', 'button_validate', [[picking.id]]);
    await this.processOdooWizardResult(result);
  }

  private async createMoveLineForMove(pickingId: number, move: StockMoveRecord, quantity: number): Promise<void> {
    const productId = Array.isArray(move.product_id) ? move.product_id[0] : move.product_id;
    const productUomId = Array.isArray(move.product_uom) ? move.product_uom[0] : move.product_uom;
    const locationId = Array.isArray(move.location_id) ? move.location_id[0] : move.location_id;
    const locationDestId = Array.isArray(move.location_dest_id) ? move.location_dest_id[0] : move.location_dest_id;

    if (!productId || !productUomId || !locationId || !locationDestId) {
      throw new Error(`Cannot create stock move line for move ${move.id}: missing product/uom/location data`);
    }

    await this.odooClient.create('stock.move.line', {
      picking_id: pickingId,
      move_id: move.id,
      product_id: productId,
      product_uom_id: productUomId,
      quantity,
      location_id: locationId,
      location_dest_id: locationDestId
    });
  }

  private async processOdooWizardResult(result: unknown): Promise<void> {
    if (!result || typeof result !== 'object') return;
    const action = result as { res_model?: string; res_id?: number; context?: Record<string, unknown> };
    if (!action.res_model) return;

    if (action.res_model === 'stock.immediate.transfer' && action.res_id) {
      await this.odooClient.call('stock.immediate.transfer', 'process', [[action.res_id]], {
        context: action.context ?? {}
      });
      return;
    }

    if (action.res_model === 'stock.backorder.confirmation' && action.res_id) {
      await this.odooClient.call('stock.backorder.confirmation', 'process', [[action.res_id]], {
        context: action.context ?? {}
      });
      return;
    }

    if (action.res_model === 'mrp.consumption.warning') {
      const context = action.context ?? {};
      const wizardId = action.res_id || await this.odooClient.create('mrp.consumption.warning', {}, context);
      await this.odooClient.call('mrp.consumption.warning', 'action_set_qty', [[wizardId]], { context });
    }
  }

  private async findExistingSaleOrder(order: ShopifyOrder): Promise<(OdooRecord & { name?: string }) | undefined> {
    const [saleOrder] = await this.odooClient.searchRead<OdooRecord & { name?: string }>(
      'sale.order',
      ['|', ['client_order_ref', '=', orderReference(order)], ['origin', '=', order.name]],
      ['name'],
      { limit: 1, order: 'id desc' }
    );
    return saleOrder;
  }

  private async buildSaleOrderLines(order: ShopifyOrder): Promise<Array<[number, number, Record<string, unknown>]>> {
    const lines = [];
    for (const line of activeLineItems(order)) {
      const sku = line.sku?.trim();
      if (!sku) {
        throw new Error(`Shopify line "${line.title}" has no SKU`);
      }
      const product = await this.findProductBySku(sku);
      if (!product) {
        throw new Error(`Odoo product not found for Shopify SKU ${sku} (${line.title})`);
      }
      lines.push([
        0,
        0,
        {
          product_id: product.id,
          product_uom_qty: itemQuantity(line),
          price_unit: Number.parseFloat(line.price),
          discount: lineDiscountPercent(line),
          name: line.variant_title ? `${line.title} - ${line.variant_title}` : line.title
        }
      ] as [number, number, Record<string, unknown>]);
    }
    return lines;
  }

  private async findOrCreateTelegraphPartner(): Promise<number> {
    const [partner] = await this.odooClient.searchRead<PartnerRecord>(
      'res.partner',
      [['name', '=', 'Telegraph Shipping']],
      ['name'],
      { limit: 1 }
    );
    if (partner) {
      return partner.id;
    }
    return await this.odooClient.create('res.partner', {
      name: 'Telegraph Shipping',
      supplier_rank: 1
    });
  }

  private async createReturnShippingBill(reference: string, amount: number): Promise<InvoiceRecord> {
    // BUG-4 FIX: account_id was hardcoded as 101 — not portable across Odoo instances.
    // Now reads from ODOO_RETURN_CHARGE_ACCOUNT_ID env var.
    // To find the right value: Odoo → Accounting → Configuration → Chart of Accounts →
    // find the expense account for return shipping charges and note its integer ID.
    const accountId = env.odoo.returnChargeAccountId;
    if (!accountId) {
      throw new Error(
        'ODOO_RETURN_CHARGE_ACCOUNT_ID is not configured. ' +
        'Set this env var to the Odoo account ID (integer) for Telegraph return-charge vendor bill lines. ' +
        'Go to Accounting → Configuration → Chart of Accounts to find the appropriate expense account ID.'
      );
    }

    const partnerId = await this.findOrCreateTelegraphPartner();
    const billId = await this.odooClient.create('account.move', {
      move_type: 'in_invoice',
      partner_id: partnerId,
      invoice_date: new Date().toISOString().slice(0, 10),
      ref: reference,
      invoice_line_ids: [[0, 0, {
        name: reference,
        quantity: 1,
        price_unit: amount,
        account_id: accountId
      }]]
    });
    await this.odooClient.call('account.move', 'action_post', [[billId]]);
    const [bill] = await this.odooClient.searchRead<InvoiceRecord>(
      'account.move',
      [['id', '=', billId]],
      ['name', 'amount_residual'],
      { limit: 1 }
    );
    return bill;
  }

  private async findOrCreatePostedSaleInvoice(
    shopifyOrderId: string,
    saleOrderId: number
  ): Promise<InvoiceRecord> {
    const [saleOrder] = await this.odooClient.searchRead<OdooRecord & {
      name?: string;
      invoice_ids?: number[];
    }>(
      'sale.order',
      [['id', '=', saleOrderId]],
      ['name', 'invoice_ids'],
      { limit: 1 }
    );
    if (!saleOrder) {
      throw new Error(`Odoo sale order not found: ${saleOrderId}`);
    }

    const existingInvoices = await this.findSaleOrderInvoices(saleOrder);
    let invoice = existingInvoices[0];

    if (!invoice) {
      invoice = await this.createSaleInvoiceFromWizard(saleOrderId);
    }

    if (invoice.state === 'draft') {
      await this.odooClient.call('account.move', 'action_post', [[invoice.id]]);
      invoice = await this.getInvoice(invoice.id);
    }

    await shipmentRepository.updateOdooInvoice(shopifyOrderId, {
      invoiceId: invoice.id,
      invoiceName: invoice.name ?? String(invoice.id),
      status: invoice.payment_state === 'paid' ? 'paid-existing' : 'invoice-posted'
    });
    return invoice;
  }

  private async findSaleOrderInvoices(saleOrder: { name?: string; invoice_ids?: number[] }): Promise<InvoiceRecord[]> {
    const domains: unknown[] = [];
    if (saleOrder.invoice_ids?.length) {
      domains.push(['id', 'in', saleOrder.invoice_ids]);
    }
    if (saleOrder.name) {
      domains.push(['invoice_origin', '=', saleOrder.name]);
    }
    if (domains.length === 0) return [];

    const domain = domains.length === 1
      ? [
        ['move_type', '=', 'out_invoice'],
        ['state', '!=', 'cancel'],
        domains[0]
      ]
      : [
        ['move_type', '=', 'out_invoice'],
        ['state', '!=', 'cancel'],
        '|',
        domains[0],
        domains[1]
      ];

    return await this.odooClient.searchRead<InvoiceRecord>(
      'account.move',
      domain,
      ['name', 'state', 'move_type', 'invoice_origin', 'amount_residual', 'amount_total', 'payment_state'],
      { limit: 10, order: 'id desc' }
    );
  }

  private async createSaleInvoiceFromWizard(saleOrderId: number): Promise<InvoiceRecord> {
    const context = { active_model: 'sale.order', active_ids: [saleOrderId], active_id: saleOrderId };
    const wizardId = await this.odooClient.create(
      'sale.advance.payment.inv',
      { advance_payment_method: 'delivered' },
      context
    );
    const result = await this.odooClient.call<{ res_id?: number; res_ids?: number[] }>(
      'sale.advance.payment.inv',
      'create_invoices',
      [[wizardId]],
      { context }
    );
    const invoiceId = result?.res_id ?? result?.res_ids?.[0];
    if (invoiceId) {
      return await this.getInvoice(invoiceId);
    }

    const [saleOrder] = await this.odooClient.searchRead<OdooRecord & { name?: string; invoice_ids?: number[] }>(
      'sale.order',
      [['id', '=', saleOrderId]],
      ['name', 'invoice_ids'],
      { limit: 1 }
    );
    if (!saleOrder) {
      throw new Error(`Odoo sale order not found after invoice wizard: ${saleOrderId}`);
    }
    const [invoice] = await this.findSaleOrderInvoices(saleOrder);
    if (!invoice) {
      throw new Error(`Odoo did not create an invoice for sale order ${saleOrder?.name ?? saleOrderId}`);
    }
    return invoice;
  }

  private async getInvoice(invoiceId: number): Promise<InvoiceRecord> {
    const [invoice] = await this.odooClient.searchRead<InvoiceRecord>(
      'account.move',
      [['id', '=', invoiceId]],
      ['name', 'state', 'move_type', 'invoice_origin', 'amount_residual', 'amount_total', 'payment_state'],
      { limit: 1 }
    );
    if (!invoice) {
      throw new Error(`Odoo invoice not found: ${invoiceId}`);
    }
    return invoice;
  }

  private async createAndPostInvoice(
    shopifyOrderId: string,
    saleOrderId: number
  ): Promise<{ id: number; name: string; created: boolean }> {
    const [saleOrder] = await this.odooClient.searchRead<OdooRecord & {
      name?: string;
      partner_id?: [number, string] | number;
      client_order_ref?: string | false;
      order_line?: number[];
    }>(
      'sale.order',
      [['id', '=', saleOrderId]],
      ['name', 'partner_id', 'client_order_ref', 'order_line'],
      { limit: 1 }
    );
    if (!saleOrder) {
      throw new Error(`Odoo sale order not found: ${saleOrderId}`);
    }

    const orderLines = await this.odooClient.searchRead<OdooRecord & {
      name?: string;
      product_id?: [number, string] | number;
      product_uom_qty?: number;
      price_unit?: number;
    }>(
      'sale.order.line',
      [['id', 'in', saleOrder.order_line ?? []]],
      ['name', 'product_id', 'product_uom_qty', 'price_unit'],
      { limit: 100 }
    );

    const invoiceLineIds = orderLines.map((line) => [
      0,
      0,
      {
        product_id: Array.isArray(line.product_id) ? line.product_id[0] : line.product_id,
        name: line.name,
        quantity: line.product_uom_qty,
        price_unit: line.price_unit
      }
    ]);

    if (invoiceLineIds.length === 0) {
      throw new Error('Odoo sale order has no lines to invoice');
    }

    const invoiceId = await this.odooClient.create('account.move', {
      move_type: 'out_invoice',
      partner_id: Array.isArray(saleOrder.partner_id) ? saleOrder.partner_id[0] : saleOrder.partner_id,
      invoice_origin: saleOrder.name,
      ref: saleOrder.client_order_ref || saleOrder.name,
      invoice_line_ids: invoiceLineIds
    });

    await this.odooClient.call('account.move', 'action_post', [[invoiceId]]);
    const [invoice] = await this.odooClient.searchRead<InvoiceRecord>(
      'account.move',
      [['id', '=', invoiceId]],
      ['name'],
      { limit: 1 }
    );
    await shipmentRepository.updateOdooInvoice(shopifyOrderId, {
      invoiceId,
      invoiceName: invoice.name ?? String(invoice.id),
      status: 'invoice-posted'
    });
    return { id: invoiceId, name: invoice.name ?? String(invoiceId), created: true };
  }

  private async registerPayment(
    invoiceId: number,
    amount: number,
    journalId: number,
    reference: string
  ): Promise<{ id: number }> {
    const context = { active_model: 'account.move', active_ids: [invoiceId], active_id: invoiceId };
    const wizardId = await this.odooClient.create('account.payment.register', {
      amount,
      journal_id: journalId,
      communication: reference
    }, context);
    const result = await this.odooClient.call<Record<string, unknown>>(
      'account.payment.register',
      'action_create_payments',
      [[wizardId]],
      { context }
    );
    const paymentId = typeof result?.res_id === 'number' ? result.res_id : undefined;
    if (paymentId) {
      return { id: paymentId };
    }

    const payments = await this.odooClient.searchRead<PaymentRecord>(
      'account.payment',
      [['ref', 'ilike', reference]],
      ['name'],
      { limit: 1, order: 'id desc' }
    );
    if (!payments[0]) {
      throw new Error('Odoo payment was created but could not be identified');
    }
    return { id: payments[0].id };
  }
}
