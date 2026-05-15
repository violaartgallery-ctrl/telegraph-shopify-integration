/**
 * WARNING: This script performs REAL Odoo API calls and DB writes.
 * It is NOT a dry-run. It will immediately process any pending queue records.
 * Use only when you intentionally want to trigger queue processing locally.
 *
 * Usage:
 *   npx tsx src/scripts/processOdooQueueOnce.ts
 *
 * What it does:
 *   - Fetches up to 2 records from the Odoo queue (odoo-so-pending,
 *     odoo-stock-pending, odoo-delivery-pending, odoo-failed-retryable)
 *   - Runs one stage per record (same logic as the cron function)
 *   - Writes results to Odoo and DB immediately
 *
 * To see what is in the queue WITHOUT processing, query the DB directly:
 *   SELECT id, "shopifyOrderName", "odooSyncStatus", "odooAttemptCount", "odooRetryAt"
 *   FROM "ShipmentRecord"
 *   WHERE "odooSyncStatus" IN (
 *     'odoo-so-pending','odoo-stock-pending','odoo-delivery-pending','odoo-failed-retryable'
 *   );
 */

import { handler } from '../netlify/functions/process-odoo-queue.js';

console.log('[processOdooQueueOnce] Starting — this will write to Odoo and DB.');

handler()
  .then((result) => {
    console.log('[processOdooQueueOnce] Done.');
    console.log(JSON.stringify(JSON.parse(result.body), null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error('[processOdooQueueOnce] Unexpected error:', err);
    process.exit(1);
  });
