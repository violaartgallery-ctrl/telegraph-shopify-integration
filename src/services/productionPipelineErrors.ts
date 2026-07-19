export class SoftDeadlineError extends Error {
  constructor(public readonly progress: string) {
    super(progress);
    this.name = 'SoftDeadlineError';
  }
}

export class PermanentProductionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentProductionError';
  }
}

export function isTransientProductionError(error: unknown): boolean {
  if (error instanceof PermanentProductionError) return false;
  const message = String(error);
  return /timeout|timed out|abort|econn|socket|network|fetch failed|http 429|http 5\d\d|temporar|rate.?limit|p1001|p1002|p1008|p1017|connection/i.test(message);
}

export function isOrderDataReviewError(error: unknown): boolean {
  const message = String(error);
  return /missing telegraph|governorate|area selection|no customer phone|no shipping\/billing address|no active line items|not eligible|invalid.*(?:zone|area)|validation/i.test(message);
}
