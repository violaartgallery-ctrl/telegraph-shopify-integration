import { Router } from 'express';
import type { Request, Response } from 'express';
import type { ShipmentStatusSyncService } from '../services/shipmentStatusSyncService.js';
import { handler as drainOdooQueue } from '../netlify/functions/process-odoo-queue-background.js';
import { logger } from '../lib/logger.js';
import type { MetaDeliveryService } from '../meta/metaDeliveryService.js';
import { listRecoverableJobs } from '../services/productionJobStore.js';
import { scheduleProductionContinuation } from '../services/productionContinuation.js';
import { checkProductionHealth } from '../services/productionHealthService.js';
import { sendMessage } from '../telegram/telegramApi.js';

/**
 * Ops endpoints triggered by an external scheduler (GitHub Actions every 30 min)
 * instead of Netlify scheduled functions / Vercel crons (Hobby is daily-only).
 * Each handler is the same work the old crons did and stays within Vercel's 300s
 * budget. Mounted OUTSIDE /api so it is not behind adminAuth; every operation is
 * fail-closed behind the shared OPS_SECRET.
 */
export const createOpsRouter = (
  shipmentStatusSyncService: ShipmentStatusSyncService,
  metaDeliveryService?: MetaDeliveryService
) => {
  const router = Router();

  // Ops routes can create shipments, invoices, payments, returns, and alerts,
  // so an incomplete deployment must fail closed rather than expose a write path.
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

  const queryInt = (request: Request, name: string, fallback: number): number => {
    const raw = typeof request.query[name] === 'string' ? request.query[name] : '';
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : fallback;
  };

  const queryApply = (request: Request): boolean =>
    ['1', 'true', 'yes'].includes(String(request.query.apply ?? '').toLowerCase());

  const processOdooQueue = async (request: Request, response: Response) => {
    if (!strictGuard(request, response)) return;
    try {
      const result = await drainOdooQueue({ batchSize: 5, budgetMs: 75_000, maxSteps: 15 });
      response.status(result.statusCode).send(result.body);
    } catch (error) {
      logger.error('ops/process-odoo-queue failed', { reason: error instanceof Error ? error.message : String(error) });
      response.status(500).json({ ok: false });
    }
  };
  router.get('/ops/process-odoo-queue', processOdooQueue);
  router.post('/ops/process-odoo-queue', processOdooQueue);

  router.get('/ops/sync-open-shipments', async (request, response) => {
    if (!strictGuard(request, response)) return;
    try {
      const result = await shipmentStatusSyncService.syncOpenShipments({ budgetMs: 70_000, batchSize: 100 });
      response.json({ ok: true, ...result });
    } catch (error) {
      logger.error('ops/sync-open-shipments failed', { reason: error instanceof Error ? error.message : String(error) });
      response.status(500).json({ ok: false });
    }
  });

  router.get('/ops/sync-collections', async (request, response) => {
    if (!strictGuard(request, response)) return;
    try {
      const result = await shipmentStatusSyncService.syncCollectionsFromReports({ maxActions: 12, budgetMs: 70_000 });
      response.json({ ok: true, ...result });
    } catch (error) {
      logger.error('ops/sync-collections failed', { reason: error instanceof Error ? error.message : String(error) });
      response.status(500).json({ ok: false });
    }
  });

  router.post('/ops/sync-returns', async (request, response) => {
    if (!strictGuard(request, response)) return;
    try {
      const result = await shipmentStatusSyncService.discoverReturnedShipmentsFromReports({
        startPage: queryInt(request, 'page', 1),
        pages: queryInt(request, 'pages', 1),
        budgetMs: 70_000,
        apply: queryApply(request)
      });
      response.json({ ok: true, ...result });
    } catch (error) {
      logger.error('ops/sync-returns failed', { reason: error instanceof Error ? error.message : String(error) });
      response.status(500).json({ ok: false });
    }
  });

  router.post('/ops/process-return-queue', async (request, response) => {
    if (!strictGuard(request, response)) return;
    try {
      const result = await shipmentStatusSyncService.processReturnQueue({
        limit: queryInt(request, 'limit', 4),
        budgetMs: 70_000,
        apply: queryApply(request)
      });
      response.json({ ok: true, ...result });
    } catch (error) {
      logger.error('ops/process-return-queue failed', { reason: error instanceof Error ? error.message : String(error) });
      response.status(500).json({ ok: false });
    }
  });

  router.post('/ops/process-shopify-payment-queue', async (request, response) => {
    if (!strictGuard(request, response)) return;
    try {
      const result = await shipmentStatusSyncService.processShopifyPaymentQueue({
        limit: queryInt(request, 'limit', 6),
        budgetMs: 70_000,
        apply: queryApply(request)
      });
      response.json({ ok: true, ...result });
    } catch (error) {
      logger.error('ops/process-shopify-payment-queue failed', { reason: error instanceof Error ? error.message : String(error) });
      response.status(500).json({ ok: false });
    }
  });

  router.get('/ops/financial-health', async (request, response) => {
    if (!strictGuard(request, response)) return;
    try {
      const result = await shipmentStatusSyncService.getFinancialQueueHealth();
      response.status(result.ok ? 200 : 503).json(result);
    } catch (error) {
      logger.error('ops/financial-health failed', { reason: error instanceof Error ? error.message : String(error) });
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

  router.get('/ops/resume-production-jobs', async (request, response) => {
    if (!strictGuard(request, response)) return;
    try {
      const { prisma } = await import('../lib/prisma.js');
      const paused = await prisma.failedPayload.findFirst({
        where: { source: 'bot_control', reason: 'bot_paused' },
      });
      if (paused) {
        response.json({ ok: true, paused: true, found: 0, dispatched: 0 });
        return;
      }

      const jobs = await listRecoverableJobs();
      let dispatched = 0;
      const failures: string[] = [];
      for (const { chatId, job } of jobs) {
        try {
          await scheduleProductionContinuation({ chatId, batchId: job.batchId });
          dispatched += 1;
        } catch (error) {
          failures.push(`${job.batchId}: ${String(error).slice(0, 160)}`);
        }
      }
      response.status(failures.length ? 503 : 200).json({
        ok: failures.length === 0,
        found: jobs.length,
        dispatched,
        failures,
      });
    } catch (error) {
      logger.error('ops/resume-production-jobs failed', { reason: error instanceof Error ? error.message : String(error) });
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

  router.get('/ops/production-health', async (request, response) => {
    if (!strictGuard(request, response)) return;
    try {
      const result = await checkProductionHealth();
      const { prisma } = await import('../lib/prisma.js');
      const stateWhere = { source: 'health_monitor', reason: 'production_health' } as const;
      const previous = await prisma.failedPayload.findFirst({ where: stateWhere, orderBy: { id: 'desc' } });
      const fingerprint = JSON.stringify({
        theme: result.theme,
        validation: result.validation,
        fallback: result.vercelFallback,
      });
      const configured = process.env.PRODUCTION_ALERT_CHAT_IDS?.trim()
        || process.env.PRODUCTION_RECIPIENT_CHAT_IDS?.trim()
        || '6776051391,8615245657';
      const recipients = [...new Set(configured.split(',').map((value) => value.trim()).filter(Boolean))];

      if (!result.ok && previous?.payloadJson !== fingerprint) {
        const alert = [
          '🚨 تنبيه أمان Viola Production',
          `Theme: ${result.theme.ok ? 'OK' : result.theme.error ?? 'FAILED'}`,
          `Shopify Validation: ${result.validation.ok ? 'OK' : result.validation.error ?? 'FAILED'}`,
          `Vercel locations fallback: ${result.vercelFallback.ok ? 'OK' : result.vercelFallback.error ?? 'FAILED'}`,
          'لن يتم تخمين مناطق؛ راجع النظام قبل أي Run جديد.',
        ].join('\n');
        await Promise.all(recipients.map((recipient) => sendMessage(recipient, alert)));
        await prisma.failedPayload.deleteMany({ where: stateWhere });
        await prisma.failedPayload.create({
          data: { ...stateWhere, payloadJson: fingerprint },
        });
      } else if (result.ok && previous) {
        await Promise.all(recipients.map((recipient) => sendMessage(
          recipient,
          '✅ Viola Production health رجع سليم: Theme + Shopify Validation + Vercel fallback.'
        )));
        await prisma.failedPayload.deleteMany({ where: stateWhere });
      }

      response.status(result.ok ? 200 : 503).json(result);
    } catch (error) {
      logger.error('ops/production-health failed', { reason: error instanceof Error ? error.message : String(error) });
      response.status(500).json({ ok: false });
    }
  });

  return router;
};
