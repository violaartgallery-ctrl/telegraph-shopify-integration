/**
 * Quick Telegraph API auth test + shipment lookup for #1946/#1947
 */
import { AccurateClient } from '../accurate/accurateClient.js';

const client = new AccurateClient();

// Test using the real getShipment method
const tests = [
  { id: 8946227, code: 'VI0000376', order: '#1947' },
  { id: 8969511, code: 'VI0000399', order: '#1946' },
];

for (const t of tests) {
  try {
    const shipment = await client.getShipment({ id: t.id });
    console.log(`✅ ${t.order} (${t.code}): status=${JSON.stringify(shipment?.status)}`);
  } catch (e: any) {
    console.log(`❌ ${t.order} (${t.code}): ${e.name}: ${e.message}`);
    if (e.details) console.log('   details:', JSON.stringify(e.details));
  }
}
