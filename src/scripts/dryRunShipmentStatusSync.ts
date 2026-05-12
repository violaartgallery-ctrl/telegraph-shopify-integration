import { AccurateClient } from '../accurate/accurateClient.js';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { OdooClient } from '../odoo/odooClient.js';
import { projectAccurateStatusToShopify } from '../services/accurateStatusMapper.js';

type OpenShipment = {
  id: number;
  shopifyOrderId: string;
  shopifyOrderName: string | null;
  accurateShipmentId: number | null;
  accurateShipmentCode: string | null;
  accurateStatus: string | null;
  accurateStatusCode: string | null;
  collectionStatus: string | null;
  odooSaleOrderName: string | null;
  odooInvoiceName: string | null;
  odooSalePaymentId: number | null;
};

const parseLimit = (): number => {
  const arg = process.argv.find((entry) => entry.startsWith('--limit='));
  const value = arg ? Number.parseInt(arg.split('=')[1] ?? '', 10) : env.syncOpenShipmentsBatchSize;
  return Number.isFinite(value) && value > 0 ? value : env.syncOpenShipmentsBatchSize;
};

const findExistingInvoice = async (odoo: OdooClient, saleOrderName?: string | null) => {
  if (!saleOrderName) return null;
  const [saleOrder] = await odoo.searchRead<any>(
    'sale.order',
    [['name', '=', saleOrderName]],
    ['name', 'invoice_ids', 'invoice_status'],
    { limit: 1 }
  );
  if (!saleOrder) return null;

  const invoiceMatch = saleOrder.invoice_ids?.length
    ? ['|', ['id', 'in', saleOrder.invoice_ids], ['invoice_origin', '=', saleOrder.name]]
    : ['invoice_origin', '=', saleOrder.name];
  const domain = saleOrder.invoice_ids?.length
    ? [['move_type', '=', 'out_invoice'], ['state', '!=', 'cancel'], ...invoiceMatch]
    : [['move_type', '=', 'out_invoice'], ['state', '!=', 'cancel'], invoiceMatch];

  const [invoice] = await odoo.searchRead<any>(
    'account.move',
    domain,
    ['name', 'state', 'payment_state', 'amount_residual', 'amount_total', 'invoice_origin'],
    { limit: 1, order: 'id desc' }
  );
  return invoice ?? null;
};

const main = async () => {
  const limit = parseLimit();
  const accurateClient = new AccurateClient();
  const odoo = new OdooClient();

  const rows = await prisma.shipmentRecord.findMany({
    where: {
      accurateShipmentId: { not: null },
      OR: [
        { accurateIsTerminal: null },
        { accurateIsTerminal: false }
      ]
    },
    orderBy: { updatedAt: 'asc' },
    take: limit,
    select: {
      id: true,
      shopifyOrderId: true,
      shopifyOrderName: true,
      accurateShipmentId: true,
      accurateShipmentCode: true,
      accurateStatus: true,
      accurateStatusCode: true,
      collectionStatus: true,
      odooSaleOrderName: true,
      odooInvoiceName: true,
      odooSalePaymentId: true
    }
  }) as OpenShipment[];

  const report = [];
  for (const row of rows) {
    const shipment = await accurateClient.getShipment({
      id: row.accurateShipmentId ?? undefined,
      code: row.accurateShipmentCode ?? undefined
    });
    if (!shipment) {
      report.push({
        order: row.shopifyOrderName,
        code: row.accurateShipmentCode,
        action: 'error',
        reason: 'Telegraph shipment not found'
      });
      continue;
    }

    const projection = projectAccurateStatusToShopify({
      statusCode: shipment.status?.code,
      statusName: shipment.status?.name,
      returnStatusCode: shipment.returnStatus?.code,
      returnStatusName: shipment.returnStatus?.name,
      collected: shipment.collected,
      paidToCustomer: shipment.paidToCustomer,
      cancelled: shipment.cancelled,
      customerDue: shipment.customerDue
    });

    const existingInvoice = await findExistingInvoice(odoo, row.odooSaleOrderName);
    const odooAction =
      projection.collectionStatus === 'collected'
        ? existingInvoice
          ? existingInvoice.payment_state === 'paid'
            ? 'record existing paid invoice'
            : existingInvoice.state === 'draft'
              ? 'post existing draft invoice then pay residual'
              : 'pay existing invoice residual'
          : 'create invoice then pay'
        : projection.collectionStatus === 'payment-review'
          ? 'manual payment review; do not auto-pay'
        : projection.collectionStatus.startsWith('returned')
          ? 'check/create return charge bill if return fees exist'
          : 'no Odoo accounting action';

    report.push({
      order: row.shopifyOrderName,
      code: row.accurateShipmentCode,
      currentDb: `${row.accurateStatusCode ?? row.accurateStatus ?? 'none'} / ${row.collectionStatus ?? 'none'}`,
      liveTelegraph: `${shipment.status?.code ?? 'none'} / ${shipment.status?.name ?? 'none'}`,
      shopifyAction: `set ${projection.shipmentStatus} / ${projection.collectionStatus}`,
      odooSaleOrder: row.odooSaleOrderName,
      existingInvoice: existingInvoice
        ? `${existingInvoice.name} ${existingInvoice.state}/${existingInvoice.payment_state} residual=${existingInvoice.amount_residual}`
        : null,
      odooAction,
      terminalAfterSync: projection.isTerminal
    });
  }

  console.log(JSON.stringify({
    openShipmentsInBatch: rows.length,
    batchLimit: limit,
    report
  }, null, 2));
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
