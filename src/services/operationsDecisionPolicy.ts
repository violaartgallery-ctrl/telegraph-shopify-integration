import {createHash,createHmac,timingSafeEqual} from 'node:crypto';

export type DecisionRow=Record<string,any>;
export const DECISION_SOURCE='ops_owner_decision_v1';
export const decisionHash=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const decisionLanes=['production','collection','shopify','return'] as const;
export const laneFields={production:'odooSyncStatus',collection:'odooCollectionSyncStatus',shopify:'shopifyPaymentSyncStatus',return:'returnSyncStatus'} as const;
const review=(s:unknown)=>typeof s==='string'&&(s.includes('review')||s==='failed');
export function reviewLanes(row:DecisionRow):string[]{return decisionLanes.filter(l=>review(row[laneFields[l]]));}
export function decisionProtected(row:DecisionRow,metadata:DecisionRow[]):boolean {
  const lanes=reviewLanes(row);
  return metadata.some(m=>{
    if(['ops_record_hold','ops_completion_receipt'].includes(m.source)){
      const p=JSON.parse(m.payloadJson),known=['production','collection','shopify','return','status'];
      if(p.version!==1||!Array.isArray(p.lanes)||!p.lanes.length||p.lanes.some((l:unknown)=>typeof l!=='string'||l!=='*'&&!known.includes(l)))return true;
      // Match the native lane exclusion exactly. A production-only completion
      // receipt is NOT permission to replay production and does NOT represent a
      // completed collection/payment. Keep it byte-for-byte, protect its lane.
      return p.lanes.some((l:string)=>l==='*'||lanes.includes(l));
    }
    if(m.source!=='automatic_operation_claim')return false;
    const p=JSON.parse(m.payloadJson);
    if(p.version!==1||typeof p.key!=='string'||!['no-external-attempt','completed','claimed','started','needs-review'].includes(p.status))return true;
    if(p.status==='no-external-attempt')return p.requestAttempted!==false;
    return p.status!=='completed'||lanes.includes(p.key.split(':')[0]);
  });
}
export function decisionVersion(row:DecisionRow,metadata:DecisionRow[]):string {
  // The whole source row is bound, not only the status that happened to fail.
  return decisionHash([row,metadata.map(m=>[m.id,m.source,m.externalId,m.reason,m.payloadJson])]);
}
export function reviewReason(reason:unknown):string {
  const text=String(reason??'');
  if(/Accounting money\/products\/address\/customization changed/.test(text))return 'بيانات الأوردر اتغيرت بعد الشحن؛ لازم نحدد النسخة الصحيحة للمحاسبة.';
  if(/Collected\/unknown return money/.test(text))return 'الشحنة مرتجعة لكن يوجد تحصيل أو قيمة تحصيل غير مؤكدة؛ محتاج قرار تسوية.';
  if(/Current carrier (?:collection|payment|return) facts changed/.test(text))return 'بيانات شركة الشحن اتغيرت عن البيانات التي توقف عليها الطابور. راجع القيم الحالية ثم اعتمد.';
  if(/paid return charge/.test(text))return 'تسليم وتحصيل بعد تسجيل مصروف مرتجع مدفوع في أودو؛ محتاج تسوية المستند السابق.';
  if(/Current Shopify payment\/collection differs/.test(text))return 'المبلغ أو طريقة الدفع في Shopify مختلفة عن التحصيل؛ اختار تفسير الفرق.';
  if(/claim|outcome|partial|uncertain|attempt/i.test(text))return 'في محاولة سابقة نتيجتها غير محسومة؛ يلزم مطابقة المستند قبل أي إعادة تنفيذ.';
  return 'الحالة تحتاج مطابقة بيانات أو مستند. افتح التفاصيل وحدد قرارك؛ لن يُعاد تنفيذ مستند مكتمل.';
}
export function decisionOptions(lanes:string[],facts:DecisionRow,protectedCase:boolean) {
  const result:Array<{value:string;label:string}> = [];
  if(facts.available&&!protectedCase&&lanes.some(l=>['collection','shopify'].includes(l)))result.push({value:'accept-current',label:'التحصيل والحالة الحالية صحيحان — اعتمد الاستكمال الآمن'});
  if(lanes.some(l=>['collection','shopify'].includes(l)))result.push({value:'discount',label:'المبلغ الأقل صحيح: خصم معتمد، وتسوية أودو وShopify'},{value:'extra',label:'المبلغ الأعلى صحيح: زيادة في أودو، وShopify بإجمالي الأوردر فقط'},{value:'wrong-collection',label:'التحصيل غير صحيح — انتظر تصحيحه من شركة الشحن، لا تسجل فلوسًا'});
  if(lanes.includes('return'))result.push({value:'returned',label:'البضاعة رجعت فعلًا — اعتمد المرتجع إن كان آمنًا'},{value:'return-money-refunded',label:'مرتجع والتحصيل اترد بالفعل — اكتب رقم مستند الرد للمطابقة'},{value:'return-money-due',label:'مرتجع لكن الفلوس لم تُرد بعد — لا تعتبرها مردودة'},{value:'return-wrong-collection',label:'مرتجع ولم يحصل تحصيل أصلًا — شركة الشحن تحتاج تصحيحًا'},{value:'not-returned',label:'البضاعة لم ترجع — أوقف تنفيذ المرتجع'});
  if(lanes.includes('production'))result.push({value:'source-current',label:'تعديلات Shopify الحالية مقصودة؛ هذه النسخة الصحيحة للمحاسبة'});
  result.push({value:'already-done',label:'اتعملت قبل كده؛ سأكتب رقم المستند أو توضيحه'},{value:'defer',label:'لم أحسم القرار بعد — احفظ ملاحظتي'},{value:'other',label:'قرار آخر — سأكتب التوضيح'});
  return result;
}
export function decisionPlan(row:DecisionRow,metadata:DecisionRow[],facts:DecisionRow,action:string) {
  const lanes=reviewLanes(row),data:DecisionRow={},released:string[]=[],blocked:string[]=[];
  const forbidden=decisionProtected(row,metadata);
  if(forbidden)blocked.push('توجد حماية تاريخية أو محاولة/مستند سابق. حفظ القرار لا يلغيها؛ يلزم التحقق من المستند المشار إليه.');
  if(!facts.available)blocked.push('تعذرت مطابقة شركة الشحن أو Shopify أو أودو؛ لن نعتبر البيانات الناقصة موافقة تنفيذ.');
  if(forbidden||!facts.available)return {data,released,blocked};
  if(facts.sourceUnchanged!==true&&['accept-current','returned'].includes(action)){
    blocked.push('المنتجات/العنوان/التخصيص أو بيانات مصدر الأوردر اتغيرت بعد الشحن أو لم تُطابق يقينًا. قرارك محفوظ، لكن اعتماد مبلغ التحصيل وحده لا يغيّر النسخة المحاسبية الأصلية.');
    return {data,released,blocked};
  }
  if(!lanes.length)blocked.push('هذه حالة تشخيص أو متطلب سابق، وليست مرحلة مالية يمكن إعادة إدخالها تلقائيًا.');
  const sameMoney=(a:any,b:any)=>typeof a==='number'&&typeof b==='number'&&Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<0.005;
  const f=facts;
  if(action==='accept-current'){
    const valid=f.collectionStatus==='collected'&&f.collectedAmount>0&&sameMoney(f.total,f.collectedAmount)&&!f.cancelled&&!f.test&&!/refund|void|partial/i.test(f.financialStatus)&&!/kashier|visa|card|instapay/i.test(f.gateway);
    const sourceMatches=sameMoney(row.collectedAmount,f.collectedAmount)&&sameMoney(row.deliveryFees,f.deliveryFees)&&sameMoney(row.customerDue,f.customerDue)&&row.collectionStatus===f.collectionStatus;
    if(!valid||!sourceMatches)blocked.push('القيم الحالية لا تطابق شروط التحصيل العادي أو لقطة Neon. اختر تفسير الفرق؛ الاستكمال يحتاج تسوية محددة أو تحديث المصدر.');
    else {
      if(lanes.includes('collection')){
        if(!['delivery-confirmed','invoice-posted','invoice-posted-awaiting-payment','paid','paid-existing'].includes(row.odooSyncStatus)||!f.saleOrderExact||f.financialDocuments.length||row.odooSalePaymentId||row.odooPaymentId||row.odooInvoiceId||row.odooReturnBillId||row.odooReturnPaymentId)blocked.push('أودو: يلزم ربط أمر بيع صحيح ومراجعة أي فاتورة/دفعة موجودة قبل الاستكمال.');
        else {Object.assign(data,{odooCollectionSyncStatus:'pending',odooCollectionFingerprint:f.collectionFingerprint,odooCollectionRetryAt:null,odooCollectionLastError:null});released.push('collection');}
      }
      if(lanes.includes('shopify')){
        if(f.financialStatus==='paid'||row.shopifyPaymentTransactionId)blocked.push('Shopify: يوجد دفع مسجل أو محتمل؛ يلزم إثباته وربطه بدل تسجيل دفع جديد.');
        else {Object.assign(data,{shopifyPaymentSyncStatus:'pending',shopifyPaymentFingerprint:f.paymentFingerprint,shopifyPaymentRetryAt:null,shopifyPaymentLastError:null});released.push('shopify');}
      }
    }
  }else if(action==='returned'){
    const returnMoneyMatches=['collectedAmount','customerDue','returnFees','returningDueFees','returnedValue'].every(k=>sameMoney(row[k],f[k]));
    if(!['returned','returned-settled'].includes(f.collectionStatus)||f.collectedAmount!==0||f.test||!['pending','authorized','unpaid','voided'].includes(f.financialStatus)||!f.saleOrderExact||f.financialDocuments.length||!f.returnFingerprint||row.collectionStatus!==f.collectionStatus||!returnMoneyMatches)blocked.push('المرتجع يحتاج مطابقة التحصيل ورسوم المرتجع وصافي المستحق/الفاتورة وأمر البيع. لم يتم إلغاء أوردر أو تحريك مخزون.');
    else if(lanes.includes('return')){Object.assign(data,{returnSyncStatus:'pending',returnSyncFingerprint:f.returnFingerprint,returnSyncRetryAt:null,returnSyncLastError:null});released.push('return');}
  }else if(action!=='defer')blocked.push('تم حفظ القرار والتوضيح، لكنه يحتاج مطابقة/تسوية المستند أو مصدر البيانات قبل التنفيذ. لا يتم إنشاء خصم أو زيادة أو رد أموال تلقائيًا من هذا الاختيار.');
  return {data,released,blocked};
}
export interface DecisionTicket {v:1;nonce:string;actor:string;orderId:string;version:string;factsHash:string;exp:number;}
export function signDecisionTicket(ticket:DecisionTicket,secret:string):string {
  if(secret.length<24)throw Error('Decision signing unavailable');
  const body=Buffer.from(JSON.stringify(ticket)).toString('base64url');
  return body+'.'+createHmac('sha256',secret).update('ops-owner-decision-v1:'+body).digest('base64url');
}
export function verifyDecisionTicket(token:string,secret:string,actor:string,now=Date.now()):DecisionTicket {
  if(typeof token!=='string'||token.length>2500||secret.length<24)throw Error('Invalid decision ticket');
  const [body,mac,...rest]=token.split('.');if(rest.length||!body||!mac)throw Error('Invalid decision ticket');
  const expected=createHmac('sha256',secret).update('ops-owner-decision-v1:'+body).digest();const actual=Buffer.from(mac,'base64url');
  if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw Error('Invalid decision signature');
  const p=JSON.parse(Buffer.from(body,'base64url').toString()) as DecisionTicket;
  if(p.v!==1||p.actor!==actor||!/^\d{1,20}$/.test(p.orderId)||!/^[-\w]{20,80}$/.test(p.nonce)||!/^\w{64}$/.test(p.version)||!/^\w{64}$/.test(p.factsHash)||!Number.isSafeInteger(p.exp)||p.exp<=now||p.exp>now+600_000)throw Error('Expired or invalid decision ticket');
  return p;
}
