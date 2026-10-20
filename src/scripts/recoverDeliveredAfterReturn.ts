/** Explicit, bounded support recovery. No Shopify writes, new waybills, deleted
 * accounting, or refunded return charges. Requires live exact DTR evidence. */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { prisma } from '../lib/prisma.js';
import { AccurateClient } from '../accurate/accurateClient.js';
import { OdooClient } from '../odoo/odooClient.js';
import { OdooSyncService } from '../odoo/odooSyncService.js';
import { OdooSaleReturnService } from '../odoo/odooSaleReturnService.js';
import { shipmentRepository } from '../services/shipmentRepository.js';

const approved = new Set(['9446', '10810', '11202', '11387', '11558', '11588', '12330']);
const requested = process.argv.find((a) => a.startsWith('--orders='))?.slice(9).split(',').map((n) => n.replace(/^#/, '').trim()) ?? [];
const apply = process.argv.includes('--apply');
assert(requested.length > 0 && requested.every((n) => approved.has(n)), 'Only the seven explicitly approved orders are supported');
const odoo = new OdooClient();
const stock = new OdooSaleReturnService(odoo);
const sales = new OdooSyncService(odoo);
const carrier = new AccurateClient();

try {
  for (const number of [...new Set(requested)]) {
    const record = await prisma.shipmentRecord.findFirst({ where: { shopifyOrderName: `#${number}` } });
    assert(record?.odooSaleOrderId && record.accurateShipmentCode && record.accurateShipmentId, 'Missing exact Odoo/courier links');
    const page = await carrier.listShipments({ id: [record.accurateShipmentId] }, 10, 1);
    const shipment = page.data.find((s) => s.id === record.accurateShipmentId && s.code === record.accurateShipmentCode);
    assert(shipment && shipment.refNumber === `Viola-${number}`, 'Exact courier reference mismatch');
    assert(shipment.status?.code === 'DTR' && !shipment.cancelled && (shipment.collected || shipment.paidToCustomer), 'No confirmed live collected delivery');
    assert(!['RTRN', 'RTS', 'RJCT'].includes(shipment.returnStatus?.code ?? ''), 'Carrier still reports a return');
    assert(Number(shipment.collectedAmount) > 0 && Number(shipment.customerDue) > 0, 'No positive merchant collection');
    assert(Math.abs(Number(shipment.collectedAmount) - Number(record.collectedAmount)) < 0.01 && Math.abs(Number(shipment.customerDue) - Number(record.customerDue)) < 0.01, 'Financial snapshot changed; reassess before recovery');
    const [bill] = record.odooReturnBillId ? await odoo.searchRead('account.move', [['id', '=', record.odooReturnBillId]], ['name', 'amount_total', 'payment_state'], { limit: 1 }) : [];
    assert(bill && bill.payment_state === 'paid' && Math.abs(Number(bill.amount_total) - Number(shipment.returnFees)) < 0.01, 'Original paid return cost does not match live carrier fees');
    console.log(JSON.stringify({ order: record.shopifyOrderName, apply, netInvoiceTarget: shipment.customerDue, preservedReturnCost: bill.amount_total }));
    if (!apply) continue;

    const audit = await prisma.failedPayload.create({ data: {
      source: 'controlled-redelivery-recovery', externalId: record.shopifyOrderId, reason: 'Live DTR recovery authorized 2026-10-20',
      payloadJson: JSON.stringify({ phase: 'before', recordId: record.id, so: record.odooSaleOrderId, oldOdooStatus: record.odooSyncStatus, oldReturnBill: record.odooReturnBillId, oldReturnPayment: record.odooReturnPaymentId, oldInvoice: record.odooInvoiceId, oldCollectionReview: record.odooCollectionLastError, carrier: { id: shipment.id, code: shipment.code, collected: shipment.collectedAmount, fees: shipment.deliveryFees, returnFees: shipment.returnFees, net: shipment.customerDue }, observedAt: new Date().toISOString() }),
    } });
    const restored = await stock.restoreDeliveredAfterReturn(record.odooSaleOrderId);
    await sales.syncCollectedShipment(record.id);
    const verified = await sales.verifyCollectedShipmentAccounting(record.id);
    assert(verified.complete, `Accounting did not verify: ${JSON.stringify(verified)}`);
    await shipmentRepository.completeOdooCollectionSync(record.id);
    await prisma.shipmentRecord.update({ where: { id: record.id }, data: {
      returnSyncStatus: 'superseded', returnSyncFingerprint: null, returnSyncClaimedAt: null,
      returnSyncLastError: 'Historical return superseded by exact live DTR + collected proof and controlled Odoo redelivery recovery',
    } });
    await prisma.failedPayload.update({ where: { id: audit.id }, data: { payloadJson: JSON.stringify({ phase: 'completed', restored, verified, preservedReturnBill: record.odooReturnBillId, preservedReturnPayment: record.odooReturnPaymentId }) } });
    console.log(JSON.stringify({ order: record.shopifyOrderName, restored, verified }));
  }
} finally { await prisma.$disconnect(); }
