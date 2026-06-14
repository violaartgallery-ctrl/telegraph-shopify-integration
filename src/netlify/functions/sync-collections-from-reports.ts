/**
 * Netlify scheduled function — PERMANENT FIX (C).
 *
 * Detects collected shipments via the working `listShipments` API (the account
 * is unauthorized for `getShipment`, which is why the old status-poll missed
 * collections). For each delivered+collected shipment with no Odoo invoice/payment,
 * it creates the Odoo invoice+payment and marks the Shopify order paid.
 *
 * Runs every 15 minutes, time-budgeted to stay within Netlify's function limit.
 */
import { createAppServices } from '../../app.js';
import { logger } from '../../lib/logger.js';

export const handler = async () => {
  const { shipmentStatusSyncService } = createAppServices();
  try {
    const result = await shipmentStatusSyncService.syncCollectionsFromReports({ maxActions: 6, budgetMs: 23_000 });
    logger.info('sync-collections-from-reports: done', result);
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown collection-report sync error';
    logger.error('sync-collections-from-reports failed', { reason: message });
    return { statusCode: 500, body: JSON.stringify({ ok: false, message }) };
  }
};
