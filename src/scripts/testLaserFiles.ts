/**
 * Laser files: routing to the store's own product families, photos engraved in
 * solid black/white with UPPERCASE hex, colour logos redrawn as lines, plain pieces still cut, and every file
 * kind (medallions, wallets, passport holders, purses, purse boxes, box grid).
 * Run: npm run test:laser-files
 */
import assert from "node:assert/strict";
import Jimp from "jimp";
import { balancedLines, boxTextLines, buildBoxGridBuffers, ensureHB, weldLine, wordmarkIn } from "../services/aiWriter.js";
import { buildKeychainFiles } from "../services/laser/keychainFile.js";
import { BED_H_MM, BED_W_MM, colourSheets, type LaserCell, LIMITS, shelfPages } from "../services/laser/laserCore.js";
import { buildLaserArtifacts } from "../services/laser/laserFiles.js";
import { photoSignature, pickDesign, prepPhotoRaster, samePhoto } from "../services/laser/laserPhoto.js";
import { isGraphic, lineArt, type Rgb } from "../services/laser/laserLineArt.js";
import { bundleLeftover, cleanLines, cleanText, entryPieces, heartsLast, type LaserEntry, partFields } from "../services/laser/laserRouting.js";
import { buildPieceFiles, pieceCell, pieceLogo, pieceZoneFor } from "../services/laser/pieceFile.js";
import { PIECE_TEMPLATES } from "../services/laser/laserAssets.js";
import { buildWalletFiles, placedByZone, placeTexts, templateGeom, WALLET_ZONES, walletZoneFor } from "../services/laser/walletFile.js";
import { fitBlock } from "../services/laser/laserText.js";
import { BOX_TEMPLATE } from "../services/boxAssets.js";
import { WALLET_TEMPLATE } from "../services/laser/laserAssets.js";
import { bounds, MM } from "../services/laser/laserCore.js";

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (error) { console.error(`FAIL ${name}\n${(error as Error).stack}`); process.exitCode = 1; }
}

function entry(title: string, fields: Array<[string, string]> = [], qty = 1, photos: LaserEntry["photo_numbers"] = []): LaserEntry {
  return { display_product: title, display_color: "Brown", customization_cleaned: fields, photo_numbers: photos,
    total_quantity: qty, source_orders: [{ order_name: "#1", remaining_quantity: qty }] };
}
const text = (b: Buffer) => b.toString("latin1");
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

async function blackSquarePng(): Promise<Buffer> {
  const im = new Jimp(240, 160, 0xffffffff);
  im.scan(60, 40, 120, 80, (_x, _y, idx) => { im.bitmap.data.writeUInt32BE(0x000000ff, idx); });
  return im.getBufferAsync(Jimp.MIME_PNG);
}

await test("only the store's own wallet families use the wallet template", () => {
  for (const t of ["Wallet", "Lines wallet", "Decorated wallet with transparent pocket",
    "Lines wallet + Photo keychain + Gift box bundle", "wallet with transparent pocket + Gift box bundle"]) {
    assert.ok(entryPieces(entry(t)).has("wallet"), t);
  }
  for (const t of ["Flip Bifold – Magnetic Leather Wallet", "Easy Carry Wallet – Genuine Leather",
    "Full Carry Wallet – Genuine Leather", "Slim Money Clip Wallet – Genuine Leather", "Magic Wallet - RFID protection"]) {
    assert.equal(entryPieces(entry(t)).size, 0, t);
  }
});

await test("purse bundle feeds the purse, the medallion and the purse box", () => {
  const b = entry("Purse + Photo keychain + Gift purse box bundle",
    [["برا", "Sara"], ["كتابة على الميدالية", "S"], ["كتابة علي البوكس", "Love"]]);
  assert.deepEqual([...entryPieces(b)].sort(), ["keychain", "purse", "purse_box"]);
  assert.deepEqual(partFields(b, "purse"), [["برا", "Sara"]]);
  assert.deepEqual(partFields(b, "purse_box"), [["كتابة علي البوكس", "Love"]]);
  assert.deepEqual([...entryPieces(entry("Gift purse box"))], ["purse_box"]);
});

await test("travel set: passport takes its fields, the bag tag goes to the line-by-line file", () => {
  const e = entry("The Leather Travel Set", [["المحفظة جوا شمال", "Sara"]],
    1, [{ position_label: "Bag tag لوجو", display_label: "photo 1", order_name: "#1" }]);
  assert.deepEqual([...entryPieces(e)].sort(), ["bag_tag", "passport"]);
  assert.equal(bundleLeftover(e)?.photo_numbers?.[0]?.position_label, "Bag tag لوجو");
});

await test("unusual labels still find their place: a purse photo with no side, an Arabic bag tag", () => {
  assert.equal(pieceZoneFor("purse", "blank", "الوش"), "cover");
  assert.equal(pieceZoneFor("purse", "mandala", "البورتفيه"), "cover");
  assert.equal(pieceZoneFor("purse", "blank", "جوا"), "inner");
  const e = entry("The Leather Travel Set", [], 1, [{ position_label: "باج تاج", display_label: "photo 1", order_name: "#1" }]);
  assert.equal(bundleLeftover(e)?.photo_numbers?.[0]?.position_label, "باج تاج");
});

await test("photos engrave solid black/white in UPPERCASE hex", async () => {
  const r = await prepPhotoRaster(await blackSquarePng(), 200, 100);
  assert.ok(r);
  assert.equal(r!.hex, r!.hex.toUpperCase());
  const px = new Set<string>();
  for (let i = 0; i < r!.hex.length; i += 8) px.add(r!.hex.slice(i, i + 8));
  assert.deepEqual([...px].sort(), ["00000000", "BFADA7E6"]);
});

/** A picture drawn pixel by pixel: [r, g, b] at (x, y). */
function picture(w: number, h: number, at: (x: number, y: number) => [number, number, number]): Rgb {
  const im: Rgb = { w, h, r: new Float64Array(w * h), g: new Float64Array(w * h), b: new Float64Array(w * h) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = at(x, y).map((v) => Math.min(255, Math.max(0, Math.round(v))));
    im.r[y * w + x] = r!; im.g[y * w + x] = g!; im.b[y * w + x] = b!;
  }
  return im;
}
async function png(im: Rgb): Promise<Buffer> {
  const j = new Jimp(im.w, im.h, 0xffffffff);
  j.scan(0, 0, im.w, im.h, (_x, _y, idx) => {
    const i = idx / 4;
    j.bitmap.data[idx] = im.r[i]!; j.bitmap.data[idx + 1] = im.g[i]!; j.bitmap.data[idx + 2] = im.b[i]!;
  });
  return j.getBufferAsync(Jimp.MIME_PNG);
}
/** A big red badge and a thin blue line on white. */
const colourLogo = () => picture(400, 300, (x, y) =>
  (x - 200) ** 2 + (y - 120) ** 2 <= 100 ** 2 ? [200, 30, 40] : y >= 262 && y <= 266 && x >= 50 && x <= 350 ? [30, 60, 200] : [255, 255, 255]);

await test("a colour logo is redrawn as black lines: outline, thin parts solid, white ground", () => {
  const im = colourLogo();
  assert.ok(isGraphic(im));
  const a = lineArt(im), at = (x: number, y: number) => a[y * im.w + x];
  assert.deepEqual([...new Set(a)].sort(), [0, 255]);
  assert.equal(at(200, 120), 255);                                     // inside the badge: not burnt
  let outline = false;
  for (let y = 16; y < 25; y++) for (let x = 196; x < 205; x++) outline ||= at(x, y) === 0;
  assert.ok(outline);                                                  // its outline is
  assert.equal(at(200, 264), 0);                                       // the thin line stays solid
  assert.equal(at(10, 290), 255);
});

await test("a light design on a dark ground: the ground turns white", () => {
  const im = picture(300, 300, (x, y) => (y >= 147 && y < 153 && x >= 40 && x < 260 ? [245, 245, 245] : [10, 10, 10]));
  assert.ok(isGraphic(im));
  const a = lineArt(im);
  assert.equal(a[20 * 300 + 20], 255);
  assert.equal(a[150 * 300 + 150], 0);
});

await test("the engraving uses the lines; a black drawing and a photograph are unchanged", async () => {
  const r = (await prepPhotoRaster(await png(colourLogo()), 216, 144))!;
  assert.ok(!r.hex.startsWith("BFADA7E6", (Math.floor(r.rows * 0.4) * r.cols + Math.floor(r.cols / 2)) * 8));   // no black plate
  const drawing = await blackSquarePng();
  assert.equal((await prepPhotoRaster(drawing, 216, 144))!.hex, (await prepPhotoRaster(drawing, 216, 144, { lineArt: false }))!.hex);
  let seed = 2;
  const noise = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return (seed / 2147483648 - 0.5) * 4; };
  const photo = picture(320, 240, (x, y) => {                          // smooth shading, as a photo has
    const u = x / 40, v = y / 40;
    return [120 + 80 * Math.sin(u) * Math.cos(v) + noise(), 110 + 70 * Math.sin(u + v) + noise(), 100 + 60 * Math.cos(u - 0.5 * v) + noise()];
  });
  assert.ok(!isGraphic(photo));
});

await test("several photos for one place: the design is engraved, not the dark mock-up", async () => {
  const mockup = new Jimp(300, 200, 0xffffffff);
  mockup.scan(30, 30, 240, 140, (_x, _y, idx) => { mockup.bitmap.data.writeUInt32BE(0x3c281eff, idx); });
  const design = new Jimp(300, 200, 0xffffffff);
  design.scan(100, 90, 100, 6, (_x, _y, idx) => { design.bitmap.data.writeUInt32BE(0x000000ff, idx); });
  const [chosen, others] = await pickDesign([
    { item: "photo 1", buf: await mockup.getBufferAsync(Jimp.MIME_PNG) },
    { item: "photo 2", buf: await design.getBufferAsync(Jimp.MIME_PNG) },
  ]);
  assert.equal(chosen, "photo 2");
  assert.deepEqual(others, ["photo 1"]);
});

await test("the same photo in two places of a wallet is flagged in the title", async () => {
  const logo = new Jimp(400, 240, 0xffffffff);
  logo.scan(40, 60, 320, 30, (_x, _y, idx) => { logo.bitmap.data.writeUInt32BE(0x000000ff, idx); });
  logo.scan(180, 90, 30, 110, (_x, _y, idx) => { logo.bitmap.data.writeUInt32BE(0x000000ff, idx); });
  const other = new Jimp(400, 240, 0xffffffff);
  other.scan(40, 150, 320, 30, (_x, _y, idx) => { other.bitmap.data.writeUInt32BE(0x000000ff, idx); });
  const a = await logo.getBufferAsync(Jimp.MIME_PNG);
  const b = await logo.clone().resize(300, 180).quality(90).getBufferAsync(Jimp.MIME_JPEG);
  assert.ok(samePhoto(await photoSignature(a), await photoSignature(b)));
  assert.ok(!samePhoto(await photoSignature(a), await photoSignature(await other.getBufferAsync(Jimp.MIME_PNG))));
  const e = entry("Lines wallet", [], 1, [
    { position_label: "برا يمين في الطرف لوجو", display_label: "photo 8", order_name: "#1", attachment_url: "u:a" },
    { position_label: "برا شمال في الطرف", display_label: "photo 13", order_name: "#1", attachment_url: "u:b" }]);
  const placed = await placedByZone(e, new Map([["u:a", a], ["u:b", b]]), "wallet", (l) => walletZoneFor(l, "lines"), "Wallet");
  assert.deepEqual(Object.keys(placed.photos.get("#1")!).sort(), ["برا تحت شمال", "برا تحت يمين"]);
  assert.deepEqual(placed.extras.get("#1"), ["CHECK photo 8 SAME AS photo 13"]);
});

await test("a plain box is still cut, with no marker frame; a box photo is engraved", async () => {
  const [plain] = await buildBoxGridBuffers([entry("Gift box")] as never);
  assert.ok(plain);
  assert.equal(count(text(plain!), /^XI$/gm), 0);
  const url = "https://cdn.example/p.png";
  const [photo] = await buildBoxGridBuffers([entry("Gift box", [], 1,
    [{ position_label: "كتابه علي البوكس", display_label: "photo 1", order_name: "#1", attachment_url: url }])] as never,
  new Map([[url, await blackSquarePng()]]));
  assert.equal(count(text(photo!), /^XI$/gm), 1);              // a box logo is always a bitmap, never paths
  assert.ok(/^1\.0000 0\.0000 1\.0000 0\.5000 k$/m.test(text(photo!)));   // the first box's green
  assert.deepEqual(await buildBoxGridBuffers([entry("Gift purse box", [["كتابة علي المنتج", "Mama"]])] as never), []);
});

await test("a file heavy with photos is split so Telegram can take it", async () => {
  const urls = ["https://cdn.example/1.png", "https://cdn.example/2.png", "https://cdn.example/3.png"];
  const box = entry("Gift box", [], 3, urls.map((u, i) => ({ position_label: "كتابه علي البوكس", display_label: `photo ${i + 1}`,
    order_name: `#${i + 1}`, attachment_url: u })));
  box.source_orders = urls.map((_u, i) => ({ order_name: `#${i + 1}`, remaining_quantity: 1 }));
  const png = await blackSquarePng();
  const photos = new Map(urls.map((u) => [u, png]));
  const oldBytes = LIMITS.maxRasterBytes;
  try {
    const [whole] = await buildBoxGridBuffers([box] as never, photos);
    const one = (text(whole!).match(/^%[0-9A-F]+$/gm) ?? []).join("").length / 3;
    LIMITS.maxRasterBytes = Math.floor(one * 1.5);     // room for one photo per file
    assert.equal((await buildBoxGridBuffers([box] as never, photos)).length, 3);
  } finally { LIMITS.maxRasterBytes = oldBytes; }
});

await test("medallions: plain ones included, 15 per file", async () => {
  const files = await buildKeychainFiles([entry("Photo keychain", [], 16)]);
  assert.equal(files.length, 2);
});

await test("wallets: 25 per file, decorated face takes no outside writing", async () => {
  assert.equal((await buildWalletFiles([entry("Wallet", [], 26)])).length, 2);
  const [deco] = await buildWalletFiles([entry("Decorated wallet", [["المحفظة برا يمين", "X"]])]);
  const [blank] = await buildWalletFiles([entry("Decorated wallet")]);
  assert.equal(count(text(deco!), /^f$/gm), count(text(blank!), /^f$/gm));
});

await test("the wallet logo is the gift boxes' VIOLA wordmark, where the deer logo was", () => {
  const [x0, y0, x1] = WALLET_TEMPLATE.logo as number[];
  const [minx, miny, maxx, maxy] = bounds(templateGeom("logo")!);
  assert.ok(Math.abs(minx - x0!) < 0.05 && Math.abs(miny - y0!) < 0.05 && Math.abs(maxx - x1!) < 0.05);
  assert.ok(Math.abs((maxx - minx) / (maxy - miny) - BOX_TEMPLATE.logo_aspect) < 0.01);
});

await test("passports, purses and purse boxes carry the VIOLA wordmark; the purse's is turned over", () => {
  for (const [product, model, upright] of [["passport", "blank", true], ["passport", "knot", true],
    ["purse", "mandala", false], ["purse_box", "plain", true]] as const) {
    const pts = (PIECE_TEMPLATES[product][model].fills.logo as number[][][]).flat();
    const deer: [number, number, number, number] = [Math.min(...pts.map((p) => p[0]!)), Math.min(...pts.map((p) => p[1]!)),
      Math.max(...pts.map((p) => p[0]!)), Math.max(...pts.map((p) => p[1]!))];
    const got = bounds(pieceLogo(product, model)!);
    const want = bounds(wordmarkIn(deer, upright)!);
    got.forEach((v, i) => assert.ok(Math.abs(v - want[i]!) < 0.05, `${product}/${model}`));
    assert.ok(upright ? Math.abs(got[1] - deer[1]) < 0.05 : Math.abs(got[3] - deer[3]) < 0.05, `${product}/${model} baseline`);
  }
});

await test("passport / purse / purse box sets fit the 1400 x 900 bed", async () => {
  for (const p of ["passport", "purse", "purse_box"] as const) {
    const [w, h, cols, rows] = pieceCell(p);
    assert.ok(20 + cols * w + (cols - 1) * 10 <= BED_W_MM && 20 + rows * h + (rows - 1) * 10 <= BED_H_MM, p);
  }
  assert.equal((await buildPieceFiles("passport", [entry("Custom Passport holder", [["برا شمال", "Kamel"]], 9)])).length, 2);
  assert.equal((await buildPieceFiles("purse", [entry("Mandela purse")])).length, 1);
});

// ── Owner's corrections of 2026-11-02 ────────────────────────────────────────
const coloured = (e: LaserEntry, color: string): LaserEntry => ({ ...e, display_color: color });

await test("a batch makes the line-by-line file, one file per leather colour (A-Z), then the purse boxes' own", async () => {
  const files = await buildLaserArtifacts([
    entry("Magic Wallet - RFID protection"), entry("Bag Tag – Personalized Leather Luggage Tag", [["Bag tag", "Ali"]]),
    coloured(entry("Photo keychain"), "Black"), entry("Wallet"), coloured(entry("Custom Passport holder"), "Dark Navy"),
    coloured(entry("Purse"), "dark navy"), entry("Gift purse box"), coloured(entry("Wallet"), "Unknown Color"),
  ], new Map());
  assert.deepEqual(files.map((f) => f.kind), ["laser", "black", "brown", "dark-navy", "no-colour", "box-port"]);
  assert.deepEqual(files.map((f) => f.label),
    ["ملف الليزر", "ملف ليزر BLACK", "ملف ليزر BROWN", "ملف ليزر DARK NAVY", "ملف ليزر - لون مش معروف", "بوكسات بورتفيه"]);
  const navy = text(files[3]!.buffer);
  assert.equal(count(navy, /^0\.0000 1\.0000 0\.75\d\d 0\.0000 K$/gm), 1);        // the passport's cover holes
  assert.ok(count(navy, /^S$/gm) > 312 + 37);                                         // + the purse's strokes
});

await test("purse boxes of every colour share their one file, none goes in a colour file", async () => {
  const mama = (color: string) => coloured(entry("Gift purse box", [["كتابة علي المنتج", "Mama"]]), color);
  const files = await buildLaserArtifacts([mama("Maroon"), mama("Black"), coloured(entry("Purse"), "Black")], new Map());
  assert.deepEqual(files.map((f) => f.kind), ["black", "box-port"]);
  const purseOnly = (await buildLaserArtifacts([coloured(entry("Purse"), "Black")], new Map()))[0]!;
  assert.equal(count(text(files[0]!.buffer), /^S$/gm), count(text(purseOnly.buffer), /^S$/gm));
});

await test("a colour sheet keeps each kind on its own rows inside the 1400 x 900 mm bed", async () => {
  const cell = (kind: string, w: number, h: number): LaserCell => ({ color: "Brown", kind, w, h, ops: async () => [] });
  const many = (n: number, c: LaserCell) => [...Array(n)].map(() => c);
  const pages = shelfPages([...many(7, cell("wallet", 230, 160)), ...many(5, cell("passport", 305, 320)), cell("keychain", 135, 188)]);
  assert.deepEqual(pages.map((rows) => rows.map((r) => `${r[0]!.kind}x${r.length}`)),
    [["walletx5", "walletx2", "passportx4"], ["passportx1", "keychainx1"]]);
  for (const rows of pages) {
    assert.ok(20 + rows.reduce((h, r) => h + Math.max(...r.map((c) => c.h)), 0) + (rows.length - 1) * 10 <= BED_H_MM);
    for (const r of rows) assert.ok(20 + r.reduce((w, c) => w + c.w, 0) + (r.length - 1) * 10 <= BED_W_MM);
  }
  const sheets = await colourSheets([cell("wallet", 230, 160), { ...cell("wallet", 230, 160), color: " brown " }]);
  assert.equal(sheets.length, 1);
});

await test("the passport has its whole cut outline in black, and its old outline bits are gone", () => {
  for (const model of ["blank", "knot", "decorated"]) {
    const tpl = PIECE_TEMPLATES.passport[model];
    const cut = tpl.strokes.filter((st: { rgb: number[] }) => st.rgb.join() === "0,0,0");
    assert.equal(cut.length, 1, model);
    assert.equal(cut[0].paths.length, 37, model);
    const pts = cut[0].paths.flat() as number[][];
    const [x0, y0, x1, y1] = [Math.min(...pts.map((p) => p[0]!)), Math.min(...pts.map((p) => p[1]!)),
      Math.max(...pts.map((p) => p[0]!)), Math.max(...pts.map((p) => p[1]!))];
    assert.ok(x0 >= 0 && y0 >= 0 && x1 <= tpl.size[0] && y1 <= tpl.size[1], model);
    const holes = tpl.strokes.filter((st: { rgb: number[] }) => st.rgb[0] === 255).flatMap((st: { paths: number[][][] }) => st.paths);
    assert.equal(holes.length, 312, model);
    for (const h of holes) assert.ok(h[0]![0]! > x0 && h[0]![0]! < x1 && h[0]![1]! > y0 && h[0]![1]! < y1, model);
  }
  const cover = PIECE_TEMPLATES.passport.blank.pieces.cover as number[];          // its holes; the outline is 4 mm out
  assert.ok(Math.abs(cover[2]! - cover[0]! - 191.94) < 0.01 && cover[0]! > 3.9);
});

await test("the lines band is a layer of its own (blue), apart from the writing", async () => {
  const band = /^1\.0000 1\.0000 0\.0000 0\.0000 k$/m;
  const [lines] = await buildWalletFiles([entry("Lines wallet", [["المحفظة برا تحت يمين", "Ali"]])]);
  const [blank] = await buildWalletFiles([entry("Wallet", [["المحفظة برا يمين", "Ali"]])]);
  assert.ok(band.test(text(lines!)) && !band.test(text(blank!)));
  const [knot] = await buildPieceFiles("passport", [entry("Lines passport holder")]);
  assert.ok(band.test(text(knot!)));
});

// ── Owner's corrections of 2026-11-01 (preview of 110 orders) ─────────────────
await test("the heart goes at the end; a date reads left to right with its heart on the right", () => {
  assert.equal(heartsLast("♥️ كل عام وأنت أجمل أقداري"), "كل عام وأنت أجمل أقداري ♥");
  assert.equal(heartsLast("🫶🏻 Some people make life beautiful 🫶"), "Some people make life beautiful 🫶");
  assert.equal(heartsLast("♡ ∞ زوجي"), "زوجي ♡ ∞");
  const xs = (t: string) => bounds(weldLine(t, 0).geom!);
  const date = xs("2026/11/5"), dated = xs("2026/11/5♥️");
  assert.ok(Math.abs(dated[0] - date[0]) < 1e-6);                     // nothing added on the left
  assert.ok(dated[2] > date[2] + 2048 * 0.5);                          // the heart on the right
});

await test("♡, 🫶 and ∞ are drawn; an apostrophe inside a word is kept", () => {
  for (const t of ["TO MY LOVE ♡", "وائل 🫶🏻", "∞"]) {
    const plain = weldLine(t.replace("♡", "").replace("🫶🏻", "").replace("∞", "x"), 0).width;
    assert.ok(weldLine(t, 0).width > plain, t);
  }
  assert.equal(cleanText("“I’m always” (with You)"), "I’m always with You");
});

await test("no word is left alone on a line", () => {
  const lines = balancedLines("Some people make life beautiful, just by being in it", 3);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => l.split(" ").length >= 2), lines.join(" | "));
  assert.deepEqual(balancedLines("وكل الناس يا أمي مياه، ووحدك زمزم يروي فؤادي", 2), ["وكل الناس يا أمي مياه،", "ووحدك زمزم يروي فؤادي"]);
});

await test("a box with writing AND a photo engraves both", async () => {
  const url = "https://cdn.example/p.png";
  const [file] = await buildBoxGridBuffers([entry("Gift box", [["كتابه علي المنتج", "Amin ♥️"]], 1,
    [{ position_label: "كتابه علي المنتج", display_label: "photo 1", order_name: "#1", attachment_url: url }])] as never,
  new Map([[url, await blackSquarePng()]]));
  const ai = text(file!);
  assert.ok(!ai.includes("photo 1"));
  assert.equal(count(ai, /^XI$/gm), 1);                                // the photo, a bitmap
  assert.ok(count(ai, /^f$/gm) >= 2);                                  // logo, writing
});

await test("wallet: pocket writing at most 70 x 40 mm, one word on the face 70 mm on one line", () => {
  const long = "Some people make life beautiful, just by being in it and every day with you is a gift";
  const [pocket] = fitBlock(long, [], WALLET_ZONES["جوا شمال"]!);
  const [px0, py0, px1, py1] = bounds(pocket!);
  assert.ok((px1 - px0) / MM <= 70.01 && (py1 - py0) / MM <= 40.01);
  const [word, n] = fitBlock("♡ ∞ زوجي", [], WALLET_ZONES["برا يمين"]!);
  const [wx0, wy0, wx1, wy1] = bounds(word!);
  assert.equal(n, 1);
  assert.ok(Math.abs(Math.max(wx1 - wx0, wy1 - wy0) / MM - 70) < 0.1);
  const [two] = fitBlock("Ahmed Ali", [], WALLET_ZONES["برا يمين"]!);
  assert.ok((bounds(two!)[3] - bounds(two!)[1]) / MM <= 20.01);        // two words: a line as before
});

await test("a note to the team is never engraved: the plane logo where it asks for it, else a LOGO marker", () => {
  const zoneFor = (label: string, hint: string) => walletZoneFor(label, "blank", hint);
  const logo = placeTexts([["المحفظة برا شمال", "نفس اللوجو اللي في الصورة"]], zoneFor, "t");
  assert.deepEqual([logo.texts, logo.logos, logo.planes], [{}, { "برا شمال": ["LOGO"] }, []]);
  const plane = placeTexts([["المحفظة برا شمال", "نفس  لوجو الطيارة اللي في صورة الويبسايت"], ["المحفظة برا يمين", "Maryam"]],
    zoneFor, "t");
  assert.deepEqual([plane.texts, plane.logos, plane.planes], [{ "برا يمين": ["Maryam"] }, {}, ["برا شمال"]]);
});

await test("a box keeps the lines the team typed, only one too wide wraps", async () => {
  await ensureHB();
  assert.equal(cleanLines(" Feel like  home ❤️\r\n\r\n A ❤️ N \n"), "Feel like home ❤️\nA ❤️ N");
  assert.deepEqual(boxTextLines("Feel like home\nA N", 1e9), ["Feel like home", "A N"]);
  assert.deepEqual(boxTextLines("one two\nthree", 1), ["one", "two", "three"]);
  assert.deepEqual(boxTextLines("", 1e9), []);
});

await test("a purse box keeps the lines the team typed, other pieces join them", async () => {
  await ensureHB();
  const zoneFor = () => "x";
  assert.deepEqual(placeTexts([["a", "Mama\nLove"]], zoneFor, "t", true).texts, { x: ["Mama\nLove"] });
  assert.deepEqual(placeTexts([["a", "Mama\nLove"]], zoneFor, "t").texts, { x: ["Mama Love"] });
  const zone = { x: [0, 200] as [number, number], line_h: 10, max_h: 30, align: "centre" as const, photo_h: 10, cy: 0 };
  assert.equal(fitBlock("Mama\nLove", [], zone)[1], 2);
  assert.equal(fitBlock("Mama Love", [], zone)[1], 1);
});

console.log(`${passed} passed`);
