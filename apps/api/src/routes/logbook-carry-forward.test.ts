/**
 * A logbook part's hours survive being sent round again.
 *
 * A logbook is not really failed. The training authority's practice is that a
 * candidate keeps logging and simply does not progress until an assessor judges
 * them competent to — so `not_satisfactory` on a logbook means "not yet", not
 * "start again", and the hours already logged still count toward the minimum.
 *
 * The system had no way to say that. A retry allocated a fresh attempt row with
 * an empty value map, so the moment an assessor sent a logbook back, a candidate
 * with 47 of 50 hours was shown a blank table asking for 50, every surface
 * reported zero, and nothing anywhere said their recorded experience had just
 * gone backwards.
 *
 * Carried forward at WRITE time rather than summed at read time, deliberately.
 * The exported evidence prints exactly ONE attempt per part
 * (`authoritativeAttempt` in apps/api/src/pdf/case-export.ts), so a summed figure
 * would sit on the dashboard beside a printed logbook page totalling less, with
 * nothing on the page explaining the difference. Copying the rows keeps one
 * attempt authoritative, which keeps the dashboard, the threshold and the PDF
 * telling the same story.
 */
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Db } from '@formai/db';
import { DEFAULT_ROLE_PERMISSIONS, type AssessmentToolManifest, type FormField } from '@formai/shared';

const ORG = 'org-1';
const ADMIN = '00000000-0000-4000-8000-00000000000a';
const CANDIDATE = '00000000-0000-4000-8000-00000000000c';
const TEMPLATE = '00000000-0000-4000-8000-000000000001';
const VERSION = '00000000-0000-4000-8000-000000000002';
// Tool creation now requires its one awarded competency (U2, R1).
const COMPETENCY = '00000000-0000-4000-8000-0000000000f1';

const admin = { userId: ADMIN, orgId: ORG, role: 'admin' as const };

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

const auth = () => ({
  cookie: `fai_session=${sealSession(admin)}`,
  'content-type': 'application/json',
});

const header = (id: string): FormField => ({
  id,
  type: 'section_header',
  label: id,
  required: false,
  source: 'imported',
});

const FIELDS: FormField[] = [
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
  header('h-after'),
];

const MANIFEST: AssessmentToolManifest = {
  parts: [
    {
      key: 'log',
      ordinal: 1,
      label: 'Part 3 Direct Observation Log',
      kind: 'logbook',
      pathways: ['new'],
      startFieldId: 'h-log',
      minimumHours: 50,
      durationColumnKey: 'duration',
    },
    {
      key: 'after',
      ordinal: 2,
      label: 'Part 4 Practical',
      kind: 'practical',
      pathways: ['new'],
      startFieldId: 'h-after',
    },
  ],
};

/* ── stateful fake database ────────────────────────────────────────────────── */

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
const nextId = () => `00000000-0000-4000-8000-${String(++idSeq).padStart(12, '0')}`;

function makeDb() {
  const store: Record<string, Record<string, unknown>[]> = {
    organizations: [{ id: ORG, planTier: 'business', seatLimit: 15, candidateSeatLimit: 200 }],
    rolePermissions: [{ id: nextId(), orgId: ORG, role: 'admin', matrix: DEFAULT_ROLE_PERMISSIONS.admin }],
    formTemplates: [{ id: TEMPLATE, orgId: ORG, name: 'Track Dozer', currentVersionId: VERSION }],
    formTemplateVersions: [{ id: VERSION, templateId: TEMPLATE, fields: FIELDS }],
    assessmentTools: [],
    assessmentCases: [],
    assessmentPartAttempts: [],
    competencyHolders: [],
    auditLogEntries: [],
    users: [{ id: CANDIDATE, name: 'Dale Rivers', email: 'dale@x.io' }],
    competencies: [{ id: COMPETENCY, orgId: ORG, name: 'Track Dozer Operator', holders: 0 }],
    // Case creation checks the candidate belongs to this org.
    memberships: [
      { id: nextId(), orgId: ORG, userId: ADMIN, role: 'admin', status: 'active' },
      { id: nextId(), orgId: ORG, userId: CANDIDATE, role: 'candidate', status: 'active' },
    ],
  };

  const table = (t: unknown): string => {
    for (const [name, schemaTable] of Object.entries(schema)) {
      if (schemaTable === t) return name;
    }
    return 'unknown';
  };

  const rowsOf = (name: string) => (store[name] ??= []);

  const query = new Proxy(
    {},
    {
      get: (_t, name: string) => ({
        findFirst: async (args?: { where?: unknown }) =>
          rowsOf(name).find((r) => matchesWhere(r, args?.where)),
        findMany: async (args?: { where?: unknown }) =>
          rowsOf(name).filter((r) => matchesWhere(r, args?.where)),
      }),
    },
  ) as never;

  const db = {
    query,
    insert: (t: unknown) => ({
      values: (v: Record<string, unknown> | Record<string, unknown>[]) => {
        const list = Array.isArray(v) ? v : [v];
        const inserted = list.map((row) => {
          // Column DEFAULTS matter here, not just the values the route sends.
          // Without them an attempt row's `outcome` is undefined rather than
          // null, and the save route's `!== null` guard reads a brand-new
          // attempt as already resolved — so every test failed with 409 before
          // the behaviour under test ever ran.
          const defaults =
            table(t) === 'assessmentPartAttempts'
              ? {
                  values: {},
                  outcome: null,
                  disposition: null,
                  dispositionReason: null,
                  thresholdNotifiedAt: null,
                  submittedAt: null,
                  assessorName: '',
                  signedAt: null,
                }
              : {};
          const full = { id: nextId(), createdAt: new Date(), ...defaults, ...row };
          rowsOf(table(t)).push(full);
          return full;
        });
        const done = Promise.resolve(undefined) as Promise<undefined> & {
          returning: () => Promise<unknown[]>;
        };
        done.returning = () => Promise.resolve(inserted);
        return done;
      },
    }),
    update: (t: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (cond: unknown) => {
          const hit = rowsOf(table(t)).filter((r) => matchesWhere(r, cond));
          for (const r of hit) Object.assign(r, patch);
          const done = Promise.resolve(undefined) as Promise<undefined> & {
            returning: () => Promise<unknown[]>;
          };
          done.returning = () => Promise.resolve(hit);
          return done;
        },
      }),
    }),
    delete: () => ({ where: async () => undefined }),
    select: () => ({ from: () => ({ where: async () => [{ count: 0 }] }) }),
  } as unknown as Db;

  return { db, store };
}

afterEach(() => {
  vi.clearAllMocks();
  mockDbValue = null;
});

/* ── the scenario ─────────────────────────────────────────────────────────── */

const WEEK_ONE = [
  { __key: 'r1', date: '2026-07-01', task: 'Slot dozing', duration: 20 },
  { __key: 'r2', date: '2026-07-08', task: 'Ripping', duration: 27 },
];

async function loggedCaseSentBack(base: string, rows = WEEK_ONE) {
  const tool = (await (
    await fetch(`${base}/assessment-tools`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ templateId: TEMPLATE, name: 'Track Dozer', manifest: MANIFEST, awardedCompetencyIds: [COMPETENCY] }),
    })
  ).json()) as { id: string };

  const kase = (await (
    await fetch(`${base}/assessment-cases`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ toolId: tool.id, candidateUserId: CANDIDATE, pathway: 'new' }),
    })
  ).json()) as { id: string };

  const first = (await (
    await fetch(`${base}/assessment-cases/${kase.id}/parts/log/attempts`, {
      method: 'POST',
      headers: auth(),
    })
  ).json()) as { id: string };

  const saveRes = await fetch(`${base}/assessment-cases/${kase.id}/attempts/${first.id}`, {
    method: 'PATCH',
    headers: auth(),
    body: JSON.stringify({ values: { 'log-table': rows } }),
  });
  if (saveRes.status !== 200) {
    throw new Error(`save failed: ${saveRes.status} ${await saveRes.text()}`);
  }

  // "Not yet" — the assessor wants more supervised time before progressing.
  await fetch(`${base}/assessment-cases/${kase.id}/attempts/${first.id}/outcome`, {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({
      outcome: 'not_satisfactory',
      disposition: 'coaching_then_retry',
      reason: 'Wants more seat time on grade before signing off',
    }),
  });

  const secondRes = await fetch(`${base}/assessment-cases/${kase.id}/parts/log/attempts`, {
    method: 'POST',
    headers: auth(),
  });
  const second = (await secondRes.json()) as { id: string; attemptNumber: number };
  // Guard the set-up: a refusal here would leave every assertion below passing
  // or failing for the wrong reason.
  if (secondRes.status !== 201) {
    throw new Error(`retry not opened: ${secondRes.status} ${JSON.stringify(second)}`);
  }

  return { caseId: kase.id, firstId: first.id, second };
}

const attemptRow = (store: ReturnType<typeof makeDb>['store'], id: string) =>
  store.assessmentPartAttempts!.find((a) => a.id === id) as
    | { values?: Record<string, unknown>; thresholdNotifiedAt?: unknown }
    | undefined;

describe('a logbook sent back for more hours', () => {
  it('carries the logged rows into the new attempt', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const { second } = await loggedCaseSentBack(base);

      const rows = attemptRow(store, second.id)?.values?.['log-table'];
      expect(rows).toHaveLength(2);
      // 47 of the 50 hours already stood to the candidate's name. Starting the
      // new attempt empty told them, and every surface, that they had none.
      expect((rows as { duration: number }[]).reduce((n, r) => n + r.duration, 0)).toBe(47);
    } finally {
      server.close();
    }
  });

  it('is still a new attempt, not an edit of the resolved one', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const { firstId, second } = await loggedCaseSentBack(base);

      expect(second.attemptNumber).toBe(2);
      expect(second.id).not.toBe(firstId);
      // The failed attempt is evidence and is never touched — the audit trail
      // keeps every send-back, which is the whole point of attempts-as-rows.
      const first = attemptRow(store, firstId);
      expect(first?.values?.['log-table']).toHaveLength(2);
    } finally {
      server.close();
    }
  });

  it('lets the candidate keep adding to the carried rows', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const { caseId, second } = await loggedCaseSentBack(base);

      const res = await fetch(`${base}/assessment-cases/${caseId}/attempts/${second.id}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({
          values: {
            'log-table': [
              ...WEEK_ONE,
              { __key: 'r3', date: '2026-07-15', task: 'Grade control', duration: 6 },
            ],
          },
        }),
      });
      expect(res.status).toBe(200);
      // 47 carried plus 6 new. Hours accumulate across a send-back, which is
      // what the training practice actually does.
      expect(((await res.json()) as { hours: number }).hours).toBe(53);
    } finally {
      server.close();
    }
  });

  it('does not re-announce a minimum the assessor was already told about', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      // Over the 50-hour minimum before being sent back, so the notification has
      // already fired once.
      const { second } = await loggedCaseSentBack(base, [
        ...WEEK_ONE,
        { __key: 'r3', date: '2026-07-15', task: 'Grade control', duration: 5 },
      ]);

      // The carried attempt is born above the minimum. Without carrying the
      // stamp too, its first save would fire "minimum reached" a second time for
      // a threshold that was crossed weeks earlier.
      expect(attemptRow(store, second.id)?.thresholdNotifiedAt).toBeTruthy();
    } finally {
      server.close();
    }
  });

  it('carries no stamp when the minimum was never reached', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      // 47 of 50. The notification is still owed, so the carried attempt must
      // stay eligible to fire it once the candidate crosses over.
      const { second } = await loggedCaseSentBack(base);

      expect(attemptRow(store, second.id)?.thresholdNotifiedAt).toBeNull();
    } finally {
      server.close();
    }
  });

  it('carries nothing on a part that is not a logbook', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = (await (
        await fetch(`${base}/assessment-tools`, {
          method: 'POST',
          headers: auth(),
          body: JSON.stringify({ templateId: TEMPLATE, name: 'Track Dozer', manifest: MANIFEST, awardedCompetencyIds: [COMPETENCY] }),
        })
      ).json()) as { id: string };
      const kase = (await (
        await fetch(`${base}/assessment-cases`, {
          method: 'POST',
          headers: auth(),
          body: JSON.stringify({ toolId: tool.id, candidateUserId: CANDIDATE, pathway: 'new' }),
        })
      ).json()) as { id: string };

      // The log has to pass before the practical unlocks.
      const log = (await (
        await fetch(`${base}/assessment-cases/${kase.id}/parts/log/attempts`, {
          method: 'POST',
          headers: auth(),
        })
      ).json()) as { id: string };
      await fetch(`${base}/assessment-cases/${kase.id}/attempts/${log.id}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ values: { 'log-table': [{ __key: 'r1', duration: 60 }] } }),
      });
      await fetch(`${base}/assessment-cases/${kase.id}/attempts/${log.id}/outcome`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ outcome: 'satisfactory' }),
      });

      const p1 = (await (
        await fetch(`${base}/assessment-cases/${kase.id}/parts/after/attempts`, {
          method: 'POST',
          headers: auth(),
        })
      ).json()) as { id: string };
      await fetch(`${base}/assessment-cases/${kase.id}/attempts/${p1.id}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ values: { 'some-answer': 'first go' } }),
      });
      await fetch(`${base}/assessment-cases/${kase.id}/attempts/${p1.id}/outcome`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          outcome: 'not_satisfactory',
          disposition: 'coaching_then_retry',
          reason: 'Blade control inconsistent on grade',
        }),
      });

      const p2 = (await (
        await fetch(`${base}/assessment-cases/${kase.id}/parts/after/attempts`, {
          method: 'POST',
          headers: auth(),
        })
      ).json()) as { id: string };

      // A practical retry is a fresh demonstration. Carrying the previous
      // attempt's answers forward would show an assessor marks they never made.
      expect(attemptRow(store, p2.id)?.values ?? {}).toEqual({});
    } finally {
      server.close();
    }
  });
});
