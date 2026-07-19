import 'dotenv/config';
import dotenv from 'dotenv';
import { basePrisma } from '../lib/prisma.js';
import { sendDocument } from '../telegram/telegramApi.js';
import { getOrderAttribute, telegraphLocationKeys } from '../services/telegraphLocation.js';
import type { ShopifyOrder } from '../types/shopify.js';

dotenv.config({ path: '.env.netlify', override: false });

const SOURCE = 'shopify-orders-create';
const MARKER_SOURCE = 'recovery-missing-location-report';
const MISSING_REASON = 'missing Telegraph';
const DEFAULT_RECIPIENTS = ['6776051391', '8615245657'];
const WINDOW_MS = 10 * 60 * 1000;

function csvCell(value: unknown): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function compact(value?: string | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function recipientIds(): string[] {
  const configured = process.env.PRODUCTION_RECIPIENT_CHAT_IDS?.trim();
  const values = configured ? configured.split(',') : DEFAULT_RECIPIENTS;
  return [...new Set(values.map((value) => value.trim()).filter((value) => /^\d+$/.test(value)))];
}

function orderNumber(order: ShopifyOrder): string {
  return String(order.name ?? order.order_number).replace(/^#/, '');
}

function customerName(order: ShopifyOrder): string {
  const address = order.shipping_address ?? order.billing_address;
  return compact(
    address?.name
      ?? [address?.first_name, address?.last_name].filter(Boolean).join(' ')
      ?? [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ')
  );
}

function phone(order: ShopifyOrder): string {
  return compact(
    order.shipping_address?.phone
      ?? order.phone
      ?? order.customer?.phone
      ?? order.billing_address?.phone
  );
}

function makeCsv(rows: Array<{ order: ShopifyOrder; failureAt: Date }>): Buffer {
  const header = [
    'order_name',
    'shopify_order_id',
    'customer_name',
    'phone',
    'address_1',
    'address_2',
    'city',
    'province',
    'country',
    'selected_governorate_id',
    'selected_governorate',
    'selected_area_id',
    'selected_area',
    'status',
    'failure_time_utc',
    'shopify_admin_url',
  ];
  const lines = [header.map(csvCell).join(',')];

  for (const { order, failureAt } of rows) {
    const address = order.shipping_address ?? order.billing_address;
    lines.push([
      order.name,
      order.id,
      customerName(order),
      phone(order),
      compact(address?.address1),
      compact(address?.address2),
      compact(address?.city),
      compact(address?.province),
      compact(address?.country),
      getOrderAttribute(order, telegraphLocationKeys.governorateId),
      getOrderAttribute(order, telegraphLocationKeys.governorate),
      getOrderAttribute(order, telegraphLocationKeys.areaId),
      getOrderAttribute(order, telegraphLocationKeys.area),
      'needs_location_review_not_shipped',
      failureAt.toISOString(),
      `https://admin.shopify.com/store/violaleather/orders/${order.id}`,
    ].map(csvCell).join(','));
  }

  // Excel otherwise guesses an ANSI code page and displays Arabic as question marks.
  return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}

async function main(): Promise<void> {
  const shouldSend = process.argv.includes('--send');
  const latest = await basePrisma.failedPayload.findFirst({
    where: { source: SOURCE, reason: { contains: MISSING_REASON } },
    orderBy: { createdAt: 'desc' },
  });
  if (!latest) throw new Error('No missing-location failure batch was found');

  const windowStart = new Date(latest.createdAt.getTime() - WINDOW_MS);
  const failures = await basePrisma.failedPayload.findMany({
    where: {
      source: SOURCE,
      reason: { contains: MISSING_REASON },
      createdAt: { gte: windowStart, lte: latest.createdAt },
    },
    orderBy: { createdAt: 'asc' },
  });

  const latestByOrderId = new Map<string, (typeof failures)[number]>();
  for (const failure of failures) {
    if (failure.externalId) latestByOrderId.set(failure.externalId, failure);
  }
  const orderIds = [...latestByOrderId.keys()];
  const shipments = await basePrisma.shipmentRecord.findMany({
    where: { shopifyOrderId: { in: orderIds } },
    select: { shopifyOrderId: true, accurateShipmentId: true },
  });
  const shippedIds = new Set(
    shipments.filter((shipment) => shipment.accurateShipmentId).map((shipment) => shipment.shopifyOrderId)
  );

  const rows = [...latestByOrderId.entries()]
    .filter(([id]) => !shippedIds.has(id))
    .map(([, failure]) => ({
      order: JSON.parse(failure.payloadJson) as ShopifyOrder,
      failureAt: failure.createdAt,
    }))
    .sort((a, b) => Number(orderNumber(b.order)) - Number(orderNumber(a.order)));

  const partialGovernorate = rows.filter(({ order }) =>
    Boolean(getOrderAttribute(order, telegraphLocationKeys.governorateId))
    && !getOrderAttribute(order, telegraphLocationKeys.areaId)
  );
  const batchKey = `${latest.createdAt.toISOString()}-${rows.length}`;
  const summary = {
    ok: true,
    batchKey,
    sourceFailures: failures.length,
    uniqueOrders: latestByOrderId.size,
    excludedAlreadyShipped: shippedIds.size,
    recoveryOrders: rows.length,
    partialGovernorateOrders: partialGovernorate.map(({ order }) => order.name),
    orderNames: rows.map(({ order }) => order.name),
    sent: false,
  };

  if (!shouldSend) {
    console.log(JSON.stringify(summary));
    return;
  }
  if (!rows.length) throw new Error('No unshipped missing-location orders remain');

  const csv = makeCsv(rows);
  const filename = `missing_locations_recovery_${latest.createdAt.toISOString().slice(0, 10).replace(/-/g, '')}_${rows.length}.csv`;
  const caption = [
    `⚠️ Recovery للمواقع الناقصة — ${rows.length} أوردر لم يتم شحنهم`,
    'اختاروا المحافظة والمنطقة الصحيحتين فقط؛ النظام لم يخمّن أي بيانات.',
    partialGovernorate.length ? `ملاحظة: ${partialGovernorate.map(({ order }) => order.name).join(', ')} به محافظة فقط والمنطقة ناقصة.` : '',
  ].filter(Boolean).join('\n');

  const sentRecipients: string[] = [];
  const skippedRecipients: string[] = [];
  for (const chatId of recipientIds()) {
    const markerId = `${batchKey}:${chatId}`;
    const existingMarker = await basePrisma.failedPayload.findFirst({
      where: { source: MARKER_SOURCE, externalId: markerId },
      select: { id: true },
    });
    if (existingMarker) {
      skippedRecipients.push(chatId);
      continue;
    }
    if (!(await sendDocument(chatId, csv, filename, caption))) {
      throw new Error(`Telegram did not confirm recovery report for recipient ${chatId}`);
    }
    await basePrisma.failedPayload.create({
      data: {
        source: MARKER_SOURCE,
        externalId: markerId,
        reason: 'recovery CSV delivered',
        payloadJson: JSON.stringify({ batchKey, chatId, filename, orderCount: rows.length }),
      },
    });
    sentRecipients.push(chatId);
  }

  console.log(JSON.stringify({ ...summary, sent: true, sentRecipients, skippedRecipients }));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await basePrisma.$disconnect();
  });
