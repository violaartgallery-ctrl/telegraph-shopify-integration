/**
 * A customer's photo -> the raster the laser engraves (port of ai_writer.py's
 * _prep_logo_raster / _engrave_black_white). Every bitmap in the factory's own
 * files is pure black and white, so the picture is finished that way:
 *   artwork on white   -> thresholded (thin grey lines kept black)
 *   photographed page  -> paper flattened, then thresholded (writing only)
 *   photograph         -> Floyd–Steinberg dots
 * and written as CMYK ink in UPPERCASE hex: RDWorks reads lowercase a–f as almost
 * no ink, which is what made the photos engrave faint.
 */
const LOGO_TARGET_DPI = 300;                        // the factory's own .rld bitmaps are ~303 DPI
const RICH_BLACK = [0xbf, 0xad, 0xa7, 0xe6];        // the factory deer's darkest ink, C/M/Y/K
const ENGRAVE_THRESHOLD = 192;
const ARTWORK_WHITE_SHARE = 0.3;
const PAGE_PAPER_SHARE = 0.65;

interface Gray { w: number; h: number; v: Float32Array }   // luminance 0..255, row-major

/** Decode (EXIF-oriented) to luminance over white. sharp when installed, else jimp. */
async function decodeGray(buf: Buffer): Promise<Gray> {
  let w = 0, h = 0, rgba: Uint8Array | Buffer;
  try {
    const sharp = (await import("sharp")).default;
    const { data, info } = await sharp(buf).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    w = info.width; h = info.height; rgba = data;
  } catch {
    const Jimp = (await import("jimp")).default;
    const im = await Jimp.read(buf);
    w = im.bitmap.width; h = im.bitmap.height; rgba = im.bitmap.data;
  }
  const v = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = rgba[i * 4 + 3]! / 255;                 // transparent -> white, not black
    const l = (rgba[i * 4]! * 299 + rgba[i * 4 + 1]! * 587 + rgba[i * 4 + 2]! * 114) / 1000;
    v[i] = Math.floor(l * a + 255 * (1 - a));
  }
  return { w, h, v };
}

function crop(g: Gray, x0: number, y0: number, x1: number, y1: number): Gray {
  const w = x1 - x0, h = y1 - y0, v = new Float32Array(w * h);
  for (let y = 0; y < h; y++) v.set(g.v.subarray((y0 + y) * g.w + x0, (y0 + y) * g.w + x1), y * w);
  return { w, h, v };
}

/** Separable resample like PIL's (support widened when shrinking). */
function resample(g: Gray, W: number, H: number, kernel: "bicubic" | "bilinear"): Gray {
  const k = kernel === "bicubic"
    ? (x: number) => { x = Math.abs(x); const a = -0.5;
      return x < 1 ? ((a + 2) * x - (a + 3)) * x * x + 1 : x < 2 ? (((x - 5) * x + 8) * x - 4) * a : 0; }
    : (x: number) => { x = Math.abs(x); return x < 1 ? 1 - x : 0; };
  const support = kernel === "bicubic" ? 2 : 1;
  const pass = (src: Float32Array, sw: number, sh: number, dw: number, horizontal: boolean) => {
    const n = horizontal ? sw : sh, m = horizontal ? sh : sw;
    const scale = n / dw, fs = Math.max(scale, 1), sup = support * fs;
    const out = new Float32Array(horizontal ? dw * sh : sw * dw);
    for (let i = 0; i < dw; i++) {
      const c = (i + 0.5) * scale;
      const lo = Math.max(0, Math.floor(c - sup)), hi = Math.min(n, Math.ceil(c + sup));
      const ws: number[] = [];
      let tot = 0;
      for (let j = lo; j < hi; j++) { const wt = k((j - c + 0.5) / fs); ws.push(wt); tot += wt; }
      for (let r = 0; r < m; r++) {
        let s = 0;
        for (let j = lo; j < hi; j++) s += ws[j - lo]! * src[horizontal ? r * sw + j : j * sw + r]!;
        const val = Math.min(255, Math.max(0, tot ? s / tot : 0));
        out[horizontal ? r * dw + i : i * sw + r] = val;
      }
    }
    return out;
  };
  const tmp = pass(g.v, g.w, g.h, W, true);
  const v = pass(tmp, W, g.h, H, false);
  return { w: W, h: H, v };
}

function maxFilter(g: Gray, size: number): Gray {
  const r = Math.floor(size / 2), v = new Float32Array(g.w * g.h);
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
    let m = 0;
    for (let dy = -r; dy <= r; dy++) {
      const yy = Math.min(g.h - 1, Math.max(0, y + dy));
      for (let dx = -r; dx <= r; dx++) {
        const val = g.v[yy * g.w + Math.min(g.w - 1, Math.max(0, x + dx))]!;
        if (val > m) m = val;
      }
    }
    v[y * g.w + x] = m;
  }
  return { w: g.w, h: g.h, v };
}

/** Gaussian blur approximated by three box blurs (as PIL does). */
function blur(g: Gray, radius: number): Gray {
  const r = Math.max(1, Math.round(radius * 0.88));
  let v = g.v;
  for (let pass = 0; pass < 3; pass++) {
    const h1 = new Float32Array(v.length), out = new Float32Array(v.length);
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
      let s = 0, n = 0;
      for (let dx = -r; dx <= r; dx++) { const xx = x + dx; if (xx >= 0 && xx < g.w) { s += v[y * g.w + xx]!; n++; } }
      h1[y * g.w + x] = s / n;
    }
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
      let s = 0, n = 0;
      for (let dy = -r; dy <= r; dy++) { const yy = y + dy; if (yy >= 0 && yy < g.h) { s += h1[yy * g.w + x]!; n++; } }
      out[y * g.w + x] = s / n;
    }
    v = out;
  }
  return { w: g.w, h: g.h, v };
}

/** PIL ImageOps.autocontrast(cutoff=(0.5, 0)) on 8-bit grey. */
function autocontrast(g: Gray): Float32Array {
  const hist = new Array<number>(256).fill(0);
  for (const val of g.v) hist[Math.round(val)]!++;
  let cut = Math.floor((g.v.length * 0.5) / 100);
  for (let lo = 0; lo < 256 && cut > 0; lo++) {
    if (cut > hist[lo]!) { cut -= hist[lo]!; hist[lo] = 0; } else { hist[lo]! -= cut; cut = 0; }
  }
  let lo = 0; while (lo < 256 && !hist[lo]) lo++;
  let hi = 255; while (hi >= 0 && !hist[hi]) hi--;
  const out = new Float32Array(g.v.length);
  if (hi <= lo) { out.set(g.v); return out; }
  const sc = 255 / (hi - lo), off = -lo * sc;
  for (let i = 0; i < g.v.length; i++) out[i] = Math.min(255, Math.max(0, Math.floor(Math.round(g.v[i]!) * sc + off)));
  return out;
}

/** Grey level that best splits writing from paper. */
function otsu(v: Float32Array): number {
  const p = new Array<number>(256).fill(0);
  for (const x of v) p[Math.min(255, Math.max(0, Math.floor(x)))]!++;
  const n = v.length;
  let w0 = 0, m = 0, best = -1, bestT = 128;
  let mTotal = 0;
  for (let i = 0; i < 256; i++) mTotal += (i * p[i]!) / n;
  for (let t = 0; t < 255; t++) {
    w0 += p[t]! / n; m += (t * p[t]!) / n;
    if (w0 <= 0 || w0 >= 1) continue;
    const between = (mTotal * w0 - m) ** 2 / (w0 * (1 - w0));
    if (between > best) { best = between; bestT = t + 1; }
  }
  return bestT;
}

function engraveBlackWhite(g: Gray): Uint8Array {
  const a = autocontrast(g);
  const out = new Uint8Array(a.length);
  const share = (arr: Float32Array, t: number) => { let c = 0; for (const x of arr) if (x >= t) c++; return c / arr.length; };
  if (share(a, 240) >= ARTWORK_WHITE_SHARE) {
    for (let i = 0; i < a.length; i++) out[i] = a[i]! < ENGRAVE_THRESHOLD ? 0 : 255;
    return out;
  }
  // No white background: divide by the local paper brightness so a shadowed page turns white.
  const f = Math.max(1, Math.floor(Math.min(g.w, g.h) / 64));
  const ac: Gray = { w: g.w, h: g.h, v: a };
  const small = resample(ac, Math.max(1, Math.floor(g.w / f)), Math.max(1, Math.floor(g.h / f)), "bilinear");
  const paper = resample(blur(maxFilter(small, 5), 3), g.w, g.h, "bilinear");
  const flat = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) flat[i] = Math.min(255, Math.max(0, (a[i]! / Math.max(paper.v[i]!, 1)) * 255));
  if (share(flat, 225) < PAGE_PAPER_SHARE) {
    // A photograph: Floyd–Steinberg dots, as PIL's convert("1").
    const e = Float32Array.from(a);
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
      const i = y * g.w + x, old = e[i]!, nv = old > 127 ? 255 : 0, err = old - nv;
      out[i] = nv;
      if (x + 1 < g.w) e[i + 1]! += (err * 7) / 16;
      if (y + 1 < g.h) {
        if (x > 0) e[i + g.w - 1]! += (err * 3) / 16;
        e[i + g.w]! += (err * 5) / 16;
        if (x + 1 < g.w) e[i + g.w + 1]! += err / 16;
      }
    }
    return out;
  }
  const t = otsu(flat);
  for (let i = 0; i < a.length; i++) out[i] = flat[i]! < t ? 0 : 255;
  return out;
}

export interface PreppedRaster { cols: number; rows: number; hex: string }

/** Crop the whitespace, size to 300 DPI at its real placement (zone in points),
 *  finish black/white and encode as the factory's CMYK. null = nothing to engrave. */
export async function prepPhotoRaster(buf: Buffer, zoneWPt: number, zoneHPt: number): Promise<PreppedRaster | null> {
  let g = await decodeGray(buf);
  const { w, h } = g;
  const v = g.v;
  // Light-grey paper around a photographed design would engrave as a faint plate:
  // when a ring just inside the edge is ONE flat light tone, stretch it to white.
  const inset = Math.max(2, Math.floor(Math.min(h, w) * 0.02));
  if (h > 2 * inset + 2 && w > 2 * inset + 2) {
    const ring: number[] = [];
    for (let x = inset; x < w - inset; x++) { ring.push(v[inset * w + x]!, v[(h - 1 - inset) * w + x]!); }
    for (let y = inset; y < h - inset; y++) { ring.push(v[y * w + inset]!, v[y * w + (w - 1 - inset)]!); }
    const sorted = [...ring].sort((p, q) => p - q);
    const mid = sorted.length / 2;
    const paper = sorted.length % 2 ? sorted[Math.floor(mid)]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    const mean = ring.reduce((s, x) => s + x, 0) / ring.length;
    const std = Math.sqrt(ring.reduce((s, x) => s + (x - mean) ** 2, 0) / ring.length);
    if (paper >= 190 && std < 12) {
      if (paper < 250) for (let i = 0; i < v.length; i++) v[i] = Math.min(255, (v[i]! * 255) / paper);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (y < inset || y >= h - inset || x < inset || x >= w - inset) v[y * w + x] = 255;
      }
    }
  }
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let i = 0; i < v.length; i++) {
    if (v[i]! >= 245) v[i] = 255;                    // near-white JPEG noise would scatter as dots
    v[i] = Math.floor(v[i]!);
    if (v[i]! < 250) { const x = i % w, y = (i - x) / w; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  const m = Math.max(2, Math.floor(Math.min(w, h) * 0.01));
  g = crop(g, Math.max(0, x0 - m), Math.max(0, y0 - m), Math.min(w, x1 + m), Math.min(h, y1 + m));
  const aspect = g.w / g.h;
  const placeWPt = aspect >= zoneWPt / zoneHPt ? zoneWPt : zoneHPt * aspect;
  const targetPx = Math.floor((placeWPt / 72.0) * LOGO_TARGET_DPI);
  if (targetPx >= 1 && g.w !== targetPx) {
    g = resample(g, targetPx, Math.max(1, Math.round((g.h * targetPx) / g.w)), "bicubic");
    for (let i = 0; i < g.v.length; i++) g.v[i] = Math.round(g.v[i]!);
  }
  const bw = engraveBlackWhite(g);
  const black = Buffer.from(RICH_BLACK).toString("hex").toUpperCase();
  const parts: string[] = new Array(bw.length);
  for (let i = 0; i < bw.length; i++) parts[i] = bw[i] ? "00000000" : black;
  return { cols: g.w, rows: g.h, hex: parts.join("") };
}
