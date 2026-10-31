/**
 * Medallion laser files (port of ai_writer.py's keychain section). Geometry is
 * Ayman's galgol.rld: the 3 leather pieces (cut, black), the stitch holes (red)
 * and the engrave zones on the main piece. The main piece folds at its slots, so
 * its two ends are the medallion's two faces: one text goes on the bottom end,
 * the other side's text on the top end rotated 180 so it reads upright once
 * folded. The customer's photo takes the bottom end. Up to 15 per file, each
 * colour starting its own row; plain medallions are included so they get cut.
 */
import { ensureHB } from "../aiWriter.js";
import { KEYCHAIN_TEMPLATE } from "./laserAssets.js";
import {
  CUT, type LaserOp, MM, pagesByColour, PT_SCALE, type RGB, rotate180, TAN, TITLE_GAP_MM, TITLE_H_MM, translate,
  bounds, cappedFiles,
} from "./laserCore.js";
import { prepPhotoRaster } from "./laserPhoto.js";
import { cleanText, entryColor, entryPieces, type LaserEntry, partFields, partPhotos, sourcesOf } from "./laserRouting.js";
import { keychainTextBlock, titleGeom } from "./laserText.js";

const PER_FILE = 15;
const GAP_MM = 10.0;
const MARGIN_MM = 10.0;
const MAX_COLS = 9;
const MAX_ROWS = 4;
const RED: RGB = [1.0, 0.11, 0.0];                 // galgol.rld's stitch red
const TEXT_MAX_H_MM = 24.0;
const PHOTO_W_MM = 44.0, PHOTO_H_MM = 46.0;          // as the factory's production files
const PHOTO_CY_MM = -60.0, PHOTO_BOTTOM_MM = -75.0;
const TOP_MARKERS = ["فوق", "الناحية التانية", "الناحيه التانيه", "الناحية الثانية", "ضهر", "back"];

/** [bottom, top] engraving text: a field labelled as the other side goes on top. */
export function keychainTexts(e: LaserEntry): [string, string] {
  const bottom: string[] = [], top: string[] = [];
  for (const [label, value] of partFields(e, "keychain")) {
    const s = cleanText(value);
    if (!s) continue;
    (TOP_MARKERS.some((m) => String(label).toLowerCase().includes(m)) ? top : bottom).push(s);
  }
  return [bottom.join("  "), top.join("  ")];
}

interface Item { color: string; title: string; order: string | null; bottom: string; top: string; photo: Buffer | null }

function items(entries: LaserEntry[], photos: Map<string, Buffer>): Item[] {
  const out: Item[] = [];
  for (const e of entries) {
    if (!entryPieces(e).has("keychain")) continue;
    const [bottom, top] = keychainTexts(e);
    const byOrder = new Map<string | null, Buffer[]>();
    for (const p of partPhotos(e, "keychain")) {
      const buf = p.attachment_url ? photos.get(p.attachment_url) : undefined;
      if (!buf) continue;
      const k = p.order_name ?? null;
      if (!byOrder.has(k)) byOrder.set(k, []);
      byOrder.get(k)!.push(buf);
    }
    for (const { order, qty } of sourcesOf(e)) {
      const mine = byOrder.get(order) ?? [];
      for (let i = 0; i < qty; i++) {
        out.push({ color: entryColor(e), title: e.display_product || "Photo keychain", order, bottom, top,
          photo: mine.length ? mine[i % mine.length]! : null });
      }
    }
  }
  return out;
}

async function pageOps(rows: Item[][]): Promise<[LaserOp[], number, number]> {
  const tpl = KEYCHAIN_TEMPLATE;
  const [setW, setH] = tpl.size as [number, number];
  const [mx0, my0, mx1, my1] = tpl.main as [number, number, number, number];
  const zt = tpl.zones_rel_main_centre.text_bottom;
  const textW = Math.max(zt.w, tpl.zones_rel_main_centre.text_top.w) * MM;
  const rowH = setH + TITLE_GAP_MM + TITLE_H_MM;
  const cols = Math.max(...rows.map((r) => r.length));
  const totalW = (2 * MARGIN_MM + cols * setW + (cols - 1) * GAP_MM) * MM;
  const totalH = (2 * MARGIN_MM + rows.length * rowH + (rows.length - 1) * GAP_MM) * MM;
  const ops: LaserOp[] = [];
  for (let r = 0; r < rows.length; r++) for (let c = 0; c < rows[r]!.length; c++) {
    const it = rows[r]![c]!;
    const ox = MARGIN_MM + c * (setW + GAP_MM);
    const oy = MARGIN_MM + (rows.length - 1 - r) * (rowH + GAP_MM);
    for (const [key, color] of [["cut", CUT], ["stitch", RED]] as const) {
      for (const path of tpl[key] as number[][][]) {
        ops.push({ t: "stroke", pts: path.map(([x, y]) => [(ox + x!) * MM, (oy + y!) * MM] as [number, number]), color });
      }
    }
    const title = titleGeom(it.title, it.color, setW);
    if (title) {
      const tw = bounds(title)[2] / MM;
      ops.push({ t: "fill", geom: translate(title, (ox + (setW - tw) / 2) * MM, (oy + setH + TITLE_GAP_MM) * MM), color: TAN });
    }
    const cx = (ox + (mx0 + mx1) / 2) * MM, cy = (oy + (my0 + my1) / 2) * MM;
    let { bottom, top, photo } = it;
    if (photo && bottom && top) {
      console.warn(`[laser] Keychain ${it.order}: two texts AND a photo — photo not placed, place it by hand.`);
      photo = null;
    } else if (photo && bottom) {
      [top, bottom] = [bottom, ""];            // the photo takes the bottom face, the text the other
    }
    for (const [text, sign] of [[bottom, 1], [top, -1]] as const) {
      if (!text) continue;
      let block = keychainTextBlock(text, textW, zt.h * MM, TEXT_MAX_H_MM * MM);
      if (!block) continue;
      if (sign < 0) block = rotate180(block);
      ops.push({ t: "fill", geom: translate(block, cx + sign * zt.cx * MM, cy + sign * zt.cy * MM), color: TAN });
    }
    if (photo) {
      const zw = PHOTO_W_MM * MM * PT_SCALE, zh = PHOTO_H_MM * MM * PT_SCALE;
      const prepped = await prepPhotoRaster(photo, zw, zh).catch(() => null);
      if (prepped) {
        const s = Math.min(zw / prepped.cols, zh / prepped.rows);
        const pw = prepped.cols * s, ph = prepped.rows * s;
        const pcyMm = Math.max(PHOTO_CY_MM, PHOTO_BOTTOM_MM + ph / PT_SCALE / MM / 2);
        const pcx = cx * PT_SCALE, pcy = (cy + pcyMm * MM) * PT_SCALE;
        ops.push({ t: "raster", cols: prepped.cols, rows: prepped.rows, hex: prepped.hex, zone: [pcx - pw / 2, pcy + ph / 2, pw, ph] });
      }
    }
  }
  return [ops, totalW, totalH];
}

/** Medallion files, up to 15 medallions each. photos: attachment_url -> bytes. */
export async function buildKeychainFiles(entries: LaserEntry[], photos: Map<string, Buffer> = new Map()): Promise<Buffer[]> {
  await ensureHB();
  return cappedFiles(items(entries, photos), (part) => pagesByColour(part, MAX_COLS, MAX_ROWS, PER_FILE),
    (rows) => rows.flat(), pageOps);
}
