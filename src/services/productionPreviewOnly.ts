import { assertAutomationReleased, AutomationPausedError } from './automationSafety.js';
import { assertManualShipmentBindings, type ManualShipmentBinding } from './manualShipmentBinding.js';

/** Temporary, explicit allowlisted Preview release. This NEVER releases the
 * global accounting/shipping hold, and old jobs cannot inherit its permission. */
export interface PreviewOnlyConfig {
  ownerChatId: number;
  allowedChatIds: number[];
  recipientChatIds: string[];
  epoch: string;
  notBefore: number;
  minUpdateId: number;
}

export function previewOnlyConfig(): PreviewOnlyConfig | undefined {
  if (process.env.PRODUCTION_PREVIEW_ONLY?.trim().toLowerCase() !== 'true') return undefined;
  const ownerChatId = Number(process.env.PRODUCTION_PREVIEW_OWNER_CHAT_ID);
  const epoch = process.env.PRODUCTION_PREVIEW_EPOCH?.trim() ?? '';
  const notBefore = Number(process.env.PRODUCTION_PREVIEW_NOT_BEFORE);
  const rawMinUpdateId = process.env.PRODUCTION_PREVIEW_MIN_UPDATE_ID?.trim() ?? '';
  const minUpdateId = Number(rawMinUpdateId);
  const parseIds = (key: string): string[] => {
    const value = process.env[key];
    const ids = value === undefined ? [String(ownerChatId)] : value.split(',').map(id => id.trim());
    if (ids.length < 1 || ids.length > 2 || new Set(ids).size !== ids.length ||
        ids.some(id => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) ||
        !ids.includes(String(ownerChatId))) {
      throw new Error('Owner-only Preview release is not configured safely');
    }
    return ids;
  };
  const allowedIds = parseIds('PRODUCTION_PREVIEW_ALLOWED_CHAT_IDS');
  const recipientChatIds = parseIds('PRODUCTION_PREVIEW_RECIPIENT_CHAT_IDS');
  if (!Number.isSafeInteger(ownerChatId) || ownerChatId <= 0 ||
      !/^[A-Za-z0-9_-]{16,80}$/.test(epoch) ||
      !Number.isSafeInteger(notBefore) || notBefore <= 0 ||
      !/^\d+$/.test(rawMinUpdateId) || !Number.isSafeInteger(minUpdateId) || minUpdateId < 0 ||
      allowedIds.length !== recipientChatIds.length || recipientChatIds.some(id => !allowedIds.includes(id))) {
    throw new Error('Owner-only Preview release is not configured safely');
  }
  return { ownerChatId, allowedChatIds: allowedIds.map(Number), recipientChatIds, epoch, notBefore, minUpdateId };
}

export function isPreviewOperator(chatId: number, config = previewOnlyConfig()): boolean {
  return Boolean(config && Number.isSafeInteger(chatId) && config.allowedChatIds.includes(chatId));
}

export function previewRecipientsMatch(values: unknown[], config: PreviewOnlyConfig): boolean {
  return values.length === config.recipientChatIds.length && new Set(values).size === values.length &&
    values.every(value => typeof value === 'string' && config.recipientChatIds.includes(value));
}

export function previewOnlyRequested(): boolean {
  return process.env.PRODUCTION_PREVIEW_ONLY?.trim().toLowerCase() === 'true';
}

export interface ManualRunConfig { epoch: string; notBefore: number; minUpdateId: number }
export function manualRunConfig(): ManualRunConfig | undefined {
  if (process.env.PRODUCTION_MANUAL_RUN_ENABLED?.trim().toLowerCase() !== 'true') return undefined;
  const preview = previewOnlyConfig();
  const epoch = process.env.PRODUCTION_MANUAL_RUN_EPOCH?.trim() ?? '';
  const rawDate = process.env.PRODUCTION_MANUAL_RUN_NOT_BEFORE?.trim() ?? '';
  const rawUpdate = process.env.PRODUCTION_MANUAL_RUN_MIN_UPDATE_ID?.trim() ?? '';
  const notBefore = Number(rawDate), minUpdateId = Number(rawUpdate);
  if (!preview || preview.allowedChatIds.length !== 2 || preview.recipientChatIds.length !== 2 ||
      !/^[A-Za-z0-9_-]{16,80}$/.test(epoch) || epoch === preview.epoch ||
      !/^\d+$/.test(rawDate) || !Number.isSafeInteger(notBefore) || notBefore <= 0 ||
      !/^\d+$/.test(rawUpdate) || !Number.isSafeInteger(minUpdateId) || minUpdateId < 0) {
    throw new Error('Manual Run release is not configured safely');
  }
  return { epoch, notBefore, minUpdateId };
}

export interface ManualRunCursorProof {
  kind: string; batchId: string; pendingRun: boolean; previewOnlyEpoch?: string; recipientChatIds: string[];
  orderNumbers?: string[]; sourceFingerprint?: string; previewReadyAt?: number;
  manualShipmentBindings?: ManualShipmentBinding[]; manualShipmentBindingHash?: string;
  manualRunEpoch?: string; manualRunApprovedBy?: number; manualRunApprovedUpdateId?: number;
  manualRunMessageDate?: number; manualRunApprovedAt?: number; manualRunApprovedBatchId?: string;
  manualRunApprovalBindingHash?: string;
  manualRunApprovalSourceFingerprint?: string;
}

export function assertManualRunCursor(chatId: number, cursor: ManualRunCursorProof): void {
  const preview = previewOnlyConfig(), run = manualRunConfig();
  if (!preview || !run || !isPreviewOperator(chatId, preview) || cursor.kind !== 'run' || cursor.pendingRun ||
      cursor.previewOnlyEpoch !== preview.epoch || !previewRecipientsMatch(cursor.recipientChatIds, preview) ||
      cursor.manualRunEpoch !== run.epoch || cursor.manualRunApprovedBy !== chatId ||
      cursor.manualRunApprovedBatchId !== cursor.batchId ||
      !Number.isSafeInteger(cursor.manualRunApprovedUpdateId) || Number(cursor.manualRunApprovedUpdateId) <= Math.max(run.minUpdateId, preview.minUpdateId) ||
      !Number.isSafeInteger(cursor.previewReadyAt) || Number(cursor.previewReadyAt) <= 0 ||
      !Number.isSafeInteger(cursor.manualRunMessageDate) || Number(cursor.manualRunMessageDate) < Math.max(run.notBefore, preview.notBefore, Number(cursor.previewReadyAt)) ||
      !Number.isSafeInteger(cursor.manualRunApprovedAt) || Number(cursor.manualRunApprovedAt) <= 0 ||
      !/^[a-f0-9]{64}$/.test(cursor.sourceFingerprint ?? '') ||
      cursor.manualRunApprovalBindingHash !== cursor.manualShipmentBindingHash ||
      cursor.manualRunApprovalSourceFingerprint !== cursor.sourceFingerprint) throw new AutomationPausedError();
  try { assertManualShipmentBindings({ ...cursor, orderNumbers: cursor.orderNumbers ?? [] }); }
  catch { throw new AutomationPausedError(); }
}

export function isFreshOwnerPreviewMessage(input: {
  chatId: number; fromId?: number; date?: number; updateId: number;
}, config = previewOnlyConfig()): boolean {
  return Boolean(config && isPreviewOperator(input.chatId, config) &&
    input.fromId === input.chatId &&
    Number.isSafeInteger(input.date) && Number(input.date) >= config.notBefore &&
    Number.isSafeInteger(input.updateId) && input.updateId > config.minUpdateId);
}

export function assertPreviewCursorInMode(chatId: number, cursor: ManualRunCursorProof): void {
  const config = previewOnlyConfig();
  if (!config) return;
  if (cursor.kind === 'run') { assertManualRunCursor(chatId, cursor); return; }
  if (!isPreviewOperator(chatId, config) || cursor.kind !== 'preview' || cursor.pendingRun ||
      cursor.previewOnlyEpoch !== config.epoch || !previewRecipientsMatch(cursor.recipientChatIds, config)) {
    throw new AutomationPausedError();
  }
}

export function assertProductionRunAllowed(context?: { chatId: number; cursor: ManualRunCursorProof }): void {
  manualRunConfig(); // A manual flag without valid containment cannot grant a normal Run.
  if (previewOnlyRequested()) {
    if (!context) throw new AutomationPausedError();
    assertManualRunCursor(context.chatId, context.cursor); return;
  }
  assertAutomationReleased();
}

/** Only current-epoch Preview or explicitly approved manual Run may use the
 * dedicated topic. Old jobs and globally held workers gain no permission. */
export async function assertProductionInvocationAllowed(chatId: number, batchId?: string): Promise<void> {
  manualRunConfig();
  const config = previewOnlyConfig();
  if (!config) { assertAutomationReleased(); return; }
  if (!isPreviewOperator(chatId, config) || !batchId) throw new AutomationPausedError();
  const { loadJob } = await import('./productionJobStore.js');
  const cursor = await loadJob(chatId);
  if (!cursor || cursor.batchId !== batchId) throw new AutomationPausedError();
  assertPreviewCursorInMode(chatId, cursor);
}

export const PREVIEW_ONLY_TOPIC = 'viola-owner-preview-20261101';
