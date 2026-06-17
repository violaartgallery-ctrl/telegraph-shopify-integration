import { PrismaClient, Prisma } from '@prisma/client';

/**
 * Transient-connection retry wrapper.
 *
 * With Neon scale-to-zero, the compute suspends after inactivity and the first
 * query after a sleep has to wait for it to resume. Most of the time that's just
 * a slightly slower query, but occasionally the initial connection fails before
 * the resume completes (P1001 "can't reach database", P1017 "server closed the
 * connection"). Without a retry, that single request would error.
 *
 * These error classes mean the query almost certainly never executed (the client
 * could not reach the server), so retrying is safe — and our write paths are
 * idempotent anyway (upserts / conditional updates by id). We retry a few times
 * with short backoff, which is plenty for a Neon resume (~1s).
 */
const RETRYABLE_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017']);

function isTransientConnectionError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) return true;
  if (error instanceof Prisma.PrismaClientKnownRequestError) return RETRYABLE_CODES.has(error.code);
  const message = error instanceof Error ? error.message : String(error);
  return /can't reach database|connection terminated|connection closed|ECONNRESET|ETIMEDOUT|server has closed/i.test(message);
}

const RETRY_DELAYS_MS = [250, 750, 1500];

const basePrisma = new PrismaClient();

export const prisma = basePrisma.$extends({
  query: {
    async $allOperations({ args, query }) {
      let lastError: unknown;
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        try {
          return await query(args);
        } catch (error) {
          lastError = error;
          if (attempt < RETRY_DELAYS_MS.length && isTransientConnectionError(error)) {
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
