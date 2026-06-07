/**
 * Netlify Background Function — runs up to 15 minutes.
 * Triggered by the telegram-webhook function.
 *
 * Pipeline:
 *  1. Call Ayman Production Agent API → get Word doc + photos ZIP
 *  2. Send Word to Telegram
 *  3. Send photos ZIP to Telegram (if present)
 *  4. Send production summary
 *  5. If execute=true: create Telegraph shipments order by order
 *  6. Send final report
 */

interface LambdaEvent { body: string | null; }
interface LambdaResult { statusCode: number; body: string; }
interface JobPayload { chatId: number; execute: boolean; orderId?: string; }

// Only telegramApi at top level — zero env dependencies, safe for module load.
import { sendMessage, sendDocument } from '../../telegram/telegramApi.js';
import type { ShopifyOrder } from '../../types/shopify.js';

// ── Ayman Agent response type ──────────────────────────────────────────────────

interface PhotoAttachment {
  attachment_name: string;
  attachment_url: string;
  order_name: string;
  comment_id: string;
}

interface AymanEntry {
  display_product: string;
  display_color?: string;
  total_quantity: number;
  warnings?: string[];
  photo_attachments?: PhotoAttachment[];
}

interface AymanResponse {
  wordBase64: string;
  productionEntries: AymanEntry[];
  summary?: { totalOrders?: number; productionEntries?: number };
  warnings?: string[];
}

// ── Ayman Agent integration ────────────────────────────────────────────────────

async function fetchFromAymanAgent(orderId?: string): Promise<AymanResponse> {
  const baseUrl = (process.env.AYMAN_AGENT_URL ?? 'https://viola-production-agent.netlify.app').replace(/\/$/, '');
  const secret = process.env.AYMAN_AGENT_SECRET ?? '';

  const resp = await fetch(`${baseUrl}/.netlify/functions/production`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { 'X-Agent-Secret': secret } : {}),
    },
    body: JSON.stringify({ mode: 'execute', skipPhotos: true, ...(orderId ? { orderId } : {}) }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Ayman Agent HTTP ${resp.status}: ${body.slice(0, 500)}`);
  }

  let data: AymanResponse;
  try {
    data = await resp.json() as AymanResponse;
  } catch {
    throw new Error('Ayman Agent returned invalid JSON');
  }

  if (!data.wordBase64) {
    const hint = JSON.stringify({ summary: data.summary, warnings: (data.warnings ?? []).slice(0, 3) });
    throw new Error(`Ayman Agent response missing wordBase64. Details: ${hint}`);
  }

  return data;
}

// ── Order filtering (used only for shipment step) ──────────────────────────────

function hasConfirmedTag(order: ShopifyOrder): boolean {
  const tags = (order.tags ?? '').toLowerCase().split(',').map((t) => t.trim());
  return tags.includes('confirmed');
}

// ── Shipment result type ───────────────────────────────────────────────────────

interface ShipResult {
  orderName: string;
  ok: boolean;
  reason?: string;
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

async function runPipeline(chatId: number, execute: boolean, orderId?: string): Promise<void> {
  const mode = execute ? 'تنفيذ حقيقي' : 'بريفيو';
  const orderLabel = orderId ? ` (أوردر ${orderId} فقط)` : '';

  // ── Step 1: Call Ayman Agent ───────────────────────────────────────────────
  await sendMessage(chatId, `📦 جاري جلب التجميعة من Ayman Agent...${orderLabel} (${mode})`);

  let aymanData: AymanResponse;
  try {
    aymanData = await fetchFromAymanAgent(orderId);
  } catch (err) {
    await sendMessage(chatId, `❌ فشل Ayman Agent:\n${String(err).slice(0, 300)}`);
    return;
  }

  const { wordBase64, productionEntries, summary, warnings } = aymanData;
  const dateStr = new Date().toISOString().slice(0, 10);

  await sendMessage(
    chatId,
    `✅ لقيت ${summary?.totalOrders ?? '?'} أوردر — ${productionEntries.length} منتج\nبدأت الإرسال...`
  );

  // ── Step 2: Send Word doc ──────────────────────────────────────────────────
  const wordBuf = Buffer.from(wordBase64, 'base64');
  await sendDocument(
    chatId,
    wordBuf,
    `production_${dateStr}.docx`,
    `قائمة الإنتاج ✅ — ${productionEntries.length} منتج`
  );

  // ── Step 3: Send photos individually from photo_attachments URLs ──────────
  const allPhotoAttachments: Array<{ url: string; orderName: string; name: string }> = [];
  for (const entry of productionEntries) {
    for (const ph of entry.photo_attachments ?? []) {
      if (ph.attachment_url) {
        allPhotoAttachments.push({ url: ph.attachment_url, orderName: ph.order_name, name: ph.attachment_name });
      }
    }
  }
  const seenUrls = new Set<string>();
  const uniquePhotos = allPhotoAttachments.filter((p) => {
    if (seenUrls.has(p.url)) return false;
    seenUrls.add(p.url);
    return true;
  });

  if (uniquePhotos.length > 0) {
    await sendMessage(chatId, `📷 جاري إرسال ${uniquePhotos.length} صورة...`);
    const photoFailures: string[] = [];
    for (let i = 0; i < uniquePhotos.length; i++) {
      const photo = uniquePhotos[i]!;
      try {
        const photoResp = await fetch(photo.url);
        if (photoResp.ok) {
          const photoBuf = Buffer.from(await photoResp.arrayBuffer());
          const rawExt = new URL(photo.url).pathname.split('.').pop() ?? 'jpg';
          const ext = rawExt.length <= 5 ? rawExt : 'jpg';
          const safeName = photo.orderName.replace(/[^a-zA-Z0-9_-]/g, '_');
          await sendDocument(chatId, photoBuf, `${safeName}_photo_${i + 1}.${ext}`, `${photo.orderName} — ${photo.name}`);
        } else {
          photoFailures.push(`${photo.orderName}: HTTP ${photoResp.status}`);
        }
      } catch (err) {
        photoFailures.push(`${photo.orderName}: ${String(err).slice(0, 80)}`);
      }
    }
    if (photoFailures.length > 0) {
      await sendMessage(chatId, `⚠️ فشل إرسال ${photoFailures.length} صورة:\n${photoFailures.slice(0, 5).join('\n')}`);
    }
  }

  // ── Step 4: Production summary ────────────────────────────────────────────
  const summaryLines = ['📋 *ملخص التجميعة:*'];
  if (warnings?.length) {
    summaryLines.push(`⚠️ تحذيرات: ${warnings.length}`);
    for (const w of warnings.slice(0, 3)) {
      summaryLines.push(`• ${String(w).slice(0, 120)}`);
    }
  }
  for (const entry of productionEntries.slice(0, 20)) {
    summaryLines.push(`• ${entry.total_quantity}x ${entry.display_product} ${entry.display_color ?? ''}`);
  }
  if (productionEntries.length > 20) {
    summaryLines.push(`...و ${productionEntries.length - 20} منتج تاني`);
  }
  await sendMessage(chatId, summaryLines.join('\n'), { parse_mode: 'Markdown' });

  // ── Step 5: Preview only — stop here ──────────────────────────────────────
  if (!execute) {
    await sendMessage(chatId, `🔒 بريفيو فقط — مش اتعملت أي شحنة.`);
    return;
  }

  // ── Step 6: Check safety gate ──────────────────────────────────────────────
  if (process.env.TELEGRAPH_ENABLED?.trim().toLowerCase() !== 'true') {
    await sendMessage(
      chatId,
      '⛔ TELEGRAPH\\_ENABLED مش مفعّل في الـ .env\nعدّل الـ .env في Netlify وأعد المحاولة.',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // ── Step 7: Fetch confirmed orders for shipment ────────────────────────────
  await sendMessage(chatId, `🚚 جاري جلب الأوردرات للشحن...`);

  const { shopifyOrdersClient } = await import('../../shopify/shopifyOrdersClient.js');
  let allOrders: ShopifyOrder[];
  try {
    const query = orderId
      ? `name:#${orderId.replace(/^#/, '')} tag:confirmed fulfillment_status:unfulfilled`
      : 'tag:confirmed fulfillment_status:unfulfilled';
    allOrders = await shopifyOrdersClient.listRecentOrders(250, query);
  } catch (err) {
    await sendMessage(chatId, `❌ فشل في جلب الأوردرات للشحن: ${String(err).slice(0, 200)}`);
    return;
  }

  const orders = allOrders.filter((o) => !o.test);
  if (!orders.length) {
    await sendMessage(chatId, '✅ مفيش أوردرات confirmed للشحن دلوقتي.');
    return;
  }

  await sendMessage(chatId, `🚚 بدأ الشحن — ${orders.length} أوردر...`);

  // Dynamic import so Prisma only loads when actually shipping
  const { createAppServices } = await import('../../app.js');
  const { shopifyOrderProcessor } = createAppServices();
  const results: ShipResult[] = [];
  const createdShipmentCodes: string[] = [];

  for (const order of orders) {
    try {
      const result = await shopifyOrderProcessor.process(order, {
        source: 'telegram-bot',
        skipEligibility: false,
      });
      if (result.skipped) {
        const reason = result.reason ?? 'skipped';
        results.push({ orderName: order.name, ok: true, reason });
        // Already-shipped orders still carry their shipment code — collect it so
        // re-running /run regenerates the waybill PDF instead of sending nothing.
        if (result.accurateShipmentCode) {
          createdShipmentCodes.push(result.accurateShipmentCode);
        }
        await sendMessage(chatId, `⏭️ ${order.name} — تم تخطيه: ${reason}`);
      } else {
        if (result.accurateShipmentCode) {
          createdShipmentCodes.push(result.accurateShipmentCode);
        }
        results.push({ orderName: order.name, ok: true });
        await sendMessage(chatId, `✅ ${order.name} — تم الشحن بنجاح`);
      }
    } catch (err) {
      const errMsg = String(err).slice(0, 200);
      results.push({ orderName: order.name, ok: false, reason: errMsg });
      await sendMessage(chatId, `❌ ${order.name} — فشل: ${errMsg}`);
    }
  }

  // ── Waybill print link ───────────────────────────────────────────────────
  // We send Telegraph's official print URL instead of generating a PDF on the
  // server. The link is deterministic (just shipment codes joined into a URL)
  // so it can never fail to build, and it opens Telegraph's own print page in
  // the user's browser — where they are already logged in — giving a 100%
  // reliable waybill the user can print or save as PDF (Ctrl+P).
  const uniqueShipmentCodes = [...new Set(createdShipmentCodes)];
  if (uniqueShipmentCodes.length > 0) {
    const codesParam = uniqueShipmentCodes.map(encodeURIComponent).join(',');
    const printUrl = `https://system.telegraphex.com/print/waybill/shipment/A4/3d/${codesParam}`;
    await sendMessage(
      chatId,
      `🖨️ *بوالص الشحن (${uniqueShipmentCodes.length}):*\n${printUrl}\n\n` +
        `افتح اللينك ← هيفتح صفحة الطباعة الرسمية ← اطبع أو احفظ PDF (Ctrl+P).`,
      { parse_mode: 'Markdown' }
    );
  } else {
    // No shipment codes at all — tell the user explicitly instead of silently
    // skipping, so a /run that produces no waybills is never a mystery.
    await sendMessage(
      chatId,
      'ℹ️ مفيش بوالص للطباعة — يا إما مفيش أوردرات جاهزة، يا إما كلها اتشحنت ومالهاش كود شحنة محفوظ.'
    );
  }

  // ── Step 8: Final report ───────────────────────────────────────────────────
  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  const reportLines = [
    '📊 *تقرير نهائي*',
    `✅ نجح: ${succeeded.length}`,
    `❌ فشل: ${failed.length}`,
  ];
  if (failed.length) {
    reportLines.push('\n*الأوردرات اللي فشلت:*');
    for (const r of failed) {
      reportLines.push(`• ${r.orderName}: ${r.reason?.slice(0, 100) ?? '?'}`);
    }
  }
  await sendMessage(chatId, reportLines.join('\n'), { parse_mode: 'Markdown' });
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const handler = async (event: LambdaEvent): Promise<LambdaResult> => {
  if (!event.body) return { statusCode: 400, body: 'Missing body' };

  let payload: JobPayload;
  try {
    payload = JSON.parse(event.body) as JobPayload;
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const { chatId, execute, orderId } = payload;

  try {
    await runPipeline(chatId, execute, orderId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[background] Pipeline error:', msg);
    try {
      await sendMessage(chatId, `❌ حصل خطأ غير متوقع:\n${msg.slice(0, 300)}`);
    } catch {
      // ignore
    }
  }

  return { statusCode: 202, body: 'ok' };
};
