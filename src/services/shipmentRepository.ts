import { prisma } from '../lib/prisma.js';
import type { ShopifyOrder } from '../types/shopify.js';

export const shipmentRepository = {
  findByShopifyOrderId: async (shopifyOrderId: string) =>
    await prisma.shipmentRecord.findUnique({ where: { shopifyOrderId } }),

  findSummaryByShopifyOrderId: async (shopifyOrderId: string) =>
    await prisma.shipmentRecord.findUnique({
      where: { shopifyOrderId },
      select: {
        id: true,
        shopifyOrderId: true,
        accurateShipmentId: true,
        accurateShipmentCode: true,
        odooSaleOrderId: true,
        odooSaleOrderName: true
      }
    }),

  findById: async (id: number) =>
    await prisma.shipmentRecord.findUnique({ where: { id } }),

  findByShopifyOrderIds: async (shopifyOrderIds: string[]) =>
    await prisma.shipmentRecord.findMany({
      where: {
        shopifyOrderId: { in: shopifyOrderIds }
      }
    }),

  findByReference: async (reference: string) =>
    await prisma.shipmentRecord.findFirst({
      where: {
        OR: [
          { shopifyOrderNumber: reference },
          { shopifyOrderName: reference },
          { accurateShipmentCode: reference }
        ]
      }
    }),

  findOpenShipments: async (limit?: number) =>
    await prisma.shipmentRecord.findMany({
      where: {
        accurateShipmentId: { not: null },
        OR: [
          { accurateIsTerminal: null },
          { accurateIsTerminal: false }
        ]
      },
      orderBy: { updatedAt: 'asc' },
      ...(limit ? { take: limit } : {})
    }),

  createPending: async (order: ShopifyOrder) =>
    await prisma.shipmentRecord.upsert({
      where: { shopifyOrderId: String(order.id) },
      update: {
        shopifyOrderNumber: String(order.order_number),
        shopifyOrderName: order.name,
        rawOrderJson: JSON.stringify(order),
        accurateStatus: 'PENDING'
      },
      create: {
        shopifyOrderId: String(order.id),
        shopifyOrderNumber: String(order.order_number),
        shopifyOrderName: order.name,
        rawOrderJson: JSON.stringify(order),
        accurateStatus: 'PENDING'
      }
    }),

  markCreated: async (shopifyOrderId: string, shipment: { id: number; code: string; status?: string | null }) =>
    await prisma.shipmentRecord.update({
      where: { shopifyOrderId },
      data: {
        accurateShipmentId: shipment.id,
        accurateShipmentCode: shipment.code,
        plannedShipmentCode: shipment.code,
        accurateStatus: shipment.status ?? 'CREATED',
        lastError: null
      }
    }),

  clearDeletedShipment: async (shopifyOrderId: string, reason: string) =>
    await prisma.shipmentRecord.update({
      where: { shopifyOrderId },
      data: {
        accurateShipmentId: null,
        accurateShipmentCode: null,
        plannedShipmentCode: null,
        accurateStatus: 'DELETED_ON_TELEGRAPH',
        trackingUrl: null,
        lastError: reason,
        lastSyncedAt: new Date()
      }
    }),

  assignPlannedShipmentCode: async (shopifyOrderId: string, code: string) =>
    await prisma.shipmentRecord.update({
      where: { shopifyOrderId },
      data: { plannedShipmentCode: code }
    }),

  updateAccurateSnapshot: async (id: number, data: {
    accurateStatus: string;
    accurateStatusCode?: string | null;
    accurateReturnStatus?: string | null;
    accurateReturnStatusCode?: string | null;
    accurateIsTerminal?: boolean | null;
    collectionStatus?: string | null;
    trackingUrl?: string | null;
    collectedAmount?: number | null;
    pendingCollectionAmount?: number | null;
    returnedValue?: number | null;
    deliveryFees?: number | null;
    returnFees?: number | null;
    returningDueFees?: number | null;
    customerDue?: number | null;
    deliveredAt?: Date | null;
  }) =>
    await prisma.shipmentRecord.update({
      where: { id },
      data: {
        accurateStatus: data.accurateStatus,
        accurateStatusCode: data.accurateStatusCode,
        accurateReturnStatus: data.accurateReturnStatus,
        accurateReturnStatusCode: data.accurateReturnStatusCode,
        accurateIsTerminal: data.accurateIsTerminal,
        collectionStatus: data.collectionStatus,
        trackingUrl: data.trackingUrl,
        collectedAmount: data.collectedAmount,
        pendingCollectionAmount: data.pendingCollectionAmount,
        returnedValue: data.returnedValue,
        deliveryFees: data.deliveryFees,
        returnFees: data.returnFees,
        returningDueFees: data.returningDueFees,
        customerDue: data.customerDue,
        deliveredAt: data.deliveredAt,
        lastSyncedAt: new Date()
      }
    }),

  markFailed: async (shopifyOrderId: string, error: string) =>
    await prisma.shipmentRecord.update({
      where: { shopifyOrderId },
      data: {
        accurateStatus: 'FAILED',
        lastError: error
      }
    }),

  updateStatus: async (id: number, status: string) =>
    await prisma.shipmentRecord.update({
      where: { id },
      data: { accurateStatus: status }
    }),

  updateOdooSalesOrder: async (shopifyOrderId: string, data: {
    saleOrderId: number;
    saleOrderName: string;
    status: string;
  }) =>
    await prisma.shipmentRecord.update({
      where: { shopifyOrderId },
      data: {
        odooSaleOrderId: data.saleOrderId,
        odooSaleOrderName: data.saleOrderName,
        odooSyncStatus: data.status,
        odooLastError: null,
        odooSyncedAt: new Date()
      }
    }),

  claimOdooSalesOrderCreation: async (shopifyOrderId: string) => {
    const result = await prisma.shipmentRecord.updateMany({
      where: {
        shopifyOrderId,
        odooSaleOrderId: null,
        OR: [
          { odooSyncStatus: null },
          { odooSyncStatus: { not: 'sales-order-creating' } }
        ]
      },
      data: {
        odooSyncStatus: 'sales-order-creating',
        odooLastError: null,
        odooSyncedAt: new Date()
      }
    });
    return result.count === 1;
  },

  updateOdooInvoice: async (shopifyOrderId: string, data: {
    invoiceId: number;
    invoiceName: string;
    status: string;
  }) =>
    await prisma.shipmentRecord.update({
      where: { shopifyOrderId },
      data: {
        odooInvoiceId: data.invoiceId,
        odooInvoiceName: data.invoiceName,
        odooSyncStatus: data.status,
        odooLastError: null,
        odooSyncedAt: new Date()
      }
    }),

  updateOdooPayment: async (shopifyOrderId: string, data: {
    paymentId: number;
    status: string;
  }) =>
    await prisma.shipmentRecord.update({
      where: { shopifyOrderId },
      data: {
        odooPaymentId: data.paymentId,
        odooSalePaymentId: data.paymentId,
        odooSyncStatus: data.status,
        odooLastError: null,
        odooSyncedAt: new Date()
      }
    }),

  markOdooInvoicePaid: async (shopifyOrderId: string, data: {
    invoiceId: number;
    invoiceName: string;
    paymentId?: number | null;
    status: string;
  }) =>
    await prisma.shipmentRecord.update({
      where: { shopifyOrderId },
      data: {
        odooInvoiceId: data.invoiceId,
        odooInvoiceName: data.invoiceName,
        odooPaymentId: data.paymentId ?? undefined,
        odooSalePaymentId: data.paymentId ?? undefined,
        odooSyncStatus: data.status,
        odooLastError: null,
        odooSyncedAt: new Date()
      }
    }),

  updateOdooReturnCharge: async (shopifyOrderId: string, data: {
    billId: number;
    paymentId?: number | null;
    status: string;
  }) =>
    await prisma.shipmentRecord.update({
      where: { shopifyOrderId },
      data: {
        odooPaymentId: data.paymentId,
        odooReturnBillId: data.billId,
        odooReturnPaymentId: data.paymentId,
        odooSyncStatus: data.status,
        odooLastError: null,
        odooSyncedAt: new Date()
      }
    }),

  markOdooFailed: async (shopifyOrderId: string, error: string) =>
    await prisma.shipmentRecord.update({
      where: { shopifyOrderId },
      data: {
        odooSyncStatus: 'failed',
        odooLastError: error,
        odooSyncedAt: new Date()
      }
    }),

  /**
   * Mark that manufacturing + internal + customer delivery pickings are all confirmed.
   * After this status is set the retry path skips Odoo entirely (returns cached result).
   */
  markOdooDeliveryConfirmed: async (shopifyOrderId: string) =>
    await prisma.shipmentRecord.update({
      where: { shopifyOrderId },
      data: {
        odooSyncStatus: 'delivery-confirmed',
        odooLastError: null,
        odooSyncedAt: new Date()
      }
    })
};
