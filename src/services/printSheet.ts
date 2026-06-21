/**
 * Print-ready photo sheet — TS port of the Python `print_layout.py`.
 *
 * Arranges the "طباعة الصور" print photos (the ones with NO place on the product,
 * so excluded from the laser) onto A4 sheets at their per-product size:
 *   photo keychain : inner 39.3x49.8mm  frame 42.0x55.7mm  (smaller)
 *   wallet         : inner 52.4x75.8mm  frame 66.0x85.7mm  (bigger)
 * Each photo is cropped to fill its inner size, drawn centred inside its outer
 * frame (white margin), wrapped in a dotted cut frame, and packed with a skyline
 * bin-packer so a sheet is used to the max (sizes mixed on one page).
 */
import Jimp from "jimp";
import { PDFDocument } from "pdf-lib";

const DPI = 300;
const MM = DPI / 25.4; // px per mm @300 DPI

const A4_W_MM = 210.0;
const A4_H_MM = 297.0;
const MARGIN_MM = 3.0;

const FRAME_COLOR = Jimp.rgbaToInt(60, 60, 60, 255);
const FRAME_DASH_MM = 1.2;
const FRAME_GAP_MM = 1.0;
const FRAME_WIDTH_PX = 2;

// kind -> [innerW, innerH, cellW, cellH] in mm
const SIZES: Record<string, [number, number, number, number]> = {
  keychain: [39.3, 49.8, 42.0, 55.7],
  wallet: [52.4, 75.8, 66.0, 85.7],
};

export type PrintKind = "wallet" | "keychain";
export interface PrintPhoto {
  buffer: Buffer;
  kind: PrintKind;
}

const px = (mm: number): number => Math.round(mm * MM);

export function kindForProduct(product: string): PrintKind {
  const p = (product || "").toLowerCase();
  if (["keychain", "key chain", "ميدالية", "ميداليه"].some((k) => p.includes(k))) return "keychain";
  return "wallet";
}

// ── skyline bin-packing (bottom-left), mirrors print_layout._skyline_pack ─────
type Seg = { x: number; w: number; y: number };
interface Item { idx: number; iw: number; ih: number; cw: number; ch: number }
type Placed = { item: Item; x: number; y: number };

function skylinePack(items: Item[], W: number, H: number): Placed[][] {
  const pages: Placed[][] = [];
  let placements: Placed[] = [];
  let sky: Seg[] = [{ x: 0, w: W, y: 0 }];

  const findPos = (w: number): [number, number] | null => {
    let best: [number, number] | null = null; // [y, x]
    for (let i = 0; i < sky.length; i++) {
      const x = sky[i]!.x;
      let total = 0, y = 0, j = i;
      while (j < sky.length && total < w - 1e-6) {
        total += sky[j]!.w;
        y = Math.max(y, sky[j]!.y);
        j++;
      }
      if (total >= w - 1e-6 && (best === null || y < best[0] - 1e-6 || (Math.abs(y - best[0]) < 1e-6 && x < best[1]))) {
        best = [y, x];
      }
    }
    return best;
  };

  const raiseSky = (x: number, w: number, top: number): void => {
    const xe = x + w;
    const next: Seg[] = [];
    for (const s of sky) {
      const sxe = s.x + s.w;
      if (sxe <= x + 1e-9 || s.x >= xe - 1e-9) { next.push(s); continue; }
      if (s.x < x) next.push({ x: s.x, w: x - s.x, y: s.y });
      const ms = Math.max(s.x, x), me = Math.min(sxe, xe);
      next.push({ x: ms, w: me - ms, y: top });
      if (sxe > xe) next.push({ x: xe, w: sxe - xe, y: s.y });
    }
    const merged: Seg[] = [];
    for (const seg of next) {
      const last = merged[merged.length - 1];
      if (last && Math.abs(last.y - seg.y) < 1e-6 && Math.abs(last.x + last.w - seg.x) < 1e-6) {
        last.w += seg.w;
      } else merged.push({ ...seg });
    }
    sky = merged;
  };

  for (const it of items) {
    let pos = findPos(it.cw);
    if (pos === null || pos[0] + it.ch > H + 1e-6) {
      pages.push(placements);
      placements = [];
      sky = [{ x: 0, w: W, y: 0 }];
      pos = findPos(it.cw) ?? [0, 0];
    }
    const [y, x] = pos;
    placements.push({ item: it, x, y });
    raiseSky(x, it.cw, y + it.ch);
  }
  if (placements.length) pages.push(placements);
  return pages;
}

function drawDottedRect(img: Jimp, x0: number, y0: number, x1: number, y1: number): void {
  const dash = px(FRAME_DASH_MM), gap = px(FRAME_GAP_MM), step = dash + gap;
  const dot = (x: number, y: number) => {
    for (let wx = 0; wx < FRAME_WIDTH_PX; wx++) {
      for (let wy = 0; wy < FRAME_WIDTH_PX; wy++) {
        const px2 = x + wx, py2 = y + wy;
        if (px2 >= 0 && py2 >= 0 && px2 < img.bitmap.width && py2 < img.bitmap.height) {
          img.setPixelColor(FRAME_COLOR, px2, py2);
        }
      }
    }
  };
  for (let x = x0; x < x1; x += step) for (let d = 0; d < dash && x + d < x1; d++) { dot(x + d, y0); dot(x + d, y1); }
  for (let y = y0; y < y1; y += step) for (let d = 0; d < dash && y + d < y1; d++) { dot(x0, y + d); dot(x1, y + d); }
}

/** Build a print-ready A4 PDF (one or more pages) from the print photos. */
export async function buildPrintSheetPdf(photos: PrintPhoto[]): Promise<Uint8Array | null> {
  if (!photos.length) return null;

  const items: Item[] = photos.map((p, idx) => {
    const [iw, ih, cw, ch] = SIZES[p.kind]!;
    return { idx, iw, ih, cw, ch };
  });
  // tall (wallet) first so short keychains fill the gaps beside them
  items.sort((a, b) => (b.ch - a.ch) || (b.cw - a.cw));

  const pages = skylinePack(items, A4_W_MM - 2 * MARGIN_MM, A4_H_MM - 2 * MARGIN_MM);
  const pageW = px(A4_W_MM), pageH = px(A4_H_MM);

  const pdf = await PDFDocument.create();
  const A4_PT: [number, number] = [595.28, 841.89];

  for (const placed of pages) {
    const canvas = new Jimp(pageW, pageH, 0xffffffff);
    for (const { item, x, y } of placed) {
      const photo = await Jimp.read(photos[item.idx]!.buffer);
      photo.cover(px(item.iw), px(item.ih)); // crop-to-fill, centred
      const cellX = px(MARGIN_MM + x), cellY = px(MARGIN_MM + y);
      const ox = cellX + px((item.cw - item.iw) / 2);
      const oy = cellY + px((item.ch - item.ih) / 2);
      canvas.composite(photo, ox, oy);
      drawDottedRect(canvas, cellX, cellY, cellX + px(item.cw), cellY + px(item.ch));
    }
    const pngBuf = await canvas.getBufferAsync(Jimp.MIME_PNG);
    const pngImg = await pdf.embedPng(pngBuf);
    const page = pdf.addPage(A4_PT);
    page.drawImage(pngImg, { x: 0, y: 0, width: A4_PT[0], height: A4_PT[1] });
  }

  return pdf.save();
}
