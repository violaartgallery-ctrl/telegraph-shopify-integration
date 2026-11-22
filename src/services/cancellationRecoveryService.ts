import {basePrisma} from '../lib/prisma.js';
import {requestShopifyAdmin} from '../shopify/shopifyAdminGraphql.js';
import {shopifyOrdersClient} from '../shopify/shopifyOrdersClient.js';
import {OdooSaleReturnService} from '../odoo/odooSaleReturnService.js';
import {OdooClient} from '../odoo/odooClient.js';
import {AccurateClient} from '../accurate/accurateClient.js';
import {loadExactCarrierShipment} from './verifiedCarrierShipment.js';
import {withAutomaticOperation,automaticRecordBlocked,AutomaticOperationReviewError} from './automaticOperationSafety.js';
import {readOwnerPayments,exactOwnerPayment,financialSaleHash} from './ownerFinancialApproval.js';
import {env} from '../config/env.js';
import {assertRecoveryNotExcluded,assertStaticRecoveryTuple,assertSettledRecoveryCarrier,assertCancelledRecoverySource,isOdooOnlyRecovery,recoveryIdentity,recoveryIdentityMatches,recoveryHash,nativeReturnProofValid,RETURN_GRACE_MS,NATIVE_RETURN_PROOF,FALSE_RETURN_PROOF,FALSE_RETURN_MARKER,NATIVE_RETURN_MARKER,RECOVERY_POLICY_START} from './cancellationRecoveryPolicy.js';

type Row=Record<string,any>;
const deny=(s:string):never=>{throw new AutomaticOperationReviewError(s);};
const parse=(r:any)=>{try{return JSON.parse(r.payloadJson);}catch{return deny('Malformed recovery evidence');}};
export async function originalRecoveryLines(orderId:string):Promise<Row[]> {
  const r=await requestShopifyAdmin<any>(`query RecoveryOriginalQuantities($id:ID!){order(id:$id){id lineItems(first:50){nodes{id quantity} pageInfo{hasNextPage}}}}`,{id:'gid://shopify/Order/'+orderId});
  if(r.order?.id!=='gid://shopify/Order/'+orderId||r.order.lineItems?.pageInfo?.hasNextPage||!Array.isArray(r.order.lineItems?.nodes))return deny('Original Shopify quantities unavailable');
  return r.order.lineItems.nodes;
}
async function uniqueProof(source:string,row:Row):Promise<Row|null>{
  const receipts=await basePrisma.failedPayload.findMany({where:{source,externalId:row.shopifyOrderId},take:3});
  if(receipts.length>1)return deny('Ambiguous recovery receipts');return receipts.length?parse(receipts[0]):null;
}
async function completedClaim(row:Row,key:string):Promise<Row|null>{
  const claims=await basePrisma.failedPayload.findMany({where:{source:'automatic_operation_claim',externalId:row.shopifyOrderId,reason:key},take:3});
  if(claims.length>1)return deny('Ambiguous recovery claims');return claims.length?parse(claims[0]):null;
}
export async function recoveryAuthority(row:Row,order:Row):Promise<Row|null>{
  assertRecoveryNotExcluded(row,order);
  const exact=assertStaticRecoveryTuple(row);
  if(exact){
    if(Number(order.total_price)!==exact.originalTotal)return deny('Exact 42 original amount changed');
    let sourceJson=row.rawOrderJson;
    // One known legacy mapper omitted properties. An explicit, separately
    // recorded owner answer may supply EMPTY properties for this exact line
    // only. No general rebase, source rewrite or product/address override.
    if(exact.orderName==='#13794'&&typeof sourceJson==='string'){
      const source=JSON.parse(sourceJson),line=source.line_items?.find((l:Row)=>String(l.id)==='50858062709028');
      if(line&&!Array.isArray(line.properties)){
        const p=await uniqueProof('ops_owner_empty_properties_13794_v1',row);
        if(p&&p.v===1&&p.action==='approve-current-empty-properties'&&p.originalRawHash===recoveryHash(row.rawOrderJson)&&recoveryIdentityMatches(p,row)&&p.lineId==='50858062709028'&&line.sku==='FLP-BIF-MIX'&&line.quantity===1){line.properties=[];sourceJson=JSON.stringify(source);}
      }
    }
    return{kind:'exact42',sourceJson};
  }
  if(!isOdooOnlyRecovery(row))return null;
  const receipt=await uniqueProof(FALSE_RETURN_PROOF,row),claim=await completedClaim(row,'return:false-return-v1');
  if(!receipt||receipt.v!==1||receipt.policyStart!==RECOVERY_POLICY_START||!recoveryIdentityMatches(receipt,row)||!claim||claim.status!=='completed'||!claim.requestAttempted||claim.recordId!==row.id||claim.fingerprint!==receipt.returnFingerprint||claim.completedAt<receipt.completedAt||receipt.proofHash!==recoveryHash([receipt.identity,receipt.returnFingerprint,receipt.sourceJson,receipt.result]))return deny('Completed Odoo false-return repair proof missing; marker alone is not permission');
  return{kind:'proved-false-return',sourceJson:receipt.sourceJson};
}
export async function assertRecoverySource(row:Row,order:Row,authority:Row):Promise<void>{
  if(typeof authority.sourceJson!=='string')return deny('Recovery source snapshot missing');
  assertCancelledRecoverySource(JSON.parse(authority.sourceJson),order,await originalRecoveryLines(row.shopifyOrderId));
}
/** Read-only native preflight: no SO creation, no invoice adjustment, no paid
 * invoice inferred from a computed Odoo search domain. */
export async function recoveryCollectionPreflight(row:Row,order:Row,client:any,live:Row):Promise<Row|null>{
  const authority=await recoveryAuthority(row,order);if(!authority)return null;
  assertSettledRecoveryCarrier(row,live);await assertRecoverySource(row,order,authority);
  if(env.odoo.paymentJournalId!==7)return deny('Recovery settlement requires Cash journal 7');
  const sales=await client.searchRead('sale.order',[['origin','=',row.shopifyOrderName]],['name','origin','client_order_ref','state','partner_id','currency_id','company_id','order_line','invoice_ids'],{limit:3}),sale=sales[0];
  if(sales.length!==1||sale.id!==row.odooSaleOrderId||sale.state!=='sale'||sale.client_order_ref!==row.shopifyOrderName+' / Viola-'+order.order_number)return deny('Recovery existing SO identity/state changed; never create another');
  const lines=await client.searchRead('sale.order.line',[['id','in',sale.order_line]],['name','product_id','product_uom_qty','price_unit','discount','tax_id','qty_delivered'],{limit:101});
  if(!lines.length||lines.length!==sale.order_line.length||lines.length>100||lines.some((l:Row)=>!Number.isFinite(l.product_uom_qty)||l.product_uom_qty<0||Math.abs(Number(l.qty_delivered)-Number(l.product_uom_qty))>0.005))return deny('Recovery delivery/line evidence is incomplete');
  const partnerId=sale.partner_id?.[0],companyId=sale.company_id?.[0],currencyId=sale.currency_id?.[0];
  if(!partnerId||!companyId||!currencyId)return deny('Recovery SO accounting identity incomplete');
  const journals=await client.searchRead('account.journal',[['id','=',7]],['name','type','company_id','currency_id'],{limit:2});
  if(journals.length!==1||journals[0].type!=='cash'||journals[0].company_id?.[0]!==companyId||journals[0].currency_id&&journals[0].currency_id?.[0]!==currencyId)return deny('Cash 7 identity is not verified');
  const docs=await client.searchRead('account.move',['|','|',['invoice_origin','=',row.shopifyOrderName],['invoice_origin','=',sale.name],['id','in',sale.invoice_ids]],['name','state','move_type','amount_total','amount_residual','payment_state','partner_id','company_id','currency_id','invoice_line_ids'],{limit:31});
  if(docs.length>=31)return deny('Recovery invoice evidence bound exceeded');
  const active=docs.filter((d:Row)=>d.state!=='cancel'),invoice=active[0],target=live.customerDue;
  if(active.length>1||invoice&&(invoice.move_type!=='out_invoice'||invoice.state!=='posted'||!sale.invoice_ids.includes(invoice.id)||Math.abs(invoice.amount_total-target)>0.005||invoice.partner_id?.[0]!==partnerId||invoice.company_id?.[0]!==companyId||invoice.currency_id?.[0]!==currencyId||!['paid','not_paid'].includes(invoice.payment_state)||Math.abs(invoice.amount_residual-(invoice.payment_state==='paid'?0:target))>0.005))return deny('Existing recovery invoice is partial, changed, duplicated or credited');
  const payments=await readOwnerPayments(client,{reference:row.shopifyOrderName+' / Viola-'+order.order_number,invoiceIds:docs.map((d:Row)=>d.id),paymentIds:[row.odooSalePaymentId].filter(Boolean),partnerId,companyId});
  const posted=payments.filter(p=>p.state!=='cancel');let payment:Row|null=null;
  if(invoice?.payment_state==='paid'){
    if(posted.length!==1||!exactOwnerPayment(posted[0]!,{invoiceId:invoice.id,amount:target,journalId:7,partnerId,companyId,currencyId}))return deny('Paid recovery invoice has no unique exact payment; no second payment');payment=posted[0]!;
  }else if(posted.length)return deny('Existing recovery payment blocks any new payment');
  if(row.odooInvoiceId&&row.odooInvoiceId!==invoice?.id||row.odooSalePaymentId&&row.odooSalePaymentId!==payment?.id)return deny('Recovery Neon links conflict with actual documents');
  return{authority,sale,invoice,payment,target,paymentJournalId:7,partnerId,companyId,currencyId,saleHash:financialSaleHash(sale,lines),orderName:order.name,orderNumber:order.order_number,saleOrderId:sale.id};
}
/** First stable observation starts a new 24h grace, even if carrier date is old.
 * The queue's existing retryAt keeps delayed returns out of the due head. */
export async function deferReturnDuringGrace(row:Row,returnFingerprint:string,now=new Date()):Promise<boolean>{
  const rows=await basePrisma.failedPayload.findMany({where:{source:'ops_return_observation_v1',externalId:row.shopifyOrderId,reason:returnFingerprint},take:3});
  if(rows.length>1)return deny('Return observation identity ambiguous');
  const first=rows[0]?.createdAt??now;
  if(!rows.length)await basePrisma.failedPayload.create({data:{source:'ops_return_observation_v1',externalId:row.shopifyOrderId,reason:returnFingerprint,payloadJson:JSON.stringify({v:1,identity:recoveryIdentity(row),fingerprint:returnFingerprint,at:now.toISOString()})}});
  else {const p=parse(rows[0]);if(p.v!==1||!recoveryIdentityMatches(p,row)||p.fingerprint!==returnFingerprint)return deny('Return observation changed');}
  const due=new Date(new Date(first).getTime()+RETURN_GRACE_MS);
  if(now>=due)return false;
  await basePrisma.shipmentRecord.updateMany({where:{id:row.id,shopifyOrderId:row.shopifyOrderId,returnSyncFingerprint:returnFingerprint,returnSyncStatus:{in:['pending','retryable']}},data:{returnSyncStatus:'retryable',returnSyncRetryAt:due,returnSyncLastError:'RETURN_STABILITY_GRACE: awaiting 24h and fresh carrier recheck'}});
  return true;
}
export async function recordNativeReturnProof(row:Row):Promise<void>{
  if(!row.rawOrderJson||!row.returnSyncFingerprint||!row.odooSaleOrderId)return deny('Completed return lacks native recovery evidence');
  const previous=await uniqueProof(NATIVE_RETURN_PROOF,row);if(previous)return deny('Prior native return proof exists; do not overwrite/rebase');
  const p={v:1,policyStart:RECOVERY_POLICY_START,identity:recoveryIdentity(row),returnFingerprint:row.returnSyncFingerprint,sourceJson:row.rawOrderJson,completedAt:new Date().toISOString()};
  await basePrisma.failedPayload.create({data:{source:NATIVE_RETURN_PROOF,externalId:row.shopifyOrderId,reason:'completed',payloadJson:JSON.stringify(p)}});
  const changed=await basePrisma.shipmentRecord.updateMany({where:{id:row.id,shopifyOrderId:row.shopifyOrderId,returnSyncStatus:'completed',returnSyncFingerprint:row.returnSyncFingerprint},data:{lastError:NATIVE_RETURN_MARKER+':'+recoveryHash(p)}});
  if(changed.count!==1)throw Error('Completed native return proof marker CAS failed; do not replay');
}
export async function repairDocumentedFalseReturn(row:Row,live:Row):Promise<boolean>{
  if(live.status?.code!=='DTR'||live.returnStatus?.code||live.cancelled||row.returnSyncStatus!=='completed'||!row.odooSaleOrderId)return false;
  if(!String(row.lastError??'').startsWith(NATIVE_RETURN_MARKER+':'))return false; // No historical scan/query on every old delivered return.
  const proof=await uniqueProof(NATIVE_RETURN_PROOF,row);if(!proof)return false;
  if(row.lastError!==NATIVE_RETURN_MARKER+':'+recoveryHash(proof))return deny('Native return proof marker does not match its receipt');
  const originalClaim=await completedClaim(row,'return:return');
  if(!originalClaim||!nativeReturnProofValid(proof,originalClaim,row))return deny('Original completed bot return proof is not exact');
  const fresh=await shopifyOrdersClient.getOrderByLegacyId(row.shopifyOrderId);assertRecoveryNotExcluded(row,fresh);
  for(const lane of ['production','return','collection','shopify','status'] as const)if(await automaticRecordBlocked(row.id,lane))return deny('Owner hold/closure excludes false-return repair');
  await assertRecoverySource(row,fresh,{sourceJson:proof.sourceJson});
  await withAutomaticOperation({recordId:row.id,lane:'return',key:'false-return-v1',fingerprint:proof.returnFingerprint},async()=>{
    const current=await basePrisma.shipmentRecord.findUnique({where:{id:row.id}});if(!current||!recoveryIdentityMatches(proof,current))return deny('False-return primary identity changed');
    const carrier=await loadExactCarrierShipment(new AccurateClient(),current);
    if(carrier.status?.code!=='DTR'||carrier.returnStatus?.code||carrier.cancelled)return deny('False-return DTR changed immediately before stock repair');
    const order=await shopifyOrdersClient.getOrderByLegacyId(row.shopifyOrderId);assertRecoveryNotExcluded(current,order);await assertRecoverySource(current,order,{sourceJson:proof.sourceJson});
    const client=new OdooClient(),sales=await client.searchRead('sale.order',[['origin','=',row.shopifyOrderName]],['name','origin','client_order_ref','state'],{limit:3});
    if(sales.length!==1||sales[0]!.id!==row.odooSaleOrderId||sales[0]!.client_order_ref!==order.name+' / Viola-'+order.order_number)return deny('False-return SO identity changed');
    const result=await new OdooSaleReturnService(client).restoreDeliveredAfterReturn(row.odooSaleOrderId);
    const receipt={v:1,policyStart:RECOVERY_POLICY_START,identity:recoveryIdentity(row),returnFingerprint:proof.returnFingerprint,sourceJson:proof.sourceJson,result,completedAt:new Date().toISOString(),proofHash:recoveryHash([recoveryIdentity(row),proof.returnFingerprint,proof.sourceJson,result])};
    await basePrisma.failedPayload.create({data:{source:FALSE_RETURN_PROOF,externalId:row.shopifyOrderId,reason:'completed',payloadJson:JSON.stringify(receipt)}});
    const changed=await basePrisma.shipmentRecord.updateMany({where:{id:row.id,shopifyOrderId:row.shopifyOrderId,odooSaleOrderId:row.odooSaleOrderId,returnSyncStatus:'completed',returnSyncFingerprint:proof.returnFingerprint},data:{lastError:FALSE_RETURN_MARKER+':'+receipt.proofHash,odooSyncStatus:'delivery-confirmed',odooLastError:null}});
    if(changed.count!==1)throw Error('False-return repaired externally but primary CAS failed; independent reconciliation required');
  });return true;
}
