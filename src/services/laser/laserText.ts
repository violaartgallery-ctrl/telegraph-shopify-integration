/**
 * Writing sized for a place on a piece (port of ai_writer.py's _title_geom /
 * _keychain_text_block and wallet_writer.py's _fit_block / _place_box).
 */
import { textWidth, weldLinesBlock, wrapToWidth } from "../aiWriter.js";
import { bounds, MM, type MultiPoly, scale, TITLE_H_MM, translate } from "./laserCore.js";

/** The factory's title over each set, e.g. "1 X LINES WALLET BROWN" (+ a note such
 *  as "+ PHOTO 13" for the operator): one line, TITLE_H_MM tall, at most maxWmm
 *  wide, bottom-left at (0, 0). */
export function titleGeom(title: string, color: string, maxWmm: number, note = ""): MultiPoly | null {
  const text = `1 X ${title} ${color} ${note}`.toUpperCase().split(/\s+/).filter(Boolean).join(" ");
  const block = weldLinesBlock([text]);
  if (!block || !block.length) return null;
  const [minx, miny, maxx, maxy] = bounds(block);
  const s = Math.min((TITLE_H_MM * MM) / Math.max(maxy - miny, 1e-6), (maxWmm * MM) / Math.max(maxx - minx, 1e-6));
  const g = scale(block, s);
  const b = bounds(g);
  return translate(g, -b[0], -b[1]);
}

function centred(g: MultiPoly): MultiPoly {
  const [minx, miny, maxx, maxy] = bounds(g);
  return translate(g, -(minx + maxx) / 2, -(miny + maxy) / 2);
}

/** Medallion text: weld and scale into the zone, trying 1..6 lines and keeping
 *  the split with the largest letters. Centred on (0, 0). Font units. */
export function keychainTextBlock(text: string, zoneW: number, zoneH1: number, zoneHmax: number): MultiPoly | null {
  let best: MultiPoly | null = null, bestS = 0;
  const tried = new Set<number>();
  const total = textWidth(text);
  const nWords = text.split(/\s+/).filter(Boolean).length;
  for (let n = 1; n <= 6; n++) {
    const lines = n === 1 ? [text] : wrapToWidth(text, total / n + 1.0);
    if (tried.has(lines.length)) continue;
    tried.add(lines.length);
    const block = weldLinesBlock(lines);
    if (!block || !block.length) continue;
    const [minx, miny, maxx, maxy] = bounds(block);
    const zoneH = lines.length === 1 ? zoneH1 : zoneHmax;
    const s = Math.min(zoneW / Math.max(maxx - minx, 1e-6), zoneH / Math.max(maxy - miny, 1e-6));
    if (s > bestS) { best = block; bestS = s; }
    if (lines.length >= nWords) break;
  }
  return best ? centred(scale(best, bestS)) : null;
}

/** A writing place: x range (mm), one line's height cap, the block's height cap,
 *  alignment, and its bottom or centre (mm). */
export interface Zone {
  x: [number, number];
  line_h: number;
  max_h: number;
  align: "left" | "right" | "centre";
  bottom?: number;
  cy?: number;
  photo_h: number;
  centre_multi?: boolean;
}

/** Weld `text` (+ marker lines) into the zone at the largest size: one line unless
 *  it only fits smaller, then up to 4 lines. [block centred on (0,0), n lines]. */
export function fitBlock(text: string, extraLines: string[], zone: Zone): [MultiPoly | null, number] {
  const zoneW = (zone.x[1] - zone.x[0]) * MM;
  const lineH = zone.line_h * MM, maxH = zone.max_h * MM;
  let best: MultiPoly | null = null, bestS = 0, bestN = 0;
  const tried = new Set<number>();
  const total = text ? textWidth(text) : 0;
  const nWords = text.split(/\s+/).filter(Boolean).length;
  for (let n = 1; n <= 4; n++) {
    const lines = text ? (n === 1 ? [text] : wrapToWidth(text, total / n + 1.0)) : [];
    if (tried.has(lines.length)) continue;
    tried.add(lines.length);
    const block = weldLinesBlock([...lines, ...extraLines]);
    if (!block || !block.length) continue;
    const k = lines.length + extraLines.length;
    const [minx, miny, maxx, maxy] = bounds(block);
    const bw = Math.max(maxx - minx, 1e-6), bh = Math.max(maxy - miny, 1e-6);
    const s = Math.min(zoneW / bw, maxH / bh, (lineH * k) / bh);
    if (s > bestS * 1.02) { best = block; bestS = s; bestN = k; }  // more lines only when clearly bigger
    if (!text || lines.length >= nWords) break;
  }
  return best ? [centred(scale(best, bestS)), bestN] : [null, 0];
}

/** Bottom-left (mm) of a w x h block in its zone of the set at (ox, oy). A longer
 *  writing is centred where the zone says so; otherwise it keeps the zone's side. */
export function placeBox(w: number, h: number, nLines: number, zone: Zone, ox: number, oy: number): [number, number] {
  const x0 = ox + zone.x[0], x1 = ox + zone.x[1];
  const align = nLines > 1 && zone.centre_multi ? "centre" : zone.align;
  const bx = align === "left" ? x0 : align === "right" ? x1 - w : (x0 + x1 - w) / 2;
  const by = zone.bottom !== undefined ? oy + zone.bottom : oy + zone.cy! - h / 2;
  return [bx, by];
}
