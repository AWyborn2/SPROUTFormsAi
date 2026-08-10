import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@formai/db';

let mockDbValue: Db | null = null;
vi.mock('../db.js', () => ({
  get db() {
    return mockDbValue;
  },
  getDbStatus: () => 'unconfigured',
}));

// A mutable SWEEP_SECRET layered over the real parsed env, so each test can set
// it (or leave it unset) without re-parsing the environment.
let sweepSecret: string | undefined;
vi.mock('../env.js', async () => {
  const actual = await vi.importActual<typeof import('../env.js')>('../env.js');
  return {
    get env() {
      return { ...actual.env, SWEEP_SECRET: sweepSecret };
    },
  };
});

const { createApp } = await import('../app.js');

function startApp() {
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

/** A database whose only need here is to answer organizations.findMany for the sweep. */
function fakeDb() {
  return { query: { organizations: { findMany: vi.fn().mockResolvedValue([]) } } } as unknown as Db;
}

afterEach(() => {
  mockDbValue = null;
  sweepSecret = undefined;
  vi.clearAllMocks();
});

describe('POST /internal/sweep — the shared-secret trigger (U21)', () => {
  it('FAILS CLOSED: with the secret unset it refuses every caller (503)', async () => {
    mockDbValue = fakeDb();
    sweepSecret = undefined; // not configured
    const { server, base } = startApp();
    // Even presenting an empty secret — the danger case undefined === undefined.
    const res = await fetch(`${base}/internal/sweep`, {
      method: 'POST',
      headers: { 'x-sweep-secret': '' },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'sweep_not_configured' });
    server.close();
  });

  it('refuses a caller presenting the wrong secret (401)', async () => {
    mockDbValue = fakeDb();
    sweepSecret = 'the-real-secret';
    const { server, base } = startApp();
    const res = await fetch(`${base}/internal/sweep`, {
      method: 'POST',
      headers: { 'x-sweep-secret': 'not-it' },
    });
    expect(res.status).toBe(401);
    server.close();
  });

  it('refuses a caller presenting no secret at all (401)', async () => {
    mockDbValue = fakeDb();
    sweepSecret = 'the-real-secret';
    const { server, base } = startApp();
    const res = await fetch(`${base}/internal/sweep`, { method: 'POST' });
    expect(res.status).toBe(401);
    server.close();
  });

  it('accepts the correct secret and runs the sweep', async () => {
    mockDbValue = fakeDb();
    sweepSecret = 'the-real-secret';
    const { server, base } = startApp();
    const res = await fetch(`${base}/internal/sweep`, {
      method: 'POST',
      headers: { 'x-sweep-secret': 'the-real-secret' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [] });
    server.close();
  });
});

describe('POST /internal/backfill-usernames — the paginated walk (U27, R21)', () => {
  const SECRET = 'a-shared-secret';

  /**
   * A double over the batch read and the atomic claim.
   *
   * The cursor is supplied by the TEST from whatever `nextCursor` the route
   * returned, never tracked internally — otherwise the double would advance the
   * walk itself and a route that ignored `after` entirely would still pass.
   *
   * `cursed` names always collide, so `backfillUsername` exhausts its attempts
   * and the row stays null for ever. That is the case the keyset exists for:
   * filtering on `username IS NULL` alone would re-read the same unissuable row
   * on every call and never terminate.
   *
   * ONE CONSTRAINT: use `cursed` only with `limit=1`. The double claims by index
   * into the captured batch and cannot see which row the route has moved on to,
   * so a cursed row sharing a batch with a good one would keep answering for the
   * cursed slot and fail the good row too. One row per batch sidesteps that; the
   * route itself has no such limitation.
   */
  function walkDb(names: string[], cursed: string[] = []) {
    const rows = names.map((name, i) => ({
      // Sortable ids, so `id > after` is a comparison the double can make.
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      name,
      username: null as string | null,
    }));
    let cursor: string | undefined;
    /*
      The batch the route is currently walking, captured at read time. Claiming
      must consume THIS list — recomputing it per claim would re-filter on
      `username === null` while the claims are mutating it, and the index would
      drift off the end.
    */
    let batch: typeof rows = [];
    let claimIndex = 0;

    const db = {
      query: {
        organizations: { findMany: vi.fn().mockResolvedValue([]) },
        users: {
          findMany: vi.fn(async (args: { limit: number }) => {
            batch = rows
              .filter((r) => r.username === null && (cursor === undefined || r.id > cursor))
              .slice(0, args.limit);
            claimIndex = 0;
            return batch.map((r) => ({ ...r }));
          }),
        },
      },
      update: () => ({
        set: (v: { username: string }) => ({
          where: () => ({
            returning: async () => {
              const target = batch[claimIndex];
              if (!target) return [];
              if (cursed.includes(target.name)) {
                /*
                  Every candidate collides. The route retries the suffix
                  MAX_ATTEMPTS times against this same row and then gives up, so
                  the index stays put until it moves on of its own accord.
                */
                throw Object.assign(new Error('duplicate key'), {
                  code: '23505',
                  constraint: 'users_username_unique',
                });
              }
              target.username = v.username;
              claimIndex++;
              return [{ id: target.id }];
            },
          }),
        }),
      }),
    };
    return {
      db: db as unknown as Db,
      rows,
      /** What the TEST read off `nextCursor` — the double never sets this itself. */
      setCursor: (c: string | null) => {
        cursor = c ?? undefined;
      },
    };
  }

  function post(base: string, query = '') {
    return fetch(`${base}/internal/backfill-usernames${query}`, {
      method: 'POST',
      headers: { 'x-sweep-secret': SECRET },
    });
  }

  it('issues one BOUNDED batch and reports where to resume', async () => {
    /*
      The unbounded read loaded every matching row with every column and then
      made one round trip per person inside a single request — unbounded memory
      behind a proxy that times out long before it finishes.
    */
    sweepSecret = SECRET;
    const { db } = walkDb(['A One', 'B Two', 'C Three', 'D Four', 'E Five']);
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const body = (await (await post(base, '?limit=2')).json()) as {
        considered: number;
        issued: number;
        done: boolean;
        nextCursor: string | null;
      };
      expect(body.considered).toBe(2);
      expect(body.issued).toBe(2);
      // A full batch means there is more to walk.
      expect(body.done).toBe(false);
      expect(body.nextCursor).toBeTruthy();
    } finally {
      server.close();
    }
  });

  it('reports done on a short batch, and asks for no further call', async () => {
    sweepSecret = SECRET;
    const { db } = walkDb(['A One', 'B Two']);
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const body = (await (await post(base, '?limit=200')).json()) as {
        considered: number;
        done: boolean;
        nextCursor: string | null;
      };
      expect(body.considered).toBe(2);
      expect(body.done).toBe(true);
      expect(body.nextCursor).toBeNull();
    } finally {
      server.close();
    }
  });

  it('walks the whole workforce across successive calls', async () => {
    sweepSecret = SECRET;
    const { db, rows, setCursor } = walkDb(['A One', 'B Two', 'C Three', 'D Four', 'E Five']);
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      let cursor: string | null = null;
      let done = false;
      let calls = 0;
      while (!done && calls < 10) {
        setCursor(cursor);
        const q: string = cursor ? `?limit=2&after=${cursor}` : '?limit=2';
        const body = (await (await post(base, q)).json()) as { done: boolean; nextCursor: string | null };
        done = body.done;
        cursor = body.nextCursor;
        calls++;
      }
      expect(done).toBe(true);
      expect(rows.every((r) => r.username !== null)).toBe(true);
      expect(calls).toBe(3);
    } finally {
      server.close();
    }
  });

  it('TERMINATES past a row whose name can never be issued', async () => {
    /*
      The whole reason the cursor advances past every row CONSIDERED rather than
      every row issued. An exhausted namespace leaves the row null for ever, so a
      walk that re-read on `username IS NULL` alone would hand back the same row
      on every call and never finish — a loop an operator would have to notice
      and kill.
    */
    sweepSecret = SECRET;
    const { db, rows, setCursor } = walkDb(['A One', 'Cursed Name', 'C Three'], ['Cursed Name']);
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      let cursor: string | null = null;
      let done = false;
      let calls = 0;
      const failures: Array<{ userId: string }> = [];
      while (!done && calls < 10) {
        setCursor(cursor);
        const q: string = cursor ? `?limit=1&after=${cursor}` : '?limit=1';
        const body = (await (await post(base, q)).json()) as {
          done: boolean;
          nextCursor: string | null;
          failed: Array<{ userId: string }>;
        };
        failures.push(...body.failed);
        done = body.done;
        cursor = body.nextCursor;
        calls++;
      }

      expect(done).toBe(true);
      // The unissuable row is REPORTED, not silently skipped...
      expect(failures).toHaveLength(1);
      // ...and it did not stop the people after it.
      expect(rows[0]!.username).not.toBeNull();
      expect(rows[1]!.username).toBeNull();
      expect(rows[2]!.username).not.toBeNull();
    } finally {
      server.close();
    }
  });

  it('rejects a limit outside the bound rather than honouring it', async () => {
    // The cap is what keeps the request inside the proxy's patience.
    sweepSecret = SECRET;
    mockDbValue = walkDb([]).db;
    const { server, base } = startApp();
    try {
      expect((await post(base, '?limit=100000')).status).toBe(400);
      expect((await post(base, '?limit=0')).status).toBe(400);
      expect((await post(base, '?after=not-a-uuid')).status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('still fails closed with the secret unset', async () => {
    sweepSecret = undefined;
    mockDbValue = walkDb([]).db;
    const { server, base } = startApp();
    try {
      expect((await post(base)).status).toBe(503);
    } finally {
      server.close();
    }
  });
});
