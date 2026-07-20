import { sql } from 'drizzle-orm';
import { createDb, type Db } from '@formai/db';
import { env } from './env.js';

export type DbStatus = 'connected' | 'error' | 'unconfigured';

/** How often the cached health status is refreshed against the real DB. */
export const HEALTH_CHECK_INTERVAL_MS = 10_000;

/**
 * The shared DB client, constructed once at module load. `null` when
 * `DATABASE_URL` is unset — mirrors `getAnthropic()`'s fail-soft pattern.
 * No migrate-on-boot: schema changes are applied explicitly via
 * `pnpm db:migrate`, not from here.
 */
export const db: Db | null = env.DATABASE_URL ? createDb(env.DATABASE_URL) : null;

/**
 * Checks connectivity for a given client (or `null`). Takes the client as an
 * explicit argument rather than reading the module singleton so callers —
 * including tests — can exercise all three states without an env-injection
 * or module-reset trick: pass `db` in production, a mock or `null` in tests.
 */
export async function checkDbConnection(target: Db | null): Promise<DbStatus> {
  if (!target) return 'unconfigured';
  try {
    await target.execute(sql`select 1`);
    return 'connected';
  } catch {
    return 'error';
  }
}

/**
 * Caches `checkDbConnection`'s result and refreshes it on a background
 * interval instead of on every read. `/health` is a frequently-polled
 * liveness endpoint (load balancers, k8s probes, uptime monitors) — querying
 * Postgres on every hit adds unnecessary DB load and ties the health check's
 * own latency/availability to the DB's. `getStatus()` is synchronous so the
 * route handler never awaits a DB round-trip.
 *
 * A factory (not a bare module singleton) so the caching mechanics — does the
 * background refresh actually update the cached value, does `stop()` clean up
 * the timer — are unit-testable with a mock client, independent of whether
 * `DATABASE_URL` happens to be set in the test environment.
 *
 * When `target` is non-null, the very first read (before the initial refresh
 * resolves) can briefly report `'unconfigured'` rather than the true state —
 * an accepted tradeoff of a fire-and-forget first check at construction time,
 * bounded to a single DB round-trip at process boot before real traffic
 * typically arrives.
 */
export function createHealthCache(target: Db | null, intervalMs = HEALTH_CHECK_INTERVAL_MS) {
  let cached: DbStatus = 'unconfigured';
  let timer: ReturnType<typeof setInterval> | undefined;

  function refresh(): void {
    void checkDbConnection(target).then((status) => {
      cached = status;
    });
  }

  if (target) {
    refresh();
    timer = setInterval(refresh, intervalMs);
    timer.unref?.();
  }

  return {
    getStatus: (): DbStatus => cached,
    /** Stop the background refresh — used by tests to avoid leaking timers. */
    stop: (): void => {
      if (timer) clearInterval(timer);
    },
  };
}

const healthCache = createHealthCache(db);

/** Synchronous read of the last-refreshed DB connectivity state. */
export function getDbStatus(): DbStatus {
  return healthCache.getStatus();
}
