import {createHash} from 'node:crypto';
import {cancellationRecoveryData as data} from './cancellationRecoveryData.js';
import {assertOdooShipmentSourceUnchanged} from './odooShipmentBinding.js';

export const RETURN_GRACE_MS=24*60*60*1000;
export const NATIVE_RETURN_PROOF='ops_native_return_proof_v1';
export const FALSE_RETURN_PROOF='ops_false_return_repair_v1';
export const FALSE_RETURN_MARKER='ODOO_ONLY_FALSE_RETURN_V1';
export const NATIVE_RETURN_MARKER='NATIVE_RETURN_COMPLETED_V1';
// Historical returns are deliberately NOT grandfathered into automatic recovery.
export const RECOVERY_POLICY_START='2026-11-04T00:44:23.000Z';
type Row=Record<string,any>;
const byId=new Map<string,(typeof data.exceptions)[number]>(data.exceptions.map(x=>[x.orderId,x]));
export const staticRecoveryException=(orderId:string|number)=>byId.get(String(orderId))??null;
export const isOdooOnlyRecovery=(row:Row)=>Boolean(staticRecoveryException(row.shopifyOrderId)||String(row.lastError??'').startsWith(FALSE_RETURN_MARKER+':'));
export function assertRecoveryNotExcluded(row:Row,order?:Row):void {
  if((data.review48 as readonly string[]).includes(row.shopifyOrderName??'')||/(?:^|,)\s*(?:restored-20261104|internal-courier)\s*(?:,|$)/i.test(order?.tags??''))throw Error('AUTOMATION_REVIEW_REQUIRED: Owner-excluded recovery case');
}
export function assertStaticRecoveryTuple(row:Row):ReturnType<typeof staticRecoveryException> {
  const x=staticRecoveryException(row.shopifyOrderId);if(!x)return null;
  if(x.orderName!==row.shopifyOrderName||x.code!==row.accurateShipmentCode||x.shipmentId!==row.accurateShipmentId||x.saleOrderId!==row.odooSaleOrderId)throw Error('AUTOMATION_REVIEW_REQUIRED: Exact 42 order/waybill/SO tuple changed');
  return x;
}
export function assertSettledRecoveryCarrier(row:Row,live:Row):void {
  if(live.id!==row.accurateShipmentId||live.code!==row.accurateShipmentCode||live.refNumber!=='Viola-'+String(row.shopifyOrderNumber??row.shopifyOrderName?.replace(/^#/,''))||live.status?.code!=='DTR'||live.returnStatus?.code||live.cancelled||live.collected!==true||live.paidToCustomer!==true)throw Error('AUTOMATION_REVIEW_REQUIRED: Odoo-only invoice requires exact DTR and BOTH carrier collection and merchant settlement');
  for(const k of ['collectedAmount','deliveryFees','customerDue'])if(typeof live[k]!=='number'||!Number.isFinite(live[k])||typeof row[k]!=='number'||Math.abs(live[k]-row[k])>0.005)throw Error('AUTOMATION_REVIEW_REQUIRED: Recovery carrier money changed');
  if(live.collectedAmount<=0||live.deliveryFees<0||live.customerDue<=0||Math.abs(live.collectedAmount-live.deliveryFees-live.customerDue)>0.005)throw Error('AUTOMATION_REVIEW_REQUIRED: Invalid net merchant settlement');
}
/** Cancellation changes lifecycle totals/current quantities only. Original quantities
 * must be supplied by an independent GraphQL read, never inferred from zeroes. */
export function assertCancelledRecoverySource(saved:Row,fresh:Row,originalLines:Row[]):void {
  if(!fresh.cancelled_at||fresh.test||fresh.currency!=='EGP'||String(saved.id)!==String(fresh.id)||saved.name!==fresh.name)throw Error('AUTOMATION_REVIEW_REQUIRED: Cancelled recovery identity/currency changed');
  const gateway=(fresh.payment_gateway_names??[fresh.gateway]).filter(Boolean).join(' ');
  if(!/cod|cash|الدفع.*الاستلام|دفع.*استلام|manual/i.test(gateway)||/kashier|visa|card|instapay|paypal|paymob|fawry/i.test(gateway))throw Error('AUTOMATION_REVIEW_REQUIRED: Cancelled recovery is COD only');
  if(!Array.isArray(originalLines)||originalLines.length!==saved.line_items?.length||originalLines.length!==fresh.line_items?.length||originalLines.length>=50)throw Error('AUTOMATION_REVIEW_REQUIRED: Original line evidence is incomplete');
  const a=structuredClone(saved),b=structuredClone(fresh);
  for(const l of b.line_items){const original=originalLines.filter(x=>String(x.id).split('/').pop()===String(l.id));const prior=a.line_items.find((x:Row)=>String(x.id)===String(l.id));if(original.length!==1||!prior||original[0]!.quantity!==prior.quantity||!Number.isSafeInteger(prior.quantity)||prior.quantity<=0)throw Error('AUTOMATION_REVIEW_REQUIRED: Original product quantity changed');l.quantity=original[0]!.quantity;}
  for(const o of [a,b]){
    // These fields represent the cancellation, not a new commercial agreement.
    for(const k of ['cancelled_at','financial_status','fulfillment_status','total_outstanding','current_total_price','current_shipping_price_set'])delete o[k];
    for(const l of o.line_items)delete l.current_quantity;
    o.tags=(o.tags??'').split(',').map((t:string)=>t.trim()).filter((t:string)=>t!=='needs-collection-followup').join(', ');
  }
  const botNote='⚠️ Telegraph delivered but customer did not pay. Business follow-up required.';
  if(b.note===botNote&&(fresh.tags??'').split(',').some((t:string)=>t.trim()==='needs-collection-followup'))b.note=a.note;
  assertOdooShipmentSourceUnchanged(a as any,b as any);
}
export function recoveryIdentity(row:Row){return{recordId:row.id,orderId:row.shopifyOrderId,orderName:row.shopifyOrderName,shipmentId:row.accurateShipmentId,code:row.accurateShipmentCode,saleOrderId:row.odooSaleOrderId};}
export function recoveryIdentityMatches(p:Row,row:Row):boolean {return JSON.stringify(p.identity)===JSON.stringify(recoveryIdentity(row));}
export function recoveryHash(value:unknown):string {return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
export function nativeReturnProofValid(p:Row,claim:Row,row:Row):boolean {
  return p.v===1&&p.policyStart===RECOVERY_POLICY_START&&recoveryIdentityMatches(p,row)&&p.returnFingerprint===row.returnSyncFingerprint&&typeof p.sourceJson==='string'&&Date.parse(p.completedAt)>=Date.parse(RECOVERY_POLICY_START)&&claim.version===1&&claim.recordId===row.id&&claim.key==='return:return'&&claim.fingerprint===p.returnFingerprint&&claim.status==='completed'&&claim.requestAttempted===true&&Date.parse(claim.completedAt)>=Date.parse(p.completedAt);
}
