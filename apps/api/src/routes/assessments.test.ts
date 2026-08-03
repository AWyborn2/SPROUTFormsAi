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
const COMPETENCY = '00000000-0000-4000-8000-0000000000f1';
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
    competencies: [{ id: COMPETENCY, orgId: ORG, name: 'Track Dozer Operator', code: 'TD-OP', holders: 0 }],
    competencyHolders: [],
    auditLogEntries: [],
    users: [],
    /*
      Case creation requires the candidate to be a member of THIS org — without
      it, any org could open a case against any user id in the system. The fake
      db had no memberships table at all, which is the shape of harness that
      lets such a gap survive: the missing check had nothing to fail against.
    */
    memberships: [
      { id: nextId(), orgId: ORG, userId: ADMIN, role: 'admin', status: 'active' },
      { id: nextId(), orgId: ORG, userId: CANDIDATE, role: 'candidate', status: 'active' },
      { id: nextId(), orgId: ORG, userId: OTHER_CANDIDATE, role: 'candidate', status: 'active' },
    ],
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

/**
 * Rows of one fake-db table. `store` carries an index signature, so reading a
 * table directly is possibly-undefined; every table above is seeded, so an
 * empty array is the honest answer rather than a non-null assertion.
 */
function rows(store: Record<string, Record<string, unknown>[]>, table: string) {
  return store[table] ?? [];
}

async function seedTool(base: string, manifest = MANIFEST, awardedCompetencyIds?: string[]) {
  const res = await fetch(`${base}/assessment-tools`, {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({
      templateId: TEMPLATE,
      name: 'Track Dozer',
      manifest,
      ...(awardedCompetencyIds ? { awardedCompetencyIds } : {}),
    }),
  });
  return (await res.json()) as { id: string };
}

afterEach(() => {
  vi.clearAllMocks();
  mockDbValue = null;
});

// ── tool authoring ──────────────────────────────────────────────────────────

describe('POST /assessment-tools', () => {
  /*
    A z.object STRIPS unknown keys. So a manifest property this schema omits is
    discarded in silence on the HTTP path while the authoring script keeps it —
    two writers, two different manifests, no error anywhere to say so.

    `candidateNameFieldId` was the one that got missed, and it is the pointer
    that puts a NAME on the certificate: the cover page belongs to no part, so
    nothing else can seed it. A tool created over HTTP therefore certified
    nobody, while the same tool authored by the script named the candidate.
  */
  it('keeps every manifest pointer it is given, including the candidate name', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/assessment-tools`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          templateId: TEMPLATE,
          name: 'Track Dozer',
          // Any real field id: validateManifest checks it exists in this
          // version, which is the half that was already working.
          manifest: { ...MANIFEST, candidateNameFieldId: 'q-mining' },
        }),
      });

      expect(res.status).toBe(201);
      const tool = rows(store, 'assessmentTools')[0];
      expect((tool?.manifest as { candidateNameFieldId?: string })?.candidateNameFieldId).toBe(
        'q-mining',
      );
    } finally {
      server.close();
    }
  });

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

  it('refuses a candidate who is not a member of this org, and opens nothing', async () => {
    // candidateUserId was only checked for UUID shape, so a well-formed id
    // belonging to another org's user opened a real case — building a
    // competency record against a stranger, on this org's candidate seat.
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      const res = await fetch(`${base}/assessment-cases`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          toolId: tool.id,
          candidateUserId: '00000000-0000-4000-8000-0000000000ff',
          pathway: 'new',
        }),
      });

      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe('candidate_not_in_org');
      expect(rows(store, 'assessmentCases')).toHaveLength(0);
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

  /*
    PREREQUISITES AND EXPIRY.

    A prerequisite was satisfied by the mere existence of a holder row, so a
    three-year ticket earned five years ago cleared the check exactly as well as
    one earned this morning. These open a case with the seeded competency as a
    candidate prerequisite and vary only how long ago it was granted.
  */
  async function caseWithPrerequisite(
    base: string,
    store: Record<string, Record<string, unknown>[]>,
    grantedDaysAgo: number,
    validity: { validForMonths?: number; gracePeriodDays?: number },
  ) {
    Object.assign(rows(store, 'competencies')[0]!, validity);
    rows(store, 'competencyHolders').push({
      id: nextId(),
      orgId: ORG,
      competencyId: COMPETENCY,
      userId: CANDIDATE,
      grantedAt: new Date(Date.now() - grantedDaysAgo * 24 * 60 * 60 * 1000),
      revokedAt: null,
    });

    const created = await fetch(`${base}/assessment-tools`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        templateId: TEMPLATE,
        name: 'Track Dozer',
        manifest: MANIFEST,
        candidatePrerequisiteIds: [COMPETENCY],
      }),
    });
    const tool = (await created.json()) as { id: string };

    const res = await fetch(`${base}/assessment-cases`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ toolId: tool.id, candidateUserId: CANDIDATE, pathway: 'experienced' }),
    });
    return (await res.json()) as { prerequisiteWarnings: string[] };
  }

  it('warns that a prerequisite has EXPIRED, not that it is missing', async () => {
    // The wording carries the action: "missing" sends an assessor to enrol
    // somebody in training they have already done, "expired" sends them to book
    // a requalification.
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const body = await caseWithPrerequisite(base, store, 5 * 365, { validForMonths: 36 });

      expect(body.prerequisiteWarnings).toHaveLength(1);
      expect(body.prerequisiteWarnings[0]).toContain('has expired');
      expect(body.prerequisiteWarnings[0]).not.toContain('missing');
    } finally {
      server.close();
    }
  });

  it('accepts a prerequisite still inside its grace period', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const body = await caseWithPrerequisite(base, store, 3 * 365 + 20, {
        validForMonths: 36,
        gracePeriodDays: 90,
      });

      expect(body.prerequisiteWarnings).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('accepts an ancient prerequisite when the competency never expires', async () => {
    // The day this ships, no competency carries a validity. Nothing may start
    // failing prerequisites until an admin states one.
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const body = await caseWithPrerequisite(base, store, 10 * 365, {});

      expect(body.prerequisiteWarnings).toEqual([]);
    } finally {
      server.close();
    }
  });

  /*
    WHO MAY ASSESS THIS DEPENDS ON WHERE IT HAPPENS.

    Per the training authority: Q50071833 (Worsley Assessor Skill Set)
    authorises MINE assessments, Q50073293 (Authority to Assess Mobile
    Equipment) authorises RAW MATERIALS, and Q34666893 (the category) is
    required in both. So the rule is `Q34666893 AND (Q50071833 OR Q50073293)`,
    with the branch decided by the case's location stream rather than chosen.

    A flat AND list fails both ways: all three warns on every case about a
    combination nobody holds, and one silently accepts an assessor authorised
    for the other site. The assessor holds nothing in these, so every
    requirement that APPLIES surfaces as a gap — which is what makes the absent
    one meaningful.
  */
  const WORSLEY = '00000000-0000-4000-8000-0000000000e1';
  const MOBILE_PLANT = '00000000-0000-4000-8000-0000000000e2';

  async function caseInStream(base: string, locationStream?: string, byStream = true) {
    const created = await fetch(`${base}/assessment-tools`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        templateId: TEMPLATE,
        name: 'Track Dozer',
        manifest: MANIFEST,
        assessorCompetencyIds: [COMPETENCY],
        ...(byStream
          ? { assessorStreamCompetencyIds: { Mining: [WORSLEY], 'Raw Materials': [MOBILE_PLANT] } }
          : {}),
      }),
    });
    const tool = (await created.json()) as { id: string };

    const res = await fetch(`${base}/assessment-cases`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        toolId: tool.id,
        candidateUserId: CANDIDATE,
        pathway: 'experienced',
        ...(locationStream ? { locationStream } : {}),
      }),
    });
    return (await res.json()) as { prerequisiteWarnings: string[] };
  }

  it('asks for the mine authority at the mine, and not the other one', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const warnings = (await caseInStream(base, 'Mining')).prerequisiteWarnings.join('\n');

      expect(warnings).toContain(COMPETENCY);
      expect(warnings).toContain(WORSLEY);
      expect(warnings).not.toContain(MOBILE_PLANT);
    } finally {
      server.close();
    }
  });

  it('asks for the raw materials authority there, and not the mine one', async () => {
    // The failure that matters: this must not accept the Worsley skill set.
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const warnings = (await caseInStream(base, 'Raw Materials')).prerequisiteWarnings.join('\n');

      expect(warnings).toContain(MOBILE_PLANT);
      expect(warnings).not.toContain(WORSLEY);
    } finally {
      server.close();
    }
  });

  it('matches the stream however it was typed', async () => {
    // Free text somebody enters by hand. An unrecognised stream contributes no
    // requirement at all, so a near-miss spelling skips the check silently —
    // which is why the comparison is normalised rather than exact.
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const warnings = (await caseInStream(base, '  raw materials  ')).prerequisiteWarnings.join('\n');

      expect(warnings).toContain(MOBILE_PLANT);
    } finally {
      server.close();
    }
  });

  it('says the check was only partial when the case names no stream', async () => {
    /*
      Reporting just the always-required half would present a partial check as a
      complete one. The case still opens — eligibility never blocks — but the
      warning has to say what went unchecked and name the streams, because the
      fix is to set one and nobody can guess the spelling.
    */
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const warnings = (await caseInStream(base)).prerequisiteWarnings.join('\n');

      expect(warnings).toContain('only partly checked');
      expect(warnings).toContain('Mining');
      expect(warnings).toContain('Raw Materials');
      // And it invented no gap for a requirement it could not resolve.
      expect(warnings).not.toContain(WORSLEY);
      expect(warnings).not.toContain(MOBILE_PLANT);
    } finally {
      server.close();
    }
  });

  it('warns rather than passing when the stream is one it does not know', async () => {
    /*
      THE FAILURE THIS WHOLE FEATURE NEARLY SHIPPED WITH.

      An unrecognised stream used to resolve to the always-required half with a
      clean result, on the reasoning that a location outside the list carries no
      extra requirement. But this value is free text shared with the document's
      own stream question, so a value outside the list is far more likely a
      near-miss spelling of a location the rule DOES cover.

      "Mine" against a tool keyed "Mining" reduced the rule from
      `category AND (mining OR raw materials)` to the category alone and called
      it fully checked — so an assessor holding only the raw-materials authority
      could sign off a mining assessment with nothing anywhere saying so.
    */
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const warnings = (await caseInStream(base, 'Mine')).prerequisiteWarnings.join('\n');

      expect(warnings).toContain('only partly checked');
      // Quotes what was actually recorded, so the typo is visible.
      expect(warnings).toContain('"Mine"');
      expect(warnings).toContain('Mining');
    } finally {
      server.close();
    }
  });

  it('says nothing about streams for a tool whose rule does not vary', async () => {
    // Every tool that existed before this column. A missing stream is not a gap
    // when nothing depended on it — warning here would fire on every case.
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const warnings = (await caseInStream(base, undefined, false)).prerequisiteWarnings.join('\n');

      expect(warnings).not.toContain('only partly checked');
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

  /*
    THIS TEST USED TO ASSERT THE OPPOSITE.

    It required a disposition and a reason for a COMPUTED theory failure, and
    400'd without them. Nothing could supply them — the assessor makes no
    judgement on a theory part, so the UI offers no outcome control — which left
    `outcome` null, and an unresolved attempt is handed back by the open route
    as `reused: true` forever. A failed theory part was unrecordable and the
    part wedged. The rule below replaces it deliberately, so the change is
    visible in the diff rather than arriving as a silently deleted test.
  */
  it('records a computed theory failure as more-coaching-required, unprompted', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
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

      expect(res.status).toBe(200);
      const row = rows(store, 'assessmentPartAttempts').find((r) => r.id === a.id);
      expect(row?.outcome).toBe('not_satisfactory');
      expect(row?.disposition).toBe('coaching_then_retry');
      // No judgement was made, so nothing is invented to justify one.
      expect(row?.dispositionReason).toBeNull();
    } finally {
      server.close();
    }
  });

  it('leaves the case open after a computed failure, so the candidate can sit it again', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const c = await openCase(base);
      const a = (await (
        await fetch(`${base}/assessment-cases/${c.id}/parts/p1/attempts`, { method: 'POST', headers: auth() })
      ).json()) as { id: string };
      await fetch(`${base}/assessment-cases/${c.id}/attempts/${a.id}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ values: { q1: ['b'] } }),
      });
      await fetch(`${base}/assessment-cases/${c.id}/attempts/${a.id}/outcome`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({}),
      });

      // Assert the failure was RECORDED as well as that the case stayed open —
      // otherwise a route that refuses outright passes this vacuously.
      expect(rows(store, 'assessmentPartAttempts').find((r) => r.id === a.id)?.outcome).toBe('not_satisfactory');
      expect(rows(store, 'assessmentCases').find((r) => r.id === c.id)?.state).toBe('open');
    } finally {
      server.close();
    }
  });

  it('opens a fresh attempt after a computed failure rather than handing back the wedged one', async () => {
    // The wedge itself: while the outcome stayed null, this returned reused:true
    // every time and there was no verb to clear it.
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const c = await openCase(base);
      const first = (await (
        await fetch(`${base}/assessment-cases/${c.id}/parts/p1/attempts`, { method: 'POST', headers: auth() })
      ).json()) as { id: string };
      await fetch(`${base}/assessment-cases/${c.id}/attempts/${first.id}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ values: { q1: ['b'] } }),
      });
      await fetch(`${base}/assessment-cases/${c.id}/attempts/${first.id}/outcome`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({}),
      });

      const retry = (await (
        await fetch(`${base}/assessment-cases/${c.id}/parts/p1/attempts`, { method: 'POST', headers: auth() })
      ).json()) as { id: string; reused?: boolean };
      expect(retry.reused).toBeFalsy();
      expect(retry.id).not.toBe(first.id);
    } finally {
      server.close();
    }
  });

  it('still demands a disposition and reason where the assessor really did judge', async () => {
    // R18 is unchanged for a JUDGED outcome. Only the computed branch moved.
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const c = await openCase(base);
      // p2 will not open until its predecessor has passed, so pass p1 first.
      const theory = (await (
        await fetch(`${base}/assessment-cases/${c.id}/parts/p1/attempts`, { method: 'POST', headers: auth() })
      ).json()) as { id: string };
      await fetch(`${base}/assessment-cases/${c.id}/attempts/${theory.id}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ values: { q1: ['a'] } }),
      });
      await fetch(`${base}/assessment-cases/${c.id}/attempts/${theory.id}/outcome`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({}),
      });

      const a = (await (
        await fetch(`${base}/assessment-cases/${c.id}/parts/p2/attempts`, { method: 'POST', headers: auth() })
      ).json()) as { id: string };
      const res = await fetch(`${base}/assessment-cases/${c.id}/attempts/${a.id}/outcome`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ outcome: 'not_satisfactory' }),
      });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('disposition_and_reason_required');
    } finally {
      server.close();
    }
  });

  it('lets an assessor still close a theory part as not yet competent, explicitly', async () => {
    // Defaulting to coaching is a DEFAULT, not a ceiling — the deliberate act
    // of closing the case stays available.
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const c = await openCase(base);
      const a = (await (
        await fetch(`${base}/assessment-cases/${c.id}/parts/p1/attempts`, { method: 'POST', headers: auth() })
      ).json()) as { id: string };
      await fetch(`${base}/assessment-cases/${c.id}/attempts/${a.id}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ values: { q1: ['b'] } }),
      });
      await fetch(`${base}/assessment-cases/${c.id}/attempts/${a.id}/outcome`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ disposition: 'not_yet_competent', reason: 'Third sitting, no progress' }),
      });

      expect(rows(store, 'assessmentPartAttempts').find((r) => r.id === a.id)?.disposition).toBe('not_yet_competent');
      expect(rows(store, 'assessmentCases').find((r) => r.id === c.id)?.state).toBe('closed');
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

      /*
        THIS USED TO EXPECT 'competent'. Marking the last part no longer
        certifies anyone: passing everything reaches `awaiting_sign_off`, and
        only the assessor's manual approval reaches `competent`. That is the
        state the printed record's name, signature and date attest to, and none
        of them exist yet at this point.
      */
      expect(passed.caseState).toBe('awaiting_sign_off');

      // Not terminal — a case waiting on a signature is not a finished one.
      expect((store.assessmentCases ?? []).find((r) => r.id === c.id)?.closedAt ?? null).toBeNull();

      const signed = (await (
        await fetch(`${base}/assessment-cases/${c.id}/sign-off`, {
          method: 'POST',
          headers: auth(),
          body: JSON.stringify({
            assessorName: 'A. Assessor',
            signature: 'data:image/png;base64,iVBORw0KGgo=',
          }),
        })
      ).json()) as { state: string };
      expect(signed.state).toBe('competent');

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
      // Passing every part now reaches `awaiting_sign_off`; the assessor's
      // manual approval is what makes it competent, so the dashboard cannot
      // show a competent case until someone signs.
      await fetch(`${base}/assessment-cases/${passing.id}/sign-off`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          assessorName: 'A. Assessor',
          signature: 'data:image/png;base64,iVBORw0KGgo=',
        }),
      });

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
 * Signing a case off — the assessor's manual approval, and the last act of an
 * assessment.
 *
 * Marking the final part reaches `awaiting_sign_off`, never `competent`. The
 * gap matters because the printed record carries a name, a signature and a
 * date: certifying on the last mark would produce a document asserting that a
 * person judged someone safe to operate a dozer, with nobody's name on it.
 */
describe('POST /assessment-cases/:id/sign-off', () => {
  const SIG = 'data:image/png;base64,iVBORw0KGgo=';

  async function readyCase(base: string) {
    const tool = await seedTool(base);
    const c = (await (
      await fetch(`${base}/assessment-cases`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ toolId: tool.id, candidateUserId: CANDIDATE, pathway: 'experienced' }),
      })
    ).json()) as { id: string };

    const theory = (await (
      await fetch(`${base}/assessment-cases/${c.id}/parts/p1/attempts`, { method: 'POST', headers: auth() })
    ).json()) as { id: string };
    await fetch(`${base}/assessment-cases/${c.id}/attempts/${theory.id}`, {
      method: 'PATCH',
      headers: auth(),
      body: JSON.stringify({ values: { q1: ['a'] } }),
    });
    await fetch(`${base}/assessment-cases/${c.id}/attempts/${theory.id}/outcome`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({}),
    });
    const prac = (await (
      await fetch(`${base}/assessment-cases/${c.id}/parts/p2/attempts`, { method: 'POST', headers: auth() })
    ).json()) as { id: string };
    await fetch(`${base}/assessment-cases/${c.id}/attempts/${prac.id}/outcome`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ outcome: 'satisfactory', assessorName: 'A. Assessor' }),
    });
    return c;
  }

  const signOff = (base: string, id: string, body: unknown) =>
    fetch(`${base}/assessment-cases/${id}/sign-off`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify(body),
    });

  /*
    THE AUDIT ROW READ "(assessor missing [object Object])".

    `unmetPrerequisites` changed from returning competency ids to returning
    {competencyId, reason}. Two call sites moved to `describeGap`; this one was
    interpolating the array straight into a template string, which does not
    fail — it stringifies.

    It matters more than the two that were caught. Sign-off is the only place
    the person who ACTUALLY signs is checked: case creation checks whoever was
    named as assessor when it was opened, who need not be the same person. And
    these gaps are never written to the case, so this row is their only durable
    record — the HTTP response carries them too, but that is a toast.
  */
  it('names the competency in the audit trail when the signer is not qualified', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      // A tool requiring a competency the signing assessor does not hold.
      const created = await fetch(`${base}/assessment-tools`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          templateId: TEMPLATE,
          name: 'Track Dozer',
          manifest: MANIFEST,
          assessorCompetencyIds: [COMPETENCY],
        }),
      });
      const tool = (await created.json()) as { id: string };

      const c = (await (
        await fetch(`${base}/assessment-cases`, {
          method: 'POST',
          headers: auth(),
          body: JSON.stringify({ toolId: tool.id, candidateUserId: CANDIDATE, pathway: 'experienced' }),
        })
      ).json()) as { id: string };

      const theory = (await (
        await fetch(`${base}/assessment-cases/${c.id}/parts/p1/attempts`, {
          method: 'POST',
          headers: auth(),
        })
      ).json()) as { id: string };
      await fetch(`${base}/assessment-cases/${c.id}/attempts/${theory.id}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ values: { q1: ['a'] } }),
      });
      await fetch(`${base}/assessment-cases/${c.id}/attempts/${theory.id}/outcome`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({}),
      });
      const prac = (await (
        await fetch(`${base}/assessment-cases/${c.id}/parts/p2/attempts`, {
          method: 'POST',
          headers: auth(),
        })
      ).json()) as { id: string };
      await fetch(`${base}/assessment-cases/${c.id}/attempts/${prac.id}/outcome`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ outcome: 'satisfactory', assessorName: 'A. Assessor' }),
      });

      const signed = await signOff(base, c.id, { assessorName: 'A. Assessor', signature: SIG });
      expect(signed.status).toBe(200);

      const entry = rows(store, 'auditLogEntries').find(
        (e) => e.action === 'Signed off assessment case',
      );
      expect(entry).toBeDefined();
      const target = String(entry!.target);
      expect(target).not.toContain('[object Object]');
      expect(target).toContain(COMPETENCY);
      expect(target).toContain('assessor missing competency');
    } finally {
      server.close();
    }
  });

  it('certifies the case, stamping the name, signature and its own date', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const c = await readyCase(base);
      const res = await signOff(base, c.id, { assessorName: 'A. Assessor', signature: SIG });

      expect(res.status).toBe(200);
      const row = rows(store, 'assessmentCases').find((r) => r.id === c.id);
      expect(row?.state).toBe('competent');
      expect(row?.signedOffName).toBe('A. Assessor');
      expect(row?.signedOffSignature).toBe(SIG);
      expect(row?.signedOffAt).toBeInstanceOf(Date);
      // Terminal at last, so the close date means something.
      expect(row?.closedAt).toBeInstanceOf(Date);
    } finally {
      server.close();
    }
  });

  it('refuses while any part is outstanding, and names which', async () => {
    // The whole guard against approving early. There is no force flag.
    const { db, store } = makeDb();
    mockDbValue = db;
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

      const res = await signOff(base, c.id, { assessorName: 'A. Assessor', signature: SIG });

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; outstanding: string[] };
      expect(body.error).toBe('parts_incomplete');
      expect(body.outstanding).toContain('p1');
      expect(rows(store, 'assessmentCases').find((r) => r.id === c.id)?.signedOffAt ?? null).toBeNull();
    } finally {
      server.close();
    }
  });

  it('refuses to let the candidate certify themselves', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const c = await readyCase(base);
      // An assessor-role user who happens to BE the candidate on this case.
      const res = await fetch(`${base}/assessment-cases/${c.id}/sign-off`, {
        method: 'POST',
        headers: auth({ userId: CANDIDATE, orgId: ORG, role: 'admin' }),
        body: JSON.stringify({ assessorName: 'Self', signature: SIG }),
      });

      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('candidate_cannot_sign_off');
      expect(rows(store, 'assessmentCases').find((r) => r.id === c.id)?.signedOffAt ?? null).toBeNull();
    } finally {
      server.close();
    }
  });

  it('refuses a signature that is not a PNG data URL', async () => {
    // The exporter draws nothing it cannot recognise, so a bad signature
    // accepted here would certify a record with an empty signature box.
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const c = await readyCase(base);
      const res = await signOff(base, c.id, { assessorName: 'A. Assessor', signature: 'scribble' });

      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('is idempotent — a double tap does not restamp the approval time', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const c = await readyCase(base);
      await signOff(base, c.id, { assessorName: 'A. Assessor', signature: SIG });
      const first = rows(store, 'assessmentCases').find((r) => r.id === c.id)?.signedOffAt;

      const again = await signOff(base, c.id, { assessorName: 'Someone Else', signature: SIG });

      expect(again.status).toBe(200);
      expect(((await again.json()) as { alreadySignedOff?: boolean }).alreadySignedOff).toBe(true);
      const row = rows(store, 'assessmentCases').find((r) => r.id === c.id);
      expect(row?.signedOffAt).toBe(first);
      expect(row?.signedOffName).toBe('A. Assessor');
    } finally {
      server.close();
    }
  });

  it('does not let a later attempt un-certify a signed case', async () => {
    /*
      The recompute runs on every outcome POST and derives state purely from the
      attempt rows. Without the signedOffAt conjunct, resolving anything
      afterwards would silently walk a certified case back down to
      awaiting_sign_off — un-certifying someone who has been certified.
    */
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const c = await readyCase(base);
      await signOff(base, c.id, { assessorName: 'A. Assessor', signature: SIG });

      // A part outside the experienced pathway, resolved after the fact.
      const extra = (await (
        await fetch(`${base}/assessment-cases/${c.id}/parts/p3/attempts`, { method: 'POST', headers: auth() })
      ).json()) as { id: string };
      if (extra.id) {
        await fetch(`${base}/assessment-cases/${c.id}/attempts/${extra.id}/outcome`, {
          method: 'POST',
          headers: auth(),
          body: JSON.stringify({ outcome: 'satisfactory' }),
        });
      }

      expect(rows(store, 'assessmentCases').find((r) => r.id === c.id)?.state).toBe('competent');
    } finally {
      server.close();
    }
  });

  /*
    Passing puts the candidate on the register the product exists to maintain.

    `assessment_tools` declared what a candidate must BRING and what an assessor
    must HOLD, but nothing naming what passing AWARDS — so a competent case
    updated its own state and stopped. `competency_holders` could only ever be
    written by hand, and a prerequisite chain could never be built out of the
    product's own assessments.
  */
  it('grants the competency the tool awards, linked to the case that earned it', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base, MANIFEST, [COMPETENCY]);
      const c = (await (
        await fetch(`${base}/assessment-cases`, {
          method: 'POST',
          headers: auth(),
          body: JSON.stringify({ toolId: tool.id, candidateUserId: CANDIDATE, pathway: 'experienced' }),
        })
      ).json()) as { id: string };

      const theory = (await (
        await fetch(`${base}/assessment-cases/${c.id}/parts/p1/attempts`, { method: 'POST', headers: auth() })
      ).json()) as { id: string };
      await fetch(`${base}/assessment-cases/${c.id}/attempts/${theory.id}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ values: { q1: ['a'] } }),
      });
      await fetch(`${base}/assessment-cases/${c.id}/attempts/${theory.id}/outcome`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({}),
      });
      const prac = (await (
        await fetch(`${base}/assessment-cases/${c.id}/parts/p2/attempts`, { method: 'POST', headers: auth() })
      ).json()) as { id: string };
      await fetch(`${base}/assessment-cases/${c.id}/attempts/${prac.id}/outcome`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ outcome: 'satisfactory', assessorName: 'A. Assessor' }),
      });

      const res = await fetch(`${base}/assessment-cases/${c.id}/sign-off`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          assessorName: 'A. Assessor',
          signature: 'data:image/png;base64,iVBORw0KGgo=',
        }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { granted: string[] }).granted).toEqual(['TD-OP']);

      const holder = rows(store, 'competencyHolders').find((h) => h.userId === CANDIDATE);
      expect(holder).toBeDefined();
      // FOLLOWABLE evidence. `evidenceRef` is documented as resolving to
      // nothing, so the case id is what makes this a link rather than a label.
      expect(holder!.sourceCaseId).toBe(c.id);
      expect(holder!.revokedAt ?? null).toBeNull();
    } finally {
      server.close();
    }
  });

  it('grants nothing when the tool awards nothing', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      // readyCase seeds a tool with no awardedCompetencyIds — the default, and
      // the state every existing tool is in.
      const c = await readyCase(base);
      await signOff(base, c.id, { assessorName: 'A. Assessor', signature: SIG });

      expect(rows(store, 'competencyHolders')).toHaveLength(0);
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

/**
 * The candidate's name on the case detail.
 *
 * Added for the evidence export's filename. Those PDFs get emailed and filed, so
 * a UUID in the name makes a document nobody can identify later — and the one
 * place it matters is an audit, months after the fact.
 */
describe('GET /assessment-cases/:id — candidate name', () => {
  it('resolves the name for display and for the exported filename', async () => {
    const { db, store } = makeDb();
    store.users!.push({ id: CANDIDATE, name: 'Dale Ferguson', email: 'dale@example.com' });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      const created = (await (
        await fetch(`${base}/assessment-cases`, {
          method: 'POST',
          headers: auth(),
          body: JSON.stringify({ toolId: tool.id, candidateUserId: CANDIDATE, pathway: 'new' }),
        })
      ).json()) as { id: string };

      const detail = (await (
        await fetch(`${base}/assessment-cases/${created.id}`, { headers: auth() })
      ).json()) as { candidateName: string; candidateUserId: string };

      expect(detail.candidateName).toBe('Dale Ferguson');
      expect(detail.candidateUserId).toBe(CANDIDATE);
    } finally {
      server.close();
    }
  });

  it('answers with an empty name rather than failing when the user row is gone', async () => {
    // A deleted account must not make an existing case unreadable — the case is
    // the record, and it has to stay openable to be exported.
    const { db } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      const created = (await (
        await fetch(`${base}/assessment-cases`, {
          method: 'POST',
          headers: auth(),
          body: JSON.stringify({ toolId: tool.id, candidateUserId: CANDIDATE, pathway: 'new' }),
        })
      ).json()) as { id: string };

      const res = await fetch(`${base}/assessment-cases/${created.id}`, { headers: auth() });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { candidateName: string }).candidateName).toBe('');
    } finally {
      server.close();
    }
  });
});

/*
  AN ATTEMPT MAY ONLY BE WRITTEN WITH ITS OWN PART'S FIELDS.

  The save route asked who owned the CASE and never what part the attempt was
  for, so any field id in the body was accepted. A candidate could open their
  own theory attempt and post the practical's observation checklist — the
  criteria their assessor is meant to mark while watching them operate the
  machine — and it would be stored against the case and merged into the
  evidence PDF.
*/
describe('attempt writes are scoped to their part', () => {
  async function openAttempt(base: string) {
    const tool = await seedTool(base);
    const caseRes = await fetch(`${base}/assessment-cases`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ toolId: tool.id, candidateUserId: CANDIDATE, pathway: 'new' }),
    });
    const c = (await caseRes.json()) as { id: string };
    const attemptRes = await fetch(`${base}/assessment-cases/${c.id}/parts/p1/attempts`, {
      method: 'POST',
      headers: auth(),
    });
    return { caseId: c.id, attempt: (await attemptRes.json()) as { id: string } };
  }

  function save(base: string, caseId: string, attemptId: string, values: Record<string, unknown>) {
    return fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
      method: 'PATCH',
      headers: auth(),
      body: JSON.stringify({ values }),
    });
  }

  it('refuses a field belonging to a DIFFERENT part', async () => {
    // `log-table` is Part 3's. Writing it through a Part 1 attempt is the hole.
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attempt } = await openAttempt(base);
      const res = await save(base, caseId, attempt.id, { 'log-table': [{ duration: 99 }] });

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; fields: string[] };
      expect(body.error).toBe('field_not_in_part');
      expect(body.fields).toEqual(['log-table']);
    } finally {
      server.close();
    }
  });

  it('accepts a field that IS in the part', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attempt } = await openAttempt(base);
      const res = await save(base, caseId, attempt.id, { q1: ['a'] });

      expect(res.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('does not delete a field the client left out', async () => {
    /*
      The route replaced the whole value map, so an omitted key vanished.
      Harmless while one party writes an attempt; silent data loss the moment
      workflow ownership lets two write one part.
    */
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attempt } = await openAttempt(base);
      await save(base, caseId, attempt.id, { q1: ['a'], 'q-mining': 'noted' });
      await save(base, caseId, attempt.id, { q1: ['b'] });

      const res = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attempt.id}`, {
        headers: auth(),
      });
      const body = (await res.json()) as { values: Record<string, unknown> };
      expect(body.values['q-mining']).toBe('noted');
      expect(body.values.q1).toEqual(['b']);
    } finally {
      server.close();
    }
  });

  it('tolerates an unchanged echo of a foreign key', async () => {
    /*
      The fill screen seeds its state from the stored values and PATCHes the
      whole map back. Rejecting outright would permanently 403 any attempt
      already carrying a stray key — and real data does, under keys the manifest
      never named.
    */
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attempt } = await openAttempt(base);
      // Nothing stored under it, and nothing sent for it either — an echo of
      // undefined is not a change.
      const res = await save(base, caseId, attempt.id, { q1: ['a'], 'log-table': undefined });

      expect(res.status).toBe(200);
    } finally {
      server.close();
    }
  });
});

/*
  AND ONLY WITH THE FIELDS THIS PARTY OWNS.

  Part scoping stopped a candidate writing ANOTHER part's checklist. It did not
  stop them writing THIS part's — which is the case the customer described: the
  candidate fills nothing in a practical, but the practical is one part and its
  fields are all in it.

  The caller here IS the candidate (ADMIN opens the case, so these use a case
  whose candidate is the caller) — that is what makes the party resolution the
  thing under test rather than incidental.
*/
describe('workflow ownership is enforced on an attempt', () => {
  /** A tool whose Part 1 the candidate may read but not write. */
  const READ_ONLY_THEORY = {
    roles: ['candidate', 'assessor'] as const,
    sections: [
      { key: 'p1', ordinal: 1, label: 'Part 1', partKey: 'p1', access: { candidate: 'view', assessor: 'fill' } },
      { key: 'p2', ordinal: 2, label: 'Part 2', partKey: 'p2', access: { candidate: 'view', assessor: 'fill' } },
      { key: 'p3', ordinal: 3, label: 'Part 3', partKey: 'p3', access: { candidate: 'fill', assessor: 'view' } },
      { key: 'p4', ordinal: 4, label: 'Part 4', partKey: 'p4', access: { candidate: 'view', assessor: 'fill' } },
    ],
  };

  async function caseAsCandidate(base: string, workflow?: unknown) {
    const created = await fetch(`${base}/assessment-tools`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        templateId: TEMPLATE,
        name: 'Track Dozer',
        manifest: workflow ? { ...MANIFEST, workflow } : MANIFEST,
      }),
    });
    const tool = (await created.json()) as { id: string };
    // The CALLER is the candidate, so party resolution puts them on the
    // candidate side of their own case.
    const caseRes = await fetch(`${base}/assessment-cases`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ toolId: tool.id, candidateUserId: ADMIN, pathway: 'new' }),
    });
    const c = (await caseRes.json()) as { id: string };
    const attemptRes = await fetch(`${base}/assessment-cases/${c.id}/parts/p1/attempts`, {
      method: 'POST',
      headers: auth(),
    });
    return { caseId: c.id, attemptId: ((await attemptRes.json()) as { id: string }).id };
  }

  it('refuses a field the workflow says this party may only VIEW', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await caseAsCandidate(base, READ_ONLY_THEORY);
      const res = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ values: { q1: ['a'] } }),
      });

      expect(res.status).toBe(403);
      expect(((await res.json()) as { fields: string[] }).fields).toEqual(['q1']);
    } finally {
      server.close();
    }
  });

  it('allows it when the workflow says this party fills it', async () => {
    const FILLS = {
      ...READ_ONLY_THEORY,
      sections: READ_ONLY_THEORY.sections.map((s) =>
        s.key === 'p1' ? { ...s, access: { candidate: 'fill', assessor: 'view' } } : s,
      ),
    };
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await caseAsCandidate(base, FILLS);
      const res = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ values: { q1: ['a'] } }),
      });

      expect(res.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('changes nothing for a tool with no workflow authored', async () => {
    // The migration story. Every existing tool must keep behaving exactly as it
    // did until somebody opens the builder.
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await caseAsCandidate(base);
      const res = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ values: { q1: ['a'] } }),
      });

      expect(res.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('tells the fill surface what may be changed', async () => {
    /*
      Decided server-side and sent, rather than worked out on the screen. A
      second implementation of the rule deciding who may write a competency
      record is a rule that can disagree with itself.
    */
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await caseAsCandidate(base, READ_ONLY_THEORY);
      const res = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        headers: auth(),
      });

      const body = (await res.json()) as { fields: { id: string }[]; writableFieldIds: string[] };
      // Visible — a candidate reads the standard they are held to…
      expect(body.fields.some((f) => f.id === 'q1')).toBe(true);
      // …and cannot mark themselves against it.
      expect(body.writableFieldIds).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('removes a HIDDEN field rather than sending it read-only', async () => {
    // Read-only and absent are different answers. Assessor comments are not
    // the candidate's business at all.
    const HIDES = {
      ...READ_ONLY_THEORY,
      sections: READ_ONLY_THEORY.sections.map((s) =>
        s.key === 'p1'
          ? { ...s, fieldAccess: { q1: { candidate: 'hidden' as const } } }
          : s,
      ),
    };
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await caseAsCandidate(base, HIDES);
      const res = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        headers: auth(),
      });

      const body = (await res.json()) as { fields: { id: string }[] };
      expect(body.fields.some((f) => f.id === 'q1')).toBe(false);
    } finally {
      server.close();
    }
  });
});
