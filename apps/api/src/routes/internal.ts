import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { and, gt, isNull } from 'drizzle-orm';
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
 * How much of the workforce one call walks.
 *
 * Bounded so the request cannot outlive whatever proxy is in front of it. The
 * default is deliberately modest — this runs once per database, by hand, and a
 * caller who wants it faster can say so.
 */
const batchQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  /** Keyset cursor: the last id the previous call CONSIDERED. */
  after: z.string().uuid().optional(),
});

/**
 * Issue a username to every `users` row written before the column existed
 * (R21, KTD21).
 *
 * ONE BATCH PER CALL. Walk it by following `nextCursor` until `done` is true:
 *
 *   POST /internal/backfill-usernames?limit=200
 *   POST /internal/backfill-usernames?limit=200&after=<nextCursor>
 *
 * IDEMPOTENT: a row already holding one is skipped, so a run interrupted
 * part-way is repeated rather than reconciled — which is the whole reason this
 * is a route calling the issuing function rather than SQL in a migration. The
 * function owns the collision retry and the name normalisation, so the backfill
 * cannot drift from what a live insert does. Idempotent under CONCURRENCY too:
 * the claim itself carries `username IS NULL`, so two overlapping walks cannot
 * overwrite each other.
 *
 * READ THE BODY, NOT THE STATUS. A row whose namespace is exhausted lands in
 * `failed[]` and the call still answers 200, because one unissuable name must
 * not stop the rest of the workforce.
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

    const params = batchQuery.safeParse(req.query);
    if (!params.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const { limit, after } = params.data;

    /*
      ONE BOUNDED BATCH PER REQUEST, walked by a keyset cursor on `id`.

      An unbounded read loaded every matching row with every column into memory
      and then made one sequential round trip per person inside a single HTTP
      request — fine on a handful of users, and on a real workforce it is
      unbounded memory behind a proxy that will time out long before it finishes.

      The cursor is `id > after` rather than an offset, and it advances past
      every row the batch LOOKED AT rather than every row it issued. That
      distinction is what makes the walk terminate: a name that cannot be issued
      (R21's exhausted namespace) stays null forever, and a
      "repeat while any remain" loop would spin on it for ever.

      Only the three columns issuance reads are selected; the rest of the row is
      not this route's business.
    */
    const rows = await db.query.users.findMany({
      where: after
        ? and(isNull(schema.users.username), gt(schema.users.id, after))
        : isNull(schema.users.username),
      columns: { id: true, name: true, username: true },
      orderBy: (u, { asc }) => [asc(u.id)],
      limit,
    });

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

    /*
      A short batch means the walk is over. `nextCursor` is the last id CONSIDERED
      — issued, skipped or failed alike — so the caller resumes past it and the
      loop always makes progress.
    */
    const done = rows.length < limit;
    res.json({
      considered: rows.length,
      issued,
      failed,
      done,
      nextCursor: done ? null : (rows[rows.length - 1]?.id ?? null),
    });
  }),
);
