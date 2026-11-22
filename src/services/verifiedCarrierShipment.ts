import {UnauthorizedError} from '../lib/errors.js';
import type {AccurateClient,AccurateShipmentSummary} from '../accurate/accurateClient.js';
import {AutomaticOperationReviewError} from './automaticOperationSafety.js';
interface ShipmentIdentity {accurateShipmentId?:number|null;accurateShipmentCode?:string|null;shopifyOrderNumber?:string|null;shopifyOrderName?:string|null;}
export function assertExactCarrierIdentity(record:ShipmentIdentity,shipment:{id:number;code:string;refNumber?:string|null}):void {
  const n=record.shopifyOrderNumber??record.shopifyOrderName?.replace(/^#/,'');
  if(!record.accurateShipmentId||!record.accurateShipmentCode||!n||process.env.ORDER_REFERENCE_PREFIX!=='Viola'||
    shipment.id!==record.accurateShipmentId||shipment.code!==record.accurateShipmentCode||shipment.refNumber!=='Viola-'+n)throw new AutomaticOperationReviewError('Exact carrier ID/code/brand/order reference is not verified');
}
export async function loadExactCarrierShipment(client:AccurateClient,record:ShipmentIdentity):Promise<AccurateShipmentSummary>{
  if(!record.accurateShipmentCode||!record.accurateShipmentId)throw new AutomaticOperationReviewError('Existing waybill identity is missing; never recreate');
  let shipment:AccurateShipmentSummary|null;
  try{shipment=await client.getShipment({code:record.accurateShipmentCode});}
  catch(error){if(!(error instanceof UnauthorizedError))throw error;const r=await client.listShipments({id:[record.accurateShipmentId]},20,1);const matches=r.data.filter(s=>s.code===record.accurateShipmentCode&&s.id===record.accurateShipmentId);if(matches.length!==1)throw new AutomaticOperationReviewError('Historical waybill is not visible; no financial/stock action');shipment=matches[0]!;}
  if(!shipment)throw new AutomaticOperationReviewError('Historical waybill is not visible; no financial/stock action');assertExactCarrierIdentity(record,shipment);return shipment;
}
