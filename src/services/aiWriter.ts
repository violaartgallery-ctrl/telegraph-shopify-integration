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
}
import { ARABIC_FONT_B64, LATIN_FONT_B64 } from "./fontsData.js";

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

type Kind = "ar" | "lat" | "heart";
function splitRuns(text: string): Array<{ text: string; kind: Kind }> {
  const runs: Array<{ text: string; kind: Kind }> = [];
  let cur = "";
  let curAr: boolean | null = null;
  const flush = () => {
    if (cur.trim()) runs.push({ text: cur, kind: curAr ? "ar" : "lat" });
    cur = ""; curAr = null;
  };
  for (const ch of text) {
    if (SKIP_CHARS.has(ch)) continue;
    if (HEARTS.has(ch)) { flush(); runs.push({ text: ch, kind: "heart" }); continue; }
    if (/\s/.test(ch) || /\d/.test(ch) || "()[]/-.,:&+".includes(ch)) { cur += ch; continue; }
    const ar = isArabic(ch);
    if (curAr === null) curAr = ar;
    if (ar !== curAr && cur.trim()) { runs.push({ text: cur, kind: curAr ? "ar" : "lat" }); cur = ch; curAr = ar; }
    else { cur += ch; curAr = ar; }
  }
  flush();
  return runs;
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
  for (const { text: run, kind } of splitRuns(text)) {
    if (kind === "heart") {
      const h = heartGeom(penX, baseline, EM * 0.62);
      geoms.push(h.geom);
      penX += h.width + EM * 0.12;
      continue;
    }
    const fb = kind === "ar" ? ara : lat;
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
    for (const piece of String(value).split(/\r?\n/)) {
      const p = piece.trim();
      if (!p) continue;
      // Colon glues the label to its value so long values stay readable.
      parts.push(sl ? `${sl}: ${p}` : p);
    }
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
// One wallet on as FEW lines as fit; long values wrap so we never emit one giant
// unreadable (multi-MB) line.
function entryLines(e: AiEntry, maxChars = MAX_INLINE): string[] {
  const parts = entryParts(e);
  if (!parts.length) return [];
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

type Row = { text: string; kind: "name" | "value"; owner: string };
function allRows(blocks: Block[]): Row[] {
  const rows: Row[] = [];
  for (const b of blocks) {
    rows.push({ text: b.header, kind: "name", owner: b.header });
    for (const ln of b.lines) rows.push({ text: ln, kind: "value", owner: b.header });
  }
  return rows;
}

// ── Weld once, pack by file SIZE, emit ─────────────────────────────────────────
// Splitting by line count is wrong because one inline wallet line can be huge.
// We weld every row once (at baseline 0), estimate its byte weight, then pack
// rows into files so each file stays under a target size (~3 MB → 3-4 files).
const BYTES_PER_POINT = 16;          // ~"1234.56 789.01 L\n"
const DEFAULT_MAX_BYTES = 3_000_000; // target per .ai file

interface WeldedRow { kind: "name" | "value"; owner: string; geom: MultiPoly | null; width: number; points: number; }

function countPoints(geom: MultiPoly | null): number {
  if (!geom) return 0;
  let n = 0;
  for (const poly of geom) for (const ring of poly) n += ring.length;
  return n;
}

function weldRow(r: { text: string; kind: "name" | "value"; owner: string }): WeldedRow {
  const { geom, width } = weldLine(r.text, 0);  // weld at baseline 0; translate later
  return { kind: r.kind, owner: r.owner, geom, width, points: countPoints(geom) };
}

function translateGeom(geom: MultiPoly, dy: number): MultiPoly {
  return geom.map((poly) => poly.map((ring) => ring.map(([x, y]) => [x, y + dy] as [number, number])));
}

function packBySize(welded: WeldedRow[], maxBytes: number): WeldedRow[][] {
  const parts: WeldedRow[][] = [];
  let cur: WeldedRow[] = [];
  let curBytes = 0;
  for (const w of welded) {
    const wb = w.points * BYTES_PER_POINT;
    if (cur.length && curBytes + wb > maxBytes) { parts.push(cur); cur = []; curBytes = 0; }
    cur.push(w);
    curBytes += wb;
  }
  if (cur.length) parts.push(cur);
  // Re-insert the product header when a file begins in the middle of a product.
  return parts.map((part) => {
    if (part.length && part[0]!.kind === "value") {
      return [weldRow({ text: part[0]!.owner, kind: "name", owner: part[0]!.owner }), ...part];
    }
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
    if (w.kind === "name") offset += GROUP_GAP;
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
    const c = w.kind === "value" ? COLOR_VALUE : COLOR_REF;
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
