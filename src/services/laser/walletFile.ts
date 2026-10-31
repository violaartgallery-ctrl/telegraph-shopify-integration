/**
 * Wallet laser files, laid out like the factory's daily production .rld files
 * (port of wallet_writer.py): the face with its two pockets above it, the model's
 * decoration (lines: the knot band; decorated: the star pattern), the deer logo,
 * a "1 X <PRODUCT> <COLOUR>" title, and every customisation in its writing place:
 *   برا شمال / برا يمين on the upper face (blank wallets only); برا تحت … in the
 *   bottom corners beside the logo (the lines wallet's band covers the upper face);
 *   جوا شمال = left pocket, جوا يمين = right pocket.
 * The decorated wallet's face is all pattern, so it only takes pocket writing.
 * Each leather colour starts its own row, up to 25 wallets per file.
 */
import { ensureHB } from "../aiWriter.js";
import { WALLET_TEMPLATE } from "./laserAssets.js";
import {
  bounds, contoursGeom, CUT, type LaserOp, MM, type MultiPoly, pagesByColour, placeAt, PT_SCALE, type RGB, scale, TAN,
  TITLE_GAP_MM, TITLE_H_MM, translate, writeLaserAi,
} from "./laserCore.js";
import { prepPhotoRaster } from "./laserPhoto.js";
import { BOX_STRIP, entryColor, entryPieces, type LaserEntry, partFields, partPhotos, sourcesOf } from "./laserRouting.js";
import { fitBlock, placeBox, titleGeom, type Zone } from "./laserText.js";

const PER_FILE = 25;
const MAX_COLS = 5;                       // 5 x (230 + 10) mm fits the 1400 mm bed
const MAX_ROWS = 5;
const GAP_MM = 10.0;
const MARGIN_MM = 10.0;
const FACE_RED: RGB = [1.0, 0.0, 0.25];
const POCKET_RED: RGB = [1.0, 0.0, 0.0];
const DECO: RGB = [0.25, 0.0, 0.51];
const MODEL_ORDER = ["blank", "lines", "decorated"] as const;
type Model = (typeof MODEL_ORDER)[number];

export const WALLET_ZONES: Record<string, Zone> = {
  "برا شمال": { x: [8.0, 97.0], line_h: 20.0, max_h: 36.0, align: "centre", cy: 44.0, photo_h: 60.0 },
  "برا يمين": { x: [133.0, 222.0], line_h: 20.0, max_h: 36.0, align: "centre", cy: 44.0, photo_h: 60.0 },
  "برا تحت شمال": { x: [6.5, 92.0], line_h: 16.0, max_h: 20.0, align: "left", bottom: 6.3, photo_h: 28.0 },
  "برا تحت يمين": { x: [139.0, 223.0], line_h: 16.0, max_h: 20.0, align: "right", bottom: 6.3, photo_h: 28.0 },
  "جوا شمال": { x: [21.5, 108.5], line_h: 16.0, max_h: 44.0, align: "left", bottom: 94.5, photo_h: 48.0, centre_multi: true },
  "جوا يمين": { x: [121.5, 208.5], line_h: 16.0, max_h: 44.0, align: "right", bottom: 94.5, photo_h: 48.0, centre_multi: true },
};
// "ف النص (سندس)" / "في الطرف (عمّوري)": an old placement hint before the writing.
const HINT_RE = /^\s*(?:ف|في)\s*(النص|الطرف)\s*[(:]?\s*/;

const geoms = new Map<string, MultiPoly | null>();
function templateGeom(key: "band" | "logo"): MultiPoly | null {
  if (!geoms.has(key)) {
    const t = WALLET_TEMPLATE;
    geoms.set(key, contoursGeom(key === "band" ? t.lines_band.contours : t.logo_contours));
  }
  return geoms.get(key)!;
}

export function walletModel(e: LaserEntry): Model {
  const p = (e.display_product || "").toLowerCase();
  if (p.includes("lines")) return "lines";
  if (p.includes("decorated") || p.includes("مزخرف")) return "decorated";
  return "blank";
}

/** [hint, text]: the writing without quotes/brackets, and an old placement hint. */
export function cleanValue(value: unknown): [string, string] {
  let s = String(value ?? "");
  let hint = "";
  const m = HINT_RE.exec(s);
  if (m) { hint = m[1]!; s = s.slice(m[0].length); }
  s = [...s].filter((c) => !BOX_STRIP.has(c)).join("");
  return [hint, s.split(/\s+/).filter(Boolean).join(" ")];
}

export function walletZoneFor(label: unknown, model: Model, hint = ""): string | null {
  const s = String(label ?? "");
  const side = s.includes("جوا") || s.includes("جوه") ? "جوا" : s.includes("برا") || s.includes("بره") ? "برا" : null;
  const lr = s.includes("يمي") ? "يمين" : s.includes("شمال") ? "شمال" : null;
  if (!side || !lr) return null;
  if (side === "جوا") return `جوا ${lr}`;
  if (model === "decorated") return null;
  if (model === "lines" || s.includes("تحت") || s.includes("الطرف") || hint === "الطرف") return `برا تحت ${lr}`;
  return `برا ${lr}`;
}

interface Item {
  color: string; model: Model; order: string | null; title: string;
  texts: Record<string, string[]>; photos: Record<string, Buffer>; markers: Record<string, string[]>;
}

function items(entries: LaserEntry[], photos: Map<string, Buffer>): Item[] {
  const out: Item[] = [];
  for (const e of entries) {
    if (!entryPieces(e).has("wallet")) continue;
    const model = walletModel(e);
    const texts: Record<string, string[]> = {};
    for (const [label, value] of partFields(e, "wallet")) {
      const [hint, s] = cleanValue(value);
      if (!s) continue;
      const zone = walletZoneFor(label, model, hint);
      if (!zone) { console.warn(`[laser] Wallet (${model}): no writing place for "${label}" — not engraved.`); continue; }
      (texts[zone] ??= []).push(s);
    }
    const byOrder = new Map<string | null, Record<string, Buffer>>();
    const markers = new Map<string | null, Record<string, string[]>>();
    for (const p of partPhotos(e, "wallet")) {
      const zone = walletZoneFor(p.position_label, model);
      const k = p.order_name ?? null;
      if (!zone) { console.warn(`[laser] Wallet ${k} (${model}): no place for ${p.display_label} — not engraved.`); continue; }
      const buf = p.attachment_url ? photos.get(p.attachment_url) : undefined;
      if (buf) {
        if (!byOrder.has(k)) byOrder.set(k, {});
        byOrder.get(k)![zone] ??= buf;
      } else {               // a photo that could not be read stays a "photo N" marker in its place
        if (!markers.has(k)) markers.set(k, {});
        (markers.get(k)![zone] ??= []).push(p.display_label ?? "photo");
      }
    }
    for (const { order, qty } of sourcesOf(e)) {
      for (let i = 0; i < qty; i++) {
        out.push({ color: entryColor(e), model, order, title: e.display_product || "Wallet", texts,
          photos: byOrder.get(order) ?? {}, markers: markers.get(order) ?? {} });
      }
    }
  }
  return out;
}

async function walletOps(it: Item, ox: number, oy: number): Promise<LaserOp[]> {
  const tpl = WALLET_TEMPLATE;
  const pts = (path: number[][]) => path.map(([x, y]) => [(ox + x!) * MM, (oy + y!) * MM] as [number, number]);
  const ops: LaserOp[] = [];
  for (const [key, color] of [["cut", CUT], ["stitch_face", FACE_RED], ["stitch_pockets", POCKET_RED]] as const) {
    for (const p of tpl[key] as number[][][]) ops.push({ t: "stroke", pts: pts(p), color });
  }
  if (it.model === "decorated") for (const p of tpl.decorated_pattern as number[][][]) ops.push({ t: "stroke", pts: pts(p), color: DECO });
  for (const [key, model] of [["band", "lines"], ["logo", null]] as const) {
    if (model !== null && model !== it.model) continue;
    const g = templateGeom(key);
    if (g) ops.push({ t: "fill", geom: translate(scale(g, MM), ox * MM, oy * MM), color: TAN });
  }
  const [setW, setH] = tpl.size as [number, number];
  const title = titleGeom(it.title, it.color, setW);
  if (title) {
    const tw = bounds(title)[2] / MM;
    ops.push({ t: "fill", geom: placeAt(title, (ox + (setW - tw) / 2) * MM, (oy + setH + TITLE_GAP_MM) * MM), color: TAN });
  }
  for (const [zname, zone] of Object.entries(WALLET_ZONES)) {
    ops.push(...(await zoneOps(`Wallet ${it.order}`, zname, zone, it.texts[zname] ?? [], it.photos[zname] ?? null,
      it.markers[zname] ?? [], ox, oy)));
  }
  return ops;
}

/** The writing or photo of one place (shared with the passport / purse files). */
export async function zoneOps(
  who: string, zname: string, zone: Zone, texts: string[], photoIn: Buffer | null, markersIn: string[], ox: number, oy: number,
): Promise<LaserOp[]> {
  const text = texts.join("  ");
  let photo = photoIn, markers = markersIn;
  if (photo && text) {
    console.warn(`[laser] ${who}: writing AND a photo in ${zname} — photo left as a marker, place it by hand.`);
    markers = [...markers, "photo"];
    photo = null;
  }
  if (photo) {
    const zw = (zone.x[1] - zone.x[0]) * MM * PT_SCALE, zh = zone.photo_h * MM * PT_SCALE;
    const prepped = await prepPhotoRaster(photo, zw, zh).catch(() => null);
    if (!prepped) return [];
    const s = Math.min(zw / prepped.cols, zh / prepped.rows);
    const pw = prepped.cols * s, ph = prepped.rows * s;
    const [bx, by] = placeBox(pw / MM / PT_SCALE, ph / MM / PT_SCALE, 2, zone, ox, oy);
    return [{ t: "raster", cols: prepped.cols, rows: prepped.rows, hex: prepped.hex,
      zone: [bx * MM * PT_SCALE, by * MM * PT_SCALE + ph, pw, ph] }];
  }
  if (!text && !markers.length) return [];
  const [block, n] = fitBlock(text, markers, zone);
  if (!block) return [];
  const [minx, miny, maxx, maxy] = bounds(block);
  const [bx, by] = placeBox((maxx - minx) / MM, (maxy - miny) / MM, n, zone, ox, oy);
  return [{ t: "fill", geom: placeAt(block, bx * MM, by * MM), color: TAN }];
}

/** Wallet files, up to 25 wallets each. photos: attachment_url -> bytes. */
export async function buildWalletFiles(entries: LaserEntry[], photos: Map<string, Buffer> = new Map()): Promise<Buffer[]> {
  await ensureHB();
  const its = items(entries, photos).sort((a, b) => MODEL_ORDER.indexOf(a.model) - MODEL_ORDER.indexOf(b.model));
  const pages = pagesByColour(its, MAX_COLS, MAX_ROWS, PER_FILE);
  const [setW, setH] = WALLET_TEMPLATE.size as [number, number];
  const rowH = setH + TITLE_GAP_MM + TITLE_H_MM;
  const out: Buffer[] = [];
  for (const rows of pages) {
    const cols = Math.max(...rows.map((r) => r.length));
    const totalW = (2 * MARGIN_MM + cols * setW + (cols - 1) * GAP_MM) * MM;
    const totalH = (2 * MARGIN_MM + rows.length * rowH + (rows.length - 1) * GAP_MM) * MM;
    const ops: LaserOp[] = [];
    for (let r = 0; r < rows.length; r++) for (let c = 0; c < rows[r]!.length; c++) {
      ops.push(...(await walletOps(rows[r]![c]!, MARGIN_MM + c * (setW + GAP_MM),
        MARGIN_MM + (rows.length - 1 - r) * (rowH + GAP_MM))));
    }
    out.push(writeLaserAi(ops, totalW, totalH));
  }
  return out;
}
