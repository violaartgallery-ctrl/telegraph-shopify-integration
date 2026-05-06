import { prisma } from '../lib/prisma.js';
import type { ShopifyOrder } from '../types/shopify.js';

export const shipmentRepository = {
  findByShopifyOrderId: async (shopifyOrderId: string) =>
    await prisma.shipmentRecord.findUnique({ where: { shopifyOrderId } }),

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

  findOpenShipments: async () =>
    await prisma.shipmentRecord.findMany({
      where: {
        accurateShipmentId: { not: null },
        OR: [
          { accurateStatus: null },
          { accurateStatus: { notIn: ['Delivered', 'Returned', 'Rejected', 'Cancelled', 'Delivered To Recipient'] } }
        ]
      },
      orderBy: { updatedAt: 'asc' }
    }),

  createPending: async (order: ShopifyOrder) =>
    await prisma.shipmentRecord.upsert({
      where: { shopifyOrderId: String(order.id) },
      update: {
        shopifyOrderNumber: String(order.order_number),
        shopifyOrderName: order.name,
        rawOrderJson: JSON.stringify(order)
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

  assignPlannedShipmentCode: async (shopifyOrderId: string, code: string) =>
    await prisma.shipmentRecord.update({
      where: { shopifyOrderId },
      data: { plannedShipmentCode: code }
    }),

  updateAccurateSnapshot: async (id: number, data: {
    accurateStatus: string;
    accurateReturnStatus?: string | null;
    collectionStatus?: string | null;
    trackingUrl?: string | null;
    collectedAmount?: number | null;
    pendingCollectionAmount?: number | null;
    returnedValue?: number | null;
    deliveredAt?: Date | null;
  }) =>
    await prisma.shipmentRecord.update({
      where: { id },
      data: {
        accurateStatus: data.accurateStatus,
        accurateReturnStatus: data.accurateReturnStatus,
        collectionStatus: data.collectionStatus,
        trackingUrl: data.trackingUrl,
        collectedAmount: data.collectedAmount,
        pendingCollectionAmount: data.pendingCollectionAmount,
        returnedValue: data.returnedValue,
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
    })
};
