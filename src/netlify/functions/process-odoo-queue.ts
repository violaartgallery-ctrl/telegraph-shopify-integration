/**
 * Netlify Scheduled Function — runs every 30 minutes (see netlify.toml).
 *
 * This is a lightweight TRIGGER only. Scheduled (synchronous) functions are
 * capped at ~26s by Netlify, which is far too short to drain a queue of Odoo
 * orders (each stage is a multi-second Odoo API call). So this function does no
 * work itself: it fire-and-forget invokes `process-odoo-queue-background`, which
 * is a Netlify Background Function with a 15-minute budget and drains the whole
 * backlog in one wake.
 *
 * Keeping the heavy work in the background function means each 30-min tick wakes
 * Neon's compute exactly once, which is what keeps us inside the free-tier
 * compute allowance.
 */
import { logger } from '../../lib/logger.js';

interface LambdaResult {
  statusCode: number;
  body: string;
}

function siteUrl(): string {
  return (process.env.URL ?? '').replace(/\/$/, '');
}

export const handler = async (): Promise<LambdaResult> => {
  const base = siteUrl();
  if (!base) {
    logger.error('process-odoo-queue: URL env not set, cannot trigger background drainer');
    return { statusCode: 500, body: JSON.stringify({ ok: false, message: 'URL env not set' }) };
  }

  const url = `${base}/.netlify/functions/process-odoo-queue-background`;
  try {
    // Background functions return 202 immediately and keep running; we don't
    // await the actual draining work, only the hand-off.
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    logger.info('process-odoo-queue: triggered background drainer');
    return { statusCode: 202, body: JSON.stringify({ ok: true, triggered: true }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('process-odoo-queue: failed to trigger background drainer', { reason: message });
    return { statusCode: 500, body: JSON.stringify({ ok: false, message }) };
  }
};
