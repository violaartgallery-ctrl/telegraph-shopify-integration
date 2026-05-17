/**
 * Test run of syncOpenShipments — shows what would happen
 * Reads from Telegraph API + DB, updates DB if status changed.
 */
import { createAppServices } from '../app.js';

const { shipmentStatusSyncService } = createAppServices();

console.log('Starting sync...');
try {
  const result = await shipmentStatusSyncService.syncOpenShipments();
  console.log('Done:', result);
} catch (e: any) {
  console.error('Error:', e.message);
}
process.exit(0);
