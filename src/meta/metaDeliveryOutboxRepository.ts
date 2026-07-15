import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

export type MetaOutboxStatus = 'pending' | 'processing' | 'retry' | 'sent' | 'dead';

export interface ClaimedMetaDeliveryEvent {
  id: number;
  shipmentRecordId: number;
  shopifyOrderId: string;
  eventId: string;
  eventTime: Date;
  mode: string;
  payloadJson: string;
  payloadHash: string;
  attemptCount: number;
  leaseToken: string;
}

export interface MetaOutboxHealth {
  pending: number;
  processing: number;
  retry: number;
  sent: number;
  dead: number;
  oldestUnsentAt: Date | null;
  observationsByReason: Record<string, number>;
  matchQuality: {
    sampleSize: number;
    averageInternalCoverageScore: number | null;
    grades: Record<string, number>;
  };
}

const safeMessage = (value: string | undefined): string | null =>
  value ? value.replace(/access_token=[^&\s]+/gi, 'access_token=[redacted]').slice(0, 800) : null;

const databaseSchema = (() => {
  try {
    const schema = new URL(process.env.DATABASE_URL ?? '').searchParams.get('schema') ?? 'public';
    return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(schema) ? schema : 'public';
  } catch {
    return 'public';
  }
})();
const outboxTable = Prisma.raw(`"${databaseSchema}"."MetaDeliveryOutbox"`);

export const metaDeliveryOutboxRepository = {
  /**
   * Atomically leases distinct due rows across concurrent Vercel workers.
   * No transaction remains open while the Meta HTTP request is in flight.
   */
  claimDue: async (limit: number, leaseMs: number, mode: 'test' | 'live'): Promise<ClaimedMetaDeliveryEvent[]> => {
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(Date.now() + leaseMs);
    const take = Math.max(1, Math.min(100, Math.trunc(limit)));

    return await prisma.$queryRaw<ClaimedMetaDeliveryEvent[]>(Prisma.sql`
      WITH candidates AS (
        SELECT "id"
        FROM ${outboxTable}
        WHERE (
          "mode" = ${mode}
          AND (
            (
              "status" IN ('pending', 'retry')
              AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW())
            )
            OR (
              "status" = 'processing'
              AND "leaseExpiresAt" IS NOT NULL
              AND "leaseExpiresAt" <= NOW()
            )
          )
        )
        ORDER BY "eventTime" ASC, "id" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${take}
      )
      UPDATE ${outboxTable} AS outbox
      SET
        "status" = 'processing',
        "leaseToken" = ${leaseToken},
        "leaseExpiresAt" = ${leaseExpiresAt},
        "lastAttemptAt" = NOW(),
        "attemptCount" = outbox."attemptCount" + 1,
        "updatedAt" = NOW()
      FROM candidates
      WHERE outbox."id" = candidates."id"
      RETURNING
        outbox."id",
        outbox."shipmentRecordId",
        outbox."shopifyOrderId",
        outbox."eventId",
        outbox."eventTime",
        outbox."mode",
        outbox."payloadJson",
        outbox."payloadHash",
        outbox."attemptCount",
        outbox."leaseToken"
    `);
  },

  markSent: async (row: ClaimedMetaDeliveryEvent, result: {
    httpStatus?: number;
    eventsReceived: number;
    fbtraceId?: string;
  }): Promise<boolean> => {
    const updated = await prisma.metaDeliveryOutbox.updateMany({
      where: { id: row.id, status: 'processing', leaseToken: row.leaseToken },
      data: {
        status: 'sent',
        sentAt: new Date(),
        eventsReceived: result.eventsReceived,
        fbtraceId: result.fbtraceId ?? null,
        lastHttpStatus: result.httpStatus,
        lastErrorCode: null,
        lastError: null,
        nextAttemptAt: null,
        leaseToken: null,
        leaseExpiresAt: null
      }
    });
    return updated.count === 1;
  },

  markRetry: async (row: ClaimedMetaDeliveryEvent, result: {
    retryAt: Date;
    httpStatus?: number;
    errorCode?: string;
    error?: string;
    fbtraceId?: string;
  }): Promise<boolean> => {
    const updated = await prisma.metaDeliveryOutbox.updateMany({
      where: { id: row.id, status: 'processing', leaseToken: row.leaseToken },
      data: {
        status: 'retry',
        nextAttemptAt: result.retryAt,
        lastHttpStatus: result.httpStatus,
        lastErrorCode: result.errorCode?.slice(0, 120) ?? null,
        lastError: safeMessage(result.error),
        fbtraceId: result.fbtraceId ?? null,
        leaseToken: null,
        leaseExpiresAt: null
      }
    });
    return updated.count === 1;
  },

  markDead: async (row: ClaimedMetaDeliveryEvent, result: {
    httpStatus?: number;
    errorCode?: string;
    error: string;
    fbtraceId?: string;
  }): Promise<boolean> => {
    const updated = await prisma.metaDeliveryOutbox.updateMany({
      where: { id: row.id, status: 'processing', leaseToken: row.leaseToken },
      data: {
        status: 'dead',
        nextAttemptAt: null,
        lastHttpStatus: result.httpStatus,
        lastErrorCode: result.errorCode?.slice(0, 120) ?? null,
        lastError: safeMessage(result.error),
        fbtraceId: result.fbtraceId ?? null,
        leaseToken: null,
        leaseExpiresAt: null
      }
    });
    return updated.count === 1;
  },

  findReconciliationCandidateIds: async (
    cutoverAt: Date,
    limit: number,
    mode: 'test' | 'live'
  ): Promise<number[]> => {
    const rows = await prisma.shipmentRecord.findMany({
      where: {
        accurateStatusCode: { equals: 'DTR', mode: 'insensitive' },
        collectionStatus: { equals: 'collected', mode: 'insensitive' },
        deliveredAt: { gte: cutoverAt },
        shopifyCreatedAt: { gte: cutoverAt },
        metaDeliveryEvents: { none: { eventName: 'Delivered', mode } }
      },
      select: { id: true },
      orderBy: { deliveredAt: 'asc' },
      take: Math.max(1, Math.min(500, Math.trunc(limit)))
    });
    return rows.map((row) => row.id);
  },

  getHealth: async (mode: 'test' | 'live'): Promise<MetaOutboxHealth> => {
    const [grouped, oldest, observationGroups, matchRows] = await Promise.all([
      prisma.metaDeliveryOutbox.groupBy({
        by: ['status'],
        where: { mode },
        _count: { _all: true }
      }),
      prisma.metaDeliveryOutbox.findFirst({
        where: { mode, status: { in: ['pending', 'processing', 'retry'] } },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' }
      }),
      prisma.shipmentRecord.groupBy({
        by: ['metaDeliveryLastReason'],
        where: { metaDeliveryLastMode: mode, metaDeliveryLastReason: { not: null } },
        _count: { _all: true }
      }),
      prisma.metaDeliveryOutbox.findMany({
        where: { mode, matchQualityJson: { not: null } },
        select: { matchQualityJson: true },
        orderBy: { createdAt: 'desc' },
        take: 200
      })
    ]);
    const counts = Object.fromEntries(grouped.map((row) => [row.status, row._count._all]));
    const observationsByReason = Object.fromEntries(
      observationGroups.flatMap((row) => row.metaDeliveryLastReason
        ? [[row.metaDeliveryLastReason, row._count._all] as const]
        : [])
    );
    const parsedMatchRows = matchRows.flatMap((row) => {
      try {
        const parsed: unknown = JSON.parse(row.matchQualityJson!);
        if (!parsed || typeof parsed !== 'object') return [];
        const value = parsed as Record<string, unknown>;
        const score = typeof value.internalCoverageScore === 'number' ? value.internalCoverageScore : undefined;
        const grade = typeof value.grade === 'string' ? value.grade : undefined;
        return score !== undefined && grade ? [{ score, grade }] : [];
      } catch {
        return [];
      }
    });
    const matchGrades: Record<string, number> = {};
    for (const row of parsedMatchRows) matchGrades[row.grade] = (matchGrades[row.grade] ?? 0) + 1;
    return {
      pending: counts.pending ?? 0,
      processing: counts.processing ?? 0,
      retry: counts.retry ?? 0,
      sent: counts.sent ?? 0,
      dead: counts.dead ?? 0,
      oldestUnsentAt: oldest?.createdAt ?? null,
      observationsByReason,
      matchQuality: {
        sampleSize: parsedMatchRows.length,
        averageInternalCoverageScore: parsedMatchRows.length > 0
          ? Math.round(parsedMatchRows.reduce((sum, row) => sum + row.score, 0) / parsedMatchRows.length)
          : null,
        grades: matchGrades
      }
    };
  }
};
