import express from 'express';
import type { Request, Response } from 'express';
import { AccurateClient } from '../accurate/accurateClient.js';
import { isOrderEligibleForShipment } from '../services/orderEligibility.js';
import { shipmentRepository } from '../services/shipmentRepository.js';
import { ShopifyOrderProcessor } from '../services/shopifyOrderProcessor.js';
import { getTelegraphLocationSelection, withTelegraphLocationSelection } from '../services/telegraphLocation.js';
import { shopifyOrdersClient } from '../shopify/shopifyOrdersClient.js';
import { OdooSyncService } from '../odoo/odooSyncService.js';
import { ShipmentStatusSyncService } from '../services/shipmentStatusSyncService.js';
import { ValidationError } from '../lib/errors.js';

interface ZoneEntry {
  id: number;
  code?: string | null;
  name: string;
}

let locationCache: { expiresAt: number; data: Array<ZoneEntry & { subzones: ZoneEntry[] }> } | undefined;

const escapeHtml = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const extractAdminToken = (request: Request): string =>
  typeof request.query.adminToken === 'string' ? request.query.adminToken : '';

const adminPath = (path: string, adminToken?: string): string => {
  if (!adminToken) return path;
  return `${path}${path.includes('?') ? '&' : '?'}adminToken=${encodeURIComponent(adminToken)}`;
};

const adminHiddenInput = (adminToken?: string): string =>
  adminToken ? `<input type="hidden" name="adminToken" value="${escapeHtml(adminToken)}" />` : '';

const renderAdminScriptContext = (adminToken?: string): string => `
      const adminToken = ${JSON.stringify(adminToken ?? '')};
      const adminHeaders = adminToken ? { 'x-admin-secret': adminToken } : {};
      const adminUrl = (path) => adminToken
        ? path + (path.includes('?') ? '&' : '?') + 'adminToken=' + encodeURIComponent(adminToken)
        : path;
`;

const renderAppShell = (adminToken?: string): string => `<!doctype html>
<html lang="ar" dir="rtl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Viola — Telegraph Shipments</title>
    <style>
      :root {
        color-scheme: light;
        --ink: #202223; --muted: #6d7175; --line: #dfe3e8; --soft: #f6f6f7;
        --brand: #0b6b5d; --danger: #b42318;
        --c-complete: #166534; --bg-complete: #dcfce7;
        --c-processing: #1e40af; --bg-processing: #dbeafe;
        --c-pending: #854d0e; --bg-pending: #fef9c3;
        --c-retry: #9a3412; --bg-retry: #ffedd5;
        --c-failed: #b42318; --bg-failed: #fee2e2;
        --c-muted: #374151; --bg-muted: #f3f4f6;
      }
      *, *::before, *::after { box-sizing: border-box; }
      body { margin:0; font-family: Arial, sans-serif; font-size:14px; color:var(--ink); background:#f9fafb; }
      main { max-width:1280px; margin:0 auto; padding:24px 16px 60px; }
      header { display:flex; gap:16px; align-items:center; justify-content:space-between; margin-bottom:20px; flex-wrap:wrap; }
      h1 { font-size:24px; margin:0; }
      h2 { font-size:17px; margin:0 0 14px; }
      .muted { color:var(--muted); font-size:13px; }
      .toolbar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
      button, a.button { border:1px solid var(--line); background:#fff; color:var(--ink); border-radius:6px; min-height:36px; padding:6px 12px; font-weight:700; font-size:13px; cursor:pointer; text-decoration:none; }
      button.primary { background:var(--brand); border-color:var(--brand); color:#fff; }
      button:disabled { cursor:not-allowed; opacity:.5; }
      section { background:#fff; border:1px solid var(--line); border-radius:8px; padding:20px; margin-top:20px; }
      table { width:100%; border-collapse:collapse; }
      th, td { padding:10px 12px; border-bottom:1px solid var(--line); text-align:right; vertical-align:top; font-size:13px; }
      th { background:var(--soft); font-size:12px; color:var(--muted); font-weight:700; white-space:nowrap; }
      tr:last-child td { border-bottom:0; }
      .stack { display:grid; gap:3px; }
      .locations { max-height:340px; overflow:auto; border:1px solid var(--line); border-radius:6px; padding:12px; }
      details { border-bottom:1px solid var(--line); padding:6px 0; }
      details:last-child { border-bottom:0; }
      summary { cursor:pointer; font-weight:700; font-size:13px; }
      .subzones { display:flex; gap:6px; flex-wrap:wrap; padding:6px 0 2px; }
      .toast { min-height:20px; font-weight:700; font-size:13px; margin-bottom:4px; }

      /* ── Summary cards ─────────────────────────────────── */
      .summary-grid { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:16px; }
      .summary-card {
        flex:1; min-width:110px; max-width:180px;
        border:1px solid var(--line); border-radius:8px;
        padding:14px 16px; background:#fff; text-align:center;
      }
      .summary-card .card-count { font-size:26px; font-weight:700; line-height:1.1; }
      .summary-card .card-label { font-size:12px; color:var(--muted); margin-top:4px; }
      .summary-card.complete  { border-color:var(--bg-complete);  background:#f0fdf4; }
      .summary-card.complete  .card-count { color:var(--c-complete); }
      .summary-card.processing{ border-color:#bfdbfe; background:#eff6ff; }
      .summary-card.processing .card-count { color:var(--c-processing); }
      .summary-card.pending   { border-color:#fde68a; background:#fefce8; }
      .summary-card.pending   .card-count { color:var(--c-pending); }
      .summary-card.retry     { border-color:#fed7aa; background:#fff7ed; }
      .summary-card.retry     .card-count { color:var(--c-retry); }
      .summary-card.failed    { border-color:#fecaca; background:#fff5f5; }
      .summary-card.failed    .card-count { color:var(--c-failed); }
      .summary-card.muted-card { border-color:var(--line); }
      .summary-card.muted-card .card-count { color:var(--muted); }

      /* ── Status badges ─────────────────────────────────── */
      .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:700; white-space:nowrap; }
      .badge.ok, .badge.status-complete   { background:var(--bg-complete);   color:var(--c-complete); }
      .badge.status-processing             { background:var(--bg-processing); color:var(--c-processing); }
      .badge.status-pending                { background:var(--bg-pending);    color:var(--c-pending); }
      .badge.warn, .badge.status-retry    { background:var(--bg-retry);      color:var(--c-retry); }
      .badge.fail, .badge.status-failed   { background:var(--bg-failed);     color:var(--c-failed); }
      .badge.status-muted                  { background:var(--bg-muted);      color:var(--c-muted); }

      /* ── Error text ────────────────────────────────────── */
      .error-text {
        display:block; max-width:200px; overflow:hidden;
        text-overflow:ellipsis; white-space:nowrap;
        color:var(--c-failed); font-size:11px; cursor:help;
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>🚚 Viola — Telegraph Shipments</h1>
          <div class="muted">إنشاء بوالص Accurate يدويًا ومتابعة حالة Odoo في الخلفية</div>
        </div>
        <div class="toolbar">
          <button id="refresh" type="button">🔄 تحديث الأوردرات</button>
          <button id="locations-refresh" type="button">📍 تحديث المناطق</button>
        </div>
      </header>
      <div id="toast" class="toast"></div>
      <section>
        <h2>الأوردرات الأخيرة</h2>
        <div id="summary-cards" class="summary-grid"></div>
        <div id="orders">جاري التحميل...</div>
      </section>
      <section>
        <h2>مناطق Accurate</h2>
        <p class="muted">المحافظات والمناطق مباشرةً من Accurate بنفس ترتيب الـ dropdown.</p>
        <div id="locations" class="locations">جاري التحميل...</div>
      </section>
    </main>
    <script>
      ${renderAdminScriptContext(adminToken)}

      // ── Utilities ──────────────────────────────────────────────────────────
      const toast = document.getElementById('toast');
      const setToast = (message, error = false) => {
        toast.textContent = message || '';
        toast.style.color = error ? '#b42318' : '#0b6b5d';
      };
      const html = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

      // ── Odoo status → Arabic label ─────────────────────────────────────────
      const ODOO_LABELS = {
        'odoo-so-pending':          'في انتظار إنشاء Sales Order',
        'odoo-so-creating':         'جاري إنشاء Sales Order',
        'odoo-stock-pending':       'في انتظار التصنيع والمخزون',
        'odoo-stock-preparing':     'جاري التصنيع والمخزون',
        'odoo-delivery-pending':    'في انتظار تأكيد الدليفري',
        'odoo-delivery-confirming': 'جاري تأكيد الدليفري',
        'delivery-confirmed':       'مكتمل ✅',
        'odoo-failed-retryable':    'فشل — سيُعاد تلقائياً',
        'failed':                   'فشل نهائي ⛔',
      };
      const odooLabel = (status) => ODOO_LABELS[status] ?? status ?? 'لم يبدأ';

      // ── Status → badge CSS class ───────────────────────────────────────────
      const odooBadgeClass = (status) => {
        if (!status) return 'status-muted';
        if (status === 'delivery-confirmed') return 'status-complete';
        if (['odoo-so-creating','odoo-stock-preparing','odoo-delivery-confirming'].includes(status)) return 'status-processing';
        if (['odoo-so-pending','odoo-stock-pending','odoo-delivery-pending'].includes(status)) return 'status-pending';
        if (status === 'odoo-failed-retryable') return 'status-retry';
        if (status === 'failed') return 'status-failed';
        return 'status-muted';
      };
      const shipmentBadgeClass = (status) => {
        if (!status) return 'status-muted';
        if (/delivered|created/i.test(status)) return 'ok';
        if (/failed|cancel/i.test(status)) return 'fail';
        return 'warn';
      };

      // ── Clean RETRY_FROM prefix from error text ────────────────────────────
      const cleanError = (err) => err ? err.replace(/^RETRY_FROM:[^|]+\|/, '') : '';

      // ── Format retry time ──────────────────────────────────────────────────
      const formatRetryAt = (iso) => {
        if (!iso) return '';
        const d = new Date(iso);
        const now = new Date();
        const diffMin = Math.round((d - now) / 60000);
        if (diffMin <= 0) return 'الآن';
        if (diffMin < 60) return 'بعد ' + diffMin + ' د';
        return 'بعد ' + Math.round(diffMin/60) + ' س';
      };

      // ── Build summary cards ────────────────────────────────────────────────
      function renderSummaryCards(orders) {
        const counts = { complete:0, processing:0, pending:0, retry:0, failed:0, none:0 };
        for (const o of orders) {
          const s = o.odooSyncStatus;
          if (s === 'delivery-confirmed') counts.complete++;
          else if (['odoo-so-creating','odoo-stock-preparing','odoo-delivery-confirming'].includes(s)) counts.processing++;
          else if (['odoo-so-pending','odoo-stock-pending','odoo-delivery-pending'].includes(s)) counts.pending++;
          else if (s === 'odoo-failed-retryable') counts.retry++;
          else if (s === 'failed') counts.failed++;
          else counts.none++;
        }
        return [
          { cls:'complete',   label:'مكتمل',         count: counts.complete },
          { cls:'processing', label:'جاري المعالجة', count: counts.processing },
          { cls:'pending',    label:'في الانتظار',   count: counts.pending },
          { cls:'retry',      label:'إعادة محاولة',  count: counts.retry },
          { cls:'failed',     label:'فشل نهائي',     count: counts.failed },
          { cls:'muted-card', label:'بدون Odoo',     count: counts.none },
        ].map((c) =>
          '<div class="summary-card ' + c.cls + '">' +
            '<div class="card-count">' + c.count + '</div>' +
            '<div class="card-label">' + c.label + '</div>' +
          '</div>'
        ).join('');
      }

      // ── Build orders table ─────────────────────────────────────────────────
      function renderOrdersTable(orders) {
        if (!orders.length) return '<p class="muted">لا توجد أوردرات.</p>';
        return '<table><thead><tr>' +
          '<th>الأوردر</th><th>العميل</th><th>الدفع</th>' +
          '<th>بوليصة Telegraph</th>' +
          '<th>حالة Odoo</th><th>Sales Order</th>' +
          '<th>محاولات</th><th>إعادة المحاولة</th><th>آخر خطأ</th>' +
          '<th>إجراء</th>' +
        '</tr></thead><tbody>' +
        orders.map((o) => {
          const oodooErr = cleanError(o.odooLastError);
          return '<tr>' +
            '<td><div class="stack"><strong>' + html(o.name) + '</strong><span class="muted">' + html(String(o.id)) + '</span></div></td>' +
            '<td><div class="stack">' + html(o.customerName || '—') + '<span class="muted">' + html(o.phone || '—') + '</span></div></td>' +
            '<td><div class="stack">' + html(o.financialStatus || '—') + '<span class="muted">' + html(o.gateway || '—') + '</span></div></td>' +
            '<td><div class="stack">' +
              '<span class="badge ' + shipmentBadgeClass(o.shipmentStatus) + '">' + html(o.shipmentStatus || 'لم تُنشأ') + '</span>' +
              (o.shipmentCode ? '<span class="muted">' + html(o.shipmentCode) + '</span>' : '') +
            '</div></td>' +
            '<td><span class="badge ' + odooBadgeClass(o.odooSyncStatus) + '">' + html(odooLabel(o.odooSyncStatus)) + '</span></td>' +
            '<td>' + (o.odooSaleOrderName ? '<span class="muted">' + html(o.odooSaleOrderName) + '</span>' : '<span class="muted">—</span>') + '</td>' +
            '<td>' + (o.odooAttemptCount > 0 ? o.odooAttemptCount + '/5' : '—') + '</td>' +
            '<td>' + (o.odooRetryAt ? '<span class="muted" title="' + html(new Date(o.odooRetryAt).toLocaleString('ar')) + '">' + html(formatRetryAt(o.odooRetryAt)) + '</span>' : '—') + '</td>' +
            '<td>' + (oodooErr ? '<span class="error-text" title="' + html(oodooErr) + '">' + html(oodooErr.slice(0, 55)) + '</span>' : '—') + '</td>' +
            '<td><div class="stack">' +
              '<button class="primary" data-order-gid="' + html(o.gid) + '" ' + (o.shipmentCode ? 'disabled' : '') + '>📦 إنشاء بوليصة</button>' +
              '<button data-odoo-order-gid="' + html(o.gid) + '" ' + (o.odooSaleOrderName ? 'disabled' : '') + '>🔁 Odoo</button>' +
            '</div></td>' +
          '</tr>';
        }).join('') + '</tbody></table>';
      }

      // ── Load orders ────────────────────────────────────────────────────────
      async function loadOrders() {
        const target = document.getElementById('orders');
        const cardsEl = document.getElementById('summary-cards');
        target.textContent = 'جاري التحميل...';
        const response = await fetch(adminUrl('/api/orders'), { headers: adminHeaders });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Could not load orders');
        cardsEl.innerHTML = renderSummaryCards(data.orders);
        target.innerHTML = renderOrdersTable(data.orders);

        // Make Telegraph shipment button
        target.querySelectorAll('button[data-order-gid]').forEach((button) => {
          button.addEventListener('click', async () => {
            button.disabled = true;
            setToast('جاري إنشاء البوليصة...');
            try {
              const response = await fetch(adminUrl('/api/orders/create-shipment'), {
                method: 'POST',
                headers: { ...adminHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderGid: button.dataset.orderGid })
              });
              const payload = await response.json();
              if (!response.ok) throw new Error(payload.message || 'Could not create shipment');
              const odooMessage = payload.odoo?.saleOrderName
                ? ' Odoo Sales Order: ' + payload.odoo.saleOrderName + '.'
                : payload.odoo?.reason === 'queued-for-background'
                  ? ' Odoo قيد المعالجة في الخلفية.'
                  : payload.odoo?.reason === 'odoo-failed-needs-manual-retry'
                    ? ' Odoo فشل سابقًا — يحتاج Manual Retry من الـ Dashboard.'
                    : payload.odoo?.reason
                      ? ' Odoo: ' + payload.odoo.reason
                      : '';
              setToast((payload.skipped ? 'تخطي: ' + payload.reason : '✅ تم إنشاء البوليصة بنجاح.') + odooMessage);
              await loadOrders();
            } catch (error) {
              setToast(error.message, true);
              button.disabled = false;
            }
          });
        });

        // Retry Odoo button
        target.querySelectorAll('button[data-odoo-order-gid]').forEach((button) => {
          button.addEventListener('click', async () => {
            button.disabled = true;
            setToast('جاري إنشاء Odoo Sales Order...');
            try {
              const response = await fetch(adminUrl('/api/orders/create-odoo-sales-order'), {
                method: 'POST',
                headers: { ...adminHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderGid: button.dataset.odooOrderGid })
              });
              const payload = await response.json();
              if (!response.ok) throw new Error(payload.message || 'Could not create Odoo Sales Order');
              setToast(payload.created ? '✅ Odoo Sales Order: ' + payload.saleOrderName : 'موجود بالفعل: ' + payload.saleOrderName);
              await loadOrders();
            } catch (error) {
              setToast(error.message, true);
              button.disabled = false;
            }
          });
        });
      }

      // ── Load locations ─────────────────────────────────────────────────────
      async function loadLocations() {
        const target = document.getElementById('locations');
        target.textContent = 'جاري التحميل...';
        const response = await fetch(adminUrl('/api/accurate/locations'), { headers: adminHeaders });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Could not load locations');
        target.innerHTML = data.locations.map((zone) =>
          '<details><summary>' + html(zone.name) + ' <span class="muted">#' + html(zone.id) + '</span></summary>' +
          '<div class="subzones">' + zone.subzones.map((s) => '<span class="badge status-muted">' + html(s.name) + ' #' + html(s.id) + '</span>').join('') + '</div></details>'
        ).join('');
      }

      // ── Event listeners ────────────────────────────────────────────────────
      document.getElementById('refresh').addEventListener('click', () => loadOrders().catch((e) => setToast(e.message, true)));
      document.getElementById('locations-refresh').addEventListener('click', () => loadLocations().catch((e) => setToast(e.message, true)));
      loadOrders().catch((e) => setToast(e.message, true));
      loadLocations().catch((e) => setToast(e.message, true));
    </script>
  </body>
</html>`;

const summarizeOrder = async () => {
  const orders = await shopifyOrdersClient.listRecentOrders(50);
  const records = await shipmentRepository.findByShopifyOrderIds(orders.map((order) => String(order.id)));
  const recordsByOrderId = new Map(records.map((record) => [record.shopifyOrderId, record]));

  return orders.map((order) => {
    const record = recordsByOrderId.get(String(order.id));
    const address = order.shipping_address ?? order.billing_address;
    return {
      id: order.id,
      gid: order.admin_graphql_api_id,
      name: order.name,
      customerName: address?.name ?? [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' '),
      phone: address?.phone ?? order.phone ?? order.customer?.phone,
      city: address?.city,
      province: address?.province,
      financialStatus: order.financial_status,
      gateway: order.payment_gateway_names?.join(', '),
      eligible: isOrderEligibleForShipment(order),
      shipmentStatus: record?.accurateStatus,
      shipmentCode: record?.accurateShipmentCode,
      lastError: record?.lastError,
      odooSyncStatus: record?.odooSyncStatus,
      odooSaleOrderName: record?.odooSaleOrderName,
      odooInvoiceName: record?.odooInvoiceName,
      odooLastError: record?.odooLastError,
      // Queue tracking fields (added for V7 dashboard)
      odooAttemptCount: record?.odooAttemptCount ?? 0,
      odooRetryAt: record?.odooRetryAt ?? null,
      updatedAt: record?.updatedAt ?? null
    };
  });
};

export const getLocations = async (accurateClient: AccurateClient) => {
  if (locationCache && Date.now() < locationCache.expiresAt) {
    return locationCache.data;
  }

  const zones = await accurateClient.listZones({ active: true, parentId: null });
  const data = await Promise.all(
    zones.map(async (zone) => ({
      ...zone,
      subzones: await accurateClient.listZones({ active: true, parentId: zone.id })
    }))
  );

  locationCache = {
    expiresAt: Date.now() + 60 * 60_000,
    data
  };

  return data;
};

const extractOrderIdFromQuery = (request: Request): string | undefined => {
  const direct = request.query.id ?? request.query.order_id ?? request.query.orderId;
  const firstValue = Array.isArray(direct) ? direct[0] : direct;
  if (typeof firstValue === 'string' && firstValue.trim()) {
    return firstValue.trim();
  }

  const selected = request.query.selected;
  const selectedValue = Array.isArray(selected) ? selected[0] : selected;
  if (typeof selectedValue === 'string' && selectedValue.trim()) {
    return selectedValue.split(',')[0]?.trim();
  }

  return undefined;
};

const extractOrderIdsFromQuery = (request: Request): string[] => {
  const rawValues = [
    request.query.selected,
    request.query.ids,
    request.query.id,
    request.query.order_id,
    request.query.orderId
  ];
  const ids = new Set<string>();

  for (const rawValue of rawValues) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (typeof value !== 'string') continue;
      for (const entry of value.split(',')) {
        const trimmed = entry.trim();
        if (trimmed) ids.add(trimmed);
      }
    }
  }

  return [...ids];
};

const normalizeOrderIdForLookup = (orderId: string): { gid?: string; legacyId?: string } => {
  if (orderId.startsWith('gid://shopify/Order/')) {
    return { gid: orderId };
  }

  const numeric = orderId.match(/\d+/)?.[0];
  return numeric ? { legacyId: numeric } : {};
};

const getOrderByRawId = async (rawOrderId: string) => {
  const lookup = normalizeOrderIdForLookup(rawOrderId);
  return lookup.gid
    ? await shopifyOrdersClient.getOrderByGid(lookup.gid)
    : await shopifyOrdersClient.getOrderByLegacyId(lookup.legacyId as string);
};

const renderShipmentResult = (params: {
  title: string;
  message: string;
  orderName?: string;
  shipmentCode?: string | null;
  shipmentId?: number | null;
  odooSaleOrderName?: string | null;
  odooSaleOrderId?: number | null;
  telegraphDashboardUrl?: string | null;
  error?: boolean;
}): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(params.title)}</title>
    <style>
      body { margin:0; font-family: Arial, sans-serif; color:#202223; background:#f6f6f7; }
      main { max-width:680px; margin:0 auto; padding:40px 20px; }
      .panel { background:#fff; border:1px solid #dfe3e8; border-radius:8px; padding:24px; }
      h1 { margin:0 0 12px; font-size:26px; }
      p { line-height:1.5; }
      a { color:#0b6b5d; font-weight:700; }
      .ok { color:#166534; font-weight:700; }
      .error { color:#b42318; font-weight:700; }
      .meta { background:#f6f6f7; border-radius:6px; padding:12px; margin-top:16px; }
    </style>
  </head>
  <body>
    <main>
      <div class="panel">
        <h1>${escapeHtml(params.title)}</h1>
        <p class="${params.error ? 'error' : 'ok'}">${escapeHtml(params.message)}</p>
        <div class="meta">
          ${params.orderName ? `<div><strong>Shopify order:</strong> ${escapeHtml(params.orderName)}</div>` : ''}
          ${params.shipmentCode ? `<div><strong>Accurate shipment code:</strong> ${escapeHtml(params.shipmentCode)}</div>` : ''}
          ${params.shipmentId ? `<div><strong>Accurate shipment id:</strong> ${escapeHtml(params.shipmentId)}</div>` : ''}
          ${params.odooSaleOrderName ? `<div><strong>Odoo Sales Order:</strong> ${escapeHtml(params.odooSaleOrderName)}</div>` : ''}
          ${params.odooSaleOrderId ? `<div><strong>Odoo Sales Order id:</strong> ${escapeHtml(params.odooSaleOrderId)}</div>` : ''}
          ${params.telegraphDashboardUrl ? `<div><strong>Telegraph dashboard:</strong> <a href="${escapeHtml(params.telegraphDashboardUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(params.telegraphDashboardUrl)}</a></div>` : ''}
        </div>
      </div>
    </main>
  </body>
</html>`;

const renderLocationSelectionForm = (params: {
  orderId: string;
  orderName: string;
  locations: Array<ZoneEntry & { subzones: ZoneEntry[] }>;
  message?: string;
  adminToken?: string;
}): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Select Telegraph location</title>
    <style>
      body { margin:0; font-family: Arial, sans-serif; color:#202223; background:#f6f6f7; }
      main { max-width:680px; margin:0 auto; padding:40px 20px; }
      form { background:#fff; border:1px solid #dfe3e8; border-radius:8px; padding:24px; display:grid; gap:16px; }
      label { display:grid; gap:6px; font-weight:700; }
      input, button { min-height:42px; border:1px solid #c9cccf; border-radius:6px; padding:8px 10px; font:inherit; }
      button { background:#0b6b5d; color:white; border-color:#0b6b5d; font-weight:700; cursor:pointer; }
      button:disabled { cursor:not-allowed; opacity:.55; }
      .muted { color:#6d7175; }
      .error { color:#b42318; font-weight:700; }
      .field { display:grid; gap:8px; }
      .picker { border:1px solid #c9cccf; border-radius:6px; overflow:hidden; background:#fff; }
      .picker input { width:100%; box-sizing:border-box; border:0; border-bottom:1px solid #dfe3e8; border-radius:0; }
      .picker-list { max-height:220px; overflow:auto; display:grid; }
      .picker-option { border:0; border-bottom:1px solid #eef0f2; background:#fff; color:#202223; min-height:38px; text-align:left; padding:9px 10px; font-weight:600; }
      .picker-option:hover, .picker-option:focus { background:#f1f8f6; outline:0; }
      .picker-option.selected { background:#0b6b5d; color:#fff; }
      .picker-empty { padding:12px; color:#6d7175; }
    </style>
  </head>
  <body>
    <main>
      <form method="post" action="${escapeHtml(adminPath('/orders/make-telegraph/select', params.adminToken))}">
        <div>
          <h1>Select Telegraph location</h1>
          <p class="muted">Order ${escapeHtml(params.orderName)} is missing Telegraph governorate and area. Choose them to create the shipment safely.</p>
          ${params.message ? `<p class="error">${escapeHtml(params.message)}</p>` : ''}
        </div>
        <input type="hidden" name="orderId" value="${escapeHtml(params.orderId)}" />
        ${adminHiddenInput(params.adminToken)}
        <div class="field">
          <label for="telegraph-admin-governorate-search">Governorate</label>
          <div class="picker">
            <input id="telegraph-admin-governorate-search" type="search" autocomplete="off" placeholder="Type ق for القاهرة..." />
            <div id="telegraph-admin-governorate-list" class="picker-list"></div>
          </div>
        </div>
        <div class="field">
          <label for="telegraph-admin-area-search">Area</label>
          <div class="picker">
            <input id="telegraph-admin-area-search" type="search" autocomplete="off" placeholder="Select governorate first" disabled />
            <div id="telegraph-admin-area-list" class="picker-list"></div>
          </div>
        </div>
        <input type="hidden" name="governorateId" id="telegraph-admin-governorate" required />
        <input type="hidden" name="areaId" id="telegraph-admin-area" required />
        <input type="hidden" name="governorate" id="telegraph-admin-governorate-name" />
        <input type="hidden" name="area" id="telegraph-admin-area-name" />
        <button id="telegraph-admin-submit" type="submit" disabled>Create Telegraph shipment</button>
      </form>
    </main>
    <script>
      const locations = ${JSON.stringify(params.locations)};
      const governorate = document.getElementById('telegraph-admin-governorate');
      const area = document.getElementById('telegraph-admin-area');
      const governorateName = document.getElementById('telegraph-admin-governorate-name');
      const areaName = document.getElementById('telegraph-admin-area-name');
      const governorateSearch = document.getElementById('telegraph-admin-governorate-search');
      const areaSearch = document.getElementById('telegraph-admin-area-search');
      const governorateList = document.getElementById('telegraph-admin-governorate-list');
      const areaList = document.getElementById('telegraph-admin-area-list');
      const submit = document.getElementById('telegraph-admin-submit');
      const escapeText = (value) => String(value || '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

      const normalize = (value) => String(value || '')
        .toLowerCase()
        .replace(/[أإآا]/g, 'ا')
        .replace(/[ىي]/g, 'ي')
        .replace(/ة/g, 'ه')
        .replace(/[ًٌٍَُِّْـ]/g, '')
        .trim();
      const matches = (entry, query) => !query || normalize(entry.name).includes(normalize(query));
      const updateSubmit = () => {
        submit.disabled = !governorate.value || !area.value;
      };
      const buttonFor = (entry, isSelected, onClick) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'picker-option' + (isSelected ? ' selected' : '');
        button.textContent = entry.name;
        button.addEventListener('click', onClick);
        return button;
      };
      const renderList = (target, entries, query, selectedId, onSelect) => {
        target.innerHTML = '';
        const filtered = entries.filter((entry) => matches(entry, query));
        if (filtered.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'picker-empty';
          empty.textContent = 'No matching locations';
          target.appendChild(empty);
          return;
        }
        filtered.forEach((entry) => {
          target.appendChild(buttonFor(entry, String(entry.id) === String(selectedId), () => onSelect(entry)));
        });
      };
      const clearArea = () => {
        area.value = '';
        areaName.value = '';
        areaSearch.value = '';
        areaList.innerHTML = '<div class="picker-empty">Select governorate first</div>';
        updateSubmit();
      };
      const selectGovernorate = (entry) => {
        governorate.value = entry.id;
        governorateName.value = entry.name;
        governorateSearch.value = entry.name;
        areaSearch.disabled = false;
        areaSearch.placeholder = 'Type area name...';
        clearArea();
        renderGovernorates();
        renderAreas();
        areaSearch.focus();
      };
      const selectArea = (entry) => {
        area.value = entry.id;
        areaName.value = entry.name;
        areaSearch.value = entry.name;
        renderAreas();
        updateSubmit();
      };
      const selectedGovernorate = () => locations.find((entry) => String(entry.id) === String(governorate.value));
      const renderGovernorates = () => renderList(governorateList, locations, governorateSearch.value, governorate.value, selectGovernorate);
      const renderAreas = () => {
        const zone = selectedGovernorate();
        if (!zone) {
          clearArea();
          return;
        }
        renderList(areaList, zone.subzones || [], areaSearch.value, area.value, selectArea);
      };
      governorateSearch.addEventListener('input', () => {
        governorate.value = '';
        governorateName.value = '';
        areaSearch.disabled = true;
        areaSearch.placeholder = 'Select governorate first';
        clearArea();
        renderGovernorates();
      });
      areaSearch.addEventListener('input', () => {
        area.value = '';
        areaName.value = '';
        renderAreas();
        updateSubmit();
      });
      renderGovernorates();
      clearArea();
    </script>
  </body>
</html>`;

const renderBulkShipmentJsPage = (params: {
  rows: Array<{
    index: number;
    rawOrderId: string;
    orderName: string;
    customerName: string;
    status: 'pending' | 'already-created' | 'needs-location' | 'error';
    shipmentCode?: string | null;
    detail?: string;
    needsProcessing: boolean;
  }>;
  adminToken?: string;
}): string => {
  const pendingOrders = params.rows
    .filter((r) => r.needsProcessing)
    .map((r) => ({ index: r.index, rawId: r.rawOrderId }));

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Make Telegraph shipments</title>
    <style>
      body { margin:0; font-family: Arial, sans-serif; color:#202223; background:#f6f6f7; }
      main { max-width:980px; margin:0 auto; padding:40px 20px; }
      .panel { background:#fff; border:1px solid #dfe3e8; border-radius:8px; padding:24px; }
      h1 { margin:0 0 8px; font-size:26px; }
      p.sub { color:#6d7175; line-height:1.5; }
      table { width:100%; border-collapse:collapse; border:1px solid #dfe3e8; margin-top:18px; }
      th, td { padding:11px; border-bottom:1px solid #dfe3e8; text-align:left; vertical-align:top; }
      th { background:#f6f6f7; color:#6d7175; font-size:13px; }
      .badge { display:inline-block; padding:4px 8px; border-radius:999px; font-size:12px; font-weight:700; }
      .pending  { background:#f3f4f6; color:#374151; }
      .processing { background:#fff7ed; color:#9a3412; animation:pulse 1.2s infinite; }
      .created  { background:#e0f2fe; color:#075985; }
      .already-created { background:#f3f4f6; color:#374151; }
      .needs-location { background:#fff7ed; color:#9a3412; }
      .error    { background:#fee2e2; color:#b42318; }
      #status-bar { margin-top:14px; color:#6d7175; font-size:14px; }
      @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
    </style>
  </head>
  <body>
    <main>
      <div class="panel">
        <h1>Make Telegraph shipments</h1>
        <p class="sub">Creating shipments — please wait while each order is processed with Odoo.</p>
        <table>
          <thead><tr><th>Order</th><th>Customer</th><th>Status</th><th>Details</th><th>Shipment</th></tr></thead>
          <tbody>
            ${params.rows.map((row) => `
              <tr>
                <td>${escapeHtml(row.orderName)}</td>
                <td>${escapeHtml(row.customerName)}</td>
                <td><span id="badge-${row.index}" class="badge ${escapeHtml(row.status)}">${escapeHtml(row.status)}</span></td>
                <td id="detail-${row.index}">${escapeHtml(
                  row.status === 'already-created' ? 'Telegraph shipment already exists.' :
                  row.status === 'needs-location'  ? 'Telegraph city/area missing. Use the single-order button first.' :
                  row.status === 'error'            ? (row.detail ?? 'Could not read order.') :
                  'Waiting to process...'
                )}</td>
                <td id="code-${row.index}">${escapeHtml(row.shipmentCode ?? '')}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        <p id="status-bar">${pendingOrders.length === 0 ? 'No orders needed processing.' : 'Starting...'}</p>
      </div>
    </main>
    <script>
      const adminToken = ${JSON.stringify(params.adminToken ?? '')};
      const adminHeaders = adminToken ? { 'x-admin-secret': adminToken } : {};
      const adminUrl = (p) => adminToken ? p + (p.includes('?') ? '&' : '?') + 'adminToken=' + encodeURIComponent(adminToken) : p;
      const pendingOrders = ${JSON.stringify(pendingOrders)};

      function updateRow(idx, status, detail, code) {
        const b = document.getElementById('badge-' + idx);
        const d = document.getElementById('detail-' + idx);
        const c = document.getElementById('code-' + idx);
        if (b) { b.className = 'badge ' + status; b.textContent = status; }
        if (d) d.textContent = detail || '';
        if (c && code) c.textContent = code;
      }

      async function processOne(order) {
        const isGid = order.rawId.startsWith('gid://shopify/Order/');
        const body  = isGid ? { orderGid: order.rawId } : { orderId: order.rawId.replace(/\\D/g, '') };
        const MAX_RETRIES = 2;

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          const isRetry = attempt > 0;
          updateRow(order.index, 'processing',
            isRetry
              ? 'Retry ' + attempt + '/' + MAX_RETRIES + ' — picking up where we left off...'
              : 'Creating Telegraph shipment + Odoo record...'
          );
          try {
            const resp = await fetch(adminUrl('/api/orders/create-shipment'), {
              method: 'POST',
              headers: { ...adminHeaders, 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
            });
            // HTTP gateway timeouts — safe to retry
            if ((resp.status === 502 || resp.status === 503 || resp.status === 504) && attempt < MAX_RETRIES) {
              await new Promise(r => setTimeout(r, 2000));
              continue;
            }
            const result = await resp.json();
            // Netlify Lambda timeout returns HTTP 200 with { errorType: 'Sandbox.Timedout' }
            const isLambdaTimeout = result.errorType === 'Sandbox.Timedout'
              || (typeof result.errorMessage === 'string' && /timed? ?out/i.test(result.errorMessage));
            if (isLambdaTimeout && attempt < MAX_RETRIES) {
              await new Promise(r => setTimeout(r, 2000));
              continue;
            }
            if (!resp.ok || !result.ok) {
              const msg = result.message || result.errorMessage || ('Server error ' + resp.status);
              updateRow(order.index, 'error', msg);
            } else if (result.skipped) {
              updateRow(order.index, 'already-created', 'Shipment already exists.', result.shipmentCode);
            } else {
              const odooNote = result.odoo && !result.odoo.skipped ? ' | Odoo: ' + (result.odoo.saleOrderName || 'synced') : '';
              updateRow(order.index, 'created', 'Created successfully' + odooNote + '.', result.shipmentCode);
            }
            return; // success or non-retryable error — stop retrying
          } catch (e) {
            // Network error (e.g. connection reset by Netlify timeout)
            if (attempt < MAX_RETRIES) {
              await new Promise(r => setTimeout(r, 2000));
              continue;
            }
            updateRow(order.index, 'error', 'Network error: ' + (e.message || 'unknown'));
          }
        }
      }

      (async () => {
        if (!pendingOrders.length) return;
        const bar = document.getElementById('status-bar');
        for (let i = 0; i < pendingOrders.length; i++) {
          if (bar) bar.textContent = 'Processing ' + (i + 1) + ' of ' + pendingOrders.length + ' orders...';
          await processOne(pendingOrders[i]);
        }
        if (bar) bar.textContent = 'Done — ' + pendingOrders.length + ' order(s) processed.';
      })();
    </script>
  </body>
</html>`;
};

const renderBulkShipmentReview = (params: {
  title: string;
  orderIds: string[];
  rows: Array<{
    orderId: string;
    orderName?: string;
    customerName?: string;
    status: string;
    detail: string;
    shipmentCode?: string | null;
  }>;
  canExecute: boolean;
  executed?: boolean;
  adminToken?: string;
}): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(params.title)}</title>
    <style>
      body { margin:0; font-family: Arial, sans-serif; color:#202223; background:#f6f6f7; }
      main { max-width:980px; margin:0 auto; padding:40px 20px; }
      .panel { background:#fff; border:1px solid #dfe3e8; border-radius:8px; padding:24px; }
      h1 { margin:0 0 8px; font-size:26px; }
      p { color:#6d7175; line-height:1.5; }
      table { width:100%; border-collapse:collapse; border:1px solid #dfe3e8; margin-top:18px; }
      th, td { padding:11px; border-bottom:1px solid #dfe3e8; text-align:left; vertical-align:top; }
      th { background:#f6f6f7; color:#6d7175; font-size:13px; }
      .badge { display:inline-block; padding:4px 8px; border-radius:999px; font-size:12px; font-weight:700; }
      .ready { background:#dcfce7; color:#166534; }
      .warn { background:#fff7ed; color:#9a3412; }
      .done { background:#e0f2fe; color:#075985; }
      .error { background:#fee2e2; color:#b42318; }
      button { margin-top:18px; min-height:42px; border:1px solid #0b6b5d; border-radius:6px; padding:8px 14px; background:#0b6b5d; color:#fff; font-weight:700; cursor:pointer; }
      button:disabled { cursor:not-allowed; opacity:.55; }
      .hidden { display:none; }
    </style>
  </head>
  <body>
    <main>
      <div class="panel">
        <h1>${escapeHtml(params.title)}</h1>
        <p>${params.executed
          ? 'Bulk shipment action finished.'
          : 'Review selected orders before creating Telegraph shipments. Orders without Telegraph city and area will be skipped.'}</p>
        <table>
          <thead>
            <tr>
              <th>Order</th>
              <th>Customer</th>
              <th>Status</th>
              <th>Details</th>
              <th>Shipment</th>
            </tr>
          </thead>
          <tbody>
            ${params.rows.map((row) => `
              <tr>
                <td>${escapeHtml(row.orderName ?? row.orderId)}</td>
                <td>${escapeHtml(row.customerName ?? '')}</td>
                <td><span class="badge ${row.status === 'ready' ? 'ready' : row.status === 'created' ? 'done' : row.status === 'error' ? 'error' : 'warn'}">${escapeHtml(row.status)}</span></td>
                <td>${escapeHtml(row.detail)}</td>
                <td>${escapeHtml(row.shipmentCode ?? '')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        ${params.executed ? '' : `
          <form method="post" action="${escapeHtml(adminPath('/orders/make-telegraph/bulk', params.adminToken))}">
            ${adminHiddenInput(params.adminToken)}
            ${params.orderIds.map((orderId) => `<input class="hidden" type="hidden" name="orderIds" value="${escapeHtml(orderId)}" />`).join('')}
            <button type="submit" ${params.canExecute ? '' : 'disabled'}>Create ready Telegraph shipments</button>
          </form>
        `}
      </div>
    </main>
  </body>
</html>`;

const renderBulkOdooReview = (params: {
  title: string;
  orderIds: string[];
  rows: Array<{
    orderId: string;
    orderName?: string;
    customerName?: string;
    status: string;
    detail: string;
    saleOrderName?: string | null;
  }>;
  canExecute: boolean;
  executed?: boolean;
  adminToken?: string;
}): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(params.title)}</title>
    <style>
      body { margin:0; font-family: Arial, sans-serif; color:#202223; background:#f6f6f7; }
      main { max-width:980px; margin:0 auto; padding:40px 20px; }
      .panel { background:#fff; border:1px solid #dfe3e8; border-radius:8px; padding:24px; }
      h1 { margin:0 0 8px; font-size:26px; }
      p { color:#6d7175; line-height:1.5; }
      table { width:100%; border-collapse:collapse; border:1px solid #dfe3e8; margin-top:18px; }
      th, td { padding:11px; border-bottom:1px solid #dfe3e8; text-align:left; vertical-align:top; }
      th { background:#f6f6f7; color:#6d7175; font-size:13px; }
      .badge { display:inline-block; padding:4px 8px; border-radius:999px; font-size:12px; font-weight:700; }
      .ready { background:#dcfce7; color:#166534; }
      .warn { background:#fff7ed; color:#9a3412; }
      .done { background:#e0f2fe; color:#075985; }
      .error { background:#fee2e2; color:#b42318; }
      button { margin-top:18px; min-height:42px; border:1px solid #0b6b5d; border-radius:6px; padding:8px 14px; background:#0b6b5d; color:#fff; font-weight:700; cursor:pointer; }
      button:disabled { cursor:not-allowed; opacity:.55; }
      .hidden { display:none; }
    </style>
  </head>
  <body>
    <main>
      <div class="panel">
        <h1>${escapeHtml(params.title)}</h1>
        <p>${params.executed
          ? 'Bulk Odoo Sales Order action finished.'
          : 'Review selected orders before creating Odoo Sales Orders. Orders with missing SKU mapping will be skipped.'}</p>
        <table>
          <thead>
            <tr>
              <th>Order</th>
              <th>Customer</th>
              <th>Status</th>
              <th>Details</th>
              <th>Odoo</th>
            </tr>
          </thead>
          <tbody>
            ${params.rows.map((row) => `
              <tr>
                <td>${escapeHtml(row.orderName ?? row.orderId)}</td>
                <td>${escapeHtml(row.customerName ?? '')}</td>
                <td><span class="badge ${row.status === 'ready' ? 'ready' : row.status === 'created' ? 'done' : row.status === 'error' ? 'error' : 'warn'}">${escapeHtml(row.status)}</span></td>
                <td>${escapeHtml(row.detail)}</td>
                <td>${escapeHtml(row.saleOrderName ?? '')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        ${params.executed ? '' : `
          <form method="post" action="${escapeHtml(adminPath('/orders/create-odoo-sales-order/bulk', params.adminToken))}">
            ${adminHiddenInput(params.adminToken)}
            ${params.orderIds.map((orderId) => `<input class="hidden" type="hidden" name="orderIds" value="${escapeHtml(orderId)}" />`).join('')}
            <button type="submit" ${params.canExecute ? '' : 'disabled'}>Create ready Odoo Sales Orders</button>
          </form>
        `}
      </div>
    </main>
  </body>
</html>`;

const shipmentResultMessage = (result: {
  skipped: boolean;
  reason?: string;
  fulfillment?: { skipped: boolean; reason?: string };
  odoo?: { skipped: boolean; reason?: string; saleOrderName?: string; created?: boolean };
}): string => {
  let message = result.skipped
    ? `Skipped: ${result.reason ?? 'already handled'}`
    : 'Shipment created successfully.';

  if (result.fulfillment?.reason && result.fulfillment.reason !== 'already-fulfilled') {
    message = `${message} Fulfillment: ${result.fulfillment.reason}`;
  }

  if (result.odoo?.saleOrderName) {
    return `${message} Odoo Sales Order: ${result.odoo.saleOrderName}`;
  }

  if (result.odoo?.reason && result.odoo.reason !== 'odoo-sync-not-configured') {
    return `${message} Odoo needs attention: ${result.odoo.reason}`;
  }

  return message;
};

const validationDetailsMessage = (details: unknown): string | undefined => {
  if (!Array.isArray(details)) return undefined;

  const messages = details.flatMap((entry) => {
    const validation = entry?.extensions?.validation;
    if (!validation || typeof validation !== 'object') {
      return typeof entry?.message === 'string' ? [entry.message] : [];
    }

    return Object.entries(validation).flatMap(([field, values]) => {
      const text = Array.isArray(values) ? values.join(', ') : String(values);
      return `${field}: ${text}`;
    });
  });

  return messages.length > 0 ? messages.join(' | ') : undefined;
};

const actionErrorMessage = (error: unknown): string => {
  if (error instanceof ValidationError) {
    return validationDetailsMessage(error.details) ?? error.message;
  }

  return error instanceof Error ? error.message : 'Could not process this request.';
};

const telegraphAction = (
  handler: (request: Request, response: Response) => Promise<void>
) => async (request: Request, response: Response): Promise<void> => {
  try {
    await handler(request, response);
  } catch (error) {
    response.status(500).type('html').send(renderShipmentResult({
      title: 'Make Telegraph shipment',
      message: actionErrorMessage(error),
      error: true
    }));
  }
};

export const createAdminAppRouter = (
  shopifyOrderProcessor: ShopifyOrderProcessor,
  accurateClient: AccurateClient,
  odooSyncService: OdooSyncService,
  shipmentStatusSyncService?: ShipmentStatusSyncService
) => {
  const router = express.Router();

  router.get('/', (request: Request, response: Response) => {
    response.type('html').send(renderAppShell(extractAdminToken(request)));
  });

  router.get('/orders/make-telegraph/bulk', async (request: Request, response: Response) => {
    const orderIds = extractOrderIdsFromQuery(request);
    if (orderIds.length === 0) {
      response.status(400).type('html').send(renderBulkShipmentReview({
        title: 'Make Telegraph shipments',
        orderIds,
        rows: [{
          orderId: '',
          status: 'error',
          detail: 'Shopify did not pass selected order ids to this app action.'
        }],
        canExecute: false,
        adminToken: extractAdminToken(request)
      }));
      return;
    }

    const rows = [];
    for (const rawOrderId of orderIds) {
      try {
        const order = await getOrderByRawId(rawOrderId);
        const record = await shipmentRepository.findSummaryByShopifyOrderId(String(order.id));
        const customerName = order.shipping_address?.name
          ?? order.billing_address?.name
          ?? [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ');

        if (record?.accurateShipmentId) {
          rows.push({
            orderId: rawOrderId,
            orderName: order.name,
            customerName,
            status: 'already-created',
            detail: 'Telegraph shipment already exists for this order.',
            shipmentCode: record.accurateShipmentCode
          });
          continue;
        }

        if (!getTelegraphLocationSelection(order)) {
          rows.push({
            orderId: rawOrderId,
            orderName: order.name,
            customerName,
            status: 'needs-location',
            detail: 'Telegraph governorate and area are missing. Use the single-order button first.'
          });
          continue;
        }

        rows.push({
          orderId: rawOrderId,
          orderName: order.name,
          customerName,
          status: 'ready',
          detail: 'Ready to create Telegraph shipment.'
        });
      } catch (error) {
        rows.push({
          orderId: rawOrderId,
          status: 'error',
          detail: error instanceof Error ? error.message : 'Could not read this order.'
        });
      }
    }

    response.type('html').send(renderBulkShipmentReview({
      title: 'Make Telegraph shipments',
      orderIds,
      rows,
      canExecute: rows.some((row) => row.status === 'ready'),
      adminToken: extractAdminToken(request)
    }));
  });

  router.post('/orders/make-telegraph/bulk', express.urlencoded({ extended: false }), async (request: Request, response: Response) => {
    const rawOrderIds = request.body?.orderIds;
    const orderIds = (Array.isArray(rawOrderIds) ? rawOrderIds : [rawOrderIds])
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

    const adminToken = extractAdminToken(request);

    // Quickly resolve order names + existing status in parallel (Shopify + DB only — fast).
    // Returns the page immediately; JS in the page processes each "pending" order one-at-a-time
    // via /api/orders/create-shipment so every order gets Telegraph + Odoo sync without timeout.
    const settled = await Promise.allSettled(
      orderIds.map(async (rawOrderId, index) => {
        const order = await getOrderByRawId(rawOrderId);
        const record = await shipmentRepository.findSummaryByShopifyOrderId(String(order.id));
        const customerName = order.shipping_address?.name
          ?? order.billing_address?.name
          ?? [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ');

        if (record?.accurateShipmentId) {
          return { index, rawOrderId, orderName: order.name, customerName, status: 'already-created' as const, shipmentCode: record.accurateShipmentCode, needsProcessing: false };
        }
        if (!getTelegraphLocationSelection(order)) {
          return { index, rawOrderId, orderName: order.name, customerName, status: 'needs-location' as const, needsProcessing: false };
        }
        return { index, rawOrderId, orderName: order.name, customerName, status: 'pending' as const, needsProcessing: true };
      })
    );

    const rows = settled.map((outcome, i) =>
      outcome.status === 'fulfilled'
        ? outcome.value
        : { index: i, rawOrderId: orderIds[i], orderName: orderIds[i], customerName: '', status: 'error' as const, detail: outcome.reason instanceof Error ? outcome.reason.message : 'Could not read order.', needsProcessing: false }
    );

    response.type('html').send(renderBulkShipmentJsPage({ rows, adminToken }));
  });

  router.get('/orders/make-telegraph', telegraphAction(async (request: Request, response: Response) => {
    const rawOrderId = extractOrderIdFromQuery(request);
    if (!rawOrderId) {
      response.status(400).type('html').send(renderShipmentResult({
        title: 'Make Telegraph shipment',
        message: 'Shopify did not pass an order id to this app action.',
        error: true
      }));
      return;
    }

    const lookup = normalizeOrderIdForLookup(rawOrderId);
    const order = lookup.gid
      ? await shopifyOrdersClient.getOrderByGid(lookup.gid)
      : await shopifyOrdersClient.getOrderByLegacyId(lookup.legacyId as string);

    const existingRecord = await shipmentRepository.findSummaryByShopifyOrderId(String(order.id));
    if (existingRecord?.accurateShipmentId) {
      const result = await shopifyOrderProcessor.process(order, {
        source: 'shopify-admin-link-duplicate-fulfillment',
        rawOrderId,
        skipEligibility: true
      });
      response.type('html').send(renderShipmentResult({
        title: 'Make Telegraph shipment',
        message: shipmentResultMessage(result),
        orderName: order.name,
        shipmentCode: existingRecord.accurateShipmentCode,
        shipmentId: existingRecord.accurateShipmentId,
        odooSaleOrderName: result.odoo?.saleOrderName ?? existingRecord.odooSaleOrderName,
        odooSaleOrderId: existingRecord.odooSaleOrderId,
        telegraphDashboardUrl: `https://system.telegraphex.com/admin/shipments/${existingRecord.accurateShipmentId}`
      }));
      return;
    }

    if (!getTelegraphLocationSelection(order)) {
      response.type('html').send(renderLocationSelectionForm({
        orderId: String(order.id),
        orderName: order.name,
        locations: await getLocations(accurateClient),
        adminToken: extractAdminToken(request)
      }));
      return;
    }

    const result = await shopifyOrderProcessor.process(order, {
      source: 'shopify-admin-link',
      rawOrderId,
      skipEligibility: true,
      requireTelegraphLocation: true
    });
    const record = await shipmentRepository.findSummaryByShopifyOrderId(String(order.id));

    response.type('html').send(renderShipmentResult({
      title: 'Make Telegraph shipment',
      message: shipmentResultMessage(result),
      orderName: order.name,
      shipmentCode: record?.accurateShipmentCode,
      shipmentId: record?.accurateShipmentId,
      odooSaleOrderName: result.odoo?.saleOrderName ?? record?.odooSaleOrderName,
      odooSaleOrderId: record?.odooSaleOrderId,
      telegraphDashboardUrl: record?.accurateShipmentId
        ? `https://system.telegraphex.com/admin/shipments/${record.accurateShipmentId}`
        : undefined
    }));
  }));

  router.post('/orders/make-telegraph/select', express.urlencoded({ extended: false }), telegraphAction(async (request: Request, response: Response) => {
    const orderId = typeof request.body?.orderId === 'string' ? request.body.orderId : '';
    const governorateId = Number.parseInt(String(request.body?.governorateId ?? ''), 10);
    const areaId = Number.parseInt(String(request.body?.areaId ?? ''), 10);
    const governorate = typeof request.body?.governorate === 'string' ? request.body.governorate : '';
    const area = typeof request.body?.area === 'string' ? request.body.area : '';

    if (!orderId || Number.isNaN(governorateId) || Number.isNaN(areaId)) {
      response.status(400).type('html').send(renderShipmentResult({
        title: 'Make Telegraph shipment',
        message: 'Telegraph governorate and area are required.',
        error: true
      }));
      return;
    }

    const order = withTelegraphLocationSelection(await shopifyOrdersClient.getOrderByLegacyId(orderId), {
      governorateId,
      governorate,
      areaId,
      area
    });

    const result = await shopifyOrderProcessor.process(order, {
      source: 'shopify-admin-location-selection',
      rawOrderId: orderId,
      skipEligibility: true,
      requireTelegraphLocation: true
    });
    const record = await shipmentRepository.findSummaryByShopifyOrderId(String(order.id));

    response.type('html').send(renderShipmentResult({
      title: 'Make Telegraph shipment',
      message: shipmentResultMessage(result),
      orderName: order.name,
      shipmentCode: record?.accurateShipmentCode,
      shipmentId: record?.accurateShipmentId,
      odooSaleOrderName: result.odoo?.saleOrderName ?? record?.odooSaleOrderName,
      odooSaleOrderId: record?.odooSaleOrderId,
      telegraphDashboardUrl: record?.accurateShipmentId
        ? `https://system.telegraphex.com/admin/shipments/${record.accurateShipmentId}`
        : undefined
    }));
  }));

  router.get('/api/orders', async (_request: Request, response: Response) => {
    response.json({ orders: await summarizeOrder() });
  });

  router.post('/api/orders/create-shipment', express.json({ limit: '100kb' }), async (request: Request, response: Response) => {
    const orderGid = typeof request.body?.orderGid === 'string' ? request.body.orderGid : undefined;
    const orderId = typeof request.body?.orderId === 'string' ? request.body.orderId : undefined;
    if (!orderGid && !orderId) {
      response.status(400).json({ ok: false, message: 'orderGid or orderId is required' });
      return;
    }

    const order = orderGid
      ? await shopifyOrdersClient.getOrderByGid(orderGid)
      : await shopifyOrdersClient.getOrderByLegacyId(orderId as string);
    const result = await shopifyOrderProcessor.process(order, { source: 'manual-admin-app' });
    const record = await shipmentRepository.findSummaryByShopifyOrderId(String(order.id));
    response.json({ ok: true, ...result, orderName: order.name, shipmentCode: record?.accurateShipmentCode ?? null });
  });

  router.get('/orders/create-odoo-sales-order/bulk', async (request: Request, response: Response) => {
    const orderIds = extractOrderIdsFromQuery(request);
    if (orderIds.length === 0) {
      response.status(400).type('html').send(renderBulkOdooReview({
        title: 'Make Odoo Sales Orders',
        orderIds,
        rows: [{
          orderId: '',
          status: 'error',
          detail: 'Shopify did not pass selected order ids to this app action.'
        }],
        canExecute: false,
        adminToken: extractAdminToken(request)
      }));
      return;
    }

    const rows = [];
    for (const rawOrderId of orderIds) {
      try {
        const order = await getOrderByRawId(rawOrderId);
        const record = await shipmentRepository.findSummaryByShopifyOrderId(String(order.id));
        const customerName = order.shipping_address?.name
          ?? order.billing_address?.name
          ?? [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ');

        if (record?.odooSaleOrderName) {
          rows.push({
            orderId: rawOrderId,
            orderName: order.name,
            customerName,
            status: 'already-created',
            detail: 'Odoo Sales Order already exists for this order.',
            saleOrderName: record.odooSaleOrderName
          });
          continue;
        }

        const preview = await odooSyncService.previewOrder(order);
        if (!preview.ready) {
          rows.push({
            orderId: rawOrderId,
            orderName: order.name,
            customerName,
            status: 'not-ready',
            detail: preview.products
              .filter((product) => !product.ready)
              .map((product) => `${product.title}: ${product.reason ?? 'not ready'}`)
              .join('; ') || 'Order is not ready for Odoo.'
          });
          continue;
        }

        rows.push({
          orderId: rawOrderId,
          orderName: order.name,
          customerName,
          status: 'ready',
          detail: `Ready. Reference: ${preview.reference}`
        });
      } catch (error) {
        rows.push({
          orderId: rawOrderId,
          status: 'error',
          detail: error instanceof Error ? error.message : 'Could not read this order.'
        });
      }
    }

    response.type('html').send(renderBulkOdooReview({
      title: 'Make Odoo Sales Orders',
      orderIds,
      rows,
      canExecute: rows.some((row) => row.status === 'ready'),
      adminToken: extractAdminToken(request)
    }));
  });

  router.post('/orders/create-odoo-sales-order/bulk', express.urlencoded({ extended: false }), async (request: Request, response: Response) => {
    const rawOrderIds = request.body?.orderIds;
    const orderIds = (Array.isArray(rawOrderIds) ? rawOrderIds : [rawOrderIds])
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

    // Process all orders in parallel to avoid Netlify function timeout on large selections.
    const settled = await Promise.allSettled(
      orderIds.map(async (rawOrderId) => {
        const order = await getOrderByRawId(rawOrderId);
        const record = await shipmentRepository.findSummaryByShopifyOrderId(String(order.id));
        const customerName = order.shipping_address?.name
          ?? order.billing_address?.name
          ?? [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ');

        if (record?.odooSaleOrderName) {
          return {
            orderId: rawOrderId,
            orderName: order.name,
            customerName,
            status: 'already-created' as const,
            detail: 'Odoo Sales Order already exists for this order.',
            saleOrderName: record.odooSaleOrderName
          };
        }

        const preview = await odooSyncService.previewOrder(order);
        if (!preview.ready) {
          return {
            orderId: rawOrderId,
            orderName: order.name,
            customerName,
            status: 'not-ready' as const,
            detail:
              preview.products
                .filter((product) => !product.ready)
                .map((product) => `${product.title}: ${product.reason ?? 'not ready'}`)
                .join('; ') || 'Order is not ready for Odoo.'
          };
        }

        const result = await odooSyncService.ensureSalesOrder(order, record ?? undefined, {
          prepareStock: false,
          skipDbStatusUpdate: true
        });
        return {
          orderId: rawOrderId,
          orderName: order.name,
          customerName,
          status: (result.created ? 'created' : 'already-created') as 'created' | 'already-created',
          detail: result.created ? 'Odoo Sales Order created successfully.' : 'Odoo Sales Order already exists.',
          saleOrderName: result.name
        };
      })
    );

    const rows = settled.map((outcome, i) =>
      outcome.status === 'fulfilled'
        ? outcome.value
        : {
            orderId: orderIds[i],
            status: 'error' as const,
            detail: outcome.reason instanceof Error ? outcome.reason.message : 'Could not process this order.'
          }
    );

    response.type('html').send(renderBulkOdooReview({
      title: 'Make Odoo Sales Orders',
      orderIds,
      rows,
      canExecute: false,
      executed: true,
      adminToken: extractAdminToken(request)
    }));
  });

  router.get('/orders/create-odoo-sales-order', async (request: Request, response: Response) => {
    const rawOrderId = extractOrderIdFromQuery(request);
    if (!rawOrderId) {
      response.status(400).type('html').send(renderShipmentResult({
        title: 'Create Odoo Sales Order',
        message: 'Shopify did not pass an order id to this app action.',
        error: true
      }));
      return;
    }

    const lookup = normalizeOrderIdForLookup(rawOrderId);
    const order = lookup.gid
      ? await shopifyOrdersClient.getOrderByGid(lookup.gid)
      : await shopifyOrdersClient.getOrderByLegacyId(lookup.legacyId as string);
    const record = await shipmentRepository.findSummaryByShopifyOrderId(String(order.id));
    const result = await odooSyncService.ensureSalesOrder(order, record ?? undefined, {
      prepareStock: false,
      skipDbStatusUpdate: true
    });

    response.type('html').send(renderShipmentResult({
      title: 'Create Odoo Sales Order',
      message: result.created ? 'Odoo Sales Order created successfully.' : 'Odoo Sales Order already exists.',
      orderName: order.name,
      odooSaleOrderId: result.id,
      odooSaleOrderName: result.name
    }));
  });

  router.post('/api/orders/create-odoo-sales-order', express.json({ limit: '100kb' }), async (request: Request, response: Response) => {
    const orderGid = typeof request.body?.orderGid === 'string' ? request.body.orderGid : undefined;
    const orderId = typeof request.body?.orderId === 'string' ? request.body.orderId : undefined;
    if (!orderGid && !orderId) {
      response.status(400).json({ ok: false, message: 'orderGid or orderId is required' });
      return;
    }

    const order = orderGid
      ? await shopifyOrdersClient.getOrderByGid(orderGid)
      : await shopifyOrdersClient.getOrderByLegacyId(orderId as string);
    const record = await shipmentRepository.findSummaryByShopifyOrderId(String(order.id));
    const result = await odooSyncService.ensureSalesOrder(order, record ?? undefined, {
      prepareStock: false,
      skipDbStatusUpdate: true
    });
    response.json({ ok: true, saleOrderId: result.id, saleOrderName: result.name, created: result.created });
  });

  router.post('/api/orders/odoo-preview', express.json({ limit: '100kb' }), async (request: Request, response: Response) => {
    const orderGid = typeof request.body?.orderGid === 'string' ? request.body.orderGid : undefined;
    const orderId = typeof request.body?.orderId === 'string' ? request.body.orderId : undefined;
    if (!orderGid && !orderId) {
      response.status(400).json({ ok: false, message: 'orderGid or orderId is required' });
      return;
    }

    const order = orderGid
      ? await shopifyOrdersClient.getOrderByGid(orderGid)
      : await shopifyOrdersClient.getOrderByLegacyId(orderId as string);
    response.json({ ok: true, preview: await odooSyncService.previewOrder(order) });
  });

  router.get('/api/odoo/journals', async (_request: Request, response: Response) => {
    response.json({ journals: await odooSyncService.listPaymentJournals() });
  });

  router.get('/api/accurate/locations', async (_request: Request, response: Response) => {
    response.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
    response.json({ locations: await getLocations(accurateClient) });
  });

  router.get('/api/accurate/zones', async (_request: Request, response: Response) => {
    response.json({ zones: await accurateClient.listZones({ active: true, parentId: null }) });
  });

  router.get('/api/accurate/zones/:parentId/subzones', async (request: Request, response: Response) => {
    response.json({
      subzones: await accurateClient.listZones({
        active: true,
        parentId: Number.parseInt(request.params.parentId, 10)
      })
    });
  });

  // Manual sync trigger — accepts a list of shipment codes or shopify order IDs.
  // Used for testing and ad-hoc recovery. Returns per-record timing so we can spot timeouts.
  router.post('/api/sync-shipments', express.json({ limit: '10kb' }), async (request: Request, response: Response) => {
    if (!shipmentStatusSyncService) {
      response.status(503).json({ ok: false, message: 'Sync service not available' });
      return;
    }
    const codes: string[] = Array.isArray(request.body?.codes) ? request.body.codes : [];
    if (codes.length === 0) {
      // No codes provided → run the full scheduled sync (same as the cron job)
      const start = Date.now();
      const result = await shipmentStatusSyncService.syncOpenShipments();
      response.json({ ok: true, mode: 'full', elapsedMs: Date.now() - start, ...result });
      return;
    }

    // Sync only the specified codes
    const results: Array<{ code: string; status: string; elapsedMs: number; error?: string }> = [];
    for (const code of codes) {
      const start = Date.now();
      try {
        const record = await shipmentRepository.findByReference(code);
        if (!record) {
          results.push({ code, status: 'not-found', elapsedMs: Date.now() - start });
          continue;
        }
        await shipmentStatusSyncService.syncRecord(record);
        results.push({ code, status: 'ok', elapsedMs: Date.now() - start });
      } catch (error) {
        results.push({
          code,
          status: 'error',
          elapsedMs: Date.now() - start,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    response.json({ ok: true, mode: 'selective', results });
  });

  return router;
};
