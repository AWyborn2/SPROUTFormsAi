import type { NextFunction, Request, Response } from 'express';
import type { TenantContext } from '@formai/shared';
import { unsealSession } from '../auth/replit-auth.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Resolved tenant context, present on authenticated routes. */
      tenant?: TenantContext;
    }
  }
}

export const SESSION_COOKIE_NAME = 'fai_session';

/**
 * Resolves `req.tenant` from the sealed session cookie and 401s when it is
 * absent, tampered, or expired. Every DB query downstream filters by
 * `tenant.orgId` — the enforced multi-tenant boundary.
 */
export function requireTenant(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  const tenant = typeof token === 'string' ? unsealSession<TenantContext>(token) : null;
  if (!tenant) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  req.tenant = tenant;
  next();
}
