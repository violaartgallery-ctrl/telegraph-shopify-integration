/**
 * Laser files: routing to the store's own product families, photos engraved in
 * solid black/white with UPPERCASE hex, plain pieces still cut, and every file
 * kind (medallions, wallets, passport holders, purses, purse boxes, box grid).
 * Run: npm run test:laser-files
 */
import assert from "node:assert/strict";
import Jimp from "jimp";
import { buildBoxGridBuffers, wordmarkIn } from "../services/aiWriter.js";
import { buildKeychainFiles } from "../services/laser/keychainFile.js";
import { BED_H_MM, BED_W_MM, LIMITS } from "../services/laser/laserCore.js";
import { buildLaserArtifacts } from "../services/laser/laserFiles.js";
import { photoSignature, pickDesign, prepPhotoRaster, samePhoto } from "../services/laser/laserPhoto.js";
import { bundleLeftover, entryPieces, type LaserEntry, partFields } from "../services/laser/laserRouting.js";
import { buildPieceFiles, pieceCell, pieceLogo, pieceZoneFor } from "../services/laser/pieceFile.js";
import { PIECE_TEMPLATES } from "../services/laser/laserAssets.js";
import { buildWalletFiles, placedByZone, templateGeom, walletZoneFor } from "../services/laser/walletFile.js";
import { BOX_TEMPLATE } from "../services/boxAssets.js";
import { WALLET_TEMPLATE } from "../services/laser/laserAssets.js";
import { bounds } from "../services/laser/laserCore.js";

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
  assert.equal(count(text(photo!), /^XI$/gm), 1);
  assert.ok(text(photo!).includes("BFADA7E6"));
  assert.deepEqual(await buildBoxGridBuffers([entry("Gift purse box", [["كتابة علي المنتج", "Mama"]])] as never), []);
});

await test("a file heavy with photos is split so Telegram can take it", async () => {
  const urls = ["https://cdn.example/1.png", "https://cdn.example/2.png", "https://cdn.example/3.png"];
  const box = entry("Gift box", [], 3, urls.map((u, i) => ({ position_label: "كتابه علي البوكس", display_label: `photo ${i + 1}`,
    order_name: `#${i + 1}`, attachment_url: u })));
  box.source_orders = urls.map((_u, i) => ({ order_name: `#${i + 1}`, remaining_quantity: 1 }));
  const png = await blackSquarePng();
  const photos = new Map(urls.map((u) => [u, png]));
  const [whole] = await buildBoxGridBuffers([box] as never, photos);
  const one = (text(whole!).match(/^%[0-9A-F]+$/gm) ?? []).join("").length / 3;
  const old = LIMITS.maxRasterBytes;
  LIMITS.maxRasterBytes = Math.floor(one * 1.5);       // room for one photo per file
  try { assert.equal((await buildBoxGridBuffers([box] as never, photos)).length, 3); }
  finally { LIMITS.maxRasterBytes = old; }
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

await test("a batch makes one file per kind, in a fixed order", async () => {
  const files = await buildLaserArtifacts([
    entry("Magic Wallet - RFID protection"), entry("Bag Tag – Personalized Leather Luggage Tag", [["Bag tag", "Ali"]]),
    entry("Photo keychain"), entry("Wallet"), entry("Custom Passport holder"), entry("Purse"), entry("Gift purse box"),
  ], new Map());
  assert.deepEqual(files.map((f) => f.kind), ["laser", "keychains", "wallets", "passports", "purses", "purse_boxes"]);
});

console.log(`${passed} passed`);
