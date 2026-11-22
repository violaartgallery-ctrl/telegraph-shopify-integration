import {createHmac,timingSafeEqual} from 'node:crypto';
import {basePrisma} from '../lib/prisma.js';
import {env} from '../config/env.js';
import {bindManualShipment} from './manualShipmentBinding.js';
import {decisionHash,DECISION_SOURCE,type DecisionRow} from './operationsDecisionPolicy.js';

// A financial-only authorization. It NEVER replaces the shipping snapshot,
// grants a production/stock action, removes a hold, or resets a durable claim.
export function financialSourceHash(order:any):string {return decisionHash(bindManualShipment(order));}
export function financialSaleHash(sale:DecisionRow,lines:DecisionRow[]):string {return decisionHash([sale.id,sale.name,sale.origin,sale.client_order_ref,sale.state,sale.partner_id,sale.currency_id,sale.company_id,lines.map(l=>[l.id,l.name,l.product_id,l.product_uom_qty,l.price_unit,l.discount,l.tax_id,l.qty_delivered]).sort((a,b)=>Number(a[0])-Number(b[0]))]);}
export const exactMoney=(a:unknown,b:unknown)=>typeof a==='number'&&typeof b==='number'&&Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<0.005;
export function ownerPaymentDomain(reference:string,_invoiceIds:number[],paymentIds:number[]=[],partnerId?:number,companyId?:number):unknown[] {
  // Live Odoo search on these computed relations is not an identity filter.
  // Query only stored reference/IDs/partner fields, then verify READ links.
  const terms:unknown[]=[['ref','=',reference]];
  if(paymentIds.length)terms.push(['id','in',paymentIds]);
  const prefix=Array(terms.length-1+(partnerId&&companyId?1:0)).fill('|');
  return [...prefix,...terms,...(partnerId&&companyId?['&',['partner_id','=',partnerId],['company_id','=',companyId]]:[])];
}
export async function readOwnerPayments(client:any,input:{reference:string;invoiceIds:number[];paymentIds?:number[];partnerId:number;companyId:number}):Promise<DecisionRow[]> {
  const rows=await client.searchRead('account.payment',ownerPaymentDomain(input.reference,input.invoiceIds,input.paymentIds??[],input.partnerId,input.companyId),['name','ref','state','amount','journal_id','partner_id','company_id','currency_id','reconciled_invoice_ids','reconciled_bill_ids'],{limit:101});
  if(rows.length>100)throw Error('AUTOMATION_REVIEW_REQUIRED: Payment evidence bound exceeded');
  const ids=new Set(input.invoiceIds),known=new Set(input.paymentIds??[]);
  return rows.filter((p:DecisionRow)=>{
    if(!Array.isArray(p.reconciled_invoice_ids)||!Array.isArray(p.reconciled_bill_ids))throw Error('AUTOMATION_REVIEW_REQUIRED: Payment links not readable');
    return p.ref===input.reference||known.has(p.id)||[...p.reconciled_invoice_ids,...p.reconciled_bill_ids].some(id=>ids.has(id))||p.state!=='cancel'&&p.partner_id?.[0]===input.partnerId&&p.company_id?.[0]===input.companyId&&!p.reconciled_invoice_ids.length&&!p.reconciled_bill_ids.length;
  });
}
export function exactOwnerPayment(p:DecisionRow,input:{invoiceId:number;amount:number;journalId:number;partnerId:number;companyId:number;currencyId:number}):boolean {
  return p.state==='posted'&&exactMoney(p.amount,input.amount)&&p.journal_id?.[0]===input.journalId&&p.partner_id?.[0]===input.partnerId&&p.company_id?.[0]===input.companyId&&p.currency_id?.[0]===input.currencyId&&Array.isArray(p.reconciled_invoice_ids)&&p.reconciled_invoice_ids.length===1&&p.reconciled_invoice_ids[0]===input.invoiceId&&Array.isArray(p.reconciled_bill_ids)&&p.reconciled_bill_ids.length===0;
}
export function merchantTarget(f:DecisionRow):number|null {
  if(![f.collectedAmount,f.deliveryFees,f.customerDue].every(x=>typeof x==='number'&&Number.isFinite(x))||f.collectedAmount<=0||f.deliveryFees<0||f.customerDue<0)return null;
  const target=f.customerDue>0?f.customerDue:f.collectedAmount-f.deliveryFees;
  return target>0&&target<=f.collectedAmount?Number(target.toFixed(2)):null;
}
export function collectionSettlementQuote(row:DecisionRow,f:DecisionRow,protectedCase:boolean,action:string) {
  const blocked:string[]=[],target=merchantTarget(f),diff=typeof f.total==='number'?Number((f.collectedAmount-f.total).toFixed(2)):null;
  if(protectedCase)blocked.push('حماية تاريخية أو محاولة سابقة غير محسومة؛ لن تُلغى من زر القرار.');
  if(!f.available||!f.financialSourceHash||f.collectionStatus!=='collected'||f.cancelled||f.test||f.currencyIsEgp!==true||!/^(pending|authorized|unpaid|paid)$/.test(f.financialStatus)||!/cod|cash|دفع.*استلام|الدفع.*الاستلام|manual/i.test(f.gateway)||/kashier|visa|card|instapay|paypal|paymob|fawry/i.test(f.gateway))blocked.push('التسوية التلقائية هنا للتحصيل النقدي المؤكد بالجنيه المصري فقط؛ الإلغاء/الدفع الإلكتروني/الرد الجزئي يحتاج تسوية مستقلة.');
  if(!f.saleOrderExact||!['delivery-confirmed','invoice-posted','invoice-posted-awaiting-payment','paid','paid-existing'].includes(row.odooSyncStatus))blocked.push('لا يوجد أمر بيع مؤكد مطابق وجاهز؛ لن ننشئ أمر بيع أو نحرّك مخزونًا بهذا القرار المالي.');
  if(target===null||typeof f.total!=='number'||f.total<=0||!Number.isFinite(f.total))blocked.push('التحصيل أو الرسوم أو صافي المستحق غير معلوم/غير صالح.');
  if(action==='discount'&&!(diff!==null&&diff<0))blocked.push('لا يوجد مبلغ أقل من Shopify لاعتماده كخصم.');
  if(action==='extra'&&!(diff!==null&&diff>0))blocked.push('لا توجد زيادة على إجمالي Shopify لاعتمادها.');
  if(action==='accept-current'&&!exactMoney(f.total,f.collectedAmount))blocked.push('المبلغ مختلف؛ اختر خصمًا أو زيادة صريحة.');
  const docs=f.financialDocuments??[],invoices=docs.filter((d:DecisionRow)=>d.type==='out_invoice');
  if(docs.length!==invoices.length||invoices.length>1)blocked.push('توجد فاتورة مرتجع/إشعار دائن/مستندات متعددة؛ لا يُنشأ مستند آخر أو تُعكس دفعة من هذا الزر.');
  const invoice=invoices[0]??null,payments=f.payments??[];
  if(invoice&&(!invoice.exactSaleLink||invoice.state!=='posted'||!exactMoney(invoice.total,target)||!['paid','not_paid'].includes(invoice.payment)||!exactMoney(invoice.residual,invoice.payment==='paid'?0:target)))blocked.push('الفاتورة الموجودة غير مطابقة أو جزئية/مسودة؛ لن نعدّل فاتورة مُرحّلة أو نكررها.');
  if(invoice?.payment==='paid'){
    if(payments.length!==1||!payments[0].exactInvoiceLink||payments[0].state!=='posted'||payments[0].journalId!==f.paymentJournalId||payments[0].partnerId!==f.salePartnerId||payments[0].companyId!==f.companyId||payments[0].currencyId!==f.currencyId||!exactMoney(payments[0].amount,target))blocked.push('الفاتورة مدفوعة لكن الدفعة المطابقة ليست وحيدة ومؤكدة؛ يلزم مطابقة، لا دفع جديد.');
  }else if(payments.length)blocked.push('يوجد دفع سابق أو غير مربوط؛ نوقف الإنشاء بدل تسجيل دفع آخر.');
  if(!Number.isSafeInteger(f.paymentJournalId)||f.paymentJournalId<=0||!f.saleEvidenceComplete||!f.saleHash||!f.paymentJournalVerified)blocked.push('إعدادات دفتر الدفع/الشركة/العملة أو أدلة أمر البيع غير مكتملة.');
  if([row.odooReturnBillId,row.odooReturnPaymentId].some(Boolean))blocked.push('يوجد رابط مصروف مرتجع؛ يحتاج تسوية المستند السابق أولًا.');
  if(row.odooInvoiceId&&row.odooInvoiceId!==invoice?.id||row.odooSalePaymentId&&row.odooSalePaymentId!==payments[0]?.id||row.odooPaymentId&&row.odooPaymentId!==payments[0]?.id)blocked.push('روابط Neon لا تطابق المستندات الحالية؛ لن نستبدلها بتخمين.');
  const paid=invoice?.payment==='paid'&&blocked.length===0;
  return {available:blocked.length===0,blocked,target,difference:diff,gross:f.collectedAmount,shopifyAmount:action==='extra'?f.total:f.collectedAmount,
    shopifyMode:action==='extra'?'original-total':action==='discount'?'discount':'exact',invoice:invoice?{id:invoice.id,name:invoice.name,paid}:null,payment:paid?{id:payments[0].id,name:payments[0].name}:null,
    steps:[invoice?`استخدام نفس الفاتورة ${invoice.name} دون إنشاء فاتورة أخرى`:`إنشاء فاتورة واحدة على أمر البيع الحالي بصافي ${target??'غير مؤكد'} ج.م`,paid?'ربط الدفعة الموجودة فقط؛ لا دفع جديد':`تسجيل دفعة واحدة بصافي ${target??'غير مؤكد'} ج.م بعد فحص الدفعات مجددًا`,action==='extra'?`Shopify: إثبات إجمالي الأوردر ${f.total} فقط؛ الزيادة ${diff} تُسوّى في أودو وتوثّق كفرق خارج Shopify`:action==='discount'?`Shopify: خصم صريح ${diff===null?'غير مؤكد':Math.abs(diff)} ثم إثبات ${f.collectedAmount}`:'Shopify: استخدام الدفع الموجود أو إثبات التحصيل مرة واحدة','لا بوليصة جديدة، ولا تغيير أمر البيع أو المخزون أو لقطة الشحن الأصلية']};
}
export function sealFinancialApproval(p:DecisionRow,secret=env.shopify.clientSecret):string {
  if(secret.length<24)throw Error('Financial signing unavailable');
  return createHmac('sha256',secret).update('owner-financial-v1:'+JSON.stringify(p)).digest('hex');
}
export function verifyFinancialApproval(p:DecisionRow,seal:string,secret=env.shopify.clientSecret):boolean {
  if(typeof seal!=='string'||!/^[a-f0-9]{64}$/.test(seal))return false;
  const a=Buffer.from(seal,'hex'),b=Buffer.from(sealFinancialApproval(p,secret),'hex');return a.length===b.length&&timingSafeEqual(a,b);
}
export async function readOwnerFinancialApproval(row:DecisionRow,order:any):Promise<DecisionRow|null> {
  const receipts=await basePrisma.failedPayload.findMany({where:{source:DECISION_SOURCE,externalId:row.shopifyOrderId},orderBy:{id:'desc'},take:101});
  if(receipts.length>100)throw Error('Owner financial evidence bound exceeded');
  const approvals=receipts.map(r=>JSON.parse(r.payloadJson)).filter(p=>p.financialApproval);
  if(!approvals.length)return null;
  const receipt=approvals[0],p=receipt.financialApproval;
  if(!verifyFinancialApproval(p,receipt.financialSeal)||p.v!==1||p.nonce!==receipt.nonce||p.actor!==receipt.actor||p.recordId!==row.id||p.orderId!==row.shopifyOrderId||p.saleOrderId!==row.odooSaleOrderId||p.shipmentId!==row.accurateShipmentId||p.code!==row.accurateShipmentCode||p.sourceHash!==financialSourceHash(order)||p.collectionFingerprint!==row.odooCollectionFingerprint||!exactMoney(p.gross,row.collectedAmount)||!exactMoney(p.deliveryFees,row.deliveryFees)||!exactMoney(p.customerDue,row.customerDue)||!exactMoney(p.target,merchantTarget(row))||!['accept-current','discount','extra'].includes(p.action))throw Error('OWNER_FINANCIAL_SOURCE_CHANGED: القرار المالي لا يطابق المصدر الحالي؛ لا إعادة تنفيذ.');
  return p;
}

export async function assertOwnerFinancialOdooPreflight(client:any,p:DecisionRow,invoiceId?:number):Promise<void> {
  const sales=await client.searchRead('sale.order',[['origin','=',p.orderName]],['name','origin','client_order_ref','state','partner_id','currency_id','company_id','order_line','invoice_ids'],{limit:3});
  const sale=sales.length===1?sales[0]:null;
  if(!sale||sale.id!==p.saleOrderId||sale.state!=='sale'||sale.client_order_ref!==p.orderName+' / Viola-'+p.orderNumber)throw Error('AUTOMATION_REVIEW_REQUIRED: Approved Sales Order identity changed');
  const lines=await client.searchRead('sale.order.line',[['id','in',sale.order_line]],['name','product_id','product_uom_qty','price_unit','discount','tax_id','qty_delivered'],{limit:101});
  if(lines.length!==sale.order_line.length||lines.length>100||financialSaleHash(sale,lines)!==p.saleHash)throw Error('AUTOMATION_REVIEW_REQUIRED: Approved Sales Order lines changed');
  const docs=await client.searchRead('account.move',['|','|',['invoice_origin','=',p.orderName],['invoice_origin','=',sale.name],['id','in',sale.invoice_ids]],['name','state','move_type','amount_total','amount_residual','payment_state','partner_id','company_id','currency_id'],{limit:31});
  const active=docs.filter((d:DecisionRow)=>d.state!=='cancel'),expected=invoiceId??p.invoiceId;
  if(active.length!==(expected?1:0)||active.some((d:DecisionRow)=>d.id!==expected||d.move_type!=='out_invoice'||d.state!=='posted'||!exactMoney(d.amount_total,p.target)||!exactMoney(d.amount_residual,p.target)||d.payment_state!=='not_paid'||d.partner_id?.[0]!==p.partnerId||d.company_id?.[0]!==p.companyId||d.currency_id?.[0]!==p.currencyId))throw Error('AUTOMATION_REVIEW_REQUIRED: Invoice appeared, changed, or was already settled; no duplicate');
  const payments=await readOwnerPayments(client,{reference:p.orderName+' / Viola-'+p.orderNumber,invoiceIds:docs.map((d:DecisionRow)=>d.id),partnerId:p.partnerId,companyId:p.companyId});
  if(payments.some((x:DecisionRow)=>x.state!=='cancel'))throw Error('AUTOMATION_REVIEW_REQUIRED: Existing payment found; never pay again');
  const journals=await client.searchRead('account.journal',[['id','=',p.paymentJournalId]],['type','company_id','currency_id'],{limit:2});
  if(journals.length!==1||!['cash','bank'].includes(journals[0].type)||journals[0].company_id?.[0]!==p.companyId||journals[0].currency_id&&journals[0].currency_id?.[0]!==p.currencyId)throw Error('AUTOMATION_REVIEW_REQUIRED: Payment journal identity changed');
}

// Called only AFTER the native collection's independent paid-invoice proof.
// Shopify stays held until then; it never races the accounting source binding.
export async function releaseOwnerShopifyAfterAccounting(row:DecisionRow,order:any):Promise<void> {
  const p=await readOwnerFinancialApproval(row,order);if(!p||!p.releaseShopify)return;
  if(!row.odooInvoiceId||!['paid','paid-existing'].includes(row.odooSyncStatus)||row.odooCollectionSyncStatus!=='completed')return;
  await basePrisma.shipmentRecord.updateMany({where:{id:row.id,shopifyOrderId:row.shopifyOrderId,updatedAt:row.updatedAt,shopifyPaymentSyncStatus:{in:['needs-review','failed']},odooInvoiceId:row.odooInvoiceId,odooCollectionSyncStatus:'completed'},data:{shopifyPaymentSyncStatus:'pending',shopifyPaymentFingerprint:p.paymentFingerprint,shopifyPaymentRetryAt:null,shopifyPaymentLastError:null}});
}
