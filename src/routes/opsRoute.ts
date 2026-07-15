import { Router } from 'express';
import type { Request, Response } from 'express';
import type { ShipmentStatusSyncService } from '../services/shipmentStatusSyncService.js';
import { handler as drainOdooQueue } from '../netlify/functions/process-odoo-queue-background.js';
import { logger } from '../lib/logger.js';
import type { MetaDeliveryService } from '../meta/metaDeliveryService.js';

/**
 * Ops endpoints triggered by an external scheduler (GitHub Actions every 30 min)
 * instead of Netlify scheduled functions / Vercel crons (Hobby is daily-only).
 * Each handler is the same work the old crons did and stays within Vercel's 300s
 * budget. Mounted OUTSIDE /api so it is not behind adminAuth; protected instead by
 * a shared secret (OPS_SECRET) when that env var is set.
 */
export const createOpsRouter = (
  shipmentStatusSyncService: ShipmentStatusSyncService,
  metaDeliveryService?: MetaDeliveryService
) => {
  const router = Router();

  const guard = (request: Request, response: Response): boolean => {
    const secret = process.env.OPS_SECRET?.trim();
    if (!secret) return true; // no secret configured → open (same as old Netlify crons)
    const provided = request.header('x-ops-secret') ?? (request.query.key as string | undefined);
    if (provided === secret) return true;
    response.status(401).json({ ok: false, message: 'Invalid ops secret' });
    return false;
  };

  // Meta delivery sends are a financial/advertising side effect and therefore
  // never fail open, even on an accidentally incomplete deployment.
  const strictGuard = (request: Request, response: Response): boolean => {
    const secret = process.env.OPS_SECRET?.trim();
    if (!secret) {
      response.status(503).json({ ok: false, message: 'OPS_SECRET is not configured' });
      return false;
    }
    const provided = request.header('x-ops-secret');
    if (provided === secret) return true;
    response.status(401).json({ ok: false, message: 'Invalid ops secret' });
    return false;
  };

  router.get('/ops/process-odoo-queue', async (request, response) => {
    if (!guard(request, response)) return;
    try {
      const result = await drainOdooQueue();
      response.status(result.statusCode).send(result.body);
    } catch (error) {
      logger.error('ops/process-odoo-queue failed', { reason: error instanceof Error ? error.message : String(error) });
      response.status(500).json({ ok: false });
    }
  });

  router.get('/ops/sync-open-shipments', async (request, response) => {
    if (!guard(request, response)) return;
    try {
      const result = await shipmentStatusSyncService.syncOpenShipments();
      response.json({ ok: true, ...result });
    } catch (error) {
      logger.error('ops/sync-open-shipments failed', { reason: error instanceof Error ? error.message : String(error) });
      response.status(500).json({ ok: false });
    }
  });

  router.get('/ops/sync-collections', async (request, response) => {
    if (!guard(request, response)) return;
    try {
      const result = await shipmentStatusSyncService.syncCollectionsFromReports();
      response.json({ ok: true, ...result });
    } catch (error) {
      logger.error('ops/sync-collections failed', { reason: error instanceof Error ? error.message : String(error) });
      response.status(500).json({ ok: false });
    }
  });

  router.post('/ops/meta-delivered/drain', async (request, response) => {
    if (!strictGuard(request, response)) return;
    if (!metaDeliveryService) {
      response.status(503).json({ ok: false, message: 'Meta delivery service is unavailable' });
      return;
    }
    try {
      const result = await metaDeliveryService.processPending();
      response.json({ ok: true, ...result });
    } catch (error) {
      logger.error('ops/meta-delivered/drain failed', {
        reason: error instanceof Error ? error.message : String(error)
      });
      response.status(500).json({ ok: false });
    }
  });

  router.get('/ops/meta-delivered/health', async (request, response) => {
    if (!strictGuard(request, response)) return;
    try {
      response.json({
        ok: true,
        enabled: metaDeliveryService?.isEnabled() ?? false,
        outbox: await metaDeliveryService?.health() ?? null
      });
    } catch (error) {
      logger.error('ops/meta-delivered/health failed', {
        reason: error instanceof Error ? error.message : String(error)
      });
      response.status(500).json({ ok: false });
    }
  });

  return router;
};
