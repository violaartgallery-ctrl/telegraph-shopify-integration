import assert from 'node:assert/strict';
import type { AccurateClient } from '../accurate/accurateClient.js';
import { LocationCatalogService, type LocationCatalogRepository } from '../services/locationCatalogService.js';
import { AutomationPausedError } from '../services/automationSafety.js';

// Only injected memory fakes: the real repository and carrier are never used.
const catalog = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `Zone ${i + 1}`,
  subzones: Array.from({ length: 5 }, (_, j) => ({ id: (i + 1) * 1000 + j + 1, name: `Area ${j + 1}` })) }));
let checks = 0;
function fixture(stored = true) {
  let now = 1_800_000_000_000, hold: string | undefined = 'operator-reconciliation-hold';
  let carrierCalls = 0, saves = 0, reads = 0;
  const repository: LocationCatalogRepository = {
    async find() { reads++; return stored ? { payloadJson: JSON.stringify(catalog), sourceFetchedAt: new Date(0) } : null; },
    async save() { saves++; throw new Error('No persistence expected in held tests'); }
  };
  const carrier = { async listZones(input: { parentId: number | null }) {
    carrierCalls++; return input.parentId === null ? catalog : catalog.find(x => x.id === input.parentId)?.subzones ?? [];
  } } as unknown as AccurateClient;
  return { service: new LocationCatalogService(carrier, repository, () => now, () => hold),
    setHold: (v: string | undefined) => { hold = v; }, advance: () => { now += 10 * 60_000; },
    counts: () => ({ carrierCalls, saves, reads }) };
}
{
  const f = fixture();
  assert.equal((await f.service.getCatalog()).source, 'database'); checks++;
  f.advance();
  assert.equal((await f.service.getCatalog()).source, 'memory'); checks++;
  await f.service.refreshIfStale(0); await f.service.refreshCatalog();
  assert.deepEqual(f.counts(), { carrierCalls: 0, saves: 0, reads: 1 }); checks++;
}
{
  const f = fixture(false);
  for (const read of [() => f.service.getCatalog(), () => f.service.refreshIfStale(0), () => f.service.refreshCatalog()]) {
    await assert.rejects(read, AutomationPausedError); checks++;
  }
  assert.deepEqual(f.counts(), { carrierCalls: 0, saves: 0, reads: 3 }); checks++;
}
{
  let hold: string | undefined, saves = 0;
  const carrier = { async listZones(input: { parentId: number | null }) {
    if (input.parentId === null) return catalog;
    hold = 'raised-during-carrier-fetch'; return catalog.find(x => x.id === input.parentId)?.subzones ?? [];
  } } as unknown as AccurateClient;
  const repository: LocationCatalogRepository = { async find() { return null; }, async save() { saves++; } };
  const service = new LocationCatalogService(carrier, repository, Date.now, () => hold);
  await assert.rejects(() => service.refreshCatalog(), AutomationPausedError); checks++;
  assert.equal(saves, 0); checks++;
}
console.log(`Location hold readiness: ${checks} checks passed; zero live I/O`);
