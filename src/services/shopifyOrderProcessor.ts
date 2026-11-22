import { AccurateClient } from '../accurate/accurateClient.js';
import { AccurateMapper } from './accurateMapper.js';
import { failedPayloadService } from './failedPayloadService.js';
import { logger } from '../lib/logger.js';
import { shipmentRepository } from './shipmentRepository.js';
import { isOrderEligibleForShipment } from './orderEligibility.js';
import { shopifyFulfillmentClient } from '../shopify/shopifyFulfillmentClient.js';
import { shipmentCodeService } from './shipmentCodeService.js';
import { UnauthorizedError, ValidationError } from '../lib/errors.js';
import { withManualShipmentClaim, type ManualShipmentAuthorization, type ManualShipmentClaim } from './manualShippingSafety.js';
import { withAdminShipmentClaim, type AdminShipmentAuthorization } from './adminShippingSafety.js';
import type { ShopifyOrder } from '../types/shopify.js';
import { bindManualShipment } from './manualShipmentBinding.js';
import { SoftDeadlineError } from './productionPipelineErrors.js';
import { reconcileExistingShipmentFulfillment, recordCreatedShipmentFulfillmentBoundary,
  markCreatedShipmentFulfillmentAttempt, completeCreatedShipmentFulfillment, noteExistingFulfillmentReview,
  existingFulfillmentBoundaryLink,
  type ExistingFulfillmentAuthority } from './existingShipmentFulfillment.js';
import type { ExistingShipmentIdentity } from '../shopify/shopifyFulfillmentClient.js';
// OdooSyncService kept for constructor type — no longer called synchronously here.
import type { OdooSyncService } from '../odoo/odooSyncService.js';

interface ProcessResult {
  skipped: boolean;
  reason?: string;
  accurateShipmentCode?: string;
  accurateShipmentId?: number;
  fulfillment?: {
    skipped: boolean;
    reason?: string;
  };
  odoo?: {
    skipped: boolean;
    reason?: string;
    saleOrderName?: string;
    created?: boolean;
  };
}

const telegraphDashboardUrl = (shipmentId?: number | null): string | null =>
  shipmentId ? `https://system.telegraphex.com/admin/shipments/${shipmentId}` : null;

const isDuplicateShipmentCodeError = (error: unknown): boolean => {
  if (!(error instanceof ValidationError)) return false;
  return JSON.stringify(error.details ?? error.message).includes('input.code');
};

// Reserve the whole carrier -> durable identity -> Shopify -> checkpoint path,
// not just the next carrier request. This is headroom, not a provider SLA.
export const MIN_CARRIER_COMPLETION_BUDGET_MS = 120_000;
function assertCarrierCompletionBudget(context?: Record<string, unknown>): void {
  const deadline = context?.operationDeadline;
  if (deadline === undefined) {
    // Admin's existing signed route has its own operation fence. Do not invent
    // a fresh deadline or weaken that fence when it was not explicitly passed.
    if (context?.manualRunAuthorization) throw new ValidationError('Native Run operation deadline is required before carrier creation');
    return;
  }
  if (typeof deadline !== 'number' || !Number.isSafeInteger(deadline)) throw new ValidationError('Invalid explicit shipment operation deadline');
  if (deadline - Date.now() < MIN_CARRIER_COMPLETION_BUDGET_MS) {
    throw new SoftDeadlineError('Not enough time to complete carrier and Shopify safely; defer this whole order');
  }
}

function fulfillmentAuthority(order: ShopifyOrder, context: Record<string, unknown> | undefined,
  assertAllowed: () => Promise<void>): ExistingFulfillmentAuthority | undefined {
  const manual = context?.manualRunAuthorization as ManualShipmentAuthorization | undefined;
  const admin = context?.adminShipmentAuthorization as AdminShipmentAuthorization | undefined;
  if (!manual && !admin) return undefined;
  return { manual, admin, binding: admin?.binding ?? bindManualShipment(order), assertOperationAllowed: assertAllowed };
}

export class ShopifyOrderProcessor {
  constructor(
    private readonly accurateClient: AccurateClient,
    private readonly accurateMapper: AccurateMapper,
    private readonly odooSyncService?: OdooSyncService
  ) {}

  async process(
    order: ShopifyOrder,
    context?: Record<string, unknown> & { skipEligibility?: boolean; requireTelegraphLocation?: boolean }
  ): Promise<ProcessResult> {
    const operation = context?.assertOperationAllowed;
    const source = context?.assertSourceUnchanged;
    const authorization = context?.manualRunAuthorization as ManualShipmentAuthorization | undefined;
    const adminAuthorization = context?.adminShipmentAuthorization as AdminShipmentAuthorization | undefined;
    if (authorization && adminAuthorization) throw new ValidationError('Ambiguous human shipment authority');
    if (process.env.PRODUCTION_PREVIEW_ONLY?.trim().toLowerCase() === 'true' && !authorization && !adminAuthorization) {
      throw new ValidationError('Held production requires an explicit current human Run authorization');
    }
    const assertAllowed = async (): Promise<void> => {
      if ((authorization || adminAuthorization) && (typeof operation !== 'function' || typeof source !== 'function')) {
        throw new ValidationError('Manual shipment requires lease and source fences');
      }
      if (typeof operation === 'function') await operation();
      if (typeof source === 'function') await source();
    };
    await assertAllowed();
    // Only an unlinked order may claim carrier creation. A linked repair uses a
    // DISTINCT fulfillment-only claim, never reopening the carrier claim.
    const linked = await shipmentRepository.findByShopifyOrderId(String(order.id));
    await assertAllowed();
    if (authorization && !linked?.accurateShipmentId && !linked?.accurateShipmentCode) {
      assertCarrierCompletionBudget(context);
      return await withManualShipmentClaim(String(order.id), authorization, assertAllowed,
        async claim => await this.processGuarded(order, context, assertAllowed, claim));
    }
    if (adminAuthorization && !linked?.accurateShipmentId && !linked?.accurateShipmentCode) {
      assertCarrierCompletionBudget(context);
      return await withAdminShipmentClaim(String(order.id), adminAuthorization, assertAllowed,
        async claim => await this.processGuarded(order, context, assertAllowed, claim));
    }
    return await this.processGuarded(order, context, assertAllowed);
  }

  private async processGuarded(
    order: ShopifyOrder,
    context: (Record<string, unknown> & { skipEligibility?: boolean; requireTelegraphLocation?: boolean }) | undefined,
    assertAllowed: () => Promise<void>,
    claim?: ManualShipmentClaim
  ): Promise<ProcessResult> {
    await assertAllowed();
    if (order.cancelled_at || order.test) return { skipped: true, reason: 'order-not-eligible' };
    const orderId = String(order.id);
    const existing = await shipmentRepository.findByShopifyOrderId(orderId);
    await assertAllowed();
    if (existing?.accurateShipmentId || existing?.accurateShipmentCode) {
      if (existing.odooSyncStatus === 'needs-review' || /OWNER_|STOCK_BALANCE|CARRIER_UNVERIFIED|PRIMARY_RECONCILIATION_READINESS_HOLD/.test(existing.lastError ?? '')) {
        throw new ValidationError('Existing shipment is held for manual review; no recreation or fulfillment is authorized');
      }
      const prefix = process.env.ORDER_REFERENCE_PREFIX?.trim();
      if (!prefix) throw new ValidationError('Shipment reference prefix is required');
      const existingShipment = await this.findExistingTelegraphShipment(
        existing.accurateShipmentId,
        existing.accurateShipmentCode,
        `${prefix}-${order.order_number}`
      );
      await assertAllowed();
      if (!existingShipment) {
        throw new ValidationError('Historical shipment is not currently verified; manual review required, NEVER recreate from missing visibility');
      } else {
        const authority = fulfillmentAuthority(order, context, assertAllowed);
        if (authority && !existingShipment.repairable) throw new ValidationError('Current carrier return/status evidence is not safe for fulfillment repair');
        const fulfillment = authority ? await reconcileExistingShipmentFulfillment({ order,
          shipment: { ...existingShipment, refNumber: `${prefix}-${order.order_number}` }, authority })
          : { skipped: true, reason: 'existing-shipment-preserved-no-source-write' };
        // A verified waybill is not authority to rearm accounting OR repair
        // Shopify. Null queue metadata is not proof that accounting never ran.
        // Missing fulfillment has a separate purpose-bound human/claim path;
        // never reopen the original shipment-creation claim to reach it.
        const odoo = {
          skipped: true,
          reason: 'existing-odoo-state-preserved',
          saleOrderName: existing.odooSaleOrderName ?? undefined,
          created: false
        };
        return {
          skipped: true,
          reason: fulfillment.skipped ? 'duplicate-order' : 'existing-shipment-fulfillment-repaired',
          // Surface the existing shipment code so a re-run can still
          // regenerate the waybill PDF for an already-shipped order.
          accurateShipmentCode: existing.accurateShipmentCode ?? undefined,
          accurateShipmentId: existing.accurateShipmentId ?? undefined,
          fulfillment,
          odoo,
        };
      }
    }

    if (!context?.skipEligibility && !isOrderEligibleForShipment(order)) {
      return { skipped: true, reason: 'order-not-eligible' };
    }

    if (existing?.odooSaleOrderId || existing?.odooInvoiceId || existing?.odooPaymentId || existing?.odooSalePaymentId || existing?.odooReturnBillId || existing?.odooReturnPaymentId || existing?.odooSyncStatus === 'needs-review') {
      throw new ValidationError('Existing accounting or held record has no verified waybill; manual review required');
    }
    const authority = fulfillmentAuthority(order, context, assertAllowed);
    assertCarrierCompletionBudget(context);
    await assertAllowed();
    await shipmentRepository.createPending(order);

    let recordedShipment: ExistingShipmentIdentity | undefined;
    try {
      const shipmentCode = await shipmentCodeService.reserveForOrder(orderId);
      await assertAllowed();
      const shipmentInput = await this.accurateMapper.mapOrderToShipment(order, {
        requireTelegraphLocation: context?.requireTelegraphLocation,
        shipmentCode
      });
      await assertAllowed();
      // Crash-safe idempotency: Telegraph may create a shipment but the HTTP
      // response can be lost before Neon records its id. On retry, recover the
      // shipment by the already-reserved code + exact Shopify reference instead
      // of allocating a second code and creating a duplicate shipment.
      let shipment = shipmentCode
        ? await this.findShipmentByPlannedCode(shipmentCode, shipmentInput.refNumber)
        : null;
      if (!shipment) {
        await assertAllowed();
        assertCarrierCompletionBudget(context);
        await claim?.beforeExternalAttempt();
        // Reserve admission was checked BEFORE persisting carrier intent. Do
        // not apply a second reserve threshold after intent: keep only the
        // native hard deadline/lease/source fences, or a CAS delay could strand
        // a falsely-attempted carrier operation without sending it.
        shipment = await this.saveShipmentSingleAttempt(shipmentInput, shipmentCode, assertAllowed);
      }

      if (!shipment) {
        throw new Error('Accurate saveShipment returned null');
      }

      await shipmentRepository.markCreated(orderId, {
        id: shipment.id,
        code: shipment.code,
        status: shipment.status?.code ?? shipment.status?.name ?? 'CREATED'
      });
      recordedShipment = { id: shipment.id, code: shipment.code, refNumber: shipmentInput.refNumber! };
      // Persist the no-Shopify-attempt boundary BEFORE the next lease/deadline
      // fence. An in-flight carrier result must survive a boundary interruption.
      const fulfillmentBoundaryId = authority ? await recordCreatedShipmentFulfillmentBoundary({
        orderId, shipment: recordedShipment, authority }) : undefined;
      await assertAllowed();

      logger.info('Shipment created successfully', {
        shopifyOrderId: orderId,
        accurateShipmentId: shipment.id,
        accurateShipmentCode: shipment.code
      });

      const fulfillment = await this.fulfillShopifyOrder(order, {
        shipmentId: shipment.id,
        shipmentCode: shipment.code,
        context,
        fulfillmentBoundaryId
      });
      if (fulfillment.skipped && fulfillment.reason !== 'already-fulfilled') {
        throw new ValidationError('Shopify fulfillment was not confirmed; existing shipment requires review');
      }

      // Queue Odoo processing asynchronously — do not block the button response.
      // The background cron (process-odoo-queue) picks this up every 5 minutes.
      await assertAllowed();
      await shipmentRepository.markOdooSoPending(orderId);
      const odoo: NonNullable<ProcessResult['odoo']> = { skipped: true, reason: 'queued-for-background' };

      return { skipped: false, accurateShipmentCode: shipment.code, accurateShipmentId: shipment.id, fulfillment, odoo };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown shipment creation error';
      if (recordedShipment) await noteExistingFulfillmentReview(orderId, recordedShipment);
      else await shipmentRepository.markFailed(orderId, message);
      await failedPayloadService.save({
        source: 'shopify-orders-create',
        externalId: orderId,
        reason: message,
        payload: order,
        headers: context
      });
      throw error;
    }
  }

  private async saveShipmentSingleAttempt(
    shipmentInput: Awaited<ReturnType<AccurateMapper['mapOrderToShipment']>>,
    initialShipmentCode?: string,
    assertAllowed: () => Promise<void> = async () => {}
  ) {
    const shipmentCode = initialShipmentCode;
      try {
        await assertAllowed();
        return await this.accurateClient.saveShipment({
          ...shipmentInput,
          code: shipmentCode
        });
      } catch (error) {
        if (!isDuplicateShipmentCodeError(error)) {
          throw error;
        }

        // A duplicate-code response can be the successful result of an earlier
        // request whose response was interrupted. Reconcile only the same code.
        if (shipmentCode) {
          const recovered = await this.findShipmentByPlannedCode(shipmentCode, shipmentInput.refNumber);
          if (recovered) return recovered;
        }

        await assertAllowed();
        throw new ValidationError('Reserved shipment code has an unresolved collision; manual review required, no fresh code allocated');
      }
  }

  private async fulfillShopifyOrder(
    order: ShopifyOrder,
    params: {
      shipmentId?: number | null;
      shipmentCode?: string | null;
      context?: Record<string, unknown>;
      fulfillmentBoundaryId?: number;
    }
  ): Promise<{ skipped: boolean; reason?: string }> {
    let requestAttempted = false;
    try {
      const result = await shopifyFulfillmentClient.fulfillOrder({
        orderId: order.admin_graphql_api_id ?? order.id,
        trackingNumber: params.shipmentCode,
        trackingUrl: telegraphDashboardUrl(params.shipmentId),
        assertOperationAllowed: async () => {
          if (typeof params.context?.assertOperationAllowed === 'function') await params.context.assertOperationAllowed();
          if (typeof params.context?.assertSourceUnchanged === 'function') await params.context.assertSourceUnchanged();
        },
        beforeExternalAttempt: params.fulfillmentBoundaryId === undefined ? undefined : async () => {
          requestAttempted = true; // An ambiguous intent CAS must also remain held.
          await markCreatedShipmentFulfillmentAttempt(params.fulfillmentBoundaryId!);
        }
      });
      if (params.fulfillmentBoundaryId !== undefined) {
        await completeCreatedShipmentFulfillment(params.fulfillmentBoundaryId, order, {
          id: params.shipmentId!, code: params.shipmentCode!, refNumber: `Viola-${order.order_number}` });
      }

      logger.info('Shopify order fulfillment synced', {
        shopifyOrderId: String(order.id),
        skipped: result.skipped,
        reason: result.reason,
        fulfillmentIds: result.fulfillmentIds
      });

      return { skipped: result.skipped, reason: result.reason };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Shopify fulfillment error';
      logger.error('Failed to fulfill Shopify order after Telegraph shipment creation', {
        shopifyOrderId: String(order.id),
        reason: message
      });

      await failedPayloadService.save({
        source: 'shopify-fulfillment-create',
        externalId: String(order.id),
        reason: message,
        payload: {
          orderId: order.id,
          orderName: order.name,
          shipmentId: params.shipmentId,
          shipmentCode: params.shipmentCode,
          requestAttempted: params.fulfillmentBoundaryId === undefined ? undefined : requestAttempted,
          ...(params.fulfillmentBoundaryId !== undefined && !requestAttempted
            ? await existingFulfillmentBoundaryLink(params.fulfillmentBoundaryId, String(order.id), {
                id: params.shipmentId!, code: params.shipmentCode!, refNumber: `Viola-${order.order_number}` }) : {})
        },
        headers: params.context
      });

      // A saved carrier identity plus missing/unknown Shopify fulfillment is NOT
      // successful shipping. Preserve identity and let native review handling run.
      throw new ValidationError(`Shopify fulfillment requires review after carrier creation: ${message}`);
    }
  }

  private async findExistingTelegraphShipment(
    shipmentId?: number | null,
    shipmentCode?: string | null,
    expectedReference?: string
  ): Promise<{ id: number; code: string; repairable: boolean } | null> {
    const identity = (shipment: NonNullable<Awaited<ReturnType<AccurateClient['getShipment']>>>) => ({
      id: shipment.id, code: shipment.code, repairable: shipment.cancelled === false && !shipment.returnStatus?.code && !shipment.returnStatus?.name &&
        ['PKR', 'PKM', 'BMT', 'OTD', 'DEX', 'HTR', 'DTR'].includes(shipment.status?.code ?? '')
    });
    try {
      const shipment = await this.accurateClient.getShipment({
        ...(shipmentId ? { id: shipmentId } : {}),
        ...(!shipmentId && shipmentCode ? { code: shipmentCode } : {})
      });
      if (!shipment || (shipmentId && shipment.id !== shipmentId) || (shipmentCode && shipment.code !== shipmentCode) || !expectedReference || shipment.refNumber !== expectedReference) return null;
      return identity(shipment);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown Telegraph shipment lookup error';
      if (/not found|404|cannot query field|does not exist|no shipment/i.test(message)) {
        return null;
      }
      // Lack of direct-read permission is not proof of existence or deletion.
      // Verify exact ID/code/reference through the permitted list endpoint.
      if (error instanceof UnauthorizedError && shipmentId && shipmentCode) {
        const listed = await this.accurateClient.listShipments({ id: [shipmentId] }, 20, 1);
        const match = listed.data.find(s => s.id === shipmentId && s.code === shipmentCode && s.refNumber === expectedReference);
        return match ? identity(match) : null;
      }
      throw error;
    }
  }

  private async findShipmentByPlannedCode(
    shipmentCode: string,
    expectedReference?: string
  ): Promise<{ id: number; code: string; refNumber?: string | null; status?: { code?: string | null; name?: string | null } | null } | null> {
    let shipment: Awaited<ReturnType<AccurateClient['getShipment']>>;
    try {
      shipment = await this.accurateClient.getShipment({ code: shipmentCode });
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
      const list = await this.accurateClient.listShipments({ search: shipmentCode }, 20, 1);
      shipment = (list.data ?? []).find((candidate) => candidate.code === shipmentCode) ?? null;
    }

    if (!shipment) return null;
    // Never adopt somebody else's shipment merely because a code collided.
    if (shipment.code !== shipmentCode || !expectedReference || shipment.refNumber !== expectedReference) return null;
    logger.warn('Recovered previously-created Telegraph shipment by planned code', {
      shipmentCode,
      expectedReference,
      accurateShipmentId: shipment.id
    });
    return shipment;
  }

}

