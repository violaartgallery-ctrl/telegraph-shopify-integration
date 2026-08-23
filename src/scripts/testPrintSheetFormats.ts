import assert from 'node:assert/strict';
import Jimp from 'jimp';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { buildPrintSheetPdf, decodePrintPhoto } from '../services/printSheet.js';

const webp = await sharp({
  create: {
    width: 640,
    height: 480,
    channels: 4,
    background: { r: 35, g: 120, b: 210, alpha: 0.85 },
  },
})
  .webp({ quality: 85 })
  .toBuffer();

const decodedWebp = await decodePrintPhoto(webp);
assert.equal(decodedWebp.bitmap.width, 640);
assert.equal(decodedWebp.bitmap.height, 480);

const jpegImage = new Jimp(320, 240, 0xff8844ff);
const jpeg = await jpegImage.getBufferAsync(Jimp.MIME_JPEG);
const decodedJpeg = await decodePrintPhoto(jpeg);
assert.equal(decodedJpeg.bitmap.width, 320);
assert.equal(decodedJpeg.bitmap.height, 240);

const bytes = await buildPrintSheetPdf([
  { buffer: webp, kind: 'keychain' },
  { buffer: jpeg, kind: 'wallet' },
]);
assert.ok(bytes, 'print sheet should be generated');
const pdf = await PDFDocument.load(bytes);
assert.equal(pdf.getPageCount(), 1);

await assert.rejects(
  () => decodePrintPhoto(Buffer.from('not-an-image')),
  /Print photo could not be decoded/
);

console.log(JSON.stringify({
  ok: true,
  webpDecoded: true,
  jpegUnchanged: true,
  pdfPages: pdf.getPageCount(),
  invalidImageRejectedClearly: true,
}));
