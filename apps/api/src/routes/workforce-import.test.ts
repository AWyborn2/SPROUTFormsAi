import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLAN_CONFIG, type Db } from '@formai/db';

const admin = { userId: 'u-admin', orgId: 'org-1', role: 'admin' as const };
const viewer = { userId: 'u-viewer', orgId: 'org-1', role: 'viewer' as const };
let sealSession: (t: { userId: string; orgId: string; role: string }) => string;

let mockDbValue: Db | null = null;
vi.mock('../db.js', () => ({
  get db() {
    return mockDbValue;
  },
  getDbStatus: () => 'unconfigured',
}));

/*
  The run itself is exercised in `lib/workforce-import-run.test.ts`; these cover
  the ROUTE — the gates, the template, and that validation writes nothing and
  prices both pools.
*/
const runMock = vi.hoisted(() => ({
  executeImportRun: vi.fn(async () => ({ runId: 'run-1' })),
  readRunReport: vi.fn(async () => null as unknown),
}));
vi.mock('../lib/workforce-import-run.js', () => runMock);

const { createApp } = await import('../app.js');
const { tierAllowsCandidates } = await import('./workforce-import.js');
({ sealSession } = await import('../auth/workos.js'));

function startApp() {
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}
function authHeader(t: { userId: string; orgId: string; role: string }) {
  return { cookie: `fai_session=${sealSession(t)}`, 'content-type': 'application/json' };
}

const ORG = {
  id: 'org-1',
  planTier: 'business',
  seatLimit: 15,
  // Nullable, because null is the UNLIMITED sentinel an Enterprise org carries.
  candidateSeatLimit: 100 as number | null,
  dateFormat: 'dmy' as const,
};

/**
 * A db double over the reads the route makes: the org, the taxonomy the
 * validator resolves names against, the competencies some tool awards, and the
 * seat counts the preview needs.
 *
 * The taxonomy is returned WITH its statuses so the route's own active-only
 * filter is exercised — a fixture that pre-filtered would let "names a retired
 * Department is rejected" pass against a route that never filtered at all.
 */
function fakeDb(
  opts: {
    locations?: unknown[];
    departments?: unknown[];
    jobRoles?: unknown[];
    /** Override the organisation row — the plan tier is what gates Candidate rows. */
    org?: Partial<typeof ORG>;
  } = {},
) {
  const inserted: unknown[] = [];
  const db = {
    query: {
      organizations: { findFirst: vi.fn().mockResolvedValue({ ...ORG, ...opts.org }) },
      locations: {
        findMany: vi
          .fn()
          .mockResolvedValue(opts.locations ?? [{ id: 'loc-1', name: 'Boddington', status: 'active' }]),
      },
      departments: {
        findMany: vi.fn().mockResolvedValue(
          opts.departments ?? [
            { id: 'dep-1', name: 'Operations', status: 'active', allowsMultipleRoles: true },
          ],
        ),
      },
      jobRoles: {
        findMany: vi.fn().mockResolvedValue(
          opts.jobRoles ?? [
            { id: 'jr-1', name: 'Dozer Operator', departmentId: 'dep-1', status: 'active' },
          ],
        ),
      },
      competencies: {
        findMany: vi.fn().mockResolvedValue([{ id: 'c-1', orgId: 'org-1', name: 'Track Dozer' }]),
      },
      assessmentTools: {
        findMany: vi.fn().mockResolvedValue([{ id: 't-1', awardedCompetencyIds: ['c-1'] }]),
      },
      memberProfiles: { findMany: vi.fn().mockResolvedValue([]) },
      users: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(undefined) },
      memberships: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(undefined) },
      rolePermissions: { findFirst: vi.fn().mockResolvedValue(undefined) },
    },
    // The seat count the preview runs.
    select: () => ({ from: () => ({ where: async () => [{ count: 0 }] }) }),
    insert: () => ({ values: async (v: unknown) => void inserted.push(v) }),
  };
  mockDbValue = db as unknown as Db;
  return { db, inserted };
}

/** A file with one good row and one naming a Location that does not exist. */
const CSV = [
  '#profiles',
  'name,email,access_level,locations,departments,roles,employee_number,swipe_card_number',
  'Jane Smith,jane@x.io,Candidate,Boddington,Operations,Dozer Operator,E1,',
  'Bad Row,bad@x.io,Candidate,Nowhere,Operations,Dozer Operator,,',
  '',
  '#competencies',
  'email,competency,grant_date,evidence',
  'jane@x.io,Track Dozer,2022-03-01,cert-1',
  '',
].join('\n');

afterEach(() => {
  vi.clearAllMocks();
  mockDbValue = null;
});

describe('GET /workforce-import/template (R141)', () => {
  it('serves the two-section template as a CSV download', async () => {
    fakeDb();
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/workforce-import/template`, { headers: authHeader(admin) });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/csv');
      const body = await res.text();
      // The two-section shape is the part somebody gets wrong by hand, and the
      // parser reads exactly this.
      expect(body).toContain('#profiles');
      expect(body).toContain('#competencies');
      expect(body).toContain('name,email,access_level');
    } finally {
      server.close();
    }
  });

  it('refuses a non-Admin (R139)', async () => {
    fakeDb();
    const { server, base } = startApp();
    try {
      expect((await fetch(`${base}/workforce-import/template`, { headers: authHeader(viewer) })).status).toBe(403);
    } finally {
      server.close();
    }
  });
});

describe('POST /workforce-import/validate (R144)', () => {
  const post = (base: string, tenant: Parameters<typeof authHeader>[0], csv = CSV) =>
    fetch(`${base}/workforce-import/validate`, {
      method: 'POST',
      headers: authHeader(tenant),
      body: JSON.stringify({ csv }),
    });

  it('validates every row and WRITES NOTHING', async () => {
    const { inserted } = fakeDb();
    const { server, base } = startApp();
    try {
      const res = await post(base, admin);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        validRows: number;
        competencyLines: number;
        rejected: Array<{ rowNumber: number; reason: string }>;
      };
      expect(body.validRows).toBe(1);
      expect(body.competencyLines).toBe(1);
      expect(body.rejected).toHaveLength(1);
      expect(body.rejected[0]!.reason).toBe('unknown_location');
      // Pricing a file must not change anything about the organisation.
      expect(inserted).toHaveLength(0);
      expect(runMock.executeImportRun).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('prices BOTH pools separately, because each row names its own level', async () => {
    fakeDb();
    const { server, base } = startApp();
    try {
      const body = (await (await post(base, admin)).json()) as {
        preview: { candidate: { needed: number }; staff: { needed: number } };
      };
      // One Candidate row and no staff rows — a single figure would have hidden
      // which allocation the file actually spends.
      expect(body.preview.candidate.needed).toBe(1);
      expect(body.preview.staff.needed).toBe(0);
    } finally {
      server.close();
    }
  });

  it('rejects a row naming a RETIRED Department, creating no taxonomy (R165, R169)', async () => {
    fakeDb({
      departments: [{ id: 'dep-1', name: 'Operations', status: 'retired', allowsMultipleRoles: true }],
    });
    const { server, base } = startApp();
    try {
      const body = (await (await post(base, admin)).json()) as {
        validRows: number;
        rejected: Array<{ reason: string }>;
      };
      expect(body.validRows).toBe(0);
      expect(body.rejected.map((r) => r.reason)).toContain('unknown_department');
    } finally {
      server.close();
    }
  });

  it('refuses a non-Admin', async () => {
    fakeDb();
    const { server, base } = startApp();
    try {
      expect((await post(base, viewer)).status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('rejects a body carrying no file', async () => {
    fakeDb();
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/workforce-import/validate`, {
        method: 'POST',
        headers: authHeader(admin),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });
});

describe('candidate seats — null is UNLIMITED, not zero (R167, R83)', () => {
  /*
    `PlanConfig.candidateSeatLimit` is `number | null`, and the null is the
    unlimited sentinel rather than a missing value. Defaulting it (`limit ?? 0`)
    reads Enterprise as a tier with no candidate seats and rejects every
    Candidate row on the tier that carries the most of them — a whole customer's
    import returning nothing but `candidate_not_allowed`. One test per state of
    that three-state field, because collapsing any two of them breaks a tier.
  */
  const ONE_CANDIDATE = [
    '#profiles',
    'name,email,access_level,locations,departments,roles,employee_number,swipe_card_number',
    'Jane Smith,jane@x.io,Candidate,Boddington,Operations,Dozer Operator,E1,',
    '',
  ].join('\n');

  const MIXED = [
    '#profiles',
    'name,email,access_level,locations,departments,roles,employee_number,swipe_card_number',
    'Jane Smith,jane@x.io,Candidate,Boddington,Operations,Dozer Operator,E1,',
    'Ada Assessor,ada@x.io,Assessor,Boddington,Operations,Dozer Operator,E2,',
    '',
  ].join('\n');

  const validate = async (planTier: string, csv = ONE_CANDIDATE) => {
    fakeDb({ org: { planTier, candidateSeatLimit: planTier === 'enterprise' ? null : 100 } });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/workforce-import/validate`, {
        method: 'POST',
        headers: authHeader(admin),
        body: JSON.stringify({ csv }),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { validRows: number; rejected: Array<{ reason: string }> };
    } finally {
      server.close();
    }
  };

  it('Enterprise (unlimited, null) LANDS Candidate rows', async () => {
    // The reported bug: every row of an Enterprise customer's file came back
    // `candidate_not_allowed`, on the tier with the largest allocation there is.
    const body = await validate('enterprise');
    expect(body.rejected).toEqual([]);
    expect(body.validRows).toBe(1);
  });

  it('Business (a real, finite allocation) lands Candidate rows', async () => {
    const body = await validate('business');
    expect(body.rejected).toEqual([]);
    expect(body.validRows).toBe(1);
  });

  it('a Candidate row still lands beside staff rows on Enterprise', async () => {
    const body = await validate('enterprise', MIXED);
    expect(body.rejected).toEqual([]);
    expect(body.validRows).toBe(2);
  });

  /*
    The tiers allocated NO candidate seats cannot reach the route at all — the
    import is gated on `assessments`, which is Business+ — so the refusal is
    asserted on the rule itself rather than through a request that would 403
    before ever reaching it.
  */
  it('the rule reads all three states of candidateSeatLimit', () => {
    expect(PLAN_CONFIG.enterprise.candidateSeatLimit).toBeNull();
    expect(tierAllowsCandidates('enterprise')).toBe(true); // null = unlimited

    expect(PLAN_CONFIG.business.candidateSeatLimit).toBeGreaterThan(0);
    expect(tierAllowsCandidates('business')).toBe(true); // a finite allocation

    expect(PLAN_CONFIG.individual.candidateSeatLimit).toBe(0);
    expect(tierAllowsCandidates('individual')).toBe(false); // 0 = none (R83)
    expect(tierAllowsCandidates('team')).toBe(false);

    // An absent config is a genuinely missing value, and failing open there
    // would hand out seats nobody bought.
    expect(tierAllowsCandidates('gold-plated')).toBe(false);
  });
});

describe('POST /workforce-import/run (R144)', () => {
  it('RE-VALIDATES the file rather than trusting the client', async () => {
    /*
      The client sends the same file back, not a "this was already approved"
      payload. Trusting one would let anyone who can reach this route land
      whatever they liked — and the taxonomy may have moved between the preview
      and the confirmation anyway.
    */
    fakeDb();
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/workforce-import/run`, {
        method: 'POST',
        headers: authHeader(admin),
        body: JSON.stringify({ csv: CSV }),
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ runId: 'run-1' });

      const [, , input] = runMock.executeImportRun.mock.calls[0] as unknown as [
        unknown,
        unknown,
        { validProfiles: unknown[]; rejected: unknown[] },
      ];
      // The route validated it itself: one good row, one rejection.
      expect(input.validProfiles).toHaveLength(1);
      expect(input.rejected).toHaveLength(1);
    } finally {
      server.close();
    }
  });

  it('refuses a non-Admin and starts no run', async () => {
    fakeDb();
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/workforce-import/run`, {
        method: 'POST',
        headers: authHeader(viewer),
        body: JSON.stringify({ csv: CSV }),
      });
      expect(res.status).toBe(403);
      expect(runMock.executeImportRun).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});

describe('GET /workforce-import/runs/:id (R171)', () => {
  it('returns the report so it outlives the tab', async () => {
    fakeDb();
    runMock.readRunReport.mockResolvedValue({ runId: 'run-1', rowsTotal: 2, rejected: [] });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/workforce-import/runs/run-1`, { headers: authHeader(admin) });
      expect(res.status).toBe(200);
      expect((await res.json()) as { runId: string }).toMatchObject({ runId: 'run-1' });
    } finally {
      server.close();
    }
  });

  it('404s for a run belonging to another organisation', async () => {
    // The reader scopes by org and returns null, which reads as absent rather
    // than forbidden — a probe learns nothing about another tenant's runs.
    fakeDb();
    runMock.readRunReport.mockResolvedValue(null);
    const { server, base } = startApp();
    try {
      expect((await fetch(`${base}/workforce-import/runs/other`, { headers: authHeader(admin) })).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
