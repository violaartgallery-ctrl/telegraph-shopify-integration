/** Narrow financial/status release, independent of manual Telegram permissions.
 * An incomplete configuration stays held without touching Neon. */
export function safeQueueConfig(): { epoch: string; proof: string } | undefined {
  if (process.env.OPS_SAFE_QUEUES_ENABLED?.trim().toLowerCase() !== 'true') return undefined;
  const epoch=process.env.OPS_SAFE_QUEUES_EPOCH?.trim()??'',proof=process.env.OPS_SAFE_QUEUES_PROOF?.trim()??'';
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(epoch)||!/^[a-f0-9]{64}$/.test(proof)||
      process.env.SHOPIFY_SHOP_DOMAIN!=='violaleather.myshopify.com'||process.env.ORDER_REFERENCE_PREFIX!=='Viola'||
      process.env.SHIPMENT_CODE_PREFIX!=='VI'||process.env.ODOO_SYNC_ENABLED?.trim().toLowerCase()!=='true') {
    throw new Error('Safe queue release is not configured; financial workers remain held');
  }
  return {epoch,proof};
}
export function safeQueueReleaseRequested(): boolean { return process.env.OPS_SAFE_QUEUES_ENABLED?.trim().toLowerCase()==='true'; }
export function safeQueueHoldReason(): string|undefined {
  try { if(safeQueueConfig())return undefined; }catch{return 'safe-queue-release-invalid';}
  return process.env.OPS_AUTOMATION_HOLD?.trim()||process.env.PRODUCTION_PREVIEW_ONLY?.trim().toLowerCase()==='true'?'operator-reconciliation-hold':undefined;
}
