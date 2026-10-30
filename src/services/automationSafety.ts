/** Available even while Neon is suspended. Never auto-expires: emergency
 * external receipts must be reconciled before ordinary writers are released. */
export function automationHoldReason(): string | undefined {
  return process.env.OPS_AUTOMATION_HOLD?.trim() ? 'operator-reconciliation-hold' : undefined;
}

export class AutomationPausedError extends Error {
  constructor() { super('Automatic work is held pending primary reconciliation'); this.name = 'AutomationPausedError'; }
}

export function assertAutomationReleased(): void {
  if (automationHoldReason()) throw new AutomationPausedError();
}

/** Inspect nested driver errors, but never log connection strings or raw errors. */
export function isDatabaseQuotaError(error: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): boolean => {
    if (depth > 5 || value == null || seen.has(value)) return false;
    if (typeof value === 'string') {
      return /(?:quota|allowance|limit).{0,100}(?:exceeded|exhausted|reached)|(?:exceeded|exhausted|reached).{0,100}(?:quota|allowance|compute time)|compute time quota|payment required/i.test(value);
    }
    if (typeof value !== 'object') return false;
    seen.add(value);
    const record = value as Record<string, unknown>;
    return ['message', 'cause', 'meta', 'database_error', 'error'].some((key) => visit(record[key], depth + 1));
  };
  return visit(error, 0);
}

/** Control ticks contain no order/financial payload. A watchdog can recreate
 * them. Do not use this acknowledgment policy on business-event queues. */
export function opsControlRetry(error: unknown, deliveryCount: number): { afterSeconds: number } | { acknowledge: true } {
  if (error instanceof AutomationPausedError || isDatabaseQuotaError(error) || deliveryCount >= 3) return { acknowledge: true };
  return { afterSeconds: deliveryCount <= 1 ? 300 : 1800 };
}
