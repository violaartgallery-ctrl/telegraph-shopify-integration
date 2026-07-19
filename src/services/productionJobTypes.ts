/** Shared types for the resumable production-job pipeline. */

export interface ShipResult {
  orderName: string;
  ok: boolean;
  reason?: string;
  category?: 'shipped' | 'skipped' | 'needs_review';
}
