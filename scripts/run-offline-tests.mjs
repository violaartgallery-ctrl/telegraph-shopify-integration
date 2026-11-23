// Runs the self-tests that need no database or provider, with dummy credentials
// and every non-loopback fetch blocked. Used locally (npm run test:offline) and in CI.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const guard = pathToFileURL(join(root, 'scripts', 'offline-fetch-guard.mjs')).href;

const tests = [
  'src/scripts/testLocationCatalog.ts',
  'src/scripts/testOdooSaleReturnAutomation.ts',
  'src/scripts/testOpsScheduler.ts',
  'src/scripts/testPrintSheetFormats.ts',
  'src/scripts/testProductionContinuationQueue.ts',
  'src/scripts/testRecipientPhoneMapping.ts',
  'src/scripts/testShopifyLinePriceMapping.ts',
  'src/scripts/testStatusPollingAutomation.ts',
  'src/scripts/testTelegraphScenarioMatrix.ts',
  'src/scripts/testWaybillShipmentFields.ts',
  'src/scripts/testMetaDeliveredScenarioMatrix.ts',
  'src/meta/metaCapiClient.selfTest.ts',
  'src/scripts/testFinancialQueueAutomation.ts',
  'src/scripts/testShipmentRefusalShippingNote.ts',
  'src/scripts/testAdminAuth.ts',
  // Picked up automatically once their pull requests are merged.
  'src/scripts/testAccurateWebhookAuth.ts',
  'src/scripts/testTelegramWebhookAuth.ts'
].filter((file) => existsSync(join(root, file)));

// Blank every documented variable first: dotenv never overrides a variable that
// is already set, so a developer's real .env cannot leak into an offline run.
const documented = readFileSync(join(root, '.env.example'), 'utf8')
  .split(/\r?\n/)
  .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
  .filter(Boolean);
const env = {
  ...process.env,
  ...Object.fromEntries(documented.map((name) => [name, ''])),
  DATABASE_URL: 'postgresql://offline:offline@127.0.0.1:1/offline',
  DIRECT_URL: 'postgresql://offline:offline@127.0.0.1:1/offline',
  SHOPIFY_SHOP_DOMAIN: 'offline-test.myshopify.com',
  SHOPIFY_CLIENT_ID: 'offline',
  SHOPIFY_CLIENT_SECRET: 'offline-secret',
  SHOPIFY_WEBHOOK_SECRET: 'offline-webhook-secret',
  ACCURATE_GRAPHQL_ENDPOINT: 'http://127.0.0.1:1/graphql',
  ACCURATE_USERNAME: 'offline',
  ACCURATE_PASSWORD: 'offline',
  ACCURATE_DEFAULT_SHIPMENT_TYPE: 'FDP',
  ACCURATE_DEFAULT_PAYMENT_TYPE: 'COLC',
  ODOO_SYNC_ENABLED: 'false',
  META_DELIVERED_ENABLED: 'false',
  TELEGRAPH_ENABLED: 'false'
};

const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const failures = [];
for (const file of tests) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [tsx, '--import', guard, file], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 180_000
  });
  const ok = result.status === 0;
  const tail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-6).join('\n');
  console.log(`${ok ? 'PASS' : 'FAIL'} ${file} (${Date.now() - started} ms)`);
  if (!ok) {
    console.log(tail);
    failures.push(file);
  }
}

console.log(`\n${tests.length - failures.length}/${tests.length} offline test files passed`);
process.exit(failures.length ? 1 : 0);
