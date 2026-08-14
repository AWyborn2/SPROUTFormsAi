/**
 * The standing LOADERS (U1 of the role-competency links round): required
 * standing is a DUAL READ — legacy Role → tool → awards derivation unioned
 * with direct `role_required_competencies` links (KTD3) — and recommended is
 * its single-source sibling that never bleeds into required (R13).
 *
 * The fake db here honours the WHERE clauses the loaders actually issue
 * (eq / and / inArray, plus `is null` on `withdrawn_at`), because the load-
 * bearing facts — a withdrawn Role contributing nothing, a tier filter keeping
 * recommended out of required — live in those clauses. A mock that returned
 * whatever was seeded would pass with the filters deleted.
 */
import { describe, expect, it, vi } from 'vitest';

// The module imports `db` for its type only and takes the database as a
// parameter, so a null module db is all this needs.
vi.mock('../db.js', () => ({ db: null, getDbStatus: () => 'unconfigured' }));

const { recommendedCompetencyIdsByUser, requiredCompetencyIdsByUser, requiredCompetencyIdsFor } =
  await import('./standing.js');

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
      roleRequiredAssessments: table('roleRequiredAssessments'),
      assessmentTools: table('assessmentTools'),
      roleRequiredCompetencies: table('roleRequiredCompetencies'),
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
  competencyId,
  tier,
});

describe('requiredCompetencyIdsByUser', () => {
  it('obliges through a direct required link with no tool involved (R5, R7)', async () => {
    // The licence case: nothing awards `c-licence`, no assessment exists —
    // the direct link alone makes it required.
    const { db } = makeDb({
      ...member('m1', 'u1', ['r1']),
      roleRequiredCompetencies: [link('r1', 'c-licence', 'required')],
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
      roleRequiredCompetencies: [
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
      roleRequiredCompetencies: [
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
      roleRequiredCompetencies: [link('r1', 'c-licence', 'required')],
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
      roleRequiredCompetencies: [link('r1', 'c-licence', 'required')],
    });

    await requiredCompetencyIdsByUser(db, ORG, ['u1']);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((r) => r.surface === 'tx')).toBe(true);
  });

  it('AE1: reads all FIVE required competencies when only one has an awarding tool (R5, R7)', async () => {
    // Dozer Operator: the ATO (awarded by an assessment) plus four
    // licence-type competencies nothing awards. Standing is the same size
    // either way — an evidence-only requirement is still a requirement.
    const FIVE = ['c-ato', 'c-licence', 'c-sme', 'c-grade', 'c-tip'];
    const { db } = makeDb({
      ...member('m1', 'u1', ['r1']),
      roleRequiredCompetencies: FIVE.map((c) => link('r1', c, 'required')),
      assessmentTools: [{ id: 't-ato', orgId: ORG, awardedCompetencyIds: ['c-ato'] }],
    });

    const byUser = await requiredCompetencyIdsByUser(db, ORG, ['u1']);

    expect([...byUser.get('u1')!].sort()).toEqual([...FIVE].sort());
  });

  it('maps every requested userId, empty set by default — nobody is absent', async () => {
    const { db } = makeDb({
      ...member('m1', 'u1', ['r1']),
      roleRequiredCompetencies: [link('r1', 'c-dozer', 'required')],
    });

    const byUser = await requiredCompetencyIdsByUser(db, ORG, ['u1', 'u-nobody']);

    expect(byUser.has('u-nobody')).toBe(true);
    expect(byUser.get('u-nobody')!.size).toBe(0);
    expect(byUser.get('u1')!.size).toBe(1);
  });

  it('serves the single-user shape through the same batch path', async () => {
    const { db } = makeDb({
      ...member('m1', 'u1', ['r1']),
      roleRequiredCompetencies: [link('r1', 'c-dozer', 'required')],
    });

    expect([...(await requiredCompetencyIdsFor(db, ORG, 'u1'))]).toEqual(['c-dozer']);
    expect((await requiredCompetencyIdsFor(db, ORG, 'u-nobody')).size).toBe(0);
  });
});

describe('recommendedCompetencyIdsByUser', () => {
  it('reads recommended links only — required never bleeds in (R6, R13)', async () => {
    const { db } = makeDb({
      ...member('m1', 'u1', ['r1']),
      roleRequiredCompetencies: [
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
      roleRequiredCompetencies: [link('r1', 'c-first-aid', 'recommended')],
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
});
