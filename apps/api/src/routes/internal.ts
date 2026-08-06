import crypto from 'node:crypto';
import { Router } from 'express';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { sweepAllOrganizations } from '../lib/sweep.js';
import { env } from '../env.js';
import { db } from '../db.js';

/**
 * Internal triggers — the product's ONLY routes authenticated by neither a
 * session nor an API key (U21). Guarded by a shared secret from the environment.
 */
export const internalRouter: Router = Router();

/** Constant-time header check against the configured secret. Length-guarded — timingSafeEqual throws on a mismatch. */
function secretMatches(presented: string, secret: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(secret, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Run the expiry sweep across every organisation. FAILS CLOSED: with
 * `SWEEP_SECRET` unset or empty it returns 503 and admits nobody, because the
 * natural comparison of an unset header against an unset variable is
 * `undefined === undefined` and would open the only unauthenticated write
 * endpoint to everyone. The plan does not pick what calls this route.
 */
internalRouter.post(
  '/sweep',
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const secret = env.SWEEP_SECRET;
    if (!secret) {
      // Fail closed — refuse everyone rather than admit all.
      res.status(503).json({ error: 'sweep_not_configured' });
      return;
    }
    const presented = req.header('x-sweep-secret') ?? '';
    if (!secretMatches(presented, secret)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const results = await sweepAllOrganizations(db, new Date());
    res.json({ results });
  }),
);
