import { QueueClient } from '@vercel/queue';
// @ts-expect-error dist exists after build.
import { assertProductionInvocationAllowed, previewOnlyConfig } from '../dist/services/productionPreviewOnly.js';
// @ts-expect-error dist exists after build.
import { AutomationPausedError, isDatabaseQuotaError } from '../dist/services/automationSafety.js';
// @ts-expect-error dist exists after build.
import { parseProductionResumePayload } from '../dist/services/productionContinuation.js';

class InvalidOwnerPreviewError extends Error {}
const queue = new QueueClient();
export default queue.handleNodeCallback(async (message: unknown) => {
  if (!previewOnlyConfig()) throw new InvalidOwnerPreviewError('Owner Preview mode is not active');
  const payload = parseProductionResumePayload(message);
  if (!payload) throw new InvalidOwnerPreviewError('Invalid owner Preview payload');
  await assertProductionInvocationAllowed(payload.chatId, payload.batchId);
  // This same isolated transport may continue a strictly approved manual Run.
  // Authorization is loaded from Neon above, never trusted from the message.
  // No normal shipping/financial worker or old production topic is released.
  // @ts-expect-error dist exists after build.
  const { resumeProductionInvocation } = await import('../dist/netlify/functions/run-production-background.js');
  await resumeProductionInvocation(payload.chatId, payload.batchId);
}, {
  visibilityTimeoutSeconds: 300,
  retry: (error, metadata) => {
    if (error instanceof InvalidOwnerPreviewError || error instanceof AutomationPausedError) return { acknowledge: true };
    // Never burn the hosting allowance retrying indefinitely while Neon is off.
    // The durable Preview cursor is kept; a NEW owner command can recover later.
    if (isDatabaseQuotaError(error) || metadata.deliveryCount >= 3) return { acknowledge: true };
    return { afterSeconds: metadata.deliveryCount <= 1 ? 300 : 1800 };
  },
});
