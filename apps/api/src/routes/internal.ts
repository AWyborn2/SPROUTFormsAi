import crypto from 'node:crypto';
import { Router } from 'express';
import { isNull } from 'drizzle-orm';
import { schema } from '@formai/db';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { sweepAllOrganizations } from '../lib/sweep.js';
import { backfillUsername } from '../lib/username.js';
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

/**
 * Issue a username to every `users` row written before the column existed
 * (R21, KTD21).
 *
 * IDEMPOTENT: a row already holding one is skipped, so a run interrupted
 * part-way is repeated rather than reconciled — which is the whole reason this
 * is a route calling the issuing function rather than SQL in a migration. The
 * function owns the collision retry and the name normalisation, so the backfill
 * cannot drift from what a live insert does.
 *
 * Existing rows have no profile to read first and last names from, so the stem
 * is split out of the single stored `users.name`. A name that will not split
 * still yields a username rather than stopping the run on that person.
 *
 * Same fail-closed shared-secret guard as the sweep above, for the same reason.
 */
internalRouter.post(
  '/backfill-usernames',
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const secret = env.SWEEP_SECRET;
    if (!secret) {
      res.status(503).json({ error: 'sweep_not_configured' });
      return;
    }
    if (!secretMatches(req.header('x-sweep-secret') ?? '', secret)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const rows = await db.query.users.findMany({ where: isNull(schema.users.username) });
    let issued = 0;
    const failed: Array<{ userId: string; reason: string }> = [];
    for (const row of rows) {
      try {
        if (await backfillUsername(db, row)) issued++;
      } catch (err) {
        // One unissuable name must not stop the rest of the workforce.
        failed.push({ userId: row.id, reason: err instanceof Error ? err.message : 'unknown' });
      }
    }
    res.json({ considered: rows.length, issued, failed });
  }),
);
