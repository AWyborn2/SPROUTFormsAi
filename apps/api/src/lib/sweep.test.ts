import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@formai/db';

// The lib imports `db` for its type only and takes the database as a parameter.
vi.mock('../db.js', () => ({ db: null, getDbStatus: () => 'unconfigured' }));

// Spy on the sender: fail-soft is the sender's own contract; here we assert the
// notice is recorded whatever the send returns, and can force a failed send.
let emailResult = true;
const sendExpiry = vi.fn(async (..._args: unknown[]) => emailResult);
vi.mock('../email/resend.js', () => ({
  sendExpiryNoticeEmail: (...args: unknown[]) => sendExpiry(...args),
}));

const { sweepOrganization, sweepAllOrganizations } = await import('./sweep.js');

const NOW = new Date('2026-08-06T00:00:00Z');
const daysFromNow = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
/** A grant with an explicit expiry `days` from NOW — the override wins over the derived date, so the window is exact. */
const grantExpiringIn = (days: number) => ({ grantedAt: daysFromNow(-100), expiresAt: daysFromNow(days) });

const org = (over: Record<string, unknown> = {}) => ({ id: 'org-1', notificationLeadDays: 30, ...over });
const COMP = { id: 'c1', orgId: 'org-1', name: 'ATO - Track Dozer', validForMonths: 36, gracePeriodDays: null };
const USER = { id: 'u1', email: 'u1@example.com' };

interface DbOpts {
  orgs?: Record<string, unknown>[];
  memberships?: Record<string, unknown>[];
  membershipRoles?: Record<string, unknown>[];
  roleReqs?: Record<string, unknown>[];
  /** Direct scope→competency links (KTD2, four scopes since U2). */
  roleLinks?: Record<string, unknown>[];
  tools?: Record<string, unknown>[];
  templates?: Record<string, unknown>[];
  heldLocations?: Record<string, unknown>[];
  heldDepartments?: Record<string, unknown>[];
  /** Taxonomy value rows — scope expansion joins their status (U4 semantics). */
  locations?: Record<string, unknown>[];
  departments?: Record<string, unknown>[];
  openCases?: Record<string, unknown>[];
  holders?: Record<string, unknown>[];
  comps?: Record<string, unknown>[];
  users?: Record<string, unknown>[];
  /** Profiles backing the unreachable-address read (U36, R98). Default: none marked. */
  profiles?: Record<string, unknown>[];
  holdersFindMany?: () => Promise<Record<string, unknown>[]>;
}

// Walk a drizzle WHERE for its bound string params (depth-limited; the column
// nodes loop back through their table, so schema metadata keys are skipped).
// Just enough for `memberships.findFirst` to pick the RIGHT member when the
// sweep loads several contexts — everything else in this fake stays lean.
const SKIP_KEYS = new Set(['table', 'config', 'encoder', 'decoder', 'session', 'dialect', 'default']);
function stringValues(node: unknown, out: string[] = [], depth = 0): string[] {
  if (!node || depth > 10 || typeof node !== 'object') return out;
  const rec = node as Record<string, unknown>;
  if (typeof rec.value === 'string') out.push(rec.value);
  for (const [k, v] of Object.entries(rec)) {
    if (SKIP_KEYS.has(k)) continue;
    if (Array.isArray(v)) v.forEach((n) => stringValues(n, out, depth + 1));
    else stringValues(v, out, depth + 1);
  }
  return out;
}

function makeDb(opts: DbOpts) {
  const notices: Record<string, unknown>[] = [];
  const cases: Record<string, unknown>[] = [];
  const insert = vi.fn((table: unknown) => ({
    values: (v: Record<string, unknown>) => {
      if (table === schema.sentNotices) notices.push(v);
      else if (table === schema.assessmentCases) cases.push(v);
      const row = { id: `row-${notices.length + cases.length}` };
      return {
        returning: async () => [row],
        // The notice insert claims the window first, then reads back the row it
        // won (or none, on a conflict) — so this returns a builder with its own
        // `.returning`, mirroring the real onConflictDoNothing().returning().
        onConflictDoNothing: () => ({ returning: async () => [row] }),
      };
    },
  }));
  const db = {
    query: {
      organizations: { findMany: async () => opts.orgs ?? [org()] },
      memberships: {
        findMany: async () => opts.memberships ?? [],
        // The assignment pass loads each membership's context BY ID, and the
        // multi-member scenarios below need the right row back — so this one
        // findFirst reads its WHERE's bound params instead of returning [0].
        findFirst: async (args?: { where?: unknown }) => {
          const wanted = new Set(stringValues(args?.where));
          const all = opts.memberships ?? [];
          return all.find((m) => wanted.has(m.id as string)) ?? all[0];
        },
      },
      membershipRoles: { findMany: async () => opts.membershipRoles ?? [] },
      membershipDepartments: { findMany: async () => opts.heldDepartments ?? [] },
      locations: { findMany: async () => opts.locations ?? [] },
      departments: { findMany: async () => opts.departments ?? [] },
      roleRequiredAssessments: { findMany: async () => opts.roleReqs ?? [] },
      // The resolver asks for tier 'required' only (R13); this lean fake does
      // not parse WHEREs, so the load-bearing filter is honoured manually.
      competencyRequirements: {
        findMany: async () => (opts.roleLinks ?? []).filter((l) => l.tier === 'required'),
      },
      assessmentTools: { findMany: async () => opts.tools ?? [] },
      formTemplates: { findMany: async () => opts.templates ?? [] },
      membershipLocations: { findMany: async () => opts.heldLocations ?? [] },
      assessmentCases: { findMany: async () => opts.openCases ?? [] },
      competencyHolders: { findMany: opts.holdersFindMany ?? (async () => opts.holders ?? []) },
      competencies: { findMany: async () => opts.comps ?? [] },
      users: { findMany: async () => opts.users ?? [] },
      memberProfiles: { findMany: async () => opts.profiles ?? [] },
      // Coarse-but-sufficient idempotence: a single-holder run inserts one row,
      // and the next run finds it and skips.
      sentNotices: { findFirst: async () => notices[0] },
    },
    insert,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { db, notices, cases };
}

afterEach(() => {
  emailResult = true;
  vi.clearAllMocks();
});

describe('sweepOrganization — notification pass', () => {
  it('sends ONE notice across two runs in the same window (KTD11 idempotence)', async () => {
    // The failure that matters: a second sweep before the window changes must not
    // double-notify. Run it twice against the SAME live state.
    const { db, notices } = makeDb({
      holders: [{ userId: 'u1', competencyId: 'c1', ...grantExpiringIn(20), revokedAt: null }],
      comps: [COMP],
      users: [USER],
    });

    const first = await sweepOrganization(db, org() as never, NOW);
    const second = await sweepOrganization(db, org() as never, NOW);

    expect(first.noticesSent).toBe(1);
    expect(second.noticesSent).toBe(0);
    expect(notices).toHaveLength(1);
  });

  it('notifies a holder whose competency is inside the lead window (R97, R98)', async () => {
    const { db, notices } = makeDb({
      holders: [{ userId: 'u1', competencyId: 'c1', ...grantExpiringIn(20), revokedAt: null }],
      comps: [COMP],
      users: [USER],
    });
    const result = await sweepOrganization(db, org() as never, NOW);
    expect(result.noticesSent).toBe(1);
    expect(notices[0]).toMatchObject({ userId: 'u1', competencyId: 'c1' });
    expect(sendExpiry).toHaveBeenCalledOnce();
  });

  it('does not notify a holder whose membership here has been deactivated (R65)', async () => {
    // A leaver is swept out of pass 1 too; pass 2 must not mail them expiry
    // notices for a ticket they hold no live seat against.
    const { db, notices } = makeDb({
      holders: [{ userId: 'u1', competencyId: 'c1', ...grantExpiringIn(20), revokedAt: null }],
      comps: [COMP],
      users: [USER],
      memberships: [{ id: 'm1', orgId: 'org-1', userId: 'u1', status: 'suspended' }],
    });
    const result = await sweepOrganization(db, org() as never, NOW);
    expect(result.noticesSent).toBe(0);
    expect(notices).toHaveLength(0);
    expect(sendExpiry).not.toHaveBeenCalled();
  });

  it('notifies an OPTIONAL competency’s holder too — the window does not read standing (R97)', async () => {
    // The notification pass warns any holder in the window; whether a Role
    // requires it is standing's business, not the clock's.
    const { db } = makeDb({
      holders: [{ userId: 'u1', competencyId: 'c1', ...grantExpiringIn(10), revokedAt: null }],
      comps: [COMP],
      users: [USER],
    });
    const result = await sweepOrganization(db, org() as never, NOW);
    expect(result.noticesSent).toBe(1);
  });

  it('does not notify a competency outside the window', async () => {
    const { db } = makeDb({
      holders: [{ userId: 'u1', competencyId: 'c1', ...grantExpiringIn(200), revokedAt: null }],
      comps: [COMP],
      users: [USER],
    });
    const result = await sweepOrganization(db, org() as never, NOW);
    expect(result.noticesSent).toBe(0);
  });

  it('does not notify an already-lapsed competency — that is the assignment pass’s job', async () => {
    const { db } = makeDb({
      holders: [{ userId: 'u1', competencyId: 'c1', ...grantExpiringIn(-5), revokedAt: null }],
      comps: [COMP],
      users: [USER],
    });
    const result = await sweepOrganization(db, org() as never, NOW);
    expect(result.noticesSent).toBe(0);
  });

  it("changing the lead time changes which competencies notify, with no code change (KTD12)", async () => {
    const holders = [{ userId: 'u1', competencyId: 'c1', ...grantExpiringIn(45), revokedAt: null }];
    const short = await sweepOrganization(makeDb({ holders, comps: [COMP], users: [USER] }).db, org({ notificationLeadDays: 30 }) as never, NOW);
    const long = await sweepOrganization(makeDb({ holders, comps: [COMP], users: [USER] }).db, org({ notificationLeadDays: 60 }) as never, NOW);
    expect(short.noticesSent).toBe(0); // 45 days out is outside a 30-day window
    expect(long.noticesSent).toBe(1); // …but inside a 60-day one
  });

  it('records the notice even when the email sender is unconfigured (fail-soft)', async () => {
    emailResult = false; // sender reports a failed/absent send
    const { db, notices } = makeDb({
      holders: [{ userId: 'u1', competencyId: 'c1', ...grantExpiringIn(20), revokedAt: null }],
      comps: [COMP],
      users: [USER],
    });
    const result = await sweepOrganization(db, org() as never, NOW);
    // The login-served record is written regardless — it is the other route.
    expect(result.noticesSent).toBe(1);
    expect(notices).toHaveLength(1);
  });

  it('sends NOTHING to an address marked unreachable, but still records the notice (U36, R98)', async () => {
    /*
      Two separate claims, and both matter.

      Not sending: repeated mail to a dead address is what gets a sender's
      domain marked as a spammer, which would cost every other member their
      notices.

      Still recording: the row IS the login delivery route and the idempotence
      guard. Skipping it would mean a marked member who signs in sees nothing,
      and the next sweep would try the dead address all over again.
    */
    const { db, notices } = makeDb({
      memberships: [{ id: 'm1', orgId: 'org-1', userId: 'u1', status: 'active' }],
      profiles: [{ membershipId: 'm1', emailUnreachableAt: daysFromNow(-5) }],
      holders: [{ userId: 'u1', competencyId: 'c1', ...grantExpiringIn(20), revokedAt: null }],
      comps: [COMP],
      users: [USER],
    });

    const result = await sweepOrganization(db, org() as never, NOW);

    expect(sendExpiry).not.toHaveBeenCalled();
    expect(result.noticesSent).toBe(1);
    expect(notices).toHaveLength(1);
  });

  it('still emails an UNMARKED address belonging to the same organisation', async () => {
    // The skip is per person, not per organisation — one member's dead address
    // must not silence their colleagues.
    const { db } = makeDb({
      memberships: [
        { id: 'm1', orgId: 'org-1', userId: 'u1', status: 'active' },
        { id: 'm2', orgId: 'org-1', userId: 'u2', status: 'active' },
      ],
      profiles: [
        { membershipId: 'm1', emailUnreachableAt: daysFromNow(-5) },
        { membershipId: 'm2', emailUnreachableAt: null },
      ],
      holders: [{ userId: 'u2', competencyId: 'c1', ...grantExpiringIn(20), revokedAt: null }],
      comps: [COMP],
      users: [{ id: 'u2', email: 'u2@example.com' }],
    });

    await sweepOrganization(db, org() as never, NOW);

    expect(sendExpiry).toHaveBeenCalledWith(expect.objectContaining({ to: 'u2@example.com' }));
  });
});

describe('sweepOrganization — assignment pass through the shared resolver (KTD2)', () => {
  it('creates a case from a Role with ONLY a direct competency link — no legacy row anywhere', async () => {
    /*
      The end-to-end proof the resolver swap demands (U3): the sweep reaches
      the engine through assignForMembership, and a Role whose requirement
      exists solely as a competency_requirements row must still assign the
      awarding tool to a holder who lacks the competency. Before the swap this
      exact fixture created nothing — roleRequiredAssessments is empty.
    */
    const { db, cases } = makeDb({
      memberships: [{ id: 'm1', orgId: 'org-1', userId: 'u1', status: 'active' }],
      membershipRoles: [{ membershipId: 'm1', roleId: 'r1', withdrawnAt: null }],
      roleReqs: [], // NO legacy rows — the direct link is the whole requirement
      roleLinks: [{ id: 'l1', orgId: 'org-1', roleId: 'r1', competencyId: 'c1', tier: 'required' }],
      tools: [
        {
          id: 't1',
          orgId: 'org-1',
          templateId: 'tpl1',
          awardedCompetencyIds: ['c1'],
          manifest: { parts: [{ key: 'p1', ordinal: 1, label: 'P1', kind: 'theory', pathways: ['new'] }] },
          locationPartKeys: {},
          assessorStreamCompetencyIds: {},
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
      templates: [{ id: 'tpl1', orgId: 'org-1', currentVersionId: 'v1' }],
      heldLocations: [{ membershipId: 'm1', locationId: 'loc1', position: 0 }],
      holders: [], // u1 holds nothing → the requirement is unmet
      comps: [COMP],
      users: [USER],
    });

    const result = await sweepOrganization(db, org() as never, NOW);

    expect(result.casesCreated).toBe(1);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ toolId: 't1', candidateUserId: 'u1', locationId: 'loc1' });
  });

  it('creates a case for a ROLE-LESS member from a LOCATION-scope requirement (KTD4, R3)', async () => {
    /*
      The scope-inheritance mirror of the direct-link proof above (U3): the
      sweep is the backstop for scope changes, and it only became effective for
      role-less members when KTD4 removed the zero-roles early return. This
      exact fixture — no membership_roles row anywhere, the requirement living
      on the LOCATION the member is placed at — created nothing before U3.
    */
    const { db, cases } = makeDb({
      memberships: [{ id: 'm1', orgId: 'org-1', userId: 'u1', status: 'active' }],
      membershipRoles: [], // holds NOTHING — the placement is the whole reach
      roleLinks: [
        { id: 'l1', orgId: 'org-1', roleId: null, locationId: 'loc1', departmentId: null, competencyId: 'c1', tier: 'required' },
      ],
      locations: [{ id: 'loc1', orgId: 'org-1', status: 'active' }],
      tools: [
        {
          id: 't1',
          orgId: 'org-1',
          templateId: 'tpl1',
          awardedCompetencyIds: ['c1'],
          manifest: { parts: [{ key: 'p1', ordinal: 1, label: 'P1', kind: 'theory', pathways: ['new'] }] },
          locationPartKeys: {},
          assessorStreamCompetencyIds: {},
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
      templates: [{ id: 'tpl1', orgId: 'org-1', currentVersionId: 'v1' }],
      heldLocations: [{ membershipId: 'm1', locationId: 'loc1', position: 0 }],
      holders: [],
      comps: [COMP],
      users: [USER],
    });

    const result = await sweepOrganization(db, org() as never, NOW);

    expect(result.casesCreated).toBe(1);
    expect(cases[0]).toMatchObject({ toolId: 't1', candidateUserId: 'u1', locationId: 'loc1' });
  });

  it('assigns an ORG-scope requirement to EVERY active member (R2 — AE3 reach, sweep side)', async () => {
    // Two members, neither holding a role: the org row reaches them both, and
    // each case lands on its own person.
    const { db, cases } = makeDb({
      memberships: [
        { id: 'm1', orgId: 'org-1', userId: 'u1', status: 'active' },
        { id: 'm2', orgId: 'org-1', userId: 'u2', status: 'active' },
      ],
      membershipRoles: [],
      roleLinks: [
        { id: 'l1', orgId: 'org-1', roleId: null, locationId: null, departmentId: null, competencyId: 'c1', tier: 'required' },
      ],
      locations: [{ id: 'loc1', orgId: 'org-1', status: 'active' }],
      tools: [
        {
          id: 't1',
          orgId: 'org-1',
          templateId: 'tpl1',
          awardedCompetencyIds: ['c1'],
          manifest: { parts: [{ key: 'p1', ordinal: 1, label: 'P1', kind: 'theory', pathways: ['new'] }] },
          locationPartKeys: {},
          assessorStreamCompetencyIds: {},
          createdAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
      templates: [{ id: 'tpl1', orgId: 'org-1', currentVersionId: 'v1' }],
      heldLocations: [
        { membershipId: 'm1', locationId: 'loc1', position: 0 },
        { membershipId: 'm2', locationId: 'loc1', position: 0 },
      ],
      holders: [],
      comps: [COMP],
      users: [USER, { id: 'u2', email: 'u2@example.com' }],
    });

    const result = await sweepOrganization(db, org() as never, NOW);

    expect(result.casesCreated).toBe(2);
    expect(cases.map((c) => c.candidateUserId).sort()).toEqual(['u1', 'u2']);
  });
});

describe('sweepAllOrganizations', () => {
  it('sweeps every org and isolates a failure so one bad org does not stop the rest (KTD11)', async () => {
    const holdersFindMany = vi
      .fn()
      .mockResolvedValueOnce([{ userId: 'u1', competencyId: 'c1', ...grantExpiringIn(20), revokedAt: null }])
      .mockRejectedValueOnce(new Error('org-2 blew up'));
    const { db } = makeDb({
      orgs: [org({ id: 'org-1' }), org({ id: 'org-2' })],
      comps: [COMP],
      users: [USER],
      holdersFindMany,
    });
    const results = await sweepAllOrganizations(db, NOW);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ orgId: 'org-1', noticesSent: 1 });
    expect(results[1]).toMatchObject({ orgId: 'org-2', failed: true });
  });

  it('sweeps a newly created org with no registration step', async () => {
    // The only source of orgs is a findMany over the table, so a new org is in
    // the next call by construction.
    const { db } = makeDb({ orgs: [org({ id: 'brand-new' })] });
    const results = await sweepAllOrganizations(db, NOW);
    expect(results.map((r) => r.orgId)).toEqual(['brand-new']);
  });
});
