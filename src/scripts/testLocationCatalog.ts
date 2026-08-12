import assert from 'node:assert/strict';
import type { AccurateClient } from '../accurate/accurateClient.js';
import {
  LocationCatalogService,
  type LocationCatalogRepository,
  validateLocationCatalog
} from '../services/locationCatalogService.js';

const buildCatalog = () => Array.from({ length: 20 }, (_, governorateIndex) => {
  const id = governorateIndex + 1;
  return {
    id,
    name: `Governorate ${id}`,
    subzones: Array.from({ length: 5 }, (_, areaIndex) => ({
      id: id * 1_000 + areaIndex + 1,
      name: `Area ${id}-${areaIndex + 1}`
    }))
  };
});

type Snapshot = {
  payloadJson: string;
  sourceFetchedAt: Date;
  governorateCount?: number;
  areaCount?: number;
};

class FakeRepository implements LocationCatalogRepository {
  findCalls = 0;
  saveCalls = 0;

  constructor(public snapshot: Snapshot | null) {}

  async find() {
    this.findCalls += 1;
    if (!this.snapshot) return null;
    return {
      payloadJson: this.snapshot.payloadJson,
      sourceFetchedAt: this.snapshot.sourceFetchedAt
    };
  }

  async save(snapshot: Required<Snapshot>) {
    this.saveCalls += 1;
    this.snapshot = snapshot;
  }
}

const createCarrier = (catalog = buildCatalog()) => {
  let calls = 0;
  const client = {
    async listZones(input: { parentId: number | null }) {
      calls += 1;
      if (input.parentId === null) {
        return catalog.map(({ id, name }) => ({ id, name }));
      }
      return catalog.find(({ id }) => id === input.parentId)?.subzones ?? [];
    }
  } as unknown as AccurateClient;
  return { client, calls: () => calls };
};

const catalog = buildCatalog();
const now = Date.parse('2026-08-12T12:00:00.000Z');

assert.throws(
  () => validateLocationCatalog(catalog.slice(0, 2)),
  /incomplete/,
  'An incomplete carrier response must never replace the valid snapshot'
);

{
  const repository = new FakeRepository({
    payloadJson: JSON.stringify(catalog),
    sourceFetchedAt: new Date(now - 60_000)
  });
  const carrier = createCarrier();
  const service = new LocationCatalogService(carrier.client, repository, () => now);

  const first = await service.getCatalog();
  const second = await service.getCatalog();
  assert.equal(first.source, 'database');
  assert.equal(second.source, 'memory');
  assert.equal(first.governorates, 20);
  assert.equal(first.areas, 100);
  assert.equal(repository.findCalls, 1);
  assert.equal(carrier.calls(), 0, 'Normal storefront reads must not call Telegraph');
}

{
  const repository = new FakeRepository(null);
  const carrier = createCarrier();
  const service = new LocationCatalogService(carrier.client, repository, () => now);

  const results = await Promise.all([
    service.getCatalog(),
    service.getCatalog(),
    service.getCatalog()
  ]);
  assert.ok(results.every((result) => result.source === 'telegraph'));
  assert.equal(carrier.calls(), 21, 'Concurrent cold reads must share one carrier refresh');
  assert.equal(repository.saveCalls, 1);
}

{
  const repository = new FakeRepository({
    payloadJson: JSON.stringify(catalog),
    sourceFetchedAt: new Date(now - 60_000)
  });
  const carrier = createCarrier();
  const service = new LocationCatalogService(carrier.client, repository, () => now);

  const result = await service.refreshIfStale(6 * 60 * 60_000);
  assert.equal(result.source, 'database');
  assert.equal(carrier.calls(), 0, 'The scheduler must not hammer Telegraph while the snapshot is fresh');
}

{
  const repository = new FakeRepository({
    payloadJson: JSON.stringify(catalog),
    sourceFetchedAt: new Date(now - 7 * 60 * 60_000)
  });
  const carrier = createCarrier();
  const service = new LocationCatalogService(carrier.client, repository, () => now);

  const result = await service.refreshIfStale(6 * 60 * 60_000);
  assert.equal(result.source, 'telegraph');
  assert.equal(carrier.calls(), 21);
  assert.equal(repository.saveCalls, 1);
}

console.log('Location catalog tests passed');
