import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { AccurateClient } from './accurateClient.js';

const normalize = (value?: string | null): string =>
  (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

export interface ResolvedZone {
  zoneId: number;
  subzoneId: number;
  resolution: 'attribute' | 'lookup' | 'default';
}

export class AccurateZoneResolver {
  constructor(private readonly accurateClient: AccurateClient) {}

  async resolve(input: {
    zoneId?: number;
    subzoneId?: number;
    city?: string | null;
    area?: string | null;
    province?: string | null;
  }): Promise<ResolvedZone> {
    if (input.zoneId && input.subzoneId) {
      return {
        zoneId: input.zoneId,
        subzoneId: input.subzoneId,
        resolution: 'attribute'
      };
    }

    const serviceId = env.accurate.defaultServiceId;
    if (!serviceId) {
      if (env.accurate.defaultRecipientZoneId && env.accurate.defaultRecipientSubzoneId) {
        return {
          zoneId: env.accurate.defaultRecipientZoneId,
          subzoneId: env.accurate.defaultRecipientSubzoneId,
          resolution: 'default'
        };
      }
      throw new Error('ACCURATE_DEFAULT_SERVICE_ID is required to resolve recipient zones');
    }

    const searchTerms = [input.city, input.area, input.province]
      .map(normalize)
      .filter(Boolean);

    if (searchTerms.length > 0) {
      for (const term of searchTerms) {
        const zones = await this.accurateClient.listZones({
          branchId: env.accurate.defaultBranchId,
          active: true,
          name: term,
          service: {
            serviceId,
            fromZoneId: env.accurate.senderZoneId,
            fromSubzoneId: env.accurate.senderSubzoneId
          }
        });

        const zone = zones.find((entry) => normalize(entry.name) === term) ?? zones[0];
        if (!zone) continue;

        const subzones = await this.accurateClient.listZones({
          branchId: env.accurate.defaultBranchId,
          active: true,
          parentId: zone.id,
          service: {
            serviceId,
            fromZoneId: env.accurate.senderZoneId,
            fromSubzoneId: env.accurate.senderSubzoneId
          }
        });

        const subzoneMatch =
          subzones.find((entry) => normalize(entry.name) === normalize(input.area)) ??
          subzones.find((entry) => normalize(entry.name) === normalize(input.city)) ??
          subzones[0];

        if (subzoneMatch) {
          return {
            zoneId: zone.id,
            subzoneId: subzoneMatch.id,
            resolution: 'lookup'
          };
        }
      }
    }

    // IMPORTANT: do NOT silently fall back to the default recipient zone here.
    // The configured default equals the SENDER zone (الاسكندرية/السيوف), so a
    // silent fallback ships the parcel to the wrong place under the sender's own
    // address. Failing loudly flags the order for manual review instead. An
    // explicit governorate/area selection (resolution: 'attribute') is the only
    // reliable input; this branch is only reached when that is missing AND the
    // address could not be matched.
    logger.warn('Could not resolve recipient zone — refusing to ship (no governorate, no address match)', input);
    throw new Error('Could not resolve recipient governorate/area — order needs an explicit Telegraph governorate/area selection (will NOT ship to the default sender zone)');
  }
}
