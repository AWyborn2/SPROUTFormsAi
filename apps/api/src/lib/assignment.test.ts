import { afterEach, describe, expect, it, vi } from 'vitest';

// The wrapper imports `db` for its type only and takes the database as a
// parameter, so a null module db is all this needs — every test passes its own.
vi.mock('../db.js', () => ({ db: null, getDbStatus: () => 'unconfigured' }));

const { assignForMembership, assignForRole } = await import('./assignment.js');

const ORG = 'org-1';
const USER = 'user-1';
const NOW = new Date('2026-06-01T00:00:00Z');

type Rows = Record<string, Record<string, unknown>[]>;

/** A throwaway database over fixed table contents; records inserted cases. */
function makeDb(rows: Rows) {
  const created: Record<string, unknown>[] = [];
  const table = (name: string) => ({
    findMany: async () => rows[name] ?? [],
    findFirst: async () => (rows[name] ?? [])[0],
  });
  const db = {
    query: {
      memberships: table('memberships'),
      membershipRoles: table('membershipRoles'),
      roleRequiredAssessments: table('roleRequiredAssessments'),
      /*
        The dual read's second half (KTD2): direct competency links, resolved
        to their awarding tool by the shared resolver. The tier predicate is
        load-bearing (R13) — the resolver asks for 'required' only, and a
        double returning every link would let a recommended link assign a case
        with the filter deleted — so it is honoured manually, like the
        in-flight case read below.
      */
      competencyRequirements: {
        findMany: async () =>
          (rows.competencyRequirements ?? []).filter((l) => l.tier === 'required'),
        findFirst: async () => (rows.competencyRequirements ?? [])[0],
      },
      assessmentTools: table('assessmentTools'),
      formTemplates: table('formTemplates'),
      membershipLocations: table('membershipLocations'),
      /*
        The ONE read here that must honour its predicate. The loader asks for
        cases in flight — `open` and `awaiting_sign_off` — and the skip rule is
        built on the answer, so a double returning every case regardless would
        report a finished or invalidated one as blocking and let the idempotence
        assertions pass against a query that had lost its filter.
      */
      assessmentCases: {
        findMany: async () =>
          (rows.assessmentCases ?? []).filter(
            (c) => c.state === 'open' || c.state === 'awaiting_sign_off',
          ),
        findFirst: async () => (rows.assessmentCases ?? [])[0],
      },
      competencyHolders: table('competencyHolders'),
      competencies: table('competencies'),
    },
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        returning: async () => {
          const row = { id: `case-${created.length + 1}`, ...v };
          created.push(row);
          return [row];
        },
      }),
    }),
  };
  return { db: db as unknown as Parameters<typeof assignForMembership>[0], created };
}

const MANIFEST = { parts: [{ key: 'p1', ordinal: 1, label: 'P1', kind: 'theory', pathways: ['new'] }] };

/** A world where user-1 holds Role r1, which requires tool t1 (awards comp c1). */
function baseRows(over: Partial<Rows> = {}): Rows {
  return {
    memberships: [{ id: 'm1', orgId: ORG, userId: USER }],
    membershipRoles: [{ membershipId: 'm1', roleId: 'r1', withdrawnAt: null }],
    roleRequiredAssessments: [{ orgId: ORG, roleId: 'r1', toolId: 't1' }],
    assessmentTools: [
      {
        id: 't1',
        orgId: ORG,
        templateId: 'tpl1',
        awardedCompetencyIds: ['c1'],
        manifest: MANIFEST,
        locationPartKeys: {},
        assessorStreamCompetencyIds: {},
      },
    ],
    formTemplates: [{ id: 'tpl1', orgId: ORG, currentVersionId: 'v1' }],
    membershipLocations: [{ membershipId: 'm1', locationId: 'loc1', position: 0 }],
    assessmentCases: [],
    competencyHolders: [],
    competencies: [],
    ...over,
  };
}

afterEach(() => vi.clearAllMocks());

describe('assignForMembership', () => {
  it('creates an unowned case at the membership Location for an unmet requirement', async () => {
    const { db, created } = makeDb(baseRows());
    const result = await assignForMembership(db, ORG, 'm1', NOW);

    expect(result.createdCaseIds).toHaveLength(1);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      toolId: 't1',
      candidateUserId: USER,
      locationId: 'loc1',
      assessorUserId: null, // unowned (R61)
      pathway: 'new',
      currentVersionId: 'v1',
    });
  });

  it('creates nothing when an open case for the tool already exists (idempotence, KTD16)', async () => {
    const { db, created } = makeDb(
      baseRows({ assessmentCases: [{ id: 'c-open', orgId: ORG, candidateUserId: USER, toolId: 't1', state: 'open' }] }),
    );
    const result = await assignForMembership(db, ORG, 'm1', NOW);

    expect(result.createdCaseIds).toEqual([]);
    expect(created).toHaveLength(0);
  });

  it('assigns nothing to a DEACTIVATED member (R64)', async () => {
    /*
      Four callers reach the engine and only a direct assign has somebody on the
      other end to be told. A leaver whose old Role gains a requirement would
      otherwise be handed an assessment they cannot sign in to take — which then
      reads as outstanding on the compliance report for as long as R63 retains
      the record, which is forever.
    */
    const { db, created } = makeDb(
      baseRows({ memberships: [{ id: 'm1', orgId: ORG, userId: USER, status: 'suspended' }] }),
    );
    const result = await assignForMembership(db, ORG, 'm1', NOW);

    expect(result.createdCaseIds).toEqual([]);
    expect(created).toHaveLength(0);
  });

  it('starts a FRESH case where the previous one was invalidated by a deactivation (R74)', async () => {
    // The returner's abandoned case is history, not work in progress. It must
    // not block the new one, and the new one must not resume it.
    const { db, created } = makeDb(
      baseRows({
        assessmentCases: [
          { id: 'c-dead', orgId: ORG, candidateUserId: USER, toolId: 't1', state: 'invalidated' },
        ],
      }),
    );
    const result = await assignForMembership(db, ORG, 'm1', NOW);

    expect(result.createdCaseIds).toHaveLength(1);
    expect(created[0]).toMatchObject({ toolId: 't1', candidateUserId: USER });
    // A new row, not the abandoned one revived.
    expect(created[0]?.id).not.toBe('c-dead');
  });

  it('creates nothing when the person already holds the awarded competency, current (R45)', async () => {
    const { db, created } = makeDb(
      baseRows({
        competencyHolders: [
          { competencyId: 'c1', userId: USER, orgId: ORG, grantedAt: new Date('2025-01-01'), expiresAt: null, revokedAt: null },
        ],
        competencies: [{ id: 'c1', orgId: ORG, validForMonths: null, gracePeriodDays: null }],
      }),
    );
    const result = await assignForMembership(db, ORG, 'm1', NOW);

    expect(result.createdCaseIds).toEqual([]);
    expect(created).toHaveLength(0);
  });

  it('creates a case when the held competency has expired (R46)', async () => {
    const { db, created } = makeDb(
      baseRows({
        competencyHolders: [
          // Granted two years ago on a one-year ticket — expired, no grace.
          { competencyId: 'c1', userId: USER, orgId: ORG, grantedAt: new Date('2024-01-01'), expiresAt: null, revokedAt: null },
        ],
        competencies: [{ id: 'c1', orgId: ORG, validForMonths: 12, gracePeriodDays: null }],
      }),
    );
    const result = await assignForMembership(db, ORG, 'm1', NOW);

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ toolId: 't1' });
  });

  it('skips a tool whose template has no published version', async () => {
    const { db, created } = makeDb(baseRows({ formTemplates: [{ id: 'tpl1', orgId: ORG, currentVersionId: null }] }));
    const result = await assignForMembership(db, ORG, 'm1', NOW);

    expect(result.createdCaseIds).toEqual([]);
    expect(created).toHaveLength(0);
  });

  it('assigns nothing when the membership holds no Role', async () => {
    const { db, created } = makeDb(baseRows({ membershipRoles: [] }));
    const result = await assignForMembership(db, ORG, 'm1', NOW);

    expect(result.createdCaseIds).toEqual([]);
    expect(created).toHaveLength(0);
  });

  it('assigns from a DIRECT competency link with no legacy row at all (KTD2, R9)', async () => {
    // The inverted world: the Role names the competency, and the tool is
    // derived through the shared resolver (t1 awards c1, published template).
    // Before the resolver swap this membership had NO roleRequiredAssessments
    // row and assignForMembership returned empty — the requirement was
    // invisible to the engine.
    const rows = baseRows({
      roleRequiredAssessments: [],
      competencyRequirements: [
        { id: 'link-1', orgId: ORG, roleId: 'r1', competencyId: 'c1', tier: 'required' },
      ],
    });
    (rows.assessmentTools![0] as Record<string, unknown>).createdAt = new Date('2026-01-01T00:00:00Z');
    const { db, created } = makeDb(rows);
    const result = await assignForMembership(db, ORG, 'm1', NOW);

    expect(result.createdCaseIds).toHaveLength(1);
    expect(created[0]).toMatchObject({ toolId: 't1', candidateUserId: USER, currentVersionId: 'v1' });
  });

  it('assigns nothing for a RECOMMENDED link — the never-enforced tier (R13)', async () => {
    const rows = baseRows({
      roleRequiredAssessments: [],
      competencyRequirements: [
        { id: 'link-1', orgId: ORG, roleId: 'r1', competencyId: 'c1', tier: 'recommended' },
      ],
    });
    (rows.assessmentTools![0] as Record<string, unknown>).createdAt = new Date('2026-01-01T00:00:00Z');
    const { db, created } = makeDb(rows);
    const result = await assignForMembership(db, ORG, 'm1', NOW);

    expect(result.createdCaseIds).toEqual([]);
    expect(created).toHaveLength(0);
  });
});

describe('assignForRole', () => {
  it('runs the same decision for every current holder of the Role (R47)', async () => {
    const { db, created } = makeDb(baseRows());
    const result = await assignForRole(db, ORG, 'r1', NOW);

    // One holder (m1) with one unmet requirement → one case, by the same rule
    // placement change would apply.
    expect(result.createdCaseIds).toHaveLength(1);
    expect(created[0]).toMatchObject({ toolId: 't1', candidateUserId: USER, locationId: 'loc1' });
  });
});
