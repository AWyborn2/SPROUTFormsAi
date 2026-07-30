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

/** A section header gated on the case's location stream. */
const streamSection = (id: string, stream: string): FormField => ({
  id,
  type: 'section_header',
  label: id,
  required: false,
  source: 'imported',
  visibleWhen: { fieldId: 'stream-q', op: 'equals', value: stream },
});

const FIELDS: FormField[] = [
  header('h-theory'),
  // The stream question itself. Its answer is seeded from the case rather than
  // asked again, which is what gates the two location sets below.
  {
    id: 'stream-q',
    type: 'dropdown',
    label: 'Location',
    required: false,
    source: 'imported',
    options: ['Mining', 'Raw Materials'],
  },
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
  streamSection('h-mining', 'Mining'),
  { id: 'q-mining', type: 'text', label: 'Mining only', required: false, source: 'imported' },
  streamSection('h-raw', 'Raw Materials'),
  { id: 'q-raw', type: 'text', label: 'Raw Materials only', required: false, source: 'imported' },
  header('h-prac1'),
  header('h-log'),
  {
    id: 'log-table',
    type: 'repeating_group',
    label: 'Direct observation log',
    required: false,
    source: 'imported',
    columns: [
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'task', label: 'Task', type: 'text' },
      { key: 'duration', label: 'Duration', type: 'number' },
    ],
  },
  header('h-prac2'),
];

const MANIFEST: AssessmentToolManifest = {
  locationStreamFieldId: 'stream-q',
  parts: [
    {
      key: 'p1',
      ordinal: 1,
      label: 'Part 1 Theory',
      kind: 'theory',
      pathways: ['experienced', 'new', 'rpl'],
      startFieldId: 'h-theory',
      mandatoryFieldIds: ['q1'],
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
      durationColumnKey: 'duration',
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
          body: JSON.stringify({ values: { 'log-table': [{ duration: 8 }, { duration: 6 }] } }),
        })
      ).json()) as { hours: number; thresholdReached: boolean };
      expect(below.hours).toBe(14);
      expect(below.thresholdReached).toBe(false);

      const crossing = (await (
        await fetch(`${base}/assessment-cases/${c.id}/attempts/${log.id}`, {
          method: 'PATCH',
          headers: auth(),
          body: JSON.stringify({ values: { 'log-table': [{ duration: 8 }, { duration: 6 }, { duration: 7 }] } }),
        })
      ).json()) as { hours: number; thresholdReached: boolean };
      expect(crossing.hours).toBe(21);
      expect(crossing.thresholdReached).toBe(true);

      const after = (await (
        await fetch(`${base}/assessment-cases/${c.id}/attempts/${log.id}`, {
          method: 'PATCH',
          headers: auth(),
          body: JSON.stringify({ values: { 'log-table': [{ duration: 30 }] } }),
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

/**
 * The document-generation logic lives in `pdf/case-export.test.ts`, which runs
 * against real PDFs. These cover the ROUTE's gates — who may mint an evidence
 * document, and what happens when the template cannot produce one.
 */
describe('POST /assessment-cases/:id/export', () => {
  async function openExperiencedCase(base: string) {
    const tool = await seedTool(base);
    return (await (
      await fetch(`${base}/assessment-cases`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ toolId: tool.id, candidateUserId: CANDIDATE, pathway: 'experienced' }),
      })
    ).json()) as { id: string };
  }

  it('refuses a candidate, who may read their case but not certify it', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const c = await openExperiencedCase(base);

      const res = await fetch(`${base}/assessment-cases/${c.id}/export`, {
        method: 'POST',
        headers: auth(candidate),
      });

      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('422s when the template has no source PDF to draw on', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const c = await openExperiencedCase(base);

      const res = await fetch(`${base}/assessment-cases/${c.id}/export`, {
        method: 'POST',
        headers: auth(),
      });

      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toBe('no_source_pdf');
    } finally {
      server.close();
    }
  });

  it('404s for a case in another org', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/assessment-cases/00000000-0000-4000-8000-0000000000ff/export`, {
        method: 'POST',
        headers: auth(),
      });

      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });
});

/**
 * Hours count toward a safety threshold, so two properties are pinned at the
 * route: a non-positive duration is REFUSED rather than quietly ignored, and a
 * duration column carrying a machine_hours calc is recomputed server-side —
 * the client's figure for a derived cell is discarded, so meter arithmetic
 * cannot be forged by editing a request body.
 */
describe('logbook duration integrity', () => {
  async function logbookAttempt(base: string) {
    const tool = await seedTool(base);
    const c = (await (
      await fetch(`${base}/assessment-cases`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ toolId: tool.id, candidateUserId: CANDIDATE, pathway: 'new' }),
      })
    ).json()) as { id: string };

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
        body: JSON.stringify(part === 'p1' ? {} : { outcome: 'satisfactory' }),
      });
    }

    const log = (await (
      await fetch(`${base}/assessment-cases/${c.id}/parts/p3/attempts`, { method: 'POST', headers: auth() })
    ).json()) as { id: string };
    return { caseId: c.id, attemptId: log.id };
  }

  it('refuses a row with a zero duration rather than ignoring it', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await logbookAttempt(base);

      const res = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ values: { 'log-table': [{ duration: 8 }, { duration: 0 }] } }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; row: number };
      expect(body.error).toBe('invalid_logbook_row');
      expect(body.row).toBe(1);
    } finally {
      server.close();
    }
  });

  it('refuses a negative duration', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await logbookAttempt(base);

      const res = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ values: { 'log-table': [{ duration: -4 }] } }),
      });

      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('accepts rows still awaiting a duration and counts only completed ones', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await logbookAttempt(base);

      const res = (await (
        await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
          method: 'PATCH',
          headers: auth(),
          body: JSON.stringify({ values: { 'log-table': [{ duration: 8 }, { task: 'mid-entry' }] } }),
        })
      ).json()) as { hours: number };

      expect(res.hours).toBe(8);
    } finally {
      server.close();
    }
  });
});

/**
 * An appeal is a NEW case linked to the disputed one — never an edit of it.
 * The two conflict rules are the integrity of the whole mechanism (R29/R30,
 * AE8): the disputed assessor can neither initiate the appeal nor be assigned
 * to assess it, so nobody adjudicates a dispute about their own decision.
 */
describe('POST /assessment-cases/:id/appeal', () => {
  const DISPUTED_ASSESSOR = '00000000-0000-4000-8000-0000000000e1';
  const INDEPENDENT = '00000000-0000-4000-8000-0000000000e2';

  async function disputedCase(base: string) {
    const tool = await seedTool(base);
    return (await (
      await fetch(`${base}/assessment-cases`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          toolId: tool.id,
          candidateUserId: CANDIDATE,
          assessorUserId: DISPUTED_ASSESSOR,
          pathway: 'experienced',
        }),
      })
    ).json()) as { id: string };
  }

  it('opens a linked case with an independent assessor, keeping both', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const c = await disputedCase(base);

      const res = await fetch(`${base}/assessment-cases/${c.id}/appeal`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ assessorUserId: INDEPENDENT, reason: 'Candidate disputes Part 2 outcome' }),
      });

      expect(res.status).toBe(201);
      const appeal = (await res.json()) as { id: string; appealOfCaseId: string };
      expect(appeal.appealOfCaseId).toBe(c.id);

      const cases = store.assessmentCases ?? [];
      expect(cases).toHaveLength(2);
      expect(cases.find((x) => x.id === c.id)).toBeDefined();
      const appealRow = cases.find((x) => x.id === appeal.id);
      expect(appealRow?.appealReason).toBe('Candidate disputes Part 2 outcome');
      expect(appealRow?.candidateUserId).toBe(CANDIDATE);

      // The original's detail surfaces the superseding record.
      const detail = (await (await fetch(`${base}/assessment-cases/${c.id}`, { headers: auth() })).json()) as {
        appeals: { id: string }[];
      };
      expect(detail.appeals.map((a) => a.id)).toContain(appeal.id);
    } finally {
      server.close();
    }
  });

  it('refuses the disputed assessor as initiator, even as an admin', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      // The disputed case is assessed by THE ADMIN calling the appeal route.
      const c = (await (
        await fetch(`${base}/assessment-cases`, {
          method: 'POST',
          headers: auth(),
          body: JSON.stringify({ toolId: tool.id, candidateUserId: CANDIDATE, pathway: 'experienced' }),
        })
      ).json()) as { id: string };

      const res = await fetch(`${base}/assessment-cases/${c.id}/appeal`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ assessorUserId: INDEPENDENT, reason: 'Disputed' }),
      });

      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('appeal_conflict');
    } finally {
      server.close();
    }
  });

  it('refuses assigning the appeal back to the disputed assessor', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const c = await disputedCase(base);

      const res = await fetch(`${base}/assessment-cases/${c.id}/appeal`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ assessorUserId: DISPUTED_ASSESSOR, reason: 'Disputed' }),
      });

      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('appeal_assessor_not_independent');
    } finally {
      server.close();
    }
  });

  it('refuses a non-admin initiator', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const c = await disputedCase(base);

      const res = await fetch(`${base}/assessment-cases/${c.id}/appeal`, {
        method: 'POST',
        headers: auth(candidate),
        body: JSON.stringify({ assessorUserId: INDEPENDENT, reason: 'Disputed' }),
      });

      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('requires a reason', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const c = await disputedCase(base);

      const res = await fetch(`${base}/assessment-cases/${c.id}/appeal`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ assessorUserId: INDEPENDENT }),
      });

      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });
});

/**
 * The fillable surface for one attempt — what the candidate portal renders.
 *
 * The headline behaviour is what is ABSENT. These fields carry the answer key
 * to the assessment the candidate is about to sit, and this route serves them
 * to that candidate. Stripping happens at the door: nothing downstream is
 * trusted to hide them.
 */
describe('GET /assessment-cases/:id/attempts/:attemptId', () => {
  async function caseWithOpenAttempt(base: string, pathway = 'new') {
    const tool = await seedTool(base);
    const caseRes = await fetch(`${base}/assessment-cases`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ toolId: tool.id, candidateUserId: CANDIDATE, pathway }),
    });
    const kase = (await caseRes.json()) as { id: string };
    const attemptRes = await fetch(`${base}/assessment-cases/${kase.id}/parts/p1/attempts`, {
      method: 'POST',
      headers: auth(),
      body: '{}',
    });
    const attempt = (await attemptRes.json()) as { id: string };
    return { caseId: kase.id, attemptId: attempt.id };
  }

  it('never serves answer keys or outcome targets to the candidate sitting the part', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await caseWithOpenAttempt(base);

      const res = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        headers: auth(candidate),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { fields: FormField[] };

      // The question itself must still be there — this is a fill surface.
      expect(body.fields.some((f) => f.id === 'q1')).toBe(true);
      // But nothing that gives the answer away, on ANY field.
      expect(body.fields.some((f) => f.answerKey !== undefined)).toBe(false);
      expect(body.fields.some((f) => f.outcomeTarget !== undefined)).toBe(false);
      // Belt and braces: the option that IS the answer must not appear as a key
      // anywhere in the serialized payload.
      expect(JSON.stringify(body)).not.toContain('answerKey');
    } finally {
      server.close();
    }
  });

  it('serves only the fields belonging to that part', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await caseWithOpenAttempt(base);
      const res = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        headers: auth(candidate),
      });
      const body = (await res.json()) as { partKey: string; fields: FormField[] };

      expect(body.partKey).toBe('p1');
      const ids = body.fields.map((f) => f.id);
      // Part 1 runs from its own anchor to the next part's.
      expect(ids).toContain('q1');
      // A later part's content is not the candidate's business here, and
      // rendering it would let them fill a part out of sequence.
      expect(ids).not.toContain('log-table');
    } finally {
      server.close();
    }
  });

  it('returns another candidate\u2019s attempt as not found, not forbidden', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await caseWithOpenAttempt(base);
      const res = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        headers: auth({ userId: OTHER_CANDIDATE, orgId: ORG, role: 'candidate' }),
      });
      // 403 would confirm the case exists, which is itself a disclosure.
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('lets the assessor read the same attempt', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await caseWithOpenAttempt(base);
      const res = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        headers: auth(),
      });
      expect(res.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('returns saved answers so a part can be resumed', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await caseWithOpenAttempt(base);
      await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: auth(candidate),
        body: JSON.stringify({ values: { q1: ['b'] } }),
      });

      const res = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        headers: auth(candidate),
      });
      const body = (await res.json()) as { values: Record<string, unknown>; outcome: string | null };
      expect(body.values).toEqual({ q1: ['b'] });
      // Still open — an unmarked attempt has no outcome.
      expect(body.outcome).toBeNull();
    } finally {
      server.close();
    }
  });

  it('reports the case stream and part kind so the portal can render correctly', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await caseWithOpenAttempt(base);
      const res = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        headers: auth(candidate),
      });
      const body = (await res.json()) as {
        partLabel: string;
        partKind: string;
        attemptNumber: number;
        locationStream: string | null;
      };
      expect(body.partKind).toBe('theory');
      expect(body.partLabel).toBe('Part 1 Theory');
      expect(body.attemptNumber).toBe(1);
      // Unset stream is reported as null; the renderer fails OPEN on it and
      // shows every location set rather than none.
      expect(body.locationStream).toBeNull();
    } finally {
      server.close();
    }
  });

  it('404s for an attempt id that belongs to a different case', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const first = await caseWithOpenAttempt(base);
      const second = await caseWithOpenAttempt(base);
      const res = await fetch(`${base}/assessment-cases/${first.caseId}/attempts/${second.attemptId}`, {
        headers: auth(),
      });
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });
});

/**
 * The progress dashboard.
 *
 * What these pin is that the aggregate is a VIEW OF THE ATTEMPT ROWS and not a
 * parallel record of its own. So they never assert a hand-written fixture: the
 * cases are driven through the real routes first, and the dashboard is then
 * checked against the rows those routes wrote and against what
 * `GET /assessment-cases/:id` says about the same case. If the two ever
 * disagree, one of them is summarising something it no longer reflects — which
 * is the failure mode a stored progress column would have made permanent.
 *
 * Scope is the other half: a candidate's aggregate is filtered server-side, and
 * a caller whose role grants no assessments view is refused outright rather than
 * handed an empty list, which would read as "no candidates" instead of "not
 * yours to see".
 */
describe('GET /assessment-cases/progress', () => {
  type ProgressPart = {
    key: string;
    state: string;
    latestOutcome: string | null;
    attempts: number;
    minimumHours: number | null;
    loggedHours: number | null;
  };
  type ProgressRow = {
    id: string;
    toolName: string;
    candidateUserId: string;
    candidateName: string;
    state: string;
    currentPartKey: string | null;
    currentPartLabel: string | null;
    parts: ProgressPart[];
  };

  const dashboard = async (base: string, who: Session = admin) =>
    (await (await fetch(`${base}/assessment-cases/progress`, { headers: auth(who) })).json()) as ProgressRow[];

  /**
   * A case against an EXISTING tool. The tool is seeded once per test rather
   * than per case, because `assessment_tools_template_uq` allows exactly one
   * tool per template — a second one would be a fixture that cannot exist.
   */
  const openCase = async (base: string, toolId: string, candidateUserId = CANDIDATE, pathway = 'new') =>
    (await (
      await fetch(`${base}/assessment-cases`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ toolId, candidateUserId, pathway }),
      })
    ).json()) as { id: string };

  const openPart = async (base: string, caseId: string, part: string) =>
    (await (
      await fetch(`${base}/assessment-cases/${caseId}/parts/${part}/attempts`, {
        method: 'POST',
        headers: auth(),
      })
    ).json()) as { id: string };

  const save = (base: string, caseId: string, attemptId: string, values: unknown) =>
    fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
      method: 'PATCH',
      headers: auth(),
      body: JSON.stringify({ values }),
    });

  const resolve = (base: string, caseId: string, attemptId: string, body: unknown) =>
    fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}/outcome`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify(body),
    });

  /** Pass theory and the first practical, so the logbook part unlocks. */
  async function passFirstTwoParts(base: string, caseId: string) {
    const theory = await openPart(base, caseId, 'p1');
    await save(base, caseId, theory.id, { q1: ['a'] });
    await resolve(base, caseId, theory.id, {});
    const prac = await openPart(base, caseId, 'p2');
    await resolve(base, caseId, prac.id, { outcome: 'satisfactory', assessorName: 'A. Assessor' });
  }

  it('reports the hours logged and the part the candidate is on', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      const c = await openCase(base, tool.id);
      await passFirstTwoParts(base, c.id);
      const log = await openPart(base, c.id, 'p3');
      await save(base, c.id, log.id, { 'log-table': [{ duration: 8 }, { duration: 6.5 }] });

      const [row] = await dashboard(base);

      // The logbook is where the case has got to, and its hours are the ones
      // the save route just totalled — not a separately tracked figure.
      expect(row?.currentPartKey).toBe('p3');
      expect(row?.currentPartLabel).toBe('Part 3 Logbook');
      const p3 = row?.parts.find((p) => p.key === 'p3');
      expect(p3?.loggedHours).toBe(14.5);
      expect(p3?.minimumHours).toBe(20);
      // The two parts already passed report as such, and a part with no hours
      // threshold reports no hours rather than a misleading zero.
      expect(row?.parts.find((p) => p.key === 'p1')?.state).toBe('satisfactory');
      expect(row?.parts.find((p) => p.key === 'p2')?.loggedHours).toBeNull();
    } finally {
      server.close();
    }
  });

  it('names the candidate rather than only their id', async () => {
    const { db, store } = makeDb();
    // One candidate, so the display name has somewhere to resolve from. The
    // fake's where-matching is a conjunction over bound values, so a
    // multi-candidate lookup finds nothing — see the note at the top of this
    // file. Scoping and hours are proven elsewhere; this pins the join.
    store.users!.push({ id: CANDIDATE, name: 'Dale Ferguson', email: 'dale@example.com' });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      await openCase(base, (await seedTool(base)).id);

      const [row] = await dashboard(base);

      expect(row?.candidateName).toBe('Dale Ferguson');
      expect(row?.candidateUserId).toBe(CANDIDATE);
    } finally {
      server.close();
    }
  });

  it('gives a candidate only their own cases', async () => {
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

      const mine = await dashboard(base, candidate);
      const all = await dashboard(base);

      // Filtered in the query, not trimmed afterwards — the aggregate a
      // candidate receives was never computed over anyone else's attempts.
      expect(mine).toHaveLength(1);
      expect(mine[0]?.candidateUserId).toBe(CANDIDATE);
      expect(all).toHaveLength(2);
    } finally {
      server.close();
    }
  });

  it('tells a competent case apart from one closed as not yet competent', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      const passing = await openCase(base, tool.id, CANDIDATE, 'experienced');
      await passFirstTwoParts(base, passing.id);

      const closing = await openCase(base, tool.id, OTHER_CANDIDATE, 'experienced');
      const attempt = await openPart(base, closing.id, 'p1');
      await save(base, closing.id, attempt.id, { q1: ['b'] });
      await resolve(base, closing.id, attempt.id, {
        disposition: 'not_yet_competent',
        reason: 'Withdrew from programme',
      });

      const rows = await dashboard(base);
      const competent = rows.find((r) => r.id === passing.id);
      const closed = rows.find((r) => r.id === closing.id);

      // Both are finished; only one of them is a pass. The closed case still
      // names the part it stopped at, which is what an auditor reads it for.
      expect(competent?.state).toBe('competent');
      expect(competent?.currentPartKey).toBeNull();
      expect(closed?.state).toBe('closed');
      expect(closed?.currentPartKey).toBe('p1');
      expect(closed?.parts.find((p) => p.key === 'p1')?.latestOutcome).toBe('not_satisfactory');
    } finally {
      server.close();
    }
  });

  it('agrees with the case detail it summarises, failed attempts included', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      const c = await openCase(base, tool.id);
      await passFirstTwoParts(base, c.id);
      const log = await openPart(base, c.id, 'p3');
      await save(base, c.id, log.id, { 'log-table': [{ duration: 21 }] });
      const failed = await resolve(base, c.id, log.id, {
        outcome: 'not_satisfactory',
        disposition: 'coaching_then_retry',
        reason: 'Entries unsigned',
      });
      expect(failed.status).toBe(200);

      const [row] = await dashboard(base);
      const detail = (await (
        await fetch(`${base}/assessment-cases/${c.id}`, { headers: auth() })
      ).json()) as {
        state: string;
        parts: { key: string; state: string; latestOutcome: string | null; attempts: number }[];
      };

      expect(row?.state).toBe(detail.state);
      expect(row?.parts.map((p) => [p.key, p.state, p.latestOutcome, p.attempts])).toEqual(
        detail.parts.map((p) => [p.key, p.state, p.latestOutcome, p.attempts]),
      );
      // And the part the dashboard calls current is the first the detail does
      // not call satisfactory — the same rule, computed once.
      expect(row?.currentPartKey).toBe(detail.parts.find((p) => p.state !== 'satisfactory')?.key);
    } finally {
      server.close();
    }
  });

  it('refuses a caller whose role grants no assessments view', async () => {
    const { db, store } = makeDb();
    // Every shipped role may view assessments, so the denial has to come from a
    // customised matrix — which is the real-world shape of it too: an org that
    // has turned the category off for a role.
    store.rolePermissions!.push({
      id: nextId(),
      orgId: ORG,
      role: 'viewer',
      matrix: {
        ...DEFAULT_ROLE_PERMISSIONS.viewer,
        assessments: { view: false, create: false, edit: false, delete: false, export: false },
      },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/assessment-cases/progress`, {
        headers: auth({ userId: ADMIN, orgId: ORG, role: 'viewer' }),
      });

      // 403, not an empty array: "not yours to see" must not read as "no
      // candidates are being assessed".
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('is not mistaken for a case id', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/assessment-cases/progress`, { headers: auth() });

      // The route is declared before `/:id`. With that order reversed Express
      // would look for the case called "progress" and 404 the whole dashboard.
      expect(res.status).toBe(200);
      expect(Array.isArray(await res.json())).toBe(true);
    } finally {
      server.close();
    }
  });
});

/**
 * Handing a part in.
 *
 * The signal that closes the tracking gap: "has answers but no outcome" cannot
 * tell someone halfway through from someone who finished last week and is
 * waiting on an assessor. Submitting is the candidate's own act, and reversible
 * by them right up until it is marked.
 */
describe('submitting an attempt', () => {
  async function openAttemptFor(base: string, pathway = 'new') {
    const tool = await seedTool(base);
    const caseRes = await fetch(`${base}/assessment-cases`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ toolId: tool.id, candidateUserId: CANDIDATE, pathway }),
    });
    const kase = (await caseRes.json()) as { id: string };
    const attemptRes = await fetch(`${base}/assessment-cases/${kase.id}/parts/p1/attempts`, {
      method: 'POST',
      headers: auth(),
      body: '{}',
    });
    const attempt = (await attemptRes.json()) as { id: string };
    return { caseId: kase.id, attemptId: attempt.id };
  }

  const submit = (base: string, caseId: string, attemptId: string, who = candidate) =>
    fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}/submit`, {
      method: 'POST',
      headers: auth(who),
      body: '{}',
    });

  const reopen = (base: string, caseId: string, attemptId: string, who = candidate) =>
    fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}/reopen`, {
      method: 'POST',
      headers: auth(who),
      body: '{}',
    });

  it('lets the candidate hand in their own attempt', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await openAttemptFor(base);
      const res = await submit(base, caseId, attemptId);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { submittedAt: string | null }).submittedAt).toBeTruthy();

      // Visible to the assessor without opening the attempt — that IS the
      // signal, so it has to reach the case view.
      const detail = await fetch(`${base}/assessment-cases/${caseId}`, { headers: auth() });
      const body = (await detail.json()) as { attempts: { id: string; submittedAt: string | null }[] };
      expect(body.attempts.find((a) => a.id === attemptId)?.submittedAt).toBeTruthy();
    } finally {
      server.close();
    }
  });

  it('refuses to save answers onto a handed-in attempt', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await openAttemptFor(base);
      await submit(base, caseId, attemptId);

      const res = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: auth(candidate),
        body: JSON.stringify({ values: { q1: ['a'] } }),
      });
      // Otherwise "handed in" would mean nothing — the answers could keep
      // moving while the assessor was reading them.
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('attempt_submitted');
    } finally {
      server.close();
    }
  });

  it('lets the candidate take it back while it is still unmarked', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await openAttemptFor(base);
      await submit(base, caseId, attemptId);

      const res = await reopen(base, caseId, attemptId);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { submittedAt: string | null }).submittedAt).toBeNull();

      // ...and answering works again. Nothing was assessed, so nothing is lost.
      const save = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: auth(candidate),
        body: JSON.stringify({ values: { q1: ['a'] } }),
      });
      expect(save.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('refuses to submit another candidate’s attempt, as not found', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await openAttemptFor(base);
      const res = await submit(base, caseId, attemptId, {
        userId: OTHER_CANDIDATE,
        orgId: ORG,
        role: 'candidate',
      });
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });

  /** Answer the mandatory question correctly, so the derived outcome passes. */
  async function markSatisfactory(base: string, caseId: string, attemptId: string) {
    await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
      method: 'PATCH',
      headers: auth(candidate),
      body: JSON.stringify({ values: { q1: ['a'] } }),
    });
    const res = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}/outcome`, {
      method: 'POST',
      headers: auth(),
      body: '{}',
    });
    // Guard the set-up: a 400 here would leave the attempt unmarked and the
    // assertions below would pass for the wrong reason.
    expect(res.status).toBe(200);
  }

  it('refuses to submit an already-marked attempt', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await openAttemptFor(base);
      await markSatisfactory(base, caseId, attemptId);

      const res = await submit(base, caseId, attemptId);
      // A marked attempt is evidence; handing it in again is meaningless.
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('attempt_resolved');
    } finally {
      server.close();
    }
  });

  it('refuses to reopen an attempt once it has been marked', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await openAttemptFor(base);
      await markSatisfactory(base, caseId, attemptId);
      const res = await reopen(base, caseId, attemptId);
      // Reopening after marking would let a candidate rewrite what was assessed.
      expect(res.status).toBe(409);
    } finally {
      server.close();
    }
  });

  it('is idempotent — submitting twice keeps the first hand-in time', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await openAttemptFor(base);
      const first = (await (await submit(base, caseId, attemptId)).json()) as { submittedAt: string };
      const second = (await (await submit(base, caseId, attemptId)).json()) as { submittedAt: string };

      // A double-tap must not look like a later hand-in than it was.
      expect(second.submittedAt).toBe(first.submittedAt);
    } finally {
      server.close();
    }
  });
});
