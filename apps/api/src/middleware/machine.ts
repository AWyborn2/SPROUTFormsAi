import type { NextFunction, Request, Response } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '@formai/db';
import type { TenantContext } from '@formai/shared';
import { unsealSession } from '../auth/replit-auth.js';
import { bearerToken, parseApiKey, verifyApiKey } from '../auth/api-key.js';
import { SESSION_COOKIE_NAME } from './tenant.js';
import { db } from '../db.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set when the request authenticated with an API key rather than a session. */
      apiKeyId?: string;
    }
  }
}

/**
 * Resolves `req.tenant` from EITHER a session cookie or an org-scoped API key.
 *
 * Mounted only on machine-facing routers. Teaching `requireTenant` itself to
 * accept a bearer token would have made every existing endpoint — team
 * management, billing, submission deletion — machine-callable in one edit, with
 * nothing at the call sites to notice. Keeping the machine door a separate
 * middleware means the set of endpoints an API key can reach is exactly the set
 * someone deliberately mounted it on, and widening it is a visible act.
 *
 * Every rejection is the same opaque `401 unauthenticated`. An unknown prefix,
 * a wrong secret, a revoked key and an orphaned issuer must be
 * indistinguishable, or the response becomes an oracle for enumerating which
 * prefixes exist.
 */
export async function requireMachineOrTenant(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const unauthenticated = () => res.status(401).json({ error: 'unauthenticated' });

  const presented = bearerToken(req.header('authorization'));
  if (presented) {
    const parsed = parseApiKey(presented);
    if (!parsed || !db) {
      unauthenticated();
      return;
    }
    // The try covers ONLY credential resolution. `next()` runs after it —
    // inside, a synchronous throw from downstream middleware would be caught
    // here and misreported as a 401 (or double-send once headers are out).
    try {
      const key = await db.query.apiKeys.findFirst({
        where: and(eq(schema.apiKeys.prefix, parsed.prefix), isNull(schema.apiKeys.revokedAt)),
      });
      if (!key || !verifyApiKey(presented, key.hash) || !key.createdByUserId) {
        unauthenticated();
        return;
      }
      // Machine calls act as the issuing administrator: `TenantContext.userId`
      // is non-nullable and `recordAudit` resolves it to name the actor, so an
      // agent's writes are attributable to whoever authorised the key.
      const issuer = await db.query.users.findFirst({
        where: eq(schema.users.id, key.createdByUserId),
      });
      if (!issuer) {
        unauthenticated();
        return;
      }
      req.tenant = { userId: issuer.id, orgId: key.orgId, role: key.role };
      req.apiKeyId = key.id;
      // Best-effort: a last-used stamp is for detection, and failing to write
      // it must never fail the request it was observing.
      void db
        .update(schema.apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(schema.apiKeys.id, key.id))
        .catch(() => {});
    } catch {
      unauthenticated();
      return;
    }
    next();
    return;
  }

  const token = req.cookies?.[SESSION_COOKIE_NAME];
  const tenant = typeof token === 'string' ? unsealSession<TenantContext>(token) : null;
  if (!tenant) {
    unauthenticated();
    return;
  }
  req.tenant = tenant;
  next();
}
