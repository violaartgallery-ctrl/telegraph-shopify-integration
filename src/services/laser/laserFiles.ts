/**
 * Every laser file of a production batch except the box grid, in a fixed order so
 * a resumed preview regenerates the same files under the same artifact keys:
 * the line-by-line file (products with no laser template, and bundle fields no
 * piece takes), then medallions, wallets, passport holders, purses, purse boxes.
 */
import { buildAiBuffers, ensureHB } from "../aiWriter.js";
import { buildKeychainFiles } from "./keychainFile.js";
import { bundleLeftover, hasLaserPiece, type LaserEntry, LASER_PIECES, entryPieces } from "./laserRouting.js";
import { buildPieceFiles } from "./pieceFile.js";
import { buildWalletFiles } from "./walletFile.js";

export interface LaserArtifact {
  buffer: Buffer;
  /** file name stem, e.g. "wallets" */
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
  add(await buildKeychainFiles(entries, photos), "keychains", "ملف الميداليات");
  add(await buildWalletFiles(entries, photos), "wallets", "ملف المحافظ");
  add(await buildPieceFiles("passport", entries, photos), "passports", "ملف الباسبور");
  add(await buildPieceFiles("purse", entries, photos), "purses", "ملف البورت");
  add(await buildPieceFiles("purse_box", entries, photos), "purse_boxes", "ملف علبة البورت");
  return out;
}
