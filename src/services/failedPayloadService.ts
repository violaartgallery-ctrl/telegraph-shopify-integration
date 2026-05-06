import { prisma } from '../lib/prisma.js';

export const failedPayloadService = {
  save: async (params: {
    source: string;
    externalId?: string;
    reason: string;
    payload: unknown;
    headers?: unknown;
  }) =>
    await prisma.failedPayload.create({
      data: {
        source: params.source,
        externalId: params.externalId,
        reason: params.reason,
        payloadJson: JSON.stringify(params.payload),
        headersJson: params.headers ? JSON.stringify(params.headers) : null
      }
    })
};
