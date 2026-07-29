/**
 * A join link is a credential printed on paper and photographed. These pin the
 * properties that make that acceptable:
 *
 *  - it can only ever grant `candidate`, whatever the stored row says;
 *  - revoked, expired and exhausted links are all refused at redemption;
 *  - scanning it never changes an existing member's role;
 *  - candidate seats are enforced on this path as on every other.
 *
 * The role test is the one that matters most: everything else is recoverable,
 * but a link that could mint an administrator is a poster on a wall that grants
 * org control.
 */
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Db } from '@formai/db';
import { DEFAULT_ROLE_PERMISSIONS } from '@formai/shared';

const ORG = 'org-1';
const ADMIN = '00000000-0000-4000-8000-00000000000a';
const NEWCOMER = '00000000-0000-4000-8000-00000000000b';
const TOKEN = 'join-token-abc';

const admin = { userId: ADMIN, orgId: ORG, role: 'admin' as const };
const newcomer = { userId: NEWCOMER, orgId: ORG, role: 'viewer' as const };

let sealSession: (t: { userId: string; orgId: string; role: string }) => string;
let mockDbValue: Db | null = null;

vi.mock('../db.js', () => ({
  get db() {
    return mockDbValue;
  },
  getDbStatus: () => 'unconfigured',
}));

const { createApp } = await import('../app.js');
({ sealSession } = await import('../auth/workos.js'));

function startApp() {
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

type Session = { userId: string; orgId: string; role: string };
const auth = (t: Session = admin) => ({
  cookie: `fai_session=${sealSession(t)}`,
  'content-type': 'application/json',
});

function insertResult(rows: unknown[]) {
  const p = Promise.resolve(undefined) as Promise<undefined> & { returning: () => Promise<unknown[]> };
  p.returning = vi.fn().mockResolvedValue(rows);
  return p;
}

function fakeDb(opts: {
  link?: Record<string, unknown>;
  membership?: unknown;
  activeCandidates?: number;
  planTier?: string;
  candidateSeatLimit?: number | null;
} = {}) {
  const insertValues = vi.fn();
  const updateSet = vi.fn();

  const db = {
    query: {
      rolePermissions: {
        findFirst: vi.fn().mockResolvedValue({ orgId: ORG, role: 'admin', matrix: DEFAULT_ROLE_PERMISSIONS.admin }),
      },
      orgJoinLinks: {
        findFirst: vi.fn().mockResolvedValue(opts.link),
        findMany: vi.fn().mockResolvedValue(opts.link ? [opts.link] : []),
      },
      organizations: {
        findFirst: vi.fn().mockResolvedValue({
          id: ORG,
          name: 'Charles Hull Contracting',
          planTier: opts.planTier ?? 'enterprise',
          candidateSeatLimit: opts.candidateSeatLimit ?? null,
        }),
      },
      memberships: { findFirst: vi.fn().mockResolvedValue(opts.membership) },
      users: { findFirst: vi.fn().mockResolvedValue(undefined) },
    },
    insert: vi.fn((table: unknown) => ({
      values: (v: unknown) => {
        insertValues(table, v);
        return insertResult([{ id: 'link-1', token: TOKEN, label: '', role: 'candidate', expiresAt: null, maxUses: null, useCount: 0, active: true, createdAt: new Date() }]);
      },
    })),
    update: vi.fn((table: unknown) => ({
      set: (v: unknown) => {
        updateSet(table, v);
        return { where: vi.fn().mockResolvedValue(undefined) };
      },
    })),
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    select: vi.fn(() => ({
      from: () => ({ where: vi.fn().mockResolvedValue([{ count: opts.activeCandidates ?? 0 }]) }),
    })),
  } as unknown as Db;

  return { db, insertValues, updateSet };
}

const liveLink = (over: Record<string, unknown> = {}) => ({
  id: 'link-1',
  orgId: ORG,
  token: TOKEN,
  role: 'candidate',
  label: 'Dozer intake',
  expiresAt: null,
  maxUses: null,
  useCount: 0,
  active: true,
  createdAt: new Date(),
  ...over,
});

afterEach(() => {
  vi.clearAllMocks();
  mockDbValue = null;
});

describe('creating a link', () => {
  it('always stores the candidate role, never one from the request', async () => {
    const f = fakeDb();
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/join-links`, {
        method: 'POST',
        headers: auth(),
        // A caller trying to escalate through the create route.
        body: JSON.stringify({ label: 'Nice try', role: 'owner' }),
      });

      expect(res.status).toBe(201);
      const [, values] = f.insertValues.mock.calls.find(([t]) => t === schema.orgJoinLinks)!;
      expect((values as { role: string }).role).toBe('candidate');
    } finally {
      server.close();
    }
  });

  it('refuses a caller without team management', async () => {
    const f = fakeDb();
    (f.db as unknown as { query: { rolePermissions: { findFirst: ReturnType<typeof vi.fn> } } }).query.rolePermissions.findFirst.mockResolvedValue({
      orgId: ORG,
      role: 'viewer',
      matrix: DEFAULT_ROLE_PERMISSIONS.viewer,
    });
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/join-links`, {
        method: 'POST',
        headers: auth(newcomer),
        body: JSON.stringify({ label: 'x' }),
      });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });
});

describe('describing a link publicly', () => {
  it('reveals the org name and role without a session', async () => {
    mockDbValue = fakeDb({ link: liveLink() }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/join/${TOKEN}`);
      const body = (await res.json()) as { orgName: string; role: string; usable: boolean };

      expect(res.status).toBe(200);
      expect(body.orgName).toBe('Charles Hull Contracting');
      expect(body.role).toBe('candidate');
      expect(body.usable).toBe(true);
    } finally {
      server.close();
    }
  });

  it('reports an expired link as unusable rather than pretending it is fine', async () => {
    mockDbValue = fakeDb({ link: liveLink({ expiresAt: new Date(Date.now() - 1000) }) }).db;
    const { server, base } = startApp();
    try {
      const body = (await (await fetch(`${base}/join/${TOKEN}`)).json()) as {
        usable: boolean;
        reason: string;
      };
      expect(body.usable).toBe(false);
      expect(body.reason).toBe('expired');
    } finally {
      server.close();
    }
  });

  it('404s an unknown token', async () => {
    mockDbValue = fakeDb({ link: undefined }).db;
    const { server, base } = startApp();
    try {
      expect((await fetch(`${base}/join/nope`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe('redeeming a link', () => {
  it('joins as a candidate and counts the use', async () => {
    const f = fakeDb({ link: liveLink(), membership: undefined });
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/join/${TOKEN}/accept`, {
        method: 'POST',
        headers: auth(newcomer),
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ orgId: ORG, role: 'candidate', alreadyMember: false });

      const [, membership] = f.insertValues.mock.calls.find(([t]) => t === schema.memberships)!;
      expect(membership).toMatchObject({ userId: NEWCOMER, orgId: ORG, role: 'candidate', status: 'active' });
      expect(f.updateSet).toHaveBeenCalledWith(schema.orgJoinLinks, expect.anything());
    } finally {
      server.close();
    }
  });

  for (const [label, over, expected] of [
    ['revoked', { active: false }, 'join_link_revoked'],
    ['expired', { expiresAt: new Date(Date.now() - 1000) }, 'join_link_expired'],
    ['exhausted', { maxUses: 5, useCount: 5 }, 'join_link_exhausted'],
  ] as const) {
    it(`refuses a ${label} link`, async () => {
      const f = fakeDb({ link: liveLink(over), membership: undefined });
      mockDbValue = f.db;
      const { server, base } = startApp();
      try {
        const res = await fetch(`${base}/join/${TOKEN}/accept`, {
          method: 'POST',
          headers: auth(newcomer),
        });

        expect(res.status).toBe(409);
        expect(((await res.json()) as { error: string }).error).toBe(expected);
        expect(f.insertValues.mock.calls.find(([t]) => t === schema.memberships)).toBeUndefined();
      } finally {
        server.close();
      }
    });
  }

  it('does not demote an existing member who scans the poster', async () => {
    const f = fakeDb({
      link: liveLink(),
      membership: { id: 'm1', userId: NEWCOMER, orgId: ORG, role: 'assessor', status: 'active' },
    });
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/join/${TOKEN}/accept`, {
        method: 'POST',
        headers: auth(newcomer),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ role: 'assessor', alreadyMember: true });
      // Their membership is untouched — no insert, no role change.
      expect(f.insertValues.mock.calls.find(([t]) => t === schema.memberships)).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('enforces the candidate seat limit on this path too', async () => {
    const f = fakeDb({
      link: liveLink(),
      membership: undefined,
      planTier: 'business',
      candidateSeatLimit: 200,
      activeCandidates: 200,
    });
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/join/${TOKEN}/accept`, {
        method: 'POST',
        headers: auth(newcomer),
      });

      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe('candidate_limit_reached');
      expect(f.insertValues.mock.calls.find(([t]) => t === schema.memberships)).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('requires a session — the token says which org, never who', async () => {
    mockDbValue = fakeDb({ link: liveLink() }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/join/${TOKEN}/accept`, { method: 'POST' });
      expect(res.status).toBe(401);
    } finally {
      server.close();
    }
  });
});

describe('revoking a link', () => {
  it('deactivates rather than deleting, so past joins stay attributable', async () => {
    const f = fakeDb({ link: liveLink() });
    mockDbValue = f.db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/team/join-links/link-1`, {
        method: 'DELETE',
        headers: auth(),
      });

      expect(res.status).toBe(204);
      expect(f.updateSet).toHaveBeenCalledWith(schema.orgJoinLinks, { active: false });
      expect(f.db.delete).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});
