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
const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);
const daysAhead = (n: number) => new Date(Date.now() + n * DAY_MS);
const dateStr = (d: Date) => d.toISOString().slice(0, 10);
/** UTC Monday of the ISO week containing `d` — the route's bucketing clock,
 * restated here so the tests compute EXPECTED buckets rather than trusting
 * whichever weekday the suite happens to run on. */
const weekStartStr = (d: Date) => {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  return dateStr(new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY_MS));
};

/*
  Does a WHERE carry an `is null` predicate? Among the four scope shapes the
  requirement reads issue, ONLY the org-scope query does (all three scope
  columns null) — the same lean-fake discrimination compliance.test.ts uses,
  so scoped link fixtures cannot leak into the org read as org-wide rows.
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

const COMP = 'comp-required';
const COMP_LICENCE = 'comp-licence';
/** Valid uuids — the scope query params are zod-validated as uuid. */
const LOC = '11111111-1111-1111-1111-111111111111';
const DEPT = '22222222-2222-2222-2222-222222222222';
const UNKNOWN = '99999999-9999-9999-9999-999999999999';

/** An org-scope required link — the all-null shape the org read answers. */
const orgLink = (competencyId: string, tier = 'required') => ({
  orgId: 'org-1',
  roleId: null,
  locationId: null,
  departmentId: null,
  competencyId,
  tier,
});
const member = (n: number) => ({ id: `m${n}`, userId: `u${n}`, orgId: 'org-1', status: 'active' });
const grant = (userId: string, competencyId: string, over: Record<string, unknown> = {}) => ({
  userId,
  competencyId,
  grantedAt: daysAgo(100),
  expiresAt: null,
  revokedAt: null,
  ...over,
});

/**
 * Bound `YYYY-MM-DD` params inside a drizzle condition AST — enough for the
 * fake to apply the route's capturedOn range the way Postgres would, without
 * modelling the whole where clause.
 */
function boundDateParams(cond: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const rec = node as { queryChunks?: unknown[]; value?: unknown };
    if (Array.isArray(rec.queryChunks)) {
      rec.queryChunks.forEach(walk);
      return;
    }
    if (typeof rec.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rec.value)) out.push(rec.value);
  };
  walk(cond);
  return out;
}

function fakeDb(opts: {
  planTier?: string;
  memberships?: unknown[];
  membershipLocations?: unknown[];
  membershipDepartments?: unknown[];
  membershipRoles?: unknown[];
  locations?: unknown[];
  departments?: unknown[];
  jobRoles?: unknown[];
  /** Direct scope → competency links; the fake honours tier AND org-shape. */
  roleLinks?: unknown[];
  legacyRequirements?: unknown[];
  tools?: unknown[];
  templates?: unknown[];
  holders?: unknown[];
  competencies?: unknown[];
  /** Cases; the route's `isNotNull(signedOffAt)` is honoured manually. */
  cases?: Array<Record<string, unknown>>;
  /** Snapshot rows; the route's `isNull(scopeType)` is honoured manually. */
  snapshots?: Array<Record<string, unknown>>;
}) {
  const db = {
    query: {
      organizations: {
        findFirst: vi.fn().mockResolvedValue({ id: 'org-1', planTier: opts.planTier ?? 'enterprise' }),
      },
      memberships: { findMany: vi.fn().mockResolvedValue(opts.memberships ?? [member(1)]) },
      membershipLocations: { findMany: vi.fn().mockResolvedValue(opts.membershipLocations ?? []) },
      membershipDepartments: { findMany: vi.fn().mockResolvedValue(opts.membershipDepartments ?? []) },
      membershipRoles: { findMany: vi.fn().mockResolvedValue(opts.membershipRoles ?? []) },
      locations: { findMany: vi.fn().mockResolvedValue(opts.locations ?? []) },
      departments: { findMany: vi.fn().mockResolvedValue(opts.departments ?? []) },
      jobRoles: { findMany: vi.fn().mockResolvedValue(opts.jobRoles ?? []) },
      roleRequiredAssessments: { findMany: vi.fn().mockResolvedValue(opts.legacyRequirements ?? []) },
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
      competencies: {
        findMany: vi.fn().mockResolvedValue(
          opts.competencies ?? [
            { id: COMP, orgId: 'org-1', name: 'Track Dozer', code: null, validForMonths: 36 },
            { id: COMP_LICENCE, orgId: 'org-1', name: 'Driver Licence', code: null, validForMonths: null },
          ],
        ),
      },
      competencyHolders: { findMany: vi.fn().mockResolvedValue(opts.holders ?? []) },
      // TIER- and SCOPE-aware, exactly like the compliance fake: the loaders
      // filter tier and the org-shape in the WHERE, and a mock that handed
      // every row to every read would count a scoped link org-wide.
      competencyRequirements: {
        findMany: vi.fn((args?: { where?: unknown }) => {
          const rows = (opts.roleLinks ?? []) as Record<string, unknown>[];
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
              ? byTier.filter((r) => r.roleId == null && r.locationId == null && r.departmentId == null)
              : byTier,
          );
        }),
      },
      // The route filters `isNotNull(signedOffAt)` in SQL; the lean fake
      // honours the load-bearing predicate manually.
      assessmentCases: {
        findMany: vi.fn(async () => (opts.cases ?? []).filter((c) => c.signedOffAt != null)),
      },
      // Same posture for `isNull(scopeType)` — org rows only. The route now
      // bounds the read at the query (gte on capturedOn), so the fake honours
      // the bound date param the same way Postgres would.
      complianceSnapshots: {
        findMany: vi.fn(async (args?: { where?: unknown }) => {
          const cutoff = boundDateParams(args?.where)[0];
          return (opts.snapshots ?? []).filter(
            (r) =>
              r.scopeType == null &&
              (cutoff === undefined || (typeof r.capturedOn === 'string' && r.capturedOn >= cutoff)),
          );
        }),
      },
    },
  } as unknown as Db;
  // The route wraps its expansion in one repeatable-read transaction and the
  // standing loader nests inside it; the fake has no snapshot to isolate.
  (db as unknown as { transaction: unknown }).transaction = async (
    fn: (tx: unknown) => Promise<unknown>,
  ) => fn(db);
  return db;
}

afterEach(() => {
  mockDbValue = null;
  vi.restoreAllMocks();
});

interface SummaryBody {
  scope: { type: string; id?: string; name?: string };
  compliance: { compliantCount: number; memberCount: number };
  expiring: { in30: number; in60: number; in90: number };
  gaps: {
    total: number;
    evidenceOnly: number;
    byCompetency: Array<{ competencyId: string; name: string; count: number }>;
  };
  complianceByGroup: {
    axis: string;
    groups: Array<{ id: string; name: string; memberCount: number; compliantCount: number }>;
  };
  signOffs: {
    weeks: Array<{ weekStart: string; count: number; currentWeek?: boolean }>;
    currentWeek: number;
    priorFullWeek: number;
  };
  trend: {
    scope: string;
    points: Array<{ capturedOn: string; requiredGapCount: number }>;
    gapDelta: number | null;
  };
}
const getSummary = async (base: string, qs = ''): Promise<SummaryBody> =>
  (await (await fetch(`${base}/training-summary${qs}`, { headers: authHeader(admin) })).json()) as SummaryBody;

describe('GET /training-summary — gates (KTD2)', () => {
  it('401s an unauthenticated request', async () => {
    mockDbValue = fakeDb({});
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-summary`);
    expect(res.status).toBe(401);
    server.close();
  });

  it('403s a non-admin member', async () => {
    mockDbValue = fakeDb({});
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-summary`, { headers: authHeader(candidate) });
    expect(res.status).toBe(403);
    server.close();
  });

  it('403s an org whose plan lacks the assessments feature', async () => {
    mockDbValue = fakeDb({ planTier: 'team' });
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-summary`, { headers: authHeader(admin) });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('feature_not_available');
    server.close();
  });

  it('503s with no database configured', async () => {
    mockDbValue = null;
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-summary`, { headers: authHeader(admin) });
    expect(res.status).toBe(503);
    server.close();
  });
});

describe('GET /training-summary — KPIs from the shared derivation (R10, R17)', () => {
  it('counts a member with ONE required gap out of compliant, and the gap as evidence-only when nothing awards it', async () => {
    // Two org-wide requirements: COMP (tool t1 awards it, bookable) and the
    // licence (nothing awards it, R7). u1 holds only COMP → one open gap, not
    // compliant; u2 holds both → compliant. The gap competency is the licence,
    // so the whole gap count is evidence-only.
    mockDbValue = fakeDb({
      memberships: [member(1), member(2)],
      roleLinks: [orgLink(COMP), orgLink(COMP_LICENCE)],
      holders: [
        grant('u1', COMP, { expiresAt: daysAhead(400) }),
        grant('u2', COMP, { expiresAt: daysAhead(400) }),
        grant('u2', COMP_LICENCE, { expiresAt: daysAhead(400) }),
      ],
    });
    const { server, base } = startApp();
    const body = await getSummary(base);
    expect(body.compliance).toEqual({ compliantCount: 1, memberCount: 2 });
    expect(body.gaps.total).toBe(1);
    expect(body.gaps.evidenceOnly).toBe(1);
    expect(body.gaps.byCompetency).toEqual([
      { competencyId: COMP_LICENCE, name: 'Driver Licence', count: 1 },
    ]);
    server.close();
  });

  it('buckets expiring grants CUMULATIVELY at 30/60/90 days (30 ⊆ 60 ⊆ 90)', async () => {
    // Three members, all required to hold COMP, expiring 20/50/80 days out.
    // Expiring still counts as held, so all three stay compliant — the buckets
    // are the early-warning surface, not a compliance failure.
    mockDbValue = fakeDb({
      memberships: [member(1), member(2), member(3)],
      roleLinks: [orgLink(COMP)],
      holders: [
        grant('u1', COMP, { expiresAt: daysAhead(20) }),
        grant('u2', COMP, { expiresAt: daysAhead(50) }),
        grant('u3', COMP, { expiresAt: daysAhead(80) }),
      ],
    });
    const { server, base } = startApp();
    const body = await getSummary(base);
    expect(body.expiring).toEqual({ in30: 1, in60: 2, in90: 3 });
    expect(body.compliance).toEqual({ compliantCount: 3, memberCount: 3 });
    expect(body.gaps.total).toBe(0);
    server.close();
  });

  it('responds the FULL payload shape with zeroed KPIs for an org with no active members', async () => {
    mockDbValue = fakeDb({ memberships: [] });
    const { server, base } = startApp();
    const body = await getSummary(base);
    expect(body.compliance).toEqual({ compliantCount: 0, memberCount: 0 }); // 0/0 — client renders 0%, never NaN
    expect(body.expiring).toEqual({ in30: 0, in60: 0, in90: 0 });
    expect(body.gaps).toEqual({ total: 0, evidenceOnly: 0, byCompetency: [] });
    expect(body.complianceByGroup).toEqual({ axis: 'department', groups: [] });
    expect(body.signOffs.weeks).toHaveLength(8);
    expect(body.signOffs.weeks.every((w) => w.count === 0)).toBe(true);
    expect(body.trend).toEqual({ scope: 'org', points: [], gapDelta: null });
    server.close();
  });
});

describe('GET /training-summary — scope (R12)', () => {
  const scopedFixture = () =>
    fakeDb({
      memberships: [member(1), member(2)],
      membershipDepartments: [{ membershipId: 'm1', departmentId: DEPT }],
      departments: [{ id: DEPT, orgId: 'org-1', name: 'Crew A', status: 'active' }],
      roleLinks: [orgLink(COMP)],
      holders: [grant('u2', COMP, { expiresAt: daysAhead(400) })], // u1 gaps, u2 compliant
    });

  it('recomputes over only the members placed in the scoped department', async () => {
    // Org-wide: 1 of 2 compliant. Scoped to Crew A, only u1 (the gapped one)
    // is placed there — the numbers must be the crew's, not the org's.
    mockDbValue = scopedFixture();
    const { server, base } = startApp();
    const body = await getSummary(base, `?department=${DEPT}`);
    expect(body.scope).toEqual({ type: 'department', id: DEPT, name: 'Crew A' });
    expect(body.compliance).toEqual({ compliantCount: 0, memberCount: 1 });
    expect(body.gaps.total).toBe(1);
    expect(body.complianceByGroup.axis).toBe('department');
    expect(body.complianceByGroup.groups).toEqual([
      { id: DEPT, name: 'Crew A', memberCount: 1, compliantCount: 0 },
    ]);
    // The trend stays ORG grain whatever the scope, and says so (R12).
    expect(body.trend.scope).toBe('org');
    server.close();
  });

  it('400s when BOTH scope params are supplied — they are mutually exclusive', async () => {
    mockDbValue = scopedFixture();
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-summary?location=${LOC}&department=${DEPT}`, {
      headers: authHeader(admin),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_scope');
    server.close();
  });

  it('400s an unknown scope id rather than reporting confidently about nothing', async () => {
    mockDbValue = scopedFixture();
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-summary?department=${UNKNOWN}`, {
      headers: authHeader(admin),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('unknown_scope');
    server.close();
  });
});

describe('GET /training-summary — group axis (R11)', () => {
  const ROLE = '33333333-3333-3333-3333-333333333333';
  const ROLE_RETIRED = '44444444-4444-4444-4444-444444444444';

  it('?axis=role groups by held roles and keeps a RETIRED-but-held role on the chart', async () => {
    // u1 holds an active role and gaps; u2 holds a RETIRED role and is
    // compliant. Roles chart with ANY status (a retired-but-held role still
    // contributes requirements — the U4 split), unlike location/department.
    mockDbValue = fakeDb({
      memberships: [member(1), member(2)],
      membershipRoles: [
        { membershipId: 'm1', roleId: ROLE, withdrawnAt: null },
        { membershipId: 'm2', roleId: ROLE_RETIRED, withdrawnAt: null },
      ],
      jobRoles: [
        { id: ROLE, orgId: 'org-1', name: 'Dozer Operator', status: 'active' },
        { id: ROLE_RETIRED, orgId: 'org-1', name: 'Tip Head Spotter', status: 'retired' },
      ],
      roleLinks: [orgLink(COMP)],
      holders: [grant('u2', COMP, { expiresAt: daysAhead(400) })],
    });
    const { server, base } = startApp();
    const body = await getSummary(base, '?axis=role');
    expect(body.complianceByGroup.axis).toBe('role');
    expect(body.complianceByGroup.groups).toEqual([
      { id: ROLE, name: 'Dozer Operator', memberCount: 1, compliantCount: 0 },
      { id: ROLE_RETIRED, name: 'Tip Head Spotter', memberCount: 1, compliantCount: 1 },
    ]);
    server.close();
  });

  it('?axis=location groups by placement and drops a retired location from the chart', async () => {
    const LOC_RETIRED = '55555555-5555-5555-5555-555555555555';
    mockDbValue = fakeDb({
      memberships: [member(1), member(2)],
      membershipLocations: [
        { membershipId: 'm1', locationId: LOC, position: 0 },
        { membershipId: 'm2', locationId: LOC_RETIRED, position: 0 },
      ],
      locations: [
        { id: LOC, orgId: 'org-1', name: 'Boddington', status: 'active' },
        { id: LOC_RETIRED, orgId: 'org-1', name: 'Old Pit', status: 'retired' },
      ],
      roleLinks: [orgLink(COMP)],
      holders: [grant('u1', COMP, { expiresAt: daysAhead(400) })],
    });
    const { server, base } = startApp();
    const body = await getSummary(base, '?axis=location');
    expect(body.complianceByGroup.axis).toBe('location');
    // Only the ACTIVE location charts; its one placed member is compliant.
    // m2's retired site confers nothing and charting it would resurrect it.
    expect(body.complianceByGroup.groups).toEqual([
      { id: LOC, name: 'Boddington', memberCount: 1, compliantCount: 1 },
    ]);
    server.close();
  });
});

describe('GET /training-summary — sign-off throughput (R10, R11)', () => {
  it('buckets sign-offs into their ISO weeks and excludes an invalidated case', async () => {
    // Signed 3 and 10 days ago — exactly a week apart, so ALWAYS different ISO
    // weeks whatever weekday the suite runs on. The invalidated case signed 3
    // days ago must not count: its sign-off no longer stands.
    mockDbValue = fakeDb({
      memberships: [member(1)],
      cases: [
        { id: 'c-a', orgId: 'org-1', candidateUserId: 'u1', state: 'competent', signedOffAt: daysAgo(3) },
        { id: 'c-b', orgId: 'org-1', candidateUserId: 'u1', state: 'closed', signedOffAt: daysAgo(10) },
        { id: 'c-x', orgId: 'org-1', candidateUserId: 'u1', state: 'invalidated', signedOffAt: daysAgo(3) },
      ],
    });
    const { server, base } = startApp();
    const body = await getSummary(base);

    expect(body.signOffs.weeks).toHaveLength(8);
    const byWeek = new Map(body.signOffs.weeks.map((w) => [w.weekStart, w.count]));
    expect(byWeek.get(weekStartStr(daysAgo(3)))).toBe(1);
    expect(byWeek.get(weekStartStr(daysAgo(10)))).toBe(1);
    expect(body.signOffs.weeks.reduce((sum, w) => sum + w.count, 0)).toBe(2);

    // The last bucket is the current week TO DATE, labelled, and the delta
    // inputs are that bucket and the one before it — the chart's "now" column
    // and the KPI card must be reading the same numbers.
    const last = body.signOffs.weeks[7]!;
    expect(last.currentWeek).toBe(true);
    expect(last.weekStart).toBe(weekStartStr(new Date()));
    expect(body.signOffs.currentWeek).toBe(last.count);
    expect(body.signOffs.priorFullWeek).toBe(body.signOffs.weeks[6]!.count);
    server.close();
  });
});

describe('GET /training-summary — trend and gap delta (R11, KTD5)', () => {
  it('returns an empty trend and a null gap delta with zero snapshots', async () => {
    mockDbValue = fakeDb({
      memberships: [member(1)],
      roleLinks: [orgLink(COMP)],
      holders: [],
    });
    const { server, base } = startApp();
    const body = await getSummary(base);
    expect(body.trend.points).toEqual([]);
    expect(body.trend.gapDelta).toBeNull();
    server.close();
  });

  it('reads ORG rows for the trend window and deltas gaps against the snapshot ~30 days back', async () => {
    // u1 gaps COMP today (1 open gap); the org snapshot 30 days ago recorded 0
    // → delta +1. The scoped row and the 200-day-old row must not appear in
    // the trend points; the recent org rows sort ascending.
    mockDbValue = fakeDb({
      memberships: [member(1)],
      roleLinks: [orgLink(COMP)],
      holders: [],
      snapshots: [
        { orgId: 'org-1', capturedOn: dateStr(daysAgo(5)), scopeType: null, scopeId: null, compliantCount: 0, memberCount: 1, requiredGapCount: 2 },
        { orgId: 'org-1', capturedOn: dateStr(daysAgo(30)), scopeType: null, scopeId: null, compliantCount: 1, memberCount: 1, requiredGapCount: 0 },
        { orgId: 'org-1', capturedOn: dateStr(daysAgo(10)), scopeType: 'location', scopeId: LOC, compliantCount: 0, memberCount: 1, requiredGapCount: 5 },
        { orgId: 'org-1', capturedOn: dateStr(daysAgo(200)), scopeType: null, scopeId: null, compliantCount: 0, memberCount: 1, requiredGapCount: 9 },
      ],
    });
    const { server, base } = startApp();
    const body = await getSummary(base);
    expect(body.trend.points.map((p) => p.capturedOn)).toEqual([
      dateStr(daysAgo(30)),
      dateStr(daysAgo(5)),
    ]);
    expect(body.trend.gapDelta).toBe(1); // 1 open gap now − 0 in the 30-day-old snapshot
    server.close();
  });
});
