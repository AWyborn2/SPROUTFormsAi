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
const daysAhead = (n: number) => new Date(Date.now() + n * 86_400_000);

/*
  Does a WHERE carry an `is null` predicate? Among the four scope shapes the
  requirement reads issue (U2), ONLY the org-scope query does (all three scope
  columns null, KTD1) — so this is how the lean fake below tells the org read
  apart and keeps role-link fixtures from leaking into it as org-wide rows.
  Depth-limited and schema-key-skipping, same as the tier walk.
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
const COMP_OPT = 'comp-optional';
const grant = (competencyId: string, over: Record<string, unknown> = {}) => ({
  userId: 'u1',
  competencyId,
  grantedAt: daysAgo(400),
  expiresAt: null,
  revokedAt: null,
  ...over,
});

/** A member whose Role requires a tool that awards COMP — so COMP is required for u1. */
function fakeDb(opts: {
  holders?: unknown[];
  competencies?: unknown[];
  memberships?: unknown[];
  /** Profiles backing the unreachable read (R99). Default: none marked. */
  profiles?: unknown[];
  /** Overrides the default user row — pass `passwordHash` to give somebody a login. */
  users?: unknown[];
  /** Legacy Role → tool rows. Default: r1 requires t1 (which awards COMP). */
  legacyRequirements?: unknown[];
  /** Direct Role → competency links (KTD1) — the dual read's second half. */
  roleLinks?: unknown[];
  /** The org's tools, for the legacy derivation AND the KTD2 bookability read (U8). */
  tools?: unknown[];
  /** Templates backing the KTD2 published-version filter. Default: t1's is published. */
  templates?: unknown[];
  /** Location placements and their value rows — the unplaced-member marker reads these (U8, KTD4). */
  membershipLocations?: unknown[];
  locations?: unknown[];
}) {
  const db = {
    query: {
      organizations: {
        findFirst: vi.fn().mockResolvedValue({ id: 'org-1', planTier: 'enterprise' }),
        // The U8 sources read resolves the ORG NAME for org-scope captions.
        findMany: vi.fn().mockResolvedValue([{ id: 'org-1', name: 'Org One' }]),
      },
      memberships: {
        findMany: vi.fn().mockResolvedValue(
          opts.memberships ?? [{ id: 'm1', userId: 'u1', orgId: 'org-1', status: 'active' }],
        ),
      },
      membershipRoles: { findMany: vi.fn().mockResolvedValue([{ membershipId: 'm1', roleId: 'r1', withdrawnAt: null }]) },
      // Role NAME rows — the sources read captions role-scope gaps from these.
      jobRoles: {
        findMany: vi.fn().mockResolvedValue([{ id: 'r1', orgId: 'org-1', name: 'Role One', status: 'active' }]),
      },
      // Scope expansion (U2) reads the placement axes and their taxonomy
      // values too; role-shaped fixtures leave them empty — which also means
      // the default member has NO location placement (the U8 marker's case).
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
        No `passwordHash` by default — an invited person who never completed
        their signup. That is the case where the mark alone decides, so the
        fixture starts there and the login case sets one explicitly.
      */
      users: { findMany: vi.fn().mockResolvedValue(opts.users ?? [{ id: 'u1', name: 'Bo Worker' }]) },
      memberProfiles: { findMany: vi.fn().mockResolvedValue(opts.profiles ?? []) },
      competencies: {
        findMany: vi.fn().mockResolvedValue(
          opts.competencies ?? [
            { id: COMP, orgId: 'org-1', name: 'Track Dozer', validForMonths: 36 },
            { id: COMP_OPT, orgId: 'org-1', name: 'First Aid', validForMonths: 36 },
          ],
        ),
      },
      competencyHolders: { findMany: vi.fn().mockResolvedValue(opts.holders ?? []) },
      /*
        The dual read's direct half (KTD1) — TIER-AWARE like the sibling route
        fakes: the loaders filter tier in the WHERE clause, and a mock handing
        every seeded row to both reads would let a recommended link count as
        required, masking exactly the R13/AE4 regression pinned below.
      */
      competencyRequirements: {
        findMany: vi.fn((args?: { where?: unknown }) => {
          const rows = (opts.roleLinks ?? []) as { tier?: string }[];
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
          // SCOPE-AWARE too (U2): the org-scope read is the only one with an
          // `is null` shape, and these role-link fixtures must not answer it —
          // otherwise every seeded role requirement would read as org-wide.
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
  // requiredCompetencyIdsByUser reads inside db.transaction (KTD3); hand the
  // same surface back — these mocks have no snapshot to isolate.
  (db as unknown as { transaction: unknown }).transaction = async (
    fn: (tx: unknown) => Promise<unknown>,
  ) => fn(db);
  return db;
}

afterEach(() => {
  mockDbValue = null;
  vi.restoreAllMocks();
});

describe('GET /compliance (U20)', () => {
  it('reports a required competency that has expired under expired (R101, R102)', async () => {
    mockDbValue = fakeDb({ holders: [grant(COMP, { expiresAt: daysAgo(10) })] });
    const { server, base } = startApp();
    const res = await fetch(`${base}/compliance`, { headers: authHeader(admin) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      expired: Array<{ competencyId: string }>;
      neverHeld: unknown[];
    };
    expect(body.expired.map((g) => g.competencyId)).toEqual([COMP]);
    expect(body.neverHeld).toEqual([]);
    server.close();
  });

  it('reports a required competency inside the 90-day window under expiring, still compliant (AE3)', async () => {
    /*
      `countsAsHeld` treats an expiring grant as current, so before the expiring
      bucket existed this person appeared nowhere until they tipped into
      `expired` — the dashboard tile exists to book them BEFORE that.
    */
    mockDbValue = fakeDb({ holders: [grant(COMP, { expiresAt: daysAhead(40) })] });
    const { server, base } = startApp();
    const res = await fetch(`${base}/compliance`, { headers: authHeader(admin) });
    const body = (await res.json()) as {
      expired: unknown[];
      expiring: Array<{ competencyId: string }>;
      neverHeld: unknown[];
    };
    expect(body.expiring.map((g) => g.competencyId)).toEqual([COMP]);
    expect(body.expired).toEqual([]);
    expect(body.neverHeld).toEqual([]);
    server.close();
  });

  it('lists a grace-period grant under expiring — past its date is the LAST person to hide', async () => {
    /*
      Grace still counts as held (no expired entry), but the person is already
      past their date — the booking surface must show them. Before this, grace
      landed in NO bucket: countsAsHeld swallowed it before expired, and the
      strict === 'expiring' test excluded it, while the Team roster
      simultaneously flagged the same person as needing attention.
    */
    mockDbValue = fakeDb({
      holders: [grant(COMP, { expiresAt: daysAgo(5) })],
      competencies: [
        { id: COMP, orgId: 'org-1', name: 'Track Dozer', validForMonths: 36, gracePeriodDays: 90 },
        { id: COMP_OPT, orgId: 'org-1', name: 'First Aid', validForMonths: 36 },
      ],
    });
    const { server, base } = startApp();
    const res = await fetch(`${base}/compliance`, { headers: authHeader(admin) });
    const body = (await res.json()) as {
      expired: unknown[];
      expiring: Array<{ competencyId: string }>;
    };
    expect(body.expiring.map((g) => g.competencyId)).toEqual([COMP]);
    expect(body.expired).toEqual([]);
    server.close();
  });

  it('does not flag a renewed competency — the best grant decides, not the superseded one', async () => {
    // The old grant expired; the renewal is current for years. History keeps
    // the old row, and reading grants one by one would book this person anyway.
    mockDbValue = fakeDb({
      holders: [
        grant(COMP, { expiresAt: daysAgo(30) }),
        grant(COMP, { expiresAt: daysAhead(1000) }),
      ],
    });
    const { server, base } = startApp();
    const res = await fetch(`${base}/compliance`, { headers: authHeader(admin) });
    const body = (await res.json()) as { expired: unknown[]; expiring: unknown[] };
    expect(body.expiring).toEqual([]);
    expect(body.expired).toEqual([]);
    server.close();
  });

  it('ignores a revoked grant when computing expiring (R107)', async () => {
    mockDbValue = fakeDb({
      holders: [grant(COMP, { expiresAt: daysAhead(40), revokedAt: daysAgo(1) })],
    });
    const { server, base } = startApp();
    const res = await fetch(`${base}/compliance`, { headers: authHeader(admin) });
    const body = (await res.json()) as {
      expiring: unknown[];
      neverHeld: Array<{ competencyId: string }>;
    };
    expect(body.expiring).toEqual([]);
    // A revoked grant confers nothing, so the requirement reads as never held.
    expect(body.neverHeld.map((g) => g.competencyId)).toEqual([COMP]);
    server.close();
  });

  it('keeps an expiring OPTIONAL competency out of every bucket (R102)', async () => {
    mockDbValue = fakeDb({
      holders: [grant(COMP, { expiresAt: daysAhead(400) }), grant(COMP_OPT, { expiresAt: daysAhead(40) })],
    });
    const { server, base } = startApp();
    const res = await fetch(`${base}/compliance`, { headers: authHeader(admin) });
    const body = (await res.json()) as {
      expiring: unknown[];
      optionalLapses: unknown[];
    };
    expect(body.expiring).toEqual([]);
    expect(body.optionalLapses).toEqual([]);
    server.close();
  });

  it('reports a required competency never held under never held, separate from expired (R103)', async () => {
    mockDbValue = fakeDb({ holders: [] }); // holds nothing
    const { server, base } = startApp();
    const res = await fetch(`${base}/compliance`, { headers: authHeader(admin) });
    const body = (await res.json()) as {
      expired: unknown[];
      neverHeld: Array<{ competencyId: string }>;
    };
    expect(body.neverHeld.map((g) => g.competencyId)).toEqual([COMP]);
    expect(body.expired).toEqual([]);
    server.close();
  });

  it('reports an optional lapse separately — not under expired (R102)', async () => {
    // Required COMP is held current; the OPTIONAL comp has lapsed.
    mockDbValue = fakeDb({
      holders: [
        grant(COMP, { expiresAt: daysAhead(200) }), // required, current → compliant
        grant(COMP_OPT, { expiresAt: daysAgo(10) }), // optional, lapsed
      ],
    });
    const { server, base } = startApp();
    const res = await fetch(`${base}/compliance`, { headers: authHeader(admin) });
    const body = (await res.json()) as {
      expired: unknown[];
      neverHeld: unknown[];
      optionalLapses: Array<{ competencyId: string }>;
    };
    expect(body.expired).toEqual([]);
    expect(body.neverHeld).toEqual([]);
    expect(body.optionalLapses.map((g) => g.competencyId)).toEqual([COMP_OPT]);
    server.close();
  });

  it('counts a revoked required competency as not held (R107)', async () => {
    // A grant in date but revoked → not current, and not a date lapse → never held.
    mockDbValue = fakeDb({ holders: [grant(COMP, { expiresAt: daysAhead(200), revokedAt: daysAgo(1) })] });
    const { server, base } = startApp();
    const res = await fetch(`${base}/compliance`, { headers: authHeader(admin) });
    const body = (await res.json()) as {
      expired: unknown[];
      neverHeld: Array<{ competencyId: string }>;
    };
    expect(body.neverHeld.map((g) => g.competencyId)).toEqual([COMP]);
    expect(body.expired).toEqual([]);
    server.close();
  });

  it('does not report a person whose required competency is current', async () => {
    mockDbValue = fakeDb({ holders: [grant(COMP, { expiresAt: daysAhead(200) })] });
    const { server, base } = startApp();
    const res = await fetch(`${base}/compliance`, { headers: authHeader(admin) });
    const body = (await res.json()) as { expired: unknown[]; neverHeld: unknown[] };
    expect(body.expired).toEqual([]);
    expect(body.neverHeld).toEqual([]);
    server.close();
  });

  it('responds with empty sections for an org with no active members', async () => {
    mockDbValue = fakeDb({ memberships: [] });
    const { server, base } = startApp();
    const res = await fetch(`${base}/compliance`, { headers: authHeader(admin) });
    expect(await res.json()).toEqual({ expired: [], expiring: [], neverHeld: [], optionalLapses: [], unreachable: [] });
    server.close();
  });

  it('refuses a non-Admin', async () => {
    mockDbValue = fakeDb({});
    const { server, base } = startApp();
    const res = await fetch(`${base}/compliance`, { headers: authHeader(candidate) });
    expect(res.status).toBe(403);
    server.close();
  });

  describe('the unreachable list (U36, R98, R99)', () => {
    /** Current on the required competency, so no gap competes with the mark. */
    const CURRENT = [grant(COMP, { expiresAt: daysAhead(200) })];
    const marked = { membershipId: 'm1', emailUnreachableAt: daysAgo(2) };

    it('reports a marked address with no login', async () => {
      mockDbValue = fakeDb({ holders: CURRENT, profiles: [marked] });
      const { server, base } = startApp();
      const body = (await (
        await fetch(`${base}/compliance`, { headers: authHeader(admin) })
      ).json()) as { unreachable: Array<{ userId: string; name: string; membershipId: string }> };
      expect(body.unreachable).toEqual([{ userId: 'u1', name: 'Bo Worker', membershipId: 'm1' }]);
      server.close();
    });

    it('does NOT report a marked address where the person holds a login (R98)', async () => {
      /*
        Reachable means EITHER route works. The sweep serves its notice on the
        person's own record whatever the email did, so somebody who signs in has
        been notified — counting them here would report a failure that did not
        occur. They are still on the working list, which asks the different
        question of whether anyone needs chasing.
      */
      mockDbValue = fakeDb({
        holders: CURRENT,
        profiles: [marked],
        users: [{ id: 'u1', name: 'Bo Worker', passwordHash: 'hash' }],
      });
      const { server, base } = startApp();
      const body = (await (
        await fetch(`${base}/compliance`, { headers: authHeader(admin) })
      ).json()) as { unreachable: unknown[] };
      expect(body.unreachable).toEqual([]);
      server.close();
    });

    it('does not report an unmarked address, login or not', async () => {
      mockDbValue = fakeDb({
        holders: CURRENT,
        profiles: [{ membershipId: 'm1', emailUnreachableAt: null }],
      });
      const { server, base } = startApp();
      const body = (await (
        await fetch(`${base}/compliance`, { headers: authHeader(admin) })
      ).json()) as { unreachable: unknown[] };
      expect(body.unreachable).toEqual([]);
      server.close();
    });

    it('is the only entry, with no competency gap beside it (AE56, R99)', async () => {
      // The other half of R16's overlap: this member is the single item on the
      // working list AND the single entry here, and nothing compliance
      // reporting counts about a competency reaches the working list.
      mockDbValue = fakeDb({ holders: CURRENT, profiles: [marked] });
      const { server, base } = startApp();
      const body = (await (
        await fetch(`${base}/compliance`, { headers: authHeader(admin) })
      ).json()) as {
        expired: unknown[];
        neverHeld: unknown[];
        optionalLapses: unknown[];
        unreachable: unknown[];
      };
      expect(body.expired).toEqual([]);
      expect(body.neverHeld).toEqual([]);
      expect(body.optionalLapses).toEqual([]);
      expect(body.unreachable).toHaveLength(1);
      server.close();
    });
  });
});

describe('GET /compliance — read alignment with the KTD2 resolver (U8)', () => {
  const COMP_LICENCE = 'comp-licence';
  type GapRow = { competencyId: string; hasAwardingAssessment: boolean };
  type Report = {
    expired: GapRow[];
    expiring: GapRow[];
    neverHeld: GapRow[];
    optionalLapses: GapRow[];
  };
  const getReport = async (base: string): Promise<Report> =>
    (await (await fetch(`${base}/compliance`, { headers: authHeader(admin) })).json()) as Report;

  it('flags a bookable gap hasAwardingAssessment: true, and an evidence-only licence false (AE1, R7)', async () => {
    // Dozer Operator requires the ATO (tool-awarded) AND a driver's licence
    // nothing awards: the ATO gap is bookable, the licence gap is evidence-based.
    mockDbValue = fakeDb({
      holders: [],
      roleLinks: [{ orgId: 'org-1', roleId: 'r1', competencyId: COMP_LICENCE, tier: 'required' }],
      competencies: [
        { id: COMP, orgId: 'org-1', name: 'Track Dozer', validForMonths: 36 },
        { id: COMP_LICENCE, orgId: 'org-1', name: 'Driver Licence', validForMonths: null },
      ],
    });
    const { server, base } = startApp();
    const body = await getReport(base);
    const byId = new Map(body.neverHeld.map((g) => [g.competencyId, g.hasAwardingAssessment]));
    expect(byId.get(COMP)).toBe(true);
    expect(byId.get(COMP_LICENCE)).toBe(false);
    server.close();
  });

  it('reads a gap whose only awarding tool has NO published version as unbookable (KTD2)', async () => {
    // "Book the assessment" for a tool that cannot carry a case is a dead end;
    // the resolver's published-version filter is what this flag must read.
    mockDbValue = fakeDb({
      holders: [],
      templates: [{ id: 'tpl-1', orgId: 'org-1', currentVersionId: null }],
    });
    const { server, base } = startApp();
    const body = await getReport(base);
    expect(body.neverHeld.map((g) => g.hasAwardingAssessment)).toEqual([false]);
    server.close();
  });

  it('clears an evidence-only gap on an imported grant (R11)', async () => {
    // The licence arrives as an imported LMS grant with its own expiry — the
    // person is compliant, and no bucket names them.
    mockDbValue = fakeDb({
      legacyRequirements: [],
      roleLinks: [{ orgId: 'org-1', roleId: 'r1', competencyId: COMP_LICENCE, tier: 'required' }],
      competencies: [{ id: COMP_LICENCE, orgId: 'org-1', name: 'Driver Licence', validForMonths: null }],
      holders: [grant(COMP_LICENCE, { expiresAt: daysAhead(400) })],
      tools: [],
    });
    const { server, base } = startApp();
    const body = await getReport(base);
    expect(body.expired).toEqual([]);
    expect(body.expiring).toEqual([]);
    expect(body.neverHeld).toEqual([]);
    server.close();
  });

  it('reports identical numbers for a legacy row and its converted link (KTD3 invariant)', async () => {
    // The same requirement, expressed both ways: Role → tool (legacy) versus
    // Role → competency (converted, the tool now awards it). Conversion must
    // not move a single person between buckets — the chips and the tile read
    // this response, so equal buckets IS the pre-inversion match.
    const holders = [grant(COMP, { expiresAt: daysAgo(10) })];
    mockDbValue = fakeDb({ holders }); // legacy: r1 → t1, t1 awards COMP
    let app = startApp();
    const legacy = await getReport(app.base);
    app.server.close();

    mockDbValue = fakeDb({
      holders,
      legacyRequirements: [],
      roleLinks: [{ orgId: 'org-1', roleId: 'r1', competencyId: COMP, tier: 'required' }],
    });
    app = startApp();
    const converted = await getReport(app.base);
    app.server.close();

    expect(converted).toEqual(legacy);
    expect(converted.expired.map((g) => g.competencyId)).toEqual([COMP]);
  });

  it('keeps a RECOMMENDED lapse out of every compliance number — the report is unchanged by recommending (AE4, R13)', async () => {
    // First Aid lapsed, and no Role requires it. Before the recommendation it
    // read as an optional lapse; recommending it must change NOTHING here —
    // recommended never flags compliance, so the two responses are equal.
    const holders = [
      grant(COMP, { expiresAt: daysAhead(400) }), // required, current → compliant
      grant(COMP_OPT, { expiresAt: daysAgo(10) }), // lapsed, never required
    ];
    mockDbValue = fakeDb({ holders });
    let app = startApp();
    const before = await getReport(app.base);
    app.server.close();

    mockDbValue = fakeDb({
      holders,
      roleLinks: [{ orgId: 'org-1', roleId: 'r1', competencyId: COMP_OPT, tier: 'recommended' }],
    });
    app = startApp();
    const after = await getReport(app.base);
    app.server.close();

    expect(after).toEqual(before);
    expect(after.expired).toEqual([]);
    expect(after.optionalLapses.map((g) => g.competencyId)).toEqual([COMP_OPT]);
  });
});

describe('GET /compliance — source scopes and the unplaced-member marker (U8)', () => {
  type SourcedGap = {
    competencyId: string;
    hasAwardingAssessment: boolean;
    sources: Array<{ scope: string; name: string }>;
    noLocationPlacement: boolean;
  };
  type Report = { expired: SourcedGap[]; expiring: SourcedGap[]; neverHeld: SourcedGap[]; optionalLapses: SourcedGap[] };
  const getReport = async (base: string): Promise<Report> =>
    (await (await fetch(`${base}/compliance`, { headers: authHeader(admin) })).json()) as Report;

  it('captions a role-derived gap with its role, legacy derivation included (R5)', async () => {
    // The default fixture is the pre-round shape: r1 → t1 → COMP, no direct
    // link anywhere. R5 allows no requirement without a source, so even the
    // legacy derivation names the role that carries it.
    mockDbValue = fakeDb({ holders: [] });
    const { server, base } = startApp();
    const body = await getReport(base);
    expect(body.neverHeld).toHaveLength(1);
    expect(body.neverHeld[0]!.sources).toEqual([{ scope: 'role', name: 'Role One' }]);
    server.close();
  });

  it('AE6: an org-scope evidence-only requirement gaps with its org source and no booking', async () => {
    // Licence-type competency required org-wide: nothing awards it, so the
    // gap is evidence-based — and its source scope is the organisation.
    const COMP_LICENCE = 'comp-licence';
    mockDbValue = fakeDb({
      holders: [],
      legacyRequirements: [],
      tools: [],
      roleLinks: [
        { orgId: 'org-1', roleId: null, locationId: null, departmentId: null, competencyId: COMP_LICENCE, tier: 'required' },
      ],
      competencies: [{ id: COMP_LICENCE, orgId: 'org-1', name: 'Driver Licence', validForMonths: null }],
    });
    const { server, base } = startApp();
    const body = await getReport(base);
    expect(body.neverHeld).toHaveLength(1);
    expect(body.neverHeld[0]!.competencyId).toBe(COMP_LICENCE);
    expect(body.neverHeld[0]!.hasAwardingAssessment).toBe(false);
    expect(body.neverHeld[0]!.sources).toEqual([{ scope: 'org', name: 'Org One' }]);
    server.close();
  });

  it('AE4: a competency required at org scope AND a role gaps ONCE, carrying both sources', async () => {
    // The union dedupes, so compliance counts one gap — and the row explains
    // itself with every contributing scope rather than picking a winner.
    mockDbValue = fakeDb({
      holders: [],
      legacyRequirements: [],
      tools: [],
      roleLinks: [
        { orgId: 'org-1', roleId: 'r1', locationId: null, departmentId: null, competencyId: COMP, tier: 'required' },
        { orgId: 'org-1', roleId: null, locationId: null, departmentId: null, competencyId: COMP, tier: 'required' },
      ],
      competencies: [{ id: COMP, orgId: 'org-1', name: 'Track Dozer', validForMonths: 36 }],
    });
    const { server, base } = startApp();
    const body = await getReport(base);
    expect(body.neverHeld).toHaveLength(1); // once, not twice
    expect(body.neverHeld[0]!.sources).toEqual([
      { scope: 'org', name: 'Org One' },
      { scope: 'role', name: 'Role One' },
    ]);
    server.close();
  });

  it('marks every gap row of a member with NO location placement as unschedulable (KTD4)', async () => {
    // The assignment engine plans no case with nowhere to assess, so this gap
    // can never book itself — the row must name its own fix (a placement),
    // not sit in "book the assessment" forever.
    mockDbValue = fakeDb({ holders: [] }); // default member: no placement rows
    const { server, base } = startApp();
    const body = await getReport(base);
    expect(body.neverHeld).toHaveLength(1);
    expect(body.neverHeld[0]!.noLocationPlacement).toBe(true);
    server.close();
  });

  it('does not mark a member placed at an ACTIVE location', async () => {
    mockDbValue = fakeDb({
      holders: [],
      membershipLocations: [{ membershipId: 'm1', locationId: 'loc-1' }],
      locations: [{ id: 'loc-1', orgId: 'org-1', name: 'Location A', status: 'active' }],
    });
    const { server, base } = startApp();
    const body = await getReport(base);
    expect(body.neverHeld).toHaveLength(1);
    expect(body.neverHeld[0]!.noLocationPlacement).toBe(false);
    server.close();
  });

  it('still marks a member whose ONLY placement is a retired location — retired confers nothing', async () => {
    /*
      The marker reads the SAME expansion the resolver uses
      (scopeKeysForMemberships), where a retired location has already stopped
      applying — so a member stranded on a closed site reads as unplaced here,
      consistent with the requirement resolution rather than the raw rows.
    */
    mockDbValue = fakeDb({
      holders: [],
      membershipLocations: [{ membershipId: 'm1', locationId: 'loc-gone' }],
      locations: [], // the status='active' read returns nothing for it
    });
    const { server, base } = startApp();
    const body = await getReport(base);
    expect(body.neverHeld[0]!.noLocationPlacement).toBe(true);
    server.close();
  });
});
