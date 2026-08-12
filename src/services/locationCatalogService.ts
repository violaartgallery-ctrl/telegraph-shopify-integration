import type { AccurateClient } from '../accurate/accurateClient.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

export interface LocationCatalogArea {
  id: number;
  name: string;
}

export interface LocationCatalogZone {
  id: number;
  name: string;
  subzones: LocationCatalogArea[];
}

export interface LocationCatalogResult {
  locations: LocationCatalogZone[];
  source: 'memory' | 'database' | 'telegraph';
  sourceFetchedAt: string;
  governorates: number;
  areas: number;
}

interface StoredLocationCatalog {
  payloadJson: string;
  sourceFetchedAt: Date;
}

interface SavedLocationCatalog extends StoredLocationCatalog {
  governorateCount: number;
  areaCount: number;
}

export interface LocationCatalogRepository {
  find(): Promise<StoredLocationCatalog | null>;
  save(snapshot: SavedLocationCatalog): Promise<void>;
}

const SNAPSHOT_ID = 'telegraph-egypt';
const MEMORY_TTL_MS = 5 * 60_000;
export const LOCATION_REFRESH_INTERVAL_MS = 6 * 60 * 60_000;
const MIN_GOVERNORATES = 20;
const MIN_AREAS = 100;

const prismaRepository: LocationCatalogRepository = {
  async find() {
    return prisma.locationCatalogSnapshot.findUnique({
      where: { id: SNAPSHOT_ID },
      select: { payloadJson: true, sourceFetchedAt: true }
    });
  },
  async save(snapshot) {
    await prisma.locationCatalogSnapshot.upsert({
      where: { id: SNAPSHOT_ID },
      create: { id: SNAPSHOT_ID, ...snapshot },
      update: snapshot
    });
  }
};

export const validateLocationCatalog = (
  input: unknown
): { locations: LocationCatalogZone[]; governorates: number; areas: number } => {
  if (!Array.isArray(input)) throw new Error('Location catalog is not an array');

  const zoneIds = new Set<number>();
  let areaCount = 0;
  const locations = input.map((raw): LocationCatalogZone => {
    const zone = raw as Partial<LocationCatalogZone>;
    const id = Number(zone.id);
    const name = typeof zone.name === 'string' ? zone.name.trim() : '';
    if (!Number.isSafeInteger(id) || id <= 0 || !name || zoneIds.has(id)) {
      throw new Error('Location catalog contains an invalid governorate');
    }
    zoneIds.add(id);

    const areaIds = new Set<number>();
    const subzones = (Array.isArray(zone.subzones) ? zone.subzones : []).map((rawArea): LocationCatalogArea => {
      const area = rawArea as Partial<LocationCatalogArea>;
      const areaId = Number(area.id);
      const areaName = typeof area.name === 'string' ? area.name.trim() : '';
      if (!Number.isSafeInteger(areaId) || areaId <= 0 || !areaName || areaIds.has(areaId)) {
        throw new Error(`Location catalog contains an invalid area under governorate ${id}`);
      }
      areaIds.add(areaId);
      areaCount += 1;
      return { id: areaId, name: areaName };
    });
    return { id, name, subzones };
  });

  if (locations.length < MIN_GOVERNORATES || areaCount < MIN_AREAS) {
    throw new Error(`Location catalog is incomplete (${locations.length} governorates, ${areaCount} areas)`);
  }
  return { locations, governorates: locations.length, areas: areaCount };
};

export class LocationCatalogService {
  private memorySnapshot?: { expiresAt: number; value: LocationCatalogResult };
  private refreshInFlight?: Promise<LocationCatalogResult>;

  constructor(
    private readonly accurateClient: AccurateClient,
    private readonly repository: LocationCatalogRepository = prismaRepository,
    private readonly now: () => number = Date.now
  ) {}

  async getCatalog(): Promise<LocationCatalogResult> {
    if (this.memorySnapshot && this.memorySnapshot.expiresAt > this.now()) {
      return { ...this.memorySnapshot.value, source: 'memory' };
    }

    try {
      const stored = await this.repository.find();
      if (stored) return this.useStoredSnapshot(stored);
    } catch (error) {
      logger.warn('Could not read the durable Telegraph location snapshot', {
        reason: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      return await this.refreshCatalog();
    } catch (error) {
      // A warm instance can still serve its last valid copy if both Neon and
      // Telegraph have a temporary incident. Checkout itself remains fail-open.
      if (this.memorySnapshot) return { ...this.memorySnapshot.value, source: 'memory' };
      throw error;
    }
  }

  async refreshIfStale(maxAgeMs = LOCATION_REFRESH_INTERVAL_MS): Promise<LocationCatalogResult> {
    try {
      const stored = await this.repository.find();
      if (stored && this.now() - stored.sourceFetchedAt.getTime() < maxAgeMs) {
        return this.useStoredSnapshot(stored);
      }
    } catch (error) {
      logger.warn('Could not check the Telegraph location snapshot age', {
        reason: error instanceof Error ? error.message : String(error)
      });
    }
    return this.refreshCatalog();
  }

  async refreshCatalog(): Promise<LocationCatalogResult> {
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = this.fetchAndStore();
    try {
      return await this.refreshInFlight;
    } finally {
      this.refreshInFlight = undefined;
    }
  }

  private useStoredSnapshot(stored: StoredLocationCatalog): LocationCatalogResult {
    const checked = validateLocationCatalog(JSON.parse(stored.payloadJson));
    const result: LocationCatalogResult = {
      ...checked,
      source: 'database',
      sourceFetchedAt: stored.sourceFetchedAt.toISOString()
    };
    this.remember(result);
    return result;
  }

  private async fetchAndStore(): Promise<LocationCatalogResult> {
    const zones = await this.accurateClient.listZones({ active: true, parentId: null });
    const fresh = await Promise.all(zones.map(async (zone) => ({
      id: zone.id,
      name: zone.name,
      subzones: (await this.accurateClient.listZones({ active: true, parentId: zone.id })).map((area) => ({
        id: area.id,
        name: area.name
      }))
    })));
    const checked = validateLocationCatalog(fresh);
    const sourceFetchedAt = new Date(this.now());

    try {
      await this.repository.save({
        payloadJson: JSON.stringify(checked.locations),
        governorateCount: checked.governorates,
        areaCount: checked.areas,
        sourceFetchedAt
      });
    } catch (error) {
      // Fresh validated data remains safe to serve; the next scheduled refresh
      // will retry persistence without turning this into a checkout outage.
      logger.warn('Could not persist the fresh Telegraph location snapshot', {
        reason: error instanceof Error ? error.message : String(error)
      });
    }

    const result: LocationCatalogResult = {
      ...checked,
      source: 'telegraph',
      sourceFetchedAt: sourceFetchedAt.toISOString()
    };
    this.remember(result);
    return result;
  }

  private remember(value: LocationCatalogResult): void {
    this.memorySnapshot = { expiresAt: this.now() + MEMORY_TTL_MS, value };
  }
}
