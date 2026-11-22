import type { AccurateClient } from '../accurate/accurateClient.js';
import type { OdooClient, OdooRecord } from '../odoo/odooClient.js';
import type { OdooSyncService } from '../odoo/odooSyncService.js';
import { whatsappOdooBridgeConfig, type BridgeCarrierShipment, type BridgeInvoice, type BridgeSaleOrder, type BridgeSaleOrderLine } from './whatsappOdooBridgePolicy.js';
import { createPrismaBridgeStore } from './whatsappOdooBridgeStore.js';
import {
  WhatsappOdooBridgeService,
  type BridgeCarrierPort, type BridgeNotifier, type BridgeOdooPort, type BridgePayment, type BridgePicking,
} from './whatsappOdooBridgeService.js';

const SO_FIELDS = ['name', 'state', 'origin', 'client_order_ref', 'amount_total', 'partner_id', 'currency_id', 'company_id',
  'order_line', 'picking_ids', 'invoice_ids', 'note'];
const INVOICE_FIELDS = ['name', 'move_type', 'state', 'payment_state', 'amount_total', 'amount_residual', 'partner_id',
  'commercial_partner_id', 'invoice_origin'];

export function createBridgeCarrierPort(client: AccurateClient): BridgeCarrierPort {
  return {
    async listRecent(page) {
      const result = await client.listBridgeShipments({}, 100, page);
      return { data: result.data as BridgeCarrierShipment[], hasMorePages: Boolean(result.paginatorInfo?.hasMorePages) };
    },
    async listByIds(ids) {
      const out: BridgeCarrierShipment[] = [];
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const result = await client.listBridgeShipments({ id: chunk }, 100, 1);
        out.push(...(result.data as BridgeCarrierShipment[]).filter(s => chunk.includes(s.id)));
      }
      return out;
    },
  };
}

export function createBridgeOdooPort(odoo: OdooClient, sync: OdooSyncService): BridgeOdooPort {
  const read = <T extends OdooRecord>(model: string, domain: unknown[], fields: string[], limit = 100) =>
    odoo.searchRead<T>(model, domain, fields, { limit });
  return {
    findSaleOrdersByName: name => read<BridgeSaleOrder & OdooRecord>('sale.order', [['name', '=', name]], SO_FIELDS, 2),
    findSaleOrdersReferencingCode: code => read<OdooRecord & { name: string }>('sale.order',
      ['|', ['origin', '=', code], ['client_order_ref', '=', code]], ['name'], 5),
    findSaleOrdersReferencingCodes: codes => codes.length ? read<BridgeSaleOrder & OdooRecord>('sale.order',
      ['|', ['origin', 'in', codes], ['client_order_ref', 'in', codes]], SO_FIELDS, 50) : Promise.resolve([]),
    async readProductTypes(ids) {
      const rows = ids.length ? await read<OdooRecord & { type?: string }>('product.product', [['id', 'in', ids]], ['type'], 200) : [];
      return new Map(rows.map(r => [r.id, String(r.type ?? '')]));
    },
    async cancelSaleOrder(id) {
      // Same non-interactive cancel the sale-return service uses; no customer mail.
      await odoo.call('sale.order', 'action_cancel', [[id]], { context: { disable_cancel_warning: true } });
    },
    async readSaleOrder(id) { return (await read<BridgeSaleOrder & OdooRecord>('sale.order', [['id', '=', id]], SO_FIELDS, 1))[0] ?? null; },
    readLines: ids => ids.length ? read<BridgeSaleOrderLine & OdooRecord>('sale.order.line', [['id', 'in', ids]],
      ['product_id', 'product_uom_qty', 'qty_delivered', 'qty_invoiced', 'price_unit', 'discount', 'display_type'], 200) : Promise.resolve([]),
    readPickings: ids => ids.length ? read<BridgePicking & OdooRecord>('stock.picking', [['id', 'in', ids]],
      ['state', 'location_dest_id'], 100) : Promise.resolve([]),
    readInvoices: so => read<BridgeInvoice & OdooRecord>('account.move', [
      ['move_type', 'in', ['out_invoice', 'out_refund']],
      ...(so.invoice_ids?.length ? ['|', ['id', 'in', so.invoice_ids]] : []),
      ['invoice_origin', '=', so.name],
    ], INVOICE_FIELDS, 10),
    async readInvoice(id) { return (await read<BridgeInvoice & OdooRecord>('account.move', [['id', '=', id]], INVOICE_FIELDS, 1))[0] ?? null; },
    async readJournal(id) { return (await read<OdooRecord & { type?: string }>('account.journal', [['id', '=', id]], ['type', 'name'], 1))[0] ?? null; },
    async readPayment(id) {
      return (await read<BridgePayment & OdooRecord>('account.payment', [['id', '=', id]],
        ['state', 'amount', 'journal_id', 'partner_id', 'payment_type', 'reconciled_invoice_ids'], 1))[0] ?? null;
    },
    deliverStock: id => sync.prepareSalesOrderAndConfirmDelivery(id),
    createMerchantNetInvoice: (id, target) => sync.createMerchantNetInvoiceForSaleOrder(id, target),
    async registerPayment(invoiceId, amount, journalId, memo) {
      const context = { active_model: 'account.move', active_ids: [invoiceId], active_id: invoiceId };
      const wizardId = await odoo.create('account.payment.register', { amount, journal_id: journalId, communication: memo }, context);
      const result = await odoo.call<Record<string, unknown>>('account.payment.register', 'action_create_payments', [[wizardId]], { context });
      return typeof result?.res_id === 'number' ? result.res_id : undefined;
    },
    previewReturn: id => sync.previewReturnedSaleOrder(id),
    executeReturn: id => sync.returnDeliveredSaleOrderAndCancel(id),
  };
}

export function createTelegramBridgeNotifier(): BridgeNotifier {
  return {
    async send(chatIds, text) {
      const { sendMessage } = await import('../telegram/telegramApi.js');
      const sent = await Promise.all(chatIds.map(id => sendMessage(id, text)));
      if (!sent.some(Boolean)) throw new Error('Telegram review notice was not delivered');
    },
  };
}

/** Production wiring. Returns undefined (no Neon/carrier/Odoo access) while disabled. */
export async function createWhatsappOdooBridge(): Promise<WhatsappOdooBridgeService | undefined> {
  const config = whatsappOdooBridgeConfig();
  if (!config.enabled) return undefined;
  const [{ AccurateClient }, { OdooClient }, { OdooSyncService }, { env }, { safeQueueConfig }] = await Promise.all([
    import('../accurate/accurateClient.js'), import('../odoo/odooClient.js'), import('../odoo/odooSyncService.js'),
    import('../config/env.js'), import('./safeQueuePolicy.js'),
  ]);
  const odoo = new OdooClient();
  return new WhatsappOdooBridgeService({
    config,
    store: createPrismaBridgeStore(),
    carrier: createBridgeCarrierPort(new AccurateClient()),
    odoo: createBridgeOdooPort(odoo, new OdooSyncService(odoo)),
    notifier: createTelegramBridgeNotifier(),
    paymentJournalId: env.odoo.paymentJournalId,
    epoch: () => { try { return safeQueueConfig()?.epoch; } catch { return undefined; } },
  });
}
