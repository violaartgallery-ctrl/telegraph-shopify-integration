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

  findOpenShipments: async (limit?: number) => {
    const collectedSyncWhere = {
      accurateShipmentId: { not: null },
      accurateIsTerminal: true,
      collectionStatus: 'collected',
      odooSyncStatus: {
        in: [
          'sales-order-created',
          'sales-order-existing',
          'delivery-confirmed',
          'invoice-posted'
        ]
      }
    };

    const collectedRecords = await prisma.shipmentRecord.findMany({
      where: collectedSyncWhere,
      orderBy: { updatedAt: 'asc' },
      ...(limit ? { take: limit } : {})
    });

    let remaining = limit ? limit - collectedRecords.length : undefined;
    if (remaining !== undefined && remaining <= 0) {
      return collectedRecords;
    }

    const returnedRecords = await prisma.shipmentRecord.findMany({
      where: {
        accurateShipmentId: { not: null },
        accurateIsTerminal: true,
        collectionStatus: { in: ['returned', 'returned-settled'] },
        odooSyncStatus: {
          in: [
            'sales-order-created',
            'sales-order-existing',
            'delivery-confirmed',
            'invoice-posted'
          ]
        },
        OR: [
          { returnFees: { gt: 0 } },
          { returningDueFees: { gt: 0 } }
        ]
      },
      orderBy: { updatedAt: 'asc' },
      ...(remaining ? { take: remaining } : {})
    });

    remaining = limit ? limit - collectedRecords.length - returnedRecords.length : undefined;
    if (remaining !== undefined && remaining <= 0) {
      return [...collectedRecords, ...returnedRecords];
    }

    const openRecords = await prisma.shipmentRecord.findMany({
      where: {
        accurateShipmentId: { not: null },
        OR: [
          { accurateIsTerminal: null },
          { accurateIsTerminal: false }
        ]
      },
      orderBy: { updatedAt: 'asc' },
      ...(remaining ? { take: remaining } : {})
    });

    return [...collectedRecords, ...returnedRecords, ...openRecords];
  },

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

  markTerminal: async (shopifyOrderId: string, reason: string) =>
    await prisma.shipmentRecord.update({
      where: { shopifyOrderId },
      data: {
        accurateIsTerminal: true,
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
    }),

  // ─── Background queue methods ─────────────────────────────────────

  /**
   * Queue Odoo Sales Order creation after Telegraph shipment is created.
   * SAFE: only queues records where odooSyncStatus IS NULL.
   * Does NOT requeue 'failed', does NOT downgrade 'delivery-confirmed',
   * does NOT overwrite any pending/processing/retryable status.
   * Uses atomic updateMany so concurrent calls are harmless.
   * Returns true if the record was successfully queued.
   */
  markOdooSoPending: async (shopifyOrderId: string): Promise<boolean> => {
    const result = await prisma.shipmentRecord.updateMany({
      where: {
        shopifyOrderId,
        OR: [{ odooSyncStatus: null }]
      },
      data: {
        odooSyncStatus: 'odoo-so-pending',
        odooLastError: null,
        odooRetryAt: null,
        odooSyncedAt: new Date()
      }
    });
    return result.count === 1;
  },

  /**
   * Find orders waiting for Odoo processing (any pending stage).
   * Ordered by odooRetryAt (retries first, nulls last) then createdAt (oldest first).
   * Only picks orders where accurateShipmentId and rawOrderJson exist.
   * Failed-retryable entries are only returned once their odooRetryAt has elapsed.
   */
  findPendingOdooQueue: async (limit: number) =>
    await prisma.shipmentRecord.findMany({
      where: {
        accurateShipmentId: { not: null },
        rawOrderJson: { not: null },
        OR: [
          { odooSyncStatus: 'odoo-so-pending' },
          { odooSyncStatus: 'odoo-stock-pending' },
          { odooSyncStatus: 'odoo-delivery-pending' },
          {
            odooSyncStatus: 'odoo-failed-retryable',
            OR: [
              { odooRetryAt: null },
              { odooRetryAt: { lte: new Date() } }
            ]
          }
        ]
      },
      orderBy: [
        { odooRetryAt: 'asc' },
        { createdAt: 'asc' }
      ],
      take: limit
    }),

  /**
   * Atomically claim an order for a specific stage transition.
   * Returns true if this worker successfully claimed it (no other worker did).
   * Prevents duplicate processing when cron overlaps or user clicks twice.
   */
  claimOdooStage: async (recordId: number, fromStatus: string, toStatus: string): Promise<boolean> => {
    const result = await prisma.shipmentRecord.updateMany({
      where: { id: recordId, odooSyncStatus: fromStatus },
      data: {
        odooSyncStatus: toStatus,
        odooSyncedAt: new Date()
      }
    });
    return result.count === 1;
  },

  /**
   * Mark a stage as successfully completed and advance to next status.
   * Resets retry fields (attempt count, retryAt, lastError) on every success.
   * Optionally saves Sales Order ID/name when Stage 1 completes.
   */
  markOdooStageSuccess: async (
    recordId: number,
    nextStatus: string,
    data?: { saleOrderId?: number; saleOrderName?: string }
  ) =>
    await prisma.shipmentRecord.update({
      where: { id: recordId },
      data: {
        odooSyncStatus: nextStatus,
        odooLastError: null,
        odooAttemptCount: 0,
        odooRetryAt: null,
        odooSyncedAt: new Date(),
        ...(data?.saleOrderId ? { odooSaleOrderId: data.saleOrderId } : {}),
        ...(data?.saleOrderName ? { odooSaleOrderName: data.saleOrderName } : {})
      }
    }),

  /**
   * Mark a stage as failed and schedule retry from the SAME stage.
   * Retries from the failed stage, not from the beginning.
   * Backs off with exponential delay: attempt 1→5m, 2→15m, 3→60m, 4→240m.
   * On attempt 5+, marks permanently as 'failed' (no more auto-retries).
   * Always stores RETRY_FROM:<stage>|<error> so dashboard can show the failing stage.
   */
  markOdooStageFailure: async (recordId: number, retryFromStatus: string, error: string) => {
    const record = await prisma.shipmentRecord.findUnique({
      where: { id: recordId },
      select: { odooAttemptCount: true }
    });

    const attempt = (record?.odooAttemptCount ?? 0) + 1;
    const lastError = `RETRY_FROM:${retryFromStatus}|${error}`;

    if (attempt >= 5) {
      // Permanent failure — store RETRY_FROM so dashboard shows which stage failed finally
      return await prisma.shipmentRecord.update({
        where: { id: recordId },
        data: {
          odooSyncStatus: 'failed',
          odooLastError: lastError,
          odooAttemptCount: attempt,
          odooRetryAt: null,
          odooSyncedAt: new Date()
        }
      });
    }

    const backoffMinutes = attempt === 1 ? 5 : attempt === 2 ? 15 : attempt === 3 ? 60 : 240;
    const retryAt = new Date(Date.now() + backoffMinutes * 60_000);

    return await prisma.shipmentRecord.update({
      where: { id: recordId },
      data: {
        odooSyncStatus: 'odoo-failed-retryable',
        odooLastError: lastError,
        odooAttemptCount: attempt,
        odooRetryAt: retryAt,
        odooSyncedAt: new Date()
      }
    });
  },

  /**
   * Save the Odoo Sales Order ID/name onto a record without changing odooSyncStatus.
   * Used in Stage 2/3 recovery when odooSaleOrderId was missing due to a crash
   * that happened after SO creation but before the DB was updated.
   */
  updateOdooSaleOrderLink: async (recordId: number, data: {
    saleOrderId: number;
    saleOrderName: string;
  }) =>
    await prisma.shipmentRecord.update({
      where: { id: recordId },
      data: {
        odooSaleOrderId: data.saleOrderId,
        odooSaleOrderName: data.saleOrderName,
        odooSyncedAt: new Date()
        // odooSyncStatus intentionally unchanged
      }
    }),

  /**
   * Permanently mark an order as failed (too many attempts or unrecoverable error).
   * Used as a safety guard when attempt count is already >= 5 at queue-pick time.
   */
  markOdooQueueFailed: async (shopifyOrderId: string, error: string) =>
    await prisma.shipmentRecord.update({
      where: { shopifyOrderId },
      data: {
        odooSyncStatus: 'failed',
        odooLastError: error,
        odooSyncedAt: new Date()
      }
    }),

  /**
   * Recover records stuck in a processing status due to a hard function kill
   * (e.g. Netlify 26s timeout during a long Odoo call).
   *
   * If a record has been in an intermediate "…-creating / …-preparing / …-confirming"
   * status for longer than `stuckThresholdMinutes` without being updated, it means
   * the worker that claimed it died without writing a success or failure.
   *
   * Recovery rolls the status back to the matching pending stage so the next
   * queue run picks it up cleanly:
   *   odoo-so-creating        → odoo-so-pending
   *   odoo-stock-preparing    → odoo-stock-pending
   *   odoo-delivery-confirming → odoo-delivery-pending
   *
   * Uses odooSyncedAt as the timestamp because claimOdooStage sets it when
   * transitioning to the processing status.
   *
   * Returns the total count of records that were recovered.
   */
  recoverStuckProcessingRecords: async (stuckThresholdMinutes = 10): Promise<number> => {
    const stuckBefore = new Date(Date.now() - stuckThresholdMinutes * 60_000);

    const [r1, r2, r3] = await Promise.all([
      prisma.shipmentRecord.updateMany({
        where: { odooSyncStatus: 'odoo-so-creating',        odooSyncedAt: { lt: stuckBefore } },
        data:  { odooSyncStatus: 'odoo-so-pending' }
      }),
      prisma.shipmentRecord.updateMany({
        where: { odooSyncStatus: 'odoo-stock-preparing',    odooSyncedAt: { lt: stuckBefore } },
        data:  { odooSyncStatus: 'odoo-stock-pending' }
      }),
      prisma.shipmentRecord.updateMany({
        where: { odooSyncStatus: 'odoo-delivery-confirming', odooSyncedAt: { lt: stuckBefore } },
        data:  { odooSyncStatus: 'odoo-delivery-pending' }
      })
    ]);

    return r1.count + r2.count + r3.count;
  }
};
