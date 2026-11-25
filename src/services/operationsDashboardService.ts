import {basePrisma} from '../lib/prisma.js';
import {safeQueueConfig} from './safeQueuePolicy.js';
import {STATUS_POLL_QUARANTINE_PREFIX} from './statusPollingPolicy.js';
import {categorizeReviewCase} from './accountantCategories.js';

// Display-only projection. No worker/finder/claim/replay functions are imported.
const LANES=['production','return','collection','shopify','status'] as const;
type Lane=typeof LANES[number];
type Row=Record<string,any>;
const LABELS:Record<Lane,string>={production:'أودو: البيع والصرف والفاتورة',return:'المرتجعات',collection:'تسويات التحصيل',shopify:'إثبات الدفع في Shopify',status:'تحديث حالة الشحن'};
const READY=['delivery-confirmed','invoice-posted','invoice-posted-awaiting-payment','paid','paid-existing'];
const PENDING=['odoo-so-pending','odoo-stock-pending','odoo-delivery-pending','odoo-paid-invoice-pending'];
const PROCESSING=['odoo-so-creating','odoo-stock-preparing','odoo-delivery-confirming','odoo-paid-invoice-processing'];
export const DASHBOARD_TTL_MS=60_000;
export function dashboardText(value:unknown):string {
  return String(value??'').replace(/https?:\/\/\S+/gi,'[رابط محجوب]').replace(/[\w.+-]+@[\w.-]+/g,'[بريد محجوب]')
    .replace(/(?:shp(?:at|ss)_|vcp_|AIza|AQ\.)[\w.-]+/g,'[سر محجوب]').replace(/\b\d{9,}\b/g,'[رقم محجوب]').slice(0,700);
}
const parse=(r:Row):Row=>{try{const p=JSON.parse(r.payloadJson);if(!p||typeof p!=='object'||Array.isArray(p))throw Error();return p;}catch{throw Error('Invalid operations metadata');}};
const time=(v:any):number=>v instanceof Date?v.getTime():typeof v==='number'?v:Date.parse(v??'');
const iso=(v:any)=>Number.isFinite(time(v))&&time(v)>0?new Date(time(v)).toISOString():null;
const orderUrl=(id:string)=>/^\d+$/.test(id)?'https://admin.shopify.com/store/violaleather/orders/'+id:undefined;
function status(r:Row,l:Lane):string {return String(r[l==='production'?'odooSyncStatus':l==='return'?'returnSyncStatus':l==='collection'?'odooCollectionSyncStatus':l==='shopify'?'shopifyPaymentSyncStatus':'accurateStatusCode']??'');}
function retry(r:Row,l:Lane):any{return r[l==='production'?'odooRetryAt':l==='return'?'returnSyncRetryAt':l==='collection'?'odooCollectionRetryAt':'shopifyPaymentRetryAt'];}
function error(r:Row,l:Lane):any{return r[l==='production'?'odooLastError':l==='return'?'returnSyncLastError':l==='collection'?'odooCollectionLastError':l==='shopify'?'shopifyPaymentLastError':'lastError'];}
function base(r:Row,l:Lane):boolean {
  if(l==='production')return r.accurateShipmentId!=null&&r.hasRawOrder;
  if(l==='return')return ['returned','returned-settled'].includes(r.collectionStatus);
  if(l==='collection')return r.collectionStatus==='collected'&&r.collectedAmount>0&&r.hasRawOrder&&r.accurateShipmentCode!=null&&READY.includes(r.odooSyncStatus);
  if(l==='shopify')return r.collectionStatus==='collected'&&r.collectedAmount>0;
  return r.accurateShipmentId!=null&&r.accurateIsTerminal!==true&&!String(r.lastError??'').startsWith(STATUS_POLL_QUARANTINE_PREFIX);
}
function state(r:Row,l:Lane):string {
  if(l==='status')return 'pending';
  const s=status(r,l);
  if(s.includes('review')||s==='failed')return 'review';
  if(l==='production')return PENDING.includes(s)?'pending':s==='odoo-failed-retryable'?'retryable':PROCESSING.includes(s)?'processing':'none';
  return ['pending','retryable','processing'].includes(s)?s:'none';
}
function sort(l:Lane,a:Row,b:Row):number {
  const date=(v:any,nil:number)=>v==null?nil:time(v);
  if(l==='production')return date(a.odooRetryAt,Infinity)-date(b.odooRetryAt,Infinity)||time(a.createdAt)-time(b.createdAt)||a.id-b.id;
  if(l==='status')return date(a.lastSyncedAt,-Infinity)-date(b.lastSyncedAt,-Infinity)||a.id-b.id;
  const key=l==='return'?'returnedAt':'deliveredAt';
  // PostgreSQL DESC defaults to NULLS FIRST, matching the native finders.
  return date(b[key],Infinity)-date(a[key],Infinity)||b.id-a.id;
}
export function projectOperations(rows:Row[],metadata:Row[],config:{epoch:string;proof:string}|undefined,deploymentId:string|undefined,now:number) {
  if(rows.length>25_000||metadata.length>6_000)throw Error('Dashboard projection bound exceeded');
  const held=new Map<string,Set<Lane>>(),closed=new Map<string,Set<Lane>>(),holds:Row[]=[],claims:Row[]=[],allClaims:Row[]=[],notes:string[]=[];
  const index=new Map(rows.map(r=>[String(r.shopifyOrderId),r]));
  let controller:Row|undefined;
  const schedulerStates=new Map<string,Row>();
  for(const m of metadata){
    const p=parse(m);
    if(m.source==='ops_record_hold'||m.source==='ops_completion_receipt'){
      if(p.version!==1||!Array.isArray(p.lanes)||!p.lanes.length||p.lanes.some((l:any)=>l!=='*'&&!LANES.includes(l)))throw Error('Invalid lane hold');
      const target=m.source==='ops_record_hold'?held:closed,id=String(m.externalId??'');
      if(!/^\d+$/.test(id))throw Error('Invalid held identity');
      const set=target.get(id)??new Set<Lane>();for(const l of p.lanes)for(const lane of l==='*'?LANES:[l])set.add(lane);target.set(id,set);
      if(m.source==='ops_record_hold')holds.push({...m,p});
    }else if(m.source==='ops_scheduler_release'&&m.reason==='active'){
      if(controller)throw Error('Duplicate active controller');controller=p;
    }else if(m.source==='ops_scheduler')schedulerStates.set(m.reason,p);
    else if(m.source==='automatic_operation_claim'){
      if(p.version!==1||!Number.isSafeInteger(p.recordId)||p.recordId<=0||!/^\d+$/.test(String(m.externalId))||typeof p.key!=='string'||!(LANES as readonly string[]).includes(p.key.split(':')[0])||!p.key.split(':').slice(1).join(':').trim()||m.reason!==p.key||!['claimed','started','completed','needs-review','no-external-attempt'].includes(p.status))throw Error('Invalid claim state');
      allClaims.push({...m,p});
      if(['claimed','started','needs-review'].includes(p.status))claims.push({...m,p});
    }
  }
  const active=Boolean(config&&deploymentId&&controller?.version===1&&controller.paused===false&&controller.epoch===config.epoch&&controller.proof===config.proof&&controller.deploymentId===deploymentId&&process.env.OPS_SCHEDULER_ENABLED!=='false');
  const nextCandidates:Row[]=[],reviewCases:Row[]=[],queues:Row[]=[],activeClaims:Row[]=[];
  const business=new Map(['odoo','delivery','returns'].map(id=>[id,{id,label:id==='odoo'?'أودو والفواتير':id==='delivery'?'التسليم والتحصيل':'المرتجعات',pending:new Set<string>(),review:new Set<string>(),processing:new Set<string>()}]));
  const businessAdd=(r:Row,l:Lane,kind:'pending'|'review'|'processing')=>{if(l==='status')return;business.get(l==='production'?'odoo':l==='return'?'returns':'delivery')![kind].add(String(r.shopifyOrderId));};
  const detail=(r:Row)=>({orderId:String(r.shopifyOrderId),orderName:r.shopifyOrderName??'#'+r.shopifyOrderNumber,shipmentCode:r.accurateShipmentCode??r.plannedShipmentCode??null,orderUrl:orderUrl(String(r.shopifyOrderId)),reviewUrl:!r.accurateShipmentId&&!r.accurateShipmentCode?'/orders/make-telegraph?id='+encodeURIComponent(String(r.shopifyOrderId)):undefined});
  const seenReview=new Set<string>();
  const addReview=(r:Row,l:Lane,reason:unknown,caseId:string,classification:string)=>{
    if(seenReview.has(caseId))return;seenReview.add(caseId);
    reviewCases.push({...detail(r),caseId,lane:l,label:LABELS[l],reason:dashboardText(reason||status(r,l)||'مراجعة مطلوبة'),classification,category:categorizeReviewCase({reason,classification,lane:l}),
      requiredAction:classification==='durable-hold'?'راجع السبب والمستندات الأصلية؛ لا يُرفع الإيقاف تلقائيًا.':classification==='diagnostic-hold'?'تحتاج تحققًا تقنيًا من هوية البوليصة؛ ليست موافقة شحن جديدة ولا يُعاد إنشاؤها.':'تأكيد الحالة أو المبلغ/المستند الصحيح قبل أي إعادة تنفيذ.'});
  };
  const claimFor=(r:Row,l:Lane)=>{
    if(l==='status')return undefined; // Status polling does not enter the financial claim primitive.
    const stage=l==='production'?(status(r,l)==='odoo-failed-retryable'?/^RETRY_FROM:([^|]+)\|/.exec(String(r.odooLastError??''))?.[1]??'odoo-so-pending':status(r,l)):l;
    const key=l+':'+stage;
    return allClaims.find(c=>String(c.externalId)===String(r.shopifyOrderId)&&c.p.status!=='no-external-attempt'&&(c.p.key===key||c.p.status!=='completed'));
  };
  for(const l of LANES){
    const q:Row={lane:l,label:LABELS[l],pending:0,retryable:0,processing:0,review:0,held:0,eligibleNow:0,waitingDependency:0,completedExcluded:0};const candidates:Row[]=[];
    for(const r of rows){const id=String(r.shopifyOrderId),s=state(r,l),isBase=base(r,l);
      if(held.get(id)?.has(l)){if(s!=='none'||l==='status'&&isBase){q.held++;businessAdd(r,l,'review');}continue;}
      if(closed.get(id)?.has(l)){if(s!=='none'||l==='status'&&isBase)q.completedExcluded++;continue;}
      const claim=s!=='none'?claimFor(r,l):undefined;
      if(claim){const fresh=['claimed','started'].includes(claim.p.status)&&claim.p.epoch===config?.epoch&&now-time(claim.p.at)<300_000;
        if(fresh&&String(claim.p.key).startsWith(l+':')){q.processing++;businessAdd(r,l,'processing');}else{q.review++;businessAdd(r,l,'review');addReview(r,l,claim.p.reason??'مطالبة مفتوحة في مسار آخر أو مستند هذه المرحلة منفذ سابقًا؛ يلزم تحقق مستقل، لا إعادة تشغيل.',`claim-${claim.id}-${l}`,'uncertain-claim');}continue;}
      if(s==='review'){q.review++;businessAdd(r,l,'review');addReview(r,l,error(r,l),`record-${r.id}-${l}`,'needs-review');continue;}
      if(s==='none')continue;
      if(!isBase){if(l!=='status'){q.waitingDependency++;businessAdd(r,l,'pending');addReview(r,l,error(r,l)||'لم تكتمل متطلبات المسار: بيانات الأوردر/البوليصة/حالة البيع أو التحصيل.',`dependency-${r.id}-${l}`,'dependency');}
        else if(r.accurateShipmentId!=null&&r.accurateIsTerminal!==true&&String(r.lastError??'').startsWith(STATUS_POLL_QUARANTINE_PREFIX)){q.review++;addReview(r,l,r.lastError,`quarantine-${r.id}`,'diagnostic-hold');}continue;}
      q[s]++;businessAdd(r,l,s==='processing'?'processing':'pending');if(s==='processing')continue;
      if(s!=='retryable'||retry(r,l)==null||time(retry(r,l))<=now){q.eligibleNow++;candidates.push(r);}
    }
    candidates.sort((a,b)=>sort(l,a,b));for(const [i,r]of candidates.slice(0,8).entries())nextCandidates.push({...detail(r),rank:i+1,lane:l,label:LABELS[l],stage:status(r,l),reason:active?'مرشح بالترتيب الحالي داخل المسار، وليس حجزًا للتنفيذ.':'مرشح فقط؛ المتحكم التلقائي غير نشط.',notBefore:iso(retry(r,l))});queues.push(q);
  }
  for(const h of holds){const r=index.get(String(h.externalId));const p=h.p,l=p.lanes[0]==='*'?'production':p.lanes[0];
    const fallback={id:h.id,shopifyOrderId:h.externalId,shopifyOrderNumber:p.orderNumber??p.orderName??h.externalId,shopifyOrderName:p.orderName,accurateShipmentCode:p.shipmentCode??p.accurateShipmentCode};
    addReview(r??fallback,l,p.reason??p.message??p.note??h.reason,`hold-${h.id}`,'durable-hold');}
  for(const c of claims){const r=rows.find(x=>x.id===c.p.recordId),l=String(c.p.key??'').split(':')[0] as Lane;if(!r||!LANES.includes(l)){notes.push('سجل تنفيذ يحتاج مطابقة هوية؛ لم يُعتبر طابورًا سليمًا أو يُعاد تشغيله.');continue;}
    if(c.p.status==='needs-review')addReview(r,l,c.p.reason??'نتيجة محاولة سابقة تحتاج دليلًا مستقلًا.',`claim-${c.id}-${l}`,'uncertain-claim');
    else if(c.p.epoch===config?.epoch&&now-time(c.p.at)<300_000)activeClaims.push({...detail(r),lane:l,label:LABELS[l],stage:dashboardText(c.p.key),status:c.p.status,startedAt:iso(c.p.at)});
  }
  const scheduler=['status','discovery','financial'].map(l=>{const s=schedulerStates.get(l+'@'+config?.epoch)??{},last=time(s.lastSuccessAt),until=time(s.leaseUntil),next=time(s.nextAt);return {
    lane:l,label:l==='status'?'تحديث الشحن':l==='discovery'?'اكتشاف التسويات':'المحاسبة والمرتجعات',enabled:active,
    state:!active?'held':until>now?'running':s.lastError?'error':!Number.isFinite(next)?'unscheduled':next<now-120_000?'overdue':!Number.isFinite(last)?'awaiting-first-cycle':'waiting',
    nextAt:iso(s.nextAt),lastSuccessAt:iso(s.lastSuccessAt),lastStartedAt:iso(s.lastStartedAt),leaseUntil:iso(s.leaseUntil),lastError:dashboardText(s.lastError)||null};});
  notes.push('لقطة قراءة فقط من Neon؛ لا تشغّل طوابير ولا ترفع الحماية. الترتيب داخل كل مسار مستقل وقد يتغير مع تحديث البيانات.','الحالات التاريخية الموقوفة وإيصالات التنفيذ المكتمل مستبعدة من المرشحين؛ ليست ازدحامًا قابلًا لإعادة التشغيل.','الأوردرات غير المكتشفة بعد في Shopify ليست محسوبة هنا. لا يوجد اتصال بخدمات العملاء الخارجية أثناء هذا العرض.');
  const ownerDecisions=metadata.filter(m=>m.source==='ops_owner_decision_v1').map(m=>{const p=parse(m);return {orderId:m.externalId,status:p.status,action:p.action,note:dashboardText(p.note),message:dashboardText(p.message),at:p.at};});
  return {ok:true,generatedAt:new Date(now).toISOString(),cacheTtlSeconds:60,controller:{active,reason:active?undefined:'التشغيل ضيق الصلاحيات غير مفعّل لهذا الإصدار أو متوقف.'},scheduler,queues,businessQueues:[...business.values()].map(g=>({id:g.id,label:g.label,pending:g.pending.size,review:g.review.size,processing:g.processing.size})),ownerDecisions,nextCandidates,activeClaims,reviewCases:reviewCases.slice(0,1000),reviewTotal:reviewCases.length,truncatedReview:reviewCases.length>1000,holdsTotal:holds.length,notes:[...new Set(notes)]};
}

let cached:ReturnType<typeof projectOperations>|undefined,inflight:Promise<any>|undefined,failedUntil=0;
export function invalidateOperationsDashboard():void {cached=undefined;failedUntil=0;}
export async function getOperationsDashboard(){
  const now=Date.now();if(cached&&now-Date.parse(cached.generatedAt)<DASHBOARD_TTL_MS)return cached;
  if(now<failedUntil)throw Error('Operations snapshot temporarily unavailable');
  if(inflight)return inflight;
  inflight=(async()=>{
    const result=await basePrisma.$transaction(async tx=>{
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const rows=await tx.$queryRawUnsafe<Row[]>(`SELECT id,"shopifyOrderId","shopifyOrderName","shopifyOrderNumber","plannedShipmentCode","accurateShipmentId","accurateShipmentCode","accurateStatusCode","accurateIsTerminal","collectionStatus","collectedAmount","createdAt","deliveredAt","returnedAt","lastSyncedAt","lastError","odooSyncStatus","odooRetryAt","odooLastError","odooCollectionSyncStatus","odooCollectionRetryAt","odooCollectionLastError","returnSyncStatus","returnSyncRetryAt","returnSyncLastError","shopifyPaymentSyncStatus","shopifyPaymentRetryAt","shopifyPaymentLastError",("rawOrderJson" IS NOT NULL) AS "hasRawOrder" FROM "viola"."ShipmentRecord" ORDER BY id LIMIT 25001`);
      const metadata=await tx.failedPayload.findMany({where:{OR:[{source:{in:['ops_record_hold','ops_completion_receipt','automatic_operation_claim','ops_owner_decision_v1']}},{source:'ops_scheduler_release',reason:'active'},{source:'ops_scheduler',reason:{in:['status','discovery','financial'].map(l=>l+'@'+safeQueueConfig()?.epoch)}}]},select:{id:true,source:true,reason:true,externalId:true,payloadJson:true},take:6001,orderBy:{id:'asc'}});
      return projectOperations(rows,metadata,safeQueueConfig(),process.env.VERCEL_DEPLOYMENT_ID,Date.now());
    },{maxWait:5000,timeout:10000,isolationLevel:'RepeatableRead'});cached=result;return result;
  })().catch(()=>{failedUntil=Date.now()+60_000;throw Error('تعذر قراءة حالة الطوابير من Neon؛ لم يتم تشغيل أي طابور. حاول بعد دقيقة.');}).finally(()=>{inflight=undefined;});return inflight;
}
