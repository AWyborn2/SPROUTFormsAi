/**
 * The requirement-change compute, in COMPETENCY terms (U3 of the
 * role-competency links round). The unit of change is a competency link; an
 * added competency plans a case only where the KTD2 resolver finds an awarding
 * tool, and removal effects are computed per holder against BOTH surviving
 * sources (direct links and remaining legacy rows).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// The module imports `db` for its type only and takes the database as a
// parameter, so a null module db is all this needs.
vi.mock('../db.js', () => ({ db: null, getDbStatus: () => 'unconfigured' }));

const { computeRequiredAssessmentsChange, computeAwardLinkChange } = await import(
  './requirement-change.js'
);
// The SHARED resolver the award link must agree with — imported here so the
// "who ends up awarding this?" question is asked of the real read site rather
// than restated by the test.
const { requiredToolIdsForMembership } = await import('./requirement-links.js');

const ORG = 'org-1';
const NOW = new Date('2026-06-01T00:00:00Z');
// The compute is scope-addressed since U4 (KTD5); these suites exercise the
// role scope, whose semantics the inheritance round promised unchanged (R11).
const ROLE = { kind: 'role', id: 'role-1' } as const;

// ── a store-backed fake db that honours eq / and / inArray WHERE clauses ─────
// The compute function is READ-ONLY, so only `query.<table>.findMany/findFirst`
// are needed. Filtering the store by the real WHERE lets a test seed several
// distinct holders and have each read return exactly its own rows.

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

/** Column names the WHERE demands be NULL — how `isNull(...)` is honoured
 * (same machinery as standing.test.ts): the org-scope requirement shape and
 * the held-role filter live in those clauses, so a fake that ignored them
 * would pass with the filters deleted. */
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

function makeDb(store: Store, counter?: { reads: number }) {
  const table = (name: string) => ({
    findMany: async (args?: { where?: unknown }) => {
      if (counter) counter.reads++;
      return (store[name] ?? []).filter((r) => matchesWhere(r, args?.where));
    },
    findFirst: async (args?: { where?: unknown }) => {
      if (counter) counter.reads++;
      return (store[name] ?? []).find((r) => matchesWhere(r, args?.where));
    },
  });
  return {
    query: {
      memberships: table('memberships'),
      membershipRoles: table('membershipRoles'),
      roleRequiredAssessments: table('roleRequiredAssessments'),
      competencyRequirements: table('competencyRequirements'),
      assessmentTools: table('assessmentTools'),
      formTemplates: table('formTemplates'),
      membershipLocations: table('membershipLocations'),
      // The four-scope expansion (U4/KTD5) reads placements AND the status of
      // the values they point at — the retired split lives in that join.
      membershipDepartments: table('membershipDepartments'),
      locations: table('locations'),
      departments: table('departments'),
      assessmentCases: table('assessmentCases'),
      competencyHolders: table('competencyHolders'),
      competencies: table('competencies'),
    },
  } as unknown as Parameters<typeof computeRequiredAssessmentsChange>[0];
}

const MANIFEST = { parts: [{ key: 'p1', ordinal: 1, label: 'P1', kind: 'theory', pathways: ['new'] }] };

/** A tool `t` that awards competencies `awards`, on template `tpl-<id>`. */
function tool(id: string, awards: string[], over: Record<string, unknown> = {}) {
  return {
    id,
    orgId: ORG,
    templateId: `tpl-${id}`,
    awardedCompetencyIds: awards,
    manifest: MANIFEST,
    locationPartKeys: {},
    assessorStreamCompetencyIds: {},
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}
function template(id: string, currentVersionId: string | null = `v-${id}`) {
  return { id, orgId: ORG, currentVersionId };
}
/**
 * Membership `m` for user `u`, holding roles `roleIds`, at one Location.
 * ACTIVE by default: every scope's holder expansion narrows to active
 * memberships now (not just the org arm), so a fixture with no status would
 * expand to nobody and every effect count would silently read zero.
 */
function member(m: string, u: string, roleIds: string[], status = 'active') {
  return {
    memberships: [{ id: m, orgId: ORG, userId: u, status }],
    membershipRoles: roleIds.map((roleId) => ({ membershipId: m, roleId, withdrawnAt: null })),
    membershipLocations: [{ membershipId: m, locationId: `loc-${m}`, position: 0 }],
  };
}
/** A required-tier link on `roleId` for `competencyId`. */
const link = (roleId: string, competencyId: string, tier: 'required' | 'recommended' = 'required') => ({
  id: `link-${roleId}-${competencyId}`,
  orgId: ORG,
  roleId,
  competencyId,
  tier,
});
/** A current, never-expiring grant of `competencyId` to `userId`. */
const grant = (userId: string, competencyId: string) => ({
  competencyId,
  userId,
  orgId: ORG,
  grantedAt: new Date('2025-01-01'),
  expiresAt: null,
  revokedAt: null,
});

afterEach(() => vi.clearAllMocks());

// ── additions (R82–R84, R7, R9) ──────────────────────────────────────────────

describe('computeRequiredAssessmentsChange — additions', () => {
  it('counts affected as every holder and created as the holders left unmet (R84)', async () => {
    // Three holders of role-1; the change adds competency cB (awarded by tB).
    // Two hold cB current, one does not — so affected 3, created 1.
    const store: Store = {
      competencyRequirements: [link('role-1', 'cA')], // current required {cA}
      membershipRoles: [
        { membershipId: 'm1', roleId: 'role-1', withdrawnAt: null },
        { membershipId: 'm2', roleId: 'role-1', withdrawnAt: null },
        { membershipId: 'm3', roleId: 'role-1', withdrawnAt: null },
      ],
      memberships: [
        { id: 'm1', orgId: ORG, userId: 'u1', status: 'active' },
        { id: 'm2', orgId: ORG, userId: 'u2', status: 'active' },
        { id: 'm3', orgId: ORG, userId: 'u3', status: 'active' },
      ],
      membershipLocations: [
        { membershipId: 'm1', locationId: 'loc1', position: 0 },
        { membershipId: 'm2', locationId: 'loc2', position: 0 },
        { membershipId: 'm3', locationId: 'loc3', position: 0 },
      ],
      assessmentTools: [tool('tB', ['cB'])],
      formTemplates: [template('tpl-tB', 'v1')],
      assessmentCases: [],
      competencyHolders: [grant('u1', 'cB'), grant('u2', 'cB')],
      competencies: [{ id: 'cB', orgId: ORG, validForMonths: null, gracePeriodDays: null }],
    };
    const { effects, casesToInsert } = await computeRequiredAssessmentsChange(
      makeDb(store), ORG, ROLE, { requiredCompetencyIds: ['cA', 'cB'] }, NOW,
    );

    expect(effects.addedCompetencyIds).toEqual(['cB']);
    expect(effects.removedCompetencyIds).toEqual([]);
    expect(effects.affected).toBe(3);
    expect(effects.created).toBe(1); // only u3
    expect(casesToInsert).toHaveLength(1);
    expect(casesToInsert[0]).toMatchObject({ toolId: 'tB', candidateUserId: 'u3', orgId: ORG });
    // KTD10 invariant: created is exactly the plan length.
    expect(effects.created).toBe(casesToInsert.length);
  });

  it('creates nothing for a holder who already has an open case for the awarding tool (KTD16)', async () => {
    const store: Store = {
      competencyRequirements: [],
      ...member('m1', 'u1', ['role-1']),
      assessmentTools: [tool('tB', ['cB'])],
      formTemplates: [template('tpl-tB', 'v1')],
      assessmentCases: [{ id: 'c-open', orgId: ORG, candidateUserId: 'u1', toolId: 'tB', state: 'open' }],
      competencyHolders: [],
      competencies: [],
    };
    const { effects } = await computeRequiredAssessmentsChange(
      makeDb(store), ORG, ROLE, { requiredCompetencyIds: ['cB'] }, NOW,
    );
    expect(effects.affected).toBe(1);
    expect(effects.created).toBe(0);
  });

  it('AE1: five required competencies, one awardable — exactly one case, licence types plan nothing (R5, R7, R9)', async () => {
    // Dozer Operator requires the ATO (awarded by its assessment) plus four
    // licence-type competencies nothing awards. A holder with none is
    // auto-assigned ONLY the awarding assessment; the other four add to
    // required standing with no case — they are evidence-based gaps.
    const FIVE = ['c-ato', 'c-licence', 'c-sme', 'c-grade', 'c-tip'];
    const store: Store = {
      competencyRequirements: [],
      ...member('m1', 'u1', ['role-1']),
      assessmentTools: [tool('t-ato', ['c-ato'])],
      formTemplates: [template('tpl-t-ato', 'v1')],
      assessmentCases: [],
      competencyHolders: [],
      competencies: FIVE.map((id) => ({ id, orgId: ORG })),
    };
    const { effects, casesToInsert } = await computeRequiredAssessmentsChange(
      makeDb(store), ORG, ROLE, { requiredCompetencyIds: FIVE }, NOW,
    );

    expect(effects.addedCompetencyIds.sort()).toEqual([...FIVE].sort());
    expect(effects.created).toBe(1);
    expect(casesToInsert).toHaveLength(1);
    expect(casesToInsert[0]).toMatchObject({ toolId: 't-ato', candidateUserId: 'u1' });
  });

  it('resolves two tools sharing createdAt by id, identically across preview and apply runs (KTD2)', async () => {
    // Both award cB and share a createdAt to the millisecond; the id breaks
    // the tie. Two invocations (a preview and its apply) must plan the SAME
    // tool, or the previewed count would describe a different write.
    const shared = new Date('2026-03-01T00:00:00Z');
    const store: Store = {
      competencyRequirements: [],
      ...member('m1', 'u1', ['role-1']),
      assessmentTools: [
        tool('t-zz', ['cB'], { createdAt: shared }),
        tool('t-aa', ['cB'], { createdAt: shared }),
      ],
      formTemplates: [template('tpl-t-zz', 'v1'), template('tpl-t-aa', 'v2')],
      assessmentCases: [],
      competencyHolders: [],
      competencies: [],
    };
    const first = await computeRequiredAssessmentsChange(
      makeDb(store), ORG, ROLE, { requiredCompetencyIds: ['cB'] }, NOW,
    );
    const second = await computeRequiredAssessmentsChange(
      makeDb(store), ORG, ROLE, { requiredCompetencyIds: ['cB'] }, NOW,
    );

    expect(first.casesToInsert.map((c) => c.toolId)).toEqual(['t-aa']); // lower id wins
    expect(second.casesToInsert.map((c) => c.toolId)).toEqual(first.casesToInsert.map((c) => c.toolId));
    expect(first.effects.created).toBe(1); // ONE tool resolves — never one case per candidate tool
  });

  it('skips a candidate tool whose template has no published version (KTD2)', async () => {
    const store: Store = {
      competencyRequirements: [],
      ...member('m1', 'u1', ['role-1']),
      assessmentTools: [tool('tB', ['cB'])],
      formTemplates: [template('tpl-tB', null)], // never published — unbookable
      assessmentCases: [],
      competencyHolders: [],
      competencies: [],
    };
    const { effects } = await computeRequiredAssessmentsChange(
      makeDb(store), ORG, ROLE, { requiredCompetencyIds: ['cB'] }, NOW,
    );
    expect(effects.addedCompetencyIds).toEqual(['cB']);
    expect(effects.created).toBe(0); // evidence-only until something bookable awards it
  });
});

// ── removals (R55, R56) ──────────────────────────────────────────────────────

describe('computeRequiredAssessmentsChange — removals', () => {
  it('reports affected, in-flight-continuing and competencies-demoting, never a created count (R85)', async () => {
    // role-1's links currently require {cA, cB}; the change drops cB. Holder u1
    // has an in-flight case for cB's awarding tool and holds cB; nothing left
    // requires cB.
    const store: Store = {
      competencyRequirements: [link('role-1', 'cA'), link('role-1', 'cB')],
      ...member('m1', 'u1', ['role-1']),
      assessmentTools: [tool('tA', ['cA']), tool('tB', ['cB'])],
      formTemplates: [template('tpl-tA'), template('tpl-tB')],
      assessmentCases: [{ id: 'case-b', orgId: ORG, candidateUserId: 'u1', toolId: 'tB', state: 'open' }],
      competencyHolders: [grant('u1', 'cB')],
      competencies: [{ id: 'cB', orgId: ORG, validForMonths: null, gracePeriodDays: null }],
    };
    const { effects } = await computeRequiredAssessmentsChange(
      makeDb(store), ORG, ROLE, { requiredCompetencyIds: ['cA'] }, NOW,
    );

    expect(effects.removedCompetencyIds).toEqual(['cB']);
    expect(effects.affected).toBe(1);
    expect(effects.inFlightContinuing).toBe(1);
    expect(effects.competenciesDemoting).toBe(1);
    expect(effects.created).toBe(0); // R85: a removal never reports a creation
  });

  it('does not demote a competency another Role still derives through a LEGACY row (R56, dual-source)', async () => {
    // u1 carries role-1 (dropping the cB link) AND role-2, which still
    // legacy-requires tB — whose award is cB. The post-change read must see
    // the legacy half or it would report a demotion that is not happening.
    const store: Store = {
      competencyRequirements: [link('role-1', 'cB')],
      roleRequiredAssessments: [{ orgId: ORG, roleId: 'role-2', toolId: 'tB' }],
      ...member('m1', 'u1', ['role-1', 'role-2']),
      assessmentTools: [tool('tB', ['cB'])],
      formTemplates: [template('tpl-tB')],
      assessmentCases: [{ id: 'case-b', orgId: ORG, candidateUserId: 'u1', toolId: 'tB', state: 'open' }],
      competencyHolders: [grant('u1', 'cB')],
      competencies: [{ id: 'cB', orgId: ORG, validForMonths: null, gracePeriodDays: null }],
    };
    const { effects } = await computeRequiredAssessmentsChange(
      makeDb(store), ORG, ROLE, { requiredCompetencyIds: [] }, NOW,
    );

    expect(effects.removedCompetencyIds).toEqual(['cB']);
    expect(effects.inFlightContinuing).toBe(0); // still obliged via role-2's legacy row
    expect(effects.competenciesDemoting).toBe(0);
  });

  it('does not demote a competency another Role requires through a DIRECT link (R56, cross-role)', async () => {
    const store: Store = {
      competencyRequirements: [link('role-1', 'cB'), link('role-2', 'cB')],
      ...member('m1', 'u1', ['role-1', 'role-2']),
      assessmentTools: [tool('tB', ['cB'])],
      formTemplates: [template('tpl-tB')],
      assessmentCases: [],
      competencyHolders: [grant('u1', 'cB')],
      competencies: [{ id: 'cB', orgId: ORG, validForMonths: null, gracePeriodDays: null }],
    };
    const { effects } = await computeRequiredAssessmentsChange(
      makeDb(store), ORG, ROLE, { requiredCompetencyIds: [] }, NOW,
    );
    expect(effects.competenciesDemoting).toBe(0);
  });

  it('counts a non-terminal awaiting_sign_off case as in flight, and ignores a competent one', async () => {
    const store: Store = {
      competencyRequirements: [link('role-1', 'cB')],
      ...member('m1', 'u1', ['role-1']),
      assessmentTools: [tool('tB', ['cB'])],
      formTemplates: [template('tpl-tB')],
      assessmentCases: [
        { id: 'c1', orgId: ORG, candidateUserId: 'u1', toolId: 'tB', state: 'awaiting_sign_off' },
        { id: 'c2', orgId: ORG, candidateUserId: 'u1', toolId: 'tB', state: 'competent' },
      ],
      competencyHolders: [],
      competencies: [],
    };
    const { effects } = await computeRequiredAssessmentsChange(
      makeDb(store), ORG, ROLE, { requiredCompetencyIds: [] }, NOW,
    );
    expect(effects.inFlightContinuing).toBe(1); // only the awaiting_sign_off one
  });
});

// ── the awaitingLink exit (KTD9) ─────────────────────────────────────────────

describe('computeRequiredAssessmentsChange — legacy-row removal', () => {
  it('removing a LINKED legacy row demotes its award and counts its in-flight case', async () => {
    // role-1 legacy-requires tB (awards cB); no direct links. Removing the
    // legacy row is the whole change: cB leaves required standing for u1, and
    // the in-flight tB case continues rather than being cancelled.
    const store: Store = {
      competencyRequirements: [],
      roleRequiredAssessments: [{ orgId: ORG, roleId: 'role-1', toolId: 'tB' }],
      ...member('m1', 'u1', ['role-1']),
      assessmentTools: [tool('tB', ['cB'])],
      formTemplates: [template('tpl-tB')],
      assessmentCases: [{ id: 'case-b', orgId: ORG, candidateUserId: 'u1', toolId: 'tB', state: 'open' }],
      competencyHolders: [grant('u1', 'cB')],
      competencies: [{ id: 'cB', orgId: ORG, validForMonths: null, gracePeriodDays: null }],
    };
    const { effects } = await computeRequiredAssessmentsChange(
      makeDb(store), ORG, ROLE, { requiredCompetencyIds: [], removeLegacyToolIds: ['tB'] }, NOW,
    );

    expect(effects.removedCompetencyIds).toEqual(['cB']);
    expect(effects.inFlightContinuing).toBe(1);
    expect(effects.competenciesDemoting).toBe(1);
    expect(effects.created).toBe(0);
  });

  it('removing an UNLINKED legacy row (empty awards) demotes nothing but counts its in-flight case', async () => {
    // The usual awaitingLink case: the tool awards nothing yet. Its removal
    // frees no competency (there is none) but its live case still continues.
    const store: Store = {
      competencyRequirements: [],
      roleRequiredAssessments: [{ orgId: ORG, roleId: 'role-1', toolId: 'tU' }],
      ...member('m1', 'u1', ['role-1']),
      assessmentTools: [tool('tU', [])],
      formTemplates: [template('tpl-tU')],
      assessmentCases: [{ id: 'case-u', orgId: ORG, candidateUserId: 'u1', toolId: 'tU', state: 'open' }],
      competencyHolders: [],
      competencies: [],
    };
    const { effects } = await computeRequiredAssessmentsChange(
      makeDb(store), ORG, ROLE, { requiredCompetencyIds: [], removeLegacyToolIds: ['tU'] }, NOW,
    );

    expect(effects.removedCompetencyIds).toEqual([]);
    expect(effects.inFlightContinuing).toBe(1);
    expect(effects.competenciesDemoting).toBe(0);
  });
});

// ── mixed add + remove in one save (union-by-presence) ───────────────────────

describe('computeRequiredAssessmentsChange — mixed', () => {
  it('reports created alongside the removal counters in a single save', async () => {
    // current links {cA, cB}; desired {cA, cC}: drops cB, adds cC. u1 holds cB
    // and has an in-flight case for cB's tool, and does not hold cC.
    const store: Store = {
      competencyRequirements: [link('role-1', 'cA'), link('role-1', 'cB')],
      ...member('m1', 'u1', ['role-1']),
      assessmentTools: [tool('tA', ['cA']), tool('tB', ['cB']), tool('tC', ['cC'])],
      formTemplates: [template('tpl-tA'), template('tpl-tB'), template('tpl-tC', 'v1')],
      assessmentCases: [{ id: 'case-b', orgId: ORG, candidateUserId: 'u1', toolId: 'tB', state: 'open' }],
      competencyHolders: [grant('u1', 'cB')],
      competencies: [{ id: 'cB', orgId: ORG, validForMonths: null, gracePeriodDays: null }],
    };
    const { effects } = await computeRequiredAssessmentsChange(
      makeDb(store), ORG, ROLE, { requiredCompetencyIds: ['cA', 'cC'] }, NOW,
    );

    expect(effects.addedCompetencyIds).toEqual(['cC']);
    expect(effects.removedCompetencyIds).toEqual(['cB']);
    expect(effects.created).toBe(1); // the tC case for u1
    expect(effects.inFlightContinuing).toBe(1); // the tB case
    expect(effects.competenciesDemoting).toBe(1); // cB now behind no requirement
  });
});

// ── the four scopes (U4 — KTD5, AE3, AE4, and the retired split) ─────────────

describe('computeRequiredAssessmentsChange — scope holder expansion (KTD5)', () => {
  const orgLink = (competencyId: string, tier = 'required') => ({
    id: `link-org-${competencyId}`,
    orgId: ORG,
    roleId: null,
    locationId: null,
    departmentId: null,
    competencyId,
    tier,
  });
  const locLink = (locationId: string, competencyId: string) => ({
    id: `link-${locationId}-${competencyId}`,
    orgId: ORG,
    roleId: null,
    locationId,
    departmentId: null,
    competencyId,
    tier: 'required',
  });
  const deptLink = (departmentId: string, competencyId: string) => ({
    id: `link-${departmentId}-${competencyId}`,
    orgId: ORG,
    roleId: null,
    locationId: null,
    departmentId,
    competencyId,
    tier: 'required',
  });

  it('AE3: an org-scope addition reaches every ACTIVE membership, and preview == apply', async () => {
    // Three active memberships (one deactivated — outside the blast radius);
    // u1 already holds cB, u2 and u3 do not. Affected counts every active
    // membership; created counts the unmet — and is the plan's length by
    // construction, which is the whole preview==apply guarantee (KTD10).
    const store: Store = {
      competencyRequirements: [],
      memberships: [
        { id: 'm1', orgId: ORG, userId: 'u1', status: 'active' },
        { id: 'm2', orgId: ORG, userId: 'u2', status: 'active' },
        { id: 'm3', orgId: ORG, userId: 'u3', status: 'active' },
        { id: 'm4', orgId: ORG, userId: 'u4', status: 'deactivated' },
      ],
      membershipRoles: [], // NOBODY holds a role — the org scope needs none (R2)
      membershipLocations: [
        { membershipId: 'm1', locationId: 'loc1', position: 0 },
        { membershipId: 'm2', locationId: 'loc2', position: 0 },
        { membershipId: 'm3', locationId: 'loc3', position: 0 },
      ],
      assessmentTools: [tool('tB', ['cB'])],
      formTemplates: [template('tpl-tB', 'v1')],
      assessmentCases: [],
      competencyHolders: [grant('u1', 'cB')],
      competencies: [{ id: 'cB', orgId: ORG, validForMonths: null, gracePeriodDays: null }],
    };
    const { effects, casesToInsert } = await computeRequiredAssessmentsChange(
      makeDb(store), ORG, { kind: 'org' }, { requiredCompetencyIds: ['cB'] }, NOW,
    );

    expect(effects.affected).toBe(3); // active only — never the leaver
    expect(effects.created).toBe(2); // u2 and u3
    expect(casesToInsert.map((c) => c.candidateUserId).sort()).toEqual(['u2', 'u3']);
    expect(effects.created).toBe(casesToInsert.length); // preview == apply
  });

  it('expands LOCATION holders by placement and DEPARTMENT holders by placement (R3)', async () => {
    // m1 is placed at loc-A; m2 is placed in dep-B; neither holds any role.
    // The location change reaches only m1, the department change only m2.
    const store: Store = {
      competencyRequirements: [],
      memberships: [
        { id: 'm1', orgId: ORG, userId: 'u1', status: 'active' },
        { id: 'm2', orgId: ORG, userId: 'u2', status: 'active' },
      ],
      membershipRoles: [],
      membershipLocations: [{ membershipId: 'm1', locationId: 'loc-A', position: 0 }],
      membershipDepartments: [{ membershipId: 'm2', departmentId: 'dep-B', position: 0 }],
      assessmentTools: [tool('tB', ['cB'])],
      formTemplates: [template('tpl-tB', 'v1')],
      assessmentCases: [],
      competencyHolders: [],
      competencies: [],
    };
    const atLocation = await computeRequiredAssessmentsChange(
      makeDb(store), ORG, { kind: 'location', id: 'loc-A' }, { requiredCompetencyIds: ['cB'] }, NOW,
    );
    expect(atLocation.effects.affected).toBe(1);
    expect(atLocation.casesToInsert.map((c) => c.candidateUserId)).toEqual(['u1']);

    const atDepartment = await computeRequiredAssessmentsChange(
      makeDb(store), ORG, { kind: 'department', id: 'dep-B' }, { requiredCompetencyIds: ['cB'] }, NOW,
    );
    expect(atDepartment.effects.affected).toBe(1);
    // m2 has no location placement, so nothing is bookable for them (KTD4's
    // no-location skip) — the requirement lands in standing, not in a case.
    expect(atDepartment.effects.created).toBe(0);
  });

  it('counts ACTIVE memberships at the placement and role scopes too, never just at org', async () => {
    /*
      A leaver keeps their placement and role rows — the record is retained —
      so the raw placement read still names them. Counting them as `affected`
      while `created` plans only for the people the engine would actually book
      reported two different populations in one preview sentence, and made an
      org-scope save disagree with a location-scope one about the same site's
      headcount. Every arm narrows to active.
    */
    const store: Store = {
      competencyRequirements: [],
      memberships: [
        { id: 'm1', orgId: ORG, userId: 'u1', status: 'active' },
        { id: 'm2', orgId: ORG, userId: 'u2', status: 'suspended' },
      ],
      membershipRoles: [
        { membershipId: 'm1', roleId: 'role-1', withdrawnAt: null },
        { membershipId: 'm2', roleId: 'role-1', withdrawnAt: null },
      ],
      membershipLocations: [
        { membershipId: 'm1', locationId: 'loc-A', position: 0 },
        { membershipId: 'm2', locationId: 'loc-A', position: 0 },
      ],
      membershipDepartments: [
        { membershipId: 'm1', departmentId: 'dep-B', position: 0 },
        { membershipId: 'm2', departmentId: 'dep-B', position: 0 },
      ],
      assessmentTools: [tool('tB', ['cB'])],
      formTemplates: [template('tpl-tB', 'v1')],
      assessmentCases: [],
      competencyHolders: [],
      competencies: [],
    };
    for (const scope of [
      ROLE,
      { kind: 'location', id: 'loc-A' } as const,
      { kind: 'department', id: 'dep-B' } as const,
      { kind: 'org' } as const,
    ]) {
      const { effects, casesToInsert } = await computeRequiredAssessmentsChange(
        makeDb(store), ORG, scope, { requiredCompetencyIds: ['cB'] }, NOW,
      );
      expect(effects.affected).toBe(1);
      expect(effects.created).toBe(1);
      expect(casesToInsert.map((c) => c.candidateUserId)).toEqual(['u1']);
    }
  });

  it('AE4: removing an org-duplicated competency from the ROLE alone changes nothing for holders, and the preview says so', async () => {
    // cB is required at BOTH org scope and role-1. Dropping it from role-1:
    // the holder's post-change set still carries cB through the org scope, so
    // nothing demotes and the in-flight case is still obliged — zero standing
    // changes, exactly what the confirm dialog must say (KTD5's subtraction).
    const store: Store = {
      competencyRequirements: [link('role-1', 'cB'), orgLink('cB')],
      ...member('m1', 'u1', ['role-1']),
      assessmentTools: [tool('tB', ['cB'])],
      formTemplates: [template('tpl-tB')],
      assessmentCases: [{ id: 'case-b', orgId: ORG, candidateUserId: 'u1', toolId: 'tB', state: 'open' }],
      competencyHolders: [grant('u1', 'cB')],
      competencies: [{ id: 'cB', orgId: ORG, validForMonths: null, gracePeriodDays: null }],
    };
    const { effects } = await computeRequiredAssessmentsChange(
      makeDb(store), ORG, ROLE, { requiredCompetencyIds: [] }, NOW,
    );

    expect(effects.removedCompetencyIds).toEqual(['cB']); // it DOES leave this scope's list
    expect(effects.competenciesDemoting).toBe(0); // …but the org scope still requires it
    expect(effects.inFlightContinuing).toBe(0); // the case is still obliged, not orphaned
    expect(effects.created).toBe(0);
  });

  it('pins the retired split: a retired LOCATION contributes nothing to the post-change set, a retired-but-held ROLE keeps contributing', async () => {
    // Editing role-1 to drop cB. The holder's OTHER cover for cB is a
    // location requirement — while that location is ACTIVE nothing demotes;
    // the moment it is RETIRED its cover evaporates ("stops applying", U4
    // split) and the demotion is real.
    const base: Store = {
      competencyRequirements: [link('role-1', 'cB'), locLink('loc-9', 'cB')],
      ...member('m1', 'u1', ['role-1']),
      assessmentTools: [tool('tB', ['cB'])],
      formTemplates: [template('tpl-tB')],
      assessmentCases: [],
      competencyHolders: [grant('u1', 'cB')],
      competencies: [{ id: 'cB', orgId: ORG, validForMonths: null, gracePeriodDays: null }],
    };
    base.membershipLocations = [{ membershipId: 'm1', locationId: 'loc-9', position: 0 }];

    const activeWorld = { ...base, locations: [{ id: 'loc-9', orgId: ORG, status: 'active' }] };
    const activeRun = await computeRequiredAssessmentsChange(
      makeDb(activeWorld), ORG, ROLE, { requiredCompetencyIds: [] }, NOW,
    );
    expect(activeRun.effects.competenciesDemoting).toBe(0); // covered by the active location

    const retiredWorld = { ...base, locations: [{ id: 'loc-9', orgId: ORG, status: 'retired' }] };
    const retiredRun = await computeRequiredAssessmentsChange(
      makeDb(retiredWorld), ORG, ROLE, { requiredCompetencyIds: [] }, NOW,
    );
    expect(retiredRun.effects.competenciesDemoting).toBe(1); // retired location covers nothing

    // The ROLE half of the split: the other cover is a link on role-2, which
    // the holder still HOLDS though the role itself is retired. Role
    // retirement withdraws nobody (R119), so the expansion never reads
    // jobRoles.status — the cover holds and nothing demotes.
    const heldRetiredRole: Store = {
      ...base,
      membershipLocations: [],
      competencyRequirements: [link('role-1', 'cB'), link('role-2', 'cB')],
      membershipRoles: [
        { membershipId: 'm1', roleId: 'role-1', withdrawnAt: null },
        { membershipId: 'm1', roleId: 'role-2', withdrawnAt: null },
      ],
      jobRoles: [{ id: 'role-2', orgId: ORG, status: 'retired' }],
    };
    const heldRun = await computeRequiredAssessmentsChange(
      makeDb(heldRetiredRole), ORG, ROLE, { requiredCompetencyIds: [] }, NOW,
    );
    expect(heldRun.effects.competenciesDemoting).toBe(0);
  });

  it('keeps the query count FLAT as the org grows — the batching pin (U4 org-scale discipline)', async () => {
    // The same structural change (add cC, remove cB) against 2 members and
    // against 6. Every read is batched set-wise, so the number of queries the
    // compute issues must not depend on the membership count. Counted against
    // the fake — wall clock proves nothing here.
    const world = (memberCount: number): Store => {
      const store: Store = {
        competencyRequirements: [orgLink('cB')],
        memberships: [],
        membershipRoles: [],
        membershipLocations: [],
        assessmentTools: [tool('tB', ['cB']), tool('tC', ['cC'])],
        formTemplates: [template('tpl-tB', 'v1'), template('tpl-tC', 'v1')],
        assessmentCases: [],
        competencyHolders: [],
        competencies: [
          { id: 'cB', orgId: ORG, validForMonths: null, gracePeriodDays: null },
          { id: 'cC', orgId: ORG, validForMonths: null, gracePeriodDays: null },
        ],
      };
      for (let i = 1; i <= memberCount; i++) {
        store.memberships!.push({ id: `m${i}`, orgId: ORG, userId: `u${i}`, status: 'active' });
        store.membershipLocations!.push({ membershipId: `m${i}`, locationId: `loc${i}`, position: 0 });
        store.competencyHolders!.push(grant(`u${i}`, 'cB'));
      }
      return store;
    };

    const small = { reads: 0 };
    await computeRequiredAssessmentsChange(
      makeDb(world(2), small), ORG, { kind: 'org' }, { requiredCompetencyIds: ['cC'] }, NOW,
    );
    const large = { reads: 0 };
    const result = await computeRequiredAssessmentsChange(
      makeDb(world(6), large), ORG, { kind: 'org' }, { requiredCompetencyIds: ['cC'] }, NOW,
    );

    expect(result.effects.affected).toBe(6); // the large world really is larger
    expect(result.effects.created).toBe(6);
    expect(result.effects.competenciesDemoting).toBe(6); // and the removal path really ran
    expect(large.reads).toBe(small.reads); // …at the same query count
  });
});

// ── the award-link compute (U2, KTD3, KTD10) ─────────────────────────────────

describe('computeAwardLinkChange', () => {
  it('plans the conversion and the ACTIVATED cases with the pending award injected (KTD3)', async () => {
    // Two roles legacy-require tB; tB still awards NOTHING in the store, so a
    // plain plan would be vacuously satisfied and count zero. The compute must
    // inject the pending award: u1 lacks cB → one case; u2 holds cB → none.
    const store: Store = {
      roleRequiredAssessments: [
        { orgId: ORG, roleId: 'role-1', toolId: 'tB' },
        { orgId: ORG, roleId: 'role-2', toolId: 'tB' },
      ],
      competencyRequirements: [link('role-2', 'cB', 'recommended')],
      memberships: [
        { id: 'm1', orgId: ORG, userId: 'u1', status: 'active' },
        { id: 'm2', orgId: ORG, userId: 'u2', status: 'active' },
      ],
      membershipRoles: [
        { membershipId: 'm1', roleId: 'role-1', withdrawnAt: null },
        { membershipId: 'm2', roleId: 'role-2', withdrawnAt: null },
      ],
      membershipLocations: [
        { membershipId: 'm1', locationId: 'loc1', position: 0 },
        { membershipId: 'm2', locationId: 'loc2', position: 0 },
      ],
      assessmentTools: [tool('tB', [])], // empty awards — the pre-link state
      formTemplates: [template('tpl-tB', 'v1')],
      assessmentCases: [],
      competencyHolders: [grant('u2', 'cB')],
      competencies: [{ id: 'cB', orgId: ORG, validForMonths: null, gracePeriodDays: null }],
    };
    const plan = await computeAwardLinkChange(
      makeDb(store) as never, ORG, 'tB', 'cB', NOW,
    );

    expect(plan.effects).toEqual({ rolesLinked: 2, affected: 2, created: 1 });
    expect(plan.casesToInsert).toHaveLength(1);
    expect(plan.casesToInsert[0]).toMatchObject({ toolId: 'tB', candidateUserId: 'u1' });
    // role-1 gains a fresh link; role-2's recommended row is UPGRADED, never a
    // second row against the unique index.
    expect(plan.roleLinkPlan).toEqual(
      expect.arrayContaining([
        { roleId: 'role-1', action: 'insert' },
        { roleId: 'role-2', action: 'upgrade', existingLinkId: 'link-role-2-cB' },
      ]),
    );
  });

  it('plans the case for the tool the KTD2 RESOLVER will keep naming, not the tool being linked', async () => {
    /*
      TWO TOOLS, ONE COMPETENCY. `t-early` is published and already awards cB;
      `t-late` is the award-less tool an admin is backfilling onto the same cB.
      KTD2's resolver picks the FIRST candidate by (createdAt, id) — so once
      the link lands, every read site (assignment, standing, compliance) keeps
      naming `t-early`.

      Planning the activation against `t-late` regardless would open a case for
      an assessment the converted Role no longer derives: the person would
      carry work that satisfies nothing, and "preview == apply" would hold only
      against a write the rest of the system disagrees with. So the plan must
      name the resolver's winner, and this test pins the two answers TOGETHER
      rather than asserting the plan alone.
    */
    const store: Store = {
      roleRequiredAssessments: [{ id: 'rr1', orgId: ORG, roleId: 'role-1', toolId: 't-late' }],
      competencyRequirements: [],
      ...member('m1', 'u1', ['role-1']),
      assessmentTools: [
        tool('t-early', ['cB'], { createdAt: new Date('2026-01-01T00:00:00Z') }),
        tool('t-late', [], { createdAt: new Date('2026-05-01T00:00:00Z') }),
      ],
      formTemplates: [template('tpl-t-early', 'v1'), template('tpl-t-late', 'v2')],
      assessmentCases: [],
      competencyHolders: [],
      competencies: [{ id: 'cB', orgId: ORG, validForMonths: null, gracePeriodDays: null }],
    };
    const db = makeDb(store);
    const plan = await computeAwardLinkChange(db as never, ORG, 't-late', 'cB', NOW);

    expect(plan.effects).toEqual({ rolesLinked: 1, affected: 1, created: 1 });
    expect(plan.casesToInsert.map((c) => c.toolId)).toEqual(['t-early']);

    // Now APPLY the plan to the store — the award written, the legacy row
    // converted to a direct link — and ask the resolver the same question the
    // sweep and the compliance report will ask tomorrow.
    (store.assessmentTools!.find((t) => t.id === 't-late') as { awardedCompetencyIds: string[] })
      .awardedCompetencyIds = ['cB'];
    store.roleRequiredAssessments = [];
    store.competencyRequirements = [link('role-1', 'cB')];

    // Asked of the MEMBERSHIP-shaped read — the one resolver left at the
    // assignment seam since the per-role dual read was deleted (KTD4). m1
    // holds role-1 and nothing else, so its union is exactly that role's.
    const toolIds = await requiredToolIdsForMembership(db as never, ORG, 'm1');
    expect(toolIds).toEqual(['t-early']);
    // The invariant in one line: the case created is FOR the tool the resolver
    // keeps naming.
    expect(toolIds).toEqual([...new Set(plan.casesToInsert.map((c) => c.toolId))]);
  });

  it('plans one case for a holder of TWO linked roles, not two (dedupe by membership)', async () => {
    const store: Store = {
      roleRequiredAssessments: [
        { orgId: ORG, roleId: 'role-1', toolId: 'tB' },
        { orgId: ORG, roleId: 'role-2', toolId: 'tB' },
      ],
      competencyRequirements: [],
      ...member('m1', 'u1', ['role-1', 'role-2']),
      assessmentTools: [tool('tB', [])],
      formTemplates: [template('tpl-tB', 'v1')],
      assessmentCases: [],
      competencyHolders: [],
      competencies: [],
    };
    const plan = await computeAwardLinkChange(makeDb(store) as never, ORG, 'tB', 'cB', NOW);

    expect(plan.effects).toEqual({ rolesLinked: 2, affected: 1, created: 1 });
  });
});
