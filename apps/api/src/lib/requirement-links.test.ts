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

const { awardingToolByCompetency, awardingToolFor, requiredToolIdsByRole } = await import(
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

function matchesWhere(row: Record<string, unknown>, where: unknown): boolean {
  if (!where) return true;
  const { all, anyOf } = whereTerms(where);
  const present = new Set(Object.values(row).filter((v) => typeof v === 'string'));
  if (![...new Set(all)].every((w) => present.has(w))) return false;
  return anyOf.every((group) => group.some((w) => present.has(w)));
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
      roleRequiredCompetencies: table('roleRequiredCompetencies'),
      assessmentTools: table('assessmentTools'),
      formTemplates: table('formTemplates'),
    };
  };
  const tx = { query: tables('tx') };
  const transaction = vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx));
  const db = {
    query: tables('root'),
    ...(withTransaction ? { transaction } : {}),
  } as unknown as Parameters<typeof requiredToolIdsByRole>[0];
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

describe('requiredToolIdsByRole', () => {
  it('unions legacy rows with resolved direct links, deduplicating a tool both name (KTD3)', async () => {
    // Mid-transition: r1 legacy-requires t1 AND direct-requires c1, which t1
    // awards. One tool, not two entries.
    const { db } = makeDb({
      roleRequiredAssessments: [{ id: 'rr1', orgId: ORG, roleId: 'r1', toolId: 't1' }],
      roleRequiredCompetencies: [link('r1', 'c1'), link('r1', 'c2')],
      assessmentTools: [
        tool('t1', ['c1'], AT('2026-01-01T00:00:00Z')),
        tool('t2', ['c2'], AT('2026-01-02T00:00:00Z')),
      ],
      formTemplates: [template('tpl-t1', 'v1'), template('tpl-t2', 'v2')],
    });

    const byRole = await requiredToolIdsByRole(db, ORG, ['r1']);

    expect([...byRole.get('r1')!].sort()).toEqual(['t1', 't2']);
  });

  it('keeps an evidence-only requirement OUT of the tool set and recommended links out entirely (R7, R13)', async () => {
    const { db } = makeDb({
      roleRequiredCompetencies: [
        link('r1', 'c-licence', 'required'), // nothing awards it
        link('r1', 'c1', 'recommended'), // never enforced
      ],
      assessmentTools: [tool('t1', ['c1'], AT('2026-01-01T00:00:00Z'))],
      formTemplates: [template('tpl-t1', 'v1')],
    });

    const byRole = await requiredToolIdsByRole(db, ORG, ['r1']);

    expect(byRole.get('r1')).toEqual([]);
  });

  it('maps every requested roleId, empty array by default', async () => {
    const { db } = makeDb({});
    const byRole = await requiredToolIdsByRole(db, ORG, ['r1', 'r2']);
    expect(byRole.get('r1')).toEqual([]);
    expect(byRole.get('r2')).toEqual([]);
  });

  it('pins every read of the dual derivation to ONE transaction when the client offers one (KTD3)', async () => {
    const { db, transaction, reads } = makeDb({
      roleRequiredAssessments: [{ id: 'rr1', orgId: ORG, roleId: 'r1', toolId: 't1' }],
      roleRequiredCompetencies: [link('r1', 'c2')],
      assessmentTools: [
        tool('t1', [], AT('2026-01-01T00:00:00Z')),
        tool('t2', ['c2'], AT('2026-01-02T00:00:00Z')),
      ],
      formTemplates: [template('tpl-t1', 'v1'), template('tpl-t2', 'v2')],
    });

    const byRole = await requiredToolIdsByRole(db, ORG, ['r1']);

    expect([...byRole.get('r1')!].sort()).toEqual(['t1', 't2']);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((r) => r.surface === 'tx')).toBe(true);
  });

  it('still reads correctly on a surface with no transaction (lean read-only callers)', async () => {
    const { db } = makeDb(
      {
        roleRequiredCompetencies: [link('r1', 'c1')],
        assessmentTools: [tool('t1', ['c1'], AT('2026-01-01T00:00:00Z'))],
        formTemplates: [template('tpl-t1', 'v1')],
      },
      { withTransaction: false },
    );

    const byRole = await requiredToolIdsByRole(db, ORG, ['r1']);

    expect(byRole.get('r1')).toEqual(['t1']);
  });
});
