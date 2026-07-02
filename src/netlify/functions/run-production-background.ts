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
import { sendMessage, sendDocument, sendMessageWithButton } from '../../telegram/telegramApi.js';
import type { ShopifyOrder } from '../../types/shopify.js';
import {
  loadJob,
  saveJob,
  clearJob,
  type RunCursor,
  type PreviewCursor,
} from '../../services/productionJobStore.js';

// Soft deadline: stop cleanly at 4 min, leaving 60s margin before Vercel's 300s
// hard cap so the pause message + Continue button always get sent in time.
const JOB_DEADLINE_MS = 240_000;

// Build the "Continue" button + prompt shown when a job pauses at the deadline.
async function sendContinuePrompt(chatId: number, kind: 'run' | 'preview', progress: string): Promise<void> {
  const what = kind === 'run' ? 'الشحن' : 'التجميعة';
  await sendMessageWithButton(
    chatId,
    `⏸️ وقفت ${what} مؤقتًا قبل ما يوصل حد الوقت (عشان مفيش حاجة تضيع).\n${progress}\n\n▶️ دوس *إكمال* أكمّل من نفس المكان.`,
    { text: '▶️ إكمال (Continue)', callback_data: `cont:${kind}` },
    { parse_mode: 'Markdown' }
  );
}

// ── Ayman Agent response type ──────────────────────────────────────────────────

interface PhotoAttachment {
  attachment_name: string;
  attachment_url: string;
  order_name: string;
  comment_id: string;
  position_label?: string | null;
}

interface AymanEntry {
  display_product: string;
  display_color?: string;
  total_quantity: number;
  warnings?: string[];
  photo_attachments?: PhotoAttachment[];
}

interface AymanOrderDetail {
  order_name: string;
  customer: string;
  created_at: string;
  items: Array<{
    product: string; color: string; variant: string; quantity: number;
    customizations: Array<[string, string]>; photo_urls: string[];
  }>;
}

interface AymanResponse {
  wordBase64: string;
  aiBase64?: string[];   // laser-ready welded outline .ai file(s) for RDWorks
  ordersDetail?: AymanOrderDetail[]; // per-order summary data (lightweight)
  productionEntries: AymanEntry[];
  summary?: { totalOrders?: number; productionEntries?: number };
  warnings?: string[];
}

// ── Ayman Agent integration ────────────────────────────────────────────────────

async function fetchFromAymanAgent(orderId?: string): Promise<AymanResponse> {
  const baseUrl = (process.env.AYMAN_AGENT_URL ?? 'https://viola-production-agent.vercel.app').replace(/\/$/, '');
  const secret = process.env.AYMAN_AGENT_SECRET ?? '';

  // Ayman agent migrated to Vercel: endpoint is /api/production (POST), not the
  // old Netlify /.netlify/functions/production path (which now 404s).
  const resp = await fetch(`${baseUrl}/api/production`, {
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

// ── Main pipeline ─────────────────────────────────────────────────────────────

export async function runPipeline(
  chatId: number,
  execute: boolean,
  orderId?: string,
  resume = false
): Promise<void> {
  // Both flows are checkpointed: a soft deadline stops the run cleanly and saves
  // a cursor; the user presses "Continue" to resume from exactly where it
  // stopped (see productionJobStore). Split so each gets its OWN 300s budget:
  //   execute=true  (/run)     → create Telegraph shipments only.
  //   execute=false (/preview) → generate + send the production documents only.
  const deadline = Date.now() + JOB_DEADLINE_MS;

  let cursor = resume ? await loadJob(chatId) : null;
  if (resume && !cursor) {
    await sendMessage(chatId, 'ℹ️ مفيش حاجة موقوفة أكمّلها. ابعت /run أو /preview من الأول.');
    return;
  }
  if (!cursor) {
    cursor = execute
      ? { kind: 'run', status: 'running', orderId, phase: 'shipping', processedOrderNames: [], createdShipmentIds: [], results: [], updatedAt: Date.now() }
      : { kind: 'preview', status: 'running', orderId, docStep: 0, photoIndex: 0, summaryDone: false, updatedAt: Date.now() };
  } else {
    cursor.status = 'running';
  }
  await saveJob(chatId, cursor);

  if (cursor.kind === 'run') {
    await createShipmentsForRun(chatId, cursor, deadline);
  } else {
    await sendProductionDocuments(chatId, cursor, deadline);
  }
}

async function sendProductionDocuments(chatId: number, cursor: PreviewCursor, deadline: number): Promise<void> {
  const orderId = cursor.orderId;
  const mode = 'بريفيو';
  const orderLabel = orderId ? ` (أوردر ${orderId} فقط)` : '';
  const pastDeadline = (): boolean => Date.now() >= deadline;

  // Pause helper: persist where we stopped, then offer the Continue button.
  const pause = async (progress: string): Promise<void> => {
    cursor.status = 'paused';
    await saveJob(chatId, cursor);
    await sendContinuePrompt(chatId, 'preview', progress);
  };

  // ── Step 1: Call Ayman Agent (re-fetched each segment; needed for docs+photos)
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

  if (cursor.docStep === 0 && cursor.photoIndex === 0) {
    await sendMessage(
      chatId,
      `✅ لقيت ${summary?.totalOrders ?? '?'} أوردر — ${productionEntries.length} منتج\nبدأت الإرسال...`
    );
  }

  // ── Step 2: Send Word doc (docStep 1) ──────────────────────────────────────
  if (cursor.docStep < 1) {
    if (pastDeadline()) { await pause('لسه مبدأتش أبعت المستندات.'); return; }
    const wordBuf = Buffer.from(wordBase64, 'base64');
    await sendDocument(
      chatId,
      wordBuf,
      `production_${dateStr}.docx`,
      `قائمة الإنتاج ✅ — ${productionEntries.length} منتج`
    );
    cursor.docStep = 1;
  }

  // ── Step 2b: Build + send laser AI file(s) for RDWorks (docStep 2) ─────────
  // Built here (not in the aggregator) because the welded .ai files are large and
  // would blow past the aggregator's 6 MB response limit.
  if (cursor.docStep < 2) {
    if (pastDeadline()) { await pause('باقي: الليزر + البوكس + ورق الطباعة + الصور.'); return; }
    try {
      const { buildAiBuffers, buildBoxGridBuffers } = await import('../../services/aiWriter.js');
      // Box products go to a 9×2 grid file; wallets/others stay linear.
      const isBoxEntry = (e: unknown): boolean => {
        const p = String((e as { display_product?: string })?.display_product || '').toLowerCase();
        return p.includes('box') || p.includes('بوكس');
      };
      const entries = productionEntries as unknown[];
      const linearEntries = entries.filter((e) => !isBoxEntry(e));
      const boxEntries = entries.filter(isBoxEntry);
      // Split by file size (~1.5 MB each) — the laser PC is weak, so keep files small.
      const aiFiles = linearEntries.length ? await buildAiBuffers(linearEntries as never, { maxBytes: 1_500_000 }) : [];
      const boxFiles = boxEntries.length ? await buildBoxGridBuffers(boxEntries as never) : [];
      for (let i = 0; i < aiFiles.length; i++) {
        const label = aiFiles.length > 1 ? `${i + 1}/${aiFiles.length}` : '';
        await sendDocument(chatId, aiFiles[i]!, `laser_${dateStr}_${i + 1}.ai`, `ملف الليزر 🔪 ${label}`.trim());
      }
      for (let i = 0; i < boxFiles.length; i++) {
        const label = boxFiles.length > 1 ? `${i + 1}/${boxFiles.length}` : '';
        await sendDocument(chatId, boxFiles[i]!, `box_grid_${dateStr}_${i + 1}.ai`, `شبكة البوكسات 📦 ${label}`.trim());
      }
      if (aiFiles.length || boxFiles.length)
        await sendMessage(chatId, `🔪 بعتّ ${aiFiles.length} ملف ليزر + ${boxFiles.length} شبكة بوكسات`);
    } catch (err) {
      await sendMessage(chatId, `⚠️ فشل توليد ملف الليزر: ${String(err).slice(0, 200)}`);
    }
    cursor.docStep = 2;
  }

  // ── Step 2.5: Print-ready photo sheet (docStep 3) ─────────────────────────
  // The "طباعة الصور" photos (no place on the product → excluded from the laser)
  // are arranged on A4 at their per-product size and sent as one print-ready PDF.
  if (cursor.docStep < 3) {
    if (pastDeadline()) { await pause('باقي: ورق الطباعة + الصور.'); return; }
    try {
      const { buildPrintSheetPdf, kindForProduct } = await import('../../services/printSheet.js');
      const printList: Array<{ url: string; kind: 'wallet' | 'keychain' }> = [];
      const seenPrint = new Set<string>();
      for (const entry of productionEntries) {
        const kind = kindForProduct(entry.display_product);
        for (const ph of entry.photo_attachments ?? []) {
          if ((ph.position_label ?? '').trim()) continue; // has a place -> laser, not print
          if (!ph.attachment_url || seenPrint.has(ph.attachment_url)) continue;
          seenPrint.add(ph.attachment_url);
          printList.push({ url: ph.attachment_url, kind });
        }
      }
      if (printList.length) {
        const photos: Array<{ buffer: Buffer; kind: 'wallet' | 'keychain' }> = [];
        for (const p of printList) {
          const r = await fetch(p.url);
          if (r.ok) photos.push({ buffer: Buffer.from(await r.arrayBuffer()), kind: p.kind });
        }
        const pdf = await buildPrintSheetPdf(photos);
        if (pdf) {
          await sendDocument(chatId, Buffer.from(pdf), `print_sheets_${dateStr}.pdf`, 'ورق طباعة الصور 🖨️');
        }
      }
    } catch (err) {
      await sendMessage(chatId, `⚠️ فشل توليد ورق الطباعة: ${String(err).slice(0, 200)}`);
    }
    cursor.docStep = 3;
  }

  // ── Step 3: Send photos individually (resumable via photoIndex) ────────────
  // Caption format the factory needs: "#orderNumber — productName color".
  // We carry the entry's product/color (not the attachment filename, which is
  // a generic "صورة الطبعة") so each photo is identifiable.
  const allPhotoAttachments: Array<{ url: string; orderName: string; product: string }> = [];
  for (const entry of productionEntries) {
    const product = `${entry.display_product}${entry.display_color ? ` ${entry.display_color}` : ''}`.trim();
    for (const ph of entry.photo_attachments ?? []) {
      if (ph.attachment_url) {
        allPhotoAttachments.push({ url: ph.attachment_url, orderName: ph.order_name, product });
      }
    }
  }
  const seenUrls = new Set<string>();
  const uniquePhotos = allPhotoAttachments.filter((p) => {
    if (seenUrls.has(p.url)) return false;
    seenUrls.add(p.url);
    return true;
  });

  if (cursor.photoIndex < uniquePhotos.length) {
    await sendMessage(
      chatId,
      cursor.photoIndex === 0
        ? `📷 جاري إرسال ${uniquePhotos.length} صورة...`
        : `📷 بكمّل الصور من رقم ${cursor.photoIndex + 1} من ${uniquePhotos.length}...`
    );
    const photoFailures: string[] = [];
    for (let i = cursor.photoIndex; i < uniquePhotos.length; i++) {
      if (pastDeadline()) {
        cursor.photoIndex = i; // resume from this photo next time
        await pause(`اتبعت ${i} من ${uniquePhotos.length} صورة.`);
        return;
      }
      const photo = uniquePhotos[i]!;
      try {
        const photoResp = await fetch(photo.url);
        if (photoResp.ok) {
          const photoBuf = Buffer.from(await photoResp.arrayBuffer());
          const rawExt = new URL(photo.url).pathname.split('.').pop() ?? 'jpg';
          const ext = rawExt.length <= 5 ? rawExt : 'jpg';
          const safeName = photo.orderName.replace(/[^a-zA-Z0-9_-]/g, '_');
          await sendDocument(chatId, photoBuf, `${safeName}_photo_${i + 1}.${ext}`, `${photo.orderName} — ${photo.product}`);
        } else {
          photoFailures.push(`${photo.orderName}: HTTP ${photoResp.status}`);
        }
      } catch (err) {
        photoFailures.push(`${photo.orderName}: ${String(err).slice(0, 80)}`);
      }
    }
    cursor.photoIndex = uniquePhotos.length;
    if (photoFailures.length > 0) {
      await sendMessage(chatId, `⚠️ فشل إرسال ${photoFailures.length} صورة:\n${photoFailures.slice(0, 5).join('\n')}`);
    }
  }

  // ── Step 4: Summary docs (orders-summary + production summary), sent once ──
  if (!cursor.summaryDone) {
    if (pastDeadline()) { await pause('باقي: ملف "تجميعة بالأوردر" + الملخص النهائي.'); return; }
    // Per-order summary doc (customer + photos embedded) — built here so embedded
    // photos never hit the 6 MB cap; image size is bounded inside the builder.
    try {
      const detail = aymanData.ordersDetail ?? [];
      if (detail.length) {
        const { buildOrdersSummaryBuffer } = await import('../../services/orderSummaryWriter.js');
        const ordersBuf = await buildOrdersSummaryBuffer(detail as never);
        await sendDocument(chatId, ordersBuf, `orders_${dateStr}.docx`, 'تجميعة بالأوردر 📋');
      }
    } catch (err) {
      await sendMessage(chatId, `⚠️ فشل توليد ملف الأوردرات: ${String(err).slice(0, 200)}`);
    }

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
    cursor.summaryDone = true;
  }

  // Everything sent — clear the checkpoint so the next /preview starts fresh.
  await sendMessage(chatId, `✅ التجميعة كاملة اتبعتت. 🔒 بريفيو فقط — مش اتعملت أي شحنة.`);
  await clearJob(chatId);
}

// Business-critical: create the Telegraph shipments for confirmed orders. Called
// FIRST in runPipeline (execute mode) so the 300s function limit can only ever
// truncate the regenerable documents, never the shipments.
async function createShipmentsForRun(chatId: number, cursor: RunCursor, deadline: number): Promise<void> {
  const orderId = cursor.orderId;
  const pastDeadline = (): boolean => Date.now() >= deadline;
  // Pause helper: persist accumulated progress, then offer the Continue button.
  const pause = async (progress: string): Promise<void> => {
    cursor.status = 'paused';
    await saveJob(chatId, cursor);
    await sendContinuePrompt(chatId, 'run', progress);
  };

  // ── Safety gate ────────────────────────────────────────────────────────────
  if (process.env.TELEGRAPH_ENABLED?.trim().toLowerCase() !== 'true') {
    await sendMessage(
      chatId,
      '⛔ TELEGRAPH\\_ENABLED مش مفعّل في الـ .env\nعدّل الـ .env في Vercel وأعد المحاولة.',
      { parse_mode: 'Markdown' }
    );
    await clearJob(chatId);
    return;
  }

  // ── Shipping phase (resumable via processedOrderNames) ─────────────────────
  if (cursor.phase === 'shipping') {
    const resuming = cursor.processedOrderNames.length > 0;
    await sendMessage(chatId, resuming ? `🚚 بكمّل الشحن...` : `🚚 جاري جلب الأوردرات للشحن...`);

    const { shopifyOrdersClient } = await import('../../shopify/shopifyOrdersClient.js');
    let allOrders: ShopifyOrder[];
    try {
      const query = orderId
        ? `name:#${orderId.replace(/^#/, '')} tag:confirmed fulfillment_status:unfulfilled`
        : 'tag:confirmed fulfillment_status:unfulfilled';
      allOrders = await shopifyOrdersClient.listRecentOrders(250, query);
    } catch (err) {
      // Transient fetch failure → keep progress and let the user retry via Continue.
      await sendMessage(chatId, `❌ فشل في جلب الأوردرات للشحن: ${String(err).slice(0, 200)}`);
      await pause('فشل جلب الأوردرات — دوس إكمال أحاول تاني.');
      return;
    }

    // Skip orders already handled in a previous segment (belt-and-suspenders:
    // shipped ones also drop out of the unfulfilled query on their own).
    const orders = allOrders
      .filter((o) => !o.test)
      .filter((o) => !cursor.processedOrderNames.includes(o.name));

    if (!orders.length && !cursor.processedOrderNames.length && !cursor.createdShipmentIds.length) {
      await sendMessage(chatId, '✅ مفيش أوردرات confirmed للشحن دلوقتي.');
      await clearJob(chatId);
      return;
    }

    if (orders.length) {
      await sendMessage(chatId, `🚚 ${resuming ? 'باقي' : 'بدأ الشحن —'} ${orders.length} أوردر...`);

      // Dynamic import so Prisma only loads when actually shipping
      const { createAppServices } = await import('../../app.js');
      const { shopifyOrderProcessor } = createAppServices();

      for (let idx = 0; idx < orders.length; idx++) {
        if (pastDeadline()) {
          await pause(`اتعامل مع ${cursor.processedOrderNames.length} أوردر — فاضل ${orders.length - idx}.`);
          return;
        }
        const order = orders[idx]!;
        try {
          const result = await shopifyOrderProcessor.process(order, {
            source: 'telegram-bot',
            skipEligibility: false,
          });
          // Telegraph's print page resolves shipments by their NUMERIC id — collect
          // ids (from new and already-shipped orders) for the waybill URL.
          if (result.accurateShipmentId) cursor.createdShipmentIds.push(result.accurateShipmentId);
          if (result.skipped) {
            const reason = result.reason ?? 'skipped';
            cursor.results.push({ orderName: order.name, ok: true, reason });
            await sendMessage(chatId, `⏭️ ${order.name} — تم تخطيه: ${reason}`);
          } else {
            cursor.results.push({ orderName: order.name, ok: true });
            await sendMessage(chatId, `✅ ${order.name} — تم الشحن بنجاح`);
          }
        } catch (err) {
          const errMsg = String(err).slice(0, 200);
          cursor.results.push({ orderName: order.name, ok: false, reason: errMsg });
          await sendMessage(chatId, `❌ ${order.name} — فشل: ${errMsg}`);
        }
        cursor.processedOrderNames.push(order.name);
      }
    }

    cursor.phase = 'finalize';
    await saveJob(chatId, cursor);
  }

  // ── Finalize: waybill link + final report (from accumulated cursor data) ───
  // Deterministic print URL (just shipment ids joined) — can never fail to build
  // and opens Telegraph's own print page where the user is already logged in.
  const uniqueShipmentIds = [...new Set(cursor.createdShipmentIds)];
  if (uniqueShipmentIds.length > 0) {
    const idsParam = uniqueShipmentIds.join(',');
    const printUrl = `https://system.telegraphex.com/print/waybill/shipment/A4/3d/${idsParam}`;
    await sendMessage(
      chatId,
      `🖨️ *بوالص الشحن (${uniqueShipmentIds.length}):*\n${printUrl}\n\n` +
        `افتح اللينك ← هيفتح صفحة الطباعة الرسمية ← اطبع أو احفظ PDF (Ctrl+P).`,
      { parse_mode: 'Markdown' }
    );
  } else {
    await sendMessage(
      chatId,
      'ℹ️ مفيش بوالص للطباعة — يا إما مفيش أوردرات جاهزة، يا إما كلها اتشحنت ومالهاش كود شحنة محفوظ.'
    );
  }

  const succeeded = cursor.results.filter((r) => r.ok);
  const failed = cursor.results.filter((r) => !r.ok);
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

  // Done — clear the checkpoint so the next /run starts fresh.
  await clearJob(chatId);
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
