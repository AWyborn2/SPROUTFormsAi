/**
 * Assessment cases, end to end.
 *
 * These run against a STATEFUL fake database rather than the usual
 * return-a-fixture stub, because the behaviour worth proving here is
 * compositional: that a retry allocates a second attempt row while the first
 * survives, that a part stays locked until its predecessor passes, and that a
 * case flips to competent only once every required part has. A stub that
 * returns canned rows per call cannot show any of that â€” it would assert the
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
const BUILDER = '00000000-0000-4000-8000-00000000000b';
const CANDIDATE = '00000000-0000-4000-8000-00000000000c';
const OTHER_CANDIDATE = '00000000-0000-4000-8000-00000000000d';
const COMPETENCY = '00000000-0000-4000-8000-0000000000f1';
const TEMPLATE = '00000000-0000-4000-8000-000000000001';
const VERSION = '00000000-0000-4000-8000-000000000002';
// The organisation's managed Locations (U8). A case points at one of these by
// id; the assessor rule is keyed by the same ids.
const MINING = '00000000-0000-4000-8000-0000000000a1';
const RAW_MATERIALS = '00000000-0000-4000-8000-0000000000a2';
const OFFICE = '00000000-0000-4000-8000-0000000000a3';
// Departments that classify a tool (U10).
const DEPT_OPS = '00000000-0000-4000-8000-0000000000d1';
const DEPT_MAINT = '00000000-0000-4000-8000-0000000000d2';

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

// â”€â”€ the template the manifest is authored against â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
  // Location-specific theory questions. Keyed like the general ones, so the
  // theory part is fully self-marking (U15) â€” a candidate sees only their
  // stream's set, and the hidden set is never marked.
  {
    id: 'q-mining',
    type: 'checkbox_group',
    label: 'Mining only',
    required: false,
    source: 'imported',
    options: ['a', 'b'],
    answerKey: ['a'],
    outcomeTarget: { fieldId: 'q-mining-out' },
  },
  { id: 'q-mining-out', type: 'check_cross', label: 'Mining outcome', required: false, source: 'imported' },
  streamSection('h-raw', 'Raw Materials'),
  {
    id: 'q-raw',
    type: 'checkbox_group',
    label: 'Raw Materials only',
    required: false,
    source: 'imported',
    options: ['a', 'b'],
    answerKey: ['a'],
    outcomeTarget: { fieldId: 'q-raw-out' },
  },
  { id: 'q-raw-out', type: 'check_cross', label: 'Raw Materials outcome', required: false, source: 'imported' },
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
  // The candidate-declaration block, for the declaration-kind tests below.
  // Appended last so every existing part slice keeps its shape.
  header('h-decl'),
  { id: 'decl-sig', type: 'signature', label: 'Candidate signature', required: true, source: 'imported' },
  { id: 'decl-date', type: 'date', label: 'Date', required: false, source: 'imported' },
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

// â”€â”€ stateful fake database â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/*
  Keys that hang the schema metadata off a column node â€” the whole pgTable, its
  encoders, its default expression. The bound param values live directly in the
  query chunks, so skipping these keeps the walk cheap and, since a column points
  back at its table, keeps it from looping.
*/
const SKIP_KEYS = new Set(['table', 'config', 'encoder', 'decoder', 'session', 'dialect', 'default']);

/** Every string `.value` (a bound param) reachable under a node. */
function stringValues(node: unknown, out: string[] = [], depth = 0): string[] {
  if (!node || depth > 10) return out;
  if (Array.isArray(node)) {
    for (const n of node) stringValues(n, out, depth + 1);
    return out;
  }
  if (typeof node !== 'object') return out;
  const rec = node as Record<string, unknown>;
  if (typeof rec.value === 'string') out.push(rec.value);
  for (const [k, v] of Object.entries(rec)) if (!SKIP_KEYS.has(k)) stringValues(v, out, depth + 1);
  return out;
}

/**
 * A drizzle where-clause reduced to what the fake db matches on: `all` are the
 * operands that must every one be present (an `and` of `eq`s), each `anyOf`
 * group is an `inArray` where the row matching ANY one operand is a match, and
 * `notNull` are columns an `isNotNull` demands a value in.
 *
 * `inArray` renders as `col in $params`, so its operands are an OR â€” collecting
 * them into `all` like the eqs would demand a single row hold every id at once
 * and match nothing. `isNotNull` binds NO value at all, so a value-only matcher
 * is blind to it â€” which is exactly the term the KTD2 role-scope filters hang
 * on, so the column name is lifted from the clause and checked against the row
 * (snake_case column to the store's camelCase key). Enough structure to model
 * these routes' reads without importing a SQL engine.
 */
function whereTerms(
  node: unknown,
  acc: { all: string[]; anyOf: string[][]; notNull: string[] } = {
    all: [],
    anyOf: [],
    notNull: [],
  },
  depth = 0,
): { all: string[]; anyOf: string[][]; notNull: string[] } {
  if (!node || depth > 10) return acc;
  if (Array.isArray(node)) {
    for (const n of node) whereTerms(n, acc, depth + 1);
    return acc;
  }
  if (typeof node !== 'object') return acc;
  const rec = node as Record<string, unknown>;

  const chunks = rec.queryChunks;
  if (Array.isArray(chunks)) {
    const text = chunks
      .map((c) => {
        const v = (c as { value?: unknown } | null)?.value;
        return Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '';
      })
      .join('');
    if (text.includes(' is not null')) {
      for (const c of chunks) {
        const name = (c as { name?: unknown } | null)?.name;
        if (typeof name === 'string') {
          acc.notNull.push(name.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase()));
        }
      }
      return acc;
    }
    if (text.includes(' in ')) {
      const group = stringValues(chunks);
      if (group.length) acc.anyOf.push(group);
      return acc;
    }
    for (const c of chunks) whereTerms(c, acc, depth + 1);
    return acc;
  }

  if (typeof rec.value === 'string') acc.all.push(rec.value);
  for (const [k, v] of Object.entries(rec)) if (!SKIP_KEYS.has(k)) whereTerms(v, acc, depth + 1);
  return acc;
}

function matchesWhere(row: Record<string, unknown>, where: unknown): boolean {
  if (!where) return true;
  const { all, anyOf, notNull } = whereTerms(where);
  const present = new Set(Object.values(row).filter((v) => typeof v === 'string'));
  if (![...new Set(all)].every((w) => present.has(w))) return false;
  if (!notNull.every((key) => row[key] !== null && row[key] !== undefined)) return false;
  return anyOf.every((group) => group.some((w) => present.has(w)));
}

let idSeq = 0;
/** Real UUID shapes â€” the routes validate ids as UUIDs, so the fake must too. */
const nextId = () => `00000000-0000-4000-8000-${String(++idSeq).padStart(12, '0')}`;

function makeDb(
  opts: {
    planTier?: string;
    role?: keyof typeof DEFAULT_ROLE_PERMISSIONS;
    /** Make every assessment_tools UPDATE throw â€” proves republish is one transaction. */
    failToolUpdate?: boolean;
  } = {},
) {
  const store: Record<string, Record<string, unknown>[]> = {
    organizations: [{ id: ORG, planTier: opts.planTier ?? 'business', seatLimit: 15, candidateSeatLimit: 200 }],
    rolePermissions: [
      { id: nextId(), orgId: ORG, role: 'admin', matrix: DEFAULT_ROLE_PERMISSIONS.admin },
      { id: nextId(), orgId: ORG, role: 'candidate', matrix: DEFAULT_ROLE_PERMISSIONS.candidate },
    ],
    formTemplates: [{ id: TEMPLATE, orgId: ORG, name: 'Track Dozer', currentVersionId: VERSION }],
    formTemplateVersions: [{ id: VERSION, templateId: TEMPLATE, fields: FIELDS }],
    /*
      The org's managed Locations (U8). A case points at one by id and the
      assessor rule is keyed by the same ids, so creation validates the id is one
      of these and the eligibility check is a plain lookup. OFFICE exists but no
      tool has a rule for it â€” that is a Location with no extra requirement, not a
      near-miss (R79).
    */
    locations: [
      { id: MINING, orgId: ORG, name: 'Mining', status: 'active' },
      { id: RAW_MATERIALS, orgId: ORG, name: 'Raw Materials', status: 'active' },
      { id: OFFICE, orgId: ORG, name: 'Head Office', status: 'active' },
    ],
    // Departments that classify tools (U10). MAINT is retired, to test that a
    // classification cannot be set to a retired Department.
    departments: [
      { id: DEPT_OPS, orgId: ORG, name: 'Operations', status: 'active' },
      { id: DEPT_MAINT, orgId: ORG, name: 'Maintenance', status: 'retired' },
    ],
    assessmentTools: [],
    assessmentToolDrafts: [],
    roleRequiredAssessments: [],
    competencyRequirements: [],
    // The award-link plan walks a legacy role's holders and their Locations
    // (U2) — empty by default, seeded by the award tests.
    membershipRoles: [],
    membershipLocations: [],
    assessmentCases: [],
    assessmentPartAttempts: [],
    competencies: [{ id: COMPETENCY, orgId: ORG, name: 'Track Dozer Operator', code: 'TD-OP', holders: 0 }],
    competencyHolders: [],
    auditLogEntries: [],
    users: [],
    /*
      Case creation requires the candidate to be a member of THIS org â€” without
      it, any org could open a case against any user id in the system. The fake
      db had no memberships table at all, which is the shape of harness that
      lets such a gap survive: the missing check had nothing to fail against.
    */
    memberships: [
      { id: nextId(), orgId: ORG, userId: ADMIN, role: 'admin', status: 'active' },
      { id: nextId(), orgId: ORG, userId: BUILDER, role: 'builder', status: 'active' },
      { id: nextId(), orgId: ORG, userId: CANDIDATE, role: 'candidate', status: 'active' },
      { id: nextId(), orgId: ORG, userId: OTHER_CANDIDATE, role: 'candidate', status: 'active' },
    ],
    /*
      Profiles backing the live display-identifier read a case DTO makes (R24,
      R61). Empty by default, which is the state these cases actually run in â€”
      the identifier resolves to null and the DTO shows the name it always did,
      so every existing assertion about `candidateName` holds unchanged.
    */
    memberProfiles: [],
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
          if (opts.failToolUpdate && name === 'assessmentTools') {
            throw new Error('tool_update_failed (forced by test)');
          }
          for (const row of store[name] ?? []) if (matchesWhere(row, w)) Object.assign(row, patch);
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async (w: unknown) => {
        const name = nameOf(table);
        if (store[name]) store[name] = store[name].filter((row) => !matchesWhere(row, w));
      },
    }),
    select: () => ({ from: () => ({ where: async () => [{ count: 0 }] }) }),
    /*
      A transaction over the store: snapshot on entry, restore on throw. Row
      copies are shallow â€” updates mutate row objects, so restoring the arrays
      of copies is enough to model the rollback the routes rely on.
    */
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const snapshot = Object.fromEntries(
        Object.entries(store).map(([k, v]) => [k, v.map((r) => ({ ...r }))]),
      );
      try {
        return await fn(db);
      } catch (err) {
        for (const k of Object.keys(store)) store[k] = snapshot[k]!;
        throw err;
      }
    },
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

/*
  Creation now REQUIRES exactly one award (U2, R1), so the helper defaults to
  the seeded competency — the shape every real tool has from this round on.
  Tests about the PRE-round state (award-less tools in production data) seed
  their tool row directly into the store instead, because the API can no
  longer create one.
*/
async function seedTool(base: string, manifest = MANIFEST, awardedCompetencyIds: string[] = [COMPETENCY]) {
  const res = await fetch(`${base}/assessment-tools`, {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({
      templateId: TEMPLATE,
      name: 'Track Dozer',
      manifest,
      awardedCompetencyIds,
    }),
  });
  return (await res.json()) as { id: string };
}

/** An award-less tool planted straight into the store — the pre-round state. */
function seedUnlinkedTool(
  store: Record<string, Record<string, unknown>[]>,
  over: Record<string, unknown> = {},
) {
  const row = {
    id: nextId(),
    orgId: ORG,
    templateId: TEMPLATE,
    name: 'Track Dozer',
    manifest: MANIFEST,
    candidatePrerequisiteIds: [],
    assessorCompetencyIds: [],
    assessorStreamCompetencyIds: {},
    awardedCompetencyIds: [],
    locationPartKeys: {},
    departmentId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
  rows(store, 'assessmentTools').push(row);
  return row as { id: string; name: string };
}

afterEach(() => {
  vi.clearAllMocks();
  mockDbValue = null;
});

// â”€â”€ tool authoring â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('GET /assessment-tools (list)', () => {
  it('exposes each tool’s awarded competency, so the new-case form can suggest a pathway', async () => {
    const { db, store } = makeDb();
    seedUnlinkedTool(store, { awardedCompetencyIds: [COMPETENCY] });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/assessment-tools`, { headers: auth() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ awardedCompetencyIds: string[] }>;
      expect(body[0]?.awardedCompetencyIds).toEqual([COMPETENCY]);
    } finally {
      server.close();
    }
  });
});

describe('POST /assessment-tools', () => {
  /*
    A z.object STRIPS unknown keys. So a manifest property this schema omits is
    discarded in silence on the HTTP path while the authoring script keeps it â€”
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
          awardedCompetencyIds: [COMPETENCY],
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

  it('keeps theoryRetry and theoryPassPercent — the schema no longer strips them (task #45)', async () => {
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
          manifest: { ...MANIFEST, theoryRetry: 'immediate', theoryPassPercent: 80 },
          awardedCompetencyIds: [COMPETENCY],
        }),
      });
      expect(res.status).toBe(201);
      const m = rows(store, 'assessmentTools')[0]?.manifest as {
        theoryRetry?: string;
        theoryPassPercent?: number;
      };
      expect(m?.theoryRetry).toBe('immediate');
      expect(m?.theoryPassPercent).toBe(80);
    } finally {
      server.close();
    }
  });

  it('keeps overallNotSatisfactory and the pathway marks — the schema no longer strips them', async () => {
    /*
      The same silent-strip trap, hit again: the manifest type, the builder's
      derivation and the exporter all carried `signOff.overallNotSatisfactory`,
      but this schema omitted it — so every tool published over HTTP lost the
      "Candidate not yet Competent" box, and the pair printed half-written on
      exactly the records that needed the negative half.
    */
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
          manifest: {
            ...MANIFEST,
            signOff: {
              overallSatisfactory: { fieldId: 'q-mining-out', value: true },
              overallNotSatisfactory: { fieldId: 'q-raw-out', value: true },
            },
            pathwayMarks: { new: { fieldId: 'q-mining-out', value: true } },
          },
          awardedCompetencyIds: [COMPETENCY],
        }),
      });
      expect(res.status).toBe(201);
      const m = rows(store, 'assessmentTools')[0]?.manifest as {
        signOff?: { overallNotSatisfactory?: { fieldId: string } };
        pathwayMarks?: { new?: { fieldId: string } };
      };
      expect(m?.signOff?.overallNotSatisfactory?.fieldId).toBe('q-raw-out');
      expect(m?.pathwayMarks?.new?.fieldId).toBe('q-mining-out');
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
        body: JSON.stringify({ templateId: TEMPLATE, name: 'Track Dozer', manifest: MANIFEST, awardedCompetencyIds: [COMPETENCY] }),
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
        body: JSON.stringify({ templateId: TEMPLATE, name: 'Bad', manifest: bad, awardedCompetencyIds: [COMPETENCY] }),
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

  /*
    THE EXACTLY-ONE AWARD RULE (U2, R1, KTD4). A tool that awards nothing is
    vacuously satisfied by everyone (pinned against decideAssignments in
    packages/shared/src/assignment.test.ts), so creation refuses to mint one;
    and strictly-one means a combined course is two assessments, never a
    two-award tool.
  */
  it('refuses a create with ZERO award ids', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/assessment-tools`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          templateId: TEMPLATE,
          name: 'Track Dozer',
          manifest: MANIFEST,
          awardedCompetencyIds: [],
        }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_request');
    } finally {
      server.close();
    }
  });

  it('refuses a create with TWO award ids (strictly one, KTD4)', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const second = '00000000-0000-4000-8000-0000000000f2';
      rows(store, 'competencies').push({ id: second, orgId: ORG, name: 'Second', holders: 0 });
      const res = await fetch(`${base}/assessment-tools`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          templateId: TEMPLATE,
          name: 'Track Dozer',
          manifest: MANIFEST,
          awardedCompetencyIds: [COMPETENCY, second],
        }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_request');
    } finally {
      server.close();
    }
  });

  it('refuses an award that is not one of the organisation’s competencies (invalid_award)', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/assessment-tools`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          templateId: TEMPLATE,
          name: 'Track Dozer',
          manifest: MANIFEST,
          awardedCompetencyIds: ['00000000-0000-4000-8000-00000000dead'],
        }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_award');
    } finally {
      server.close();
    }
  });
});

/**
 * The workflow editor's summary auto-fill keys. Publish GUESSES the result
 * pair and the methods mapping from printed labels with no way to see or fix
 * the guess; these PATCH keys are the fix, so what they persist — and what
 * they refuse — is pinned here.
 */
describe('PATCH /assessment-tools/:id — summary auto-fill keys', () => {
  it('persists the result pair and the pathway map, and a later save keeps them', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      const res = await fetch(`${base}/assessment-tools/${tool.id}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({
          signOff: {
            overallSatisfactory: { fieldId: 'q-mining-out', value: true },
            overallNotSatisfactory: { fieldId: 'q-raw-out', value: true },
          },
          pathwayMarks: { new: { fieldId: 'q-mining-out', value: true } },
        }),
      });
      expect(res.status).toBe(200);

      // A name-only PATCH must leave them exactly as stored — the tri-state's
      // whole point is that saving one thing cannot erase another.
      await fetch(`${base}/assessment-tools/${tool.id}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ name: 'Renamed' }),
      });

      const m = rows(store, 'assessmentTools').find((r) => r.id === tool.id)?.manifest as {
        signOff?: { overallSatisfactory?: { fieldId: string }; overallNotSatisfactory?: { fieldId: string } };
        pathwayMarks?: { new?: { fieldId: string } };
      };
      expect(m?.signOff?.overallSatisfactory?.fieldId).toBe('q-mining-out');
      expect(m?.signOff?.overallNotSatisfactory?.fieldId).toBe('q-raw-out');
      expect(m?.pathwayMarks?.new?.fieldId).toBe('q-mining-out');
    } finally {
      server.close();
    }
  });

  it('clears the sign-off block with null', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      await fetch(`${base}/assessment-tools/${tool.id}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({
          signOff: { overallSatisfactory: { fieldId: 'q-mining-out', value: true } },
        }),
      });
      await fetch(`${base}/assessment-tools/${tool.id}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ signOff: null }),
      });

      const m = rows(store, 'assessmentTools').find((r) => r.id === tool.id)?.manifest as {
        signOff?: unknown;
      };
      expect(m?.signOff).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('refuses a pathway box that is not in this version, and writes nothing', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      const res = await fetch(`${base}/assessment-tools/${tool.id}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({
          pathwayMarks: { new: { fieldId: 'ghost-box', value: true } },
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; problems: string[] };
      expect(body.error).toBe('invalid_workflow');
      expect(body.problems.join(' ')).toContain('ghost-box');
      const m = rows(store, 'assessmentTools').find((r) => r.id === tool.id)?.manifest as {
        pathwayMarks?: unknown;
      };
      expect(m?.pathwayMarks).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('refuses a completion mark pointing at anything but a fixed-row table', async () => {
    const { db } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      const res = await fetch(`${base}/assessment-tools/${tool.id}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({
          partCompletionMarks: [{ partKey: 'p1', fieldId: 'q1', rowIndex: 0, columnKey: 'used' }],
        }),
      });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_workflow');
    } finally {
      server.close();
    }
  });
});

// ── the backfill worklist and the award link (U2 — R2, R3, R15, KTD5, KTD10) ─

describe('GET /assessment-tools/unlinked', () => {
  it('lists only award-less tools, suggesting on an exact name or code match (KTD5)', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      // A LINKED tool (created through the API, so it awards) must not appear.
      await seedTool(base);
      const byName = seedUnlinkedTool(store, { name: 'Track Dozer Operator' }); // = competency name
      const byCode = seedUnlinkedTool(store, { name: 'td-op' }); // = code, case-insensitively
      const noMatch = seedUnlinkedTool(store, { name: 'Site Familiarisation v2' }); // AE3's resolve row

      const res = await fetch(`${base}/assessment-tools/unlinked`, { headers: auth() });
      /*
        200 with an ARRAY is also the registration-order pin: declared after
        GET /:id, "unlinked" would be captured as an :id and cast against a
        uuid column instead of reaching this handler.
      */
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{
        id: string;
        suggestion: { competencyId: string; name: string } | null;
      }>;
      expect(Array.isArray(body)).toBe(true);
      expect(body.map((t) => t.id).sort()).toEqual([byName.id, byCode.id, noMatch.id].sort());
      const suggestionOf = (id: string) => body.find((t) => t.id === id)?.suggestion;
      expect(suggestionOf(byName.id)).toEqual({ competencyId: COMPETENCY, name: 'Track Dozer Operator' });
      expect(suggestionOf(byCode.id)).toEqual({ competencyId: COMPETENCY, name: 'Track Dozer Operator' });
      expect(suggestionOf(noMatch.id)).toBeNull(); // surfaced, never guessed (R3)
    } finally {
      server.close();
    }
  });

  it('refuses a non-admin — reading the worklist sits on the gate that acts on it', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/assessment-tools/unlinked`, { headers: auth(candidate) });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });
});

describe('award link: PUT /assessment-tools/:id/award and its preview (U2, KTD3, KTD10)', () => {
  const ROLE_1 = '00000000-0000-4000-8000-00000000ab01';
  const ROLE_2 = '00000000-0000-4000-8000-00000000ab02';
  const COMP_2 = '00000000-0000-4000-8000-0000000000f2';

  /** Give `userId`'s membership the Role and a Location, so a case can land. */
  function placeHolder(
    store: Record<string, Record<string, unknown>[]>,
    userId: string,
    roleId: string,
  ) {
    const membership = rows(store, 'memberships').find((m) => m.userId === userId)!;
    rows(store, 'membershipRoles').push({
      id: nextId(),
      membershipId: membership.id,
      roleId,
      withdrawnAt: null,
    });
    rows(store, 'membershipLocations').push({
      id: nextId(),
      membershipId: membership.id,
      locationId: MINING,
      position: 0,
    });
    return membership;
  }

  const award = (base: string, toolId: string, body: Record<string, unknown>, session: Session = admin) =>
    fetch(`${base}/assessment-tools/${toolId}/award`, {
      method: 'PUT',
      headers: auth(session),
      body: JSON.stringify(body),
    });
  const preview = (base: string, toolId: string, body: Record<string, unknown>) =>
    fetch(`${base}/assessment-tools/${toolId}/award/preview`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify(body),
    });

  it('FIRST LINK: preview counts equal the apply, which converts legacy rows and inserts the cases (R15, KTD3)', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = seedUnlinkedTool(store);
      rows(store, 'roleRequiredAssessments').push({
        id: nextId(),
        orgId: ORG,
        roleId: ROLE_1,
        toolId: tool.id,
      });
      placeHolder(store, CANDIDATE, ROLE_1);

      // The preview — the tool still awards nothing, so the count MUST come
      // from the injected pending award, not the stored (vacuous) state.
      const previewed = (await (
        await preview(base, tool.id, { competencyId: COMPETENCY })
      ).json()) as Record<string, number>;
      expect(previewed).toEqual({ rolesLinked: 1, affected: 1, created: 1 });
      // A preview writes nothing.
      expect(rows(store, 'assessmentCases')).toHaveLength(0);
      expect(rows(store, 'competencyRequirements')).toHaveLength(0);

      const applied = await award(base, tool.id, { competencyId: COMPETENCY });
      expect(applied.status).toBe(200);
      expect(await applied.json()).toEqual(previewed); // preview == apply (KTD10)

      // One transaction: award set, link inserted, legacy drained, case live.
      const toolRow = rows(store, 'assessmentTools').find((t) => t.id === tool.id)!;
      expect(toolRow.awardedCompetencyIds).toEqual([COMPETENCY]);
      expect(rows(store, 'competencyRequirements')).toEqual([
        expect.objectContaining({ roleId: ROLE_1, competencyId: COMPETENCY, tier: 'required' }),
      ]);
      expect(rows(store, 'roleRequiredAssessments')).toHaveLength(0);
      const cases = rows(store, 'assessmentCases');
      expect(cases).toHaveLength(1);
      expect(cases[0]).toMatchObject({ toolId: tool.id, candidateUserId: CANDIDATE, locationId: MINING });
    } finally {
      server.close();
    }
  });

  it('conversion UPGRADES an existing recommended row rather than inserting a second (unique index)', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = seedUnlinkedTool(store);
      rows(store, 'roleRequiredAssessments').push({
        id: nextId(),
        orgId: ORG,
        roleId: ROLE_2,
        toolId: tool.id,
      });
      const existingLinkId = nextId();
      rows(store, 'competencyRequirements').push({
        id: existingLinkId,
        orgId: ORG,
        roleId: ROLE_2,
        competencyId: COMPETENCY,
        tier: 'recommended',
      });

      const applied = await award(base, tool.id, { competencyId: COMPETENCY });
      expect(applied.status).toBe(200);

      const links = rows(store, 'competencyRequirements');
      expect(links).toHaveLength(1); // upgraded IN PLACE — never a second row
      expect(links[0]).toMatchObject({ id: existingLinkId, tier: 'required' });
    } finally {
      server.close();
    }
  });

  it('repeats idempotently: a second PUT of the SAME competency converts nothing further', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = seedUnlinkedTool(store);
      rows(store, 'roleRequiredAssessments').push({
        id: nextId(),
        orgId: ORG,
        roleId: ROLE_1,
        toolId: tool.id,
      });
      placeHolder(store, CANDIDATE, ROLE_1);

      await award(base, tool.id, { competencyId: COMPETENCY });
      const repeat = await award(base, tool.id, { competencyId: COMPETENCY });

      expect(repeat.status).toBe(200);
      expect(await repeat.json()).toMatchObject({ rolesLinked: 0, affected: 0, created: 0 });
      expect(rows(store, 'assessmentCases')).toHaveLength(1); // no duplicate case
      expect(rows(store, 'competencyRequirements')).toHaveLength(1);
    } finally {
      server.close();
    }
  });

  it('RE-LINK: 409s while the tool has a non-terminal case (KTD10)', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base); // awards COMPETENCY
      rows(store, 'competencies').push({ id: COMP_2, orgId: ORG, name: 'Grader Operator', holders: 0 });
      rows(store, 'assessmentCases').push({
        id: nextId(),
        orgId: ORG,
        toolId: tool.id,
        candidateUserId: CANDIDATE,
        state: 'open',
      });

      const res = await award(base, tool.id, { competencyId: COMP_2, confirm: true });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('open_cases');
      // Nothing moved: the award still points at the outgoing competency.
      const toolRow = rows(store, 'assessmentTools').find((t) => t.id === tool.id)!;
      expect(toolRow.awardedCompetencyIds).toEqual([COMPETENCY]);
    } finally {
      server.close();
    }
  });

  it('RE-LINK: demands confirm, previews the outgoing grants, and carries the role links across (KTD10)', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base); // awards COMPETENCY (the outgoing)
      rows(store, 'competencies').push({ id: COMP_2, orgId: ORG, name: 'Grader Operator', holders: 0 });
      // Two live grants of the outgoing competency — they must be COUNTED and
      // never touched (history is state).
      for (const userId of [CANDIDATE, OTHER_CANDIDATE]) {
        rows(store, 'competencyHolders').push({
          id: nextId(),
          orgId: ORG,
          competencyId: COMPETENCY,
          userId,
          grantedAt: new Date('2025-01-01'),
          revokedAt: null,
        });
      }
      // One role requires the outgoing competency; its holder lacks COMP_2.
      const linkId = nextId();
      rows(store, 'competencyRequirements').push({
        id: linkId,
        orgId: ORG,
        roleId: ROLE_1,
        competencyId: COMPETENCY,
        tier: 'required',
      });
      placeHolder(store, OTHER_CANDIDATE, ROLE_1);

      const previewed = (await (
        await preview(base, tool.id, { competencyId: COMP_2, carryRoleLinks: true })
      ).json()) as Record<string, number>;
      expect(previewed).toEqual({ outgoingGrants: 2, rolesRequiringOutgoing: 1, created: 1 });

      // A bare re-link is refused — the caller must attest they saw the preview.
      const bare = await award(base, tool.id, { competencyId: COMP_2, carryRoleLinks: true });
      expect(bare.status).toBe(400);
      expect(((await bare.json()) as { error: string }).error).toBe('confirm_required');

      const applied = await award(base, tool.id, {
        competencyId: COMP_2,
        carryRoleLinks: true,
        confirm: true,
      });
      expect(applied.status).toBe(200);
      expect(await applied.json()).toEqual(previewed); // preview == apply (KTD10)

      // The role link is RE-POINTED in place; the grants are untouched.
      const links = rows(store, 'competencyRequirements');
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({ id: linkId, competencyId: COMP_2, tier: 'required' });
      const grants = rows(store, 'competencyHolders');
      expect(grants).toHaveLength(2);
      expect(grants.every((g) => g.competencyId === COMPETENCY)).toBe(true);
      // The activated case for the carried role's holder.
      expect(rows(store, 'assessmentCases')).toHaveLength(1);
      expect(rows(store, 'assessmentCases')[0]).toMatchObject({
        toolId: tool.id,
        candidateUserId: OTHER_CANDIDATE,
      });
    } finally {
      server.close();
    }
  });

  it('RE-LINK ignores a NON-role requirement of the outgoing competency — neither carried nor counted (KTD2)', async () => {
    /*
      The requirements table now holds four scopes, and the outgoing-links read
      selects by competencyId — so without its role filter the carry would
      ingest an org-scope row the moment the table generalised: a null roleId
      in the carry plan, an inflated rolesRequiringOutgoing on the confirm
      dialog, and a repoint that could collide with the org-scope partial
      unique index. Award-link conversion is inherently role-scoped (legacy
      rows only ever lived on roles), so the org-scope row must sit this out
      entirely: not counted, not re-pointed, still naming the OUTGOING
      competency after the apply.
    */
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base); // awards COMPETENCY (the outgoing)
      rows(store, 'competencies').push({ id: COMP_2, orgId: ORG, name: 'Grader Operator', holders: 0 });
      const roleLinkId = nextId();
      const orgScopeId = nextId();
      rows(store, 'competencyRequirements').push(
        { id: roleLinkId, orgId: ORG, roleId: ROLE_1, competencyId: COMPETENCY, tier: 'required' },
        // The org itself requires the outgoing competency — all scope columns null.
        {
          id: orgScopeId,
          orgId: ORG,
          roleId: null,
          locationId: null,
          departmentId: null,
          competencyId: COMPETENCY,
          tier: 'required',
        },
      );
      placeHolder(store, OTHER_CANDIDATE, ROLE_1);

      const previewed = (await (
        await preview(base, tool.id, { competencyId: COMP_2, carryRoleLinks: true })
      ).json()) as Record<string, number>;
      // ONE role requires the outgoing competency. The org-scope row is not a role.
      expect(previewed).toEqual({ outgoingGrants: 0, rolesRequiringOutgoing: 1, created: 1 });

      const applied = await award(base, tool.id, {
        competencyId: COMP_2,
        carryRoleLinks: true,
        confirm: true,
      });
      expect(applied.status).toBe(200);
      expect(await applied.json()).toEqual(previewed); // preview == apply (KTD10)

      // The role link travelled; the org-scope row did not move an inch.
      const links = rows(store, 'competencyRequirements');
      expect(links).toHaveLength(2);
      expect(links.find((l) => l.id === roleLinkId)).toMatchObject({ competencyId: COMP_2 });
      expect(links.find((l) => l.id === orgScopeId)).toMatchObject({
        competencyId: COMPETENCY,
        roleId: null,
        tier: 'required',
      });
    } finally {
      server.close();
    }
  });

  it('RE-LINK with carry MERGES into an existing incoming link instead of colliding (unique index)', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      rows(store, 'competencies').push({ id: COMP_2, orgId: ORG, name: 'Grader Operator', holders: 0 });
      // The role ALREADY requires the incoming competency alongside the outgoing.
      rows(store, 'competencyRequirements').push(
        { id: nextId(), orgId: ORG, roleId: ROLE_1, competencyId: COMPETENCY, tier: 'required' },
        { id: nextId(), orgId: ORG, roleId: ROLE_1, competencyId: COMP_2, tier: 'required' },
      );

      const applied = await award(base, tool.id, {
        competencyId: COMP_2,
        carryRoleLinks: true,
        confirm: true,
      });
      expect(applied.status).toBe(200);

      const links = rows(store, 'competencyRequirements');
      expect(links).toHaveLength(1); // the outgoing row deleted, never re-pointed into a clash
      expect(links[0]).toMatchObject({ roleId: ROLE_1, competencyId: COMP_2, tier: 'required' });
    } finally {
      server.close();
    }
  });

  it('RE-LINK with confirm but NO carry moves the award alone — links and cases untouched', async () => {
    /*
      THE LIKELY DEFAULT ADMIN ACTION, and until now the only award path with
      no test at all. Without `carryRoleLinks` the correction is deliberately
      narrow: the tool starts awarding the incoming competency and NOTHING else
      moves. The role that required the outgoing competency keeps requiring it
      — now with no awarding tool, i.e. an evidence-only requirement (R7) — and
      because the roles stop deriving this tool, nobody is owed a new case.

      The holder below is seeded precisely so a carry WOULD have created one:
      `created: 0` is then a fact about the no-carry branch rather than about an
      empty fixture.
    */
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base); // awards COMPETENCY (the outgoing)
      rows(store, 'competencies').push({ id: COMP_2, orgId: ORG, name: 'Grader Operator', holders: 0 });
      const linkId = nextId();
      rows(store, 'competencyRequirements').push({
        id: linkId,
        orgId: ORG,
        roleId: ROLE_1,
        competencyId: COMPETENCY,
        tier: 'required',
      });
      placeHolder(store, OTHER_CANDIDATE, ROLE_1);

      const previewed = (await (
        await preview(base, tool.id, { competencyId: COMP_2 })
      ).json()) as Record<string, number>;
      expect(previewed).toEqual({ outgoingGrants: 0, rolesRequiringOutgoing: 1, created: 0 });

      const applied = await award(base, tool.id, { competencyId: COMP_2, confirm: true });
      expect(applied.status).toBe(200);
      expect(await applied.json()).toEqual(previewed); // preview == apply (KTD10)

      // The award moved…
      const toolRow = rows(store, 'assessmentTools').find((t) => t.id === tool.id)!;
      expect(toolRow.awardedCompetencyIds).toEqual([COMP_2]);
      // …and nothing else did.
      const links = rows(store, 'competencyRequirements');
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({ id: linkId, competencyId: COMPETENCY, tier: 'required' });
      expect(rows(store, 'assessmentCases')).toHaveLength(0);
    } finally {
      server.close();
    }
  });

  it('RE-LINK with carry UPGRADES a RECOMMENDED incoming link and drops the outgoing row', async () => {
    /*
      The third carry action (`merge-upgrade`), and the only one the unique
      index makes unavoidable: the role already names the incoming competency,
      but merely as a RECOMMENDATION. Re-pointing the outgoing row onto it
      would collide with competency_requirements_role_uq, and deleting the
      outgoing row alone would quietly DEMOTE a required competency to
      recommended. So the recommended row is promoted in place and the outgoing
      row deleted — one row, tier 'required', requirement preserved.
    */
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base); // awards COMPETENCY (the outgoing)
      rows(store, 'competencies').push({ id: COMP_2, orgId: ORG, name: 'Grader Operator', holders: 0 });
      const outgoingLinkId = nextId();
      const recommendedLinkId = nextId();
      rows(store, 'competencyRequirements').push(
        { id: outgoingLinkId, orgId: ORG, roleId: ROLE_1, competencyId: COMPETENCY, tier: 'required' },
        { id: recommendedLinkId, orgId: ORG, roleId: ROLE_1, competencyId: COMP_2, tier: 'recommended' },
      );

      const applied = await award(base, tool.id, {
        competencyId: COMP_2,
        carryRoleLinks: true,
        confirm: true,
      });
      expect(applied.status).toBe(200);

      const links = rows(store, 'competencyRequirements');
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({
        id: recommendedLinkId, // promoted IN PLACE, never a second row
        competencyId: COMP_2,
        tier: 'required',
      });
      expect(links.some((l) => l.id === outgoingLinkId)).toBe(false);
    } finally {
      server.close();
    }
  });

  it('refuses a non-admin and a competency outside the organisation', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = seedUnlinkedTool(store);
      const forbidden = await award(base, tool.id, { competencyId: COMPETENCY }, candidate);
      expect(forbidden.status).toBe(403);

      const foreign = await award(base, tool.id, {
        competencyId: '00000000-0000-4000-8000-00000000dead',
      });
      expect(foreign.status).toBe(400);
      expect(((await foreign.json()) as { error: string }).error).toBe('invalid_award');
    } finally {
      server.close();
    }
  });
});

// â”€â”€ case creation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    // belonging to another org's user opened a real case â€” building a
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
          awardedCompetencyIds: [COMPETENCY],
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
        awardedCompetencyIds: [COMPETENCY],
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
    requirement that APPLIES surfaces as a gap â€” which is what makes the absent
    one meaningful.
  */
  const WORSLEY = '00000000-0000-4000-8000-0000000000e1';
  const MOBILE_PLANT = '00000000-0000-4000-8000-0000000000e2';

  async function caseAtLocation(base: string, locationId?: string, byStream = true) {
    const created = await fetch(`${base}/assessment-tools`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        templateId: TEMPLATE,
        name: 'Track Dozer',
        manifest: MANIFEST,
        assessorCompetencyIds: [COMPETENCY],
        awardedCompetencyIds: [COMPETENCY],
        // Keyed by Location id now, not by stream name (U8).
        ...(byStream
          ? { assessorStreamCompetencyIds: { [MINING]: [WORSLEY], [RAW_MATERIALS]: [MOBILE_PLANT] } }
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
        // Name an assessor who holds nothing, so the assessor-eligibility check
        // has a subject (a pooled create names none and warns about none â€” U13).
        assessorUserId: ADMIN,
        pathway: 'experienced',
        ...(locationId ? { locationId } : {}),
      }),
    });
    return { status: res.status, body: (await res.json()) as { prerequisiteWarnings?: string[]; error?: string } };
  }

  it('asks for the mine authority at the mine, and not the other one', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const warnings = (await caseAtLocation(base, MINING)).body.prerequisiteWarnings!.join('\n');

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
      const warnings = (await caseAtLocation(base, RAW_MATERIALS)).body.prerequisiteWarnings!.join('\n');

      expect(warnings).toContain(MOBILE_PLANT);
      expect(warnings).not.toContain(WORSLEY);
    } finally {
      server.close();
    }
  });

  it('refuses a case at a Location that is not the organisation\'s', async () => {
    /*
      A Location is chosen from the org's list, never typed (R77), so an id that
      is not one of the org's active Locations is a bad request, not a case
      opened against an unknown site. This is the check that makes a near-miss
      impossible â€” there is nothing to normalise because nothing is free text.
    */
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const notOurs = '00000000-0000-4000-8000-0000000000bb';
      const { status, body } = await caseAtLocation(base, notOurs);

      expect(status).toBe(400);
      expect(body.error).toBe('location_not_found');
    } finally {
      server.close();
    }
  });

  it('says the check was only partial when the case names no Location', async () => {
    /*
      Reporting just the always-required half would present a partial check as a
      complete one. The case still opens â€” eligibility never blocks â€” but the
      warning has to say what went unchecked and name the Locations the tool has
      a rule for, because the fix is to set one.
    */
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const warnings = (await caseAtLocation(base)).body.prerequisiteWarnings!.join('\n');

      expect(warnings).toContain('only partly checked');
      // Named by their current Location names, resolved from the keyed ids.
      expect(warnings).toContain('Mining');
      expect(warnings).toContain('Raw Materials');
      // And it invented no gap for a requirement it could not resolve.
      expect(warnings).not.toContain(WORSLEY);
      expect(warnings).not.toContain(MOBILE_PLANT);
    } finally {
      server.close();
    }
  });

  it('treats a Location the tool has no rule for as matched, not a near-miss (R79)', async () => {
    /*
      The failure the old free-text model nearly shipped with is now impossible.
      A Location is an id chosen from the org's list, so a case at a Location the
      tool has no rule for is a site with no extra requirement â€” the always-half
      applies and the check is complete. There is no "unrecognised" state to warn
      about, because there is no spelling to get wrong.
    */
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const warnings = (await caseAtLocation(base, OFFICE)).body.prerequisiteWarnings!.join('\n');

      expect(warnings).not.toContain('only partly checked');
      // The always-required half still surfaces; no location-specific gap is invented.
      expect(warnings).toContain(COMPETENCY);
      expect(warnings).not.toContain(WORSLEY);
      expect(warnings).not.toContain(MOBILE_PLANT);
    } finally {
      server.close();
    }
  });

  it('says nothing about Locations for a tool whose rule does not vary', async () => {
    // Every tool that existed before this column. A missing Location is not a gap
    // when nothing depended on it â€” warning here would fire on every case.
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const warnings = (await caseAtLocation(base, undefined, false)).body.prerequisiteWarnings!.join('\n');

      expect(warnings).not.toContain('only partly checked');
    } finally {
      server.close();
    }
  });
});

// â”€â”€ the location-to-parts rule (U9) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('PATCH /assessment-tools/:id/location-parts', () => {
  async function makeTool(base: string) {
    const res = await fetch(`${base}/assessment-tools`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ templateId: TEMPLATE, name: 'Track Dozer', manifest: MANIFEST, awardedCompetencyIds: [COMPETENCY] }),
    });
    return (await res.json()) as { id: string };
  }

  function setRule(
    base: string,
    toolId: string,
    locationPartKeys: Record<string, string[]>,
    session: Session = admin,
  ) {
    return fetch(`${base}/assessment-tools/${toolId}/location-parts`, {
      method: 'PATCH',
      headers: auth(session),
      body: JSON.stringify({ locationPartKeys }),
    });
  }

  it('declares the rule as an Admin and reads it back on the tool', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const tool = await makeTool(base);
      expect((await setRule(base, tool.id, { [MINING]: ['p1', 'p2'] })).status).toBe(200);

      const got = await fetch(`${base}/assessment-tools/${tool.id}`, { headers: auth() });
      const body = (await got.json()) as {
        locationPartKeys: Record<string, string[]>;
        locations: Array<{ id: string; name: string }>;
      };
      expect(body.locationPartKeys).toEqual({ [MINING]: ['p1', 'p2'] });
      // The active Locations the rule may distinguish come back for the editor (R76).
      expect(body.locations.map((l) => l.id)).toContain(MINING);
    } finally {
      server.close();
    }
  });

  it('refuses a Builder and accepts an Admin (R73)', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const tool = await makeTool(base);
      const asBuilder = await setRule(base, tool.id, { [MINING]: ['p1'] }, {
        userId: BUILDER,
        orgId: ORG,
        role: 'builder',
      });
      expect(asBuilder.status).toBe(403);

      expect((await setRule(base, tool.id, { [MINING]: ['p1'] })).status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('refuses a rule declared for a retired Location (R118)', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const RETIRED = '00000000-0000-4000-8000-0000000000b9';
    rows(store, 'locations').push({ id: RETIRED, orgId: ORG, name: 'Old Pit', status: 'retired' });
    const { server, base } = startApp();
    try {
      const tool = await makeTool(base);
      const res = await setRule(base, tool.id, { [RETIRED]: ['p1'] });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('location_not_found');
    } finally {
      server.close();
    }
  });

  it('keeps a rule for a Location retired after it was declared, and still returns it (R118)', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = await makeTool(base);
      // Declared while MINING is activeâ€¦
      expect((await setRule(base, tool.id, { [MINING]: ['p1', 'p2'] })).status).toBe(200);
      // â€¦then MINING retires. A rule stays with the Location it names.
      for (const l of rows(store, 'locations')) if (l.id === MINING) l.status = 'retired';
      // Re-saving the same map is not rejected â€” the entry already existed.
      expect((await setRule(base, tool.id, { [MINING]: ['p1', 'p2'] })).status).toBe(200);

      const got = await fetch(`${base}/assessment-tools/${tool.id}`, { headers: auth() });
      const body = (await got.json()) as { locationPartKeys: Record<string, string[]> };
      expect(body.locationPartKeys).toEqual({ [MINING]: ['p1', 'p2'] });
    } finally {
      server.close();
    }
  });

  it('refuses a part key the manifest does not declare', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const tool = await makeTool(base);
      const res = await setRule(base, tool.id, { [MINING]: ['p1', 'ghost'] });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('unknown_part');
    } finally {
      server.close();
    }
  });
});

// â”€â”€ tool classification and the Department filter (U10) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('PATCH /assessment-tools/:id/classification and the filter', () => {
  async function makeTool(base: string) {
    const res = await fetch(`${base}/assessment-tools`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ templateId: TEMPLATE, name: 'Track Dozer', manifest: MANIFEST, awardedCompetencyIds: [COMPETENCY] }),
    });
    return (await res.json()) as { id: string };
  }
  function classify(base: string, id: string, departmentId: string | null, session: Session = admin) {
    return fetch(`${base}/assessment-tools/${id}/classification`, {
      method: 'PATCH',
      headers: auth(session),
      body: JSON.stringify({ departmentId }),
    });
  }
  async function toolDept(base: string, id: string) {
    const got = (await (await fetch(`${base}/assessment-tools/${id}`, { headers: auth() })).json()) as {
      departmentId: string | null;
    };
    return got.departmentId;
  }

  it('classifies a tool as an Admin and reads it back (R9)', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const tool = await makeTool(base);
      expect((await classify(base, tool.id, DEPT_OPS)).status).toBe(200);
      expect(await toolDept(base, tool.id)).toBe(DEPT_OPS);
    } finally {
      server.close();
    }
  });

  it('refuses classification by a non-admin (R73 sibling)', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const tool = await makeTool(base);
      const res = await classify(base, tool.id, DEPT_OPS, { userId: BUILDER, orgId: ORG, role: 'builder' });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('refuses a retired Department (R10, R16)', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const tool = await makeTool(base);
      const res = await classify(base, tool.id, DEPT_MAINT);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('department_not_found');
    } finally {
      server.close();
    }
  });

  it('carries at most one Department â€” a second classification replaces the first (R9)', async () => {
    const { db, store } = makeDb();
    const DEPT_RAIL = '00000000-0000-4000-8000-0000000000d3';
    rows(store, 'departments').push({ id: DEPT_RAIL, orgId: ORG, name: 'Rail', status: 'active' });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = await makeTool(base);
      expect((await classify(base, tool.id, DEPT_OPS)).status).toBe(200);
      expect((await classify(base, tool.id, DEPT_RAIL)).status).toBe(200);
      expect(await toolDept(base, tool.id)).toBe(DEPT_RAIL);
    } finally {
      server.close();
    }
  });

  it('clears the classification to unclassified with null (R10)', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const tool = await makeTool(base);
      await classify(base, tool.id, DEPT_OPS);
      expect((await classify(base, tool.id, null)).status).toBe(200);
      expect(await toolDept(base, tool.id)).toBeNull();
    } finally {
      server.close();
    }
  });

  it('filters by Department, and an unclassified tool appears in every filter (R9, R10, R11)', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const classified = await makeTool(base);
      await classify(base, classified.id, DEPT_OPS);
      const unclassified = await makeTool(base);

      const ops = (await (
        await fetch(`${base}/assessment-tools?departmentId=${DEPT_OPS}`, { headers: auth() })
      ).json()) as Array<{ id: string }>;
      const opsIds = ops.map((t) => t.id);
      expect(opsIds).toContain(classified.id); // carries this Department
      expect(opsIds).toContain(unclassified.id); // and the unclassified appears everywhere (R11)

      // Filtering by a different Department drops the classified tool, keeps the unclassified.
      const other = (await (
        await fetch(`${base}/assessment-tools?departmentId=${DEPT_MAINT}`, { headers: auth() })
      ).json()) as Array<{ id: string }>;
      const otherIds = other.map((t) => t.id);
      expect(otherIds).not.toContain(classified.id);
      expect(otherIds).toContain(unclassified.id);
    } finally {
      server.close();
    }
  });
});

// â”€â”€ attempts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    400'd without them. Nothing could supply them â€” the assessor makes no
    judgement on a theory part, so the UI offers no outcome control â€” which left
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

      // Assert the failure was RECORDED as well as that the case stayed open â€”
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
    // Defaulting to coaching is a DEFAULT, not a ceiling â€” the deliberate act
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

// â”€â”€ logbook â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ access scoping â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('candidate scoping', () => {
  it('hides another candidateâ€™s case behind a 404, not a 403', async () => {
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

  it('lists only the calling candidateâ€™s own cases', async () => {
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
        currentPartLabel: string | null;
        currentPartIndex: number | null;
        requiredPartCount: number;
        awaitingAssessor: boolean;
      }[];
      const all = (await (await fetch(`${base}/assessment-cases`, { headers: auth() })).json()) as unknown[];

      expect(mine).toHaveLength(1);
      expect(mine[0]?.candidateUserId).toBe(CANDIDATE);
      // A fresh case carries its stage: it sits at the first required part and
      // is waiting on nobody yet (no part handed in, not signing off).
      expect(mine[0]?.currentPartIndex).toBe(1);
      expect(mine[0]?.requiredPartCount).toBeGreaterThan(0);
      expect(mine[0]?.currentPartLabel).toBeTruthy();
      expect(mine[0]?.awaitingAssessor).toBe(false);
      expect(all).toHaveLength(2);
    } finally {
      server.close();
    }
  });
});

// â”€â”€ the whole journey â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * The compositional test: a New candidate driven from an empty case to
 * competent, failing Part 4 once on the way.
 *
 * Covers AE3 (the failed attempt survives while the passing one becomes
 * authoritative) and AE2 (theory is computed from the answer key, not entered).
 */
describe('marker attribution (U15)', () => {
  async function openCase(base: string) {
    const tool = await seedTool(base);
    const res = await fetch(`${base}/assessment-cases`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ toolId: tool.id, candidateUserId: CANDIDATE, pathway: 'new' }),
    });
    return (await res.json()) as { id: string };
  }
  async function openPart(base: string, caseId: string, partKey: string) {
    return (await (
      await fetch(`${base}/assessment-cases/${caseId}/parts/${partKey}/attempts`, {
        method: 'POST',
        headers: auth(),
      })
    ).json()) as { id: string };
  }

  it('records an automatically marked part as marked by nobody, even given a name (R70)', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const c = await openCase(base);
      const a = await openPart(base, c.id, 'p1'); // p1 is fully keyed â†’ self-marking
      await fetch(`${base}/assessment-cases/${c.id}/attempts/${a.id}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ values: { q1: ['a'] } }),
      });
      const res = await fetch(`${base}/assessment-cases/${c.id}/attempts/${a.id}/outcome`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ assessorName: 'Should Be Ignored' }),
      });
      expect(res.status).toBe(200);
      const row = rows(store, 'assessmentPartAttempts').find((r) => r.id === a.id);
      expect(row?.outcome).toBe('satisfactory');
      expect(row?.markerKind).toBe('automatic');
      // Named by nobody â€” the submitted name is not stamped onto an automatic mark.
      expect(row?.assessorUserId).toBeNull();
      expect(row?.assessorName).toBe('');
    } finally {
      server.close();
    }
  });

  it('records a person-judged part as marked by that person, named (R70)', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const c = await openCase(base);
      // Pass the theory part so the practical unlocks.
      const p1 = await openPart(base, c.id, 'p1');
      await fetch(`${base}/assessment-cases/${c.id}/attempts/${p1.id}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ values: { q1: ['a'] } }),
      });
      await fetch(`${base}/assessment-cases/${c.id}/attempts/${p1.id}/outcome`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({}),
      });

      // p2 is a practical part carrying no key â†’ judged by a person.
      const p2 = await openPart(base, c.id, 'p2');
      const res = await fetch(`${base}/assessment-cases/${c.id}/attempts/${p2.id}/outcome`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ outcome: 'satisfactory', assessorName: 'Pat Assessor' }),
      });
      expect(res.status).toBe(200);
      const row = rows(store, 'assessmentPartAttempts').find((r) => r.id === p2.id);
      expect(row?.markerKind).toBe('person');
      expect(row?.assessorUserId).toBe(ADMIN);
      expect(row?.assessorName).toBe('Pat Assessor');
    } finally {
      server.close();
    }
  });
});

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

      // Part 1 â€” theory, answered correctly. Outcome is computed, not supplied.
      const t = await open('p1');
      await save(t.id, { q1: ['a'] });
      const theory = await resolve(t.id, {});
      expect(theory.outcome).toBe('satisfactory');

      // Part 2 â€” practical.
      const p2 = await open('p2');
      await resolve(p2.id, { outcome: 'satisfactory', assessorName: 'A. Assessor' });

      // Part 3 â€” logbook past its minimum.
      const p3 = await open('p3');
      await save(p3.id, { entries: [{ duration: 21 }] });
      await resolve(p3.id, { outcome: 'satisfactory' });

      // Part 4 â€” failed, then retried and passed.
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

      // Not terminal â€” a case waiting on a signature is not a finished one.
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
 * against real PDFs. These cover the ROUTE's gates â€” who may mint an evidence
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
 * A logbook is filled a shift at a time, so the save route must take partial
 * progress: a not-yet-valid row (zero, negative, blank, or still awaiting its
 * duration) is STORED and simply left out of the running total, never a reason
 * to reject the whole save. Refusing them here — as the route once did — is
 * what made "save progress" impossible on a half-filled log. Completeness is
 * the minimum-hours threshold's job at submit, not this route's. Hours still
 * count toward a safety threshold, so a duration column carrying a calc is
 * recomputed server-side and the client's figure for a derived cell discarded.
 */
describe('logbook progressive saving', () => {
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

  it('accepts a zero-duration row and simply leaves it out of the total', async () => {
    // Progressive saving is the whole point of a logbook filled a shift at a
    // time, so a not-yet-valid row must never reject the save. A zero rides
    // along on the record and counts for nothing, where it once 400'd the
    // entire save and made saving progress impossible.
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await logbookAttempt(base);

      const res = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ values: { 'log-table': [{ duration: 8 }, { duration: 0 }] } }),
      });

      expect(res.status).toBe(200);
      expect(((await res.json()) as { hours: number }).hours).toBe(8);
    } finally {
      server.close();
    }
  });

  it('accepts a negative duration without counting it', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await logbookAttempt(base);

      const res = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ values: { 'log-table': [{ duration: -4 }, { duration: 5 }] } }),
      });

      expect(res.status).toBe(200);
      expect(((await res.json()) as { hours: number }).hours).toBe(5);
    } finally {
      server.close();
    }
  });

  it('saves a blank row left ready for the next entry — the "cannot save progress" report', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await logbookAttempt(base);

      const res = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ values: { 'log-table': [{ duration: 8 }, {}] } }),
      });

      expect(res.status).toBe(200);
      expect(((await res.json()) as { hours: number }).hours).toBe(8);
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
 * An appeal is a NEW case linked to the disputed one â€” never an edit of it.
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
      // The disputed case is OWNED by the admin calling the appeal route (a
      // manual create naming an assessor keeps them â€” U13).
      const c = (await (
        await fetch(`${base}/assessment-cases`, {
          method: 'POST',
          headers: auth(),
          body: JSON.stringify({
            toolId: tool.id,
            candidateUserId: CANDIDATE,
            assessorUserId: ADMIN,
            pathway: 'experienced',
          }),
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
 * The fillable surface for one attempt â€” what the candidate portal renders.
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

      // The question itself must still be there â€” this is a fill surface.
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
      // Still open â€” an unmarked attempt has no outcome.
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
 * disagree, one of them is summarising something it no longer reflects â€” which
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
   * tool per template â€” a second one would be a fixture that cannot exist.
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
      // the save route just totalled â€” not a separately tracked figure.
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
    // multi-candidate lookup finds nothing â€” see the note at the top of this
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

      // Filtered in the query, not trimmed afterwards â€” the aggregate a
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
      // not call satisfactory â€” the same rule, computed once.
      expect(row?.currentPartKey).toBe(detail.parts.find((p) => p.state !== 'satisfactory')?.key);
    } finally {
      server.close();
    }
  });

  it('refuses a caller whose role grants no assessments view', async () => {
    const { db, store } = makeDb();
    // The caller is a genuine viewer, so requireTenant's role revalidation keeps
    // that role and the customised matrix below is what denies them.
    (store.memberships!.find((m) => (m as { userId: string }).userId === ADMIN) as { role: string }).role = 'viewer';
    // Every shipped role may view assessments, so the denial has to come from a
    // customised matrix â€” which is the real-world shape of it too: an org that
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
 * Signing a case off â€” the assessor's manual approval, and the last act of an
 * assessment.
 *
 * Marking the final part reaches `awaiting_sign_off`, never `competent`. The
 * gap matters because the printed record carries a name, a signature and a
 * date: certifying on the last mark would produce a document asserting that a
 * person judged someone safe to operate a dozer, with nobody's name on it.
 */
describe('POST /assessment-cases/:id/sign-off', () => {
  const SIG = 'data:image/png;base64,iVBORw0KGgo=';

  async function readyCase(base: string, toolId?: string) {
    const tool = toolId ? { id: toolId } : await seedTool(base);
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
    fail â€” it stringifies.

    It matters more than the two that were caught. Sign-off is the only place
    the person who ACTUALLY signs is checked: case creation checks whoever was
    named as assessor when it was opened, who need not be the same person. And
    these gaps are never written to the case, so this row is their only durable
    record â€” the HTTP response carries them too, but that is a toast.
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
          awardedCompetencyIds: [COMPETENCY],
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
    // The scenario is a sign-off-capable user who is ALSO the candidate on the
    // case. Give that user a genuine admin membership so requireTenant's role
    // revalidation keeps their authority and the route reaches the
    // self-certification refusal rather than a bare permission denial.
    (rows(store, 'memberships').find((m) => (m as { userId: string }).userId === CANDIDATE) as {
      role: string;
    }).role = 'admin';
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

  it('lets a qualified person certify their own case when the organisation allows it', async () => {
    /*
      Self-assessment is a real policy that differs between registered
      training setups — the org's switch, never inferred from role. The
      stricter default stays: the test above pins the refusal with the flag
      off, this one pins the allowance with it on.
    */
    const { db, store } = makeDb();
    (rows(store, 'memberships').find((m) => (m as { userId: string }).userId === CANDIDATE) as {
      role: string;
    }).role = 'admin';
    (rows(store, 'organizations')[0] as { allowSelfAssessment?: boolean }).allowSelfAssessment = true;
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const c = await readyCase(base);
      const res = await fetch(`${base}/assessment-cases/${c.id}/sign-off`, {
        method: 'POST',
        headers: auth({ userId: CANDIDATE, orgId: ORG, role: 'admin' }),
        body: JSON.stringify({ assessorName: 'Self Assessor', signature: SIG }),
      });

      expect(res.status).toBe(200);
      const row = rows(store, 'assessmentCases').find((r) => r.id === c.id);
      expect(row?.state).toBe('competent');
      expect(row?.signedOffName).toBe('Self Assessor');
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

  it('is idempotent â€” a double tap does not restamp the approval time', async () => {
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
      awaiting_sign_off â€” un-certifying someone who has been certified.
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
    must HOLD, but nothing naming what passing AWARDS â€” so a competent case
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
      // The PRE-round state: production tools created before U2 award nothing.
      // The API can no longer create one (exactly-one is enforced at create),
      // so the tool row is planted straight into the store.
      const unlinked = seedUnlinkedTool(store);
      const c = await readyCase(base, unlinked.id);
      await signOff(base, c.id, { assessorName: 'A. Assessor', signature: SIG });

      expect(rows(store, 'competencyHolders')).toHaveLength(0);
    } finally {
      server.close();
    }
  });
});

/**
 * A DECLARATION IS NOT AN ASSESSMENT. "I was told what this involves and I am
 * ready" is an attestation: nobody judges it, and signing it IS the act. It
 * completes at hand-in — with the one gate that matters checked first, because
 * an empty tap on Submit must not auto-satisfy an attestation with a blank
 * signature box.
 */
describe('declaration parts', () => {
  const DECL_MANIFEST: AssessmentToolManifest = {
    parts: [
      {
        key: 'pd',
        ordinal: 1,
        label: 'Candidate declaration',
        kind: 'declaration',
        pathways: ['experienced', 'new', 'rpl'],
        startFieldId: 'h-decl',
      },
      {
        key: 'p1',
        ordinal: 2,
        label: 'Part 1 Theory',
        kind: 'theory',
        pathways: ['experienced', 'new', 'rpl'],
        startFieldId: 'h-theory',
      },
    ],
  };

  async function openDeclaration(base: string) {
    const tool = await seedTool(base, DECL_MANIFEST);
    const caseRes = await fetch(`${base}/assessment-cases`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ toolId: tool.id, candidateUserId: CANDIDATE, pathway: 'new' }),
    });
    const kase = (await caseRes.json()) as { id: string };
    const attemptRes = await fetch(`${base}/assessment-cases/${kase.id}/parts/pd/attempts`, {
      method: 'POST',
      headers: auth(),
      body: '{}',
    });
    const attempt = (await attemptRes.json()) as { id: string };
    return { caseId: kase.id, attemptId: attempt.id };
  }

  const handIn = (base: string, caseId: string, attemptId: string) =>
    fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}/submit`, {
      method: 'POST',
      headers: auth(candidate),
      body: '{}',
    });

  it('refuses an unsigned hand-in, naming the empty boxes, and leaves the attempt open', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await openDeclaration(base);

      const res = await handIn(base, caseId, attemptId);

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; missing: { id: string }[] };
      expect(body.error).toBe('declaration_incomplete');
      expect(body.missing.some((m) => m.id === 'decl-sig')).toBe(true);

      // NOT stamped submitted — the gate ran before the write, so the
      // candidate signs and hands in again without anyone reopening anything.
      const save = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: auth(candidate),
        body: JSON.stringify({ values: { 'decl-sig': 'data:image/png;base64,iVBORw0KGgo=' } }),
      });
      expect(save.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('completes at hand-in once signed — satisfactory, automatically, no assessor', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await openDeclaration(base);
      await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: auth(candidate),
        body: JSON.stringify({ values: { 'decl-sig': 'data:image/png;base64,iVBORw0KGgo=' } }),
      });

      const res = await handIn(base, caseId, attemptId);

      expect(res.status).toBe(200);
      expect(((await res.json()) as { outcome?: string }).outcome).toBe('satisfactory');

      // The case view agrees: the declaration is satisfied and the theory part
      // is what remains — the attestation gates, it is never judged.
      const detail = await fetch(`${base}/assessment-cases/${caseId}`, { headers: auth() });
      const body = (await detail.json()) as {
        state: string;
        parts: { key: string; state: string }[];
      };
      expect(body.parts.find((p) => p.key === 'pd')?.state).toBe('satisfactory');
      expect(body.state).toBe('open');
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

      // Visible to the assessor without opening the attempt â€” that IS the
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
      // Otherwise "handed in" would mean nothing â€” the answers could keep
      // moving while the assessor was reading them. On this fully-keyed part
      // the hand-in also MARKED the attempt, so the refusal is the stronger
      // one: resolved, not merely parked.
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('attempt_resolved');
    } finally {
      server.close();
    }
  });

  /** Pass p1 (fully keyed) so the person-judged p2 unlocks. */
  async function passTheory(base: string, caseId: string, attemptId: string) {
    await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
      method: 'PATCH',
      headers: auth(candidate),
      body: JSON.stringify({ values: { q1: ['a'] } }),
    });
    const res = await submit(base, caseId, attemptId);
    expect(((await res.json()) as { outcome?: string }).outcome).toBe('satisfactory');
  }

  it('lets the candidate take a person-judged part back while it is still unmarked', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await openAttemptFor(base);
      await passTheory(base, caseId, attemptId);

      // The candidate opens the practical THEMSELVES â€” the sequence has
      // authorised it, and waiting for an assessor to press the button was the
      // turnstile this removes.
      const opened = await fetch(`${base}/assessment-cases/${caseId}/parts/p2/attempts`, {
        method: 'POST',
        headers: auth(candidate),
        body: '{}',
      });
      expect(opened.status).toBe(201);
      const practical = (await opened.json()) as { id: string };

      await submit(base, caseId, practical.id);
      // Nobody judges a practical at hand-in, so the take-back window is real.
      const res = await reopen(base, caseId, practical.id);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { submittedAt: string | null }).submittedAt).toBeNull();

      // ...and answering works again. Nothing was assessed, so nothing is lost.
      const save = await fetch(`${base}/assessment-cases/${caseId}/attempts/${practical.id}`, {
        method: 'PATCH',
        headers: auth(candidate),
        body: JSON.stringify({ values: {} }),
      });
      expect(save.status).toBe(200);
    } finally {
      server.close();
    }
  });

  /*
    HAND-IN IS THE MARKING MOMENT ON A FULLY-KEYED PART. The arithmetic needs
    no judgement, so making it wait for an assessor to visit was pure queue
    time â€” the candidate learns the result in the submit response, and
    everything sequenced behind the part unlocks the moment it is earned.
  */
  it('marks a fully-keyed part at hand-in and tells the candidate the result', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await openAttemptFor(base);
      await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: auth(candidate),
        body: JSON.stringify({ values: { q1: ['a'] } }),
      });

      const res = await submit(base, caseId, attemptId);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { outcome?: string; caseState?: string };
      expect(body.outcome).toBe('satisfactory');

      // The mark was made by nobody â€” automatic attribution, no name (U15).
      const row = rows(store, 'assessmentPartAttempts').find((a) => a.id === attemptId);
      expect(row?.outcome).toBe('satisfactory');
      expect(row?.markerKind).toBe('automatic');
    } finally {
      server.close();
    }
  });

  it('defaults a failed hand-in to coaching, and the candidate retries with their correct answers kept', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await openAttemptFor(base);
      // Mining stream chosen; the mandatory q1 wrong, the stream question right.
      await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: auth(candidate),
        body: JSON.stringify({ values: { 'stream-q': 'Mining', q1: ['b'], 'q-mining': ['a'] } }),
      });

      const res = await submit(base, caseId, attemptId);
      expect(((await res.json()) as { outcome?: string }).outcome).toBe('not_satisfactory');

      // The candidate opens their own retry â€” no assessor in the loop â€” and
      // the question they got RIGHT is already answered on it, while the one
      // they missed is blank.
      const retry = await fetch(`${base}/assessment-cases/${caseId}/parts/p1/attempts`, {
        method: 'POST',
        headers: auth(candidate),
        body: '{}',
      });
      expect(retry.status).toBe(201);
      const created = (await retry.json()) as { id: string; attemptNumber: number };
      expect(created.attemptNumber).toBe(2);

      const view = await fetch(`${base}/assessment-cases/${caseId}/attempts/${created.id}`, {
        headers: auth(candidate),
      });
      const values = ((await view.json()) as { values: Record<string, unknown> }).values;
      expect(values['q-mining']).toEqual(['a']);
      expect(values['q1']).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('refuses a candidate opening a part the workflow does not hand them', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base, {
        ...MANIFEST,
        workflow: {
          roles: ['candidate', 'assessor'],
          sections: [
            { key: 's1', ordinal: 1, label: 'Theory', partKey: 'p1', access: { candidate: 'fill', assessor: 'view' } },
            { key: 's2', ordinal: 2, label: 'Practical', partKey: 'p2', access: { candidate: 'view', assessor: 'fill' } },
          ],
        },
      });
      const caseRes = await fetch(`${base}/assessment-cases`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ toolId: tool.id, candidateUserId: CANDIDATE, pathway: 'new' }),
      });
      const kase = (await caseRes.json()) as { id: string };
      const attemptRes = await fetch(`${base}/assessment-cases/${kase.id}/parts/p1/attempts`, {
        method: 'POST',
        headers: auth(candidate),
        body: '{}',
      });
      const attempt = (await attemptRes.json()) as { id: string };
      await passTheory(base, kase.id, attempt.id);

      // p2 is unlocked, but the workflow says the ASSESSOR fills it â€” the
      // candidate opening it would put an empty row on someone else's step.
      const res = await fetch(`${base}/assessment-cases/${kase.id}/parts/p2/attempts`, {
        method: 'POST',
        headers: auth(candidate),
        body: '{}',
      });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  /*
    THE DECLARATION SHAPE (U-workflow): a workflow's `requires` replaces the
    printed sequence. Here p2 declares no dependencies at all, so it is open
    from the start â€” the candidate does not wait for p1 even though it prints
    first.
  */
  it('lets requires override the printed order for what opens when', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base, {
        ...MANIFEST,
        workflow: {
          roles: ['candidate', 'assessor'],
          sections: [
            { key: 's1', ordinal: 2, label: 'Theory', partKey: 'p1', access: { candidate: 'fill' } },
            { key: 's2', ordinal: 1, label: 'Methods', partKey: 'p2', access: { candidate: 'fill' }, requires: [] },
          ],
        },
      });
      const caseRes = await fetch(`${base}/assessment-cases`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ toolId: tool.id, candidateUserId: CANDIDATE, pathway: 'new' }),
      });
      const kase = (await caseRes.json()) as { id: string };

      const res = await fetch(`${base}/assessment-cases/${kase.id}/parts/p2/attempts`, {
        method: 'POST',
        headers: auth(candidate),
        body: '{}',
      });
      expect(res.status).toBe(201);
    } finally {
      server.close();
    }
  });

  it('refuses to submit another candidateâ€™s attempt, as not found', async () => {
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

  it('is idempotent â€” submitting twice keeps the first hand-in time', async () => {
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
 * a UUID in the name makes a document nobody can identify later â€” and the one
 * place it matters is an audit, months after the fact.
 */
describe('GET /assessment-cases/:id â€” candidate name', () => {
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
    // A deleted account must not make an existing case unreadable â€” the case is
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
  own theory attempt and post the practical's observation checklist â€” the
  criteria their assessor is meant to mark while watching them operate the
  machine â€” and it would be stored against the case and merged into the
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
      already carrying a stray key â€” and real data does, under keys the manifest
      never named.
    */
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const { caseId, attempt } = await openAttempt(base);
      // Nothing stored under it, and nothing sent for it either â€” an echo of
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
  stop them writing THIS part's â€” which is the case the customer described: the
  candidate fills nothing in a practical, but the practical is one part and its
  fields are all in it.

  The caller here IS the candidate (ADMIN opens the case, so these use a case
  whose candidate is the caller) â€” that is what makes the party resolution the
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
        awardedCompetencyIds: [COMPETENCY],
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
      // Visible â€” a candidate reads the standard they are held toâ€¦
      expect(body.fields.some((f) => f.id === 'q1')).toBe(true);
      // â€¦and cannot mark themselves against it.
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

describe('the pooled queue and unowned cases (U13)', () => {
  const POOL_TOOL = '00000000-0000-4000-8000-0000000000c1';
  const POOL_CASE = '00000000-0000-4000-8000-0000000000c2';
  const ADMIN2 = '00000000-0000-4000-8000-0000000000bc';
  const admin2 = { userId: ADMIN2, orgId: ORG, role: 'admin' as const };

  function seedPooled(store: ReturnType<typeof makeDb>['store'], over: Record<string, unknown> = {}) {
    rows(store, 'assessmentTools').push({
      id: POOL_TOOL,
      orgId: ORG,
      templateId: TEMPLATE,
      name: 'Track Dozer',
      manifest: MANIFEST,
      assessorCompetencyIds: [COMPETENCY],
      assessorStreamCompetencyIds: {},
      candidatePrerequisiteIds: [],
      awardedCompetencyIds: [],
      locationPartKeys: {},
      departmentId: null,
    });
    rows(store, 'assessmentCases').push({
      id: POOL_CASE,
      orgId: ORG,
      toolId: POOL_TOOL,
      candidateUserId: CANDIDATE,
      assessorUserId: null,
      state: 'open',
      locationId: null,
      pathway: 'new',
      currentVersionId: VERSION,
      createdAt: new Date(),
      prerequisiteWarnings: [],
      ...over,
    });
  }
  function holdCompetency(store: ReturnType<typeof makeDb>['store'], userId: string) {
    rows(store, 'competencyHolders').push({
      competencyId: COMPETENCY,
      userId,
      orgId: ORG,
      grantedAt: new Date('2025-01-01'),
      expiresAt: null,
      revokedAt: null,
    });
  }
  const detail = async (base: string, id: string) =>
    (await (await fetch(`${base}/assessment-cases/${id}`, { headers: auth() })).json()) as {
      assessorUserId: string | null;
    };
  const queue = async (base: string, session = admin) =>
    (await (await fetch(`${base}/assessment-cases/queue`, { headers: auth(session) })).json()) as Array<{
      id: string;
      overdue: boolean;
    }>;

  it('a manual create with no assessor lands unowned; naming one keeps it (R61)', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      const pooled = (await (
        await fetch(`${base}/assessment-cases`, {
          method: 'POST',
          headers: auth(),
          body: JSON.stringify({ toolId: tool.id, candidateUserId: CANDIDATE, pathway: 'new' }),
        })
      ).json()) as { id: string };
      const owned = (await (
        await fetch(`${base}/assessment-cases`, {
          method: 'POST',
          headers: auth(),
          body: JSON.stringify({
            toolId: tool.id,
            candidateUserId: OTHER_CANDIDATE,
            assessorUserId: ADMIN,
            pathway: 'new',
          }),
        })
      ).json()) as { id: string };

      expect((await detail(base, pooled.id)).assessorUserId).toBeNull();
      expect((await detail(base, owned.id)).assessorUserId).toBe(ADMIN);
    } finally {
      server.close();
    }
  });

  it('returns a pooled case to an eligible assessor, and not to an ineligible one (R62, R64)', async () => {
    const { db, store } = makeDb();
    seedPooled(store);
    holdCompetency(store, ADMIN); // ADMIN holds the tool's assessor competency
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      // ADMIN is eligible; ADMIN2 (holds nothing) is not.
      expect((await queue(base)).map((c) => c.id)).toContain(POOL_CASE);
      expect(await queue(base, admin2)).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('refuses the queue to a candidate', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/assessment-cases/queue`, { headers: auth(candidate) });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('reads a pooled case older than the threshold as overdue, re-dating when it changes (R63)', async () => {
    const { db, store } = makeDb();
    seedPooled(store, { createdAt: new Date(Date.now() - 30 * 86_400_000) }); // 30 days old
    holdCompetency(store, ADMIN);
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      // Default threshold is 14 â†’ overdue.
      expect((await queue(base)).find((c) => c.id === POOL_CASE)?.overdue).toBe(true);
      // Raise the threshold past its age â†’ no longer overdue, with no case write.
      (rows(store, 'organizations')[0] as { pooledCaseOverdueDays?: number }).pooledCaseOverdueDays = 60;
      expect((await queue(base)).find((c) => c.id === POOL_CASE)?.overdue).toBe(false);
    } finally {
      server.close();
    }
  });

  it('excludes from an appeal whoever recorded a part on the pooled case (R61, R62)', async () => {
    const { db, store } = makeDb();
    seedPooled(store);
    // ADMIN recorded a part on the pooled case â€” so ADMIN is not independent.
    rows(store, 'assessmentPartAttempts').push({
      id: '00000000-0000-4000-8000-0000000000c9',
      orgId: ORG,
      caseId: POOL_CASE,
      partKey: 'p1',
      attemptNumber: 1,
      templateVersionId: VERSION,
      assessorUserId: ADMIN,
      markerKind: 'person',
      outcome: 'satisfactory',
      values: {},
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      // ADMIN cannot INITIATE (they marked a part).
      const asInitiator = await fetch(`${base}/assessment-cases/${POOL_CASE}/appeal`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ assessorUserId: ADMIN2, reason: 'Disputed' }),
      });
      expect(asInitiator.status).toBe(409);
      expect(((await asInitiator.json()) as { error: string }).error).toBe('appeal_conflict');

      // Naming ADMIN (who marked) as the independent assessor is refused too.
      const asAssessor = await fetch(`${base}/assessment-cases/${POOL_CASE}/appeal`, {
        method: 'POST',
        headers: auth(admin2),
        body: JSON.stringify({ assessorUserId: ADMIN, reason: 'Disputed' }),
      });
      expect(asAssessor.status).toBe(409);
      expect(((await asAssessor.json()) as { error: string }).error).toBe('appeal_assessor_not_independent');
    } finally {
      server.close();
    }
  });
});

describe('assessor eligibility warned at marking (U14)', () => {
  async function toolWithAssessorReq(base: string) {
    const res = await fetch(`${base}/assessment-tools`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        templateId: TEMPLATE,
        name: 'Track Dozer',
        manifest: MANIFEST,
        assessorCompetencyIds: [COMPETENCY],
        awardedCompetencyIds: [COMPETENCY],
      }),
    });
    return (await res.json()) as { id: string };
  }
  async function openCaseFor(base: string, toolId: string) {
    return (await (
      await fetch(`${base}/assessment-cases`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ toolId, candidateUserId: CANDIDATE, pathway: 'new' }),
      })
    ).json()) as { id: string };
  }
  async function openPart(base: string, caseId: string, partKey: string) {
    return (await (
      await fetch(`${base}/assessment-cases/${caseId}/parts/${partKey}/attempts`, {
        method: 'POST',
        headers: auth(),
      })
    ).json()) as { id: string };
  }
  async function passP1(base: string, caseId: string) {
    const p1 = await openPart(base, caseId, 'p1');
    await fetch(`${base}/assessment-cases/${caseId}/attempts/${p1.id}`, {
      method: 'PATCH',
      headers: auth(),
      body: JSON.stringify({ values: { q1: ['a'] } }),
    });
    await fetch(`${base}/assessment-cases/${caseId}/attempts/${p1.id}/outcome`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({}),
    });
  }

  it('records a warning naming what the marker is missing, and the mark still stands (R65)', async () => {
    const { db, store } = makeDb(); // ADMIN holds no competency
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = await toolWithAssessorReq(base);
      const c = await openCaseFor(base, tool.id);
      await passP1(base, c.id);
      const p2 = await openPart(base, c.id, 'p2');
      const res = await fetch(`${base}/assessment-cases/${c.id}/attempts/${p2.id}/outcome`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ outcome: 'satisfactory', assessorName: 'Pat' }),
      });
      expect(res.status).toBe(200);
      const row = rows(store, 'assessmentPartAttempts').find((r) => r.id === p2.id);
      expect(row?.outcome).toBe('satisfactory'); // the mark stands
      expect((row?.markingEligibilityWarnings as string[]).join('\n')).toContain(COMPETENCY);
    } finally {
      server.close();
    }
  });

  it('records no warning when the marker holds the assessor competency', async () => {
    const { db, store } = makeDb();
    rows(store, 'competencyHolders').push({
      competencyId: COMPETENCY,
      userId: ADMIN,
      orgId: ORG,
      grantedAt: new Date('2025-01-01'),
      expiresAt: null,
      revokedAt: null,
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = await toolWithAssessorReq(base);
      const c = await openCaseFor(base, tool.id);
      await passP1(base, c.id);
      const p2 = await openPart(base, c.id, 'p2');
      await fetch(`${base}/assessment-cases/${c.id}/attempts/${p2.id}/outcome`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ outcome: 'satisfactory', assessorName: 'Pat' }),
      });
      const row = rows(store, 'assessmentPartAttempts').find((r) => r.id === p2.id);
      expect(row?.markingEligibilityWarnings).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('records no eligibility warning on an automatically marked part (R65)', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = await toolWithAssessorReq(base);
      const c = await openCaseFor(base, tool.id);
      const p1 = await openPart(base, c.id, 'p1');
      await fetch(`${base}/assessment-cases/${c.id}/attempts/${p1.id}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ values: { q1: ['a'] } }),
      });
      await fetch(`${base}/assessment-cases/${c.id}/attempts/${p1.id}/outcome`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({}),
      });
      const row = rows(store, 'assessmentPartAttempts').find((r) => r.id === p1.id);
      expect(row?.markerKind).toBe('automatic');
      expect(row?.markingEligibilityWarnings).toEqual([]);
    } finally {
      server.close();
    }
  });
});

describe('appeal independence covers the sign-off assessor (U13 review fix)', () => {
  const POOL_TOOL = '00000000-0000-4000-8000-0000000000d1';
  const POOL_CASE = '00000000-0000-4000-8000-0000000000d2';
  const OTHER_ADMIN = '00000000-0000-4000-8000-0000000000da';

  it('refuses the assessor who signed off a self-marked pooled case as appeal initiator', async () => {
    const { db, store } = makeDb();
    rows(store, 'assessmentTools').push({
      id: POOL_TOOL,
      orgId: ORG,
      templateId: TEMPLATE,
      name: 'Track Dozer',
      manifest: MANIFEST,
      assessorCompetencyIds: [],
      assessorStreamCompetencyIds: {},
      candidatePrerequisiteIds: [],
      awardedCompetencyIds: [],
      locationPartKeys: {},
      departmentId: null,
    });
    // Pooled (no named assessor), self-marked (no person attempts), but SIGNED
    // OFF by ADMIN â€” who is therefore not independent of it.
    rows(store, 'assessmentCases').push({
      id: POOL_CASE,
      orgId: ORG,
      toolId: POOL_TOOL,
      candidateUserId: CANDIDATE,
      assessorUserId: null,
      signedOffByUserId: ADMIN,
      state: 'competent',
      locationId: null,
      pathway: 'new',
      currentVersionId: VERSION,
      createdAt: new Date(),
      prerequisiteWarnings: [],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/assessment-cases/${POOL_CASE}/appeal`, {
        method: 'POST',
        headers: auth(), // ADMIN, who signed it off
        body: JSON.stringify({ assessorUserId: OTHER_ADMIN, reason: 'Disputed' }),
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('appeal_conflict');
    } finally {
      server.close();
    }
  });
});

// â”€â”€ republishing a revision â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('POST /assessment-tools/:id/republish', () => {
  const DRAFT_VERSION = '00000000-0000-4000-8000-000000000003';

  function seedDraftVersion(
    store: Record<string, Record<string, unknown>[]>,
    fields: FormField[] = FIELDS,
  ) {
    rows(store, 'formTemplateVersions').push({
      id: DRAFT_VERSION,
      templateId: TEMPLATE,
      fields,
      state: 'draft',
      versionLabel: 'v2',
    });
  }

  function republishBodyFor(over: Record<string, unknown> = {}) {
    return JSON.stringify({
      versionId: DRAFT_VERSION,
      seededFromVersionId: VERSION,
      fields: FIELDS,
      manifest: MANIFEST,
      ...over,
    });
  }

  it('publishes the draft version and updates the tool in one call', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      // Admin config the create path zeroes, set after creation â€” a revision
      // must not reset it.
      Object.assign(rows(store, 'assessmentTools')[0]!, {
        departmentId: DEPT_OPS,
        locationPartKeys: { [MINING]: ['p1'] },
      });
      // The revision draft whose slot the republish frees.
      rows(store, 'assessmentToolDrafts').push({
        id: '00000000-0000-4000-8000-0000000000dd',
        orgId: ORG,
        name: 'Track Dozer - v2',
        revisionOfToolId: tool.id,
      });
      seedDraftVersion(store);

      const res = await fetch(`${base}/assessment-tools/${tool.id}/republish`, {
        method: 'POST',
        headers: auth(),
        body: republishBodyFor({
          manifest: { ...MANIFEST, candidateNameFieldId: 'q-mining' },
          revisionIdentity: { code: 'Rev 3', reviewedOn: '08/2026', note: 'Annual review' },
        }),
      });

      expect(res.status).toBe(200);
      const version = rows(store, 'formTemplateVersions').find((v) => v.id === DRAFT_VERSION)!;
      expect(version.state).toBe('published');
      expect((version.revisionIdentity as { code?: string }).code).toBe('Rev 3');
      const template = rows(store, 'formTemplates')[0]!;
      expect(template.currentVersionId).toBe(DRAFT_VERSION);
      const toolRow = rows(store, 'assessmentTools')[0]!;
      // Manifest replaced, admin config preserved.
      expect((toolRow.manifest as { candidateNameFieldId?: string }).candidateNameFieldId).toBe('q-mining');
      expect(toolRow.departmentId).toBe(DEPT_OPS);
      expect(toolRow.locationPartKeys).toEqual({ [MINING]: ['p1'] });
      // The one-revision-per-tool slot is freed.
      expect(rows(store, 'assessmentToolDrafts')).toHaveLength(0);
    } finally {
      server.close();
    }
  });

  it('AE3: an open case keeps its pinned version; only the template pointer moves', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      seedDraftVersion(store);
      rows(store, 'assessmentCases').push({
        id: '00000000-0000-4000-8000-0000000000c1',
        orgId: ORG,
        toolId: tool.id,
        candidateUserId: CANDIDATE,
        currentVersionId: VERSION,
        state: 'open',
        pathway: 'new',
      });

      const res = await fetch(`${base}/assessment-tools/${tool.id}/republish`, {
        method: 'POST',
        headers: auth(),
        body: republishBodyFor(),
      });

      expect(res.status).toBe(200);
      const openCase = rows(store, 'assessmentCases')[0]!;
      expect(openCase.currentVersionId).toBe(VERSION);
      expect(rows(store, 'formTemplates')[0]!.currentVersionId).toBe(DRAFT_VERSION);
    } finally {
      server.close();
    }
  });

  it('refuses stale_revision when somebody published after the revision was seeded', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      seedDraftVersion(store);

      const res = await fetch(`${base}/assessment-tools/${tool.id}/republish`, {
        method: 'POST',
        headers: auth(),
        // Seeded from a version that is no longer current.
        body: republishBodyFor({ seededFromVersionId: DRAFT_VERSION }),
      });

      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('stale_revision');
      expect(rows(store, 'formTemplateVersions').find((v) => v.id === DRAFT_VERSION)!.state).toBe('draft');
      expect(rows(store, 'formTemplates')[0]!.currentVersionId).toBe(VERSION);
    } finally {
      server.close();
    }
  });

  it('R16: refuses open_cases_incompatible naming the case a new manifest would dangle against', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      // The revised document adds a section, and the new manifest anchors a
      // part to it â€” valid against the draft version, dangling against the
      // open case pinned to the old one.
      const revisedFields = [...FIELDS, header('h-new')];
      seedDraftVersion(store, revisedFields);
      const caseId = '00000000-0000-4000-8000-0000000000c2';
      rows(store, 'assessmentCases').push({
        id: caseId,
        orgId: ORG,
        toolId: tool.id,
        candidateUserId: CANDIDATE,
        currentVersionId: VERSION,
        state: 'open',
        pathway: 'new',
      });
      const newManifest = {
        ...MANIFEST,
        parts: [
          ...MANIFEST.parts,
          {
            key: 'p5',
            ordinal: 5,
            label: 'Part 5 New',
            kind: 'practical',
            pathways: ['new'],
            startFieldId: 'h-new',
          },
        ],
      };

      const res = await fetch(`${base}/assessment-tools/${tool.id}/republish`, {
        method: 'POST',
        headers: auth(),
        body: republishBodyFor({ fields: revisedFields, manifest: newManifest }),
      });

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; cases: Array<{ id: string }> };
      expect(body.error).toBe('open_cases_incompatible');
      expect(body.cases.map((c) => c.id)).toEqual([caseId]);
      expect(rows(store, 'formTemplateVersions').find((v) => v.id === DRAFT_VERSION)!.state).toBe('draft');
    } finally {
      server.close();
    }
  });

  it('400s a manifest that orphans a Location parts rule, naming the part', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      Object.assign(rows(store, 'assessmentTools')[0]!, {
        locationPartKeys: { [MINING]: ['p4'] },
      });
      seedDraftVersion(store);
      // A revised manifest that drops p4 while the Mining rule still names it.
      const trimmed = { ...MANIFEST, parts: MANIFEST.parts.slice(0, 3) };

      const res = await fetch(`${base}/assessment-tools/${tool.id}/republish`, {
        method: 'POST',
        headers: auth(),
        body: republishBodyFor({ manifest: trimmed }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; problems: string[] };
      expect(body.error).toBe('invalid_manifest');
      /*
        In PEOPLE'S TERMS — the Location's NAME and the part's printed LABEL,
        never the rule's UUID or the internal part key. "Rule 764679d8…
        requires secnew2" is what an author actually saw, and it told them
        nothing they could act on.
      */
      const joined = body.problems.join(' ');
      expect(joined).toContain('Mining');
      expect(joined).toContain('Part 4 Practical');
      expect(joined).toContain('Where each part applies');
    } finally {
      server.close();
    }
  });

  it('trims dangling Location rules with the publish when the author opts in', async () => {
    /*
      The refusal's one-click fix: the untick is the AUTHOR'S explicit
      choice (the flag), applied in the same transaction as the publish —
      never defaulted, because silently changing what a Location requires is
      a policy edit nobody made.
    */
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      Object.assign(rows(store, 'assessmentTools')[0]!, {
        locationPartKeys: { [MINING]: ['p4', 'p1'] },
      });
      seedDraftVersion(store);
      const trimmed = { ...MANIFEST, parts: MANIFEST.parts.slice(0, 3) };

      const res = await fetch(`${base}/assessment-tools/${tool.id}/republish`, {
        method: 'POST',
        headers: auth(),
        body: republishBodyFor({ manifest: trimmed, dropDanglingLocationRules: true }),
      });

      expect(res.status).toBe(200);
      // The rule kept p1 (still declared) and lost only the removed p4.
      const row = rows(store, 'assessmentTools')[0] as { locationPartKeys: Record<string, string[]> };
      expect(row.locationPartKeys[MINING]).toEqual(['p1']);
    } finally {
      server.close();
    }
  });

  /** A case with an attempt on p1, for the removed-part guards. */
  async function attemptedCase(base: string) {
    const caseRes = await fetch(`${base}/assessment-cases`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ toolId: (await seedTool(base)).id, candidateUserId: CANDIDATE, pathway: 'experienced' }),
    });
    const kase = (await caseRes.json()) as { id: string };
    await fetch(`${base}/assessment-cases/${kase.id}/parts/p1/attempts`, {
      method: 'POST',
      headers: auth(),
      body: '{}',
    });
    return kase;
  }

  it('400s a revision that removes a part with evidence on a COMPLETED case', async () => {
    /*
      The export selects attempts by the manifest's part keys and fails loud
      on an attempt whose part the manifest no longer declares — so dropping
      a certified part would leave that evidence unable to print, discovered
      months later by an auditor.
    */
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const kase = await attemptedCase(base);
      Object.assign(
        rows(store, 'assessmentCases').find((r) => r.id === kase.id)!,
        { state: 'competent' },
      );
      seedDraftVersion(store);
      const trimmed = { ...MANIFEST, parts: MANIFEST.parts.slice(1) };

      const res = await fetch(`${base}/assessment-tools/${(rows(store, 'assessmentTools')[0] as { id: string }).id}/republish`, {
        method: 'POST',
        headers: auth(),
        body: republishBodyFor({ manifest: trimmed }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; problems: string[] };
      expect(body.error).toBe('invalid_manifest');
      expect(body.problems.join(' ')).toContain('evidence on completed cases');
      expect(body.problems.join(' ')).toContain('Part 1 Theory');
    } finally {
      server.close();
    }
  });

  it('publishes over an OPEN case attempt on a removed part, warning about the progress', async () => {
    /*
      A consolidation — the part's fields folded into a neighbouring section,
      still printed, still filled — is a legitimate revision. An open case's
      progress is the author's to spend, and blocking on it would freeze
      every tool the moment a live test case touched a part being merged.
    */
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      await attemptedCase(base);
      seedDraftVersion(store);
      const trimmed = { ...MANIFEST, parts: MANIFEST.parts.slice(1) };

      const res = await fetch(`${base}/assessment-tools/${(rows(store, 'assessmentTools')[0] as { id: string }).id}/republish`, {
        method: 'POST',
        headers: auth(),
        body: republishBodyFor({ manifest: trimmed }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { warnings: string[] };
      expect(body.warnings.join(' ')).toContain('Open cases have attempts on "Part 1 Theory"');
    } finally {
      server.close();
    }
  });

  it('rolls back the version publish when the tool update fails', async () => {
    const { db, store } = makeDb({ failToolUpdate: true });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      // Seed the tool row directly - seedTool would also hit the forced failure.
      rows(store, 'assessmentTools').push({
        id: '00000000-0000-4000-8000-0000000000e1',
        orgId: ORG,
        templateId: TEMPLATE,
        name: 'Track Dozer',
        manifest: MANIFEST,
        locationPartKeys: {},
      });
      const toolId = rows(store, 'assessmentTools')[0]!.id as string;
      rows(store, 'assessmentToolDrafts').push({
        id: '00000000-0000-4000-8000-0000000000de',
        orgId: ORG,
        name: 'Track Dozer - v2',
        revisionOfToolId: toolId,
      });
      seedDraftVersion(store);

      const res = await fetch(`${base}/assessment-tools/${toolId}/republish`, {
        method: 'POST',
        headers: auth(),
        body: republishBodyFor(),
      });

      expect(res.status).toBe(500);
      // Nothing partially applied: version still draft, pointer unmoved,
      // revision draft still occupying its slot.
      expect(rows(store, 'formTemplateVersions').find((v) => v.id === DRAFT_VERSION)!.state).toBe('draft');
      expect(rows(store, 'formTemplates')[0]!.currentVersionId).toBe(VERSION);
      expect(rows(store, 'assessmentToolDrafts')).toHaveLength(1);
    } finally {
      server.close();
    }
  });

  it('refuses an already-published version and a version of another template', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      seedDraftVersion(store);

      Object.assign(rows(store, 'formTemplateVersions').find((v) => v.id === VERSION)!, { state: 'published' });
      const published = await fetch(`${base}/assessment-tools/${tool.id}/republish`, {
        method: 'POST',
        headers: auth(),
        body: republishBodyFor({ versionId: VERSION }),
      });
      expect(published.status).toBe(409);
      expect(((await published.json()) as { error: string }).error).toBe('version_already_published');

      const foreign = await fetch(`${base}/assessment-tools/${tool.id}/republish`, {
        method: 'POST',
        headers: auth(),
        body: republishBodyFor({ versionId: '00000000-0000-4000-8000-0000000000ff' }),
      });
      expect(foreign.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('403s a role that cannot author, and caps identity field lengths', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      seedDraftVersion(store);

      const denied = await fetch(`${base}/assessment-tools/${tool.id}/republish`, {
        method: 'POST',
        headers: auth(candidate),
        body: republishBodyFor(),
      });
      expect(denied.status).toBe(403);

      const oversized = await fetch(`${base}/assessment-tools/${tool.id}/republish`, {
        method: 'POST',
        headers: auth(),
        body: republishBodyFor({ revisionIdentity: { note: 'x'.repeat(2001) } }),
      });
      expect(oversized.status).toBe(400);
      expect(((await oversized.json()) as { error: string }).error).toBe('invalid_request');
    } finally {
      server.close();
    }
  });
});

/*
  ── Mixed marking and the assessor's marking pass (U3/U4) ────────────────────

  The Tip Head Controller shape: one theory part carrying KEYED choice
  questions (the machine's) beside UNKEYED written questions with model
  answers (the assessor's), every question with a printed ✓/✗ box. The tool
  ships the workflow the builder emits for it: keyed cells locked `auto`,
  written questions' cells assessor-fillable with the candidate on view, the
  part's verdict radio locked `auto` — which is exactly the #269 configuration
  that must NOT auto-fire when written questions are present.
*/
const MIX_TEMPLATE = '00000000-0000-4000-8000-0000000000e1';
const MIX_VERSION = '00000000-0000-4000-8000-0000000000e2';
const MODEL_W1 = 'Stop tipping, chock the wheels and report to the supervisor.';

const MIX_FIELDS: FormField[] = [
  header('h-mix'),
  {
    id: 'q-k1',
    type: 'radio',
    label: 'Q1 keyed',
    required: true,
    source: 'imported',
    options: ['a', 'b'],
    answerKey: ['a'],
    outcomeTarget: { fieldId: 'q-k1-out' },
  },
  { id: 'q-k1-out', type: 'check_cross', label: 'Q1 outcome', required: false, source: 'imported' },
  {
    id: 'q-k2',
    type: 'checkbox_group',
    label: 'Q2 keyed',
    required: true,
    source: 'imported',
    options: ['a', 'b'],
    answerKey: ['a'],
    outcomeTarget: { fieldId: 'q-k2-out' },
  },
  { id: 'q-k2-out', type: 'check_cross', label: 'Q2 outcome', required: false, source: 'imported' },
  {
    id: 'q-w1',
    type: 'textarea',
    label: 'Q3 written',
    required: true,
    source: 'imported',
    modelAnswer: MODEL_W1,
    outcomeTarget: { fieldId: 'q-w1-out' },
  },
  { id: 'q-w1-out', type: 'check_cross', label: 'Q3 outcome', required: false, source: 'imported' },
  // A written question with a target but NO model answer — legal furniture,
  // and the guide must not carry an empty entry for it.
  {
    id: 'q-w2',
    type: 'text',
    label: 'Q4 written',
    required: false,
    source: 'imported',
    outcomeTarget: { fieldId: 'q-w2-out' },
  },
  { id: 'q-w2-out', type: 'check_cross', label: 'Q4 outcome', required: false, source: 'imported' },
  {
    id: 'mix-verdict',
    type: 'radio',
    label: 'The Candidate’s responses were',
    required: false,
    source: 'imported',
    options: ['Satisfactory', 'Not Satisfactory'],
  },
  { id: 'mix-assessor-name', type: 'text', label: 'Name of Assessor', required: false, source: 'imported' },
  { id: 'mix-signed-date', type: 'date', label: 'Date', required: false, source: 'imported' },
];

const MIX_MANIFEST: AssessmentToolManifest = {
  parts: [
    {
      key: 'm1',
      ordinal: 1,
      label: 'Mixed Theory',
      kind: 'theory',
      pathways: ['experienced', 'new', 'rpl'],
      startFieldId: 'h-mix',
      assessorNameFieldId: 'mix-assessor-name',
      signedDateFieldId: 'mix-signed-date',
    },
  ],
  workflow: {
    roles: ['candidate', 'assessor'],
    sections: [
      {
        key: 'm1',
        ordinal: 1,
        label: 'Mixed Theory',
        partKey: 'm1',
        access: { candidate: 'fill', assessor: 'fill' },
        // What the builder emits: keyed cells and the verdict radio are the
        // system's; the written questions' cells stay `entry` for the assessor.
        fieldSource: { 'q-k1-out': 'auto', 'q-k2-out': 'auto', 'mix-verdict': 'auto' },
        fieldAccess: { 'q-w1-out': { candidate: 'view' }, 'q-w2-out': { candidate: 'view' } },
      },
    ],
  },
};

/** Seed the mixed template + tool, open a case and an m1 attempt. */
async function mixedCase(
  base: string,
  store: Record<string, Record<string, unknown>[]>,
  candidateUserId: string = CANDIDATE,
) {
  rows(store, 'formTemplates').push({
    id: MIX_TEMPLATE,
    orgId: ORG,
    name: 'Tip Head Controller',
    currentVersionId: MIX_VERSION,
  });
  rows(store, 'formTemplateVersions').push({ id: MIX_VERSION, templateId: MIX_TEMPLATE, fields: MIX_FIELDS });
  const created = await fetch(`${base}/assessment-tools`, {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({
      templateId: MIX_TEMPLATE,
      name: 'Tip Head Controller',
      manifest: MIX_MANIFEST,
      awardedCompetencyIds: [COMPETENCY],
    }),
  });
  expect(created.status).toBe(201);
  const tool = (await created.json()) as { id: string };
  const caseRes = await fetch(`${base}/assessment-cases`, {
    method: 'POST',
    headers: auth(),
    body: JSON.stringify({ toolId: tool.id, candidateUserId, pathway: 'new' }),
  });
  expect(caseRes.status).toBe(201);
  const kase = (await caseRes.json()) as { id: string };
  const attemptRes = await fetch(`${base}/assessment-cases/${kase.id}/parts/m1/attempts`, {
    method: 'POST',
    headers: auth(),
  });
  expect(attemptRes.status).toBe(201);
  return { caseId: kase.id, attemptId: ((await attemptRes.json()) as { id: string }).id, toolId: tool.id };
}

describe('mixed marking: a judged part pre-marks its keyed subset (U3)', () => {
  it('stores the keyed ✓/✗ at outcome time, with anything a person recorded winning', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await mixedCase(base, store);
      // Candidate answers: q-k1 right, q-k2 wrong, prose for the written ones.
      await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: auth(candidate),
        body: JSON.stringify({ values: { 'q-k1': 'a', 'q-k2': ['b'], 'q-w1': 'Chock and report.' } }),
      });
      // The assessor ticks the written question's box by hand.
      await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ values: { 'q-w1-out': true } }),
      });
      // A legacy stored tick at a keyed cell (recorded before these locked):
      // the machine disagrees — q-k2 is wrong — but the person's mark stands.
      const row = rows(store, 'assessmentPartAttempts').find((r) => r.id === attemptId)!;
      row.values = { ...(row.values as Record<string, unknown>), 'q-k2-out': true };

      const res = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}/outcome`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ outcome: 'satisfactory', assessorName: 'Pat Assessor' }),
      });
      expect(res.status).toBe(200);

      const values = row.values as Record<string, unknown>;
      // The machine's pre-mark fills the silent keyed cell…
      expect(values['q-k1-out']).toBe(true);
      // …and never rewrites the one a person recorded.
      expect(values['q-k2-out']).toBe(true);
      // The written questions' cells stay exactly the person's.
      expect(values['q-w1-out']).toBe(true);
      expect(values['q-w2-out']).toBeUndefined();
      // Marker attribution stays PERSON — the machine marked four cells, not
      // the part.
      expect(row.outcome).toBe('satisfactory');
      expect(row.markerKind).toBe('person');
      expect(row.assessorName).toBe('Pat Assessor');
    } finally {
      server.close();
    }
  });

  it('the #269 pin: written questions keep the auto-locked verdict radio empty — the outcome demands the assessor', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await mixedCase(base, store);
      await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: auth(candidate),
        body: JSON.stringify({ values: { 'q-k1': 'a', 'q-k2': ['a'], 'q-w1': 'All correct prose.' } }),
      });
      const submit = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}/submit`, {
        method: 'POST',
        headers: auth(candidate),
      });
      expect(submit.status).toBe(200);
      // Hand-in parks the attempt for marking: no outcome, no verdict write —
      // even though every KEYED answer is correct, the written ones aren't
      // the machine's to judge.
      expect('outcome' in ((await submit.json()) as Record<string, unknown>)).toBe(false);
      const row = rows(store, 'assessmentPartAttempts').find((r) => r.id === attemptId)!;
      expect(row.outcome).toBeNull();
      expect((row.values as Record<string, unknown>)['mix-verdict']).toBeUndefined();

      // And the outcome route refuses to invent one.
      const res = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}/outcome`, {
        method: 'POST',
        headers: auth(),
        body: '{}',
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('outcome_required');
    } finally {
      server.close();
    }
  });

  it('regression: a fully keyed part still marks itself at hand-in', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      const caseRes = await fetch(`${base}/assessment-cases`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ toolId: tool.id, candidateUserId: CANDIDATE, pathway: 'new' }),
      });
      const kase = (await caseRes.json()) as { id: string };
      const attemptRes = await fetch(`${base}/assessment-cases/${kase.id}/parts/p1/attempts`, {
        method: 'POST',
        headers: auth(),
      });
      const attempt = (await attemptRes.json()) as { id: string };
      await fetch(`${base}/assessment-cases/${kase.id}/attempts/${attempt.id}`, {
        method: 'PATCH',
        headers: auth(candidate),
        body: JSON.stringify({ values: { q1: ['a'] } }),
      });
      const submit = await fetch(`${base}/assessment-cases/${kase.id}/attempts/${attempt.id}/submit`, {
        method: 'POST',
        headers: auth(candidate),
      });
      expect(submit.status).toBe(200);
      expect(((await submit.json()) as { outcome?: string }).outcome).toBe('satisfactory');
      const row = rows(store, 'assessmentPartAttempts').find((r) => r.id === attempt.id)!;
      expect((row.values as Record<string, unknown>)['q1-out']).toBe(true);
      expect(row.markerKind).toBe('automatic');
    } finally {
      server.close();
    }
  });
});

describe('assessor delivery: the marking guide and pre-marks (U4/D6)', () => {
  it('serves the candidate NO modelAnswer anywhere and NO markingGuide property', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await mixedCase(base, store);
      const res = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        headers: auth(candidate),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.party).toBe('candidate');
      // Absence asserted explicitly — an empty guide would still be a shape
      // that could someday carry a secret.
      expect('markingGuide' in body).toBe(false);
      expect(JSON.stringify(body)).not.toContain('modelAnswer');
      expect(JSON.stringify(body)).not.toContain(MODEL_W1.slice(0, 12));
    } finally {
      server.close();
    }
  });

  it('serves the assessor stripped fields PLUS the guide, only for questions that have one', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await mixedCase(base, store);
      const res = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        headers: auth(),
      });
      const body = (await res.json()) as {
        party: string;
        fields: FormField[];
        markingGuide: { fieldId: string; modelAnswer: string }[];
      };
      expect(body.party).toBe('assessor');
      // The fields themselves are never un-stripped, whoever is asking.
      expect(body.fields.some((f) => f.modelAnswer !== undefined)).toBe(false);
      expect(body.fields.some((f) => f.answerKey !== undefined)).toBe(false);
      // The guide travels beside them: q-w1 only — q-w2 has no model answer.
      expect(body.markingGuide).toEqual([{ fieldId: 'q-w1', modelAnswer: MODEL_W1 }]);
    } finally {
      server.close();
    }
  });

  it('a self-assessing candidate is a candidate: no guide on their own paper', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      // The admin IS the candidate on this case — staff role, own paper.
      const { caseId, attemptId } = await mixedCase(base, store, ADMIN);
      const res = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        headers: auth(),
      });
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.party).toBe('candidate');
      expect('markingGuide' in body).toBe(false);
      expect(JSON.stringify(body)).not.toContain('modelAnswer');
    } finally {
      server.close();
    }
  });

  it('pre-marks the keyed boxes only after hand-in, and only for the assessor', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await mixedCase(base, store);
      await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: auth(candidate),
        body: JSON.stringify({ values: { 'q-k1': 'a' } }),
      });

      // Before hand-in: nothing derived, for anyone — the answers are moving.
      const early = (await (
        await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, { headers: auth() })
      ).json()) as { values: Record<string, unknown> };
      expect(early.values['q-k1-out']).toBeUndefined();

      await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}/submit`, {
        method: 'POST',
        headers: auth(candidate),
      });

      // After: the assessor sees the machine's honest read — right, and the
      // unanswered q-k2 marked incorrect…
      const assessor = (await (
        await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, { headers: auth() })
      ).json()) as { values: Record<string, unknown> };
      expect(assessor.values['q-k1-out']).toBe(true);
      expect(assessor.values['q-k2-out']).toBe(false);

      // …and the candidate still sees exactly what they stored.
      const cand = (await (
        await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
          headers: auth(candidate),
        })
      ).json()) as { values: Record<string, unknown> };
      expect(cand.values['q-k1-out']).toBeUndefined();
      expect(cand.values['q-k2-out']).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('narrows writableFieldIds to the marking surface once the attempt is handed in', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await mixedCase(base, store);

      // Open attempt: staff may fill anything the workflow grants, prose included.
      const before = (await (
        await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, { headers: auth() })
      ).json()) as { writableFieldIds: string[] };
      expect(before.writableFieldIds).toContain('q-w1');

      await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}/submit`, {
        method: 'POST',
        headers: auth(candidate),
      });

      const after = (await (
        await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, { headers: auth() })
      ).json()) as { writableFieldIds: string[] };
      // The marks and the signature furniture…
      expect(after.writableFieldIds).toEqual(
        expect.arrayContaining(['q-w1-out', 'q-w2-out', 'mix-assessor-name', 'mix-signed-date']),
      );
      // …and nothing of the candidate's evidence, nor the machine's cells.
      expect(after.writableFieldIds).not.toContain('q-w1');
      expect(after.writableFieldIds).not.toContain('q-k1');
      expect(after.writableFieldIds).not.toContain('q-k1-out');
      expect(after.writableFieldIds).not.toContain('mix-verdict');
    } finally {
      server.close();
    }
  });
});

describe('the marking pass: staff writes on a submitted attempt (U4/D5)', () => {
  async function submittedMixed(base: string, store: Record<string, Record<string, unknown>[]>) {
    const { caseId, attemptId } = await mixedCase(base, store);
    await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
      method: 'PATCH',
      headers: auth(candidate),
      body: JSON.stringify({ values: { 'q-k1': 'a', 'q-k2': ['a'], 'q-w1': 'Chock and report.' } }),
    });
    await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}/submit`, {
      method: 'POST',
      headers: auth(candidate),
    });
    return { caseId, attemptId };
  }

  it('lets staff tick a ✓/✗ box and sign, on the submitted-unmarked attempt', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await submittedMixed(base, store);
      const res = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ values: { 'q-w1-out': true, 'mix-assessor-name': 'Pat Assessor' } }),
      });
      expect(res.status).toBe(200);
      const row = rows(store, 'assessmentPartAttempts').find((r) => r.id === attemptId)!;
      const values = row.values as Record<string, unknown>;
      expect(values['q-w1-out']).toBe(true);
      expect(values['mix-assessor-name']).toBe('Pat Assessor');
      // The candidate's prose survived the pass untouched.
      expect(values['q-w1']).toBe('Chock and report.');
    } finally {
      server.close();
    }
  });

  it('refuses staff a candidate textarea — the evidence is frozen, only the marks are open', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await submittedMixed(base, store);
      const res = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ values: { 'q-w1': 'reworded by the marker' } }),
      });
      // The same refusal shape as every other out-of-scope write.
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; fields: string[] };
      expect(body.error).toBe('field_not_in_part');
      expect(body.fields).toEqual(['q-w1']);
    } finally {
      server.close();
    }
  });

  it('still 409s the candidate on their own submitted attempt', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await submittedMixed(base, store);
      const res = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: auth(candidate),
        body: JSON.stringify({ values: { 'q-k1': 'b' } }),
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('attempt_submitted');
    } finally {
      server.close();
    }
  });

  it('a MARKED attempt is evidence: 409 for everyone, staff included', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await submittedMixed(base, store);
      await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}/outcome`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ outcome: 'satisfactory', assessorName: 'Pat Assessor' }),
      });

      const staff = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ values: { 'q-w1-out': false } }),
      });
      expect(staff.status).toBe(409);
      expect(((await staff.json()) as { error: string }).error).toBe('attempt_resolved');

      const cand = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: auth(candidate),
        body: JSON.stringify({ values: { 'q-k1': 'b' } }),
      });
      expect(cand.status).toBe(409);
      expect(((await cand.json()) as { error: string }).error).toBe('attempt_resolved');
    } finally {
      server.close();
    }
  });

  it('check-question still refuses a written field — no key, no check (regression pin)', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await mixedCase(base, store);
      const res = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}/check-question`, {
        method: 'POST',
        headers: auth(candidate),
        body: JSON.stringify({ fieldId: 'q-w1', value: 'any prose at all' }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('not_a_keyed_question');
    } finally {
      server.close();
    }
  });
});


/*
  ── Review-round pins ────────────────────────────────────────────────────────

  The tool detail is the ONE read that serves unstripped fields (answerKey +
  modelAnswer), so it takes the same edit gate as the PATCH beside it. The
  leak pin mirrors fill-links.test.ts's posture: absence is asserted on the
  serialized body, not on a property the shape might rename.
*/
describe('GET /assessment-tools/:id is an authoring read — edit-gated', () => {
  it('403s a candidate-role caller, with no key material in the refusal', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const { toolId } = await mixedCase(base, store);
      const res = await fetch(`${base}/assessment-tools/${toolId}`, { headers: auth(candidate) });
      expect(res.status).toBe(403);
      const body = JSON.stringify(await res.json());
      expect(body).not.toContain('answerKey');
      expect(body).not.toContain('modelAnswer');
      expect(body).not.toContain(MODEL_W1.slice(0, 12));
    } finally {
      server.close();
    }
  });

  it('still serves an editor the UNSTRIPPED fields — the authoring surface keeps its keys', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const { toolId } = await mixedCase(base, store);
      const res = await fetch(`${base}/assessment-tools/${toolId}`, { headers: auth() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { fields: FormField[] };
      expect(body.fields.find((f) => f.id === 'q-k1')?.answerKey).toEqual(['a']);
      expect(body.fields.find((f) => f.id === 'q-w1')?.modelAnswer).toBe(MODEL_W1);
    } finally {
      server.close();
    }
  });

  it('403s a viewer-role caller too — org-wide view is not authoring', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const { toolId } = await mixedCase(base, store);
      const res = await fetch(`${base}/assessment-tools/${toolId}`, {
        headers: auth({ userId: BUILDER, orgId: ORG, role: 'viewer' }),
      });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });
});

/*
  ── The judged pre-mark is PART-SCOPED ───────────────────────────────────────

  Marking the whole version at the outcome route read every OTHER part's keyed
  questions as unanswered and wrote their ✗ into THIS attempt's stored values;
  the export's per-part merge then let a later judged attempt's foreign ✗
  overwrite the keyed part's real ✓ on the certified PDF.
*/
const TWO_TEMPLATE = '00000000-0000-4000-8000-0000000000e3';
const TWO_VERSION = '00000000-0000-4000-8000-0000000000e4';

const TWO_FIELDS: FormField[] = [
  header('h-t1'),
  {
    id: 'k1',
    type: 'radio',
    label: 'P1 keyed',
    required: true,
    source: 'imported',
    options: ['a', 'b'],
    answerKey: ['a'],
    outcomeTarget: { fieldId: 'k1-out' },
  },
  { id: 'k1-out', type: 'check_cross', label: 'P1 outcome', required: false, source: 'imported' },
  header('h-t2'),
  {
    id: 'k2',
    type: 'radio',
    label: 'P2 keyed',
    required: true,
    source: 'imported',
    options: ['a', 'b'],
    answerKey: ['a'],
    outcomeTarget: { fieldId: 'k2-out' },
  },
  { id: 'k2-out', type: 'check_cross', label: 'P2 outcome', required: false, source: 'imported' },
  {
    id: 'w2',
    type: 'textarea',
    label: 'P2 written',
    required: true,
    source: 'imported',
    modelAnswer: 'Chock, isolate, report.',
    outcomeTarget: { fieldId: 'w2-out' },
  },
  { id: 'w2-out', type: 'check_cross', label: 'P2 written outcome', required: false, source: 'imported' },
];

const TWO_MANIFEST: AssessmentToolManifest = {
  parts: [
    /*
      t1 names its mandatory set explicitly because the SELF-MARKING branch
      still runs `markTheory` over the whole version: without the narrowing,
      t2's unanswered keyed question fails t1's gate at hand-in. That
      whole-version gate is a pre-existing adjacent issue this round leaves
      alone — the fix under test here is the JUDGED pre-mark's part scoping.
    */
    { key: 't1', ordinal: 1, label: 'Keyed Theory', kind: 'theory', pathways: ['experienced', 'new', 'rpl'], startFieldId: 'h-t1', mandatoryFieldIds: ['k1'] },
    { key: 't2', ordinal: 2, label: 'Mixed Theory', kind: 'theory', pathways: ['experienced', 'new', 'rpl'], startFieldId: 'h-t2' },
  ],
};

describe('mixed marking pre-marks only the ATTEMPT PART’s keyed questions', () => {
  it('a judged part’s outcome never writes another part’s ✗ into its stored values', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      rows(store, 'formTemplates').push({
        id: TWO_TEMPLATE,
        orgId: ORG,
        name: 'Two Part Paper',
        currentVersionId: TWO_VERSION,
      });
      rows(store, 'formTemplateVersions').push({ id: TWO_VERSION, templateId: TWO_TEMPLATE, fields: TWO_FIELDS });
      const created = await fetch(`${base}/assessment-tools`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          templateId: TWO_TEMPLATE,
          name: 'Two Part Paper',
          manifest: TWO_MANIFEST,
          awardedCompetencyIds: [COMPETENCY],
        }),
      });
      expect(created.status).toBe(201);
      const tool = (await created.json()) as { id: string };
      const kase = (await (
        await fetch(`${base}/assessment-cases`, {
          method: 'POST',
          headers: auth(),
          body: JSON.stringify({ toolId: tool.id, candidateUserId: CANDIDATE, pathway: 'new' }),
        })
      ).json()) as { id: string };

      // Part 1: fully keyed, answered right, marks itself at hand-in — ✓ stored.
      const a1 = (await (
        await fetch(`${base}/assessment-cases/${kase.id}/parts/t1/attempts`, { method: 'POST', headers: auth() })
      ).json()) as { id: string };
      await fetch(`${base}/assessment-cases/${kase.id}/attempts/${a1.id}`, {
        method: 'PATCH',
        headers: auth(candidate),
        body: JSON.stringify({ values: { k1: 'a' } }),
      });
      const s1 = await fetch(`${base}/assessment-cases/${kase.id}/attempts/${a1.id}/submit`, {
        method: 'POST',
        headers: auth(candidate),
      });
      expect(((await s1.json()) as { outcome?: string }).outcome).toBe('satisfactory');

      // Part 2: judged (w2 is unkeyed), keyed subset answered right.
      const a2 = (await (
        await fetch(`${base}/assessment-cases/${kase.id}/parts/t2/attempts`, { method: 'POST', headers: auth() })
      ).json()) as { id: string };
      await fetch(`${base}/assessment-cases/${kase.id}/attempts/${a2.id}`, {
        method: 'PATCH',
        headers: auth(candidate),
        body: JSON.stringify({ values: { k2: 'a', w2: 'Chock and report.' } }),
      });
      const res = await fetch(`${base}/assessment-cases/${kase.id}/attempts/${a2.id}/outcome`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ outcome: 'satisfactory', assessorName: 'Pat Assessor' }),
      });
      expect(res.status).toBe(200);

      const row2 = rows(store, 'assessmentPartAttempts').find((r) => r.id === a2.id)!;
      const values2 = row2.values as Record<string, unknown>;
      // Its own keyed subset pre-marked…
      expect(values2['k2-out']).toBe(true);
      // …and NOTHING of part 1's: no foreign ✗ to shadow the real ✓ at export.
      expect('k1-out' in values2).toBe(false);
      expect('k1' in values2).toBe(false);

      // Part 1's own record is untouched — the mark the export draws.
      const row1 = rows(store, 'assessmentPartAttempts').find((r) => r.id === a1.id)!;
      expect((row1.values as Record<string, unknown>)['k1-out']).toBe(true);
    } finally {
      server.close();
    }
  });
});

/*
  ── Reopen clears the marking pass's writes ──────────────────────────────────

  A candidate taking a submitted attempt back is about to change the answers a
  partial marking pass judged — the assessor's ✓/✗ and sign-off must not
  pre-label the revised paper.
*/
describe('reopen strips the marking pass’s ✓/✗ and sign-off from the stored attempt', () => {
  it('submit → staff ticks and signs → candidate reopens → the marks are gone, the answers stay', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await mixedCase(base, store);
      await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: auth(candidate),
        body: JSON.stringify({ values: { 'q-k1': 'a', 'q-w1': 'Chock and report.' } }),
      });
      await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}/submit`, {
        method: 'POST',
        headers: auth(candidate),
      });
      // A partial marking pass: one written question ticked, the part signed.
      const markRes = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({
          values: { 'q-w1-out': true, 'mix-assessor-name': 'Pat Assessor', 'mix-signed-date': '2026-08-21' },
        }),
      });
      expect(markRes.status).toBe(200);

      const reopen = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}/reopen`, {
        method: 'POST',
        headers: auth(candidate),
      });
      expect(reopen.status).toBe(200);

      const row = rows(store, 'assessmentPartAttempts').find((r) => r.id === attemptId)!;
      const values = row.values as Record<string, unknown>;
      // The marking pass's writes are gone — judgments on answers about to change.
      expect('q-w1-out' in values).toBe(false);
      expect('mix-assessor-name' in values).toBe(false);
      expect('mix-signed-date' in values).toBe(false);
      // The candidate's own evidence is exactly as they left it.
      expect(values['q-k1']).toBe('a');
      expect(values['q-w1']).toBe('Chock and report.');
      expect(row.submittedAt).toBeNull();
    } finally {
      server.close();
    }
  });
});

/*
  ── The marking surface excludes candidate-writable boxes ────────────────────

  A self-answering yes/no the CANDIDATE fills is one of their answers; leaving
  it on the marking surface let staff flip a candidate's own recorded answer on
  a frozen attempt. No explicit workflow here on purpose: the derived default
  gives everyone fill on the answer box, while the written question's cell is
  candidate-view by `assessorMarkAccess` — the builder's own emission.
*/
const SELFQ_TEMPLATE = '00000000-0000-4000-8000-0000000000e5';
const SELFQ_VERSION = '00000000-0000-4000-8000-0000000000e6';

const SELFQ_FIELDS: FormField[] = [
  header('h-s1'),
  { id: 'q-self', type: 'boolean_yes_no', label: 'Was the area barricaded?', required: true, source: 'imported' },
  {
    id: 'q-w1',
    type: 'textarea',
    label: 'Describe the isolation steps',
    required: true,
    source: 'imported',
    modelAnswer: 'Isolate, lock, tag, test for dead.',
    outcomeTarget: { fieldId: 'q-w1-out' },
  },
  { id: 'q-w1-out', type: 'check_cross', label: 'Isolation outcome', required: false, source: 'imported' },
  { id: 's-name', type: 'text', label: 'Name of Assessor', required: false, source: 'imported' },
];

const SELFQ_MANIFEST: AssessmentToolManifest = {
  parts: [
    {
      key: 's1',
      ordinal: 1,
      label: 'Self-answer Theory',
      kind: 'theory',
      pathways: ['experienced', 'new', 'rpl'],
      startFieldId: 'h-s1',
      assessorNameFieldId: 's-name',
    },
  ],
};

describe('the marking surface never contains a candidate-writable answer box', () => {
  async function submittedSelfQ(base: string, store: Record<string, Record<string, unknown>[]>) {
    rows(store, 'formTemplates').push({
      id: SELFQ_TEMPLATE,
      orgId: ORG,
      name: 'Self Answer',
      currentVersionId: SELFQ_VERSION,
    });
    rows(store, 'formTemplateVersions').push({ id: SELFQ_VERSION, templateId: SELFQ_TEMPLATE, fields: SELFQ_FIELDS });
    const created = await fetch(`${base}/assessment-tools`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        templateId: SELFQ_TEMPLATE,
        name: 'Self Answer',
        manifest: SELFQ_MANIFEST,
        awardedCompetencyIds: [COMPETENCY],
      }),
    });
    expect(created.status).toBe(201);
    const tool = (await created.json()) as { id: string };
    const kase = (await (
      await fetch(`${base}/assessment-cases`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ toolId: tool.id, candidateUserId: CANDIDATE, pathway: 'new' }),
      })
    ).json()) as { id: string };
    const attempt = (await (
      await fetch(`${base}/assessment-cases/${kase.id}/parts/s1/attempts`, { method: 'POST', headers: auth() })
    ).json()) as { id: string };
    await fetch(`${base}/assessment-cases/${kase.id}/attempts/${attempt.id}`, {
      method: 'PATCH',
      headers: auth(candidate),
      body: JSON.stringify({ values: { 'q-self': true, 'q-w1': 'Locked and tagged.' } }),
    });
    await fetch(`${base}/assessment-cases/${kase.id}/attempts/${attempt.id}/submit`, {
      method: 'POST',
      headers: auth(candidate),
    });
    return { caseId: kase.id, attemptId: attempt.id };
  }

  it('serves the assessor a surface WITHOUT the candidate’s yes/no answer', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await submittedSelfQ(base, store);
      const body = (await (
        await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, { headers: auth() })
      ).json()) as { writableFieldIds: string[] };
      // The assessor-only cell and the signature furniture stay open…
      expect(body.writableFieldIds).toEqual(expect.arrayContaining(['q-w1-out', 's-name']));
      // …and the candidate's own recorded answer is frozen evidence.
      expect(body.writableFieldIds).not.toContain('q-self');
    } finally {
      server.close();
    }
  });

  it('refuses a staff write to the candidate’s yes/no, and accepts the assessor-only ✓/✗', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await submittedSelfQ(base, store);
      const flip = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ values: { 'q-self': false } }),
      });
      expect(flip.status).toBe(403);
      expect(((await flip.json()) as { fields: string[] }).fields).toEqual(['q-self']);

      const tick = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ values: { 'q-w1-out': true } }),
      });
      expect(tick.status).toBe(200);
    } finally {
      server.close();
    }
  });
});

/*
  ── The marking guide's audience is MARKERS, not all staff viewers ───────────

  `party === 'assessor'` is identity, and a view-only role satisfies it. The
  guide and the pre-marks attach only for a caller who clears the same
  org-wide `assessments.edit` the marking-pass PATCH enforces.
*/
describe('view-only staff get no marking guide and no pre-marks', () => {
  it('a viewer’s payload carries neither; an editor’s carries both', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const { caseId, attemptId } = await mixedCase(base, store);
      await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: auth(candidate),
        body: JSON.stringify({ values: { 'q-k1': 'a' } }),
      });
      await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}/submit`, {
        method: 'POST',
        headers: auth(candidate),
      });

      const viewer = { userId: BUILDER, orgId: ORG, role: 'viewer' };
      const viewed = await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, {
        headers: auth(viewer),
      });
      expect(viewed.status).toBe(200);
      const viewerBody = (await viewed.json()) as Record<string, unknown>;
      expect(viewerBody.party).toBe('assessor');
      expect('markingGuide' in viewerBody).toBe(false);
      expect(JSON.stringify(viewerBody)).not.toContain('modelAnswer');
      expect(JSON.stringify(viewerBody)).not.toContain(MODEL_W1.slice(0, 12));
      expect((viewerBody.values as Record<string, unknown>)['q-k1-out']).toBeUndefined();

      const editorBody = (await (
        await fetch(`${base}/assessment-cases/${caseId}/attempts/${attemptId}`, { headers: auth() })
      ).json()) as { markingGuide?: unknown[]; values: Record<string, unknown> };
      expect(editorBody.markingGuide).toEqual([{ fieldId: 'q-w1', modelAnswer: MODEL_W1 }]);
      expect(editorBody.values['q-k1-out']).toBe(true);
    } finally {
      server.close();
    }
  });
});

/**
 * "Where each part applies" (U9), finally ENFORCED at case runtime. The rule
 * was stored and edited but never consulted by progress, so a case demanded
 * every pathway part regardless of its Location — a Boddington dozer case
 * still owed the Worsley theory paper.
 */
describe('location parts rule at case runtime', () => {
  async function caseWithRule(base: string, locationId?: string) {
    const tool = await seedTool(base);
    // MINING narrows to p1, p2, p4 — the logbook p3 is not done there.
    const ruleRes = await fetch(`${base}/assessment-tools/${tool.id}/location-parts`, {
      method: 'PATCH',
      headers: auth(),
      body: JSON.stringify({ locationPartKeys: { [MINING]: ['p1', 'p2', 'p4'] } }),
    });
    expect(ruleRes.status).toBe(200);

    const c = (await (
      await fetch(`${base}/assessment-cases`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          toolId: tool.id,
          candidateUserId: CANDIDATE,
          pathway: 'new',
          ...(locationId ? { locationId } : {}),
        }),
      })
    ).json()) as { id: string };
    return c.id;
  }

  const open = (base: string, caseId: string, part: string) =>
    fetch(`${base}/assessment-cases/${caseId}/parts/${part}/attempts`, {
      method: 'POST',
      headers: auth(),
    });

  async function passPart(
    base: string,
    caseId: string,
    part: string,
    values: Record<string, unknown>,
    outcome: Record<string, unknown>,
  ) {
    const a = (await (await open(base, caseId, part)).json()) as { id: string };
    await fetch(`${base}/assessment-cases/${caseId}/attempts/${a.id}`, {
      method: 'PATCH',
      headers: auth(),
      body: JSON.stringify({ values }),
    });
    const res = await fetch(`${base}/assessment-cases/${caseId}/attempts/${a.id}/outcome`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify(outcome),
    });
    expect(res.status).toBe(200);
  }

  it('completes a case without the part its Location excludes, and refuses to open it', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const caseId = await caseWithRule(base, MINING);

      // The excluded logbook is not this case's to open — same refusal as a
      // part outside the pathway.
      const p3 = await open(base, caseId, 'p3');
      expect(p3.status).toBe(400);
      expect(((await p3.json()) as { error: string }).error).toBe('part_not_in_pathway');

      await passPart(base, caseId, 'p1', { q1: ['a'] }, {});
      await passPart(base, caseId, 'p2', {}, { outcome: 'satisfactory' });
      // p4 unlocks with p3 skipped — the excluded part never blocks the
      // sequence…
      await passPart(base, caseId, 'p4', {}, { outcome: 'satisfactory' });

      // …and the case is finished without it.
      expect(rows(store, 'assessmentCases').find((r) => r.id === caseId)?.state).toBe(
        'awaiting_sign_off',
      );
    } finally {
      server.close();
    }
  });

  it('still requires everything at a Location the rule does not list — the safe direction', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const caseId = await caseWithRule(base, RAW_MATERIALS);

      await passPart(base, caseId, 'p1', { q1: ['a'] }, {});
      await passPart(base, caseId, 'p2', {}, { outcome: 'satisfactory' });

      // p3 (the logbook) still gates p4 here: an unlisted Location narrows
      // nothing (R75).
      const p4 = await open(base, caseId, 'p4');
      expect(p4.status).toBe(409);
      expect(((await p4.json()) as { error: string }).error).toBe('part_locked');
    } finally {
      server.close();
    }
  });
});

/**
 * The parts' verdict pairs, repointed from the workflow editor — the fix for
 * a printed "responses were" pair that publish's guess missed.
 */
describe('PATCH /assessment-tools/:id — part outcome marks', () => {
  it('persists a pair onto its part, and a later save keeps it', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      const res = await fetch(`${base}/assessment-tools/${tool.id}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({
          partOutcomeMarks: [
            {
              partKey: 'p1',
              outcomeSatisfactory: { fieldId: 'q-mining-out', value: true },
              outcomeNotSatisfactory: { fieldId: 'q-raw-out', value: true },
            },
          ],
        }),
      });
      expect(res.status).toBe(200);

      await fetch(`${base}/assessment-tools/${tool.id}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ name: 'Renamed' }),
      });

      const m = rows(store, 'assessmentTools').find((r) => r.id === tool.id)?.manifest as {
        parts: Array<{ key: string; outcomeSatisfactory?: { fieldId: string } }>;
      };
      expect(m?.parts.find((p) => p.key === 'p1')?.outcomeSatisfactory?.fieldId).toBe(
        'q-mining-out',
      );
    } finally {
      server.close();
    }
  });

  it('refuses a pair naming a ghost part or a ghost box', async () => {
    mockDbValue = makeDb().db;
    const { server, base } = startApp();
    try {
      const tool = await seedTool(base);
      const ghostPart = await fetch(`${base}/assessment-tools/${tool.id}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({
          partOutcomeMarks: [
            { partKey: 'nope', outcomeSatisfactory: { fieldId: 'q-mining-out', value: true } },
          ],
        }),
      });
      expect(ghostPart.status).toBe(400);

      const ghostBox = await fetch(`${base}/assessment-tools/${tool.id}`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({
          partOutcomeMarks: [
            { partKey: 'p1', outcomeSatisfactory: { fieldId: 'ghost-box', value: true } },
          ],
        }),
      });
      expect(ghostBox.status).toBe(400);
    } finally {
      server.close();
    }
  });
});

/**
 * Moving an OPEN case to a Location — the fix for cases opened before the
 * Location rule was enforced, which carry none and demand every part.
 */
describe('PATCH /assessment-cases/:id/location', () => {
  it('sets the Location on an open case', async () => {
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

      const res = await fetch(`${base}/assessment-cases/${c.id}/location`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ locationId: MINING }),
      });

      expect(res.status).toBe(200);
      expect(rows(store, 'assessmentCases').find((r) => r.id === c.id)?.locationId).toBe(MINING);
    } finally {
      server.close();
    }
  });

  it('refuses a Location that is not one of the organisation’s', async () => {
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

      const res = await fetch(`${base}/assessment-cases/${c.id}/location`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ locationId: '00000000-0000-4000-8000-0000000000bb' }),
      });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('location_not_found');
    } finally {
      server.close();
    }
  });
});
