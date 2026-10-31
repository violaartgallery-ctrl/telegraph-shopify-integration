/**
 * Shared pieces of the laser files (medallions, wallets, passport holders, purses,
 * purse boxes, box grid) — TypeScript port of viola-production-agent's ai_writer.py
 * helpers. Geometry is in font units (MM per millimetre), y up; the .ai file is a
 * real Adobe Illustrator file so RDWorks maps every K/k colour to a layer.
 */
import * as polygonClippingNs from "polygon-clipping";
import { AI_HEAD, AI_TAIL } from "../boxAssets.js";

const pc: typeof polygonClippingNs =
  (polygonClippingNs as unknown as { default?: typeof polygonClippingNs }).default ?? polygonClippingNs;

export type Ring = [number, number][];
export type Poly = Ring[];
export type MultiPoly = Poly[];
export type RGB = [number, number, number];

export const PT_SCALE = 0.02;                       // font unit -> point
export const MM = 72.0 / (PT_SCALE * 25.4);         // font units per millimetre
export const BED_W_MM = 1400.0;
export const BED_H_MM = 900.0;
export const TITLE_H_MM = 6.0;                      // "1 X PHOTO KEYCHAIN HAVAN" above each set
export const TITLE_GAP_MM = 3.0;
export const CUT: RGB = [0, 0, 0];
export const TAN: RGB = [0.702, 0.628, 0.459];      // the factory's engrave layer (179, 160, 117)
const FRAME_LINE_MM = 0.2;

/** zone = [tx, tyTop, pw, ph] in POINTS (the raster's top-left corner and size). */
export type LaserOp =
  | { t: "stroke"; pts: Ring; color: RGB }
  | { t: "fill"; geom: MultiPoly; color: RGB }
  | { t: "raster"; cols: number; rows: number; hex: string; zone: [number, number, number, number] };

export function bounds(g: MultiPoly): [number, number, number, number] {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const poly of g) for (const ring of poly) for (const [x, y] of ring) {
    if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
  }
  return [minx, miny, maxx, maxy];
}
export function translate(g: MultiPoly, dx: number, dy: number): MultiPoly {
  return g.map((p) => p.map((r) => r.map(([x, y]) => [x + dx, y + dy] as [number, number])));
}
export function scale(g: MultiPoly, s: number): MultiPoly {
  return g.map((p) => p.map((r) => r.map(([x, y]) => [x * s, y * s] as [number, number])));
}
/** Rotate 180 degrees about the origin. */
export function rotate180(g: MultiPoly): MultiPoly {
  return g.map((p) => p.map((r) => r.map(([x, y]) => [-x, -y] as [number, number])));
}
/** Move a geometry so its bounds' bottom-left lands at (x, y) font units. */
export function placeAt(g: MultiPoly, x: number, y: number): MultiPoly {
  const [minx, miny] = bounds(g);
  return translate(g, x - minx, y - miny);
}
/** Traced contours (mm) combined even-odd, like the factory bitmap they came from. */
export function contoursGeom(contours: number[][][]): MultiPoly | null {
  const polys: MultiPoly[] = [];
  for (const c of contours) if (c.length >= 3) polys.push([[c.map(([x, y]) => [x!, y!]) as Ring]]);
  if (!polys.length) return null;
  return polys.length === 1 ? polys[0]! : (pc.xor(polys[0]!, ...polys.slice(1)) as MultiPoly);
}
export function union(geoms: MultiPoly[]): MultiPoly | null {
  const gs = geoms.filter((g) => g && g.length);
  if (!gs.length) return null;
  return gs.length === 1 ? gs[0]! : (pc.union(gs[0]!, ...gs.slice(1)) as MultiPoly);
}

function rgbToCmyk(c: RGB): [number, number, number, number] {
  const [r, g, b] = c;
  const k = 1 - Math.max(r, g, b);
  if (k >= 0.9999) return [0, 0, 0, 1];
  return [(1 - r - k) / (1 - k), (1 - g - k) / (1 - k), (1 - b - k) / (1 - k), k];
}
function aiColorCmds(c: RGB): string {
  const [cc, m, y, k] = rgbToCmyk(c);
  const s = `${cc.toFixed(4)} ${m.toFixed(4)} ${y.toFixed(4)} ${k.toFixed(4)}`;
  return `${s} k\n${s} K`;
}
function polyToAi(poly: Poly, out: string[]) {
  for (const ring of poly) {
    if (ring.length < 3) continue;
    const [x0, y0] = ring[0]!;
    out.push(`${(x0 * PT_SCALE).toFixed(2)} ${(y0 * PT_SCALE).toFixed(2)} m`);
    for (let i = 1; i < ring.length; i++) {
      const [x, y] = ring[i]!;
      out.push(`${(x * PT_SCALE).toFixed(2)} ${(y * PT_SCALE).toFixed(2)} L`);
    }
  }
  out.push("f");
}

/** One embedded raster as an Adobe XI block (the factory .ai's exact format),
 *  clipped and placed at zone = [tx, tyTop, pw, ph] points. */
function emitXiRaster(out: string[], cols: number, rows: number, hex: string, zone: [number, number, number, number]) {
  const [tx, ty, pw, ph] = zone;
  const sx = pw / cols, sy = ph / rows;
  const mat = `${sx.toFixed(6)} 0.0000 0.0000 ${sy.toFixed(6)} ${tx.toFixed(4)} ${ty.toFixed(4)}`;
  const x1 = tx + pw, yb = ty - ph;
  out.push(
    "q",
    `${tx.toFixed(4)} ${ty.toFixed(4)} m`, `${x1.toFixed(4)} ${ty.toFixed(4)} L`, `${x1.toFixed(4)} ${yb.toFixed(4)} L`,
    `${tx.toFixed(4)} ${yb.toFixed(4)} L`, `${tx.toFixed(4)} ${ty.toFixed(4)} L`, "h W n",
    "%AI5_File:", "%AI5_BeginRaster", "() 0 XG",
    `[${mat}] ${cols} ${rows} 0 Xh`,
    `[${mat}] 0 0 ${cols} ${rows} ${cols} ${rows} 8 4 0 0 0 0`,
    `%%BeginData: ${hex.length + Math.floor(hex.length / 60) + 12}`, "XI",
  );
  for (let i = 0; i < hex.length; i += 60) out.push("%" + hex.slice(i, i + 60));
  out.push("%%EndData", "XH", "%AI5_EndRaster", "N", "Q");
}

/** The draw ops as a real .ai file: strokes, then fills, then rasters. */
// Telegram takes documents up to 50 MB and an engraved photo is ~5-8 MB of hex, so a
// page whose photos pass this is split in two and laid out again.
export const LIMITS = { maxRasterBytes: 35_000_000 };

/** The .ai files of `items`, paginated by `paginate`, any page heavy with engraved
 *  photos split in two so every file stays sendable (ai_writer._capped_pages). */
export async function cappedFiles<T, P>(items: T[], paginate: (items: T[]) => P[], itemsOf: (page: P) => T[],
  pageOps: (page: P) => Promise<[LaserOp[], number, number]>): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (const page of paginate(items)) {
    const [ops, totalW, totalH] = await pageOps(page);
    const its = itemsOf(page);
    const rasterBytes = ops.reduce((n, op) => n + (op.t === "raster" ? op.hex.length : 0), 0);
    if (its.length > 1 && rasterBytes > LIMITS.maxRasterBytes) {
      const half = Math.floor(its.length / 2);
      out.push(...await cappedFiles(its.slice(0, half), paginate, itemsOf, pageOps));
      out.push(...await cappedFiles(its.slice(half), paginate, itemsOf, pageOps));
    } else out.push(writeLaserAi(ops, totalW, totalH));
  }
  return out;
}

export function writeLaserAi(ops: LaserOp[], totalW: number, totalH: number): Buffer {
  const sc = PT_SCALE;
  const W = Math.floor(totalW * sc) + 1, H = Math.floor(totalH * sc) + 1;
  const head = AI_HEAD
    .replace("%%BoundingBox:684 -299 1058 579", `%%BoundingBox:0 0 ${W} ${H}`)
    .replace("%AI5_ArtSize: 612 792 ", `%AI5_ArtSize: ${W} ${H} `);
  const out: string[] = [head.replace(/\n+$/, ""), "%AI5_BeginLayer", "1 1 1 1 0 0 -1 55 52 53 Lb", "(Layer 1) Ln"];
  const lw = FRAME_LINE_MM * MM * sc;
  let last: string | null = null;
  for (const op of ops) {
    if (op.t !== "stroke" || op.pts.length < 2) continue;
    const key = op.color.join(",");
    if (key !== last) { out.push(aiColorCmds(op.color)); last = key; }
    out.push(`0 J 0 j ${lw.toFixed(3)} w []0 d`);
    const [x0, y0] = op.pts[0]!;
    out.push(`${(x0 * sc).toFixed(2)} ${(y0 * sc).toFixed(2)} m`);
    for (let i = 1; i < op.pts.length; i++) {
      const [x, y] = op.pts[i]!;
      out.push(`${(x * sc).toFixed(2)} ${(y * sc).toFixed(2)} L`);
    }
    out.push("S");
  }
  for (const op of ops) {
    if (op.t !== "fill" || !op.geom || !op.geom.length) continue;
    const key = op.color.join(",");
    if (key !== last) { out.push(aiColorCmds(op.color)); last = key; }
    for (const poly of op.geom) polyToAi(poly, out);
  }
  for (const op of ops) {
    if (op.t !== "raster") continue;
    emitXiRaster(out, op.cols, op.rows, op.hex, op.zone);
    last = null;
  }
  out.push(AI_TAIL.replace(/\n+$/, ""));
  return Buffer.from(out.join("\n"), "latin1");
}

/** Split items into pages of rows: each leather colour starts its own row (one
 *  leather per row), up to maxCols per row, maxRows rows and perFile items a page. */
export function pagesByColour<T extends { color: string }>(
  items: T[], maxCols: number, maxRows: number, perFile = Infinity,
): T[][][] {
  const byColor = new Map<string, T[]>();
  for (const it of items) {
    if (!byColor.has(it.color)) byColor.set(it.color, []);
    byColor.get(it.color)!.push(it);
  }
  const pages: T[][][] = [];
  let rows: T[][] = [];
  let count = 0;
  for (const colorItems of byColor.values()) {
    let i = 0;
    while (i < colorItems.length) {
      if (count === perFile || rows.length === maxRows) { pages.push(rows); rows = []; count = 0; }
      const row = colorItems.slice(i, i + Math.min(maxCols, perFile - count));
      rows.push(row);
      count += row.length;
      i += row.length;
    }
  }
  if (rows.length) pages.push(rows);
  return pages;
}
