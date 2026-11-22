import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {prisma} from '../lib/prisma.js';
import {ValidationError} from '../lib/errors.js';
import {adminManualShippingEnabled} from './adminReadOnlyPolicy.js';
import {withDurableShipmentClaim,type ManualShipmentClaim} from './manualShippingSafety.js';
import {bindManualShipment,type ManualShipmentBinding} from './manualShipmentBinding.js';
import type {ShopifyOrder} from '../types/shopify.js';

export interface AdminShipmentAuthorization {
  version: 1; kind: 'shopify-admin'; shop: string; epoch: string;
  binding: ManualShipmentBinding; nonce: string; issuedAt: number; expiresAt: number;
}
const key = (): string => {
  const value=process.env.ADMIN_SECRET_TOKEN ?? '';
  if(value.length<16)throw new ValidationError('Shopify manual shipping signing key is unavailable');
  return value;
};
const signature=(body:string):string=>createHmac('sha256',key()).update('viola-admin-shipment-v1:'+body).digest('base64url');
const equal=(a:string,b:string):boolean=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function mintAdminShipmentConfirmation(order:ShopifyOrder):string {
  if(!adminManualShippingEnabled())throw new ValidationError('Shopify manual shipping is not enabled');
  const issuedAt=Date.now();
  const p:AdminShipmentAuthorization={version:1,kind:'shopify-admin',shop:process.env.SHOPIFY_SHOP_DOMAIN!,
    epoch:process.env.SHOPIFY_MANUAL_SHIPPING_EPOCH!.trim(),binding:bindManualShipment(order),nonce:randomUUID(),
    issuedAt,expiresAt:issuedAt+15*60_000};
  const body=Buffer.from(JSON.stringify(p)).toString('base64url');
  return body+'.'+signature(body);
}
export function verifyAdminShipmentConfirmation(token:string,orderId:string):AdminShipmentAuthorization {
  try {
    if(typeof token!=='string'||token.length>6000)throw Error();
    const parts=token.split('.');
    if(parts.length!==2||!equal(signature(parts[0]),parts[1]))throw Error();
    const p=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8')) as AdminShipmentAuthorization;
    assertAdminShipmentAuthorization(p,orderId);
    return p;
  } catch { throw new ValidationError('Confirmation expired or order changed; reopen Make Telegraph shipment'); }
}
export function assertAdminShipmentAuthorization(p:AdminShipmentAuthorization,orderId:string):void {
  if(!adminManualShippingEnabled()||p?.version!==1||p.kind!=='shopify-admin'||
    p.shop!=='violaleather.myshopify.com'||p.epoch!==process.env.SHOPIFY_MANUAL_SHIPPING_EPOCH?.trim()||
    !/^[1-9]\d*$/.test(orderId)||p.binding?.version!==1||p.binding.shopifyOrderId!==orderId||
    !/^#\S+$/.test(p.binding.orderName)||!/^[a-f0-9]{64}$/.test(p.binding.shippingHash)||
    !/^[a-f0-9-]{36}$/.test(p.nonce)||!Number.isSafeInteger(p.issuedAt)||!Number.isSafeInteger(p.expiresAt)||
    p.issuedAt>Date.now()+5000||p.expiresAt<=Date.now()||p.expiresAt-p.issuedAt!==900_000) {
    throw new ValidationError('Shopify human shipment authorization is invalid');
  }
}
export async function assertAdminShipmentFence(p:AdminShipmentAuthorization,orderId:string):Promise<void> {
  assertAdminShipmentAuthorization(p,orderId);
  // Any owner or historic completion hold stays held. This release never
  // interprets a generic enable flag as a decision on a disputed order.
  const rows=await prisma.failedPayload.findMany({where:{
    source:{in:['ops_record_hold','ops_completion_receipt']},externalId:orderId},select:{id:true}});
  if(rows.length)throw new ValidationError('This order has an owner/completion review hold; no new shipment is allowed');
}
export async function withAdminShipmentClaim<T extends {accurateShipmentId?:number;accurateShipmentCode?:string}>(
  orderId:string,p:AdminShipmentAuthorization,assertAllowed:()=>Promise<void>,
  action:(claim:ManualShipmentClaim)=>Promise<T>
):Promise<T> {
  const fence=async()=>{await assertAdminShipmentFence(p,orderId);await assertAllowed();};
  await fence();
  // SAME native per-order claim namespace and lock as Telegram: concurrent
  // double-clicks or mixed Shopify/Telegram attempts cannot allocate twice.
  return await withDurableShipmentClaim(orderId,p,'shopify-admin:'+p.nonce,fence,action);
}
