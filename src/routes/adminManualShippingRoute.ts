import express from 'express';
import type {Request,Response,NextFunction} from 'express';
import {adminManualShippingEnabled} from '../services/adminReadOnlyPolicy.js';
import {mintAdminShipmentConfirmation,verifyAdminShipmentConfirmation,assertAdminShipmentFence} from '../services/adminShippingSafety.js';
import {assertManualShipmentUnchanged} from '../services/manualShipmentBinding.js';
import {getTelegraphLocationSelection,withTelegraphLocationSelection} from '../services/telegraphLocation.js';
import {shopifyOrdersClient} from '../shopify/shopifyOrdersClient.js';
import {shipmentRepository} from '../services/shipmentRepository.js';
import {isOrderEligibleForShipment} from '../services/orderEligibility.js';
import type {ShopifyOrderProcessor} from '../services/shopifyOrderProcessor.js';
import {suggestLocation,LocationSuggestionError} from '../services/locationSuggestionService.js';
import {renderLocationSuggestion,renderLocationSuggestionScript} from '../ui/locationSuggestion.js';

type Zone={id:number;name:string;subzones:Array<{id:number;name:string}>};
const esc=(v:unknown):string=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const cap=(r:Request):string=>typeof r.query.adminToken==='string'?r.query.adminToken:'';
const path=(p:string,r:Request):string=>p+(p.includes('?')?'&':'?')+'adminToken='+encodeURIComponent(cap(r));
const id=(raw:unknown):string=>{
  if(typeof raw!=='string')return '';
  return /^(?:gid:\/\/shopify\/Order\/)?([1-9]\d*)$/.exec(raw)?.[1]??'';
};
const page=(body:string):string=>`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Make Telegraph shipment</title><meta name="shopify-api-key" content="${esc(process.env.SHOPIFY_CLIENT_ID??'')}"><script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script><style>body{font-family:Arial,sans-serif;background:#f6f8f6;color:#21382c;line-height:1.8;padding:20px}main{max-width:780px;margin:auto;background:white;border:1px solid #dbe5de;border-radius:12px;padding:24px}label{display:block;font-weight:bold;margin-top:12px}input,select,button{box-sizing:border-box;font:inherit;padding:10px;width:100%;margin:4px 0;border:1px solid #b9c9bf;border-radius:6px}button{background:#0b6b5d;color:white;font-weight:bold;cursor:pointer}a{color:#0b6b5d}.error{color:#b42318}li{margin-bottom:6px}</style></head><body><main>${body}</main></body></html>`;

export function createAdminManualShippingRouter(deps:{processor:ShopifyOrderProcessor;locations:()=>Promise<Zone[]>}) {
  const router=express.Router();
  const enabled=(r:Request,s:Response,next:NextFunction)=>adminManualShippingEnabled()?next():next('router');
  router.use(enabled);
  router.post('/api/orders/location-suggestion',express.json({limit:'2kb'}),async(r,s)=>{
    s.set('Cache-Control','private, no-store');
    try{if(r.body?.publicPlaceOnly!==true)throw new LocationSuggestionError('أكد أولًا أن النص اسم مكان عام فقط ولا يتضمن بيانات العميل.');s.json(await suggestLocation(r.body?.locality,await deps.locations()));}
    catch(e){s.status(503).json({ok:false,error:e instanceof LocationSuggestionError?e.message:'تعذر البحث الجغرافي؛ اختر يدويًا دون إعادة تلقائية.'});}
  });
  const handle=(fn:(r:Request,s:Response)=>Promise<void>)=>async(r:Request,s:Response)=>{
    try{await fn(r,s);}catch(e){s.status(409).type('html').send(page(`<h1>Make Telegraph shipment</h1><p class="error">${esc(e instanceof Error?e.message:'تعذر إتمام الطلب')}</p><p>لم تتم إعادة المحاولة تلقائيًا. لو ظهر رقم بوليصة، لا تنشئ واحدة بديلة قبل المراجعة.</p><a href="${esc(path('/orders',r))}">عرض الأوردرات</a>`));}
  };
  router.get('/orders/make-telegraph/bulk',handle(async(r,s)=>{
    const raw=r.query.ids??r.query['ids[]']??r.query.order_ids??r.query.id;
    const values=(Array.isArray(raw)?raw:typeof raw==='string'?raw.split(','):[]).map(id).filter(Boolean);
    const ids=[...new Set(values)];
    if(!ids.length||ids.length>50){s.status(400).type('html').send(page('<h1>اختر أوردرًا من Shopify</h1><p>حد أقصى 50 أوردرًا في القائمة.</p>'));return;}
    s.type('html').send(page('<h1>Make Telegraph shipments</h1><p>افتح كل أوردر وراجع بياناته ثم أكد إنشاء البوليصة. فتح القائمة وحده لا ينشئ شحنات.</p><ol>'+ids.map(v=>`<li><a href="${esc(path('/orders/make-telegraph?id='+v,r))}">فتح الأوردر ${esc(v)}</a></li>`).join('')+'</ol>'));
  }));
  router.get('/orders/make-telegraph',handle(async(r,s)=>{
    const orderId=id(r.query.id??r.query.order_id??r.query.orderId);
    if(!orderId){s.status(400).type('html').send(page('<h1>Make Telegraph shipment</h1><p>Shopify did not pass a valid order id.</p>'));return;}
    const order=await shopifyOrdersClient.getOrderByLegacyId(orderId);
    const existing=await shipmentRepository.findByShopifyOrderId(orderId);
    if(existing?.accurateShipmentId||existing?.accurateShipmentCode){s.type('html').send(page(`<h1>${esc(order.name)}</h1><p>للأوردر بوليصة مسجلة بالفعل: <strong>${esc(existing.accurateShipmentCode??existing.accurateShipmentId)}</strong>.</p><p>لم تُنشأ بوليصة أخرى ولم تتغير المحاسبة.</p>`));return;}
    if(order.cancelled_at||order.test||!isOrderEligibleForShipment(order)){s.status(409).type('html').send(page(`<h1>${esc(order.name)}</h1><p class="error">الأوردر غير مؤهل للشحن حاليًا. راجع حالة الإلغاء والتسليم والدفع أولًا؛ لم يتم تغييرها.</p>`));return;}
    const confirmation=mintAdminShipmentConfirmation(order),authorization=verifyAdminShipmentConfirmation(confirmation,orderId);
    await assertAdminShipmentFence(authorization,orderId);
    const locations=await deps.locations(),selected=getTelegraphLocationSelection(order),address=order.shipping_address??order.billing_address;
    const json=JSON.stringify(locations).replace(/</g,'\\u003c');
    s.type('html').send(page(`<h1>Make Telegraph shipment — ${esc(order.name)}</h1><p><strong>${esc(address?.name??'')}</strong></p><p>${esc([address?.address1,address?.address2,address?.city,address?.province].filter(Boolean).join(' — '))}</p><p>الهاتف: ${esc(address?.phone??order.phone??'')}<br>قيمة الطلب: ${esc(order.total_price)} ${esc(order.currency)}<br>الدفع: ${esc(order.financial_status)}</p><ul>${order.line_items.map(x=>`<li>${esc(x.title)} × ${esc(x.quantity)}</li>`).join('')}</ul>${renderLocationSuggestion([address?.city,address?.province].filter(Boolean).join(' — '))}<form method="post" action="${esc(path('/orders/make-telegraph/confirm',r))}"><input type="hidden" name="orderId" value="${esc(orderId)}"><input type="hidden" name="confirmation" value="${esc(confirmation)}"><input type="hidden" name="confirmed" value="yes"><label for="govSearch">بحث المحافظة</label><input id="govSearch" type="search" placeholder="اكتب حرفًا أو اسم المحافظة"><select id="gov" name="governorateId" required><option value="">اختر المحافظة</option></select><label for="areaSearch">بحث المنطقة</label><input id="areaSearch" type="search" placeholder="اكتب حرفًا أو اسم المنطقة"><select id="area" name="areaId" required><option value="">اختر المنطقة</option></select><p>راجع العنوان والاختيارات. الضغط التالي هو تأكيدك لإنشاء بوليصة واحدة وربطها بالأوردر، وستُضاف المحاسبة لطابورها المعتاد.</p><button type="submit">تأكيد إنشاء بوليصة Telegraph</button></form><script>const zones=${json},g=document.getElementById('gov'),a=document.getElementById('area'),gs=document.getElementById('govSearch'),as=document.getElementById('areaSearch');const norm=v=>String(v).toLowerCase().replace(/[أإآ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه').trim();function fill(el,items,q,chosen){el.replaceChildren(new Option('اختر',''));for(const x of items)if(norm(x.name).includes(norm(q)))el.add(new Option(x.name,x.id));el.value=String(chosen??'');}function areas(){const z=zones.find(z=>String(z.id)===g.value);fill(a,z?.subzones??[],as.value,a.value);}fill(g,zones,'',${JSON.stringify(selected?.governorateId??'')});areas();a.value=${JSON.stringify(String(selected?.areaId??''))};gs.oninput=()=>{fill(g,zones,gs.value,g.value);areas();};as.oninput=areas;g.onchange=()=>{as.value='';areas();};document.querySelector('form').addEventListener('submit',()=>{document.querySelector('button[type=submit]').disabled=true;});${renderLocationSuggestionScript(path('/api/orders/location-suggestion',r))}</script>`));
  }));
  router.post('/orders/make-telegraph/confirm',express.urlencoded({extended:false,limit:'20kb'}),handle(async(r,s)=>{
    const orderId=id(r.body?.orderId),token=typeof r.body?.confirmation==='string'?r.body.confirmation:'';
    if(!orderId||r.body?.confirmed!=='yes'||!token){s.status(400).type('html').send(page('<h1>التأكيد مطلوب</h1><p>افتح Make Telegraph shipment من الأوردر وراجع البيانات ثم أكد الإنشاء.</p>'));return;}
    const authorization=verifyAdminShipmentConfirmation(token,orderId),deadline=Date.now()+180_000;
    const raw=await shopifyOrdersClient.getOrderByLegacyId(orderId);
    assertManualShipmentUnchanged(authorization.binding,raw);
    const existing=await shipmentRepository.findByShopifyOrderId(orderId);
    if(existing?.accurateShipmentId||existing?.accurateShipmentCode){s.type('html').send(page(`<h1>${esc(raw.name)}</h1><p>البوليصة موجودة بالفعل: ${esc(existing.accurateShipmentCode??existing.accurateShipmentId)}. لم تُنشأ أخرى.</p>`));return;}
    if(raw.cancelled_at||raw.test||!isOrderEligibleForShipment(raw))throw Error('حالة الأوردر لا تسمح بالشحن. لم يتم تغيير حالة الدفع أو الإلغاء.');
    const gov=String(r.body?.governorateId??''),area=String(r.body?.areaId??'');
    const zone=(await deps.locations()).find(z=>String(z.id)===gov),sub=zone?.subzones.find(x=>String(x.id)===area);
    if(!zone||!sub)throw Error('اختر محافظة ومنطقة صحيحتين من قائمة Telegraph.');
    const order=withTelegraphLocationSelection(raw,{governorateId:zone.id,governorate:zone.name,areaId:sub.id,area:sub.name});
    const fence=async()=>{if(Date.now()>=deadline)throw Error('انتهت مهلة التنفيذ؛ راجع النتيجة قبل أي إعادة محاولة.');await assertAdminShipmentFence(authorization,orderId);};
    const source=async()=>{await fence();const fresh=await shopifyOrdersClient.getOrderByLegacyId(orderId);await fence();assertManualShipmentUnchanged(authorization.binding,fresh);
      if(fresh.fulfillment_status==='fulfilled'&&!(await shipmentRepository.findByShopifyOrderId(orderId))?.accurateShipmentId)throw Error('الأوردر أصبح مسلّمًا قبل إنشاء البوليصة؛ راجع الشحنات الموجودة.');};
    const result=await deps.processor.process(order,{source:'shopify-admin-human-confirmation',requireTelegraphLocation:true,
      skipEligibility:false,adminShipmentAuthorization:authorization,assertOperationAllowed:fence,assertSourceUnchanged:source});
    s.type('html').send(page(`<h1>${esc(raw.name)}</h1><p>${result.skipped?'لم تُنشأ شحنة جديدة: '+esc(result.reason):'تم إنشاء البوليصة وربطها بالأوردر.'}</p><p><strong>${esc(result.accurateShipmentCode??'')}</strong></p>${result.fulfillment?.reason?.startsWith('fulfillment-error:')?'<p class="error">البوليصة موجودة لكن ربط التسليم في Shopify يحتاج مراجعة؛ لا تنشئ بوليصة بديلة.</p>':''}<p>حالة Odoo: ${esc(result.odoo?.reason??'لم يتم تنفيذ محاسبة مباشرة')}</p><a href="${esc(path('/orders',r))}">عرض الأوردرات</a>`));
  }));
  return router;
}
