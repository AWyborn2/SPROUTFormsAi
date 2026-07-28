/**
 * Assessment cases, end to end.
 *
 * These run against a STATEFUL fake database rather than the usual
 * return-a-fixture stub, because the behaviour worth proving here is
 * compositional: that a retry allocates a second attempt row while the first
 * survives, that a part stays locked until its predecessor passes, and that a
 * case flips to competent only once every required part has. A stub that
 * returns canned rows per call cannot show any of that — it would assert the
 * fixtures, not the logic.
 *
 * The fake honours `where` by extracting the bound values from the drizzle SQL
 * object and requiring each to match some field of a row. Every filter in this
 * router is equality on identifying columns, so that approximation is exact
 * here; it would not be for range or negation predicates.
 */
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Db } from '@formai/db';
import { DEFAULT_ROLE_PERMISSIONS, type AssessmentToolManifest, type FormField } from '@formai/shared';

const ORG = 'org-1';
const ADMIN = '00000000-0000-4000-8000-00000000000a';
const CANDIDATE = '00000000-0000-4000-8000-00000000000c';
const OTHER_CANDIDATE = '00000000-0000-4000-8000-00000000000d';
const TEMPLATE = '00000000-0000-4000-8000-000000000001';
const VERSION = '00000000-0000-4000-8000-000000000002';

const admin = { userId: ADMIN, orgId: ORG, role: 'admin' as const };
const candidate = { userId: CANDIDATE, orgId: ORG, role: 'candidate' as const };

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

type Session = { userId: string; orgId: string; role: string };
const auth = (t: Session = admin) => ({
  cookie: `fai_session=${sealSession(t)}`,
  'content-type': 'application/json',
});

// ── the template the manifest is authored against ───────────────────────────

const header = (id: string): FormField => ({
  id,
  type: 'section_header',
  label: id,
  required: false,
  source: 'imported',
});

const FIELDS: FormField[] = [
  header('h-theory'),
  header('h-general'),
  {
    id: 'q1',
    type: 'checkbox_group',
    label: 'Q1',
    required: true,
    source: 'imported',
    options: ['a', 'b'],
    answerKey: ['a'],
    outcomeTarget: { fieldId: 'q1-out' },
  },
  { id: 'q1-out', type: 'check_cross', label: 'Q1 outcome', required: false, source: 'imported' },
  header('h-prac1'),
  header('h-log'),
  header('h-prac2'),
];

const MANIFEST: AssessmentToolManifest = {
  parts: [
    {
      key: 'p1',
      ordinal: 1,
      label: 'Part 1 Theory',
      kind: 'theory',
      pathways: ['experienced', 'new', 'rpl'],
      startFieldId: 'h-theory',
      mandatorySectionFieldId: 'h-general',
    },
    {
      key: 'p2',
      ordinal: 2,
      label: 'Part 2 Practical',
      kind: 'practical',
      pathways: ['experienced', 'new', 'rpl'],
      startFieldId: 'h-prac1',
    },
    {
      key: 'p3',
      ordinal: 3,
      label: 'Part 3 Logbook',
      kind: 'logbook',
      pathways: ['new'],
      startFieldId: 'h-log',
      minimumHours: 20,
    },
    {
      key: 'p4',
      ordinal: 4,
      label: 'Part 4 Practical',
      kind: 'practical',
      pathways: ['new'],
      startFieldId: 'h-prac2',
    },
  ],
};

// ── stateful fake database ──────────────────────────────────────────────────

/** Bound values inside a drizzle where-clause. */
function whereValues(node: unknown, depth = 0, out: string[] = []): string[] {
  if (!node || depth > 8) return out;
  if (Array.isArray(node)) {
    for (const n of node) whereValues(n, depth + 1, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  const rec = node as Record<string, unknown>;
  if (typeof rec.value === 'string') out.push(rec.value);
  for (const v of Object.values(rec)) whereValues(v, depth + 1, out);
  return out;
}

function matchesWhere(row: Record<string, unknown>, where: unknown): boolean {
  if (!where) return true;
  const wanted = [...new Set(whereValues(where))];
  const present = new Set(Object.values(row).filter((v) => typeof v === 'string'));
  return wanted.every((w) => present.has(w));
}

let idSeq = 0;
/** Real UUID shapes — the routes validate ids as UUIDs, so the fake must too. */
const nextId = () => `00000000-0000-4000-8000-${String(++idSeq).padStart(12, '0')}`;

function makeDb(opts: { planTier?: string; role?: keyof typeof DEFAULT_ROLE_PERMISSIONS } = {}) {
  const store: Record<string, Record<string, unknown>[]> = {
    organizations: [{ id: ORG, planTier: opts.planTier ?? 'business', seatLimit: 15, candidateSeatLimit: 200 }],
    rolePermissions: [
      { id: nextId(), orgId: ORG, role: 'admin', matrix: DEFAULT_ROLE_PERMISSIONS.admin },
      { id: nextId(), orgId: ORG, role: 'candidate', matrix: DEFAULT_ROLE_PERMISSIONS.candidate },
    ],
    formTemplates: [{ id: TEMPLATE, orgId: ORG, name: 'Track Dozer', currentVersionId: VERSION }],
    formTemplateVersions: [{ id: VERSION, templateId: TEMPLATE, fields: FIELDS }],
    assessmentTools: [],
    assessmentCases: [],
    assessmentPartAttempts: [],
    competencyHolders: [],
    auditLogEntries: [],
    users: [],
  };

  const nameOf = (table: unknown) =>
    Object.keys(schema).find((k) => (schema as Record<string, unknown>)[k] === table) ?? '';

  const query = Object.fromEntries(
    Object.keys(store).map((name) => [
      name,
      {
        findFirst: async (args?: { where?: unknown }) =>
          store[name]!.find((r) => matchesWhere(r, args?.where)),
        findMany: async (args?: { where?: unknown }) =>
          store[name]!.filter((r) => matchesWhere(r, args?.where)),
      },
    ]),
  );

  const db = {
    query,
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown> | Record<string, unknown>[]) => {
        const name = nameOf(table);
        const rows = (Array.isArray(v) ? v : [v]).map((r) => ({
          id: nextId(),
          createdAt: new Date(),
          outcome: null,
          thresholdNotifiedAt: null,
          state: 'open',
          ...r,
        }));
        store[name]?.push(...rows);
        const p = Promise.resolve(undefined) as Promise<undefined> & { returning: () => Promise<unknown[]> };
        p.returning = () => Promise.resolve(rows);
        return p;
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: async (w: unknown) => {
          const name = nameOf(table);
          for (const row of store[name] ?? []) if (matchesWhere(row, w)) Object.assign(row, patch);
        },
      }),
    }),
    delete: () => ({ where: async () => undefined }),
    select: () => ({ from: () => ({ where: async () => [{ count: 0 }] }) }),
  } as unknown as Db;

  return { db, store };
}

async function seedTool(base: string, manifest = MANIFEST) {
  const res = await fetch(`${base}/assessment-tools`, {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ templateId: TEMPLATE, name: 'Track Dozer', manifest }),
  });
  return (await res.json()) as { id: string };
}

afterEach(() => {
  vi.clearAllMocks();
  mockDbValue = null;
});

// ── tool authoring ──────────────────────────────────────────────────────────

describe('POST /assessment-tools', () => {
  it('creates a tool when the manifest matches the template', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/assessment-tools`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ templateId: TEMPLATE, name: 'Track Dozer', manifest: MANIFEST }),
      });
      expect(res.status).toBe(201);
    } finally {
      server.close();
    }
  });

  it('refuses a manifest whose start field is not a header in that version', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const bad = { parts: [{ ...MANIFEST.parts[0]!, startFieldId: 'nope' }] };
      const res = await fetch(`${base}/assessment-tools`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ templateId: TEMPLATE, name: 'Bad', manifest: bad }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_manifest');
    } finally {
      server.close();
    }
  });

  it('is refused below the Business plan', async () => {
    mockDbValue = makeDb({ planTier: 'team' }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/assessment-tools`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ templateId: TEMPLATE, name: 'X', manifest: MANIFEST }),
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { feature: string }).feature).toBe('assessments');
    } finally {
      server.close();
    }
  });
});

// ── case creation ───────────────────────────────────────────────────────────

describe('POST /assessment-cases', () => {
  it('gives an experienced case only the parts that pathway requires', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      const res = await fetch(`${base}/assessment-cases`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ toolId: tool.id, candidateUserId: CANDIDATE, pathway: 'experienced' }),
      });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { parts: string[] }).parts).toEqual(['p1', 'p2']);
    } finally {
      server.close();
    }
  });

  it('gives a new candidate every part', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      const res = await fetch(`${base}/assessment-cases`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ toolId: tool.id, candidateUserId: CANDIDATE, pathway: 'new' }),
      });
      expect(((await res.json()) as { parts: string[] }).parts).toEqual(['p1', 'p2', 'p3', 'p4']);
    } finally {
      server.close();
    }
  });

  it('requires a justification for RPL, since it waives the logged hours', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      const res = await fetch(`${base}/assessment-cases`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ toolId: tool.id, candidateUserId: CANDIDATE, pathway: 'rpl' }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('rpl_justification_required');
    } finally {
      server.close();
    }
  });

  it('records unmet prerequisites as warnings and still opens the case', async () => {
    const { db } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const created = await fetch(`${base}/assessment-tools`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          templateId: TEMPLATE,
          name: 'Track Dozer',
          manifest: MANIFEST,
          candidatePrerequisiteIds: ['00000000-0000-4000-8000-0000000000f1'],
        }),
      });
      const tool = (await created.json()) as { id: string };

      const res = await fetch(`${base}/assessment-cases`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ toolId: tool.id, candidateUserId: CANDIDATE, pathway: 'experienced' }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { prerequisiteWarnings: string[] };
      expect(body.prerequisiteWarnings).toHaveLength(1);
      expect(body.prerequisiteWarnings[0]).toContain('candidate missing competency');
    } finally {
      server.close();
    }
  });
});

// ── attempts ────────────────────────────────────────────────────────────────

describe('attempt sequencing', () => {
  async function openCase(base: string, pathway = 'new') {
    const tool = await seedTool(base);
    const res = await fetch(`${base}/assessment-cases`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ toolId: tool.id, candidateUserId: CANDIDATE, pathway }),
    });
    return (await res.json()) as { id: string };
  }

  it('refuses to open a part whose predecessor has not passed', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const c = await openCase(base);
      const res = await fetch(`${base}/assessment-cases/${c.id}/parts/p2/attempts`, {
        method: 'POST',
        headers: auth(),
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('part_locked');
    } finally {
      server.close();
    }
  });

  it('refuses a part the pathway does not include', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const c = await openCase(base, 'experienced');
      const res = await fetch(`${base}/assessment-cases/${c.id}/parts/p3/attempts`, {
        method: 'POST',
        headers: auth(),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('part_not_in_pathway');
    } finally {
      server.close();
    }
  });

  it('returns the existing open attempt rather than stacking a second one', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const c = await openCase(base);
      const first = await (
        await fetch(`${base}/assessment-cases/${c.id}/parts/p1/attempts`, { method: 'POST', headers: auth() })
      ).json();
      const second = await (
        await fetch(`${base}/assessment-cases/${c.id}/parts/p1/attempts`, { method: 'POST', headers: auth() })
      ).json();

      expect((second as { id: string }).id).toBe((first as { id: string }).id);
      expect((second as { reused: boolean }).reused).toBe(true);
    } finally {
      server.close();
    }
  });

  it('refuses a not-satisfactory outcome with no disposition and reason', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const c = await openCase(base);
      const a = (await (
        await fetch(`${base}/assessment-cases/${c.id}/parts/p1/attempts`, { method: 'POST', headers: auth() })
      ).json()) as { id: string };

      // Answer wrongly so theory marking produces not_satisfactory.
      await fetch(`${base}/assessment-cases/${c.id}/attempts/${a.id}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ values: { q1: ['b'] } }),
      });
      const res = await fetch(`${base}/assessment-cases/${c.id}/attempts/${a.id}/outcome`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('disposition_and_reason_required');
    } finally {
      server.close();
    }
  });

  it('refuses to edit a resolved attempt', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const c = await openCase(base);
      const a = (await (
        await fetch(`${base}/assessment-cases/${c.id}/parts/p1/attempts`, { method: 'POST', headers: auth() })
      ).json()) as { id: string };
      await fetch(`${base}/assessment-cases/${c.id}/attempts/${a.id}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ values: { q1: ['a'] } }),
      });
      await fetch(`${base}/assessment-cases/${c.id}/attempts/${a.id}/outcome`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({}),
      });

      const res = await fetch(`${base}/assessment-cases/${c.id}/attempts/${a.id}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ values: { q1: ['b'] } }),
      });

      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('attempt_resolved');
    } finally {
      server.close();
    }
  });
});

// ── logbook ─────────────────────────────────────────────────────────────────

describe('logbook accumulation', () => {
  it('totals hours and flags the threshold exactly once', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      const c = (await (
        await fetch(`${base}/assessment-cases`, {
          method: 'POST',
          headers: auth(),
          body: JSON.stringify({ toolId: tool.id, candidateUserId: CANDIDATE, pathway: 'new' }),
        })
      ).json()) as { id: string };

      // Pass p1 and p2 so the logbook part unlocks.
      for (const [part, values] of [
        ['p1', { q1: ['a'] }],
        ['p2', {}],
      ] as const) {
        const a = (await (
          await fetch(`${base}/assessment-cases/${c.id}/parts/${part}/attempts`, {
            method: 'POST',
            headers: auth(),
          })
        ).json()) as { id: string };
        await fetch(`${base}/assessment-cases/${c.id}/attempts/${a.id}`, {
          method: 'PATCH',
          headers: auth(),
          body: JSON.stringify({ values }),
        });
        await fetch(`${base}/assessment-cases/${c.id}/attempts/${a.id}/outcome`, {
          method: 'POST',
          headers: auth(),
          body: JSON.stringify({ outcome: 'satisfactory' }),
        });
      }

      const log = (await (
        await fetch(`${base}/assessment-cases/${c.id}/parts/p3/attempts`, { method: 'POST', headers: auth() })
      ).json()) as { id: string };

      const below = (await (
        await fetch(`${base}/assessment-cases/${c.id}/attempts/${log.id}`, {
          method: 'PATCH',
          headers: auth(),
          body: JSON.stringify({ values: { entries: [{ duration: 8 }, { duration: 6 }] } }),
        })
      ).json()) as { hours: number; thresholdReached: boolean };
      expect(below.hours).toBe(14);
      expect(below.thresholdReached).toBe(false);

      const crossing = (await (
        await fetch(`${base}/assessment-cases/${c.id}/attempts/${log.id}`, {
          method: 'PATCH',
          headers: auth(),
          body: JSON.stringify({ values: { entries: [{ duration: 8 }, { duration: 6 }, { duration: 7 }] } }),
        })
      ).json()) as { hours: number; thresholdReached: boolean };
      expect(crossing.hours).toBe(21);
      expect(crossing.thresholdReached).toBe(true);

      const after = (await (
        await fetch(`${base}/assessment-cases/${c.id}/attempts/${log.id}`, {
          method: 'PATCH',
          headers: auth(),
          body: JSON.stringify({ values: { entries: [{ duration: 30 }] } }),
        })
      ).json()) as { thresholdReached: boolean };
      expect(after.thresholdReached).toBe(false);
    } finally {
      server.close();
    }
  });
});

// ── access scoping ──────────────────────────────────────────────────────────

describe('candidate scoping', () => {
  it('hides another candidate’s case behind a 404, not a 403', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      const other = (await (
        await fetch(`${base}/assessment-cases`, {
          method: 'POST',
          headers: auth(),
          body: JSON.stringify({ toolId: tool.id, candidateUserId: OTHER_CANDIDATE, pathway: 'experienced' }),
        })
      ).json()) as { id: string };

      const res = await fetch(`${base}/assessment-cases/${other.id}`, { headers: auth(candidate) });

      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('lists only the calling candidate’s own cases', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      for (const who of [CANDIDATE, OTHER_CANDIDATE]) {
        await fetch(`${base}/assessment-cases`, {
          method: 'POST',
          headers: auth(),
          body: JSON.stringify({ toolId: tool.id, candidateUserId: who, pathway: 'experienced' }),
        });
      }

      const mine = (await (await fetch(`${base}/assessment-cases`, { headers: auth(candidate) })).json()) as {
        candidateUserId: string;
      }[];
      const all = (await (await fetch(`${base}/assessment-cases`, { headers: auth() })).json()) as unknown[];

      expect(mine).toHaveLength(1);
      expect(mine[0]?.candidateUserId).toBe(CANDIDATE);
      expect(all).toHaveLength(2);
    } finally {
      server.close();
    }
  });
});

// ── the whole journey ───────────────────────────────────────────────────────

/**
 * The compositional test: a New candidate driven from an empty case to
 * competent, failing Part 4 once on the way.
 *
 * Covers AE3 (the failed attempt survives while the passing one becomes
 * authoritative) and AE2 (theory is computed from the answer key, not entered).
 */
describe('full case lifecycle', () => {
  it('drives a new candidate to competent, keeping the failed attempt', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      const c = (await (
        await fetch(`${base}/assessment-cases`, {
          method: 'POST',
          headers: auth(),
          body: JSON.stringify({ toolId: tool.id, candidateUserId: CANDIDATE, pathway: 'new' }),
        })
      ).json()) as { id: string };

      const open = async (part: string) =>
        (await (
          await fetch(`${base}/assessment-cases/${c.id}/parts/${part}/attempts`, {
            method: 'POST',
            headers: auth(),
          })
        ).json()) as { id: string; attemptNumber: number };

      const save = (id: string, values: unknown) =>
        fetch(`${base}/assessment-cases/${c.id}/attempts/${id}`, {
          method: 'PATCH',
          headers: auth(),
          body: JSON.stringify({ values }),
        });

      const resolve = async (id: string, body: unknown) =>
        (await (
          await fetch(`${base}/assessment-cases/${c.id}/attempts/${id}/outcome`, {
            method: 'POST',
            headers: auth(),
            body: JSON.stringify(body),
          })
        ).json()) as { outcome: string; caseState: string };

      // Part 1 — theory, answered correctly. Outcome is computed, not supplied.
      const t = await open('p1');
      await save(t.id, { q1: ['a'] });
      const theory = await resolve(t.id, {});
      expect(theory.outcome).toBe('satisfactory');

      // Part 2 — practical.
      const p2 = await open('p2');
      await resolve(p2.id, { outcome: 'satisfactory', assessorName: 'A. Assessor' });

      // Part 3 — logbook past its minimum.
      const p3 = await open('p3');
      await save(p3.id, { entries: [{ duration: 21 }] });
      await resolve(p3.id, { outcome: 'satisfactory' });

      // Part 4 — failed, then retried and passed.
      const first = await open('p4');
      const failed = await resolve(first.id, {
        outcome: 'not_satisfactory',
        disposition: 'coaching_then_retry',
        reason: 'Blade control inconsistent on grade',
      });
      expect(failed.outcome).toBe('not_satisfactory');
      expect(failed.caseState).toBe('open');

      const retry = await open('p4');
      expect(retry.attemptNumber).toBe(2);
      const passed = await resolve(retry.id, { outcome: 'satisfactory', assessorName: 'A. Assessor' });

      expect(passed.caseState).toBe('competent');

      // Both Part 4 attempts survive, and the failure keeps its reason.
      const p4Attempts = (store.assessmentPartAttempts ?? []).filter((a) => a.partKey === 'p4');
      expect(p4Attempts).toHaveLength(2);
      expect(p4Attempts[0]?.outcome).toBe('not_satisfactory');
      expect(p4Attempts[0]?.dispositionReason).toBe('Blade control inconsistent on grade');
      expect(p4Attempts[1]?.outcome).toBe('satisfactory');

      // The theory attempt carries the derived mark alongside the answer.
      const theoryAttempt = (store.assessmentPartAttempts ?? []).find((a) => a.partKey === 'p1');
      expect((theoryAttempt?.values as Record<string, unknown>)['q1-out']).toBe(true);

      // And the case detail agrees with the rows it summarises.
      const detail = (await (await fetch(`${base}/assessment-cases/${c.id}`, { headers: auth() })).json()) as {
        state: string;
        parts: { key: string; state: string; attempts: number }[];
      };
      expect(detail.state).toBe('competent');
      expect(detail.parts.map((p) => p.state)).toEqual([
        'satisfactory',
        'satisfactory',
        'satisfactory',
        'satisfactory',
      ]);
      expect(detail.parts.find((p) => p.key === 'p4')?.attempts).toBe(2);
    } finally {
      server.close();
    }
  });

  it('closes the case when the assessor disposes not yet competent', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      const c = (await (
        await fetch(`${base}/assessment-cases`, {
          method: 'POST',
          headers: auth(),
          body: JSON.stringify({ toolId: tool.id, candidateUserId: CANDIDATE, pathway: 'experienced' }),
        })
      ).json()) as { id: string };

      const a = (await (
        await fetch(`${base}/assessment-cases/${c.id}/parts/p1/attempts`, { method: 'POST', headers: auth() })
      ).json()) as { id: string };
      await fetch(`${base}/assessment-cases/${c.id}/attempts/${a.id}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ values: { q1: ['b'] } }),
      });

      const res = (await (
        await fetch(`${base}/assessment-cases/${c.id}/attempts/${a.id}/outcome`, {
          method: 'POST',
          headers: auth(),
          body: JSON.stringify({ disposition: 'not_yet_competent', reason: 'Withdrew from programme' }),
        })
      ).json()) as { caseState: string };

      expect(res.caseState).toBe('closed');
    } finally {
      server.close();
    }
  });
});
