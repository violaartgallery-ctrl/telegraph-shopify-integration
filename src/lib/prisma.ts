import { PrismaClient, Prisma } from '@prisma/client';
import { isDatabaseQuotaError } from '../services/automationSafety.js';

/**
 * Transient-connection retry wrapper.
 *
 * With Neon scale-to-zero, the compute suspends after inactivity and the first
 * query after a sleep has to wait for it to resume. Most of the time that's just
 * a slightly slower query, but occasionally the initial connection fails before
 * the resume completes (P1001 "can't reach database", P1017 "server closed the
 * connection"). Without a retry, that single request would error.
 *
 * A timeout or lost connection can occur AFTER a write committed. Only known
 * Prisma model reads may be retried; writes and all raw/unknown operations must
 * surface their original error for outcome reconciliation by the caller.
 * Raw queries are excluded even if named $queryRaw: SQL can have side effects.
 */
const RETRYABLE_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);

function isTransientConnectionError(error: unknown): boolean {
  if (isDatabaseQuotaError(error)) return false;
  if (error instanceof Prisma.PrismaClientInitializationError) return true;
  if (error instanceof Prisma.PrismaClientKnownRequestError) return RETRYABLE_CODES.has(error.code);
  const message = error instanceof Error ? error.message : String(error);
  return /can't reach database|connection terminated|connection closed|ECONNRESET|ETIMEDOUT|server has closed/i.test(message);
}

const RETRY_DELAYS_MS = [250, 750, 1500];
const READ_ONLY_OPERATIONS = new Set([
  'findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow',
  'findMany', 'count', 'aggregate', 'groupBy',
]);

export const basePrisma = new PrismaClient({
  transactionOptions: {
    maxWait: 15_000,
    timeout: 20_000,
  },
});

export const prisma = basePrisma.$extends({
  query: {
    async $allOperations({ model, operation, args, query }) {
      const retryRead = typeof model === 'string' && model.length > 0
        && READ_ONLY_OPERATIONS.has(operation);
      let lastError: unknown;
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        try {
          return await query(args);
        } catch (error) {
          lastError = error;
          if (retryRead && attempt < RETRY_DELAYS_MS.length && isTransientConnectionError(error)) {
            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
            continue;
          }
          throw error;
        }
      }
      throw lastError;
    }
  }
});
