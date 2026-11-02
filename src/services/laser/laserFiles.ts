/**
 * Every laser file of a production batch except the box grid, in a fixed order so
 * a resumed preview regenerates the same files under the same artifact keys:
 * the line-by-line file (products with no laser template, and bundle fields no
 * piece takes), then one file per leather colour (owner, 2026-11-02: "a laser file
 * by colour, not by product") with that colour's wallets, passport holders, purses,
 * purse boxes and medallions, colours A-Z.
 */
import { buildAiBuffers, ensureHB } from "../aiWriter.js";
import { keychainCells } from "./keychainFile.js";
import { colourSheets } from "./laserCore.js";
import { bundleLeftover, hasLaserPiece, type LaserEntry, LASER_PIECES, entryPieces } from "./laserRouting.js";
import { pieceCells } from "./pieceFile.js";
import { walletCells } from "./walletFile.js";

export interface LaserArtifact {
  buffer: Buffer;
  /** file name stem, e.g. "laser" or a colour's "dark-navy" */
  kind: string;
  /** Arabic name for the Telegram caption */
  label: string;
}

/** Customer photos that go ON a laser piece (print photos have no position). */
export function laserPhotoUrls(entries: LaserEntry[]): string[] {
  const urls = new Set<string>();
  for (const e of entries) {
    if (!LASER_PIECES.some((p) => entryPieces(e).has(p))) continue;
    for (const p of e.photo_numbers ?? []) {
      if ((p.position_label ?? "").trim() && p.attachment_url) urls.add(p.attachment_url);
    }
  }
  return [...urls];
}

export async function buildLaserArtifacts(
  entries: LaserEntry[], photos: Map<string, Buffer>, opts: { maxBytes?: number } = {},
): Promise<LaserArtifact[]> {
  await ensureHB();   // HarfBuzz must be loaded before any writing is welded
  const out: LaserArtifact[] = [];
  const add = (buffers: Buffer[], kind: string, label: string) => buffers.forEach((buffer) => out.push({ buffer, kind, label }));
  const linear = entries.filter((e) => !hasLaserPiece(e));
  for (const e of entries) {
    const leftover = bundleLeftover(e);
    if (leftover) linear.push(leftover);
  }
  if (linear.length) add(await buildAiBuffers(linear as never, { maxBytes: opts.maxBytes }), "laser", "ملف الليزر");
  const cells = [
    ...await walletCells(entries, photos),
    ...await pieceCells("passport", entries, photos),
    ...await pieceCells("purse", entries, photos),
    ...await pieceCells("purse_box", entries, photos),
    ...await keychainCells(entries, photos),
  ];
  for (const { color, files } of await colourSheets(cells)) {
    add(files, colourStem(color), color ? `ملف ليزر ${color.toUpperCase()}` : "ملف ليزر - لون مش معروف");
  }
  return out;
}

/** A colour's file name stem: "Dark Navy" -> "dark-navy"; no colour -> "no-colour". */
export function colourStem(color: string): string {
  return color.toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, "-").replace(/^-+|-+$/g, "") || "no-colour";
}
