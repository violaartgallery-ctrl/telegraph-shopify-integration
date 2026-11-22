/** Display-only exceptions to the operational hold. GET alone is NOT safe:
 * historical Shopify action URLs can create shipments or accounting records. */
const READ_PATHS = new Set(['/orders', '/orders/', '/api/orders', '/api/orders/', '/api/operations/dashboard']);
const ACTION_PATHS = new Set([
  '/orders/make-telegraph', '/orders/make-telegraph/bulk',
  '/orders/create-odoo-sales-order', '/orders/create-odoo-sales-order/bulk',
]);
const readMethod = (method: string): boolean => method === 'GET' || method === 'HEAD';

/** Independent human Shopify permission, never a general worker release. */
export function adminManualShippingEnabled(): boolean {
  return process.env.SHOPIFY_MANUAL_SHIPPING_ENABLED?.trim().toLowerCase() === 'true' &&
    /^[A-Za-z0-9_-]{16,80}$/.test(process.env.SHOPIFY_MANUAL_SHIPPING_EPOCH?.trim() ?? '') &&
    process.env.SHOPIFY_SHOP_DOMAIN === 'violaleather.myshopify.com' &&
    process.env.ORDER_REFERENCE_PREFIX === 'Viola' && process.env.SHIPMENT_CODE_PREFIX === 'VI';
}

export function heldAdminManualShippingRequest(method: string, path: string): boolean {
  const clean = path.endsWith('/') ? path.slice(0, -1) : path;
  return adminManualShippingEnabled() && (
    (readMethod(method) && ['/orders/make-telegraph', '/orders/make-telegraph/bulk'].includes(clean)) ||
    (method === 'POST' && clean === '/orders/make-telegraph/confirm')
  );
}

/** One authenticated human-requested advisory endpoint, never a worker bypass. */
export function heldAdminLocationSuggestionRequest(method:string,path:string):boolean {
  return adminManualShippingEnabled()&&method==='POST'&&path==='/api/orders/location-suggestion';
}

/** Exact authenticated decision endpoints only; never a general financial bypass. */
export function heldAdminOperationsReviewRequest(method:string,path:string):boolean {
  return adminManualShippingEnabled()&&method==='POST'&&['/api/operations/review/prepare','/api/operations/review/decide'].includes(path);
}

export function heldLegacyActionNotice(method: string, path: string): boolean {
  return readMethod(method) && ACTION_PATHS.has(path.endsWith('/') ? path.slice(0, -1) : path);
}

export function heldAdminDisplayRequest(method: string, path: string): boolean {
  return readMethod(method) && (READ_PATHS.has(path) || heldLegacyActionNotice(method, path));
}

export function renderHeldAdminNotice(capability?: string): string {
  const link = '/orders' + (capability ? '?adminToken=' + encodeURIComponent(capability) : '');
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Viola — العرض الآمن</title></head><body style="font-family:Arial,sans-serif;background:#f6f8f6;color:#21382c;padding:32px;line-height:1.8"><main style="max-width:720px;margin:auto;background:white;padding:28px;border:1px solid #dbe5de;border-radius:12px"><h1>هذا الإجراء متوقف لحماية الأوردرات</h1><p>يمكنك عرض الأوردرات وحالتها، لكن روابط الشحن والمحاسبة القديمة لن تنشئ أي مستند. التشغيل اليدوي المسموح يكون من تيليجرام بموافقة جديدة، مع حمايات منع التكرار ومراجعة البيانات.</p><p><a href="${link}" style="color:#166347;font-weight:bold">افتح عرض الأوردرات الآمن</a></p><p>لم يتم إنشاء بوليصة أو Sales Order أو فاتورة أو دفعة بفتح هذه الصفحة.</p></main></body></html>`;
}
