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

    if (env.accurate.defaultRecipientZoneId && env.accurate.defaultRecipientSubzoneId) {
      logger.warn('Falling back to default Accurate recipient zone config', input);
      return {
        zoneId: env.accurate.defaultRecipientZoneId,
        subzoneId: env.accurate.defaultRecipientSubzoneId,
        resolution: 'default'
      };
    }

    throw new Error('Could not resolve Accurate recipient zone/subzone and no defaults are configured');
  }
}
