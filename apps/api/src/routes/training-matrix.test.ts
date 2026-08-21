import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@formai/db';

const admin = { userId: 'admin-1', orgId: 'org-1', role: 'admin' as const };
const candidate = { userId: 'cand-1', orgId: 'org-1', role: 'candidate' as const };
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
function authHeader(t: { userId: string; orgId: string; role: string }) {
  return { cookie: `fai_session=${sealSession(t)}` };
}
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

/**
 * Bound parameter values out of a drizzle condition tree (the dashboard.test.ts
 * helper). The org-scoping fixtures below FILTER rows by these, so a route that
 * dropped its orgId or status predicate loses the very rows its test asserts on
 * — leakage is caught by the WHERE the route actually wrote, not by a fake that
 * quietly scopes for it.
 */
function boundParams(cond: unknown): unknown[] {
  const out: unknown[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const rec = node as { queryChunks?: unknown[]; value?: unknown; constructor?: { name?: string } };
    if (Array.isArray(rec.queryChunks)) {
      rec.queryChunks.forEach(walk);
      return;
    }
    if (rec.constructor?.name === 'Param' && 'value' in rec) {
      if (Array.isArray(rec.value)) out.push(...(rec.value as unknown[]));
      else out.push(rec.value);
    }
  };
  walk(cond);
  return out;
}

/*
  Does a WHERE carry an `is null` predicate? Among the scope shapes the
  requirement reads issue, ONLY the org-scope query does (all three scope
  columns null) — this is how the lean fake tells the org read apart and keeps
  role-link fixtures from leaking into it as org-wide rows (the same walker
  compliance.test.ts uses).
*/
const WHERE_SKIP = new Set(['table', 'config', 'encoder', 'decoder', 'session', 'dialect', 'default']);
function hasIsNull(node: unknown, depth = 0): boolean {
  if (!node || typeof node !== 'object' || depth > 12) return false;
  const rec = node as Record<string, unknown>;
  const chunks = rec.queryChunks;
  if (Array.isArray(chunks)) {
    for (const c of chunks) {
      const v = (c as { value?: unknown } | null)?.value;
      if (Array.isArray(v) && v.some((s) => typeof s === 'string' && s.includes('is null'))) return true;
      if (hasIsNull(c, depth + 1)) return true;
    }
    return false;
  }
  for (const [k, v] of Object.entries(rec)) {
    if (WHERE_SKIP.has(k)) continue;
    if (hasIsNull(v, depth + 1)) return true;
  }
  return false;
}

const COMP = 'comp-dozer'; // required via the legacy r1 → t1 derivation, bookable
const COMP_GAP = 'comp-licence'; // required via a direct link, nothing awards it
const COMP_REC = 'comp-heights'; // recommended via a direct link

const grant = (competencyId: string, over: Record<string, unknown> = {}) => ({
  userId: 'u1',
  competencyId,
  grantedAt: daysAgo(400),
  expiresAt: null,
  revokedAt: null,
  sourceCaseId: null,
  licenceNumber: null,
  licenceClass: null,
  importedAt: null,
  ...over,
});

/**
 * Default fixture: one active member (u1 "Bo Worker") holding Role One, whose
 * legacy requirement derives COMP; direct links require COMP_GAP (evidence-only
 * — no tool awards it) and recommend COMP_REC. No location placement, so the
 * default member is the `noLocationPlacement: true` case.
 */
function fakeDb(opts: {
  holders?: unknown[];
  competencies?: Array<Record<string, unknown>>;
  memberships?: Array<Record<string, unknown>>;
  users?: Array<Record<string, unknown>>;
  legacyRequirements?: unknown[];
  roleLinks?: unknown[];
  tools?: unknown[];
  templates?: unknown[];
  membershipLocations?: unknown[];
  locations?: unknown[];
  /** The plan gate reads this; 'team' has no `assessments` feature. */
  planTier?: string;
}) {
  const membershipRows =
    opts.memberships ?? [{ id: 'm1', userId: 'u1', orgId: 'org-1', status: 'active', role: 'viewer' }];
  const userRows = opts.users ?? [{ id: 'u1', name: 'Bo Worker' }];
  const competencyRows = opts.competencies ?? [
    { id: COMP, orgId: 'org-1', name: 'Track Dozer', validForMonths: 36, gracePeriodDays: null, code: 'RIIMPO212E' },
    { id: COMP_GAP, orgId: 'org-1', name: 'Driver Licence', validForMonths: null, gracePeriodDays: null, code: null },
    { id: COMP_REC, orgId: 'org-1', name: 'Working at Heights', validForMonths: 12, gracePeriodDays: null, code: null },
  ];
  const holderRows = (opts.holders ?? []) as Array<Record<string, unknown>>;

  const db = {
    query: {
      organizations: {
        findFirst: vi.fn().mockResolvedValue({ id: 'org-1', planTier: opts.planTier ?? 'enterprise' }),
        // The sources read resolves the ORG NAME for org-scope captions.
        findMany: vi.fn().mockResolvedValue([{ id: 'org-1', name: 'Org One' }]),
      },
      /*
        Org-scoping is enforced BY THE ROUTE'S OWN WHERE: rows survive only if
        the bound params name their orgId (and, on the route's member read,
        'active' → the status filter). A route that forgot either predicate
        gets the wrong rows here and fails the assertions below.
      */
      memberships: {
        findMany: vi.fn((args?: { where?: unknown }) => {
          const params = boundParams(args?.where);
          let rows = membershipRows.filter((r) => params.includes(r.orgId));
          if (params.includes('active')) rows = rows.filter((r) => r.status === 'active');
          return Promise.resolve(rows);
        }),
      },
      users: {
        findMany: vi.fn((args?: { where?: unknown }) => {
          const params = boundParams(args?.where);
          return Promise.resolve(userRows.filter((r) => params.includes(r.id)));
        }),
      },
      competencies: {
        findMany: vi.fn((args?: { where?: unknown }) => {
          const params = boundParams(args?.where);
          return Promise.resolve(competencyRows.filter((r) => params.includes(r.orgId)));
        }),
      },
      competencyHolders: {
        findMany: vi.fn((args?: { where?: unknown }) => {
          const params = boundParams(args?.where);
          return Promise.resolve(holderRows.filter((r) => params.includes(r.userId)));
        }),
      },
      membershipRoles: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ membershipId: 'm1', roleId: 'r1', position: 0, withdrawnAt: null }]),
      },
      jobRoles: {
        findMany: vi.fn().mockResolvedValue([{ id: 'r1', orgId: 'org-1', name: 'Role One', status: 'active' }]),
      },
      membershipLocations: { findMany: vi.fn().mockResolvedValue(opts.membershipLocations ?? []) },
      membershipDepartments: { findMany: vi.fn().mockResolvedValue([]) },
      locations: { findMany: vi.fn().mockResolvedValue(opts.locations ?? []) },
      departments: { findMany: vi.fn().mockResolvedValue([]) },
      roleRequiredAssessments: {
        findMany: vi.fn().mockResolvedValue(
          opts.legacyRequirements ?? [{ orgId: 'org-1', roleId: 'r1', toolId: 't1' }],
        ),
      },
      assessmentTools: {
        findMany: vi.fn().mockResolvedValue(
          opts.tools ?? [
            {
              id: 't1',
              orgId: 'org-1',
              templateId: 'tpl-1',
              awardedCompetencyIds: [COMP],
              createdAt: new Date('2026-01-01T00:00:00Z'),
            },
          ],
        ),
      },
      formTemplates: {
        findMany: vi.fn().mockResolvedValue(
          opts.templates ?? [{ id: 'tpl-1', orgId: 'org-1', currentVersionId: 'v1' }],
        ),
      },
      /*
        Direct requirement links, TIER- and SCOPE-AWARE like the compliance
        fake: the loaders filter tier in the WHERE, and only the org-scope
        read carries an `is null` shape — a mock handing every row to every
        read would let a recommended link count as required.
      */
      competencyRequirements: {
        findMany: vi.fn((args?: { where?: unknown }) => {
          const rows = (opts.roleLinks ?? [
            { orgId: 'org-1', roleId: 'r1', competencyId: COMP_GAP, tier: 'required' },
            { orgId: 'org-1', roleId: 'r1', competencyId: COMP_REC, tier: 'recommended' },
          ]) as { tier?: string }[];
          const seen = new Set<unknown>();
          const stack: unknown[] = [args?.where];
          let tier: string | null = null;
          while (stack.length && !tier) {
            const n = stack.pop();
            if (!n || typeof n !== 'object' || seen.has(n)) continue;
            seen.add(n);
            const rec = n as Record<string, unknown>;
            if (rec.value === 'required' || rec.value === 'recommended') {
              tier = rec.value as string;
              break;
            }
            for (const v of Object.values(rec)) if (v && typeof v === 'object') stack.push(v);
          }
          const byTier = tier ? rows.filter((r) => r.tier === tier) : rows;
          return Promise.resolve(
            hasIsNull(args?.where)
              ? byTier.filter(
                  (r) =>
                    (r as Record<string, unknown>).roleId == null &&
                    (r as Record<string, unknown>).locationId == null &&
                    (r as Record<string, unknown>).departmentId == null,
                )
              : byTier,
          );
        }),
      },
    },
  } as unknown as Db;
  // The route's snapshot AND the resolver's nested one land here; these mocks
  // have no snapshot to isolate, so both just run on the same surface.
  (db as unknown as { transaction: unknown }).transaction = async (
    fn: (tx: unknown) => Promise<unknown>,
  ) => fn(db);
  return db;
}

type Cell = {
  standing: string;
  status?: string;
  expiresAt?: string;
  revoked?: boolean;
  evidence?: string;
  noAward?: boolean;
} | null;
type MemberRow = {
  membershipId: string;
  userId: string;
  name: string;
  role: string;
  locations: Array<{ id: string; name: string }>;
  departments: Array<{ id: string; name: string }>;
  roles: Array<{ id: string; name: string }>;
  noLocationPlacement: boolean;
  cells: Cell[];
};
type Payload = { competencies: Array<{ id: string; name: string }>; members: MemberRow[] };

const getMatrix = async (base: string): Promise<Payload> =>
  (await (await fetch(`${base}/training-matrix`, { headers: authHeader(admin) })).json()) as Payload;

afterEach(() => {
  mockDbValue = null;
  vi.restoreAllMocks();
});

describe('GET /training-matrix (U3)', () => {
  it('401s without a session', async () => {
    mockDbValue = fakeDb({});
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-matrix`);
    expect(res.status).toBe(401);
    server.close();
  });

  it('refuses a non-Admin', async () => {
    mockDbValue = fakeDb({});
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-matrix`, { headers: authHeader(candidate) });
    expect(res.status).toBe(403);
    server.close();
  });

  it('refuses an org whose plan lacks the assessments feature', async () => {
    mockDbValue = fakeDb({ planTier: 'team' });
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-matrix`, { headers: authHeader(admin) });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('feature_not_available');
    server.close();
  });

  it('503s with no database configured', async () => {
    mockDbValue = null;
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-matrix`, { headers: authHeader(admin) });
    expect(res.status).toBe(503);
    server.close();
  });

  it('grids every competency for every member, with held, gap and recommended cells (R2, KTD3)', async () => {
    // u1 holds COMP via an assessment case; COMP_GAP is required and never
    // held; COMP_REC is recommended and not held.
    mockDbValue = fakeDb({ holders: [grant(COMP, { sourceCaseId: 'case-1' })] });
    const { server, base } = startApp();
    const body = await getMatrix(base);

    // Columns are the org's whole list, name-sorted and stable.
    expect(body.competencies.map((c) => c.name)).toEqual([
      'Driver Licence',
      'Track Dozer',
      'Working at Heights',
    ]);

    expect(body.members).toHaveLength(1);
    const member = body.members[0]!;
    expect(member.name).toBe('Bo Worker');
    expect(member.membershipId).toBe('m1');
    // Names beside ids on the display refs — never bare ids (PR #198 rule).
    expect(member.roles).toEqual([{ id: 'r1', name: 'Role One' }]);
    // The default fixture places nobody: raw membership_locations is empty.
    expect(member.noLocationPlacement).toBe(true);

    // cells[i] speaks about competencies[i] — the KTD3 alignment invariant.
    expect(member.cells).toHaveLength(body.competencies.length);
    const cellFor = (id: string): Cell => member.cells[body.competencies.findIndex((c) => c.id === id)]!;

    const held = cellFor(COMP);
    expect(held).toMatchObject({ standing: 'required', status: 'held', evidence: 'assessment' });
    // Derived expiry (grant + 36 months) passes through for client sorting.
    expect(typeof held!.expiresAt).toBe('string');

    const gap = cellFor(COMP_GAP);
    // Required, never held, nothing awards it: a gap cell — standing without
    // status — flagged evidence-only (R7).
    expect(gap).toEqual({ standing: 'required', noAward: true });

    // Recommended and not held: standing only, never a status.
    expect(cellFor(COMP_REC)).toEqual({ standing: 'recommended' });
    server.close();
  });

  it('answers only for the tenant org — a second org contributes no member and no column', async () => {
    mockDbValue = fakeDb({
      memberships: [
        { id: 'm1', userId: 'u1', orgId: 'org-1', status: 'active', role: 'viewer' },
        { id: 'm9', userId: 'u9', orgId: 'org-2', status: 'active', role: 'viewer' },
      ],
      users: [
        { id: 'u1', name: 'Bo Worker' },
        { id: 'u9', name: 'Rival Person' },
      ],
      competencies: [
        { id: COMP, orgId: 'org-1', name: 'Track Dozer', validForMonths: 36, gracePeriodDays: null, code: null },
        { id: 'comp-alien', orgId: 'org-2', name: 'Alien Comp', validForMonths: null, gracePeriodDays: null, code: null },
      ],
    });
    const { server, base } = startApp();
    const body = await getMatrix(base);
    expect(body.members.map((m) => m.name)).toEqual(['Bo Worker']);
    expect(body.competencies.map((c) => c.id)).toEqual([COMP]);
    server.close();
  });

  it('excludes a member whose only membership is not active', async () => {
    mockDbValue = fakeDb({
      memberships: [
        { id: 'm1', userId: 'u1', orgId: 'org-1', status: 'active', role: 'viewer' },
        { id: 'm2', userId: 'u2', orgId: 'org-1', status: 'invited', role: 'viewer' },
      ],
      users: [
        { id: 'u1', name: 'Bo Worker' },
        { id: 'u2', name: 'Ida Invited' },
      ],
    });
    const { server, base } = startApp();
    const body = await getMatrix(base);
    expect(body.members.map((m) => m.name)).toEqual(['Bo Worker']);
    server.close();
  });

  it('answers an org with zero active members with the full shape — columns, no rows', async () => {
    mockDbValue = fakeDb({ memberships: [] });
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-matrix`, { headers: authHeader(admin) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Payload;
    expect(body.members).toEqual([]);
    // Columns still answer: an empty workforce's matrix has headers.
    expect(body.competencies.map((c) => c.id).sort()).toEqual([COMP_GAP, COMP_REC, COMP].sort());
    server.close();
  });

  it('sorts member rows by name', async () => {
    mockDbValue = fakeDb({
      memberships: [
        { id: 'm1', userId: 'u1', orgId: 'org-1', status: 'active', role: 'viewer' },
        { id: 'm2', userId: 'u2', orgId: 'org-1', status: 'active', role: 'viewer' },
      ],
      users: [
        { id: 'u1', name: 'Zed Worker' },
        { id: 'u2', name: 'Abel Yard' },
      ],
    });
    const { server, base } = startApp();
    const body = await getMatrix(base);
    expect(body.members.map((m) => m.name)).toEqual(['Abel Yard', 'Zed Worker']);
    server.close();
  });

  it('does NOT mark a member placed only at a retired location — raw rows count (KTD4)', async () => {
    /*
      The engine books against raw membership_locations rows, whatever the
      location's status (the review-corrected compliance rule): a member
      stranded on a closed site still has a case booked there, so the flag
      may only be true with NO placement rows at all. The active-status
      locations read returns nothing for this site; the raw row still counts.
    */
    mockDbValue = fakeDb({
      membershipLocations: [{ membershipId: 'm1', locationId: 'loc-gone', position: 0 }],
      locations: [], // the value row is retired — no active read answers for it
    });
    const { server, base } = startApp();
    const body = await getMatrix(base);
    expect(body.members[0]!.noLocationPlacement).toBe(false);
    server.close();
  });
});
