import { prisma } from '../lib/prisma.js';
import type { ShopifyOrder } from '../types/shopify.js';
import { isOrderEligibleForShipment } from './orderEligibility.js';
import { PermanentProductionError } from './productionPipelineErrors.js';

export interface PreviewShipmentIdentity {
  orderName: string;
  shopifyOrderId: string;
}
export type PreviewShipmentScope = readonly PreviewShipmentIdentity[];
interface Blocker { orderName: string; reason: string; waybill?: string }

/** A review stop, never permission to filter already-built Word/laser output. */
export class PreviewShipmentExclusionError extends PermanentProductionError {
  readonly code = 'PREVIEW_SHIPMENT_EXCLUSION';
  constructor(readonly blockers: readonly Blocker[]) {
    const details = blockers.map(b => `${b.orderName}${b.waybill ? ` (${b.waybill})` : ''}: ${b.reason}`).join('؛ ');
    super(`تم إيقاف Preview قبل إرسال ملفات إنتاج مكررة: ${details}. ` +
      'راجع الشحنة وShopify fulfillment/الدفع أولًا، ثم اطلب Preview جديدًا؛ لن نحذف منتجات من الملف أو نكرر الشحن. [PREVIEW_SHIPMENT_EXCLUSION]');
    this.name = 'PreviewShipmentExclusionError';
  }
}

function stop(scope: readonly { orderName: string }[], reason: string): never {
  throw new PreviewShipmentExclusionError(scope.map(({ orderName }) => ({ orderName, reason })));
}

/** All order names come from ordersDetail, not just the customized entry subset. */
export function previewShipmentScope(
  orderNumbers: readonly string[],
  hints: readonly { orderName: unknown; shopifyOrderId: unknown }[]
): PreviewShipmentScope {
  if (!Array.isArray(orderNumbers) || !orderNumbers.length || orderNumbers.length > 2000 ||
      orderNumbers.some(n => typeof n !== 'string' || !/^#[1-9]\d*$/.test(n)) ||
      new Set(orderNumbers).size !== orderNumbers.length) {
    throw new PreviewShipmentExclusionError([{ orderName: 'Batch', reason: 'قائمة الأوردرات غير مكتملة أو ملتبسة' }]);
  }
  const names = new Set(orderNumbers), ids = new Map<string, Set<string>>();
  for (const hint of hints) {
    if (!hint || typeof hint.orderName !== 'string' || !names.has(hint.orderName) ||
        typeof hint.shopifyOrderId !== 'string') stop(orderNumbers.map(orderName => ({ orderName })), 'هوية مصدر الإنتاج ملتبسة');
    const id = hint.shopifyOrderId.match(/^(?:gid:\/\/shopify\/Order\/)?([1-9]\d*)$/)?.[1];
    if (!id) stop([{ orderName: hint.orderName }], 'هوية Shopify غير صالحة');
    const found = ids.get(hint.orderName) ?? new Set<string>();
    found.add(id); ids.set(hint.orderName, found);
  }
  const scope = orderNumbers.map(orderName => {
    const found = ids.get(orderName);
    if (!found || found.size !== 1) stop([{ orderName }], 'تعذّر إثبات هوية Shopify كاملة وفريدة');
    return { orderName, shopifyOrderId: [...found][0]! };
  });
  if (new Set(scope.map(x => x.shopifyOrderId)).size !== scope.length) stop(scope, 'هوية Shopify مشتركة بين أوردرات مختلفة');
  return Object.freeze(scope.map(item => Object.freeze(item)));
}

/** Read-only, primary first. Re-run immediately before each externally visible
 * artifact boundary; a cached absence must not authorize a later send. No locks,
 * updates, historical replay, claim expiry, or automatic rearming occur here. */
export async function assertPreviewPrimaryShipmentExclusion(scope: PreviewShipmentScope): Promise<void> {
  previewShipmentScope(scope.map(x => x.orderName), scope);
  const names = scope.map(x => x.orderName), ids = scope.map(x => x.shopifyOrderId);
  const byId = new Map(scope.map(x => [x.shopifyOrderId, x]));
  const rows = await prisma.shipmentRecord.findMany({
    where: { OR: [{ shopifyOrderId: { in: ids } }, { shopifyOrderName: { in: names } },
      { shopifyOrderNumber: { in: names.map(n => n.slice(1)) } }] },
    select: { shopifyOrderId: true, shopifyOrderName: true, shopifyOrderNumber: true,
      plannedShipmentCode: true, accurateShipmentId: true, accurateShipmentCode: true },
    take: scope.length + 1,
  });
  if (!Array.isArray(rows) || rows.length > scope.length) stop(scope, 'قراءة الشحنات الأساسية غير مكتملة أو ملتبسة');
  const blockers: Blocker[] = [], seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') stop(scope, 'قراءة سجل الشحن الأساسي غير صالحة');
    const item = byId.get(row.shopifyOrderId);
    if (!item || seen.has(row.shopifyOrderId) || row.shopifyOrderNumber !== item.orderName.slice(1) ||
        (row.shopifyOrderName !== null && row.shopifyOrderName !== item.orderName)) stop(scope, 'تعارض هوية في سجل الشحن الأساسي');
    seen.add(row.shopifyOrderId);
    const values = [row.plannedShipmentCode, row.accurateShipmentCode];
    const malformed = values.some(v => v !== null && (typeof v !== 'string' || !/^[A-Za-z0-9_-]+$/.test(v))) ||
      (row.accurateShipmentId !== null && (!Number.isSafeInteger(row.accurateShipmentId) || row.accurateShipmentId <= 0));
    if (malformed) blockers.push({ orderName: item.orderName, reason: 'هوية شحنة غير صالحة؛ مراجعة مطلوبة' });
    else if (row.plannedShipmentCode !== null || row.accurateShipmentCode !== null || row.accurateShipmentId !== null) {
      blockers.push({ orderName: item.orderName, waybill: row.accurateShipmentCode ?? row.plannedShipmentCode ?? undefined,
        reason: row.accurateShipmentId !== null || row.accurateShipmentCode !== null ? 'بوليصة موجودة بالفعل' : 'رقم بوليصة محجوز بالفعل' });
    }
  }
  if (blockers.length) throw new PreviewShipmentExclusionError(blockers);

  const limit = scope.length * 8;
  const attempts = await prisma.failedPayload.findMany({
    where: { OR: [{ source: 'manual_shipment_claim', reason: { in: ids } },
      { source: { in: ['shopify-orders-create', 'shopify-fulfillment-create'] }, externalId: { in: ids } }] },
    select: { source: true, reason: true, externalId: true, payloadJson: true }, take: limit + 1,
  });
  if (!Array.isArray(attempts) || attempts.length > limit) stop(scope, 'سجل محاولات الشحن غير مكتمل؛ مراجعة مطلوبة');
  for (const row of attempts) {
    if (!row || typeof row !== 'object') stop(scope, 'قراءة محاولة الشحن السابقة غير صالحة');
    const item = byId.get(row.source === 'manual_shipment_claim' ? row.reason : row.externalId ?? '');
    if (!item) stop(scope, 'هوية محاولة شحن سابقة غير معروفة');
    let provenNoAttempt = false;
    if (row.source === 'manual_shipment_claim') {
      try {
        const p = JSON.parse(row.payloadJson) as Record<string, unknown>;
        provenNoAttempt = p !== null && !Array.isArray(p) && p.version === 1 && p.orderId === item.shopifyOrderId &&
          p.status === 'no-external-attempt' && p.requestAttempted === false &&
          typeof p.token === 'string' && Boolean(p.token) && typeof p.authorization === 'object' &&
          p.authorization !== null && !Array.isArray(p.authorization) &&
          typeof p.at === 'string' && Number.isFinite(Date.parse(p.at)) &&
          typeof p.stoppedAt === 'string' && Number.isFinite(Date.parse(p.stoppedAt));
      } catch { /* Malformed is unknown, never evidence of no carrier attempt. */ }
    }
    if (!provenNoAttempt) blockers.push({ orderName: item.orderName, reason: 'محاولة شحن سابقة غير محسومة؛ راجع البوليصة وfulfillment' });
  }
  if (blockers.length) throw new PreviewShipmentExclusionError(blockers);
}

/** Reuse the already fetched complete Shopify list. A saved Preview must receive
 * a fresh list on every invocation; old bindings are not current financial proof.
 * Missing/refunded/unknown sources never become a smaller filtered batch. */
export function assertPreviewFinancialSource(scope: PreviewShipmentScope, orders: readonly ShopifyOrder[]): void {
  previewShipmentScope(scope.map(x => x.orderName), scope);
  if (!Array.isArray(orders) || orders.some(o => !o || typeof o !== 'object' ||
      typeof o.name !== 'string' || !Number.isSafeInteger(o.id) || o.id <= 0 ||
      (o.payment_gateway_names !== undefined && (!Array.isArray(o.payment_gateway_names) ||
        o.payment_gateway_names.some((g: unknown) => typeof g !== 'string'))) ||
      (o.gateway !== undefined && o.gateway !== null && typeof o.gateway !== 'string'))) {
    stop(scope, 'مصدر Shopify الحالي غير متاح أو غير صالح');
  }
  const blockers: Blocker[] = [];
  for (const item of scope) {
    const matches = orders.filter(o => o.name === item.orderName || String(o.id) === item.shopifyOrderId);
    const order = matches[0];
    if (matches.length !== 1 || !order || order.name !== item.orderName || String(order.id) !== item.shopifyOrderId) {
      blockers.push({ orderName: item.orderName, reason: 'الأوردر غير متاح بهوية فريدة في مصدر Shopify الحالي' });
      continue;
    }
    const financial = typeof order.financial_status === 'string' ? order.financial_status.trim().toLowerCase() : '';
    const optional = order as ShopifyOrder & { refunds?: unknown; transactions?: unknown };
    let reason: string | undefined;
    if (order.cancelled_at) reason = 'الأوردر ملغى حاليًا';
    else if (financial === 'refunded' || financial === 'partially_refunded') reason = `حالة الدفع ${financial}؛ مراجعة الاسترداد مطلوبة`;
    else if (Object.hasOwn(optional, 'refunds') && (!Array.isArray(optional.refunds) || optional.refunds.length > 0)) {
      reason = 'سجل استرداد موجود أو غير محسوم؛ مراجعة مطلوبة';
    } else if (Object.hasOwn(optional, 'transactions') && (!Array.isArray(optional.transactions) ||
        optional.transactions.some(t => !t || typeof t !== 'object' ||
          String((t as { kind?: unknown }).kind ?? '').toUpperCase() === 'REFUND'))) {
      reason = 'معاملة استرداد موجودة أو سجل معاملات غير صالح؛ مراجعة مطلوبة';
    }
    else if (!financial || !isOrderEligibleForShipment(order)) reason = `الأوردر غير مؤهل للشحن/الدفع (${financial || 'unknown'})`;
    if (reason) blockers.push({ orderName: item.orderName, reason });
  }
  if (blockers.length) throw new PreviewShipmentExclusionError(blockers);
}
