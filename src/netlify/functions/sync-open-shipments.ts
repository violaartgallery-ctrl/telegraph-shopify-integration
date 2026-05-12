import { createAppServices } from '../../app.js';
import { logger } from '../../lib/logger.js';

export const handler = async () => {
  const { shipmentStatusSyncService } = createAppServices();

  try {
    const result = await shipmentStatusSyncService.syncOpenShipments();
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, ...result })
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown scheduled sync error';
    logger.error('Netlify scheduled shipment sync failed', { reason: message });
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, message })
    };
  }
};
