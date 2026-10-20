/** Bounded owner-approved support actions, 2026-10-20. Preview by default. */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { prisma } from '../lib/prisma.js';
import { AccurateClient } from '../accurate/accurateClient.js';
import { OdooClient } from '../odoo/odooClient.js';
import { OdooSyncService } from '../odoo/odooSyncService.js';
import { OdooSaleReturnService } from '../odoo/odooSaleReturnService.js';
import { shopifyOrdersClient } from '../shopify/shopifyOrdersClient.js';
import { shopifyStatusSyncClient } from '../shopify/shopifyStatusSyncClient.js';
import { requestShopifyAdmin } from '../shopify/shopifyAdminGraphql.js';
import { shipmentRepository } from '../services/shipmentRepository.js';

const apply = process.argv.includes('--apply');
const stage = process.argv.find((a) => a.startsWith('--stage='))?.slice(8);
assert(['shopify', 'zero-invoice', 'undispatched-return'].includes(stage ?? ''), 'Explicit stage required');
const carrier = new AccurateClient();
const odoo = new OdooClient();
const sales = new OdooSyncService(odoo);
const stock = new OdooSaleReturnService(odoo);
const close = (a: unknown, b: number) => Math.abs(Number(a) - b) < 0.01;
const audit = async (order: string, payload: unknown) => await prisma.failedPayload.create({ data: {
  source: 'owner-approved-review-20261020', externalId: order, reason: String(stage), payloadJson: JSON.stringify({ phase: 'before', payload })
} });
const done = async (id: number, payload: unknown) => await prisma.failedPayload.update({ where: { id }, data: {
  payloadJson: JSON.stringify({ phase: 'completed', payload })
} });
async function exactRecord(number: string) {
  const r = await prisma.shipmentRecord.findFirst({ where: { shopifyOrderName: `#${number}` } });
  assert(r?.accurateShipmentId && r.accurateShipmentCode && r.odooSaleOrderId, 'Missing exact links');
  const page = await carrier.listShipments({ id: [r.accurateShipmentId] }, 10, 1);
  const s = page.data.find((s) => s.id === r.accurateShipmentId && s.code === r.accurateShipmentCode && s.refNumber === `Viola-${number}`);
  assert(s, 'Exact courier identity failed');
  return { r, s };
}
async function addApprovedCharge(orderId: string, target: number, amount: number) {
  const begin = await requestShopifyAdmin<any>(`mutation($id:ID!){orderEditBegin(id:$id){calculatedOrder{id totalPriceSet{shopMoney{amount}} stagedChanges(first:1){nodes{__typename}}}userErrors{message}}}`, { id: `gid://shopify/Order/${orderId}` });
  const b = begin.orderEditBegin;
  assert.equal(b.userErrors.length, 0, JSON.stringify(b.userErrors));
  assert(b.calculatedOrder && b.calculatedOrder.stagedChanges.nodes.length === 0, 'Unexpected staged edits');
  assert(close(b.calculatedOrder.totalPriceSet.shopMoney.amount, target - amount), 'Initial total changed');
  const id = b.calculatedOrder.id;
  const added = await requestShopifyAdmin<any>(`mutation($id:ID!,$price:MoneyInput!){orderEditAddCustomItem(id:$id,title:"تسوية زيادة تحصيل Telegraph",price:$price,quantity:1,requiresShipping:false,taxable:false){calculatedOrder{totalPriceSet{shopMoney{amount}}}userErrors{message}}}`, { id, price: { amount: amount.toFixed(2), currencyCode: 'EGP' } });
  assert.equal(added.orderEditAddCustomItem.userErrors.length, 0, JSON.stringify(added.orderEditAddCustomItem.userErrors));
  assert(close(added.orderEditAddCustomItem.calculatedOrder.totalPriceSet.shopMoney.amount, target), 'Staged charge did not produce exact target');
  const commit = await requestShopifyAdmin<any>(`mutation($id:ID!){orderEditCommit(id:$id,notifyCustomer:false,staffNote:"Owner approved 800 EGP additional Telegraph collection on 2026-10-20; non-stock adjustment only"){order{currentTotalPriceSet{shopMoney{amount}}}userErrors{message}}}`, { id });
  assert.equal(commit.orderEditCommit.userErrors.length, 0, JSON.stringify(commit.orderEditCommit.userErrors));
  assert(close(commit.orderEditCommit.order.currentTotalPriceSet.shopMoney.amount, target), 'Committed charge did not verify');
}

try {
  if (stage === 'shopify') {
    for (const [number, before, target] of [['11666', 3135, 2035], ['12695', 835, 685], ['11879', 865, 1665]] as const) {
      const { r, s } = await exactRecord(number);
      assert(s.status?.code === 'DTR' && !s.cancelled && s.collected && !s.returnStatus && close(s.collectedAmount, target), 'Live collection changed');
      let state = await shopifyStatusSyncClient.fetchOrderPaymentState(r.shopifyOrderId);
      assert(state && !state.cancelledAt && state.currencyCode === 'EGP', 'Unsafe Shopify state');
      assert(close(state.totalPrice, before) || close(state.totalPrice, target), 'Unexpected Shopify total');
      assert(close(state.totalReceived, 0) || (state.displayFinancialStatus === 'PAID' && close(state.totalReceived, target)), 'Existing partial/unexpected payment');
      console.log(JSON.stringify({ order: r.shopifyOrderName, apply, before: state.totalPrice, target, adjustment: target - before }));
      if (!apply) continue;
      const log = await audit(r.shopifyOrderName!, { recordId: r.id, state, carrier: s, approvedAdjustment: target - before });
      let transactionId: string | undefined;
      if (state.displayFinancialStatus !== 'PAID') {
        if (close(state.totalPrice, before)) {
          if (target < before) {
            transactionId = (await shopifyStatusSyncClient.applyOrderDiscountAndPay({ orderId: r.shopifyOrderId, discountAmount: before - target, paymentAmount: target, currencyCode: 'EGP', discountDescription: 'Owner-approved collection discount 2026-10-20' })).transactionId;
          } else await addApprovedCharge(r.shopifyOrderId, target, target - before);
        }
        state = await shopifyStatusSyncClient.fetchOrderPaymentState(r.shopifyOrderId);
        assert(state && close(state.totalPrice, target), 'Adjusted total changed');
        if (state.displayFinancialStatus !== 'PAID') {
          const result = await shopifyStatusSyncClient.recordCustomerPayment({ orderId: r.shopifyOrderId, amount: target });
          assert(!result.skipped || result.reason === 'already-paid', JSON.stringify(result));
          transactionId = result.transactionId;
        }
      }
      const verified = await shopifyStatusSyncClient.fetchOrderPaymentState(r.shopifyOrderId);
      assert(verified?.displayFinancialStatus === 'PAID' && close(verified.totalPrice, target) && close(verified.totalReceived, target) && close(verified.totalOutstanding, 0), 'Final Shopify payment verification failed');
      await shipmentRepository.completeShopifyPaymentSync(r.id, transactionId ?? r.shopifyPaymentTransactionId ?? undefined);
      const fresh = await shopifyOrdersClient.getOrderByLegacyId(r.shopifyOrderId);
      await prisma.shipmentRecord.update({ where: { id: r.id }, data: { rawOrderJson: JSON.stringify(fresh) } });
      await done(log.id, { verified, transactionId, odooPreserved: true });
      console.log(JSON.stringify({ order: r.shopifyOrderName, verified }));
    }
  }
  if (stage === 'zero-invoice') {
    const { r, s } = await exactRecord('12264');
    assert(r.odooSaleOrderId === 23357 && r.odooInvoiceId === 554170, 'Odoo links changed');
    assert(s.status?.code === 'DTR' && s.collected && close(s.collectedAmount, 250) && close(s.customerDue, 179), 'Live collection changed');
    const source = await shopifyOrdersClient.getOrderByLegacyId(r.shopifyOrderId);
    const state = await shopifyStatusSyncClient.fetchOrderPaymentState(r.shopifyOrderId);
    assert(state?.displayFinancialStatus === 'PAID' && close(state.totalPrice, 250), 'Shopify source changed');
    const [so] = await odoo.searchRead<any>('sale.order', [['id', '=', 23357]], ['name', 'state', 'amount_total', 'order_line', 'invoice_ids']);
    const [invoice] = await odoo.searchRead<any>('account.move', [['id', '=', 554170]], ['name', 'state', 'amount_total', 'invoice_line_ids', 'payment_state']);
    const gl = await odoo.searchRead<any>('account.move.line', [['move_id', '=', 554170]], ['display_type', 'product_id', 'quantity', 'sale_line_ids', 'payment_id', 'matched_debit_ids', 'matched_credit_ids', 'debit', 'credit']);
    assert(so.state === 'sale' && so.order_line.length === 1 && source.line_items.length === 1 && close(source.line_items[0]!.price, 1000), 'Unexpected SO/product structure');
    const allocation = source.line_items[0]!.discount_allocations?.reduce((sum, d) => sum + Number(d.amount), 0);
    assert(close(allocation, 750), 'Source discount changed');
    console.log(JSON.stringify({ order: '#12264', apply, invoice: invoice.name, oldTotal: invoice.amount_total, target: 179, sourceGross: 1000, sourceDiscountPercent: 75 }));
    if (apply) {
      const log = await audit('#12264', { so, invoice, gl });
      if (!close(invoice.amount_total, 179)) {
        assert(close(invoice.amount_total, 0) && !r.odooSalePaymentId && !r.odooPaymentId, 'Existing nonzero invoice/payment requires reassessment');
        assert(gl.every((l: any) => !l.payment_id && l.matched_debit_ids.length === 0 && l.matched_credit_ids.length === 0), 'Invoice has monetary reconciliation');
        const productLines = gl.filter((l: any) => l.display_type === 'product');
        assert(productLines.length === 1 && productLines[0].quantity === 1 && productLines[0].sale_line_ids.includes(so.order_line[0]), 'Invoice product link changed');
        await odoo.call('account.move', 'button_draft', [[554170]]);
        await odoo.call('sale.order.line', 'write', [[so.order_line[0]], { price_unit: 1000, discount: 75 }]);
        await odoo.call('account.move.line', 'write', [[productLines[0].id], { price_unit: 179, discount: 0 }]);
        await odoo.call('account.move', 'action_post', [[554170]]);
      }
      await prisma.shipmentRecord.update({ where: { id: r.id }, data: { rawOrderJson: JSON.stringify(source) } });
      await sales.syncCollectedShipment(r.id);
      const verified = await sales.verifyCollectedShipmentAccounting(r.id);
      assert(verified.complete && close(verified.targetAmount, 179), JSON.stringify(verified));
      await shipmentRepository.completeOdooCollectionSync(r.id);
      await done(log.id, verified);
      console.log(JSON.stringify({ order: '#12264', verified }));
    }
  }
  if (stage === 'undispatched-return') {
    const { r, s } = await exactRecord('11756');
    assert(r.odooSaleOrderId === 22804 && r.odooReturnBillId === 555558, 'Odoo links changed');
    assert(s.status?.code === 'RTRN' && !s.collected && close(s.collectedAmount, 0) && close(s.customerDue, -61), 'No exact full return proof');
    const [so] = await odoo.searchRead<any>('sale.order', [['id', '=', 22804]], ['name', 'state', 'order_line', 'picking_ids']);
    const lines = await odoo.searchRead<any>('sale.order.line', [['id', 'in', so.order_line]], ['qty_delivered', 'qty_invoiced']);
    const picks = await odoo.searchRead<any>('stock.picking', [['id', 'in', so.picking_ids]], ['state', 'move_ids']);
    const moves = await odoo.searchRead<any>('stock.move', [['id', 'in', picks.flatMap((p: any) => p.move_ids)]], ['state']);
    const [credit] = await odoo.searchRead<any>('account.move', [['id', '=', 555560]], ['state', 'amount_total', 'amount_residual', 'payment_state']);
    const [bill] = await odoo.searchRead<any>('account.move', [['id', '=', 555558]], ['state', 'amount_total', 'payment_state']);
    const preview = await stock.preview(22804);
    assert(lines.length > 0 && lines.every((l: any) => close(l.qty_delivered, 0) && close(l.qty_invoiced, 0)), 'Stock/accounting quantities are not zero');
    assert(picks.length === 2 && moves.length === 2 && picks.every((p: any) => ['waiting', 'confirmed', 'assigned', 'cancel'].includes(p.state)) && moves.every((m: any) => ['waiting', 'confirmed', 'assigned', 'cancel'].includes(m.state)), 'A stock transfer executed or changed');
    assert(preview.activeInvoiceCount === 0 && credit.state === 'posted' && close(credit.amount_total, 865) && bill.payment_state === 'paid' && close(bill.amount_total, 61), 'Accounting reversal/return cost changed');
    console.log(JSON.stringify({ order: '#11756', apply, preview, credit, preservedReturnBill: bill }));
    if (apply) {
      const log = await audit('#11756', { so, lines, picks, moves, credit, bill });
      if (so.state !== 'cancel') await odoo.call('sale.order', 'action_cancel', [[22804]], { context: { disable_cancel_warning: true } });
      const verified = await stock.preview(22804);
      assert(verified.status === 'already-complete' && verified.deliveredQuantityZero && verified.activeInvoiceCount === 0, JSON.stringify(verified));
      await shipmentRepository.completeReturnSync(r.id);
      await done(log.id, { verified, customerCreditPreserved: credit, returnBillPreserved: bill });
      console.log(JSON.stringify({ order: '#11756', verified, cashRefundCreated: false, stockReturnCreated: false }));
    }
  }
} finally { await prisma.$disconnect(); }
