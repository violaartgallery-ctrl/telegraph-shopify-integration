/**
 * Passport holder, purse (بورتفيه) and purse box laser files, laid out like the
 * factory's daily production files passport.rld, port sada.rld, port mandila.rld
 * and box port.rld (port of piece_writer.py). Each set is the factory's set (stitch
 * holes, cut lines, decorated pattern; traced deer logo, knot band, mandala) with
 * a "1 X <PRODUCT> <COLOUR>" title and each customisation where the factory puts it:
 *   passport  برا شمال / برا يمين: middle of the cover's left / right half (knot:
 *             bottom corners under the band; decorated: none); جوا شمال / يمين: inside
 *   purse     برا: centred low on the cover (mandala: bottom right corner); جوا: the
 *             inner pocket's bottom right
 *   purse box the writing / photo centred above the logo
 */
import { ensureHB } from "../aiWriter.js";
import { PIECE_TEMPLATES } from "./laserAssets.js";
import {
  BED_H_MM, BED_W_MM, bounds, contoursGeom, type LaserOp, MM, type MultiPoly, pagesByColour, placeAt, type RGB, scale,
  TAN, TITLE_GAP_MM, TITLE_H_MM, translate, writeLaserAi,
} from "./laserCore.js";
import { entryColor, entryPieces, type LaserEntry, partFields, partPhotos, sourcesOf } from "./laserRouting.js";
import { titleGeom, type Zone } from "./laserText.js";
import { cleanValue, zoneOps } from "./walletFile.js";

export type PieceProduct = "passport" | "purse" | "purse_box";
const GAP_MM = 10.0;
const MARGIN_MM = 10.0;

type PieceZone = Zone & { piece: string };
const COVER = { line_h: 22.0, max_h: 40.0, align: "centre", cy: 71.0, photo_h: 90.0 } as const;
const CORNER = { line_h: 16.0, max_h: 30.0, bottom: 4.0, photo_h: 55.0 } as const;
const INSIDE = { line_h: 16.0, bottom: 3.5 } as const;
// mm from the bottom-left of their piece, measured from the factory files' customer writing.
const ZONES: Record<PieceProduct, Record<string, Record<string, PieceZone>>> = {
  passport: {
    blank: {
      cover_left: { piece: "cover", x: [6.0, 86.0], ...COVER },
      cover_right: { piece: "cover", x: [106.0, 186.0], ...COVER },
    },
    knot: {
      cover_left: { piece: "cover", x: [5.0, 76.0], align: "left", ...CORNER },
      cover_right: { piece: "cover", x: [116.0, 187.0], align: "right", ...CORNER },
    },
    decorated: {},
    "*": {
      inner_left: { piece: "inner", x: [5.0, 80.0], max_h: 34.0, align: "left", photo_h: 95.0, centre_multi: true, ...INSIDE },
      inner_right: { piece: "inner", x: [100.0, 161.0], max_h: 26.0, align: "right", photo_h: 60.0, ...INSIDE },
    },
  },
  purse: {
    blank: { cover: { piece: "cover", x: [10.0, 182.0], line_h: 20.0, max_h: 40.0, align: "centre", bottom: 6.0, photo_h: 66.0 } },
    mandala: { cover: { piece: "cover", x: [128.0, 188.0], line_h: 16.0, max_h: 24.0, align: "right", bottom: 5.0, photo_h: 36.0 } },
    "*": { inner: { piece: "inner", x: [108.0, 190.0], line_h: 15.0, max_h: 32.0, align: "right", bottom: 4.5, photo_h: 48.0 } },
  },
  purse_box: {
    "*": { front: { piece: "front", x: [24.0, 226.0], line_h: 30.0, max_h: 64.0, align: "centre", cy: 61.0, photo_h: 69.0 } },
  },
};
const MODEL_ORDER: Record<PieceProduct, string[]> = {
  passport: ["blank", "knot", "decorated"], purse: ["blank", "mandala"], purse_box: ["plain"],
};
const DEFAULT_TITLE: Record<PieceProduct, string> = { passport: "Cover passport", purse: "Purse", purse_box: "Gift purse box" };

const fills = new Map<string, MultiPoly | null>();
function fillGeom(product: PieceProduct, model: string, key: string): MultiPoly | null {
  const k = `${product}/${model}/${key}`;
  if (!fills.has(k)) fills.set(k, contoursGeom(PIECE_TEMPLATES[product][model].fills[key] ?? []));
  return fills.get(k)!;
}

export function pieceModel(product: PieceProduct, e: LaserEntry): string {
  const p = (e.display_product || "").toLowerCase();
  if (product === "passport") {
    if (p.includes("decorated") || p.includes("مزخرف")) return "decorated";
    return p.includes("lines") || p.includes("knot") || p.includes("ضفير") ? "knot" : "blank";
  }
  if (product === "purse") return ["mandela", "mandala", "ماندالا", "مندالا"].some((k) => p.includes(k)) ? "mandala" : "blank";
  return "plain";
}

function zonesOf(product: PieceProduct, model: string): Record<string, PieceZone> {
  return { ...(ZONES[product]["*"] ?? {}), ...(ZONES[product][model] ?? {}) };
}

export function pieceZoneFor(product: PieceProduct, model: string, label: unknown): string | null {
  if (product === "purse_box") return "front";
  const s = String(label ?? "");
  const side = s.includes("جوا") || s.includes("جوه") ? "جوا" : s.includes("برا") || s.includes("بره") ? "برا" : null;
  let zone: string | null;
  if (product === "purse") zone = side === "جوا" ? "inner" : side === "برا" ? "cover" : null;
  else {
    const lr = s.includes("يمي") ? "يمين" : s.includes("شمال") ? "شمال" : null;
    zone = side === "جوا" ? (lr === "يمين" ? "inner_right" : "inner_left")
      : side === "برا" ? (lr === "شمال" ? "cover_left" : "cover_right") : null;
  }
  return zone && zone in zonesOf(product, model) ? zone : null;
}

interface Item {
  product: PieceProduct; model: string; color: string; order: string | null; title: string;
  texts: Record<string, string[]>; photos: Record<string, Buffer>; markers: Record<string, string[]>;
}

function items(product: PieceProduct, entries: LaserEntry[], photos: Map<string, Buffer>): Item[] {
  const out: Item[] = [];
  for (const e of entries) {
    if (!entryPieces(e).has(product)) continue;
    const model = pieceModel(product, e);
    const texts: Record<string, string[]> = {};
    for (const [label, value] of partFields(e, product)) {
      const [, s] = cleanValue(value);
      if (!s) continue;
      const zone = pieceZoneFor(product, model, label);
      if (!zone) { console.warn(`[laser] ${product} (${model}): no writing place for "${label}" — not engraved.`); continue; }
      (texts[zone] ??= []).push(s);
    }
    const byOrder = new Map<string | null, Record<string, Buffer>>();
    const markers = new Map<string | null, Record<string, string[]>>();
    for (const p of partPhotos(e, product)) {
      const zone = pieceZoneFor(product, model, p.position_label);
      const k = p.order_name ?? null;
      if (!zone) { console.warn(`[laser] ${product} ${k} (${model}): no place for ${p.display_label} — not engraved.`); continue; }
      const buf = p.attachment_url ? photos.get(p.attachment_url) : undefined;
      if (buf) {
        if (!byOrder.has(k)) byOrder.set(k, {});
        byOrder.get(k)![zone] ??= buf;
      } else {
        if (!markers.has(k)) markers.set(k, {});
        (markers.get(k)![zone] ??= []).push(p.display_label ?? "photo");
      }
    }
    for (const { order, qty } of sourcesOf(e)) {
      for (let i = 0; i < qty; i++) {
        out.push({ product, model, color: entryColor(e), order, title: e.display_product || DEFAULT_TITLE[product],
          texts, photos: byOrder.get(order) ?? {}, markers: markers.get(order) ?? {} });
      }
    }
  }
  return out;
}

/** [cellW, cellH, cols, rows]: one set + its title, and how many fit the bed. */
export function pieceCell(product: PieceProduct): [number, number, number, number] {
  const sizes = Object.values(PIECE_TEMPLATES[product]).map((m: any) => m.size as [number, number]);
  const w = Math.max(...sizes.map((s) => s[0]));
  const h = Math.max(...sizes.map((s) => s[1])) + TITLE_GAP_MM + TITLE_H_MM;
  const cols = Math.max(1, Math.floor((BED_W_MM - 2 * MARGIN_MM + GAP_MM) / (w + GAP_MM)));
  const rows = Math.max(1, Math.floor((BED_H_MM - 2 * MARGIN_MM + GAP_MM) / (h + GAP_MM)));
  return [w, h, cols, rows];
}

async function setOps(it: Item, ox: number, oy: number): Promise<LaserOp[]> {
  const tpl = PIECE_TEMPLATES[it.product][it.model];
  const ops: LaserOp[] = [];
  for (const s of tpl.strokes as Array<{ rgb: number[]; paths: number[][][] }>) {
    const color = s.rgb.map((v) => v / 255) as RGB;
    for (const p of s.paths) ops.push({ t: "stroke", pts: p.map(([x, y]) => [(ox + x!) * MM, (oy + y!) * MM] as [number, number]), color });
  }
  for (const key of Object.keys(tpl.fills)) {
    const g = fillGeom(it.product, it.model, key);
    if (g) ops.push({ t: "fill", geom: translate(scale(g, MM), ox * MM, oy * MM), color: TAN });
  }
  const [setW, setH] = tpl.size as [number, number];
  const title = titleGeom(it.title, it.color, setW);
  if (title) {
    const tw = bounds(title)[2] / MM;
    ops.push({ t: "fill", geom: placeAt(title, (ox + (setW - tw) / 2) * MM, (oy + setH + TITLE_GAP_MM) * MM), color: TAN });
  }
  for (const [zname, z] of Object.entries(zonesOf(it.product, it.model))) {
    const [px0, py0] = tpl.pieces[z.piece] as [number, number];
    const zone: Zone = { ...z, x: [px0 + z.x[0], px0 + z.x[1]] };
    if (z.bottom !== undefined) zone.bottom = py0 + z.bottom; else zone.cy = py0 + z.cy!;
    ops.push(...(await zoneOps(`${it.product} ${it.order}`, zname, zone, it.texts[zname] ?? [], it.photos[zname] ?? null,
      it.markers[zname] ?? [], ox, oy)));
  }
  return ops;
}

/** Laser files for one product, as many sets per file as fit the bed. */
export async function buildPieceFiles(product: PieceProduct, entries: LaserEntry[],
  photos: Map<string, Buffer> = new Map()): Promise<Buffer[]> {
  await ensureHB();
  const order = MODEL_ORDER[product];
  const its = items(product, entries, photos).sort((a, b) => order.indexOf(a.model) - order.indexOf(b.model));
  const [cellW, cellH, maxCols, maxRows] = pieceCell(product);
  const out: Buffer[] = [];
  for (const rows of pagesByColour(its, maxCols, maxRows)) {
    const cols = Math.max(...rows.map((r) => r.length));
    const totalW = (2 * MARGIN_MM + cols * cellW + (cols - 1) * GAP_MM) * MM;
    const totalH = (2 * MARGIN_MM + rows.length * cellH + (rows.length - 1) * GAP_MM) * MM;
    const ops: LaserOp[] = [];
    for (let r = 0; r < rows.length; r++) for (let c = 0; c < rows[r]!.length; c++) {
      ops.push(...(await setOps(rows[r]![c]!, MARGIN_MM + c * (cellW + GAP_MM), MARGIN_MM + (rows.length - 1 - r) * (cellH + GAP_MM))));
    }
    out.push(writeLaserAi(ops, totalW, totalH));
  }
  return out;
}
