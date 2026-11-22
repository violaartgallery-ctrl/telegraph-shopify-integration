/**
 * A coloured logo / design -> black lines on white for the laser, no AI (port of the
 * agent's line_art.py). Colours are grouped (k-means in Lab, near shades merged); the
 * background group turns white; thin parts (lettering, lines) and black ink stay
 * solid; larger coloured areas keep only their outline. Only for a picture that is a
 * graphic in colour, or light on a dark background - a black drawing on white keeps
 * the plain threshold and a photograph keeps its dots.
 */

export interface Rgb { w: number; h: number; r: Float64Array; g: Float64Array; b: Float64Array }   // 0..255, row-major

export const LINE_ART_WORK = 1200;     // working size, px on the long side
export const LINE_ART_GATE = 320;      // size the photo / graphic test runs at
const K = 8;                           // colour groups before merging
const MERGE_DE = 20.0;                 // groups closer than this (Lab dE) are one colour
const BG_DE = 14.0;                    // this close to the background colour -> background
const INK_L = 35.0, INK_C = 25.0;      // darker and greyer than this -> black ink, solid
const PAPER_L = 85.0, PAPER_C = 12.0;  // lighter and greyer than this on a light background -> paper
const LIGHT_BG_L = 60.0;
const THIN = 0.011;                    // a part narrower than this share of the short side -> solid
const SAMPLE = 60000;                  // pixels the colour groups are found from
const SHADE_DE = 6.0, EDGE_DE = 20.0, EDGE_NEAR = 3;
const PHOTO_SHADE = 0.12;              // more smooth shading than this, away from edges -> a photograph
const COLOUR_C = 20.0, COLOUR_SHARE = 0.05;
const DARK_L = 40.0, DARK_SHARE = 0.3, TWO_TONE_RES = 1.7;

interface Lab { n: number; L: Float64Array; A: Float64Array; B: Float64Array }

const lin = (v: number) => { const c = v / 255.0; return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92; };
const fLab = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

function toLab(im: Rgb): Lab {
  const n = im.w * im.h, L = new Float64Array(n), A = new Float64Array(n), B = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = lin(im.r[i]!), g = lin(im.g[i]!), b = lin(im.b[i]!);
    const fx = fLab((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
    const fy = fLab(r * 0.2126 + g * 0.7152 + b * 0.0722);
    const fz = fLab((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
    L[i] = 116 * fy - 16; A[i] = 500 * (fx - fy); B[i] = 200 * (fy - fz);
  }
  return { n, L, A, B };
}

const dist2 = (p: Lab, i: number, c: Float64Array, j: number) => {
  const dl = p.L[i]! - c[j * 3]!, da = p.A[i]! - c[j * 3 + 1]!, db = p.B[i]! - c[j * 3 + 2]!;
  return dl * dl + da * da + db * db;
};

/** Nearest centre of every point (the first on a tie). */
function nearest(p: Lab, c: Float64Array, k: number): Int32Array {
  const out = new Int32Array(p.n), best = new Float64Array(p.n).fill(Infinity);
  for (let j = 0; j < k; j++) {
    for (let i = 0; i < p.n; i++) { const d = dist2(p, i, c, j); if (d < best[i]!) { best[i] = d; out[i] = j; } }
  }
  return out;
}

/** k-means, deterministic: seeds at the most common colours (Lab boxes of 10, each
 *  seed at least MERGE_DE from the others - flat fills, not the shades between them),
 *  then 12 rounds. Returns the centres (at most k). */
function kmeans(p: Lab, k: number): Float64Array {
  const boxes = new Map<number, number[]>();          // box -> [count, sum L, sum a, sum b]
  for (let i = 0; i < p.n; i++) {
    const id = Math.floor(p.L[i]! / 10) * 1000 + Math.floor((p.A[i]! + 130) / 10) * 30 + Math.floor((p.B[i]! + 130) / 10);
    const b = boxes.get(id) ?? [0, 0, 0, 0];
    b[0]! += 1; b[1]! += p.L[i]!; b[2]! += p.A[i]!; b[3]! += p.B[i]!;
    boxes.set(id, b);
  }
  const seeds: number[][] = [];
  for (const [, b] of [...boxes].sort((x, y) => y[1][0]! - x[1][0]! || x[0] - y[0])) {
    const m = [b[1]! / b[0]!, b[2]! / b[0]!, b[3]! / b[0]!];
    if (seeds.every((x) => Math.sqrt((m[0]! - x[0]!) * (m[0]! - x[0]!) + (m[1]! - x[1]!) * (m[1]! - x[1]!) + (m[2]! - x[2]!) * (m[2]! - x[2]!)) >= MERGE_DE)) {
      seeds.push(m);
      if (seeds.length === k) break;
    }
  }
  k = seeds.length;
  const c = Float64Array.from(seeds.flat());
  for (let round = 0; round < 12; round++) {
    const lab = nearest(p, c, k), n = new Float64Array(k), s = new Float64Array(k * 3);
    for (let i = 0; i < p.n; i++) { const j = lab[i]!; n[j]! += 1; s[j * 3]! += p.L[i]!; s[j * 3 + 1]! += p.A[i]!; s[j * 3 + 2]! += p.B[i]!; }
    for (let j = 0; j < k; j++) if (n[j]! > 0) for (let ch = 0; ch < 3; ch++) c[j * 3 + ch] = s[j * 3 + ch]! / n[j]!;
  }
  return c;
}

/** The picture's edge pixels: top row, bottom row, left column, right column. */
function borderValues<T extends ArrayLike<number>>(a: T, w: number, h: number): number[] {
  const out: number[] = [];
  for (let x = 0; x < w; x++) out.push(a[x]!);
  for (let x = 0; x < w; x++) out.push(a[(h - 1) * w + x]!);
  for (let y = 0; y < h; y++) out.push(a[y * w]!);
  for (let y = 0; y < h; y++) out.push(a[y * w + w - 1]!);
  return out;
}

/** Colourfulness of group g's mean colour. */
const chroma = (c: Float64Array, g: number) => Math.sqrt(c[g * 3 + 1]! * c[g * 3 + 1]! + c[g * 3 + 2]! * c[g * 3 + 2]!);

function mostCommon(values: number[], k: number): number {
  const n = new Array<number>(k).fill(0);
  for (const v of values) n[v]!++;
  return n.indexOf(Math.max(...n));
}

/** Grow true pixels into their 4 neighbours, `times` times (outside counts as false). */
function dilate(m: Uint8Array, w: number, h: number, times: number): Uint8Array {
  let cur = m;
  for (let t = 0; t < times; t++) {
    const next = new Uint8Array(cur);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (cur[i]) continue;
      if ((x > 0 && cur[i - 1]) || (x + 1 < w && cur[i + 1]) || (y > 0 && cur[i - w]) || (y + 1 < h && cur[i + w])) next[i] = 1;
    }
    cur = next;
  }
  return cur;
}

/** 4-connected parts of a mask: label per pixel (0 = none, 1..n) and n. */
function label(m: Uint8Array, w: number, h: number): [Int32Array, number] {
  const lab = new Int32Array(w * h), stack: number[] = [];
  let n = 0;
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || lab[s]) continue;
    lab[s] = ++n; stack.push(s);
    while (stack.length) {
      const i = stack.pop()!, x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x + 1 < w ? i + 1 : -1, i >= w ? i - w : -1, i + w < m.length ? i + w : -1]) {
        if (j >= 0 && m[j] && !lab[j]) { lab[j] = n; stack.push(j); }
      }
    }
  }
  return [lab, n];
}

/** Squared distance of every true pixel to the nearest false one (exact, Felzenszwalb). */
function distance2(m: Uint8Array, w: number, h: number): Float64Array {
  const INF = 1e20, f = new Float64Array(w * h);
  for (let i = 0; i < f.length; i++) f[i] = m[i] ? INF : 0;
  const line = (get: (i: number) => number, set: (i: number, v: number) => void, n: number) => {
    const v = new Int32Array(n), z = new Float64Array(n + 1), src = new Float64Array(n);
    for (let q = 0; q < n; q++) src[q] = get(q);
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = ((src[q]! + q * q) - (src[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      while (s <= z[k]!) { k--; s = ((src[q]! + q * q) - (src[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1]! < q) k++; set(q, (q - v[k]!) * (q - v[k]!) + src[v[k]!]!); }
  };
  for (let x = 0; x < w; x++) line((y) => f[y * w + x]!, (y, val) => { f[y * w + x] = val; }, h);
  for (let y = 0; y < h; y++) line((x) => f[y * w + x]!, (x, val) => { f[y * w + x] = val; }, w);
  return f;
}

/** 5 x 5 median of one 0..255 channel, edges repeated (a sliding histogram). */
function median5(src: Float64Array, w: number, h: number): Float64Array {
  const out = new Float64Array(w * h), R = 2, RANK = 12;
  const at = (x: number, y: number) => src[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]!;
  const hist = new Int32Array(256);
  for (let y = 0; y < h; y++) {
    hist.fill(0);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) hist[at(dx, y + dy)]!++;
    let med = 0, below = 0;
    while (below + hist[med]! <= RANK) { below += hist[med]!; med++; }
    out[y * w] = med;
    for (let x = 1; x < w; x++) {
      for (let dy = -R; dy <= R; dy++) {
        const gone = at(x - R - 1, y + dy), come = at(x + R, y + dy);
        hist[gone]!--; if (gone < med) below--;
        hist[come]!++; if (come < med) below++;
      }
      while (below > RANK) { med--; below -= hist[med]!; }
      while (below + hist[med]! <= RANK) { below += hist[med]!; med++; }
      out[y * w + x] = med;
    }
  }
  return out;
}

/** A coloured graphic (logo, lettering, drawing) or a light design on a dark ground -
 *  not a photograph, not a plain black drawing on white. `im` at LINE_ART_GATE. */
export function isGraphic(im: Rgb): boolean {
  const { w, h } = im, p = toLab(im);
  let coloured = 0, darkPx = 0;
  for (let i = 0; i < p.n; i++) {
    if (Math.sqrt(p.A[i]! * p.A[i]! + p.B[i]! * p.B[i]!) > COLOUR_C) coloured++;
    if (p.L[i]! < DARK_L) darkPx++;
  }
  const colourful = coloured / p.n >= COLOUR_SHARE;
  if (!colourful && darkPx / p.n < DARK_SHARE) return false;          // black on white: the plain threshold does it
  const c = kmeans(p, K), lab = nearest(p, c, c.length / 3);
  const res = new Float64Array(p.n);
  for (let i = 0; i < p.n; i++) res[i] = Math.sqrt(dist2(p, i, c, lab[i]!));
  const bg = mostCommon(borderValues(lab, w, h), K);
  const content = new Uint8Array(p.n), step = new Uint8Array(p.n);
  const diff = (i: number, j: number) => {
    const dl = p.L[i]! - p.L[j]!, da = p.A[i]! - p.A[j]!, db = p.B[i]! - p.B[j]!;
    return Math.sqrt(dl * dl + da * da + db * db);
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    content[i] = Math.sqrt(dist2(p, i, c, bg)) >= BG_DE ? 1 : 0;
    const right = x + 1 < w ? diff(i + 1, i) : 0, down = y + 1 < h ? diff(i + w, i) : 0;
    step[i] = Math.max(right, down) > EDGE_DE ? 1 : 0;
  }
  const near = dilate(step, w, h, EDGE_NEAR);
  let nContent = 0, shaded = 0, resSum = 0;
  for (let i = 0; i < p.n; i++) {
    if (content[i]) { nContent++; if (res[i]! > SHADE_DE && !near[i]) shaded++; }
    resSum += res[i]!;
  }
  if (shaded / Math.max(1, nContent) >= PHOTO_SHADE) return false;   // a photograph keeps its dots
  return colourful || (c[bg * 3]! < DARK_L && resSum / p.n < TWO_TONE_RES);
}

/** The picture as black (0) and white (255) lines. `im` at most LINE_ART_WORK. */
export function lineArt(im: Rgb): Float32Array {
  const { w, h } = im;
  const p = toLab({ w, h, r: median5(im.r, w, h), g: median5(im.g, w, h), b: median5(im.b, w, h) });
  const stride = Math.max(1, Math.floor(p.n / SAMPLE)), m = Math.ceil(p.n / stride);
  const sample: Lab = { n: m, L: new Float64Array(m), A: new Float64Array(m), B: new Float64Array(m) };
  for (let s = 0; s < m; s++) { sample.L[s] = p.L[s * stride]!; sample.A[s] = p.A[s * stride]!; sample.B[s] = p.B[s * stride]!; }
  const c = kmeans(sample, K);
  const k = c.length / 3, raw = nearest(p, c, k);
  // near shades are one colour - never chained further than MERGE_DE across
  const d = (i: number, j: number) => {
    const dl = c[i * 3]! - c[j * 3]!, da = c[i * 3 + 1]! - c[j * 3 + 1]!, db = c[i * 3 + 2]! - c[j * 3 + 2]!;
    return Math.sqrt(dl * dl + da * da + db * db);
  };
  const group = Array.from({ length: k }, (_x, i) => i), pairs: Array<[number, number, number]> = [];
  for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) if (d(i, j) < MERGE_DE) pairs.push([d(i, j), i, j]);
  pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  for (const [, i, j] of pairs) {
    const gi = group[i]!, gj = group[j]!;
    if (gi === gj) continue;
    let close = true;
    for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) if (group[a] === gi && group[b] === gj && d(a, b) >= MERGE_DE) close = false;
    if (close) for (let a = 0; a < k; a++) if (group[a] === gj) group[a] = gi;
  }
  const lab = new Int32Array(p.n), n = new Float64Array(K), mean = new Float64Array(K * 3);
  for (let i = 0; i < p.n; i++) {
    const g = group[raw[i]!]!; lab[i] = g; n[g]! += 1;
    mean[g * 3]! += p.L[i]!; mean[g * 3 + 1]! += p.A[i]!; mean[g * 3 + 2]! += p.B[i]!;
  }
  for (let g = 0; g < K; g++) for (let ch = 0; ch < 3; ch++) mean[g * 3 + ch] = mean[g * 3 + ch]! / Math.max(n[g]!, 1);
  // the background is the colour most of the edge is (plus paper tones on a light one)
  const bg = mostCommon(borderValues(lab, w, h), K);
  const lightBg = mean[bg * 3]! > LIGHT_BG_L;
  const toBg = new Uint8Array(K);
  for (let g = 0; g < K; g++) {
    if (g === bg || !n[g]) continue;
    const dl = mean[g * 3]! - mean[bg * 3]!, da = mean[g * 3 + 1]! - mean[bg * 3 + 1]!, db = mean[g * 3 + 2]! - mean[bg * 3 + 2]!;
    if (Math.sqrt(dl * dl + da * da + db * db) < BG_DE || (lightBg && mean[g * 3]! > PAPER_L && chroma(mean, g) < PAPER_C)) toBg[g] = 1;
  }
  for (let i = 0; i < p.n; i++) if (toBg[lab[i]!]) lab[i] = bg;
  // thin parts and black ink are solid; the rest is outlined below
  const black = new Uint8Array(p.n), fillPx = Math.max(2.0, THIN * Math.min(h, w));
  for (let g = 0; g < K; g++) {
    if (g === bg) continue;
    const mask = new Uint8Array(p.n);
    let any = false;
    for (let i = 0; i < p.n; i++) if (lab[i] === g) { mask[i] = 1; any = true; }
    if (!any) continue;
    const ink = mean[g * 3]! < INK_L && chroma(mean, g) < INK_C;
    const [comp, nComp] = label(mask, w, h);
    const thick = new Float64Array(nComp + 1), d2 = distance2(mask, w, h);
    for (let i = 0; i < p.n; i++) if (comp[i]! && d2[i]! > thick[comp[i]!]!) thick[comp[i]!] = d2[i]!;
    for (let i = 0; i < p.n; i++) if (comp[i]! && (ink || Math.sqrt(thick[comp[i]!]!) < fillPx)) black[i] = 1;
  }
  // every border between two colours is a line
  const edge = new Uint8Array(p.n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (lab[i] !== lab[i - 1] || lab[i] !== lab[i - w]) edge[i] = 1;
  }
  const lines = dilate(edge, w, h, Math.max(1, Math.floor(Math.min(h, w) / 500 + 0.5)));
  for (let i = 0; i < p.n; i++) if (lines[i]) black[i] = 1;
  // specks, and screenshot frames / corner shadows lying along the picture's edge
  const [comp, nComp] = label(black, w, h);
  const size = new Float64Array(nComp + 1), inBand = new Float64Array(nComp + 1);
  const b = Math.max(3, Math.floor(0.02 * Math.min(h, w) + 0.5));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const part = comp[y * w + x]!;
    if (!part) continue;
    size[part]! += 1;
    if (y < b || y >= h - b || x < b || x >= w - b) inBand[part]! += 1;
  }
  const minSize = Math.max(12, h * w * 2e-5);
  const out = new Float32Array(p.n).fill(255);
  for (let i = 0; i < p.n; i++) {
    const part = comp[i]!;
    if (part && size[part]! >= minSize && inBand[part]! / Math.max(size[part]!, 1) < 0.6) out[i] = 0;
  }
  return out;
}
