/**
 * Dev check (not built): run every example from viola-production-agent's examples
 * folder (each NN_ folder's entry.json, photos in _photos) through the bot's laser
 * writers and write the files to the folder's ts/ so they can be compared with Python's.
 * Usage: npx tsx src/scripts/_laserCompare.ts "F:/ayman agent/output/examples_20261031"
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildBoxGridBuffers } from "../services/aiWriter.js";
import { buildLaserArtifacts } from "../services/laser/laserFiles.js";
import type { LaserEntry } from "../services/laser/laserRouting.js";

const dir = process.argv[2]!;
const only = process.argv[3];
for (const name of readdirSync(dir).sort()) {
  if (!/^\d\d_/.test(name) || (only && !name.startsWith(only))) continue;
  const raw = JSON.parse(readFileSync(join(dir, name, "entry.json"), "utf8"));
  const entry: LaserEntry = { ...raw, customization_cleaned: (raw.customization_cleaned ?? []).map((x: any) => [x[0], x[1]]) };
  const photos = new Map<string, Buffer>();
  for (const p of entry.photo_numbers ?? []) {
    const f = join(dir, "_photos", (p as any).local_filename ?? "");
    if (p.attachment_url && (p as any).local_filename && existsSync(f)) photos.set(p.attachment_url, readFileSync(f));
  }
  const out = join(dir, name, "ts");
  mkdirSync(out, { recursive: true });
  const t0 = Date.now();
  const files = await buildLaserArtifacts([entry], photos);
  const counts = new Map<string, number>();
  for (const f of files) {
    const n = (counts.get(f.kind) ?? 0) + 1;
    counts.set(f.kind, n);
    writeFileSync(join(out, `${f.kind}_${n}.ai`), f.buffer);
  }
  const boxes = await buildBoxGridBuffers([entry] as never, photos);
  boxes.forEach((b, i) => writeFileSync(join(out, `box_grid_${i + 1}.ai`), b));
  console.log(`${name}: ${[...counts].map(([k, n]) => `${k}x${n}`).join(" ")}${boxes.length ? ` box_gridx${boxes.length}` : ""} (${Date.now() - t0} ms)`);
}
