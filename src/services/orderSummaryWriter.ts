/**
 * Per-order summary Word document (grouped by order, oldest -> newest).
 *
 * Unlike the production list (grouped by product, no customer data), THIS doc
 * intentionally shows order number + customer name + the customer's uploaded
 * photos embedded inline. Built in the bot (not the aggregator) so embedded
 * images never hit the aggregator's 6 MB response limit.
 */
import { BorderStyle, Document, ImageRun, Packer, Paragraph, TextRun } from "docx";

const DEFAULT_FONT = "Calibri";
const ARABIC_FONT = "DecoType Thuluth II";
const FONT_SIZE = 28; // 14pt (half-points)

interface OrderDetailItem {
  product: string;
  color: string;
  variant: string;
  quantity: number;
  customizations: Array<[string, string]>;
  photo_urls: string[];
}
export interface OrderDetail {
  order_name: string;
  customer: string;
  created_at: string;
  items: OrderDetailItem[];
}

const COLOR_MAP: Record<string, string> = {
  black: "1A1A1A", brown: "6B3A2A", "dark brown": "5C2E1E", "dark navy": "0D1B6E",
  navy: "0D1B6E", havan: "8B6214", green: "1B5E20", maroon: "7B0026", red: "C62828",
  beige: "B89660",
};
const getColor = (c: string): string | undefined => COLOR_MAP[(c ?? "").toLowerCase().trim()];

const containsArabic = (t: string): boolean => /[؀-ۿ]/.test(t);

function para(text = "", opts: { bold?: boolean; indent?: number; color?: string; size?: number } = {}): Paragraph {
  const arabic = containsArabic(text);
  return new Paragraph({
    bidirectional: arabic,
    indent: opts.indent ? { left: opts.indent } : undefined,
    children: [new TextRun({
      text, bold: opts.bold, size: opts.size ?? FONT_SIZE,
      font: arabic ? ARABIC_FONT : DEFAULT_FONT, color: opts.color, rightToLeft: arabic,
    })],
  });
}

function divider(): Paragraph {
  return new Paragraph({ border: { bottom: { color: "AAAAAA", space: 1, style: BorderStyle.SINGLE, size: 6 } }, children: [] });
}

function shortDate(createdAt: string): string {
  if (!createdAt) return "";
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return createdAt.slice(0, 10);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getFullYear()}`;
}

// Minimal PNG/JPEG dimension reader so embedded photos keep their aspect ratio
// without pulling in an image library.
function imageMeta(buf: Buffer): { type: "png" | "jpg"; w: number; h: number } | null {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    return { type: "png", w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o + 9 < buf.length) {
      if (buf[o] !== 0xff) { o++; continue; }
      const marker = buf[o + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: "jpg", h: buf.readUInt16BE(o + 5), w: buf.readUInt16BE(o + 7) };
      }
      o += 2 + buf.readUInt16BE(o + 2);
    }
    return { type: "jpg", w: 360, h: 360 };
  }
  return null;
}

// Keep the doc small + reliable to build/upload on Netlify: bound each download
// (timeout + per-image cap) and stop embedding once the total gets large.
const FETCH_TIMEOUT_MS = 12_000;
const MAX_IMG_BYTES = 4_000_000;     // skip a single oversized image
const MAX_TOTAL_BYTES = 12_000_000;  // stop embedding past ~12 MB total

interface ImgBudget { used: number; skipped: number }

async function imageParagraph(url: string, budget: ImgBudget): Promise<Paragraph | null> {
  if (budget.used >= MAX_TOTAL_BYTES) { budget.skipped++; return null; }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let buf: Buffer;
    try {
      const resp = await fetch(url, { signal: ctrl.signal });
      if (!resp.ok) return null;
      buf = Buffer.from(await resp.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
    if (buf.length > MAX_IMG_BYTES) { budget.skipped++; return null; }
    const meta = imageMeta(buf);
    if (!meta) return null;
    budget.used += buf.length;
    const maxW = 360;
    const w = Math.min(maxW, meta.w || maxW);
    const h = Math.round(w * ((meta.h || maxW) / (meta.w || maxW)));
    return new Paragraph({
      indent: { left: 680 },
      children: [new ImageRun({ data: buf, type: meta.type, transformation: { width: w, height: h } })],
    });
  } catch {
    return null;
  }
}

export async function buildOrdersSummaryBuffer(ordersDetail: OrderDetail[]): Promise<Buffer> {
  const dd = new Date();
  const title = `Orders — ${String(dd.getDate()).padStart(2, "0")}-${String(dd.getMonth() + 1).padStart(2, "0")}-${dd.getFullYear()}`;
  const children: Paragraph[] = [para(title, { bold: true }), para()];
  const budget: ImgBudget = { used: 0, skipped: 0 };

  for (let i = 0; i < ordersDetail.length; i++) {
    const order = ordersDetail[i]!;
    if (i > 0) { children.push(divider()); children.push(para()); }

    const header = `${order.order_name} — ${order.customer}`.replace(/^[\s—]+|[\s—]+$/g, "");
    children.push(para(header || "(order)", { bold: true }));
    const ds = shortDate(order.created_at);
    if (ds) children.push(para(ds, { size: 20 }));

    for (const item of order.items) {
      const tag = (item.variant || item.color || "").trim();
      const line = `• ${item.product}${tag ? ` — ${tag}` : ""}  ×${item.quantity}`;
      children.push(para(line.trim(), { bold: true, indent: 280, color: getColor(item.color) }));

      for (const [label, value] of item.customizations) {
        const visible = String(value).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (!visible.length) continue;
        if (label) children.push(para(`${label}:`, { bold: true, indent: 680 }));
        for (const ln of visible) children.push(para(ln, { indent: 680 }));
      }

      for (const url of item.photo_urls) {
        const p = await imageParagraph(url, budget);
        if (p) children.push(p);
        else if (budget.used >= MAX_TOTAL_BYTES) {
          children.push(para("[صورة غير مدمجة — اتبعتت منفصلة]", { indent: 680, size: 18 }));
        }
      }
    }
    children.push(para());
  }

  const doc = new Document({ sections: [{ properties: {}, children }] });
  return Packer.toBuffer(doc);
}
