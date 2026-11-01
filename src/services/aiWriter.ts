/**
 * Laser-ready Adobe Illustrator (.ai) generator — TypeScript port of ai_writer.py.
 *
 * Shapes each line (Arabic via DecoType Thuluth II, Latin via Monotype Corsiva)
 * with HarfBuzz (WASM), converts glyphs to outlines, welds them (polygon union),
 * and emits a legacy .ai of pure paths. Output is byte-for-byte equivalent in
 * intent to the Python module (HarfBuzz shaping is identical across both).
 */
import type { Face, Font } from "harfbuzzjs";
import * as polygonClippingNs from "polygon-clipping";

// harfbuzzjs is ESM-only; Netlify bundles functions as CJS, so load it lazily via
// dynamic import() (works for ESM from CJS) and cache the module.
type HBModule = typeof import("harfbuzzjs");
let HB: HBModule | null = null;
export async function ensureHB(): Promise<HBModule> {
  if (!HB) HB = await import("harfbuzzjs");
  return HB;
}

// polygon-clipping is published as CommonJS; under ESM the functions land on
// `.default`. Normalize so `pc.union/xor` work in both tsx and esbuild bundles.
const pc: typeof polygonClippingNs =
  (polygonClippingNs as unknown as { default?: typeof polygonClippingNs }).default ?? polygonClippingNs;
export interface AiEntry {
  display_product: string;
  display_color?: string;
  total_quantity?: number;
  customization_cleaned: Array<[string, string]>;
  photo_numbers?: Array<{ position_label?: string | null; display_label?: string }>;
}
import { ARABIC_FONT_B64, LATIN_FONT_B64 } from "./fontsData.js";
import { BOX_TEMPLATE } from "./boxAssets.js";
import { cappedFiles, type LaserOp, TRACED_BYTES_PER_POINT } from "./laser/laserCore.js";
import { burnShare, type PreppedRaster, prepPhotoRaster, traceRaster } from "./laser/laserPhoto.js";
import {
  cleanText, entryPieces, HEARTS, INFINITY, type LaserEntry, partFields, partPhotos, SKIP_CHARS, sourcesOf,
} from "./laser/laserRouting.js";

type Ring = [number, number][];
type Poly = Ring[];
type MultiPoly = Poly[];

const EM = 2048;
const PT_SCALE = 0.02;
const HEADER_GAP = Math.round(EM * 1.6);
const WALLET_GAP = Math.round(EM * 2.4);
const GROUP_GAP = Math.round(EM * 4.5);
const MARGIN = Math.round(EM * 0.8);
const BEZIER_STEPS = 6;

const COLOR_VALUE: [number, number, number] = [0, 0, 0];
const COLOR_REF: [number, number, number] = [0, 0, 1];

// ── Fonts ───────────────────────────────────────────────────────────────────
interface FB { face: Face; font: Font; upem: number; }
let _ara: FB | null = null;
let _lat: FB | null = null;

function loadFont(b64: string): FB {
  const data = Buffer.from(b64, "base64");
  const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const blob = new HB!.Blob(ab);
  const face = new HB!.Face(blob, 0);
  const font = new HB!.Font(face);
  return { face, font, upem: face.upem };
}
function fonts(): [FB, FB] {
  if (!_ara) _ara = loadFont(ARABIC_FONT_B64);
  if (!_lat) _lat = loadFont(LATIN_FONT_B64);
  return [_ara, _lat];
}

// ── Script segmentation ───────────────────────────────────────────────────────
function isArabic(ch: string): boolean {
  // Presentation forms A and B only: U+FE00-FE6F holds the emoji variation
  // selectors, which made "2026/11/5♥️" a right-to-left line (heart on the left).
  const c = ch.codePointAt(0)!;
  return (c >= 0x0600 && c <= 0x06ff) || (c >= 0x0750 && c <= 0x077f) || (c >= 0xfb50 && c <= 0xfdff)
    || (c >= 0xfe70 && c <= 0xfeff);
}

type Kind = "ar" | "lat" | "num" | "heart" | "inf";
function splitRuns(text: string): Array<{ text: string; kind: Kind }> {
  // Digits get their own LTR run so "40" never reverses to "04" inside RTL
  // Arabic; neutral chars (space/punct) stick to the current run.
  const runs: Array<{ text: string; kind: Kind }> = [];
  let cur = "";
  let curKind: Kind | null = null;
  const flush = () => {
    if (cur.trim()) runs.push({ text: cur, kind: curKind ?? "lat" });
    cur = ""; curKind = null;
  };
  for (const ch of text) {
    if (SKIP_CHARS.has(ch)) continue;
    if (HEARTS.has(ch)) { flush(); runs.push({ text: ch, kind: "heart" }); continue; }
    if (ch === INFINITY) { flush(); runs.push({ text: ch, kind: "inf" }); continue; }
    let k: Kind;
    if (/\d/.test(ch)) k = "num";
    else if (isArabic(ch)) k = "ar";
    else if (/\p{L}/u.test(ch)) k = "lat";
    else { cur += ch; continue; }          // neutral: stick to current run
    if (curKind === null) curKind = k;
    if (k !== curKind && cur.trim()) { runs.push({ text: cur, kind: curKind }); cur = ch; curKind = k; }
    else { cur += ch; curKind = k; }
  }
  flush();
  return runs;
}

function lineIsRtl(text: string): boolean {
  // Base direction = RTL if the first strong-directional char is Arabic.
  for (const ch of text) {
    if (isArabic(ch)) return true;
    if (/\p{L}/u.test(ch)) return false;
  }
  return false;
}

// ── Glyph outline -> polygons ──────────────────────────────────────────────────
function pathToContours(d: string): Ring[] {
  // Parse an SVG path (M/L/Q/C/Z, absolute) into flattened polygon contours.
  const contours: Ring[] = [];
  let cur: Ring = [];
  let x = 0, y = 0, sx = 0, sy = 0;
  const re = /([MLQCZmlqcz])([^MLQCZmlqcz]*)/g;
  let m: RegExpExecArray | null;
  const nums = (s: string) => (s.match(/-?\d*\.?\d+(?:e-?\d+)?/g) || []).map(Number);
  while ((m = re.exec(d))) {
    const cmd = m[1];
    const a = nums(m[2] || "");
    if (cmd === "M") { if (cur.length) contours.push(cur); x = a[0]; y = a[1]; sx = x; sy = y; cur = [[x, y]]; }
    else if (cmd === "L") { for (let i = 0; i < a.length; i += 2) { x = a[i]; y = a[i + 1]; cur.push([x, y]); } }
    else if (cmd === "Q") {
      for (let i = 0; i < a.length; i += 4) {
        const cx = a[i], cy = a[i + 1], ex = a[i + 2], ey = a[i + 3];
        for (let s = 1; s <= BEZIER_STEPS; s++) {
          const t = s / BEZIER_STEPS, mt = 1 - t;
          cur.push([mt * mt * x + 2 * mt * t * cx + t * t * ex, mt * mt * y + 2 * mt * t * cy + t * t * ey]);
        }
        x = ex; y = ey;
      }
    } else if (cmd === "C") {
      for (let i = 0; i < a.length; i += 6) {
        const c1x = a[i], c1y = a[i + 1], c2x = a[i + 2], c2y = a[i + 3], ex = a[i + 4], ey = a[i + 5];
        for (let s = 1; s <= BEZIER_STEPS; s++) {
          const t = s / BEZIER_STEPS, mt = 1 - t;
          cur.push([
            mt**3*x + 3*mt*mt*t*c1x + 3*mt*t*t*c2x + t**3*ex,
            mt**3*y + 3*mt*mt*t*c1y + 3*mt*t*t*c2y + t**3*ey,
          ]);
        }
        x = ex; y = ey;
      }
    } else if (cmd === "Z" || cmd === "z") { if (cur.length) { contours.push(cur); cur = []; } x = sx; y = sy; }
  }
  if (cur.length) contours.push(cur);
  return contours;
}

function glyphGeom(fb: FB, gid: number, ox: number, oy: number, scale: number): MultiPoly | null {
  const d = fb.font.glyphToPath(gid);
  if (!d) return null;
  const polys: MultiPoly[] = [];
  for (const c of pathToContours(d)) {
    if (c.length < 3) continue;
    polys.push([[c.map(([px, py]) => [ox + px * scale, oy + py * scale]) as Ring]]);
  }
  if (!polys.length) return null;
  if (polys.length === 1) return polys[0]!;
  // Even-odd (holes wound opposite) in ONE xor call — far faster than pairwise.
  return pc.xor(polys[0]!, ...polys.slice(1)) as MultiPoly;
}

function heartGeom(left: number, baseline: number, height: number): { geom: MultiPoly; width: number } {
  const raw: [number, number][] = [];
  for (let i = 0; i < 80; i++) {
    const t = (2 * Math.PI * i) / 80;
    const x = 16 * Math.sin(t) ** 3;
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    raw.push([x, y]);
  }
  const xs = raw.map((p) => p[0]), ys = raw.map((p) => p[1]);
  const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
  const scale = height / (maxy - miny);
  const ring: Ring = raw.map(([x, y]) => [left + (x - minx) * scale, baseline + (y - miny) * scale]);
  return { geom: [[ring]], width: (maxx - minx) * scale };
}

/** "∞" (no glyph in either font): two loops joined side by side, centred on the
 *  heart's height. */
function infinityGeom(left: number, baseline: number): { geom: MultiPoly; width: number } {
  const ry = EM * 0.22, rx = EM * 0.26, t = EM * 0.075, cy = baseline + EM * 0.31;
  const ellipse = (cx: number, ax: number, ay: number): Ring =>
    Array.from({ length: 48 }, (_, i) => {
      const a = (2 * Math.PI * i) / 48;
      return [cx + ax * Math.cos(a), cy + ay * Math.sin(a)] as [number, number];
    });
  const loop = (cx: number): Poly => [ellipse(cx, rx, ry), ellipse(cx, rx - t, ry - t)];
  const c1 = left + rx, c2 = left + 3 * rx - t;
  return { geom: pc.union(loop(c1), loop(c2)) as MultiPoly, width: 4 * rx - t };
}

function shapeRun(fb: FB, text: string): Array<{ g: number; ax: number; xo: number; yo: number }> {
  const buf = new HB!.Buffer();
  buf.addText(text);
  buf.guessSegmentProperties();
  HB!.shape(fb.font, buf, undefined);
  return buf.getGlyphInfosAndPositions().map((x: any) => ({
    g: x.codepoint, ax: x.xAdvance || 0, xo: x.xOffset || 0, yo: x.yOffset || 0,
  }));
}

export function weldLine(text: string, baseline: number): { geom: MultiPoly | null; width: number } {
  const [ara, lat] = fonts();
  const geoms: MultiPoly[] = [];
  let penX = 0;
  let runs = splitRuns(text);
  // RTL base line: lay runs right-to-left so mixed Arabic + numbers + Latin
  // read correctly instead of scrambled.
  if (lineIsRtl(text)) runs = runs.slice().reverse();
  for (const { text: run, kind } of runs) {
    if (kind === "heart") {
      const h = heartGeom(penX, baseline, EM * 0.62);
      geoms.push(h.geom);
      penX += h.width + EM * 0.12;
      continue;
    }
    if (kind === "inf") {
      const g = infinityGeom(penX, baseline);
      geoms.push(g.geom);
      penX += g.width + EM * 0.12;
      continue;
    }
    const fb = kind === "ar" || kind === "num" ? ara : lat;
    const scale = ara.upem / fb.upem;
    for (const gl of shapeRun(fb, run)) {
      // glyph 0 == .notdef: the font has no glyph (emoji, &, …). Skip it so we
      // never draw a tofu box.
      if (gl.g === 0) continue;
      const g = glyphGeom(fb, gl.g, penX + gl.xo * scale, baseline + gl.yo * scale, scale);
      if (g && g.length) geoms.push(g);
      penX += gl.ax * scale;
    }
  }
  if (!geoms.length) return { geom: null, width: penX };
  // Union ALL glyphs of the line in a single sweep — orders of magnitude faster
  // than pairwise unions for long lines.
  const welded = geoms.length === 1 ? geoms[0]! : (pc.union(geoms[0]!, ...geoms.slice(1)) as MultiPoly);
  return { geom: welded, width: penX };
}

// ── Entry -> blocks (grouped inline layout) ────────────────────────────────────
const MAX_INLINE = 70; // chars per AI line before wrapping (keeps lines readable)

function productKey(e: AiEntry): string {
  const product = (e.display_product || "").trim();
  const pl = product.toLowerCase();
  // Boxes are grouped WITHOUT color; all purse boxes collapse into one group.
  if (pl.includes("purse") && pl.includes("box")) return "Gift purse box";
  if (pl.includes("box") || pl.includes("بوكس")) return product;
  return `${product} ${e.display_color || ""}`.trim();
}
function shortLabel(label: string): string {
  const s = (label || "").trim();
  if (s.toLowerCase() === "message") return "";
  // Box-writing labels ('كتابه علي البوكس') are suppressed — only the actual
  // engraving text should appear in the laser file, not the position meta-label.
  if (s.includes("بوكس") || s.toLowerCase().includes("box")) return "";
  return s.replace("المحفظة", "").trim();
}
function qtyOf(e: AiEntry): number {
  const q = Number(e.total_quantity || 1);
  return Number.isFinite(q) && q > 0 ? Math.floor(q) : 1;
}
function entryParts(e: AiEntry): string[] {
  const parts: string[] = [];
  for (const [label, value] of e.customization_cleaned) {
    const sl = shortLabel(label);
    // Flatten multi-line values to one part so the label shows ONCE; word-wrap
    // later splits long values across lines without repeating the label.
    const v = String(value).replace(/\s+/g, " ").trim();
    if (!v) continue;
    parts.push(sl ? `${sl}: ${v}` : v);
  }
  return parts;
}
function wrapWords(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const w of text.split(/\s+/)) {
    const cand = cur ? `${cur} ${w}` : w;
    if (cand.length > maxChars && cur) { out.push(cur); cur = w; } else cur = cand;
  }
  if (cur) out.push(cur);
  return out.length ? out : [text];
}
// Customisation-photo markers for the laser file, as SEPARATE lines:
//   "المحفظة برا يمين:"
//   "photo 31"
// The Arabic position label and the LTR "photo N" marker live on their OWN lines
// so BiDi never reorders the digits — matches the Word doc exactly. ONLY photos
// with a known place (position_label set) are written; "طباعة الصور" uploads have
// no place and are skipped (print photos, never reach the laser file).
function entryPhotoLines(e: AiEntry): string[] {
  const lines: string[] = [];
  for (const p of e.photo_numbers ?? []) {
    const pos = (p.position_label ?? "").trim();
    if (!pos) continue;
    lines.push(`${pos}:`);
    lines.push(p.display_label ?? "photo");
  }
  return lines;
}
// One wallet on as FEW lines as fit; long values wrap so we never emit one giant
// unreadable (multi-MB) line.
function entryLines(e: AiEntry, maxChars = MAX_INLINE): string[] {
  const parts = entryParts(e);
  const lines: string[] = [];
  let cur = "";
  for (const part of parts) {
    if (part.length > maxChars) {
      if (cur) { lines.push(cur); cur = ""; }
      lines.push(...wrapWords(part, maxChars));
      continue;
    }
    const cand = cur ? `${cur}  ----  ${part}` : part;
    if (cand.length > maxChars && cur) { lines.push(cur); cur = part; } else cur = cand;
  }
  if (cur) lines.push(cur);
  // Photo markers come AFTER the text, each on its own line (label + "photo N").
  lines.push(...entryPhotoLines(e));
  return lines;
}

interface Block { header: string; lines: string[] }
function buildBlocks(entries: AiEntry[]): Block[] {
  const order: string[] = [];
  const byKey = new Map<string, AiEntry[]>();
  for (const e of entries) {
    if (!entryLines(e).length) continue;
    const k = productKey(e);
    if (!byKey.has(k)) { byKey.set(k, []); order.push(k); }
    byKey.get(k)!.push(e);
  }
  return order.map((k) => {
    const ents = byKey.get(k)!;
    const count = ents.reduce((s, e) => s + qtyOf(e), 0);
    const lines: string[] = [];
    for (const e of ents) {
      const elines = entryLines(e);
      const q = qtyOf(e);
      if (q > 1 && elines.length) elines[0] = `x${q}   ${elines[0]}`;
      lines.push(...elines);
    }
    return { header: `${count} X ${k}`.toUpperCase(), lines };
  });
}

const SEP_TEXT = "-".repeat(50); // divider line drawn between products
type Kind2 = "name" | "value" | "sep";
type Row = { text: string; kind: Kind2; owner: string };
function allRows(blocks: Block[]): Row[] {
  const rows: Row[] = [];
  blocks.forEach((b, i) => {
    // A divider line between products so they are easy to tell apart on the laser.
    if (i > 0) rows.push({ text: SEP_TEXT, kind: "sep", owner: b.header });
    rows.push({ text: b.header, kind: "name", owner: b.header });
    for (const ln of b.lines) rows.push({ text: ln, kind: "value", owner: b.header });
  });
  return rows;
}

// ── Weld once, pack by file SIZE, emit ─────────────────────────────────────────
// Splitting by line count is wrong because one inline wallet line can be huge.
// We weld every row once (at baseline 0), estimate its byte weight, then pack
// rows into files so each file stays under a target size (~3 MB → 3-4 files).
const BYTES_PER_POINT = 16;          // ~"1234.56 789.01 L\n"
const DEFAULT_MAX_BYTES = 3_000_000; // target per .ai file

interface WeldedRow { kind: Kind2; owner: string; geom: MultiPoly | null; width: number; points: number; }

function countPoints(geom: MultiPoly | null): number {
  if (!geom) return 0;
  let n = 0;
  for (const poly of geom) for (const ring of poly) n += ring.length;
  return n;
}

function weldRow(r: { text: string; kind: Kind2; owner: string }): WeldedRow {
  const { geom, width } = weldLine(r.text, 0);  // weld at baseline 0; translate later
  return { kind: r.kind, owner: r.owner, geom, width, points: countPoints(geom) };
}

function translateGeom(geom: MultiPoly, dy: number): MultiPoly {
  return geom.map((poly) => poly.map((ring) => ring.map(([x, y]) => [x, y + dy] as [number, number])));
}

function packBySize(welded: WeldedRow[], maxBytes: number): WeldedRow[][] {
  // Keep every product WHOLE inside one file — a product is never split across
  // two files (even if that means more files). A product bigger than the cap
  // gets its own file alone.
  // Group consecutive rows by owner so each product block stays together.
  const blocks: WeldedRow[][] = [];
  for (const w of welded) {
    const last = blocks[blocks.length - 1];
    if (!last || last[0]!.owner !== w.owner) blocks.push([w]);
    else last.push(w);
  }

  const parts: WeldedRow[][] = [];
  let cur: WeldedRow[] = [];
  let curBytes = 0;
  for (const block of blocks) {
    const blockBytes = block.reduce((s, w) => s + w.points * BYTES_PER_POINT, 0);
    // Start a new file if this whole product would overflow the current one.
    if (cur.length && curBytes + blockBytes > maxBytes) { parts.push(cur); cur = []; curBytes = 0; }
    cur.push(...block);
    curBytes += blockBytes;
  }
  if (cur.length) parts.push(cur);

  // Never start a file with a divider line.
  return parts.map((partIn) => {
    let part = partIn;
    while (part.length && part[0]!.kind === "sep") part = part.slice(1);
    return part;
  });
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

function emitPart(part: WeldedRow[]): string {
  // Assign top-down baselines with kind-aware gaps.
  const placed: Array<{ w: WeldedRow; off: number }> = [];
  let offset = MARGIN;
  let prev: string | null = null;
  let maxW = 0;
  for (const w of part) {
    if (w.kind === "sep") offset += GROUP_GAP;                       // big space before the divider
    else if (w.kind === "name") offset += prev === "sep" ? HEADER_GAP : GROUP_GAP;
    else if (prev === "name") offset += HEADER_GAP;
    else offset += WALLET_GAP;
    placed.push({ w, off: offset });
    prev = w.kind;
    maxW = Math.max(maxW, w.width);
  }
  const totalH = offset + MARGIN;

  const out: string[] = [
    "%!PS-Adobe-3.0 EPSF-3.0",
    "%%Creator: VIOLA Production Agent (welded outlines, no fonts)",
    `%%BoundingBox: 0 0 ${Math.floor((maxW + 2 * MARGIN) * PT_SCALE) + 1} ${Math.floor(totalH * PT_SCALE) + 1}`,
    "%%EndComments",
  ];
  let last: string | null = null;
  for (const { w, off } of placed) {
    if (!w.geom) continue;
    const geom = translateGeom(w.geom, totalH - off);  // move from baseline 0 to its place
    const c = w.kind === "name" ? COLOR_REF : COLOR_VALUE;
    const key = c.join(",");
    if (key !== last) { out.push(`${c[0].toFixed(1)} ${c[1].toFixed(1)} ${c[2].toFixed(1)} setrgbcolor`); last = key; }
    for (const poly of geom) polyToAi(poly, out);
  }
  out.push("%%EOF");
  return out.join("\n");
}

/** Build one or more .ai files, split by file SIZE. Returns latin1 Buffers. */
export async function buildAiBuffers(
  entries: AiEntry[],
  opts: { maxBytes?: number } = {},
): Promise<Buffer[]> {
  await ensureHB();  // load the HarfBuzz WASM module before any sync glyph work
  const rows = allRows(buildBlocks(entries));
  if (!rows.length) return [];
  const welded = rows.map(weldRow);
  const parts = packBySize(welded, opts.maxBytes ?? DEFAULT_MAX_BYTES);
  return parts.map((part) => Buffer.from(emitPart(part), "latin1"));
}

// ════════════════════════════════════════════════════════════════════════════
// Box grid (9 cols × 2 rows = 18 boxes/file) — mirror of ai_writer.py.
// Each box is one cell: the real die-line + red guide lines + per-box engraving
// text (or a photo-zone marker for uploaded logos), the VIOLA brand mark, and a
// per-box engrave colour. Output is a real Adobe Illustrator file so RDWorks
// reads the K/k CMYK colours.
// ════════════════════════════════════════════════════════════════════════════
const CELL_W_MM = 132.0, CELL_H_MM = 310.0;
const GRID_COLS = 9, GRID_ROWS = 2;
const CELLS_PER_FILE = GRID_COLS * GRID_ROWS;
const MM = 72.0 / (PT_SCALE * 25.4);            // font units per millimetre
const CELL_W = CELL_W_MM * MM;
const CELL_H = CELL_H_MM * MM;
const GRID_MARGIN = 10.0 * MM;
const LINE_GAP = Math.round(EM * 0.25);         // between one line's lowest point and the next one's highest
const MIN_PITCH = Math.round(EM * 1.1);         // baseline to baseline, at least
const COLOR_RED: [number, number, number] = [1, 0, 0];
const BOX_CUT: [number, number, number] = [0, 0, 0];
const BOX_TEXT_COLORS: Array<[number, number, number]> = [
  [0.0, 0.50, 0.0], [1.0, 0.50, 0.0], [1.0, 0.45, 0.70], [0.50, 0.10, 0.80],
  [0.50, 0.80, 0.10], [0.0, 0.60, 0.60], [0.85, 0.10, 0.50], [0.30, 0.30, 1.0], [0.60, 0.40, 0.0],
];

function geomBounds(g: MultiPoly): [number, number, number, number] {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const poly of g) for (const ring of poly) for (const [x, y] of ring) {
    if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
  }
  return [minx, miny, maxx, maxy];
}
function translateXY(g: MultiPoly, dx: number, dy: number): MultiPoly {
  return g.map((p) => p.map((r) => r.map(([x, y]) => [x + dx, y + dy] as [number, number])));
}
function scaleXY(g: MultiPoly, sx: number, sy: number): MultiPoly {
  return g.map((p) => p.map((r) => r.map(([x, y]) => [x * sx, y * sy] as [number, number])));
}

function boxTextTarget(): [number, number, number, number] {
  const z = BOX_TEMPLATE.text_zone;
  return [(z.x0 + z.x1) / 2, (z.y0 + z.y1) / 2, z.x1 - z.x0, z.y1 - z.y0];
}

export function textWidth(text: string): number {
  const [ara, lat] = fonts();
  let w = 0;
  for (const { text: run, kind } of splitRuns(text)) {
    if (kind === "heart") { w += EM * 0.62 + EM * 0.12; continue; }
    if (kind === "inf") { w += infinityGeom(0, 0).width + EM * 0.12; continue; }
    const fb = kind === "ar" || kind === "num" ? ara : lat;
    const scale = ara.upem / fb.upem;
    for (const gl of shapeRun(fb, run)) { if (gl.g === 0) continue; w += gl.ax * scale; }
  }
  return w;
}

/** `text` in exactly n lines (fewer when it has fewer words) of the most even
 *  width: the widest line as narrow as it can be. With at least 2 words a line,
 *  no word is ever left alone on a line (owner, 2026-11-01). */
export function balancedLines(text: string, n: number): string[] {
  const words = (text || "").split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const k = Math.min(Math.max(1, n), words.length);
  if (k === 1) return [words.join(" ")];
  const minWords = words.length >= 2 * k ? 2 : 1;
  const widths = new Map<string, number>();
  const w = (i: number, j: number) => {
    const key = `${i},${j}`;
    if (!widths.has(key)) widths.set(key, textWidth(words.slice(i, j).join(" ")));
    return widths.get(key)!;
  };
  const W = words.length;
  // best[l][j]: the narrowest widest-line for the first j words in l lines
  const best: number[][] = Array.from({ length: k + 1 }, () => new Array(W + 1).fill(Infinity));
  const cut: number[][] = Array.from({ length: k + 1 }, () => new Array(W + 1).fill(-1));
  best[0]![0] = 0;
  for (let l = 1; l <= k; l++) {
    for (let j = l * minWords; j <= W; j++) {
      for (let i = (l - 1) * minWords; i <= j - minWords; i++) {
        if (best[l - 1]![i] === Infinity) continue;
        const v = Math.max(best[l - 1]![i]!, w(i, j));
        if (v < best[l]![j]!) { best[l]![j] = v; cut[l]![j] = i; }
      }
    }
  }
  const lines: string[] = [];
  for (let l = k, j = W; l > 0; l--) {
    const i = cut[l]![j]!;
    lines.unshift(words.slice(i, j).join(" "));
    j = i;
  }
  return lines;
}
export function wrapToWidth(text: string, targetW: number): string[] {
  const words = (text || "").split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    const cand = cur ? `${cur} ${word}` : word;
    if (cur && textWidth(cand) > targetW) { lines.push(cur); cur = word; } else cur = cand;
  }
  if (cur) lines.push(cur);
  return lines;
}
/** Lines stacked top to bottom, each centred. The line pitch is the same for every
 *  line: the deepest pair of neighbours (one's lowest point to the next one's
 *  highest) plus LINE_GAP, at least MIN_PITCH - close, never touching. */
export function weldLinesBlock(lines: string[]): MultiPoly | null {
  const welded = lines.map((ln) => {
    const { geom } = weldLine(ln, 0);
    return geom && geom.length ? geom : null;
  });
  let pitch = MIN_PITCH;
  for (let i = 0; i + 1 < welded.length; i++) {
    const a = welded[i], b = welded[i + 1];
    if (a && b) pitch = Math.max(pitch, -geomBounds(a)[1] + geomBounds(b)[3] + LINE_GAP);
  }
  const placed: Array<{ g: MultiPoly; y: number; w: number }> = [];
  welded.forEach((g, i) => {
    if (g) { const b = geomBounds(g); placed.push({ g, y: i * pitch, w: b[2] - b[0] }); }
  });
  if (!placed.length) return null;
  const maxw = Math.max(...placed.map((p) => p.w));
  const geoms = placed.map((p) => translateXY(p.g, (maxw - p.w) / 2 - geomBounds(p.g)[0], -p.y));
  return geoms.length === 1 ? geoms[0]! : (pc.union(geoms[0]!, ...geoms.slice(1)) as MultiPoly);
}
/** [centre x, centre y, width, height] of a box's engraving area, fractions of the cell. */
type Area = [number, number, number, number];
const TEXT_SHARE = 0.30;   // a box with writing AND a photo: the writing takes the area's lower 30%...
const SPLIT_GAP = 0.04;    // ...the photo the rest above it, this much apart
function boxAreas(): { photo: Area; text: Area } {
  const [cx, cy, wf, hf] = boxTextTarget();
  const y0 = cy - hf / 2, th = TEXT_SHARE * hf, gap = SPLIT_GAP * hf;
  return { text: [cx, y0 + th / 2, wf, th], photo: [cx, (y0 + th + gap + cy + hf / 2) / 2, wf, hf - th - gap] };
}

function placeTextBox(block: MultiPoly, cellX: number, cellY: number, area: Area = boxTextTarget()): MultiPoly | null {
  if (!block || !block.length) return null;
  const [cx, cy, wf, hf] = area;
  const zoneW = wf * CELL_W, zoneH = hf * CELL_H;
  let b = geomBounds(block); let bw = b[2] - b[0], bh = b[3] - b[1];
  if (bw <= 0 || bh <= 0) return null;
  const s = Math.min(zoneW / bw, zoneH / bh);
  const g = scaleXY(block, s, s);
  b = geomBounds(g); bw = b[2] - b[0]; bh = b[3] - b[1];
  return translateXY(g, cellX + cx * CELL_W - (b[0] + bw / 2), cellY + cy * CELL_H - (b[1] + bh / 2));
}

function boxTemplateStrokes(cellX: number, cellY: number): Array<{ pts: Ring; color: [number, number, number] }> {
  const out: Array<{ pts: Ring; color: [number, number, number] }> = [];
  for (const ln of (BOX_TEMPLATE.lines || []) as Array<{ c: string; pts: [number, number][] }>) {
    const pts = ln.pts.map(([nx, ny]) => [cellX + nx * CELL_W, cellY + ny * CELL_H] as [number, number]);
    if (pts.length >= 2) out.push({ pts, color: ln.c === "red" ? COLOR_RED : BOX_CUT });
  }
  return out;
}

let LOGO_GEOM: MultiPoly | null | undefined;
function loadLogoVector(): MultiPoly | null {
  if (LOGO_GEOM === undefined) {
    const polys: MultiPoly[] = [];
    for (const c of (BOX_TEMPLATE.logo_contours || []) as [number, number][][]) {
      if (c.length >= 3) polys.push([[c as Ring]]);
    }
    LOGO_GEOM = polys.length ? (polys.length === 1 ? polys[0]! : (pc.xor(polys[0]!, ...polys.slice(1)) as MultiPoly)) : null;
  }
  return LOGO_GEOM;
}
/** The VIOLA wordmark (mm) in place of a factory deer logo with these bounds
 *  (owner, 2026-11-01: every piece carries the gift boxes' logo): as wide as the
 *  deer logo, centred on it, on its baseline; turned 180 degrees where the deer
 *  logo is upside down on its piece (the purse's, read from the far side). */
export function wordmarkIn([x0, y0, x1, y1]: [number, number, number, number], upright = true): MultiPoly | null {
  const base = loadLogoVector();
  if (!base) return null;
  const w = x1 - x0, h = w / BOX_TEMPLATE.logo_aspect;
  return upright ? translateXY(scaleXY(base, w, h), x0, y0) : translateXY(scaleXY(base, -w, -h), x1, y1);
}
function logoGeom(cellX: number, cellY: number): MultiPoly | null {
  const base = loadLogoVector();
  const z = BOX_TEMPLATE.logo_zone;
  if (!base || !z) return null;
  const g = scaleXY(base, (z.x1 - z.x0) * CELL_W, (z.y1 - z.y0) * CELL_H);
  return translateXY(g, cellX + z.x0 * CELL_W, cellY + z.y0 * CELL_H);
}

// A box carries only its engraving message. In a bundle it takes the box's own
// fields; a purse bundle's box is the purse box (its own file, laser/pieceFile.ts).
function boxText(e: LaserEntry): string {
  return partFields(e, "box").map(([, v]) => cleanText(v)).filter(Boolean).join("  ");
}

/** A box's photo: the bitmap, and its outlines when it can be filled in the box's
 *  colour (null: too fine, it stays a bitmap). */
interface BoxPhoto extends PreppedRaster { rings: Array<Array<[number, number]>> | null }
/** One cell per physical box: its writing, the customer's photo (with the writing
 *  under it when there is both), or nothing (a plain box is still cut: outline + logo). */
type BoxCell =
  | { kind: "text"; block: MultiPoly }
  | { kind: "photo"; photo: BoxPhoto; block: MultiPoly | null }
  | { kind: "plain" };

/** The box writing in as many lines as the zone's width asks for, evened out. */
function boxTextLines(text: string, targetW: number): string[] {
  return text ? balancedLines(text, wrapToWidth(text, targetW).length) : [];
}

async function boxCellContents(entries: LaserEntry[], photos: Map<string, Buffer>): Promise<BoxCell[]> {
  const [, , wf] = boxTextTarget();
  const targetW = wf * CELL_W;
  const cells: BoxCell[] = [];
  for (const e of entries) {
    if (!entryPieces(e).has("box")) continue;
    const text = boxText(e);
    const lines = boxTextLines(text, targetW);
    const block = lines.length ? weldLinesBlock(lines) : null;
    const placed = partPhotos(e, "box");
    if (placed.length) {
      // Each order's boxes get that order's photo (photo-only boxes aggregate into one entry).
      const area = block ? boxAreas().photo : boxTextTarget();
      const zoneWPt = area[2] * CELL_W * PT_SCALE, zoneHPt = area[3] * CELL_H * PT_SCALE;
      for (const { order, qty } of sourcesOf(e)) {
        const mine = placed.filter((p) => (p.order_name ?? null) === order);
        const prepped: PreppedRaster[] = [];
        for (const p of mine) {
          const buf = p.attachment_url ? photos.get(p.attachment_url) : undefined;
          const r = buf ? await prepPhotoRaster(buf, zoneWPt, zoneHPt).catch(() => null) : null;
          if (r) prepped.push(r);
        }
        // More photos than boxes: engrave the designs, not the mock-ups.
        if (prepped.length > qty) {
          const key = (r: PreppedRaster) => { const s = burnShare(r); return [s <= 0.002 ? 1 : 0, s] as const; };
          prepped.sort((a, b) => { const [a0, a1] = key(a), [b0, b1] = key(b); return a0 - b0 || a1 - b1; });
        }
        const traced = prepped.map((r): BoxPhoto => ({ ...r, rings: traceRaster(r) }));
        for (let i = 0; i < qty; i++) {
          if (traced.length) { cells.push({ kind: "photo", photo: traced[i % traced.length]!, block }); continue; }
          // An unreadable photo: still cut, its "photo N" marker under the writing.
          const marked = weldLinesBlock([...lines, ...(mine.length ? mine.map((p) => p.display_label ?? "photo") : ["photo"])]);
          cells.push(marked ? { kind: "text", block: marked } : { kind: "plain" });
        }
      }
      continue;
    }
    for (let i = 0; i < qtyOf(e); i++) cells.push(block ? { kind: "text", block } : { kind: "plain" });
  }
  return cells;
}
function gridDims(): [number, number] {
  return [2 * GRID_MARGIN + GRID_COLS * CELL_W, 2 * GRID_MARGIN + GRID_ROWS * CELL_H];
}

/** Fit a cols x rows photo into the cell's engrave area; [tx, tyTop, pw, ph] points. */
function photoZone(cellX: number, cellY: number, cols: number, rows: number,
  area: Area = boxTextTarget()): [number, number, number, number] {
  const sc = PT_SCALE;
  const [cx, cy, wf, hf] = area;
  const zcx = (cellX + cx * CELL_W) * sc, zcy = (cellY + cy * CELL_H) * sc;
  const s = Math.min((wf * CELL_W * sc) / cols, (hf * CELL_H * sc) / rows);
  const pw = cols * s, ph = rows * s;
  return [zcx - pw / 2, zcy + ph / 2, pw, ph];
}

function boxGridPageOps(cells: BoxCell[]): LaserOp[] {
  const ops: LaserOp[] = [];
  cells.forEach((cell, idx) => {
    const col = idx % GRID_COLS, row = Math.floor(idx / GRID_COLS);
    const cellX = GRID_MARGIN + col * CELL_W;
    const cellY = GRID_MARGIN + (GRID_ROWS - 1 - row) * CELL_H;
    for (const { pts, color } of boxTemplateStrokes(cellX, cellY)) ops.push({ t: "stroke", pts, color });
    // text + VIOLA logo of this box share one colour, cycled by box position.
    const ecolor = BOX_TEXT_COLORS[idx % BOX_TEXT_COLORS.length]!;
    const lg = logoGeom(cellX, cellY);
    if (lg && lg.length) ops.push({ t: "fill", geom: lg, color: ecolor });
    if (cell.kind === "text") {
      const ft = placeTextBox(cell.block, cellX, cellY);
      if (ft) ops.push({ t: "fill", geom: ft, color: ecolor });
    } else if (cell.kind === "photo") {
      const { cols, rows, hex, rings } = cell.photo;
      const zone = photoZone(cellX, cellY, cols, rows, cell.block ? boxAreas().photo : boxTextTarget());
      if (rings) {
        // the photo's outlines in the box's colour (pixel corners -> font units)
        const [tx, ty, pw, ph] = zone;
        const sx = pw / cols, sy = ph / rows;
        ops.push({ t: "fill", color: ecolor, weight: rings.reduce((n, r) => n + r.length, 0) * TRACED_BYTES_PER_POINT,
          geom: [rings.map((ring) => ring.map(([x, y]) => [(tx + x * sx) / PT_SCALE, (ty - y * sy) / PT_SCALE] as [number, number]))] });
      } else ops.push({ t: "raster", cols, rows, hex, zone });
      if (cell.block) {
        const ft = placeTextBox(cell.block, cellX, cellY, boxAreas().text);
        if (ft) ops.push({ t: "fill", geom: ft, color: ecolor });
      }
    }
  });
  return ops;
}

/** Build one or more box-grid .ai files (18 boxes/file). photos: attachment_url ->
 *  bytes of the customers' box photos (engraved; a missing one keeps its marker). */
export async function buildBoxGridBuffers(entries: AiEntry[], photos: Map<string, Buffer> = new Map()): Promise<Buffer[]> {
  await ensureHB();
  const contents = await boxCellContents(entries as LaserEntry[], photos);
  if (!contents.length) return [];
  const [totalW, totalH] = gridDims();
  const paginate = (cells: BoxCell[]) => {
    const pages: BoxCell[][] = [];
    for (let i = 0; i < cells.length; i += CELLS_PER_FILE) pages.push(cells.slice(i, i + CELLS_PER_FILE));
    return pages;
  };
  return cappedFiles(contents, paginate, (page) => page, async (page) => [boxGridPageOps(page), totalW, totalH]);
}
