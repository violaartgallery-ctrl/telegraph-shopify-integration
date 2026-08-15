export const STATUS_POLL_RETRY_PREFIX = 'STATUS_POLL_RETRY:';
export const STATUS_POLL_QUARANTINE_PREFIX = 'STATUS_POLL_QUARANTINED:';

export const isStatusPollingQuarantined = (lastError?: string | null): boolean =>
  lastError?.startsWith(STATUS_POLL_QUARANTINE_PREFIX) ?? false;

export const isStatusPollingDiagnostic = (lastError?: string | null): boolean =>
  lastError?.startsWith(STATUS_POLL_RETRY_PREFIX) === true ||
  isStatusPollingQuarantined(lastError);

const compactReason = (reason: string): string =>
  reason.replace(/\s+/g, ' ').trim().slice(0, 1_800);

export const buildStatusPollingRetryReason = (reason: string): string =>
  `${STATUS_POLL_RETRY_PREFIX} ${compactReason(reason)}`;

export const buildStatusPollingQuarantineReason = (reason: string): string =>
  `${STATUS_POLL_QUARANTINE_PREFIX} ${compactReason(reason)}`;

export const isOlderThanStatusPollingCutoff = (
  createdAt: Date,
  shopifyCreatedAt: Date | null,
  cutoff: Date
): boolean => (shopifyCreatedAt ?? createdAt) < cutoff;
