/**
 * The standing LOADERS (U1 of the role-competency links round, scope-
 * generalised by U2 of the requirement inheritance round): required standing
 * is the UNION over four scopes — org, placed Locations, placed Departments,
 * held Roles — where the role scope is itself a DUAL READ (legacy Role → tool
 * → awards derivation unioned with direct `competency_requirements` links,
 * KTD3). Recommended is the same four-scope union at its own tier and never
 * bleeds into required (R13).
 *
 * The fake db here honours the WHERE clauses the loaders actually issue
 * (eq / and / inArray, plus `is null` on scope columns and `withdrawn_at`),
 * because the load-bearing facts — a withdrawn Role contributing nothing, a
 * retired Location conferring nothing, an org-scope row being exactly the
 * all-scope-columns-null shape (KTD1), a tier filter keeping recommended out
 * of required — live in those clauses. A mock that returned whatever was
 * seeded would pass with the filters deleted.
 */
import { describe, expect, it, vi } from 'vitest';

// The module imports `db` for its type only and takes the database as a
// parameter, so a null module db is all this needs.
vi.mock('../db.js', () => ({ db: null, getDbStatus: () => 'unconfigured' }));

const {
  competencySourcesByUser,
  competencySourcesFor,
  recommendedCompetencyIdsByUser,
  requiredCompetencyIdsByUser,
  requiredCompetencyIdsFor,
  sourceRefs,
} = await import('./standing.js');

const ORG = 'org-1';

// ── a store-backed fake db that honours eq / and / inArray / isNull WHEREs ──
// Same machinery as requirement-change.test.ts, extended with `is null`
// awareness so the held-Roles filter is real rather than vacuous.

// Skip the schema metadata a column node hangs off (its whole table, encoders,
// default expression) — the bound param values live in the query chunks, and
// walking the table loops back through its columns and blows up.
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

function whereTerms(
  node: unknown,
  acc: { all: string[]; anyOf: string[][] } = { all: [], anyOf: [] },
  depth = 0,
): { all: string[]; anyOf: string[][] } {
  if (!node || depth > 12 || typeof node !== 'object') return acc;
  const rec = node as Record<string, unknown>;
  const chunks = rec.queryChunks;
  if (Array.isArray(chunks)) {
    const text = chunks
      .map((c) => {
        const v = (c as { value?: unknown } | null)?.value;
        return Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '';
      })
      .join('');
    if (text.includes(' in ')) {
      const group = stringValues(chunks);
      if (group.length) acc.anyOf.push(group);
      return acc;
    }
    for (const c of chunks) whereTerms(c, acc, depth + 1);
    return acc;
  }
  if (typeof rec.value === 'string') acc.all.push(rec.value);
  for (const [k, v] of Object.entries(rec)) {
    if (SKIP_KEYS.has(k)) continue;
    whereTerms(v, acc, depth + 1);
  }
  return acc;
}

/** Column names the WHERE demands be NULL — how `isNull(withdrawnAt)` is honoured. */
function nullColumns(node: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (!node || depth > 12 || typeof node !== 'object') return out;
  const rec = node as Record<string, unknown>;
  const chunks = rec.queryChunks;
  if (Array.isArray(chunks)) {
    for (let i = 0; i < chunks.length; i++) {
      const v = (chunks[i] as { value?: unknown } | null)?.value;
      const text = Array.isArray(v) ? v.filter((s) => typeof s === 'string').join('') : '';
      if (text.includes('is null')) {
        const col = chunks[i - 1] as { name?: unknown } | null;
        if (col && typeof col.name === 'string') out.add(col.name);
      } else {
        nullColumns(chunks[i], out, depth + 1);
      }
    }
    return out;
  }
  for (const [k, v] of Object.entries(rec)) {
    if (SKIP_KEYS.has(k)) continue;
    if (Array.isArray(v)) v.forEach((n) => nullColumns(n, out, depth + 1));
    else nullColumns(v, out, depth + 1);
  }
  return out;
}

const camel = (snake: string) => snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function matchesWhere(row: Record<string, unknown>, where: unknown): boolean {
  if (!where) return true;
  const { all, anyOf } = whereTerms(where);
  const present = new Set(Object.values(row).filter((v) => typeof v === 'string'));
  if (![...new Set(all)].every((w) => present.has(w))) return false;
  if (!anyOf.every((group) => group.some((w) => present.has(w)))) return false;
  for (const colName of nullColumns(where)) {
    if (row[camel(colName)] != null) return false;
  }
  return true;
}

type Store = Record<string, Record<string, unknown>[]>;

/**
 * Both surfaces — root client and transaction — read the same store, and every
 * read records which surface it ran on so a test can pin the KTD3 fact: the
 * dual read's queries all run inside the one transaction.
 */
function makeDb(store: Store) {
  const reads: { surface: 'root' | 'tx'; table: string }[] = [];
  const tables = (surface: 'root' | 'tx') => {
    const table = (name: string) => ({
      findMany: async (args?: { where?: unknown }) => {
        reads.push({ surface, table: name });
        return (store[name] ?? []).filter((r) => matchesWhere(r, args?.where));
      },
    });
    return {
      memberships: table('memberships'),
      membershipRoles: table('membershipRoles'),
      membershipLocations: table('membershipLocations'),
      membershipDepartments: table('membershipDepartments'),
      locations: table('locations'),
      departments: table('departments'),
      jobRoles: table('jobRoles'),
      organizations: table('organizations'),
      roleRequiredAssessments: table('roleRequiredAssessments'),
      assessmentTools: table('assessmentTools'),
      competencyRequirements: table('competencyRequirements'),
    };
  };
  const tx = { query: tables('tx') };
  const transaction = vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx));
  const db = { query: tables('root'), transaction } as unknown as Parameters<
    typeof requiredCompetencyIdsByUser
  >[0];
  return { db, transaction, reads };
}

/** Membership `m` for user `u` holding `roleIds`; withdrawn ones carry a date. */
function member(m: string, u: string, roleIds: string[], withdrawn: string[] = []) {
  return {
    memberships: [{ id: m, orgId: ORG, userId: u }],
    membershipRoles: roleIds.map((roleId) => ({
      membershipId: m,
      roleId,
      withdrawnAt: withdrawn.includes(roleId) ? new Date('2026-01-01T00:00:00Z') : null,
    })),
  };
}

const link = (roleId: string, competencyId: string, tier: 'required' | 'recommended') => ({
  id: `link-${roleId}-${competencyId}`,
  orgId: ORG,
  roleId,
  // Explicit nulls so the org-scope query's `is null` checks are exercised
  // against a real value, not an absent key (KTD1's all-null org shape).
  locationId: null,
  departmentId: null,
  competencyId,
  tier,
});

// ── the other three scope shapes (KTD1): exactly one scope column set, or ──
// ── none at all for the org scope — never a sentinel id.                  ──
const orgLink = (competencyId: string, tier: 'required' | 'recommended' = 'required') => ({
  id: `link-org-${competencyId}`,
  orgId: ORG,
  roleId: null,
  locationId: null,
  departmentId: null,
  competencyId,
  tier,
});
const locLink = (locationId: string, competencyId: string, tier: 'required' | 'recommended' = 'required') => ({
  id: `link-${locationId}-${competencyId}`,
  orgId: ORG,
  roleId: null,
  locationId,
  departmentId: null,
  competencyId,
  tier,
});
const deptLink = (departmentId: string, competencyId: string, tier: 'required' | 'recommended' = 'required') => ({
  id: `link-${departmentId}-${competencyId}`,
  orgId: ORG,
  roleId: null,
  locationId: null,
  departmentId,
  competencyId,
  tier,
});

/** An active taxonomy value row; flip `status` to model retirement (R15). */
const taxonomyRow = (id: string, name: string, status: 'active' | 'retired' = 'active') => ({
  id,
  orgId: ORG,
  name,
  status,
});

/** Placement rows for one membership — the axes scope expansion reads (R3). */
const placedAt = (membershipId: string, locationIds: string[], departmentIds: string[] = []) => ({
  membershipLocations: locationIds.map((locationId) => ({ membershipId, locationId })),
  membershipDepartments: departmentIds.map((departmentId) => ({ membershipId, departmentId })),
});

/*
  The AE1 stack, in generic fixture terms (R12 — the engine is customer-blind,
  so the fixture is too): org requires one competency of everyone; Location
  loc-a requires three of anyone placed there; Department dep-ops requires one
  of anyone placed in it; Role r-op (offered by dep-ops) requires three of its
  holders. Member u1 is placed at loc-a, in dep-ops, holding r-op → eight.
  Member u2 is placed at loc-a in dep-adm (no role, no dep-adm rows) → four.
*/
const AE1_LINKS = [
  orgLink('c-org'),
  locLink('loc-a', 'c-site'),
  locLink('loc-a', 'c-barricade'),
  locLink('loc-a', 'c-vehicle'),
  deptLink('dep-ops', 'c-dept'),
  link('r-op', 'c-role-1', 'required'),
  link('r-op', 'c-role-2', 'required'),
  link('r-op', 'c-role-3', 'required'),
];
const AE1_STORE: Store = {
  memberships: [
    { id: 'm1', orgId: ORG, userId: 'u1' },
    { id: 'm2', orgId: ORG, userId: 'u2' },
  ],
  membershipRoles: [{ membershipId: 'm1', roleId: 'r-op', withdrawnAt: null }],
  membershipLocations: [
    { membershipId: 'm1', locationId: 'loc-a' },
    { membershipId: 'm2', locationId: 'loc-a' },
  ],
  membershipDepartments: [
    { membershipId: 'm1', departmentId: 'dep-ops' },
    { membershipId: 'm2', departmentId: 'dep-adm' },
  ],
  locations: [taxonomyRow('loc-a', 'Location A')],
  departments: [taxonomyRow('dep-ops', 'Operations'), taxonomyRow('dep-adm', 'Administration')],
  jobRoles: [{ ...taxonomyRow('r-op', 'Operator'), departmentId: 'dep-ops' }],
  organizations: [{ id: ORG, name: 'Org One' }],
  competencyRequirements: AE1_LINKS,
};

describe('requiredCompetencyIdsByUser', () => {
  it('obliges through a direct required link with no tool involved (R5, R7)', async () => {
    // The licence case: nothing awards `c-licence`, no assessment exists —
    // the direct link alone makes it required.
    const { db } = makeDb({
      ...member('m1', 'u1', ['r1']),
      competencyRequirements: [link('r1', 'c-licence', 'required')],
    });

    const byUser = await requiredCompetencyIdsByUser(db, ORG, ['u1']);

    expect([...byUser.get('u1')!]).toEqual(['c-licence']);
  });

  it('still derives through a legacy tool row pre-conversion (R15)', async () => {
    const { db } = makeDb({
      ...member('m1', 'u1', ['r1']),
      roleRequiredAssessments: [{ id: 'rr1', orgId: ORG, roleId: 'r1', toolId: 't1' }],
      assessmentTools: [{ id: 't1', orgId: ORG, awardedCompetencyIds: ['c-dozer'] }],
    });

    const byUser = await requiredCompetencyIdsByUser(db, ORG, ['u1']);

    expect([...byUser.get('u1')!]).toEqual(['c-dozer']);
  });

  it('unions the two halves and deduplicates a requirement both name (KTD3)', async () => {
    // Mid-transition state: the tool-derived requirement and its converted
    // direct link briefly coexist. One obligation, not two.
    const { db } = makeDb({
      ...member('m1', 'u1', ['r1']),
      roleRequiredAssessments: [{ id: 'rr1', orgId: ORG, roleId: 'r1', toolId: 't1' }],
      assessmentTools: [{ id: 't1', orgId: ORG, awardedCompetencyIds: ['c-dozer'] }],
      competencyRequirements: [
        link('r1', 'c-dozer', 'required'),
        link('r1', 'c-licence', 'required'),
      ],
    });

    const byUser = await requiredCompetencyIdsByUser(db, ORG, ['u1']);

    expect([...byUser.get('u1')!].sort()).toEqual(['c-dozer', 'c-licence']);
  });

  it('never lets a recommended link enter the required set (R13)', async () => {
    const { db } = makeDb({
      ...member('m1', 'u1', ['r1']),
      competencyRequirements: [
        link('r1', 'c-dozer', 'required'),
        link('r1', 'c-first-aid', 'recommended'),
      ],
    });

    const byUser = await requiredCompetencyIdsByUser(db, ORG, ['u1']);

    expect([...byUser.get('u1')!]).toEqual(['c-dozer']);
  });

  it('lets a withdrawn Role contribute nothing from EITHER source (R52, R90)', async () => {
    // The one Role held is withdrawn; it carries both a legacy tool
    // requirement and a direct link, and neither may survive the filter.
    const { db } = makeDb({
      ...member('m1', 'u1', ['r1'], ['r1']),
      roleRequiredAssessments: [{ id: 'rr1', orgId: ORG, roleId: 'r1', toolId: 't1' }],
      assessmentTools: [{ id: 't1', orgId: ORG, awardedCompetencyIds: ['c-dozer'] }],
      competencyRequirements: [link('r1', 'c-licence', 'required')],
    });

    const byUser = await requiredCompetencyIdsByUser(db, ORG, ['u1']);

    expect(byUser.get('u1')!.size).toBe(0);
  });

  it('runs every read of the dual derivation inside ONE transaction (KTD3)', async () => {
    // A conversion committing between a root-client legacy read and a
    // root-client direct read could make a requirement vanish from both
    // halves. The pin: the loader opened a transaction and issued NO read
    // outside it.
    const { db, transaction, reads } = makeDb({
      ...member('m1', 'u1', ['r1']),
      roleRequiredAssessments: [{ id: 'rr1', orgId: ORG, roleId: 'r1', toolId: 't1' }],
      assessmentTools: [{ id: 't1', orgId: ORG, awardedCompetencyIds: ['c-dozer'] }],
      competencyRequirements: [link('r1', 'c-licence', 'required')],
    });

    await requiredCompetencyIdsByUser(db, ORG, ['u1']);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((r) => r.surface === 'tx')).toBe(true);
    // The isolation level is the guarantee, not the BEGIN/COMMIT: at the
    // default READ COMMITTED every statement takes a fresh snapshot and the
    // wrapper pins nothing (KTD3).
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'repeatable read',
    });
  });

  it('AE1: a role holder resolves the union of all FOUR scopes (R2, R3)', async () => {
    const { db } = makeDb(AE1_STORE);

    const byUser = await requiredCompetencyIdsByUser(db, ORG, ['u1']);

    expect([...byUser.get('u1')!].sort()).toEqual(
      ['c-org', 'c-site', 'c-barricade', 'c-vehicle', 'c-dept', 'c-role-1', 'c-role-2', 'c-role-3'].sort(),
    );
  });

  it('AE1: a role-LESS member resolves org + placement scopes only (R2, R3)', async () => {
    // u2 holds no role and their department names nothing — the obligation is
    // the org row plus the location's three, and nothing role-shaped leaks in.
    const { db } = makeDb(AE1_STORE);

    const byUser = await requiredCompetencyIdsByUser(db, ORG, ['u2']);

    expect([...byUser.get('u2')!].sort()).toEqual(['c-barricade', 'c-org', 'c-site', 'c-vehicle']);
  });

  it('contributes department + org scopes to a department placement with no role (R3)', async () => {
    // Placement, never role-derivation: the person is IN the department, so
    // its requirement applies before they hold anything.
    const { db } = makeDb({
      memberships: [{ id: 'm1', orgId: ORG, userId: 'u1' }],
      ...placedAt('m1', [], ['dep-ops']),
      departments: [taxonomyRow('dep-ops', 'Operations')],
      competencyRequirements: [orgLink('c-org'), deptLink('dep-ops', 'c-dept')],
    });

    const byUser = await requiredCompetencyIdsByUser(db, ORG, ['u1']);

    expect([...byUser.get('u1')!].sort()).toEqual(['c-dept', 'c-org']);
  });

  it('dedupes a competency required at BOTH org scope and a role — AE4 read side (KTD2)', async () => {
    const { db } = makeDb({
      ...member('m1', 'u1', ['r1']),
      competencyRequirements: [orgLink('c-x'), link('r1', 'c-x', 'required')],
    });

    const byUser = await requiredCompetencyIdsByUser(db, ORG, ['u1']);

    expect([...byUser.get('u1')!]).toEqual(['c-x']); // once, not twice
  });

  it('lets a RETIRED location confer nothing while a retired-but-held role still does (U4 split)', async () => {
    /*
      The decided retirement semantics, pinned as a PAIR because they diverge:
      retiring a Location (or Department) means its requirement STOPS applying
      to the people placed there — the resolver joins the value's status — but
      retiring a ROLE withdraws nobody (R119 posture): a retired-but-held role
      keeps contributing until the withdrawal/transfer flow ends the holding.
      A status filter added to the role read would turn this test red.
    */
    const { db } = makeDb({
      memberships: [{ id: 'm1', orgId: ORG, userId: 'u1' }],
      membershipRoles: [{ membershipId: 'm1', roleId: 'r-old', withdrawnAt: null }],
      ...placedAt('m1', ['loc-gone'], ['dep-gone']),
      locations: [taxonomyRow('loc-gone', 'Closed Site', 'retired')],
      departments: [taxonomyRow('dep-gone', 'Disbanded', 'retired')],
      jobRoles: [{ ...taxonomyRow('r-old', 'Legacy Operator', 'retired'), departmentId: 'dep-gone' }],
      competencyRequirements: [
        locLink('loc-gone', 'c-site'),
        deptLink('dep-gone', 'c-dept'),
        link('r-old', 'c-role', 'required'),
      ],
    });

    const byUser = await requiredCompetencyIdsByUser(db, ORG, ['u1']);

    expect([...byUser.get('u1')!]).toEqual(['c-role']);
  });

  it('keeps the requirement VISIBLE for a member with no location placement (KTD4)', async () => {
    // The assignment engine plans zero cases with nowhere to assess (the
    // decideAssignments skip, pinned in assignment.test.ts) — but the gap must
    // stay visible here, or an unbookable obligation would read as compliance.
    const { db } = makeDb({
      memberships: [{ id: 'm1', orgId: ORG, userId: 'u1' }],
      competencyRequirements: [orgLink('c-org')],
    });

    const byUser = await requiredCompetencyIdsByUser(db, ORG, ['u1']);

    expect([...byUser.get('u1')!]).toEqual(['c-org']);
  });

  it('AE1: reads all FIVE required competencies when only one has an awarding tool (R5, R7)', async () => {
    // Dozer Operator: the ATO (awarded by an assessment) plus four
    // licence-type competencies nothing awards. Standing is the same size
    // either way — an evidence-only requirement is still a requirement.
    const FIVE = ['c-ato', 'c-licence', 'c-sme', 'c-grade', 'c-tip'];
    const { db } = makeDb({
      ...member('m1', 'u1', ['r1']),
      competencyRequirements: FIVE.map((c) => link('r1', c, 'required')),
      assessmentTools: [{ id: 't-ato', orgId: ORG, awardedCompetencyIds: ['c-ato'] }],
    });

    const byUser = await requiredCompetencyIdsByUser(db, ORG, ['u1']);

    expect([...byUser.get('u1')!].sort()).toEqual([...FIVE].sort());
  });

  it('maps every requested userId, empty set by default — nobody is absent', async () => {
    const { db } = makeDb({
      ...member('m1', 'u1', ['r1']),
      competencyRequirements: [link('r1', 'c-dozer', 'required')],
    });

    const byUser = await requiredCompetencyIdsByUser(db, ORG, ['u1', 'u-nobody']);

    expect(byUser.has('u-nobody')).toBe(true);
    expect(byUser.get('u-nobody')!.size).toBe(0);
    expect(byUser.get('u1')!.size).toBe(1);
  });

  it('serves the single-user shape through the same batch path', async () => {
    const { db } = makeDb({
      ...member('m1', 'u1', ['r1']),
      competencyRequirements: [link('r1', 'c-dozer', 'required')],
    });

    expect([...(await requiredCompetencyIdsFor(db, ORG, 'u1'))]).toEqual(['c-dozer']);
    expect((await requiredCompetencyIdsFor(db, ORG, 'u-nobody')).size).toBe(0);
  });
});

describe('recommendedCompetencyIdsByUser', () => {
  it('reads recommended links only — required never bleeds in (R6, R13)', async () => {
    const { db } = makeDb({
      ...member('m1', 'u1', ['r1']),
      competencyRequirements: [
        link('r1', 'c-dozer', 'required'),
        link('r1', 'c-first-aid', 'recommended'),
      ],
    });

    const byUser = await recommendedCompetencyIdsByUser(db, ORG, ['u1']);

    expect([...byUser.get('u1')!]).toEqual(['c-first-aid']);
  });

  it('lets a withdrawn Role recommend nothing (R52)', async () => {
    const { db } = makeDb({
      ...member('m1', 'u1', ['r1'], ['r1']),
      competencyRequirements: [link('r1', 'c-first-aid', 'recommended')],
    });

    const byUser = await recommendedCompetencyIdsByUser(db, ORG, ['u1']);

    expect(byUser.get('u1')!.size).toBe(0);
  });

  it('maps every requested userId, empty set by default', async () => {
    const { db } = makeDb({});

    const byUser = await recommendedCompetencyIdsByUser(db, ORG, ['u1', 'u2']);

    expect(byUser.get('u1')!.size).toBe(0);
    expect(byUser.get('u2')!.size).toBe(0);
  });

  it('reaches ONLY the members placed at a location that recommends (R8, R3)', async () => {
    // u1 is placed at loc-a, u2 elsewhere: the recommendation follows the
    // placement, never the org roster.
    const { db } = makeDb({
      memberships: [
        { id: 'm1', orgId: ORG, userId: 'u1' },
        { id: 'm2', orgId: ORG, userId: 'u2' },
      ],
      membershipLocations: [
        { membershipId: 'm1', locationId: 'loc-a' },
        { membershipId: 'm2', locationId: 'loc-b' },
      ],
      locations: [taxonomyRow('loc-a', 'Location A'), taxonomyRow('loc-b', 'Location B')],
      competencyRequirements: [locLink('loc-a', 'c-nice-to-have', 'recommended')],
    });

    const byUser = await recommendedCompetencyIdsByUser(db, ORG, ['u1', 'u2']);

    expect([...byUser.get('u1')!]).toEqual(['c-nice-to-have']);
    expect(byUser.get('u2')!.size).toBe(0);
  });

  it('unions all four scopes at the recommended tier (R8)', async () => {
    const { db } = makeDb({
      ...AE1_STORE,
      competencyRequirements: [
        orgLink('c-r-org', 'recommended'),
        locLink('loc-a', 'c-r-loc', 'recommended'),
        deptLink('dep-ops', 'c-r-dept', 'recommended'),
        link('r-op', 'c-r-role', 'recommended'),
      ],
    });

    const byUser = await recommendedCompetencyIdsByUser(db, ORG, ['u1']);

    expect([...byUser.get('u1')!].sort()).toEqual(['c-r-dept', 'c-r-loc', 'c-r-org', 'c-r-role']);
  });

  it('now runs inside ONE repeatable-read transaction — the exemption is dead (KTD3)', async () => {
    /*
      The old "single source" justification is gone: this read spans the
      placement tables AND four requirement-row shapes, so a location transfer
      or a scope save committing mid-read could otherwise show half a world.
      Same pin as the required sibling — every read on the tx surface, at
      repeatable read (READ COMMITTED would re-snapshot per statement).
    */
    const { db, transaction, reads } = makeDb(AE1_STORE);

    await recommendedCompetencyIdsByUser(db, ORG, ['u1']);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((r) => r.surface === 'tx')).toBe(true);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'repeatable read',
    });
  });
});

describe('competencySourcesFor', () => {
  it('names EVERY contributing scope for a cross-scope duplicate, org carrying a null id (R5, KTD2)', async () => {
    const { db } = makeDb({
      ...AE1_STORE,
      competencyRequirements: [orgLink('c-x'), locLink('loc-a', 'c-x'), link('r-op', 'c-x', 'required')],
    });

    const sources = await competencySourcesFor(db, ORG, 'u1');

    // Deterministic order — org, then locations, departments, roles — so a
    // record surface renders the same line every load (R5).
    expect(sources.required.get('c-x')).toEqual([
      { scope: 'org', scopeId: null, scopeName: 'Org One' },
      { scope: 'location', scopeId: 'loc-a', scopeName: 'Location A' },
      { scope: 'role', scopeId: 'r-op', scopeName: 'Operator' },
    ]);
  });

  it('covers the AE1 stack: each entry names the scope that produced it (R5)', async () => {
    const { db } = makeDb(AE1_STORE);

    const sources = await competencySourcesFor(db, ORG, 'u1');

    expect(sources.required.get('c-org')).toEqual([{ scope: 'org', scopeId: null, scopeName: 'Org One' }]);
    expect(sources.required.get('c-site')).toEqual([
      { scope: 'location', scopeId: 'loc-a', scopeName: 'Location A' },
    ]);
    expect(sources.required.get('c-dept')).toEqual([
      { scope: 'department', scopeId: 'dep-ops', scopeName: 'Operations' },
    ]);
    expect(sources.required.get('c-role-1')).toEqual([
      { scope: 'role', scopeId: 'r-op', scopeName: 'Operator' },
    ]);
    expect(sources.required.size).toBe(8);
  });

  it('sources a LEGACY tool-derived requirement from its role, like a direct link (KTD3)', async () => {
    // The dual read's legacy half is still a role obligation, and R5 says no
    // surface reports a requirement without its source — pre-conversion rows
    // included.
    const { db } = makeDb({
      ...member('m1', 'u1', ['r1']),
      jobRoles: [{ ...taxonomyRow('r1', 'Role One'), departmentId: 'dep-x' }],
      organizations: [{ id: ORG, name: 'Org One' }],
      roleRequiredAssessments: [{ id: 'rr1', orgId: ORG, roleId: 'r1', toolId: 't1' }],
      assessmentTools: [{ id: 't1', orgId: ORG, awardedCompetencyIds: ['c-dozer'] }],
    });

    const sources = await competencySourcesFor(db, ORG, 'u1');

    expect(sources.required.get('c-dozer')).toEqual([
      { scope: 'role', scopeId: 'r1', scopeName: 'Role One' },
    ]);
  });

  it('keeps the tiers apart: a recommended source never appears as required (R13)', async () => {
    const { db } = makeDb({
      memberships: [{ id: 'm1', orgId: ORG, userId: 'u1' }],
      ...placedAt('m1', ['loc-a']),
      locations: [taxonomyRow('loc-a', 'Location A')],
      organizations: [{ id: ORG, name: 'Org One' }],
      competencyRequirements: [locLink('loc-a', 'c-nice', 'recommended')],
    });

    const sources = await competencySourcesFor(db, ORG, 'u1');

    expect(sources.required.size).toBe(0);
    expect(sources.recommended.get('c-nice')).toEqual([
      { scope: 'location', scopeId: 'loc-a', scopeName: 'Location A' },
    ]);
  });

  it('reads both tiers off ONE repeatable-read snapshot (KTD3)', async () => {
    // A scope save moving a row between tiers mid-read must be seen on exactly
    // one side — the record page renders both tiers from this single call.
    const { db, transaction, reads } = makeDb(AE1_STORE);

    await competencySourcesFor(db, ORG, 'u1');

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(reads.every((r) => r.surface === 'tx')).toBe(true);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'repeatable read',
    });
  });
});

describe('competencySourcesByUser (the batched sibling, U8)', () => {
  it('assembles each user from their OWN keys — u1’s role never captions u2 (R5)', async () => {
    /*
      The batch reads are set-wise over the UNION of everyone's scope keys, so
      the isolation has to be proven, not assumed: u2 is placed at the same
      location as u1 but holds no role and sits in a department with no rows —
      their captions must carry the location and org scopes ONLY, while u1's
      carry all four. A per-index spread (rather than per-member keys) would
      leak r-op's rows onto u2 here.
    */
    const { db, transaction } = makeDb(AE1_STORE);

    const byUser = await competencySourcesByUser(db, ORG, ['u1', 'u2']);

    expect(transaction).toHaveBeenCalledTimes(1); // one snapshot for the whole batch
    expect(byUser.get('u1')!.required.size).toBe(8);
    const u2 = byUser.get('u2')!;
    expect(u2.required.size).toBe(4);
    expect(u2.required.get('c-site')).toEqual([
      { scope: 'location', scopeId: 'loc-a', scopeName: 'Location A' },
    ]);
    expect(u2.required.get('c-role-1')).toBeUndefined();
    expect(u2.required.get('c-dept')).toBeUndefined();
  });

  it('maps every requested userId, empty maps by default — nobody is absent', async () => {
    const { db } = makeDb(AE1_STORE);

    const byUser = await competencySourcesByUser(db, ORG, ['u1', 'u-nobody']);

    expect(byUser.has('u-nobody')).toBe(true);
    expect(byUser.get('u-nobody')!.required.size).toBe(0);
    expect(byUser.get('u-nobody')!.recommended.size).toBe(0);
  });

  it('scopes the LEGACY derivation per member — a colleague’s tool row captions nothing (KTD3)', async () => {
    // u1 holds r1 (legacy tool requirement), u2 holds r2 (no requirements).
    // The batch reads every legacy row for both roles at once; u2 must not
    // inherit r1's caption from the shared read.
    const { db } = makeDb({
      memberships: [
        { id: 'm1', orgId: ORG, userId: 'u1' },
        { id: 'm2', orgId: ORG, userId: 'u2' },
      ],
      membershipRoles: [
        { membershipId: 'm1', roleId: 'r1', withdrawnAt: null },
        { membershipId: 'm2', roleId: 'r2', withdrawnAt: null },
      ],
      jobRoles: [
        { ...taxonomyRow('r1', 'Role One'), departmentId: 'dep-x' },
        { ...taxonomyRow('r2', 'Role Two'), departmentId: 'dep-x' },
      ],
      organizations: [{ id: ORG, name: 'Org One' }],
      roleRequiredAssessments: [{ id: 'rr1', orgId: ORG, roleId: 'r1', toolId: 't1' }],
      assessmentTools: [{ id: 't1', orgId: ORG, awardedCompetencyIds: ['c-dozer'] }],
    });

    const byUser = await competencySourcesByUser(db, ORG, ['u1', 'u2']);

    expect(byUser.get('u1')!.required.get('c-dozer')).toEqual([
      { scope: 'role', scopeId: 'r1', scopeName: 'Role One' },
    ]);
    expect(byUser.get('u2')!.required.size).toBe(0);
  });
});

describe('sourceRefs (the wire shape, U8)', () => {
  it('drops scopeId and keeps the render order — names are what surfaces caption with (R5)', () => {
    expect(
      sourceRefs([
        { scope: 'org', scopeId: null, scopeName: 'Org One' },
        { scope: 'location', scopeId: 'loc-a', scopeName: 'Location A' },
      ]),
    ).toEqual([
      { scope: 'org', name: 'Org One' },
      { scope: 'location', name: 'Location A' },
    ]);
    // Undefined in, empty out — "no scope names it" is a fact, not an error.
    expect(sourceRefs(undefined)).toEqual([]);
  });
});
