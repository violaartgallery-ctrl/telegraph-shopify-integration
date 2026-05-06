import { logger } from './logger.js';

const sleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, ms));

export const retry = async <T>(
  fn: () => Promise<T>,
  shouldRetry: (error: unknown) => boolean,
  attempts = 3,
  delayMs = 400
): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error) || attempt === attempts) {
        throw error;
      }
      logger.warn('Retrying transient operation', { attempt, error });
      await sleep(delayMs * attempt);
    }
  }
  throw lastError;
};
