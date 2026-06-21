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
async function ensureHB(): Promise<HBModule> {
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
import { BOX_TEMPLATE, AI_HEAD, AI_TAIL } from "./boxAssets.js";

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

const HEARTS = new Set([
  "❤", "♥", "🤍", "💙", "💚", "💛", "🧡", "💜", "🖤", "🤎",
  "💖", "💗", "💞", "💓", "💕", "💟",
]);
const SKIP_CHARS = new Set(["️", "︎", "‍"]);

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
  const c = ch.codePointAt(0)!;
  return (c >= 0x0600 && c <= 0x06ff) || (c >= 0xfb50 && c <= 0xfeff) || (c >= 0x0750 && c <= 0x077f);
}

type Kind = "ar" | "lat" | "num" | "heart";
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

function shapeRun(fb: FB, text: string): Array<{ g: number; ax: number; xo: number; yo: number }> {
  const buf = new HB!.Buffer();
  buf.addText(text);
  buf.guessSegmentProperties();
  HB!.shape(fb.font, buf, undefined);
  return buf.getGlyphInfosAndPositions().map((x: any) => ({
    g: x.codepoint, ax: x.xAdvance || 0, xo: x.xOffset || 0, yo: x.yOffset || 0,
  }));
}

function weldLine(text: string, baseline: number): { geom: MultiPoly | null; width: number } {
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
const FRAME_LINE_MM = 0.2;
const CELL_LINE_GAP = Math.round(EM * 2.0);
const COLOR_RED: [number, number, number] = [1, 0, 0];
const BOX_CUT: [number, number, number] = [0, 0, 0];
const BOX_TEXT_COLORS: Array<[number, number, number]> = [
  [0.0, 0.50, 0.0], [1.0, 0.50, 0.0], [1.0, 0.45, 0.70], [0.50, 0.10, 0.80],
  [0.50, 0.80, 0.10], [0.0, 0.60, 0.60], [0.85, 0.10, 0.50], [0.30, 0.30, 1.0], [0.60, 0.40, 0.0],
];
const BOX_STRIP = new Set(['"', "'", "«", "»", "“", "”", "‘", "’", "(", ")", "[", "]", "{", "}"]);

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

function textWidth(text: string): number {
  const [ara, lat] = fonts();
  let w = 0;
  for (const { text: run, kind } of splitRuns(text)) {
    if (kind === "heart") { w += EM * 0.62 + EM * 0.12; continue; }
    const fb = kind === "ar" || kind === "num" ? ara : lat;
    const scale = ara.upem / fb.upem;
    for (const gl of shapeRun(fb, run)) { if (gl.g === 0) continue; w += gl.ax * scale; }
  }
  return w;
}
function wrapToWidth(text: string, targetW: number): string[] {
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
function weldLinesBlock(lines: string[]): MultiPoly | null {
  const placed: Array<{ g: MultiPoly; y: number; w: number }> = [];
  let y = 0;
  for (const ln of lines) {
    const { geom } = weldLine(ln, 0);
    if (geom && geom.length) { const b = geomBounds(geom); placed.push({ g: geom, y, w: b[2] - b[0] }); }
    y += CELL_LINE_GAP;
  }
  if (!placed.length) return null;
  const maxw = Math.max(...placed.map((p) => p.w));
  const geoms = placed.map((p) => translateXY(p.g, (maxw - p.w) / 2 - geomBounds(p.g)[0], -p.y));
  return geoms.length === 1 ? geoms[0]! : (pc.union(geoms[0]!, ...geoms.slice(1)) as MultiPoly);
}
function placeTextBox(block: MultiPoly, cellX: number, cellY: number): MultiPoly | null {
  if (!block || !block.length) return null;
  const [cx, cy, wf, hf] = boxTextTarget();
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
function logoGeom(cellX: number, cellY: number): MultiPoly | null {
  const base = loadLogoVector();
  const z = BOX_TEMPLATE.logo_zone;
  if (!base || !z) return null;
  const g = scaleXY(base, (z.x1 - z.x0) * CELL_W, (z.y1 - z.y0) * CELL_H);
  return translateXY(g, cellX + z.x0 * CELL_W, cellY + z.y0 * CELL_H);
}

function isBox(e: AiEntry): boolean {
  const p = (e.display_product || "").toLowerCase();
  return p.includes("box") || p.includes("بوكس");
}
function boxText(e: AiEntry): string {
  const vals: string[] = [];
  for (const [, v] of e.customization_cleaned) {
    const s = [...String(v)].filter((c) => !BOX_STRIP.has(c)).join("").split(/\s+/).filter(Boolean).join(" ");
    if (s) vals.push(s);
  }
  return vals.join("  ");
}

type BoxCell = { kind: "text"; block: MultiPoly } | { kind: "logozone" };
function boxCellContents(entries: AiEntry[]): BoxCell[] {
  const [, , wf] = boxTextTarget();
  const targetW = wf * CELL_W;
  const cells: BoxCell[] = [];
  for (const e of entries) {
    if (!isBox(e)) continue;
    const text = boxText(e);
    const lines: string[] = text ? wrapToWidth(text, targetW) : [];
    // Customisation photos -> "photo N" marker on its own line (the box is a
    // single zone, so the position is implicit). "طباعة الصور" uploads have no
    // place (position_label null) and are skipped.
    for (const p of e.photo_numbers ?? []) {
      if (!((p.position_label ?? "").trim())) continue;
      lines.push(p.display_label ?? "photo");
    }
    if (!lines.length) { for (let i = 0; i < qtyOf(e); i++) cells.push({ kind: "logozone" }); continue; }
    const block = weldLinesBlock(lines);
    if (!block) continue;
    for (let i = 0; i < qtyOf(e); i++) cells.push({ kind: "text", block });
  }
  return cells;
}
function gridDims(): [number, number] {
  return [2 * GRID_MARGIN + GRID_COLS * CELL_W, 2 * GRID_MARGIN + GRID_ROWS * CELL_H];
}

type BoxOp =
  | { t: "stroke"; pts: Ring; color: [number, number, number] }
  | { t: "fill"; geom: MultiPoly; color: [number, number, number] };
function boxGridPageOps(cells: BoxCell[]): BoxOp[] {
  const ops: BoxOp[] = [];
  const [cx, cy, wf, hf] = boxTextTarget();
  cells.forEach((cell, idx) => {
    const col = idx % GRID_COLS, row = Math.floor(idx / GRID_COLS);
    const cellX = GRID_MARGIN + col * CELL_W;
    const cellY = GRID_MARGIN + (GRID_ROWS - 1 - row) * CELL_H;
    for (const { pts, color } of boxTemplateStrokes(cellX, cellY)) ops.push({ t: "stroke", pts, color });
    const ecolor = BOX_TEXT_COLORS[idx % BOX_TEXT_COLORS.length]!;
    const lg = logoGeom(cellX, cellY);
    if (lg && lg.length) ops.push({ t: "fill", geom: lg, color: ecolor });
    if (cell.kind === "text") {
      const ft = placeTextBox(cell.block, cellX, cellY);
      if (ft) ops.push({ t: "fill", geom: ft, color: ecolor });
    } else {
      // photo-zone marker (uploaded logos are imported separately — embedded
      // rasters engrave faint in RDWorks).
      const zx0 = cellX + (cx - wf / 2) * CELL_W, zx1 = cellX + (cx + wf / 2) * CELL_W;
      const zy0 = cellY + (cy - hf / 2) * CELL_H, zy1 = cellY + (cy + hf / 2) * CELL_H;
      ops.push({ t: "stroke", pts: [[zx0, zy0], [zx1, zy0], [zx1, zy1], [zx0, zy1], [zx0, zy0]], color: ecolor });
    }
  });
  return ops;
}

function rgbToCmyk(c: [number, number, number]): [number, number, number, number] {
  const [r, g, b] = c;
  const k = 1 - Math.max(r, g, b);
  if (k >= 0.9999) return [0, 0, 0, 1];
  return [(1 - r - k) / (1 - k), (1 - g - k) / (1 - k), (1 - b - k) / (1 - k), k];
}
function aiColorCmds(c: [number, number, number]): string {
  const [cc, m, y, k] = rgbToCmyk(c);
  const s = `${cc.toFixed(4)} ${m.toFixed(4)} ${y.toFixed(4)} ${k.toFixed(4)}`;
  return `${s} k\n${s} K`;
}
function writeBoxGrid(ops: BoxOp[], totalW: number, totalH: number): string {
  const sc = PT_SCALE;
  const W = Math.floor(totalW * sc) + 1, H = Math.floor(totalH * sc) + 1;
  const head = AI_HEAD
    .replace("%%BoundingBox:684 -299 1058 579", `%%BoundingBox:0 0 ${W} ${H}`)
    .replace("%AI5_ArtSize: 612 792 ", `%AI5_ArtSize: ${W} ${H} `);
  const out: string[] = [head.replace(/\n+$/, ""), "%AI5_BeginLayer", "1 1 1 1 0 0 -1 55 52 53 Lb", "(Layer 1) Ln"];
  const lw = FRAME_LINE_MM * MM * sc;
  let last: string | null = null;
  for (const op of ops) {
    if (op.t !== "stroke") continue;
    const key = op.color.join(",");
    if (key !== last) { out.push(aiColorCmds(op.color)); last = key; }
    out.push(`0 J 0 j ${lw.toFixed(3)} w []0 d`);
    const [x0, y0] = op.pts[0]!;
    out.push(`${(x0 * sc).toFixed(2)} ${(y0 * sc).toFixed(2)} m`);
    for (let i = 1; i < op.pts.length; i++) { const [x, y] = op.pts[i]!; out.push(`${(x * sc).toFixed(2)} ${(y * sc).toFixed(2)} L`); }
    out.push("S");
  }
  for (const op of ops) {
    if (op.t !== "fill") continue;
    if (!op.geom || !op.geom.length) continue;
    const key = op.color.join(",");
    if (key !== last) { out.push(aiColorCmds(op.color)); last = key; }
    for (const poly of op.geom) polyToAi(poly, out);
  }
  out.push(AI_TAIL.replace(/\n+$/, ""));
  return out.join("\n");
}

/** Build one or more box-grid .ai files (18 boxes/file). Returns latin1 Buffers. */
export async function buildBoxGridBuffers(entries: AiEntry[]): Promise<Buffer[]> {
  await ensureHB();
  const contents = boxCellContents(entries);
  if (!contents.length) return [];
  const pages: BoxCell[][] = [];
  for (let i = 0; i < contents.length; i += CELLS_PER_FILE) pages.push(contents.slice(i, i + CELLS_PER_FILE));
  const [totalW, totalH] = gridDims();
  return pages.map((page) => Buffer.from(writeBoxGrid(boxGridPageOps(page), totalW, totalH), "latin1"));
}
