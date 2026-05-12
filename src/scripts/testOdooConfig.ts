import { OdooClient } from '../odoo/odooClient.js';
import { OdooSyncService } from '../odoo/odooSyncService.js';

const service = new OdooSyncService(new OdooClient());

try {
  const connection = await service.checkConnection();
  console.log(`Odoo login ok. uid=${connection.uid}`);

  const journals = await service.listPaymentJournals();
  console.log('Available Odoo payment journals:');
  for (const journal of journals) {
    console.log(`- ${journal.id}: ${journal.name ?? 'Unnamed'} (${journal.type ?? 'unknown'}${journal.code ? `, ${journal.code}` : ''})`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
