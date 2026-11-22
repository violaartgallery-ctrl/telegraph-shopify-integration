import express from 'express';
import {env} from '../config/env.js';
import {constantTimeTextEqual,verifyAdminCapability,verifyShopifySessionToken} from '../services/shopifyAdminAuth.js';
import {prepareOperationsDecision,submitOperationsDecision} from '../services/operationsDecisionService.js';

// Mounted AFTER adminAuth; no cookies, legacy GET execution, or unauthenticated links.
function actor(request:express.Request):string {
  const header=request.header('x-admin-secret');
  if(header&&env.adminSecretToken&&constantTimeTextEqual(header,env.adminSecretToken))return 'operations-admin';
  const token=typeof request.query.adminToken==='string'?request.query.adminToken:header;
  if(token){const verified=verifyAdminCapability(token,{clientSecret:env.shopify.clientSecret,shopDomain:env.shopify.shopDomain});if(verified.ok)return 'shopify:'+verified.claims.sub;}
  const jwt=request.header('authorization')?.replace(/^Bearer /,'')??(typeof request.query.id_token==='string'?request.query.id_token:undefined);
  if(jwt){const verified=verifyShopifySessionToken(jwt,{clientId:env.shopify.clientId,clientSecret:env.shopify.clientSecret,shopDomain:env.shopify.shopDomain});if(verified.ok)return 'shopify:'+verified.claims.sub;}
  throw Error('انتهى تسجيل الدخول؛ افتح التطبيق من Shopify من جديد.');
}
const recent=new Map<string,{at:number;count:number;busy:boolean}>();
export function createOperationsDecisionRouter() {
  const router=express.Router();
  router.post(['/api/operations/review/prepare','/api/operations/review/decide'],express.json({limit:'8kb',strict:true}),async(request,response)=>{
    response.set('Cache-Control','private, no-store');response.set('Referrer-Policy','no-referrer');
    let limit:{at:number;count:number;busy:boolean}|undefined;
    let acquired=false;
    try {
      if(!request.is('application/json')||request.header('x-ops-review')!=='1')throw Error('استخدم زر الحفظ داخل التطبيق.');
      const origin=request.header('origin');if(!origin||new URL(origin).host!==request.get('host'))throw Error('الحفظ متاح من صفحة التطبيق نفسها فقط.');
      const who=actor(request),now=Date.now();
      if(recent.size>1000)for(const [key,v]of recent)if(now-v.at>60000)recent.delete(key);
      limit=recent.get(who);if(!limit||now-limit.at>60000){limit={at:now,count:0,busy:false};recent.set(who,limit);}
      if(limit.busy||++limit.count>30){response.status(429).json({ok:false,error:'طلب آخر قيد المراجعة أو تم الوصول لحد التحديث. انتظر قليلًا ثم حاول يدويًا.'});return;}
      limit.busy=true;acquired=true;
      if(request.path.endsWith('/prepare')){
        const body=request.body;if(!body||Object.keys(body).length!==1||typeof body.orderId!=='string'||!/^\d{1,20}$/.test(body.orderId))throw Error('رقم أوردر غير صالح.');
        response.json(await prepareOperationsDecision(body.orderId,who));
      }else response.json(await submitOperationsDecision(request.body,who));
    }catch(error){const message=error instanceof Error?error.message:'';response.status(409).json({ok:false,error:/[\u0600-\u06ff]/.test(message)?message:'تعذر التحقق من الحالة أو صلاحية الطلب. افتح التفاصيل من جديد؛ لم يتم تشغيل أي مستند من هذا الطلب.'});}
    finally{if(limit&&acquired)limit.busy=false;}
  });
  return router;
}
