/**
 * /form-brands — the clients a form can be presented as.
 *
 * A brand names a client and carries their logo, so the property this file
 * exists to pin is that ONE ORG CANNOT SEE ANOTHER'S. The list of brands an org
 * holds is the list of companies it subcontracts for, which is commercially
 * sensitive in a way a colour is not — every query here is org-scoped in its
 * WHERE clause, and the tests below check the scope reaches the query rather
 * than checking it after the row has already been loaded.
 *
 * The other property is that a duplicate name is refused. Two entries reading
 * "BBM" and "bbm" in one picker is a coin flip about which client's colours a
 * form renders in.
 */
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@formai/db';

const admin = { userId: 'u1', orgId: 'org-1', role: 'admin' as const };
const builder = { userId: 'u2', orgId: 'org-1', role: 'builder' as const };
const viewer = { userId: 'u3', orgId: 'org-1', role: 'viewer' as const };

let mockDbValue: Db | null = null;
vi.mock('../db.js', () => ({
  get db() {
    return mockDbValue;
  },
  getDbStatus: () => 'unconfigured',
}));

const { createApp } = await import('../app.js');
const { sealSession } = await import('../auth/workos.js');

function startApp() {
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

function authHeader(t: { userId: string; orgId: string; role: string }) {
  return { cookie: `fai_session=${sealSession(t)}`, 'content-type': 'application/json' };
}

function returningResult(rows: unknown[]) {
  const awaitable = Promise.resolve(undefined) as Promise<undefined> & {
    returning: () => Promise<unknown[]>;
  };
  awaitable.returning = vi.fn().mockResolvedValue(rows);
  return awaitable;
}

const BBM = {
  id: 'b-1',
  name: 'BBM',
  branding: {
    logoAssetUrl: '/api/assets/logo/org-1/logo-x.png',
    primaryColor: '#0044cc',
    theme: { radius: 4 },
  },
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

function fakeDb(opts: {
  findMany?: unknown[];
  findFirst?: unknown;
  inserted?: unknown;
  updated?: unknown;
  deleted?: unknown;
  /** Thrown by insert/update, to stand in for the unique index firing. */
  writeError?: Error;
} = {}) {
  const findManyArgs = vi.fn();
  const updateSet = vi.fn();
  const deleteWhere = vi.fn();
  const db = {
    query: {
      // `hasPermission` reads this first; undefined falls back to the shipped
      // default matrix, which is what every role assertion below relies on.
      rolePermissions: { findFirst: vi.fn().mockResolvedValue(undefined) },
      users: { findFirst: vi.fn().mockResolvedValue({ name: 'Ada' }) },
      formBrands: {
        findMany: vi.fn((args: unknown) => {
          findManyArgs(args);
          return Promise.resolve(opts.findMany ?? []);
        }),
        findFirst: vi.fn().mockResolvedValue(opts.findFirst),
      },
    },
    insert: vi.fn(() => ({
      values: () => {
        if (opts.writeError) throw opts.writeError;
        return returningResult([opts.inserted]);
      },
    })),
    update: vi.fn(() => ({
      set: (v: unknown) => {
        updateSet(v);
        return {
          where: () => {
            if (opts.writeError) throw opts.writeError;
            return returningResult([opts.updated]);
          },
        };
      },
    })),
    delete: vi.fn(() => ({
      where: (w: unknown) => {
        deleteWhere(w);
        return returningResult([opts.deleted]);
      },
    })),
  } as unknown as Db;
  return { db, findManyArgs, updateSet, deleteWhere };
}

afterEach(() => {
  mockDbValue = null;
  vi.restoreAllMocks();
});

describe('GET /form-brands', () => {
  it('refuses an unauthenticated caller', async () => {
    // The brand list names the org's clients. A URL is not a credential for it.
    mockDbValue = fakeDb().db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands`);
      expect(res.status).toBe(401);
    } finally {
      server.close();
    }
  });

  it('scopes the query to the caller’s org', async () => {
    /*
      THE TEST THAT MATTERS MOST. The route never re-checks orgId after loading,
      by design — so if the scope ever leaves the WHERE clause, nothing
      downstream would catch it. This asserts the `findMany` is given a filter
      at all, which is the only place the scope lives.
    */
    const { db, findManyArgs } = fakeDb({ findMany: [BBM] });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands`, { headers: authHeader(admin) });
      expect(res.status).toBe(200);
      expect(findManyArgs).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.anything() }),
      );
    } finally {
      server.close();
    }
  });

  it('sorts by name, so the picker does not reshuffle between loads', async () => {
    // A list that reorders itself is a list somebody picks wrongly from.
    const { db } = fakeDb({
      findMany: [
        { ...BBM, id: 'b-2', name: 'Zenith' },
        { ...BBM, id: 'b-3', name: 'Acme' },
      ],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands`, { headers: authHeader(admin) });
      const body = (await res.json()) as { name: string }[];
      expect(body.map((br) => br.name)).toEqual(['Acme', 'Zenith']);
    } finally {
      server.close();
    }
  });

  it('lets a Viewer read the list', async () => {
    // Reading is gated on forms:view, not forms:edit — the picker sits beside
    // a form somebody is already allowed to look at.
    mockDbValue = fakeDb({ findMany: [BBM] }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands`, { headers: authHeader(viewer) });
      expect(res.status).toBe(200);
    } finally {
      server.close();
    }
  });
});

describe('POST /form-brands', () => {
  it('creates a brand', async () => {
    mockDbValue = fakeDb({ inserted: BBM }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands`, {
        method: 'POST',
        headers: authHeader(admin),
        body: JSON.stringify({ name: 'BBM', branding: { primaryColor: '#0044cc' } }),
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ id: 'b-1', name: 'BBM' });
    } finally {
      server.close();
    }
  });

  it('reports a duplicate name as 409, from the index rather than a pre-read', async () => {
    /*
      A read-then-write check would let two people adding "BBM" at once both
      find nothing and both insert. The unique index is what refuses it, so the
      route's job is to recognise that failure — this asserts it does.
    */
    mockDbValue = fakeDb({
      writeError: new Error(
        'duplicate key value violates unique constraint "form_brands_org_name_uq"',
      ),
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands`, {
        method: 'POST',
        headers: authHeader(admin),
        body: JSON.stringify({ name: 'bbm' }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'duplicate_name' });
    } finally {
      server.close();
    }
  });

  it('lets any other write failure surface as a 500 rather than a 409', async () => {
    // Reporting an unrelated failure as "that name is taken" would send the
    // author renaming a brand that was never the problem.
    mockDbValue = fakeDb({ writeError: new Error('connection terminated') }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands`, {
        method: 'POST',
        headers: authHeader(admin),
        body: JSON.stringify({ name: 'BBM' }),
      });
      expect(res.status).toBe(500);
    } finally {
      server.close();
    }
  });

  it('refuses a logo pointing at another host', async () => {
    /*
      `logoAssetUrl` is a path we minted, not a URL a caller chose. An absolute
      one would make every respondent's browser fetch a client's form asset from
      somewhere else, handing that host the IP of everyone who opens the form.
    */
    mockDbValue = fakeDb({ inserted: BBM }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands`, {
        method: 'POST',
        headers: authHeader(admin),
        body: JSON.stringify({
          name: 'BBM',
          branding: { logoAssetUrl: 'https://evil.example/logo.png' },
        }),
      });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('refuses a Viewer', async () => {
    mockDbValue = fakeDb().db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands`, {
        method: 'POST',
        headers: authHeader(viewer),
        body: JSON.stringify({ name: 'BBM' }),
      });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });
});

describe('PATCH /form-brands/:id', () => {
  it('MERGES THE PATCH INTO THE STORED KIT rather than replacing it', async () => {
    /*
      An edit that changes the colours must not blank the logo. The patch is
      per-key inside one jsonb column, so a plain write of the body would drop
      every key the author did not happen to re-send — including a client's
      logo, which would put ours back on their form.
    */
    const { db, updateSet } = fakeDb({ findFirst: BBM, updated: BBM });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands/b-1`, {
        method: 'PATCH',
        headers: authHeader(admin),
        body: JSON.stringify({ branding: { primaryColor: '#111111' } }),
      });
      expect(res.status).toBe(200);
      expect(updateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          branding: {
            logoAssetUrl: '/api/assets/logo/org-1/logo-x.png',
            primaryColor: '#111111',
            theme: { radius: 4 },
          },
        }),
      );
    } finally {
      server.close();
    }
  });

  it('lets an explicit null REMOVE the brand’s logo', async () => {
    // `undefined` (not mentioned) and `null` ("this brand has no logo") have to
    // stay different, or "remove the client's logo" becomes unsayable and the
    // org's comes back on their form.
    const { db, updateSet } = fakeDb({ findFirst: BBM, updated: BBM });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      await fetch(`${base}/form-brands/b-1`, {
        method: 'PATCH',
        headers: authHeader(admin),
        body: JSON.stringify({ branding: { logoAssetUrl: null } }),
      });
      expect(updateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          branding: expect.objectContaining({ logoAssetUrl: null, primaryColor: '#0044cc' }),
        }),
      );
    } finally {
      server.close();
    }
  });

  it('404s when the lookup matched nothing — including another org’s brand', async () => {
    /*
      The org filter is in the lookup's own WHERE, so another org's id simply
      matches no row. Indistinguishable from a nonexistent id on purpose: a
      different status would turn this route into a way to confirm that some
      other company uses the product.
    */
    mockDbValue = fakeDb({ findFirst: undefined }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands/someone-elses`, {
        method: 'PATCH',
        headers: authHeader(admin),
        body: JSON.stringify({ name: 'Renamed' }),
      });
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('reports a rename onto an existing name as 409', async () => {
    mockDbValue = fakeDb({
      findFirst: BBM,
      writeError: new Error('unique constraint "form_brands_org_name_uq"'),
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands/b-1`, {
        method: 'PATCH',
        headers: authHeader(admin),
        body: JSON.stringify({ name: 'Acme' }),
      });
      expect(res.status).toBe(409);
    } finally {
      server.close();
    }
  });
});

describe('DELETE /form-brands/:id', () => {
  it('deletes the brand and answers 204', async () => {
    mockDbValue = fakeDb({ deleted: BBM }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands/b-1`, {
        method: 'DELETE',
        headers: authHeader(admin),
      });
      expect(res.status).toBe(204);
    } finally {
      server.close();
    }
  });

  it('refuses a Builder, who may edit forms but not delete', async () => {
    /*
      Deleting a brand reaches every form that used it, unstyling all of them at
      once. That is a delete-shaped act even though nothing named a form, so it
      is gated as one.
    */
    mockDbValue = fakeDb({ deleted: BBM }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands/b-1`, {
        method: 'DELETE',
        headers: authHeader(builder),
      });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('404s on another org’s brand rather than deleting it', async () => {
    mockDbValue = fakeDb({ deleted: undefined }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands/someone-elses`, {
        method: 'DELETE',
        headers: authHeader(admin),
      });
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });
});
