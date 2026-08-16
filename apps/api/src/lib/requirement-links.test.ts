/**
 * The shared resolver (KTD2): competency → awarding tool, and the per-role
 * dual read that feeds the assignment engine. The resolution ORDER is the
 * load-bearing fact — (createdAt, id) ascending, first wins — because preview
 * and apply both call this and must name the same tool.
 */
import { describe, expect, it, vi } from 'vitest';

// The module imports `db` for its type only and takes the database as a
// parameter, so a null module db is all this needs.
vi.mock('../db.js', () => ({ db: null, getDbStatus: () => 'unconfigured' }));

const { awardingToolByCompetency, awardingToolFor, requiredToolIdsForMembership } = await import(
  './requirement-links.js'
);

const ORG = 'org-1';

// ── a store-backed fake db honouring eq / and / inArray WHEREs ───────────────
// Same machinery as requirement-change.test.ts — the tier filter and the org
// scope live in WHERE clauses, and a mock returning whatever was seeded would
// pass with them deleted.

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

/** Column names the WHERE demands be NULL — `isNull` on scope columns and
 * `withdrawn_at` is load-bearing (KTD1's org shape, R52), so the fake honours it. */
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

/** Both surfaces read the same store; every read records its surface (KTD3 pin). */
function makeDb(store: Store, { withTransaction = true } = {}) {
  const reads: { surface: 'root' | 'tx'; table: string }[] = [];
  const tables = (surface: 'root' | 'tx') => {
    const table = (name: string) => ({
      findMany: async (args?: { where?: unknown }) => {
        reads.push({ surface, table: name });
        return (store[name] ?? []).filter((r) => matchesWhere(r, args?.where));
      },
    });
    return {
      roleRequiredAssessments: table('roleRequiredAssessments'),
      competencyRequirements: table('competencyRequirements'),
      assessmentTools: table('assessmentTools'),
      formTemplates: table('formTemplates'),
      // Scope expansion for the membership-shaped read (U2/U3).
      membershipRoles: table('membershipRoles'),
      membershipLocations: table('membershipLocations'),
      membershipDepartments: table('membershipDepartments'),
      locations: table('locations'),
      departments: table('departments'),
    };
  };
  const tx = { query: tables('tx') };
  // The config is captured, not ignored: the KTD3 pin is only real at
  // `repeatable read`, and a mock that dropped the second argument would let
  // the option be deleted without a single test noticing.
  const transaction = vi.fn(
    async (fn: (t: unknown) => Promise<unknown>, _config?: { isolationLevel?: string }) => fn(tx),
  );
  const db = {
    query: tables('root'),
    ...(withTransaction ? { transaction } : {}),
  } as unknown as Parameters<typeof requiredToolIdsForMembership>[0];
  return { db, transaction, reads };
}

const AT = (iso: string) => new Date(iso);

function tool(id: string, awards: string[], createdAt: Date, templateId = `tpl-${id}`) {
  return { id, orgId: ORG, templateId, awardedCompetencyIds: awards, createdAt };
}
const template = (id: string, currentVersionId: string | null) => ({ id, orgId: ORG, currentVersionId });
const link = (roleId: string, competencyId: string, tier: 'required' | 'recommended' = 'required') => ({
  id: `link-${roleId}-${competencyId}`,
  orgId: ORG,
  roleId,
  competencyId,
  tier,
});

describe('awardingToolByCompetency', () => {
  it('picks the earliest-created qualifying tool, breaking a createdAt tie by id (KTD2)', async () => {
    const shared = AT('2026-02-01T00:00:00Z');
    const { db } = makeDb({
      assessmentTools: [
        tool('t-later', ['c1'], AT('2026-03-01T00:00:00Z')),
        tool('t-zz', ['c1'], shared),
        tool('t-aa', ['c1'], shared),
      ],
      formTemplates: [
        template('tpl-t-later', 'v1'),
        template('tpl-t-zz', 'v2'),
        template('tpl-t-aa', 'v3'),
      ],
    });

    const byCompetency = await awardingToolByCompetency(db, ORG, ['c1']);

    expect(byCompetency.get('c1')).toBe('t-aa'); // earliest createdAt, then lowest id
  });

  it('never resolves to a tool whose template has no published version (KTD2)', async () => {
    // The older tool is unbookable; the younger, published one wins — never
    // "book the assessment" for something that cannot carry a case.
    const { db } = makeDb({
      assessmentTools: [
        tool('t-old-unpublished', ['c1'], AT('2026-01-01T00:00:00Z')),
        tool('t-new-published', ['c1'], AT('2026-02-01T00:00:00Z')),
      ],
      formTemplates: [
        template('tpl-t-old-unpublished', null),
        template('tpl-t-new-published', 'v1'),
      ],
    });

    expect(await awardingToolFor(db, ORG, 'c1')).toBe('t-new-published');
  });

  it('resolves to nothing for a licence-type competency no tool awards (R7)', async () => {
    const { db } = makeDb({
      assessmentTools: [tool('t1', ['c-other'], AT('2026-01-01T00:00:00Z'))],
      formTemplates: [template('tpl-t1', 'v1')],
    });

    expect(await awardingToolFor(db, ORG, 'c-licence')).toBeNull();
  });
});

// ── the ONE membership-shaped read at the assignment seam (U2, KTD4): ────────
// ── scope expansion → union → tool resolution. The per-ROLE dual read that ───
// ── this replaced is deleted, not merely unused (review-verified: no ─────────
// ── production caller survived U3), so nothing here pins it any more. ────────

/** One-scope link rows (KTD1) — explicit nulls so the org query's `is null` bites. */
const scoped = (
  scope: { roleId?: string; locationId?: string; departmentId?: string },
  competencyId: string,
  tier: 'required' | 'recommended' = 'required',
) => ({
  id: `link-${scope.roleId ?? scope.locationId ?? scope.departmentId ?? 'org'}-${competencyId}`,
  orgId: ORG,
  roleId: null,
  locationId: null,
  departmentId: null,
  competencyId,
  tier,
  ...scope,
});

/** A membership placed/holding across the three key tables, with active values. */
function placedMembership(
  m: string,
  { roleIds = [], locationIds = [], departmentIds = [] }: Record<string, string[]>,
) {
  return {
    membershipRoles: roleIds.map((roleId) => ({ membershipId: m, roleId, withdrawnAt: null })),
    membershipLocations: locationIds.map((locationId) => ({ membershipId: m, locationId })),
    membershipDepartments: departmentIds.map((departmentId) => ({ membershipId: m, departmentId })),
    locations: locationIds.map((id) => ({ id, orgId: ORG, status: 'active' })),
    departments: departmentIds.map((id) => ({ id, orgId: ORG, status: 'active' })),
  };
}

describe('requiredToolIdsForMembership', () => {
  it('unions all four scopes AND the legacy rows into one tool set, deduplicated (KTD4, KTD2)', async () => {
    const { db } = makeDb({
      ...placedMembership('m1', { roleIds: ['r1'], locationIds: ['loc1'], departmentIds: ['dep1'] }),
      roleRequiredAssessments: [{ id: 'rr1', orgId: ORG, roleId: 'r1', toolId: 't-legacy' }],
      competencyRequirements: [
        scoped({ roleId: 'r1' }, 'c-role'),
        scoped({ locationId: 'loc1' }, 'c-loc'),
        scoped({ departmentId: 'dep1' }, 'c-dept'),
        scoped({}, 'c-org'),
        // Cross-scope duplicate resolving to the SAME tool as the role link —
        // the union carries one entry, never two (AE4's read side).
        scoped({ locationId: 'loc1' }, 'c-role'),
      ],
      assessmentTools: [
        tool('t-legacy', [], AT('2026-01-01T00:00:00Z')),
        tool('t-role', ['c-role'], AT('2026-01-02T00:00:00Z')),
        tool('t-loc', ['c-loc'], AT('2026-01-03T00:00:00Z')),
        tool('t-dept', ['c-dept'], AT('2026-01-04T00:00:00Z')),
        tool('t-org', ['c-org'], AT('2026-01-05T00:00:00Z')),
      ],
      formTemplates: ['t-legacy', 't-role', 't-loc', 't-dept', 't-org'].map((t) =>
        template(`tpl-${t}`, 'v1'),
      ),
    });

    const toolIds = await requiredToolIdsForMembership(db, ORG, 'm1');

    expect([...toolIds].sort()).toEqual(['t-dept', 't-legacy', 't-loc', 't-org', 't-role']);
  });

  it('reaches a membership with NO roles through the org scope (KTD4 — the early return is dead)', async () => {
    // The exact shape the zero-roles early return used to drop on the floor:
    // no membership_roles row anywhere, an org-wide requirement, one tool.
    const { db } = makeDb({
      ...placedMembership('m1', { locationIds: ['loc1'] }),
      competencyRequirements: [scoped({}, 'c-org')],
      assessmentTools: [tool('t-org', ['c-org'], AT('2026-01-01T00:00:00Z'))],
      formTemplates: [template('tpl-t-org', 'v1')],
    });

    expect(await requiredToolIdsForMembership(db, ORG, 'm1')).toEqual(['t-org']);
  });

  it('keeps evidence-only requirements out of the tool set and recommended out entirely (R7, R13)', async () => {
    const { db } = makeDb({
      ...placedMembership('m1', { locationIds: ['loc1'] }),
      competencyRequirements: [
        scoped({ locationId: 'loc1' }, 'c-licence'), // nothing awards it
        scoped({}, 'c1', 'recommended'), // never enforced
      ],
      assessmentTools: [tool('t1', ['c1'], AT('2026-01-01T00:00:00Z'))],
      formTemplates: [template('tpl-t1', 'v1')],
    });

    expect(await requiredToolIdsForMembership(db, ORG, 'm1')).toEqual([]);
  });

  it('lets a RETIRED location confer no tools — its scope key drops out of the expansion (U4)', async () => {
    const { db } = makeDb({
      membershipLocations: [{ membershipId: 'm1', locationId: 'loc-gone' }],
      locations: [{ id: 'loc-gone', orgId: ORG, status: 'retired' }],
      competencyRequirements: [scoped({ locationId: 'loc-gone' }, 'c1')],
      assessmentTools: [tool('t1', ['c1'], AT('2026-01-01T00:00:00Z'))],
      formTemplates: [template('tpl-t1', 'v1')],
    });

    expect(await requiredToolIdsForMembership(db, ORG, 'm1')).toEqual([]);
  });

  it('pins the whole expansion — placement tables included — to ONE repeatable-read transaction (KTD3)', async () => {
    // The snapshot now covers the placement reads too: a location transfer
    // committing mid-read must not feed one placement to the scope expansion
    // and another to the requirement rows.
    const { db, transaction, reads } = makeDb({
      ...placedMembership('m1', { roleIds: ['r1'], locationIds: ['loc1'] }),
      roleRequiredAssessments: [{ id: 'rr1', orgId: ORG, roleId: 'r1', toolId: 't1' }],
      competencyRequirements: [scoped({ locationId: 'loc1' }, 'c2')],
      assessmentTools: [
        tool('t1', [], AT('2026-01-01T00:00:00Z')),
        tool('t2', ['c2'], AT('2026-01-02T00:00:00Z')),
      ],
      formTemplates: [template('tpl-t1', 'v1'), template('tpl-t2', 'v2')],
    });

    const toolIds = await requiredToolIdsForMembership(db, ORG, 'm1');

    expect([...toolIds].sort()).toEqual(['t1', 't2']);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((r) => r.surface === 'tx')).toBe(true);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'repeatable read',
    });
  });

  it('still reads correctly on a surface with no transaction (lean read-only callers)', async () => {
    const { db } = makeDb(
      {
        ...placedMembership('m1', { locationIds: ['loc1'] }),
        competencyRequirements: [scoped({ locationId: 'loc1' }, 'c1')],
        assessmentTools: [tool('t1', ['c1'], AT('2026-01-01T00:00:00Z'))],
        formTemplates: [template('tpl-t1', 'v1')],
      },
      { withTransaction: false },
    );

    expect(await requiredToolIdsForMembership(db, ORG, 'm1')).toEqual(['t1']);
  });
});
