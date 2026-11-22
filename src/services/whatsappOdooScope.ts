import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Write authority for the WhatsApp-only Odoo bridge.
 *
 * WhatsApp orders have no Shopify order or ShipmentRecord, so they cannot use
 * the record-keyed context in automaticOperationSafety. The Odoo transport hook
 * (beforeAutomaticOdooWrite) delegates to this context instead, keeping the
 * same guarantees: no Odoo write without a durable claim, the first write is
 * recorded before it is sent, and an unknown outcome halts the operation.
 *
 * This module has no imports on purpose, so the safety module can depend on it
 * without an import cycle.
 */
export interface WhatsappOdooWriteContext {
  readonly linkId: number;
  readonly key: string;
  halted?: string;
  closed: boolean;
  beforeWrite(model: string, method: string): Promise<void>;
}

export const whatsappOdooScope = new AsyncLocalStorage<WhatsappOdooWriteContext>();

export function currentWhatsappOdooContext(): WhatsappOdooWriteContext | undefined {
  return whatsappOdooScope.getStore();
}
