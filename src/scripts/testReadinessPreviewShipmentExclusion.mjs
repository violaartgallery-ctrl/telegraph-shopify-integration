// Synthetic VM-only: actual helper + Preview service, no handlers, live DB,
// dotenv, generation libraries, network, or filesystem writes are imported.
// node --experimental-vm-modules src/scripts/testReadinessPreviewShipmentExclusion.mjs
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const ts = require(process.env.READINESS_TYPESCRIPT_PATH || 'typescript');
const root = new URL('../services/', import.meta.url);
const source = {};
for (const name of ['previewShipmentExclusion','productionPreviewService','productionPipelineErrors','orderEligibility']) {
  source[name] = await readFile(new URL(name+'.ts',root),'utf8');
}
const copy = x => structuredClone(x);
const names = ['#900001','#900002'];
const identities = names.map((orderName,i)=>({orderName,shopifyOrderId:String(900001+i)}));
const raw = identities.map((x,i)=>({id:Number(x.shopifyOrderId),name:x.orderName,order_number:900001+i,
  financial_status:'pending',payment_gateway_names:['cash_on_delivery'],gateway:'cash_on_delivery',
  confirmed:true,test:false,cancelled_at:null,fulfillment_status:null,total_price:'100',line_items:[]}));
const fixture = {wordBase64:Buffer.from('WORD_CONTAINS_BOTH_ORDERS').toString('base64'),
  // Deliberately only one production entry: the second order must STILL be
  // fenced via full ordersDetail / binding scope, never an entries-only filter.
  productionEntries:[{display_product:'Wallet',display_color:'Black',customization_cleaned:[['inside','SYNTHETIC']],
    source_orders:[{order_name:names[0],order_id:'gid://shopify/Order/900001'}],photo_attachments:[]}],
  ordersDetail:names.map(order_name=>({order_name,items:[]})),warnings:[]};
const emptyRow = (i=0) => ({shopifyOrderId:identities[i].shopifyOrderId,shopifyOrderName:names[i],
  shopifyOrderNumber:names[i].slice(1),plannedShipmentCode:null,accurateShipmentId:null,accurateShipmentCode:null});
const noAttempt = (i=0) => ({source:'manual_shipment_claim',reason:identities[i].shopifyOrderId,externalId:'synthetic-batch',
  payloadJson:JSON.stringify({version:1,orderId:identities[i].shopifyOrderId,authorization:{batchId:'synthetic-batch'},
    token:'synthetic-token',status:'no-external-attempt',requestAttempted:false,at:'2026-01-01T00:00:00Z',stoppedAt:'2026-01-01T00:00:01Z'})});
let state, checks=0, forbiddenCalls=0;
const noop=async()=>{};
function reset(){state={rows:[],attempts:[],dbReads:[],shopifyReads:0,fetchSource:0,snapshotLoads:0,snapshotSaves:0,
  sends:[],checkpoints:0,orders:copy(raw),data:copy(fixture),primary:noop,claims:noop,afterRead:noop,
  beforeSend:noop,laser:noop,box:noop,pdf:noop,summary:noop,binary:noop,saved:noop,lease:noop,loadSnapshot:true};}
function forbidden(){forbiddenCalls++;throw Error('Unapproved real operation');}
class Lost extends Error{}
const context=vm.createContext({Buffer,Date,URL,console,process:{env:{}},AbortSignal:{timeout:()=>undefined},
  setTimeout:fn=>{Promise.resolve().then(fn);return 0;},fetch:async url=>{
    if(url!=='https://synthetic.invalid/photo.png')return forbidden();
    await state.binary();return{ok:true,status:200,arrayBuffer:async()=>Uint8Array.from([1,2,3]).buffer};
  }});
const modules=new Map();
async function synthetic(key,values){
  if(!modules.has(key)){
    const m=new vm.SyntheticModule(Object.keys(values),function(){for(const[k,v]of Object.entries(values))this.setExport(k,v);},{context,identifier:key});
    await m.link(forbidden);await m.evaluate();modules.set(key,m);
  }return modules.get(key);
}
const db={
  shipmentRecord:{findMany:async args=>{state.dbReads.push({kind:'primary',args:copy(args)});await state.primary();return copy(state.rows);}},
  failedPayload:{findMany:async args=>{state.dbReads.push({kind:'claims',args:copy(args)});await state.claims();return copy(state.attempts);}},
};
async function resolve(id){
  if(id==='node:crypto')return synthetic(id,{createHash});
  if(id==='../lib/prisma.js')return synthetic(id,{prisma:db});
  if(id==='./orderEligibility.js')return eligibility;
  if(id==='./productionPipelineErrors.js')return errors;
  if(id==='./previewShipmentExclusion.js')return helper;
  if(id==='./productionJobStore.js')return synthetic(id,{assertJobLease:async()=>state.lease(),ProductionJobLeaseLostError:Lost});
  if(id==='./productionPreviewOnly.js')return synthetic(id,{manualRunConfig:()=>({epoch:'synthetic'})});
  if(id==='./manualShipmentBinding.js')return synthetic(id,{
    bindManualShipment:o=>({version:1,orderName:o.name,shopifyOrderId:String(o.id),shippingHash:'synthetic-shipping-hash'}),
    assertManualShipmentUnchanged:()=>{},assertManualShipmentBindings:()=>{},manualShipmentBindingsHash:()=> 'synthetic-bindings-hash',
  });
  if(id==='../shopify/shopifyOrdersClient.js')return synthetic(id,{shopifyOrdersClient:{listAllMatchingOrders:async()=>{
    state.shopifyReads++;await state.afterRead();return copy(state.orders);
  }}});
  if(id==='./productionAgentClient.js')return synthetic(id,{
    extractOrderNumbers:d=>[...new Set(d.ordersDetail.map(x=>x.order_name))],productionSourceFingerprint:()=> 'synthetic-fingerprint',
    fetchProductionBatch:async()=>{state.fetchSource++;return copy(state.data);},
  });
  if(id==='../telegram/telegramApi.js')return synthetic(id,{
    sendMessage:async(recipient,text)=>{await state.beforeSend({recipient,text});state.sends.push({type:'text',recipient,text});return true;},
    sendDocument:async(recipient,buffer,filename)=>{await state.beforeSend({recipient,filename});state.sends.push({type:'document',recipient,filename});return true;},
  });
  if(id==='./laser/laserFiles.js')return synthetic(id,{laserPhotoUrls:()=>[],buildLaserArtifacts:async()=>{
    await state.laser();return[{buffer:Buffer.from('SYNTHETIC_LASER'),kind:'wallet',label:'synthetic'}];
  }});
  if(id==='./aiWriter.js')return synthetic(id,{buildBoxGridBuffers:async()=>{await state.box();return[Buffer.from('SYNTHETIC_BOX')];}});
  if(id==='./printSheet.js')return synthetic(id,{kindForProduct:()=> 'wallet',printPhotoSourceUrl:x=>x,buildPrintSheetPdf:async()=>{await state.pdf();return Buffer.from('SYNTHETIC_PDF');}});
  if(id==='./orderSummaryWriter.js')return synthetic(id,{buildOrdersSummaryBuffer:async()=>{await state.summary();return Buffer.from('SYNTHETIC_SUMMARY');}});
  throw Error('Unapproved import '+id);
}
async function compile(name){
  const js=ts.transpileModule(source[name],{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
  const m=new vm.SourceTextModule(js,{context,identifier:name,importModuleDynamically:resolve});
  await m.link(resolve);await m.evaluate();return m;
}
const errors=await compile('productionPipelineErrors');
const eligibility=await compile('orderEligibility');
const helper=await compile('previewShipmentExclusion');
const preview=await compile('productionPreviewService');
const H=helper.namespace;
const excluded=e=>e instanceof H.PreviewShipmentExclusionError&&e instanceof errors.namespace.PermanentProductionError&&e.code==='PREVIEW_SHIPMENT_EXCLUSION';
const scope=()=>H.previewShipmentScope(names,identities);
const documents=()=>state.sends.filter(x=>x.type==='document');
async function check(name,fn){reset();await fn();checks++;console.log(`ok ${checks} - ${name}`);}
function cursor(saved=true){return {version:2,kind:'preview',batchId:'synthetic-batch',status:'running',executionToken:'synthetic-lease',
  orderNumbers:saved?[...names]:[],recipientChatIds:['1','2'],sentArtifactKeys:[],sentPhotoKeys:[],unavailablePhotoUrls:[],pendingRun:false,
  ...(saved?{sourceFingerprint:'synthetic-fingerprint',manualShipmentBindings:identities.map(x=>({version:1,...x,shippingHash:'OLD_HASH'})),manualShipmentBindingHash:'OLD_BINDING_HASH'}:{}),updatedAt:Date.now()};}
async function run(c=cursor(),saved=true){return preview.namespace.sendCompleteProductionPreview({chatId:1,cursor:c,deadline:Date.now()+60000,
  checkpoint:async()=>{state.checkpoints++;},sourceSnapshot:{load:async()=>{state.snapshotLoads++;return saved?copy(state.data):null;},
    save:async()=>{state.snapshotSaves++;await state.saved();}}});}

await check('no primary row / no claim is allowed without writes',async()=>{await H.assertPreviewPrimaryShipmentExclusion(scope());assert.deepEqual(state.dbReads.map(x=>x.kind),['primary','claims']);});
await check('empty unlinked primary row is allowed',async()=>{state.rows=[emptyRow()];await H.assertPreviewPrimaryShipmentExclusion(scope());});
for(const field of ['accurateShipmentCode','plannedShipmentCode','accurateShipmentId'])await check(field+' blocks before claim read',async()=>{
  state.rows=[{...emptyRow(1),[field]:field==='accurateShipmentId'?123:'VI900002'}];
  await assert.rejects(H.assertPreviewPrimaryShipmentExclusion(scope()),e=>excluded(e)&&e.message.includes('#900002')&&(field==='accurateShipmentId'||e.message.includes('VI900002')));
  assert.equal(state.dbReads.length,1);
});
for(const value of [undefined,'',{},0,-1])await check('malformed primary identity '+String(value),async()=>{
  state.rows=[{...emptyRow(),accurateShipmentCode:value}];await assert.rejects(H.assertPreviewPrimaryShipmentExclusion(scope()),excluded);
});
for(const change of [{shopifyOrderId:'other'},{shopifyOrderName:'#900009'},{shopifyOrderNumber:'other'}])await check('conflicting primary identity '+Object.keys(change)[0],async()=>{
  state.rows=[{...emptyRow(),...change}];await assert.rejects(H.assertPreviewPrimaryShipmentExclusion(scope()),excluded);
});
await check('duplicated primary rows are unknown, not absence',async()=>{state.rows=[emptyRow(),emptyRow()];await assert.rejects(H.assertPreviewPrimaryShipmentExclusion(scope()),excluded);});
await check('malformed null primary row blocks',async()=>{state.rows=[null];await assert.rejects(H.assertPreviewPrimaryShipmentExclusion(scope()),excluded);});
await check('proven no-external-attempt claim is allowed',async()=>{state.attempts=[noAttempt()];await H.assertPreviewPrimaryShipmentExclusion(scope());});
for(const status of ['claimed','external-attempt','needs-review','completed','unknown',null])await check('claim status '+status+' blocks',async()=>{
  const row=noAttempt(),p=JSON.parse(row.payloadJson);p.status=status;row.payloadJson=JSON.stringify(p);state.attempts=[row];await assert.rejects(H.assertPreviewPrimaryShipmentExclusion(scope()),excluded);
});
for(const value of ['{','null','[]','{}','"unknown"'])await check('malformed claim '+value+' blocks',async()=>{state.attempts=[{...noAttempt(),payloadJson:value}];await assert.rejects(H.assertPreviewPrimaryShipmentExclusion(scope()),excluded);});
for(const field of ['requestAttempted','orderId','version','token','authorization','at','stoppedAt'])await check('missing no-attempt proof '+field,async()=>{
  const row=noAttempt(),p=JSON.parse(row.payloadJson);delete p[field];row.payloadJson=JSON.stringify(p);state.attempts=[row];await assert.rejects(H.assertPreviewPrimaryShipmentExclusion(scope()),excluded);
});
for(const src of ['shopify-orders-create','shopify-fulfillment-create'])await check(src+' historical uncertainty blocks',async()=>{
  state.attempts=[{source:src,externalId:'900002',reason:'synthetic',payloadJson:'{}'}];await assert.rejects(H.assertPreviewPrimaryShipmentExclusion(scope()),excluded);
});
await check('unknown attempt identity blocks',async()=>{state.attempts=[{...noAttempt(),reason:'unknown'}];await assert.rejects(H.assertPreviewPrimaryShipmentExclusion(scope()),excluded);});
await check('malformed null attempt row blocks',async()=>{state.attempts=[null];await assert.rejects(H.assertPreviewPrimaryShipmentExclusion(scope()),excluded);});
await check('bounded attempt saturation blocks',async()=>{state.attempts=Array.from({length:17},()=>noAttempt());await assert.rejects(H.assertPreviewPrimaryShipmentExclusion(scope()),excluded);});
for(const kind of ['primary','claims'])await check(kind+' database outage propagates without permission',async()=>{
  state[kind]=async()=>{throw Error('SYNTHETIC_DB_UNAVAILABLE');};await assert.rejects(H.assertPreviewPrimaryShipmentExclusion(scope()),/SYNTHETIC_DB_UNAVAILABLE/);
});
for(const invalid of [[],['#SYNTHETIC'],['#0'],['#900001','#900001']])await check('malformed full order scope '+JSON.stringify(invalid),async()=>{
  assert.throws(()=>H.previewShipmentScope(invalid,identities),excluded);
});
await check('missing order identity blocks',async()=>assert.throws(()=>H.previewShipmentScope(names,[identities[0]]),excluded));
await check('outside-entry order identity blocks',async()=>assert.throws(()=>H.previewShipmentScope(names,[...identities,{orderName:'#900003',shopifyOrderId:'900003'}]),excluded));
await check('two Shopify IDs for same name block',async()=>assert.throws(()=>H.previewShipmentScope(names,[...identities,{orderName:'#900001',shopifyOrderId:'900009'}]),excluded));
await check('same Shopify ID for two names blocks',async()=>assert.throws(()=>H.previewShipmentScope(names,[identities[0],{...identities[1],shopifyOrderId:'900001'}]),excluded));
await check('GID hints resolve to exact immutable scope',async()=>{const s=H.previewShipmentScope(names,identities.map(x=>({...x,shopifyOrderId:'gid://shopify/Order/'+x.shopifyOrderId})));assert.equal(s[1].shopifyOrderId,'900002');assert.ok(Object.isFrozen(s)&&Object.isFrozen(s[0]));});
for(const financial of ['paid','partially_paid','authorized','pending'])await check('native eligible financial '+financial,async()=>{
  const orders=copy(raw);orders[0].financial_status=financial;H.assertPreviewFinancialSource(scope(),orders);
});
for(const financial of ['refunded','partially_refunded','voided','expired','unknown','',null])await check('financial '+financial+' blocks whole batch',async()=>{
  const orders=copy(raw);orders[1].financial_status=financial;assert.throws(()=>H.assertPreviewFinancialSource(scope(),orders),e=>excluded(e)&&e.message.includes('#900002'));
});
for(const change of [{cancelled_at:'2026-01-01'},{test:true},{confirmed:false},{fulfillment_status:'fulfilled'},{payment_gateway_names:['card'],gateway:'card'}])await check('ineligible current '+Object.keys(change)[0],async()=>{
  const orders=copy(raw);Object.assign(orders[1],change);assert.throws(()=>H.assertPreviewFinancialSource(scope(),orders),excluded);
});
for(const orders of [[],null,[null],[raw[0],raw[0]],[{...raw[0],payment_gateway_names:'cod'},raw[1]]])await check('missing/malformed current source fails closed',async()=>assert.throws(()=>H.assertPreviewFinancialSource(scope(),orders),excluded));
for(const evidence of [{refunds:[{id:'synthetic'}]},{refunds:null},{transactions:[{kind:'REFUND',status:'SUCCESS'}]},
  {transactions:[{kind:'REFUND',status:'PENDING'}]},{transactions:{}},{transactions:[null]}])await check('available refund/uncertain transaction evidence blocks',async()=>{
  const orders=copy(raw);Object.assign(orders[1],evidence);assert.throws(()=>H.assertPreviewFinancialSource(scope(),orders),excluded);
});
await check('available empty refunds / non-refund transactions remain allowed',async()=>{
  const orders=copy(raw);Object.assign(orders[1],{refunds:[],transactions:[{kind:'SALE',status:'SUCCESS'}]});H.assertPreviewFinancialSource(scope(),orders);
});

await check('existing snapshot primary link stops before fresh Shopify read and any artifact',async()=>{
  state.rows=[{...emptyRow(1),accurateShipmentCode:'VI900002'}];const c=cursor(),before=JSON.stringify(c.manualShipmentBindings);
  await assert.rejects(run(c),excluded);assert.equal(state.shopifyReads,0);assert.equal(state.snapshotSaves,0);assert.equal(documents().length,0);assert.equal(state.checkpoints,0);assert.equal(JSON.stringify(c.manualShipmentBindings),before);
});
await check('fresh source second-order link stops despite absent production entry',async()=>{
  state.rows=[{...emptyRow(1),plannedShipmentCode:'VI900002'}];await assert.rejects(run(cursor(false),false),excluded);
  assert.equal(state.shopifyReads,1);assert.equal(state.snapshotSaves,0);assert.equal(documents().length,0);
});
await check('saved snapshot refund is freshly read then stops, old bindings unchanged',async()=>{
  state.orders[1].financial_status='refunded';const c=cursor(),before=JSON.stringify(c);
  await assert.rejects(run(c),e=>excluded(e)&&e.message.includes('refunded'));assert.equal(state.shopifyReads,1);assert.equal(state.fetchSource,0);assert.equal(documents().length,0);assert.equal(state.snapshotSaves,0);assert.equal(JSON.stringify(c),before);
});
await check('fresh partial refund blocks before snapshot save / binding persistence',async()=>{
  state.afterRead=async()=>{if(state.shopifyReads===2)state.orders[1].financial_status='partially_refunded';};
  await assert.rejects(run(cursor(false),false),e=>excluded(e)&&e.message.includes('partially_refunded'));assert.equal(state.snapshotSaves,0);assert.equal(documents().length,0);
});
await check('saved snapshot cancellation blocks before any artifact',async()=>{
  state.orders[1].cancelled_at='2026-01-01';await assert.rejects(run(),excluded);assert.equal(documents().length,0);
});
await check('unknown claim first blocks without Shopify fetch or snapshot save',async()=>{
  state.attempts=[{...noAttempt(1),payloadJson:'{'}];await assert.rejects(run(),excluded);assert.equal(state.shopifyReads,0);assert.equal(documents().length,0);
});
await check('concurrent reservation before source save blocks all saves/sends',async()=>{
  state.primary=async()=>{if(state.dbReads.filter(x=>x.kind==='primary').length===2)state.rows=[{...emptyRow(),plannedShipmentCode:'VI900001'}];};
  await assert.rejects(run(cursor(false),false),excluded);assert.equal(state.snapshotSaves,0);assert.equal(documents().length,0);
});
await check('concurrent uncertain claim after source save blocks first Word send',async()=>{
  state.saved=async()=>{state.attempts=[{...noAttempt(),payloadJson:'{}'}];};await assert.rejects(run(cursor(false),false),excluded);
  assert.equal(state.snapshotSaves,1);assert.equal(documents().length,0);
});
await check('concurrent link during generation blocks next artifact',async()=>{
  state.laser=async()=>{state.rows=[{...emptyRow(),accurateShipmentId:123}];};const c=cursor();await assert.rejects(run(c),excluded);
  assert.equal(documents().length,2);assert.ok(documents().every(x=>x.filename.startsWith('production_')));
  assert.equal(c.artifactManifest,undefined);
});
await check('concurrent link between recipients blocks second recipient',async()=>{
  state.beforeSend=async x=>{if(x.filename)state.rows=[{...emptyRow(),accurateShipmentCode:'VI900001'}];};const c=cursor();await assert.rejects(run(c),excluded);
  assert.equal(documents().length,1);assert.ok(c.sentArtifactKeys.includes('1|word:synthetic-fingerprint'));
});
await check('concurrent link while box grid builds stops all remaining file sends',async()=>{
  state.data.productionEntries.push({display_product:'Gift box',source_orders:[{order_name:'#900002',order_id:'gid://shopify/Order/900002'}],photo_attachments:[]});
  state.box=async()=>{state.rows=[{...emptyRow(1),plannedShipmentCode:'VI900002'}];};await assert.rejects(run(),excluded);
  assert.equal(documents().length,2);assert.ok(documents().every(x=>x.filename.startsWith('production_')));
});
await check('concurrent uncertainty after print PDF generation blocks PDF send',async()=>{
  state.data.productionEntries[0].photo_attachments=[{attachment_url:'https://synthetic.invalid/photo.png',order_name:'#900001',position_label:''}];
  state.pdf=async()=>{state.attempts=[{...noAttempt(),payloadJson:'{}'}];};await assert.rejects(run(),excluded);
  assert.equal(documents().length,4);assert.ok(documents().every(x=>!x.filename.endsWith('.pdf')));
});
await check('concurrent link while original photo loads blocks individual photo send',async()=>{
  state.data.productionEntries[0].photo_attachments=[{attachment_url:'https://synthetic.invalid/photo.png',order_name:'#900001',position_label:'inside'}];
  state.binary=async()=>{state.rows=[{...emptyRow(),accurateShipmentCode:'VI900001'}];};await assert.rejects(run(),excluded);
  assert.equal(documents().length,4);assert.ok(documents().every(x=>!x.filename.includes('_photo_')));
});
await check('concurrent link during order-summary build blocks its document',async()=>{
  state.summary=async()=>{state.rows=[{...emptyRow(),accurateShipmentCode:'VI900001'}];};await assert.rejects(run(),excluded);
  assert.equal(documents().length,4);assert.ok(documents().every(x=>!x.filename.startsWith('orders_')));
});
await check('final plain summary has its own exclusion fence',async()=>{
  state.beforeSend=async x=>{if(x.filename?.startsWith('orders_')&&x.recipient==='2')state.rows=[{...emptyRow(),accurateShipmentCode:'VI900001'}];};
  await assert.rejects(run(),excluded);assert.equal(documents().length,6);assert.ok(!state.sends.some(x=>x.text?.startsWith('📋')));
});
await check('saved snapshot clean path keeps whole Word, one bulk source read, no source resave',async()=>{
  const c=cursor();await run(c);assert.equal(state.shopifyReads,1);assert.equal(state.fetchSource,0);assert.equal(state.snapshotSaves,0);
  assert.equal(documents().length,6);assert.equal(c.orderNumbers.length,2);assert.ok(c.sentArtifactKeys.some(x=>x.includes('orders-summary')));
});
await check('fresh clean path reuses original bracket reads and captures snapshot only once',async()=>{
  const c=cursor(false);await run(c,false);assert.equal(state.shopifyReads,2);assert.equal(state.fetchSource,1);assert.equal(state.snapshotSaves,1);assert.equal(documents().length,6);
});
await check('scope mismatch cannot send stale Word',async()=>{
  const c=cursor();c.orderNumbers.reverse();await assert.rejects(run(c),excluded);assert.equal(documents().length,0);assert.equal(state.shopifyReads,0);
});
await check('duplicated order detail cannot hide behind extractOrderNumbers deduplication',async()=>{
  state.data.ordersDetail.push(copy(state.data.ordersDetail[0]));await assert.rejects(run(),excluded);assert.equal(documents().length,0);
});
await check('malformed source order detail stops typed before Word',async()=>{
  state.data.ordersDetail[0].order_name=null;await assert.rejects(run(),excluded);assert.equal(documents().length,0);
});
await check('lease lost during primary read prevents subsequent artifact and snapshot save',async()=>{
  state.primary=async()=>{state.lease=async()=>{throw new Lost('cancelled during guard');};};await assert.rejects(run(),Lost);assert.equal(documents().length,0);assert.equal(state.snapshotSaves,0);
});
await check('lease failure still stops before guard/database/source work',async()=>{
  state.lease=async()=>{throw new Lost('cancelled');};await assert.rejects(run(),Lost);assert.equal(state.dbReads.length,0);assert.equal(state.snapshotLoads,0);assert.equal(documents().length,0);
});
assert.equal(forbiddenCalls,0);
console.log(JSON.stringify({passed:checks,syntheticOnly:true,realNetwork:0,realDatabase:0,filesystemWrites:0,forbiddenCalls}));
