import {randomUUID} from 'node:crypto';
import {basePrisma} from '../lib/prisma.js';
import {env} from '../config/env.js';
import {AccurateClient} from '../accurate/accurateClient.js';
import {OdooClient} from '../odoo/odooClient.js';
import {shopifyOrdersClient} from '../shopify/shopifyOrdersClient.js';
import {loadExactCarrierShipment} from './verifiedCarrierShipment.js';
import {projectAccurateStatusToShopify} from './accurateStatusMapper.js';
import {buildReturnSyncFingerprint,buildOdooCollectionFingerprint,buildShopifyPaymentFingerprint} from './shipmentStatusSyncService.js';
import {safeQueueConfig} from './safeQueuePolicy.js';
import {assertOdooShipmentSourceUnchanged} from './odooShipmentBinding.js';
import {collectionSettlementQuote,financialSourceHash,financialSaleHash,sealFinancialApproval,readOwnerPayments} from './ownerFinancialApproval.js';
import {invalidateOperationsDashboard} from './operationsDashboardService.js';
import {DECISION_SOURCE,decisionHash,decisionOptions,decisionPlan,decisionProtected,decisionVersion,laneFields,reviewLanes,reviewReason,signDecisionTicket,verifyDecisionTicket,type DecisionRow} from './operationsDecisionPolicy.js';

const number=(v:unknown)=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
const secret=()=>env.shopify.clientSecret;
const sources=['ops_record_hold','ops_completion_receipt','automatic_operation_claim',DECISION_SOURCE];
export async function loadDecisionState(db:any,orderId:string) {
  const row=await db.shipmentRecord.findUnique({where:{shopifyOrderId:orderId}});
  if(!row)throw Error('هذا الأوردر غير موجود في سجلات الربط الحالية.');
  const metadata=await db.failedPayload.findMany({where:{externalId:orderId,source:{in:sources}},orderBy:{id:'asc'},take:501});
  if(metadata.length>500)throw Error('سجل الحالة يحتاج مطابقة تقنية؛ لم يتم اختصار أدلة التنفيذ.');
  for(const m of metadata){const p=JSON.parse(m.payloadJson);if(!p||typeof p!=='object'||Array.isArray(p))throw Error('سجل مراجعة غير صالح.');}
  return {row,metadata,version:decisionVersion(row,metadata)};
}
export async function readDecisionFacts(row:DecisionRow):Promise<DecisionRow> {
  try {
    const carrier=await loadExactCarrierShipment(new AccurateClient(),row as any);
    const order=await shopifyOrdersClient.getOrderByLegacyId(row.shopifyOrderId);
    if(String(order.id)!==row.shopifyOrderId||order.name!==row.shopifyOrderName||String(order.order_number)!==String(row.shopifyOrderNumber))throw Error('Identity mismatch');
    let sourceUnchanged=false;
    try{assertOdooShipmentSourceUnchanged(JSON.parse(row.rawOrderJson??'null'),order);sourceUnchanged=true;}catch{/* Display the decision, but never authorize changed products/address/money. */}
    const client=new OdooClient();
    const sales=await client.searchRead('sale.order',[['origin','=',order.name]],['name','origin','client_order_ref','state','invoice_ids','partner_id','currency_id','company_id','order_line'],{limit:3});
    const invoiceIds=sales.flatMap(s=>Array.isArray(s.invoice_ids)?s.invoice_ids:[]);
    const linked=[row.odooInvoiceId,row.odooReturnBillId].filter(x=>Number.isSafeInteger(x)&&x>0);
    const docs=await client.searchRead('account.move',['|','|',['invoice_origin','=',order.name],['invoice_origin','in',sales.map(s=>s.name)],['id','in',[...new Set([...invoiceIds,...linked])]]],['name','ref','invoice_origin','state','move_type','amount_total','payment_state','amount_residual','partner_id','currency_id','company_id'],{limit:31});
    if(docs.length>30||sales.length>2)throw Error('Evidence bound exceeded');
    const sale=sales.length===1?sales[0]!:null,relation=(v:any)=>Array.isArray(v)&&Number.isSafeInteger(v[0])?v[0]:null;
    const paymentIds=[row.odooSalePaymentId,row.odooPaymentId,row.odooReturnPaymentId].filter(x=>Number.isSafeInteger(x)&&x>0);
    const payments=await readOwnerPayments(client,{reference:order.name+' / Viola-'+order.order_number,invoiceIds:docs.map(d=>d.id),paymentIds,partnerId:relation(sale?.partner_id)??0,companyId:relation(sale?.company_id)??0});
    const activeDocs=docs.filter(d=>d.state!=='cancel');
    const saleLines=sale&&Array.isArray(sale.order_line)?await client.searchRead('sale.order.line',[['id','in',sale.order_line]],['name','product_id','product_uom_qty','price_unit','discount','tax_id','qty_delivered'],{limit:101}):[];
    const journals=env.odoo.paymentJournalId?await client.searchRead('account.journal',[['id','=',env.odoo.paymentJournalId]],['type','company_id','currency_id'],{limit:2}):[];
    const projection=projectAccurateStatusToShopify({statusCode:carrier.status?.code,returnStatusCode:carrier.returnStatus?.code,collected:carrier.collected,paidToCustomer:carrier.paidToCustomer,cancelled:carrier.cancelled,customerDue:carrier.customerDue});
    return {available:true,sourceUnchanged,financialSourceHash:financialSourceHash(order),shopifySourceHash:decisionHash(order),carrierStatus:carrier.status?.name??carrier.status?.code??'غير محدد',collectionStatus:projection.collectionStatus,
      collectedAmount:number(carrier.collectedAmount),deliveryFees:number(carrier.deliveryFees),customerDue:number(carrier.customerDue),returnFees:number(carrier.returnFees),returningDueFees:number(carrier.returningDueFees),returnedValue:number(carrier.returnedValue),
      total:number(order.current_total_price??order.total_price),currencyIsEgp:order.currency==='EGP'&&Array.isArray(sale?.currency_id)&&sale!.currency_id[1]==='EGP',financialStatus:order.financial_status??'',cancelled:Boolean(order.cancelled_at),test:Boolean(order.test),gateway:(order.payment_gateway_names??[order.gateway]).filter(Boolean).join(' '),
      saleOrderExact:sales.length===1&&sales[0]!.id===row.odooSaleOrderId&&sales[0]!.origin===order.name&&sales[0]!.client_order_ref===order.name+' / Viola-'+order.order_number&&['sale','done'].includes(String(sales[0]!.state)),
      saleOrders:sales.map(s=>({id:s.id,name:s.name,state:s.state})).sort((a,b)=>a.id-b.id),
      saleEvidenceComplete:Boolean(sale&&relation(sale.partner_id)&&relation(sale.company_id)&&relation(sale.currency_id)&&Array.isArray(sale.order_line)&&sale.order_line.length&&saleLines.length===sale.order_line.length&&saleLines.length<=100),saleHash:sale?financialSaleHash(sale,saleLines):null,saleLines:saleLines.map(l=>({name:l.name,quantity:l.product_uom_qty,price:l.price_unit,delivered:l.qty_delivered})),salePartnerId:relation(sale?.partner_id),companyId:relation(sale?.company_id),currencyId:relation(sale?.currency_id),paymentJournalId:env.odoo.paymentJournalId,paymentJournalVerified:journals.length===1&&['cash','bank'].includes(String(journals[0]!.type))&&relation(journals[0]!.company_id)===relation(sale?.company_id)&&(!journals[0]!.currency_id||relation(journals[0]!.currency_id)===relation(sale?.currency_id)),
      financialDocuments:activeDocs.map(d=>({id:d.id,name:d.name,type:d.move_type,state:d.state,total:d.amount_total,payment:d.payment_state,residual:d.amount_residual,exactSaleLink:Boolean(sale&&(invoiceIds.includes(d.id)||d.invoice_origin===sale.name)&&relation(d.partner_id)===relation(sale.partner_id)&&relation(d.company_id)===relation(sale.company_id)&&relation(d.currency_id)===relation(sale.currency_id))})).sort((a,b)=>a.id-b.id),
      payments:payments.filter(p=>p.state!=='cancel').map(p=>({id:p.id,name:p.name,state:p.state,amount:p.amount,journalId:relation(p.journal_id),partnerId:relation(p.partner_id),companyId:relation(p.company_id),currencyId:relation(p.currency_id),exactInvoiceLink:activeDocs.length===1&&Array.isArray(p.reconciled_invoice_ids)&&p.reconciled_invoice_ids.length===1&&p.reconciled_invoice_ids[0]===activeDocs[0]!.id&&Array.isArray(p.reconciled_bill_ids)&&p.reconciled_bill_ids.length===0})).sort((a,b)=>a.id-b.id),
      sourceDifferences:(()=>{try{const old=JSON.parse(row.rawOrderJson);return [...new Set([...Object.keys(old),...Object.keys(order)])].filter(k=>decisionHash(old[k]??null)!==decisionHash((order as any)[k]??null)).filter(k=>!['created_at','processed_at','updated_at','fulfillment_status','browser_ip','landing_site','referring_site','client_details'].includes(k));}catch{return ['original-source-unavailable'];}})(),
      collectionFingerprint:buildOdooCollectionFingerprint(carrier),paymentFingerprint:buildShopifyPaymentFingerprint(Number(carrier.collectedAmount)),returnFingerprint:buildReturnSyncFingerprint(carrier)};
  }catch{return {available:false,message:'تعذرت مطابقة أحد المصادر (شركة الشحن / Shopify / أودو). يمكنك حفظ توضيحك أو التأجيل، لكن الاعتماد التنفيذي غير متاح حتى تعود المطابقة.'};}
}
function safeResult(p:DecisionRow){return {id:p.nonce,action:p.action,note:p.note,status:p.status,message:p.message,blocked:p.blocked,released:p.released,at:p.at};}
export async function prepareOperationsDecision(orderId:string,actor:string) {
  const state=await basePrisma.$transaction(async tx=>{await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');return loadDecisionState(tx,orderId);},{timeout:10000,isolationLevel:'RepeatableRead'});
  const facts=await readDecisionFacts(state.row),lanes=reviewLanes(state.row);
  const protectedCase=decisionProtected(state.row,state.metadata);
  const history=state.metadata.filter((m:DecisionRow)=>m.source===DECISION_SOURCE).map((m:DecisionRow)=>safeResult(JSON.parse(m.payloadJson)));
  const reasons=lanes.map(l=>reviewReason(state.row[l==='production'?'odooLastError':l==='return'?'returnSyncLastError':l==='collection'?'odooCollectionLastError':'shopifyPaymentLastError']));
  if(protectedCase)reasons.push('الحالة عليها حماية/إيصال تنفيذ سابق. قرارك سيُحفظ، لكن لن يعيد أي مستند أو يلغي الحماية تلقائيًا.');
  const ticket=signDecisionTicket({v:1,nonce:randomUUID(),actor,orderId,version:state.version,factsHash:decisionHash(facts),exp:Date.now()+600000},secret());
  const settlements=Object.fromEntries(['accept-current','discount','extra'].map(a=>[a,collectionSettlementQuote(state.row,facts,protectedCase,a)]));
  return {ok:true,orderId,orderName:state.row.shopifyOrderName,shipmentCode:state.row.accurateShipmentCode,lanes,reasons:[...new Set(reasons)],protectedCase,settlements,
    saved:{collectedAmount:state.row.collectedAmount,deliveryFees:state.row.deliveryFees,customerDue:state.row.customerDue,returnFees:state.row.returnFees,returningDueFees:state.row.returningDueFees,returnedValue:state.row.returnedValue,total:(()=>{try{const p=JSON.parse(state.row.rawOrderJson??'null');return number(p?.current_total_price??p?.total_price);}catch{return null;}})()},
    facts,options:decisionOptions(lanes,facts,protectedCase),history:history.slice(-5),ticket};
}
export async function submitOperationsDecision(input:DecisionRow,actor:string) {
  if(!input||Object.keys(input).some(k=>!['ticket','action','note','confirmFinancial'].includes(k))||input.confirmFinancial!==undefined&&typeof input.confirmFinancial!=='boolean'||typeof input.action!=='string'||typeof input.note!=='string'||input.note.length>1200||/(?:shp(?:at|ss)_|vcp_|AIza|AQ\.)[\w.-]{16,}/.test(input.note))throw Error('راجع الاختيار والتوضيح (بحد أقصى ١٢٠٠ حرف، ومن غير أي مفاتيح سرية).');
  const ticket=verifyDecisionTicket(input.ticket,secret(),actor),note=input.note.trim();
  if(input.action!=='accept-current'&&input.action!=='defer'&&note.length<5)throw Error('اكتب توضيحًا قصيرًا للقرار، ورقم المستند لو اتعمل قبل كده.');
  const requestHash=decisionHash([actor,input.action,note,input.confirmFinancial===true]);
  // Retries after a lost HTTP reply return the original receipt, never re-arm again.
  const prior=await basePrisma.failedPayload.findFirst({where:{source:DECISION_SOURCE,externalId:ticket.orderId,reason:ticket.nonce}});
  if(prior){const p=JSON.parse(prior.payloadJson);if(p.requestHash!==requestHash)throw Error('تم حفظ اختيار مختلف بهذا الطلب؛ افتح التفاصيل من جديد.');return {ok:true,...safeResult(p),duplicate:true};}
  const initial=await loadDecisionState(basePrisma,ticket.orderId);
  if(initial.version!==ticket.version)throw Error('بيانات الحالة اتغيرت؛ افتح التفاصيل من جديد قبل الاعتماد.');
  const facts=await readDecisionFacts(initial.row);
  if(decisionHash(facts)!==ticket.factsHash)throw Error('المصادر اتغيرت منذ عرض الاختيارات؛ افتح التفاصيل وراجع القيم الجديدة.');
  const option=decisionOptions(reviewLanes(initial.row),facts,decisionProtected(initial.row,initial.metadata)).find(o=>o.value===input.action);
  if(!option)throw Error('الاختيار غير متاح لهذه الحالة.');
  const result=await basePrisma.$transaction(async tx=>{
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))",'automatic-order:'+ticket.orderId);
    const state=await loadDecisionState(tx,ticket.orderId);
    const existing=state.metadata.find((m:DecisionRow)=>m.source===DECISION_SOURCE&&m.reason===ticket.nonce);
    if(existing){const p=JSON.parse(existing.payloadJson);if(p.requestHash!==requestHash)throw Error('اختيار مختلف محفوظ بالفعل.');return safeResult(p);}
    if(state.version!==ticket.version)throw Error('الحالة اتغيرت أو شغالة دلوقتي؛ افتح التفاصيل من جديد.');
    const config=safeQueueConfig();const controller=await tx.failedPayload.findMany({where:{source:'ops_scheduler_release',reason:'active'},take:2});
    const current=controller.length===1?JSON.parse(controller[0]!.payloadJson):null;
    const active=Boolean(config&&current?.paused===false&&current?.epoch===config.epoch&&current?.proof===config.proof&&current?.deploymentId===process.env.VERCEL_DEPLOYMENT_ID&&process.env.OPS_SCHEDULER_ENABLED!=='false');
    const plan=decisionPlan(state.row,state.metadata,facts,input.action);
    let financialApproval:DecisionRow|undefined;
    if(input.confirmFinancial===true){
      if(!['accept-current','discount','extra','already-done'].includes(input.action)||!reviewLanes(state.row).some(l=>l==='collection'||l==='shopify'))throw Error('هذا الاختيار ليس تسوية تحصيل تلقائية.');
      const action=input.action==='already-done'?'accept-current':input.action;
      const quote=collectionSettlementQuote(state.row,facts,decisionProtected(state.row,state.metadata),action);
      if(!quote.available||input.action==='already-done'&&!quote.invoice?.paid)throw Error(quote.blocked.join(' ')||'لا توجد فاتورة ودفعة مطابقان يمكن ربطهما.');
      if(!active)throw Error('التشغيل الآمن غير نشط؛ لم يعتمد قرار تنفيذي.');
      plan.blocked.length=0;plan.released.length=0;for(const key of Object.keys(plan.data))delete plan.data[key];
      const releaseShopify=reviewLanes(state.row).includes('shopify')&&!state.row.shopifyPaymentTransactionId;
      Object.assign(plan.data,{collectionStatus:'collected',collectedAmount:facts.collectedAmount,deliveryFees:facts.deliveryFees,customerDue:facts.customerDue,odooCollectionFingerprint:facts.collectionFingerprint,odooCollectionRetryAt:null,odooCollectionLastError:null});
      if(quote.invoice?.paid){Object.assign(plan.data,{odooInvoiceId:quote.invoice.id,odooInvoiceName:quote.invoice.name,odooSalePaymentId:quote.payment!.id,odooPaymentId:quote.payment!.id,odooSyncStatus:'paid-existing',odooCollectionSyncStatus:'completed'});plan.released.push('existing-documents');
        if(releaseShopify){Object.assign(plan.data,{shopifyPaymentSyncStatus:'pending',shopifyPaymentFingerprint:facts.paymentFingerprint,shopifyPaymentRetryAt:null,shopifyPaymentLastError:null});plan.released.push('shopify');}
      }else{plan.data.odooCollectionSyncStatus='pending';plan.released.push('collection');}
      financialApproval={v:1,nonce:ticket.nonce,actor,action,recordId:state.row.id,orderId:state.row.shopifyOrderId,orderName:state.row.shopifyOrderName,orderNumber:state.row.shopifyOrderNumber,sourceHash:facts.financialSourceHash,sourceDifferences:facts.sourceDifferences,saleHash:facts.saleHash,saleOrderId:state.row.odooSaleOrderId,shipmentId:state.row.accurateShipmentId,code:state.row.accurateShipmentCode,gross:facts.collectedAmount,deliveryFees:facts.deliveryFees,customerDue:facts.customerDue,target:quote.target,collectionFingerprint:facts.collectionFingerprint,paymentFingerprint:facts.paymentFingerprint,shopifyAmount:quote.shopifyAmount,shopifyMode:quote.shopifyMode,releaseShopify,invoiceId:quote.invoice?.id??null,paymentId:quote.payment?.id??null,paymentJournalId:facts.paymentJournalId,companyId:facts.companyId,currencyId:facts.currencyId,partnerId:facts.salePartnerId,at:new Date().toISOString()};
    }
    if(plan.released.length&&!active){plan.blocked.push('متحكم الطوابير غير نشط لهذا الإصدار. القرار محفوظ بدون إعادة إدخال مرحلة.');plan.released.length=0;for(const k of Object.keys(plan.data))delete plan.data[k];}
    if(plan.released.length){
      // Status pollers do not take the order lock: CAS protects their concurrent update too.
      const updated=await tx.shipmentRecord.updateMany({where:{id:state.row.id,updatedAt:state.row.updatedAt,...Object.fromEntries(Object.values(laneFields).map(k=>[k,state.row[k]]))},data:plan.data});
      if(updated.count!==1)throw Error('وصل تحديث جديد أثناء الحفظ؛ لم يُعتمد القرار. أعد فتح التفاصيل.');
    }
    const status=plan.released.length?'queued':input.action==='defer'?'deferred':'saved-needs-evidence';
    const message=financialApproval?'اعتمدت التسوية المحددة. أودو يستخدم المستند المطابق أو ينفذ فاتورة ودفعة مرة واحدة، ثم يُستكمل Shopify تلقائيًا بعد التحقق؛ لا تحتاج الرجوع للمساعد. أي مصدر متغير أو نتيجة غير مؤكدة ستتوقف للمراجعة.':status==='queued'?'اتعتمد وأُضيف للطابور الآمن. لم يُنفّذ أي مستند من زر الحفظ؛ تابع تحديث الحالة.':status==='deferred'?'تم حفظ ملاحظتك بدون اعتماد أو تغيير حالة أي مرحلة. المراحل الآمنة المفعلة أصلًا تستمر حسب الجدولة.':'تم حفظ قرارك؛ الاستكمال يحتاج التحقق الموضح أدناه. لا يلزم تكرار ردك.';
    const p={version:1,nonce:ticket.nonce,actor,orderId:ticket.orderId,recordId:state.row.id,requestHash,sourceVersion:ticket.version,factsHash:ticket.factsHash,action:input.action,note,status,message,released:plan.released,blocked:plan.blocked,at:new Date().toISOString(),...(financialApproval?{financialApproval,financialSeal:sealFinancialApproval(financialApproval)}:{})};
    await tx.failedPayload.create({data:{source:DECISION_SOURCE,externalId:ticket.orderId,reason:ticket.nonce,payloadJson:JSON.stringify(p)}});
    return safeResult(p);
  },{timeout:10000,maxWait:5000});
  invalidateOperationsDashboard();return {ok:true,...result};
}
