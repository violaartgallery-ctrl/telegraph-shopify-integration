// Actual scoped modules execute only with VM fakes. No dotenv/Prisma/provider I/O.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import ts from 'typescript';
let checks=0;
const ok=(value,message)=>{assert.ok(value,message);checks++;};
class ValidationError extends Error {constructor(m,details){super(m);this.details=details;}}
class UnauthorizedError extends Error {}
const env={ORDER_REFERENCE_PREFIX:'Viola',PRODUCTION_MANUAL_RUN_ENABLED:'true',PRODUCTION_MANUAL_RUN_EPOCH:'synthetic-epoch',PRODUCTION_MANUAL_RUN_MIN_UPDATE_ID:'100',PRODUCTION_PREVIEW_ALLOWED_CHAT_IDS:'101,102'};
let rows=[],nextId=1,serial=Promise.resolve(),uuid=0;
const match=(r,w)=>Object.entries(w??{}).every(([k,v])=>r[k]===v);
const table={async findMany({where}={}){return structuredClone(rows.filter(r=>match(r,where)));},async create({data}){const r={id:nextId++,...data};rows.push(r);return structuredClone(r);},async updateMany({where,data}){let count=0;for(const r of rows)if(match(r,where)){Object.assign(r,data);count++;}return {count};},async update({where,data}){const r=rows.find(r=>match(r,where));if(!r)throw Error('Missing synthetic claim');Object.assign(r,data);return structuredClone(r);}};
const db={failedPayload:table,$transaction(fn){const p=serial.then(()=>fn({failedPayload:table,$queryRawUnsafe:async sql=>{ok(sql.includes('pg_advisory_xact_lock'),'Durable per-order transaction lock');return [];}}));serial=p.catch(()=>{});return p;}};
const logger={info(){},warn(){},error(){}};
function load(path,mocks){const module={exports:{}};const source=readFileSync(new URL('../'+path+'.ts',import.meta.url),'utf8');const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}});const sandbox={module,exports:module.exports,process:{env},console,Date,Error,Buffer,JSON,Set,Map,Number,fetch(){throw Error('Real network forbidden');},require(s){if(!Object.hasOwn(mocks,s))throw Error('Unapproved import '+s);return mocks[s];}};vm.runInNewContext(compiled.outputText,sandbox,{filename:path});return module.exports;}
const errors={ValidationError,UnauthorizedError};
const safety=load('services/manualShippingSafety',{'node:crypto':{randomUUID:()=>String(++uuid)},'../lib/prisma.js':{prisma:db},'../lib/errors.js':errors});
const auth={chatId:101,batchId:'synthetic-batch',epoch:'synthetic-epoch',updateId:101};
await assert.rejects(()=>safety.withManualShipmentClaim('1',{...auth,epoch:'old'},async()=>{},async()=>({})),/invalid/);ok(rows.length===0,'Stale authorization has no claim');
let entered,release;const held=new Promise(r=>release=r),started=new Promise(r=>entered=r);
const first=safety.withManualShipmentClaim('1',auth,async()=>{},async c=>{await c.beforeExternalAttempt();entered();await held;return {accurateShipmentId:700,accurateShipmentCode:'VI9000001'};});await started;
await assert.rejects(()=>safety.withManualShipmentClaim('1',{...auth,chatId:102},async()=>{},async()=>({})),/durable claim/);checks++;release();await first;
ok(JSON.parse(rows[0].payloadJson).status==='completed','Successful claim receipt preserved');
await assert.rejects(()=>safety.withManualShipmentClaim('1',auth,async()=>{},async()=>({})),/durable claim/);checks++;
await assert.rejects(()=>safety.withManualShipmentClaim('2',auth,async()=>{},async c=>{await c.beforeExternalAttempt();throw Error('fetch failed');}),/manual review/);checks++;
await assert.rejects(()=>safety.withManualShipmentClaim('2',auth,async()=>{},async()=>({})),/durable claim/);checks++;
ok(JSON.parse(rows.find(r=>r.reason==='2').payloadJson).requestAttempted,'Unknown writes never expire');
await assert.rejects(()=>safety.withManualShipmentClaim('3',auth,async()=>{},async()=>{throw Error('before external request');}),/before external/);checks++;
await safety.withManualShipmentClaim('3',auth,async()=>{},async()=>({}));ok(rows.filter(r=>r.reason==='3').length===2,'Proven no-attempt failure may be reclaimed');

let record=null,calls=[],get=async()=>null,save=async()=>({id:700,code:'VI9000001'}),fence=async()=>{};
const repo={async findByShopifyOrderId(){return structuredClone(record);},async createPending(){calls.push('pending');record??={};},async markCreated(id,s){calls.push('receipt');Object.assign(record,{accurateShipmentId:s.id,accurateShipmentCode:s.code});},async markFailed(){calls.push('failed');},async markOdooSoPending(){calls.push('odoo-intent');},async clearDeletedShipment(){throw Error('Unsafe recreation forbidden');}};
const fulfill={async fulfillOrder(input){await input.assertOperationAllowed?.();calls.push('fulfill');return {skipped:false};}};
const processorBinding=load('services/manualShipmentBinding',{'node:crypto':{createHash}}),pipelineErrors=load('services/productionPipelineErrors',{});
const processorModule=load('services/shopifyOrderProcessor',{'../accurate/accurateClient.js':{},'./accurateMapper.js':{},'./failedPayloadService.js':{failedPayloadService:{async save(){calls.push('failure-audit');}}},'../lib/logger.js':{logger},'./shipmentRepository.js':{shipmentRepository:repo},'./orderEligibility.js':{isOrderEligibleForShipment:()=>true},'../shopify/shopifyFulfillmentClient.js':{shopifyFulfillmentClient:fulfill},'./shipmentCodeService.js':{shipmentCodeService:{async reserveForOrder(){calls.push('reserve');return 'VI9000001';}}},'../lib/errors.js':errors,'./manualShippingSafety.js':safety,'./adminShippingSafety.js':{withAdminShipmentClaim(){throw Error('Admin authority outside this Telegram regression');}},'./manualShipmentBinding.js':processorBinding,'./productionPipelineErrors.js':pipelineErrors,'./existingShipmentFulfillment.js':{async reconcileExistingShipmentFulfillment(){throw Error('Human reconciliation is tested in testExistingShipmentFulfillment');},async recordCreatedShipmentFulfillmentBoundary(){return 1;},async markCreatedShipmentFulfillmentAttempt(){},async completeCreatedShipmentFulfillment(){},async noteExistingFulfillmentReview(){}}});
const processor=new processorModule.ShopifyOrderProcessor({getShipment:async()=>await get(),listShipments:async()=>({data:await get()}),saveShipment:async()=>{calls.push('save');return await save();}},{async mapOrderToShipment(){return {code:'VI9000001',refNumber:'Viola-900001'};}});
const order={id:900001,name:'#900001',order_number:900001,test:false,cancelled_at:null,line_items:[]};
const old={accurateShipmentId:700,accurateShipmentCode:'VI9000001',odooSyncStatus:'paid',odooSaleOrderId:22,odooSaleOrderName:'S22'};
record={...old};get=async()=>null;await assert.rejects(()=>processor.process(order),/NEVER recreate/);ok(!calls.includes('save')&&!calls.includes('fulfill'),'Missing historical carrier never recreated');
for(const status of ['paid','paid-existing','returned','returned-charge-paid','delivery-confirmed']){calls=[];record={...old,odooSyncStatus:status};get=async()=>({id:700,code:'VI9000001',refNumber:'Viola-900001'});const r=await processor.process(order);ok(r.skipped&&!calls.includes('odoo-intent')&&!calls.includes('fulfill')&&!calls.includes('save'),'Completed historical state preserved '+status);}
calls=[];record={...old,odooSyncStatus:'needs-review'};await assert.rejects(()=>processor.process(order),/manual review/);ok(calls.length===0,'Existing held case untouched');
calls=[];record={odooSaleOrderId:22};await assert.rejects(()=>processor.process(order),/accounting/);ok(!calls.includes('save'),'Orphan accounting link blocks shipping');
calls=[];record=null;await processor.process({...order,cancelled_at:'synthetic'});ok(!calls.includes('save'),'Cancelled order cannot create shipment');
record={...old};get=async()=>({id:700,code:'VI9000001',refNumber:'Other-900001'});await assert.rejects(()=>processor.process(order),/NEVER recreate/);checks++;
env.PRODUCTION_PREVIEW_ONLY='true';record=null;await assert.rejects(()=>processor.process(order),/human Run authorization/);checks++;
const context={manualRunAuthorization:{...auth,batchId:'processor-batch'},operationDeadline:Date.now()+300000,assertOperationAllowed:async()=>await fence(),assertSourceUnchanged:async()=>{}};
calls=[];get=async()=>null;save=async()=>{throw Error('ECONNRESET unknown outcome');};await assert.rejects(()=>processor.process(order,context),/manual review/);ok(calls.filter(c=>c==='save').length===1,'Single external shipment attempt');
await assert.rejects(()=>processor.process(order,context),/durable claim/);ok(calls.filter(c=>c==='save').length===1,'Unknown outcome is not replayed');
record=null;calls=[];let cancelled=false;save=async()=>{cancelled=true;return {id:701,code:'VI9000001'};};fence=async()=>{if(cancelled)throw Error('lease cancelled');};await assert.rejects(()=>processor.process({...order,id:900002},context),/manual review/);ok(record.accurateShipmentId===701&&!calls.includes('fulfill'),'In-flight result receipt retained after cancellation, no later fulfillment');
delete env.PRODUCTION_PREVIEW_ONLY;fence=async()=>{};

let requests=0,retryCalls=0;
const accurate=load('accurate/accurateClient',{'../config/env.js':{env:{accurate:{}}},'../lib/errors.js':errors,'../lib/logger.js':{logger},'../lib/retry.js':{async retry(fn,should,n){retryCalls++;let last;for(let i=0;i<n;i++){try{return await fn();}catch(e){last=e;if(!should(e))throw e;}}throw last;}},'./queries.js':Object.fromEntries(['GET_SHIPMENT_QUERY','LIST_PAYMENTS_QUERY','LIST_SHIPMENTS_QUERY','LIST_SHIPMENTS_FOR_PAYMENT_QUERY','LIST_ZONES_QUERY','LOGIN_MUTATION','SAVE_SHIPMENT_MUTATION'].map(k=>[k,k]))});
for(const err of [Error('fetch failed'),Error('ETIMEDOUT'),new UnauthorizedError()]){const c=new accurate.AccurateClient();c.token='synthetic';c.tokenExpiresAt=Date.now()+60000;c.request=async()=>{requests++;throw err;};requests=0;retryCalls=0;await assert.rejects(()=>c.saveShipment({}));ok(requests===1&&retryCalls===0,'Mutation retry disabled '+err.message);}
const c=new accurate.AccurateClient();c.token='synthetic';c.tokenExpiresAt=Date.now()+60000;requests=0;c.request=async()=>{if(++requests<3)throw Error('fetch failed');return {shipment:{id:1}};};await c.getShipment({id:1});ok(requests===3,'Read-only bounded retry preserved');
let gqlCalls=0,stop=false;
const fulfillment=load('shopify/shopifyFulfillmentClient',{'node:crypto':{createHash},'../services/orderEligibility.js':load('services/orderEligibility',{}),'./shopifyAdminGraphql.js':{async requestShopifyAdmin(){gqlCalls++;stop=true;return {order:{displayFulfillmentStatus:'UNFULFILLED',fulfillmentOrders:{nodes:[{id:'synthetic',status:'OPEN',lineItems:{nodes:[{id:'line',remainingQuantity:1}]}}]}}};}}});
await assert.rejects(()=>fulfillment.shopifyFulfillmentClient.fulfillOrder({orderId:1,assertOperationAllowed:async()=>{if(stop)throw Error('lease cancelled');}}),/lease cancelled/);ok(gqlCalls===1,'Cancellation during fulfillment read fences the mutation');
const reader=load('shopify/shopifyOrdersClient',{'./shopifyAdminGraphql.js':{requestShopifyAdmin(){throw Error('Synthetic map-only test');}}});
const line={id:'gid://shopify/LineItem/990001',title:'synthetic',quantity:1,currentQuantity:1,originalUnitPriceSet:{shopMoney:{amount:'100'}},customAttributes:[{key:'engraving',value:'synthetic name'},{key:'photo',value:'https://invalid.test/synthetic.png'}]};
const mapped=reader.mapLineItems([line]);ok(mapped[0].properties[0].name==='engraving'&&mapped[0].properties[1].value.endsWith('synthetic.png'),'Shared mapper retains text and image customization');
ok(reader.mapLineItems([{...line,customAttributes:[]}])[0].properties.length===0,'Explicit empty customization retained');
ok(reader.mapLineItems([{...line,customAttributes:undefined}])[0].properties===undefined,'Missing customization is not silently declared empty');
const binding=load('services/manualShipmentBinding',{'node:crypto':{createHash}}),boundOrder={...order,line_items:mapped,total_price:'100'};
const bound=binding.bindManualShipment(boundOrder),changed=structuredClone(boundOrder);changed.line_items[0].properties[0].value='changed';
assert.throws(()=>binding.assertManualShipmentUnchanged(bound,changed),/source changed/);checks++;
binding.assertManualShipmentUnchanged(bound,{...boundOrder,fulfillment_status:'fulfilled'});ok(true,'Own fulfillment does not mask critical customization binding');
console.log(JSON.stringify({ok:true,checks,realDatabaseConnections:0,realNetworkCalls:0,realPreviewRun:0}));
