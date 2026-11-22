// Synthetic VM-only tests. No environment loading, DB, network or production worker invocation.
import assert from 'node:assert/strict';
import{readFileSync}from'node:fs';
import{createRequire}from'node:module';
import{createHash}from'node:crypto';
import{Script,createContext}from'node:vm';
const require=createRequire(import.meta.url),ts=require('typescript');let checks=0,network=0;
const vm=createContext({Buffer,console,process:{env:{}},fetch(){network++;throw Error('Network denied');}});
function load(path,mocks={},suffix=''){
 const source=readFileSync(new URL('../'+path+'.ts',import.meta.url),'utf8');
 const compiled=ts.transpileModule(source+suffix,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const module={exports:{}};new Script('(function(require,module,exports){'+compiled+'})').runInContext(vm)(id=>{if(Object.hasOwn(mocks,id))return mocks[id];if(id.endsWith('/cancellationRecoveryPolicy.js'))return{isOdooOnlyRecovery:()=>false,assertRecoveryNotExcluded(){}};throw Error('Import denied: '+id);},module,module.exports);return module.exports;
}
const manual=load('services/manualShipmentBinding',{'node:crypto':{createHash}});
const accounting=load('services/odooShipmentBinding',{'./manualShipmentBinding.js':manual});
const base={id:900001,name:'#900001',order_number:900001,tags:'confirmed',financial_status:'pending',fulfillment_status:null,total_price:'900',total_outstanding:'900',currency:'EGP',shipping_address:{address1:'Synthetic street',city:'Synthetic town',phone:'01000000000'},note:'custom note',note_attributes:[{name:'customer-design',value:'sample'}],line_items:[{id:1,title:'Synthetic wallet',quantity:1,price:'800',properties:[{name:'customization',value:'SAMPLE'}]}]};
const copy=x=>structuredClone(x),ok=(a,b)=>{accounting.assertOdooShipmentSourceUnchanged(a,b);checks++;},deny=(a,b)=>{assert.throws(()=>accounting.assertOdooShipmentSourceUnchanged(a,b));checks++;};
ok(base,copy(base));
const allTags=['accurate','accurate-cancelled','accurate-delivered','accurate-collected','accurate-delivered-not-collected','accurate-payment-review','accurate-returned','accurate-returned-settled','accurate-returned-unsettled','accurate-out-for-delivery','accurate-redelivery-pending','accurate-delivery-exception','accurate-return-in-transit','accurate-received','accurate-scheduled','accurate-pkr','accurate-pkm','accurate-pkh','accurate-pkd','accurate-prp','accurate-bmr','accurate-bmt','accurate-std','accurate-dtr','accurate-dex','accurate-htr','accurate-rtrn','accurate-rts','accurate-rjct','accurate-unknown'];
for(const tag of allTags){const fresh={...copy(base),tags:tag+', confirmed'};ok(base,fresh);ok(fresh,base);assert.throws(()=>manual.assertManualShipmentUnchanged(manual.bindManualShipment(base),fresh));checks++;}
for(const tag of['accurate-vip','accurate-unknown-new-code','unconfirmed','cancelled','sent_to_production'])deny(base,{...copy(base),tags:'confirmed, '+tag});
deny(base,{...copy(base),tags:''});
for(const name of['Telegraph Governorate ID','Telegraph Governorate','Telegraph Area ID','Telegraph Area']){const saved=copy(base);saved.note_attributes.push({name,value:'synthetic-route'});ok(saved,base);assert.throws(()=>manual.assertManualShipmentUnchanged(manual.bindManualShipment(saved),base));checks++;}
for(const key of['Telegraph Location Status','Telegraph Area New','customization','customer-design','_fbc']){const fresh=copy(base);fresh.note_attributes.push({name:key,value:'changed'});deny(base,fresh);}
for(const[field,value]of Object.entries({id:900002,name:'#900002',order_number:900002,financial_status:'paid',total_price:'901',total_outstanding:'0',currency:'USD',note:'changed',test:true,cancelled_at:'2026-01-01'}))deny(base,{...copy(base),[field]:value});
for(const k of['address1','city','phone']){const fresh=copy(base);fresh.shipping_address[k]='CHANGED';deny(base,fresh);}
for(const k of['title','quantity','price','properties']){const fresh=copy(base);fresh.line_items[0][k]=k==='quantity'?2:k==='properties'?[{name:'customization',value:'CHANGED'}]:'CHANGED';deny(base,fresh);}
for(const value of[{},[],5])deny(base,{...copy(base),tags:value});
for(const value of[{},5])deny(base,{...copy(base),note_attributes:value});
deny(base,{...copy(base),note_attributes:[{value:'missing-identity'}]});
const incomplete=copy(base);delete incomplete.line_items[0].properties;deny(incomplete,base);
const tooMany=copy(base);tooMany.line_items=Array.from({length:50},()=>copy(base.line_items[0]));deny(tooMany,tooMany);
const observed={...copy(base),created_at:'new',processed_at:'new',updated_at:'new',fulfillment_status:'fulfilled',browser_ip:'synthetic'};ok(base,observed);
const immutable=copy(base),savedBefore=JSON.stringify(immutable);ok(immutable,{...copy(base),tags:'accurate, confirmed'});assert.equal(JSON.stringify(immutable),savedBefore);checks++;
class Review extends Error{};
async function fixture({fresh={...copy(base),tags:'accurate, accurate-pkr, confirmed'},carrierError}={}){
 const errors=[],writes=[],success=[];const worker=load('netlify/functions/process-odoo-queue-background',{
  '../../app.js':{createAppServices(){throw Error('No actual handler');}},
  '../../services/shipmentRepository.js':{shipmentRepository:{claimOdooStage:async()=>true,markOdooStageFailure:async(...a)=>errors.push(a),markOdooStageSuccess:async(...a)=>success.push(a)}},
  '../../lib/logger.js':{logger:{info(){},warn(){},error(){}}},
  '../../shopify/shopifyOrdersClient.js':{shopifyOrdersClient:{getOrderByLegacyId:async()=>fresh}},
  '../../shopify/shopifyStatusSyncClient.js':{shopifyStatusSyncClient:{}},
  '../../services/automaticOperationSafety.js':{withAutomaticOperation:async(_o,cb)=>cb(),automaticQueueSafetyActive:()=>true,AutomaticOperationReviewError:Review},
  '../../odoo/odooClient.js':{OdooClient:class{}},
  '../../services/safeQueuePolicy.js':{safeQueueHoldReason:()=>undefined},
  '../../services/automationSafety.js':{isDatabaseQuotaError:e=>e?.message==='quota'},
  '../../services/verifiedCarrierShipment.js':{loadExactCarrierShipment:async()=>{if(carrierError)throw carrierError;return{};}},
  '../../services/odooShipmentBinding.js':accounting,
 },'\nexports.__testProcessOne=processOne;');
 const record={id:900001,shopifyOrderId:'900001',odooSyncStatus:'odoo-so-pending',odooAttemptCount:0,rawOrderJson:JSON.stringify(base),accurateShipmentCode:'VI900001'};
 const result=await worker.__testProcessOne(record,{ensureSalesOrder:async()=>{writes.push('ensureSO');return{id:99,name:'SYNTHETIC'};}},{});return{result,errors,writes,success};
}
const good=await fixture();assert.equal(good.writes.length,1);assert.equal(good.success.length,1);checks+=2;
const money=await fixture({fresh:{...copy(base),total_price:'901'}});assert.equal(money.writes.length,0);assert.match(money.errors[0][2],/^AUTOMATION_REVIEW_REQUIRED:/);checks+=2;
const missing=await fixture({carrierError:new Review('Historical waybill is not visible')});assert.equal(missing.writes.length,0);assert.match(missing.errors[0][2],/^AUTOMATION_REVIEW_REQUIRED:/);checks+=2;
const transient=await fixture({carrierError:new Error('ETIMEDOUT')});assert.match(transient.errors[0][2],/^(Error: )?ETIMEDOUT$/);assert.doesNotMatch(transient.errors[0][2],/AUTOMATION_REVIEW/);checks+=2;
await assert.rejects(fixture({carrierError:new Error('quota')}),/quota/);checks++;
assert.equal(network,0);checks++;
console.log(JSON.stringify({passed:checks,network,dbCalls:0,syntheticOnly:true}));
