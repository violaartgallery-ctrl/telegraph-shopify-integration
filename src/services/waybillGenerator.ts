/**
 * Waybill PDF Generator
 * Generates an A4 PDF with 3 waybills per page from shipment codes.
 * Data is read from ShipmentRecord.rawOrderJson in the DB.
 * Uses pdf-lib (pure JS) + bwip-js (CODE128 barcodes) + Cairo Arabic font.
 */

import { PDFDocument, PDFFont, PDFPage, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import bwipjs from 'bwip-js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import {
  buildCustomerName,
  buildPhone,
  buildAddress,
  buildShipmentDescription,
  buildPiecesCount,
} from './accurateMapper.js';
import type { ShopifyOrder } from '../types/shopify.js';

// ── Font ──────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_PATH = path.join(__dirname, '../assets/fonts/Cairo-Regular.ttf');

// ── Page constants (A4 in points: 1pt = 1/72 inch) ───────────────────────────

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 12;
const WAYBILL_H = (PAGE_H - MARGIN * 2) / 3; // ~272pt each

// ── Waybill data shape ────────────────────────────────────────────────────────

interface WaybillData {
  shipmentCode: string;
  recipientName: string;
  phone: string;
  address: string;
  zone: string;
  date: string;
  senderName: string;
  senderPhone: string;
  description: string;
  price: number;
  piecesCount: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildZone(order: ShopifyOrder): string {
  return (
    [order.shipping_address?.city, order.shipping_address?.province]
      .filter(Boolean)
      .join(' - ') || 'غير محدد'
  );
}

function buildPrice(order: ShopifyOrder): number {
  return Number.parseFloat(
    order.total_outstanding ?? order.current_total_price ?? order.total_price ?? '0'
  );
}

async function generateBarcodePng(code: string): Promise<Buffer> {
  return bwipjs.toBuffer({
    bcid: 'code128',
    text: code,
    scale: 2,
    height: 14,
    includetext: false,
  }) as unknown as Promise<Buffer>;
}

// ── Draw one waybill in its vertical slot ─────────────────────────────────────

async function drawWaybill(
  page: PDFPage,
  pdfDoc: PDFDocument,
  wb: WaybillData,
  slotIndex: number, // 0 = top, 1 = middle, 2 = bottom
  font: PDFFont
): Promise<void> {
  const yTop = PAGE_H - MARGIN - slotIndex * WAYBILL_H;
  const yBottom = yTop - WAYBILL_H;
  const innerW = PAGE_W - MARGIN * 2;

  // ── Outer border ────────────────────────────────────────────────────────────
  page.drawRectangle({
    x: MARGIN,
    y: yBottom + 4,
    width: innerW,
    height: WAYBILL_H - 8,
    borderColor: rgb(0, 0, 0),
    borderWidth: 1,
    color: rgb(1, 1, 1),
  });

  // ── Dashed separator above (except first slot) ──────────────────────────────
  if (slotIndex > 0) {
    page.drawLine({
      start: { x: MARGIN, y: yTop },
      end: { x: PAGE_W - MARGIN, y: yTop },
      thickness: 0.5,
      color: rgb(0.6, 0.6, 0.6),
      dashArray: [5, 3],
    });
  }

  // ── Header bar ──────────────────────────────────────────────────────────────
  const headerH = 22;
  page.drawRectangle({
    x: MARGIN,
    y: yTop - headerH - 4,
    width: innerW,
    height: headerH,
    color: rgb(0.05, 0.42, 0.36), // brand green
  });

  page.drawText('واي بيل — Telegraph', {
    x: MARGIN + 8,
    y: yTop - headerH + 4,
    font,
    size: 11,
    color: rgb(1, 1, 1),
  });

  page.drawText(wb.date, {
    x: PAGE_W - MARGIN - 70,
    y: yTop - headerH + 4,
    font,
    size: 9,
    color: rgb(0.9, 0.9, 0.9),
  });

  // ── Barcode (center top) ─────────────────────────────────────────────────────
  const barcodePng = await generateBarcodePng(wb.shipmentCode);
  const barcodeImage = await pdfDoc.embedPng(barcodePng);
  const bcW = 160;
  const bcH = 48;
  const bcX = PAGE_W / 2 - bcW / 2;
  const bcY = yTop - headerH - 4 - bcH - 8;

  page.drawImage(barcodeImage, { x: bcX, y: bcY, width: bcW, height: bcH });

  page.drawText(wb.shipmentCode, {
    x: PAGE_W / 2 - (wb.shipmentCode.length * 3.5),
    y: bcY - 12,
    font,
    size: 9,
    color: rgb(0, 0, 0),
  });

  // ── Left column: recipient ───────────────────────────────────────────────────
  const colLeft = MARGIN + 8;
  const colRight = PAGE_W / 2 + 8;
  const startY = bcY - 28;
  const lineGap = 24;

  const drawField = (
    label: string,
    value: string,
    x: number,
    y: number,
    maxChars = 45
  ) => {
    page.drawText(label, {
      x,
      y: y + 10,
      font,
      size: 7,
      color: rgb(0.45, 0.45, 0.45),
    });
    page.drawText(value.slice(0, maxChars), {
      x,
      y,
      font,
      size: 9,
      color: rgb(0, 0, 0),
    });
  };

  drawField('المستلم', wb.recipientName, colLeft, startY);
  drawField('الهاتف', wb.phone, colLeft, startY - lineGap);
  drawField('العنوان', wb.address, colLeft, startY - lineGap * 2);
  drawField('المنطقة', wb.zone, colLeft, startY - lineGap * 3);

  // ── Right column: shipment info ──────────────────────────────────────────────
  drawField('المُرسِل', wb.senderName, colRight, startY, 35);
  drawField('هاتف المُرسِل', wb.senderPhone, colRight, startY - lineGap, 35);
  drawField('السعر', `${wb.price} ج.م`, colRight, startY - lineGap * 2, 35);
  drawField('عدد القطع', String(wb.piecesCount), colRight, startY - lineGap * 3, 35);

  // ── Description bar at bottom ────────────────────────────────────────────────
  const descY = yBottom + 20;
  page.drawRectangle({
    x: MARGIN,
    y: descY - 2,
    width: innerW,
    height: 18,
    color: rgb(0.96, 0.96, 0.96),
  });
  page.drawText('البضاعة: ' + wb.description.slice(0, 90), {
    x: MARGIN + 6,
    y: descY + 2,
    font,
    size: 8,
    color: rgb(0.2, 0.2, 0.2),
  });
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateWaybillPdf(shipmentCodes: string[]): Promise<Buffer> {
  // 1. Fetch DB records
  const records = await prisma.shipmentRecord.findMany({
    where: { accurateShipmentCode: { in: shipmentCodes } },
  });

  // 2. Build waybill data
  const today = new Date().toISOString().slice(0, 10);
  const waybills: WaybillData[] = [];

  for (const record of records) {
    if (!record.rawOrderJson || !record.accurateShipmentCode) continue;
    const order = JSON.parse(record.rawOrderJson) as ShopifyOrder;
    waybills.push({
      shipmentCode: record.accurateShipmentCode,
      recipientName: buildCustomerName(order),
      phone: buildPhone(order),
      address: buildAddress(order),
      zone: buildZone(order),
      date: today,
      senderName: env.accurate.senderName ?? 'Viola',
      senderPhone: env.accurate.senderPhone ?? '',
      description: buildShipmentDescription(order),
      price: buildPrice(order),
      piecesCount: buildPiecesCount(order),
    });
  }

  if (waybills.length === 0) {
    throw new Error('لم يتم العثور على بيانات لأي شحنة.');
  }

  // 3. Build PDF
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  const fontBytes = readFileSync(FONT_PATH);
  const arabicFont = await pdfDoc.embedFont(fontBytes);

  // 3 waybills per page
  for (let i = 0; i < waybills.length; i += 3) {
    const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    const batch = waybills.slice(i, i + 3);

    for (let j = 0; j < batch.length; j++) {
      await drawWaybill(page, pdfDoc, batch[j]!, j, arabicFont);
    }
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}
