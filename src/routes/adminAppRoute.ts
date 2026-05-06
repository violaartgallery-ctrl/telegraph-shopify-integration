import express from 'express';
import type { Request, Response } from 'express';
import { AccurateClient } from '../accurate/accurateClient.js';
import { isOrderEligibleForShipment } from '../services/orderEligibility.js';
import { shipmentRepository } from '../services/shipmentRepository.js';
import { ShopifyOrderProcessor } from '../services/shopifyOrderProcessor.js';
import { getTelegraphLocationSelection, withTelegraphLocationSelection } from '../services/telegraphLocation.js';
import { shopifyOrdersClient } from '../shopify/shopifyOrdersClient.js';

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

const renderAppShell = (): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Telegraph Shipments</title>
    <style>
      :root { color-scheme: light; --ink:#202223; --muted:#6d7175; --line:#dfe3e8; --soft:#f6f6f7; --brand:#0b6b5d; --danger:#b42318; }
      body { margin:0; font-family: Arial, sans-serif; color:var(--ink); background:#fff; }
      main { max-width:1180px; margin:0 auto; padding:28px 20px 48px; }
      header { display:flex; gap:16px; align-items:center; justify-content:space-between; margin-bottom:22px; }
      h1 { font-size:28px; margin:0; }
      .muted { color:var(--muted); }
      .toolbar { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
      button, a.button { border:1px solid var(--line); background:#fff; color:var(--ink); border-radius:6px; min-height:38px; padding:8px 13px; font-weight:700; cursor:pointer; text-decoration:none; }
      button.primary { background:var(--brand); border-color:var(--brand); color:#fff; }
      button:disabled { cursor:not-allowed; opacity:.55; }
      section { border-top:1px solid var(--line); padding-top:18px; margin-top:22px; }
      table { width:100%; border-collapse:collapse; border:1px solid var(--line); }
      th, td { padding:12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
      th { background:var(--soft); font-size:13px; color:var(--muted); }
      .badge { display:inline-block; padding:3px 8px; border-radius:999px; background:var(--soft); font-size:12px; font-weight:700; }
      .badge.ok { background:#dcfce7; color:#166534; }
      .badge.warn { background:#fff7ed; color:#9a3412; }
      .badge.fail { background:#fee2e2; color:var(--danger); }
      .stack { display:grid; gap:4px; }
      .locations { max-height:360px; overflow:auto; border:1px solid var(--line); padding:12px; }
      details { border-bottom:1px solid var(--line); padding:8px 0; }
      details:last-child { border-bottom:0; }
      summary { cursor:pointer; font-weight:700; }
      .subzones { display:flex; gap:6px; flex-wrap:wrap; padding:8px 0 4px; }
      .toast { min-height:22px; font-weight:700; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>Telegraph Shipments</h1>
          <div class="muted">Create Accurate shipments manually and verify location values.</div>
        </div>
        <div class="toolbar">
          <button id="refresh" type="button">Refresh orders</button>
          <button id="locations-refresh" type="button">Refresh locations</button>
        </div>
      </header>
      <div id="toast" class="toast"></div>
      <section>
        <h2>Orders</h2>
        <div id="orders">Loading orders...</div>
      </section>
      <section>
        <h2>Accurate locations</h2>
        <p class="muted">These governorates and areas come directly from Accurate in the same dropdown order.</p>
        <div id="locations" class="locations">Loading locations...</div>
      </section>
    </main>
    <script>
      const toast = document.getElementById('toast');
      const setToast = (message, error = false) => {
        toast.textContent = message || '';
        toast.style.color = error ? '#b42318' : '#0b6b5d';
      };
      const html = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
      const statusBadge = (status) => {
        const value = status || 'not-created';
        const cls = /created|delivered|pending/i.test(value) ? 'ok' : /failed/i.test(value) ? 'fail' : 'warn';
        return '<span class="badge ' + cls + '">' + html(value) + '</span>';
      };
      async function loadOrders() {
        const target = document.getElementById('orders');
        target.textContent = 'Loading orders...';
        const response = await fetch('/api/orders');
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Could not load orders');
        target.innerHTML = '<table><thead><tr><th>Order</th><th>Customer</th><th>Address</th><th>Payment</th><th>Shipment</th><th>Action</th></tr></thead><tbody>' +
          data.orders.map((order) => '<tr>' +
            '<td><div class="stack"><strong>' + html(order.name) + '</strong><span class="muted">' + html(order.id) + '</span></div></td>' +
            '<td>' + html(order.customerName || '-') + '<br><span class="muted">' + html(order.phone || '-') + '</span></td>' +
            '<td>' + html(order.city || '-') + '<br><span class="muted">' + html(order.province || '-') + '</span></td>' +
            '<td>' + html(order.financialStatus || '-') + '<br><span class="muted">' + html(order.gateway || '-') + '</span></td>' +
            '<td>' + statusBadge(order.shipmentStatus) + (order.shipmentCode ? '<br><span class="muted">' + html(order.shipmentCode) + '</span>' : '') + '</td>' +
            '<td><button class="primary" data-order-gid="' + html(order.gid) + '" ' + (order.shipmentCode ? 'disabled' : '') + '>Make Telegraph shipment</button></td>' +
          '</tr>').join('') + '</tbody></table>';
        target.querySelectorAll('button[data-order-gid]').forEach((button) => {
          button.addEventListener('click', async () => {
            button.disabled = true;
            setToast('Creating shipment...');
            try {
              const response = await fetch('/api/orders/create-shipment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderGid: button.dataset.orderGid })
              });
              const payload = await response.json();
              if (!response.ok) throw new Error(payload.message || 'Could not create shipment');
              setToast(payload.skipped ? 'Skipped: ' + payload.reason : 'Shipment created successfully');
              await loadOrders();
            } catch (error) {
              setToast(error.message, true);
              button.disabled = false;
            }
          });
        });
      }
      async function loadLocations() {
        const target = document.getElementById('locations');
        target.textContent = 'Loading locations...';
        const response = await fetch('/api/accurate/locations');
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Could not load locations');
        target.innerHTML = data.locations.map((zone) => '<details>' +
          '<summary>' + html(zone.name) + ' <span class="muted">#' + html(zone.id) + '</span></summary>' +
          '<div class="subzones">' + zone.subzones.map((subzone) => '<span class="badge">' + html(subzone.name) + ' #' + html(subzone.id) + '</span>').join('') + '</div>' +
        '</details>').join('');
      }
      document.getElementById('refresh').addEventListener('click', () => loadOrders().catch((error) => setToast(error.message, true)));
      document.getElementById('locations-refresh').addEventListener('click', () => loadLocations().catch((error) => setToast(error.message, true)));
      loadOrders().catch((error) => setToast(error.message, true));
      loadLocations().catch((error) => setToast(error.message, true));
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
      lastError: record?.lastError
    };
  });
};

const getLocations = async (accurateClient: AccurateClient) => {
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

const normalizeOrderIdForLookup = (orderId: string): { gid?: string; legacyId?: string } => {
  if (orderId.startsWith('gid://shopify/Order/')) {
    return { gid: orderId };
  }

  const numeric = orderId.match(/\d+/)?.[0];
  return numeric ? { legacyId: numeric } : {};
};

const renderShipmentResult = (params: {
  title: string;
  message: string;
  orderName?: string;
  shipmentCode?: string | null;
  shipmentId?: number | null;
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
      <form method="post" action="/orders/make-telegraph/select">
        <div>
          <h1>Select Telegraph location</h1>
          <p class="muted">Order ${escapeHtml(params.orderName)} is missing Telegraph governorate and area. Choose them to create the shipment safely.</p>
          ${params.message ? `<p class="error">${escapeHtml(params.message)}</p>` : ''}
        </div>
        <input type="hidden" name="orderId" value="${escapeHtml(params.orderId)}" />
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

const shipmentResultMessage = (result: {
  skipped: boolean;
  reason?: string;
  fulfillment?: { skipped: boolean; reason?: string };
}): string => {
  const base = result.skipped
    ? `Skipped: ${result.reason ?? 'already handled'}`
    : 'Shipment created successfully.';

  if (!result.fulfillment?.reason || result.fulfillment.reason === 'already-fulfilled') {
    return base;
  }

  return `${base} Fulfillment: ${result.fulfillment.reason}`;
};

export const createAdminAppRouter = (
  shopifyOrderProcessor: ShopifyOrderProcessor,
  accurateClient: AccurateClient
) => {
  const router = express.Router();

  router.get('/', (_request: Request, response: Response) => {
    response.type('html').send(renderAppShell());
  });

  router.get('/orders/make-telegraph', async (request: Request, response: Response) => {
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

    const existingRecord = await shipmentRepository.findByShopifyOrderId(String(order.id));
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
        telegraphDashboardUrl: `https://system.telegraphex.com/admin/shipments/${existingRecord.accurateShipmentId}`
      }));
      return;
    }

    if (!getTelegraphLocationSelection(order)) {
      response.type('html').send(renderLocationSelectionForm({
        orderId: String(order.id),
        orderName: order.name,
        locations: await getLocations(accurateClient)
      }));
      return;
    }

    const result = await shopifyOrderProcessor.process(order, {
      source: 'shopify-admin-link',
      rawOrderId,
      skipEligibility: true,
      requireTelegraphLocation: true
    });
    const record = await shipmentRepository.findByShopifyOrderId(String(order.id));

    response.type('html').send(renderShipmentResult({
      title: 'Make Telegraph shipment',
      message: shipmentResultMessage(result),
      orderName: order.name,
      shipmentCode: record?.accurateShipmentCode,
      shipmentId: record?.accurateShipmentId,
      telegraphDashboardUrl: record?.accurateShipmentId
        ? `https://system.telegraphex.com/admin/shipments/${record.accurateShipmentId}`
        : undefined
    }));
  });

  router.post('/orders/make-telegraph/select', express.urlencoded({ extended: false }), async (request: Request, response: Response) => {
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
    const record = await shipmentRepository.findByShopifyOrderId(String(order.id));

    response.type('html').send(renderShipmentResult({
      title: 'Make Telegraph shipment',
      message: shipmentResultMessage(result),
      orderName: order.name,
      shipmentCode: record?.accurateShipmentCode,
      shipmentId: record?.accurateShipmentId,
      telegraphDashboardUrl: record?.accurateShipmentId
        ? `https://system.telegraphex.com/admin/shipments/${record.accurateShipmentId}`
        : undefined
    }));
  });

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
    response.json({ ok: true, ...result });
  });

  router.get('/api/accurate/locations', async (_request: Request, response: Response) => {
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

  return router;
};
