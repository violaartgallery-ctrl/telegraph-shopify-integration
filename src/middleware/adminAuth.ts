/**
 * adminAuth middleware — BUG-SEC-4 fix.
 *
 * Protects admin routes (/orders/*, /api/*) with a shared-secret token.
 *
 * Configuration
 * -------------
 * Set ADMIN_SECRET_TOKEN in your environment / Netlify env vars.
 *
 * Usage from clients / Shopify App Extension
 * ------------------------------------------
 *   Header:      x-admin-secret: <token>
 *   Query param: ?adminToken=<token>
 *
 * If ADMIN_SECRET_TOKEN is not set the server starts but logs a one-time warning
 * and admin routes remain open (backward-compat). Set the token in production.
 */

import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

let warnedOnce = false;

export const adminAuth = (request: Request, response: Response, next: NextFunction): void => {
  const token = env.adminSecretToken;

  if (!token) {
    if (!warnedOnce) {
      logger.warn(
        'ADMIN_SECRET_TOKEN is not set. ' +
        'Admin routes (/orders/*, /api/*) are unprotected. ' +
        'Set ADMIN_SECRET_TOKEN in your environment to secure the admin UI.'
      );
      warnedOnce = true;
    }
    next();
    return;
  }

  const provided =
    request.header('x-admin-secret') ??
    (request.query['adminToken'] as string | undefined);

  if (!provided || provided !== token) {
    response.status(401).json({
      ok: false,
      message: 'Unauthorized. Supply a valid admin token via the x-admin-secret header or adminToken query parameter.'
    });
    return;
  }

  next();
};
