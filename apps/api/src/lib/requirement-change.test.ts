import { afterEach, describe, expect, it, vi } from 'vitest';

// The module imports `db` for its type only and takes the database as a
// parameter, so a null module db is all this needs.
vi.mock('../db.js', () => ({ db: null, getDbStatus: () => 'unconfigured' }));

const { computeRequiredAssessmentsChange } = await import('./requirement-change.js');

const ORG = 'org-1';
const NOW = new Date('2026-06-01T00:00:00Z');
const ROLE = { id: 'role-1' };

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

function matchesWhere(row: Record<string, unknown>, where: unknown): boolean {
  if (!where) return true;
  const { all, anyOf } = whereTerms(where);
  const present = new Set(Object.values(row).filter((v) => typeof v === 'string'));
  if (![...new Set(all)].every((w) => present.has(w))) return false;
  return anyOf.every((group) => group.some((w) => present.has(w)));
}

type Store = Record<string, Record<string, unknown>[]>;

function makeDb(store: Store) {
  const table = (name: string) => ({
    findMany: async (args?: { where?: unknown }) =>
      (store[name] ?? []).filter((r) => matchesWhere(r, args?.where)),
    findFirst: async (args?: { where?: unknown }) =>
      (store[name] ?? []).find((r) => matchesWhere(r, args?.where)),
  });
  return {
    query: {
      memberships: table('memberships'),
      membershipRoles: table('membershipRoles'),
      roleRequiredAssessments: table('roleRequiredAssessments'),
      assessmentTools: table('assessmentTools'),
      formTemplates: table('formTemplates'),
      membershipLocations: table('membershipLocations'),
      assessmentCases: table('assessmentCases'),
      competencyHolders: table('competencyHolders'),
      competencies: table('competencies'),
    },
  } as unknown as Parameters<typeof computeRequiredAssessmentsChange>[0];
}

const MANIFEST = { parts: [{ key: 'p1', ordinal: 1, label: 'P1', kind: 'theory', pathways: ['new'] }] };

/** A tool `t` that awards competency `c`, on a published template `tpl`. */
function tool(id: string, awards: string[], templateId = `tpl-${id}`) {
  return {
    id,
    orgId: ORG,
    templateId,
    awardedCompetencyIds: awards,
    manifest: MANIFEST,
    locationPartKeys: {},
    assessorStreamCompetencyIds: {},
  };
}
function template(id: string, currentVersionId: string | null = `v-${id}`) {
  return { id, orgId: ORG, currentVersionId };
}
/** Membership `m` for user `u`, holding roles `roleIds`, at one Location. */
function member(m: string, u: string, roleIds: string[]) {
  return {
    memberships: [{ id: m, orgId: ORG, userId: u }],
    membershipRoles: roleIds.map((roleId) => ({ membershipId: m, roleId, withdrawnAt: null })),
    membershipLocations: [{ membershipId: m, locationId: `loc-${m}`, position: 0 }],
  };
}

afterEach(() => vi.clearAllMocks());

// ── additions (R82–R84) ──────────────────────────────────────────────────────

describe('computeRequiredAssessmentsChange — additions', () => {
  it('counts affected as every holder and created as the holders left unmet (R84)', async () => {
    // Three holders of role-1; the change adds tool tB (awards cB). Two hold cB
    // current, one does not — so affected 3, created 1.
    const store: Store = {
      roleRequiredAssessments: [{ orgId: ORG, roleId: 'role-1', toolId: 'tA' }], // current {A}
      membershipRoles: [
        { membershipId: 'm1', roleId: 'role-1', withdrawnAt: null },
        { membershipId: 'm2', roleId: 'role-1', withdrawnAt: null },
        { membershipId: 'm3', roleId: 'role-1', withdrawnAt: null },
      ],
      memberships: [
        { id: 'm1', orgId: ORG, userId: 'u1' },
        { id: 'm2', orgId: ORG, userId: 'u2' },
        { id: 'm3', orgId: ORG, userId: 'u3' },
      ],
      membershipLocations: [
        { membershipId: 'm1', locationId: 'loc1', position: 0 },
        { membershipId: 'm2', locationId: 'loc2', position: 0 },
        { membershipId: 'm3', locationId: 'loc3', position: 0 },
      ],
      assessmentTools: [tool('tB', ['cB'])],
      formTemplates: [template('tpl-tB', 'v1')],
      assessmentCases: [],
      competencyHolders: [
        // u1 and u2 already hold cB, current (never expires); u3 holds nothing.
        { competencyId: 'cB', userId: 'u1', orgId: ORG, grantedAt: new Date('2025-01-01'), expiresAt: null, revokedAt: null },
        { competencyId: 'cB', userId: 'u2', orgId: ORG, grantedAt: new Date('2025-01-01'), expiresAt: null, revokedAt: null },
      ],
      competencies: [{ id: 'cB', orgId: ORG, validForMonths: null, gracePeriodDays: null }],
    };
    const { effects, casesToInsert } = await computeRequiredAssessmentsChange(
      makeDb(store), ORG, ROLE, ['tA', 'tB'], NOW,
    );

    expect(effects.addedToolIds).toEqual(['tB']);
    expect(effects.removedToolIds).toEqual([]);
    expect(effects.affected).toBe(3);
    expect(effects.created).toBe(1); // only u3
    expect(casesToInsert).toHaveLength(1);
    expect(casesToInsert[0]).toMatchObject({ toolId: 'tB', candidateUserId: 'u3', orgId: ORG });
    // KTD10 invariant: created is exactly the plan length.
    expect(effects.created).toBe(casesToInsert.length);
  });

  it('creates one case per newly-obliged holder when none hold the competency', async () => {
    const store: Store = {
      roleRequiredAssessments: [],
      ...merge(member('m1', 'u1', ['role-1']), member('m2', 'u2', ['role-1'])),
      assessmentTools: [tool('tB', ['cB'])],
      formTemplates: [template('tpl-tB', 'v1')],
      assessmentCases: [],
      competencyHolders: [],
      competencies: [],
    };
    const { effects } = await computeRequiredAssessmentsChange(makeDb(store), ORG, ROLE, ['tB'], NOW);
    expect(effects.affected).toBe(2);
    expect(effects.created).toBe(2);
  });

  it('creates nothing for a holder who already has an open case for the added tool (KTD16)', async () => {
    const store: Store = {
      roleRequiredAssessments: [],
      ...member('m1', 'u1', ['role-1']),
      assessmentTools: [tool('tB', ['cB'])],
      formTemplates: [template('tpl-tB', 'v1')],
      assessmentCases: [{ id: 'c-open', orgId: ORG, candidateUserId: 'u1', toolId: 'tB', state: 'open' }],
      competencyHolders: [],
      competencies: [],
    };
    const { effects } = await computeRequiredAssessmentsChange(makeDb(store), ORG, ROLE, ['tB'], NOW);
    expect(effects.affected).toBe(1);
    expect(effects.created).toBe(0);
  });
});

// ── removals (R55, R56) ──────────────────────────────────────────────────────

describe('computeRequiredAssessmentsChange — removals', () => {
  it('reports affected, in-flight-continuing and competencies-demoting, never a created count (R85)', async () => {
    // role-1 currently requires {A, B}; the change drops B. One holder u1 has an
    // in-flight B case and holds cB (which B awards); nothing left requires cB.
    const store: Store = {
      roleRequiredAssessments: [
        { orgId: ORG, roleId: 'role-1', toolId: 'tA' },
        { orgId: ORG, roleId: 'role-1', toolId: 'tB' },
      ],
      ...member('m1', 'u1', ['role-1']),
      assessmentTools: [tool('tA', ['cA']), tool('tB', ['cB'])],
      formTemplates: [template('tpl-tA'), template('tpl-tB')],
      assessmentCases: [{ id: 'case-b', orgId: ORG, candidateUserId: 'u1', toolId: 'tB', state: 'open' }],
      competencyHolders: [
        { competencyId: 'cB', userId: 'u1', orgId: ORG, grantedAt: new Date('2025-01-01'), expiresAt: null, revokedAt: null },
      ],
      competencies: [{ id: 'cB', orgId: ORG, validForMonths: null, gracePeriodDays: null }],
    };
    const { effects } = await computeRequiredAssessmentsChange(makeDb(store), ORG, ROLE, ['tA'], NOW);

    expect(effects.removedToolIds).toEqual(['tB']);
    expect(effects.affected).toBe(1);
    expect(effects.inFlightContinuing).toBe(1);
    expect(effects.competenciesDemoting).toBe(1);
    expect(effects.created).toBe(0); // R85: a removal never reports a creation
  });

  it('does not demote a competency another Role the holder still carries requires (R56, cross-role)', async () => {
    // u1 carries role-1 (dropping B) AND role-2 (which still requires B). B's
    // competency stays required, and B's in-flight case is still obligatory.
    const store: Store = {
      roleRequiredAssessments: [
        { orgId: ORG, roleId: 'role-1', toolId: 'tB' },
        { orgId: ORG, roleId: 'role-2', toolId: 'tB' },
      ],
      ...member('m1', 'u1', ['role-1', 'role-2']),
      assessmentTools: [tool('tB', ['cB'])],
      formTemplates: [template('tpl-tB')],
      assessmentCases: [{ id: 'case-b', orgId: ORG, candidateUserId: 'u1', toolId: 'tB', state: 'open' }],
      competencyHolders: [
        { competencyId: 'cB', userId: 'u1', orgId: ORG, grantedAt: new Date('2025-01-01'), expiresAt: null, revokedAt: null },
      ],
      competencies: [{ id: 'cB', orgId: ORG, validForMonths: null, gracePeriodDays: null }],
    };
    // role-1 desired = {} (drop B); role-2 still requires B.
    const { effects } = await computeRequiredAssessmentsChange(makeDb(store), ORG, ROLE, [], NOW);

    expect(effects.removedToolIds).toEqual(['tB']);
    expect(effects.inFlightContinuing).toBe(0); // still required via role-2
    expect(effects.competenciesDemoting).toBe(0);
  });

  it('counts a non-terminal awaiting_sign_off case as in flight, and ignores a competent one', async () => {
    const store: Store = {
      roleRequiredAssessments: [{ orgId: ORG, roleId: 'role-1', toolId: 'tB' }],
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
    const { effects } = await computeRequiredAssessmentsChange(makeDb(store), ORG, ROLE, [], NOW);
    expect(effects.inFlightContinuing).toBe(1); // only the awaiting_sign_off one
  });
});

// ── mixed add + remove in one save (union-by-presence) ───────────────────────

describe('computeRequiredAssessmentsChange — mixed', () => {
  it('reports created alongside the removal counters in a single save', async () => {
    // current {A, B}; desired {A, C}: drops B, adds C. u1 holds cB and has an
    // in-flight B case, and does not hold cC.
    const store: Store = {
      roleRequiredAssessments: [
        { orgId: ORG, roleId: 'role-1', toolId: 'tA' },
        { orgId: ORG, roleId: 'role-1', toolId: 'tB' },
      ],
      ...member('m1', 'u1', ['role-1']),
      assessmentTools: [tool('tA', ['cA']), tool('tB', ['cB']), tool('tC', ['cC'])],
      formTemplates: [template('tpl-tA'), template('tpl-tB'), template('tpl-tC', 'v1')],
      assessmentCases: [{ id: 'case-b', orgId: ORG, candidateUserId: 'u1', toolId: 'tB', state: 'open' }],
      competencyHolders: [
        { competencyId: 'cB', userId: 'u1', orgId: ORG, grantedAt: new Date('2025-01-01'), expiresAt: null, revokedAt: null },
      ],
      competencies: [{ id: 'cB', orgId: ORG, validForMonths: null, gracePeriodDays: null }],
    };
    const { effects } = await computeRequiredAssessmentsChange(makeDb(store), ORG, ROLE, ['tA', 'tC'], NOW);

    expect(effects.addedToolIds).toEqual(['tC']);
    expect(effects.removedToolIds).toEqual(['tB']);
    expect(effects.created).toBe(1); // the C case for u1
    expect(effects.inFlightContinuing).toBe(1); // the B case
    expect(effects.competenciesDemoting).toBe(1); // cB now behind no requirement
  });
});

/** Shallow-merge the array-valued fixtures a couple of `member()` calls return. */
function merge(...parts: Record<string, Record<string, unknown>[]>[]): Record<string, Record<string, unknown>[]> {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const p of parts) for (const [k, v] of Object.entries(p)) out[k] = [...(out[k] ?? []), ...v];
  return out;
}
