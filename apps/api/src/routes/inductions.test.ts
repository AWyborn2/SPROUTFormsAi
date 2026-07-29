import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@formai/db';
import { CHC_FIELD_IDS, chcIntakeFields, type SubmissionValue } from '@formai/shared';

let mockDbValue: Db | null = null;
vi.mock('../db.js', () => ({
  get db() {
    return mockDbValue;
  },
  getDbStatus: () => 'unconfigured',
}));

const { createApp } = await import('../app.js');
const { sealSession } = await import('../auth/replit-auth.js');
const { mintApiKey } = await import('../auth/api-key.js');

const OWNER = { userId: 'u-owner', orgId: 'org-1', role: 'owner' as const };
const VIEWER = { userId: 'u-viewer', orgId: 'org-1', role: 'viewer' as const };

/** Tuesday. The next bookable Monday is 16 Mar 2026. */
const NOW = new Date('2026-03-10T09:00:00');
const VALID_MONDAY = '2026-03-16';
const LATER_MONDAY = '2026-03-23';

const INTAKE_FIELDS = chcIntakeFields();

function fileRef(fileName: string, contentType: string): SubmissionValue {
  return { kind: 'file', key: `org-1/upload-secret-key.jpg`, fileName, contentType, size: 2048 };
}

function starterValues(overrides: Record<string, SubmissionValue> = {}) {
  return {
    [CHC_FIELD_IDS.firstName]: 'Marlee',
    [CHC_FIELD_IDS.lastName]: 'Okonkwo',
    [CHC_FIELD_IDS.gender]: 'Female',
    [CHC_FIELD_IDS.indigenous]: true,
    [CHC_FIELD_IDS.starterType]: 'New starter',
    [CHC_FIELD_IDS.inductionDate]: VALID_MONDAY,
    [CHC_FIELD_IDS.department]: 'Operations',
    [CHC_FIELD_IDS.roleOperations]: ['Dozer Operator'],
    [CHC_FIELD_IDS.inBeakon]: false,
    [CHC_FIELD_IDS.mobile]: '0412 345 678',
    [CHC_FIELD_IDS.email]: 'marlee@example.com',
    [CHC_FIELD_IDS.dob]: '1994-02-11',
    [CHC_FIELD_IDS.addressStreet]: '14 Marradong Rd',
    [CHC_FIELD_IDS.suburb]: 'Boddington',
    [CHC_FIELD_IDS.postcode]: '6390',
    [CHC_FIELD_IDS.emergencyContactName]: 'Sam Okonkwo',
    [CHC_FIELD_IDS.emergencyContactPhone]: '0498 765 432',
    [CHC_FIELD_IDS.licenceClass]: 'HR',
    [CHC_FIELD_IDS.licenceExpiry]: '2030-06-30',
    [CHC_FIELD_IDS.licenceNumber]: 'WA-1234567',
    [CHC_FIELD_IDS.photo]: fileRef('marlee.jpg', 'image/jpeg'),
    [CHC_FIELD_IDS.driversLicence]: fileRef('licence.pdf', 'application/pdf'),
    ...overrides,
  };
}

function submission(id: string, values: Record<string, SubmissionValue>, versionId = 'ver-intake') {
  return {
    id,
    orgId: 'org-1',
    templateId: 'tpl-intake',
    templateVersionId: versionId,
    submittedByUserId: null,
    submitterName: '',
    submitterEmail: '',
    values,
    status: 'submitted',
    flag: '',
    createdAt: new Date('2026-03-01T00:00:00Z'),
  };
}

/** `res.json()` is `unknown` under this tsconfig; these are fixtures we control. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function jsonBody(res: Response): Promise<any> {
  return res.json();
}

function startApp() {
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

function authHeader(tenant: { userId: string; orgId: string; role: string }) {
  return { cookie: `fai_session=${sealSession(tenant)}` };
}

function fakeDb(opts: {
  submissions?: unknown[];
  submissionFindFirst?: unknown;
  versions?: unknown[];
  apiKey?: unknown;
} = {}) {
  const versions = opts.versions ?? [
    { id: 'ver-intake', templateId: 'tpl-intake', fields: INTAKE_FIELDS },
  ];
  return {
    query: {
      submissions: {
        findMany: vi.fn().mockResolvedValue(opts.submissions ?? []),
        findFirst: vi.fn().mockResolvedValue(opts.submissionFindFirst),
      },
      formTemplateVersions: {
        findMany: vi.fn().mockResolvedValue(versions),
        findFirst: vi.fn().mockResolvedValue(versions[0]),
      },
      rolePermissions: { findFirst: vi.fn().mockResolvedValue(undefined) },
      users: { findFirst: vi.fn().mockResolvedValue({ id: 'u-owner', name: 'Ash Wyborn' }) },
      apiKeys: { findFirst: vi.fn().mockResolvedValue(opts.apiKey) },
    },
    update: vi.fn(() => ({ set: () => ({ where: () => Promise.resolve() }) })),
  } as unknown as Db;
}

beforeEach(() => {
  // Only Date is faked: faking timers wholesale would stall the HTTP server
  // these tests talk to.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mockDbValue = null;
});

describe('GET /inductions/candidates', () => {
  it('assesses intake submissions and withholds sensitive detail', async () => {
    mockDbValue = fakeDb({ submissions: [submission('sub-1', starterValues())] });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/inductions/candidates`, { headers: authHeader(OWNER) });
      expect(res.status).toBe(200);
      const text = await res.text();
      const body = JSON.parse(text) as { candidates: Record<string, never>[] };

      expect(body.candidates).toHaveLength(1);
      const candidate = body.candidates[0] as unknown as {
        submissionId: string;
        readiness: string;
        starter: { fullName: string; mobile: string; email: string; photo: unknown };
      };
      expect(candidate.submissionId).toBe('sub-1');
      expect(candidate.readiness).toBe('ready');
      expect(candidate.starter.fullName).toBe('Marlee Okonkwo');
      expect(candidate.starter.mobile).toBe('0412 345 678');
      expect(candidate.starter.email).toBe('marlee@example.com');

      // R9 — none of the sensitive answers travel by default.
      expect(text).not.toContain('1994-02-11');
      expect(text).not.toContain('Marradong');
      expect(text).not.toContain('WA-1234567');
      expect(text).not.toContain('0498 765 432');
      // KTD6 — documents are presence and metadata, never a fetchable handle.
      expect(text).toContain('marlee.jpg');
      expect(text).not.toContain('upload-secret-key');
    } finally {
      server.close();
    }
  });

  it('skips submissions that are not intake forms', async () => {
    mockDbValue = fakeDb({
      submissions: [submission('sub-other', { q1: 'hello' }, 'ver-other')],
      versions: [{ id: 'ver-other', templateId: 'tpl-other', fields: [{ id: 'q1', type: 'text', label: 'Q', required: false }] }],
    });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/inductions/candidates`, { headers: authHeader(OWNER) });
      expect((await jsonBody(res)).candidates).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('filters inclusively by induction date and by readiness', async () => {
    mockDbValue = fakeDb({
      submissions: [
        submission('early', starterValues()),
        submission('late', starterValues({ [CHC_FIELD_IDS.inductionDate]: LATER_MONDAY })),
        submission('blocked', starterValues({ [CHC_FIELD_IDS.mobile]: '' })),
      ],
    });
    const { server, base } = startApp();
    try {
      const ranged = await fetch(
        `${base}/inductions/candidates?from=${VALID_MONDAY}&to=${VALID_MONDAY}`,
        { headers: authHeader(OWNER) },
      );
      const rangedIds = (await jsonBody(ranged)).candidates.map((c: { submissionId: string }) => c.submissionId);
      expect(rangedIds).toEqual(['early', 'blocked']);

      const blocked = await fetch(`${base}/inductions/candidates?readiness=blocked`, {
        headers: authHeader(OWNER),
      });
      const body = await jsonBody(blocked);
      expect(body.candidates).toHaveLength(1);
      expect(body.candidates[0].blockers).toContain('contact_missing');
    } finally {
      server.close();
    }
  });

  it('400s on a malformed date filter', async () => {
    mockDbValue = fakeDb();
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/inductions/candidates?from=last-tuesday`, {
        headers: authHeader(OWNER),
      });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('401s without a credential', async () => {
    mockDbValue = fakeDb();
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/inductions/candidates`);
      expect(res.status).toBe(401);
      expect(await jsonBody(res)).toEqual({ error: 'unauthenticated' });
    } finally {
      server.close();
    }
  });

  it('answers an API key exactly as it answers a session', async () => {
    const minted = mintApiKey();
    mockDbValue = fakeDb({
      submissions: [submission('sub-1', starterValues())],
      apiKey: {
        id: 'key-1',
        orgId: 'org-1',
        role: 'reviewer',
        prefix: minted.prefix,
        hash: minted.hash,
        createdByUserId: 'u-owner',
        revokedAt: null,
      },
    });
    const { server, base } = startApp();
    try {
      const viaKey = await fetch(`${base}/inductions/candidates`, {
        headers: { authorization: `Bearer ${minted.plaintext}` },
      });
      const viaSession = await fetch(`${base}/inductions/candidates`, { headers: authHeader(OWNER) });
      expect(viaKey.status).toBe(200);
      expect(await jsonBody(viaKey)).toEqual(await jsonBody(viaSession));
    } finally {
      server.close();
    }
  });
});

describe('GET /inductions/candidates/:id', () => {
  it('omits sensitive detail unless it is asked for', async () => {
    mockDbValue = fakeDb({ submissionFindFirst: submission('sub-1', starterValues()) });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/inductions/candidates/sub-1`, { headers: authHeader(OWNER) });
      const body = await jsonBody(res);
      expect(body.sensitiveOmitted).toBe('not_requested');
      expect(body.sensitive).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('returns sensitive detail to a caller who asks and may export', async () => {
    mockDbValue = fakeDb({ submissionFindFirst: submission('sub-1', starterValues()) });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/inductions/candidates/sub-1?includeSensitive=true`, {
        headers: authHeader(OWNER),
      });
      const body = await jsonBody(res);
      expect(body.sensitive.dob).toBe('1994-02-11');
      expect(body.sensitive.licenceNumber).toBe('WA-1234567');
      expect(body.sensitiveOmitted).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('gives a caller without the export grant the usable payload and the reason', async () => {
    mockDbValue = fakeDb({ submissionFindFirst: submission('sub-1', starterValues()) });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/inductions/candidates/sub-1?includeSensitive=true`, {
        headers: authHeader(VIEWER),
      });
      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(body.sensitiveOmitted).toBe('insufficient_permission');
      expect(body.sensitive).toBeUndefined();
      expect(body.starter.fullName).toBe('Marlee Okonkwo');
    } finally {
      server.close();
    }
  });

  it('404s for an unknown id and for one belonging to another org', async () => {
    // The org filter lives in the WHERE clause, so a foreign id simply misses.
    mockDbValue = fakeDb({ submissionFindFirst: undefined });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/inductions/candidates/sub-elsewhere`, {
        headers: authHeader(OWNER),
      });
      expect(res.status).toBe(404);
      expect(await jsonBody(res)).toEqual({ error: 'not_found' });
    } finally {
      server.close();
    }
  });

  it('404s when the submission is not an intake form', async () => {
    mockDbValue = fakeDb({
      submissionFindFirst: submission('sub-other', { q1: 'hi' }, 'ver-other'),
      versions: [{ id: 'ver-other', templateId: 'tpl-other', fields: [] }],
    });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/inductions/candidates/sub-other`, { headers: authHeader(OWNER) });
      expect(res.status).toBe(404);
      expect(await jsonBody(res)).toEqual({ error: 'not_an_induction_candidate' });
    } finally {
      server.close();
    }
  });
});

describe('GET /inductions/cohorts', () => {
  it('counts seats from ready starters while still listing blocked ones', async () => {
    mockDbValue = fakeDb({
      submissions: [
        submission('ready-1', starterValues()),
        submission('blocked-1', starterValues({ [CHC_FIELD_IDS.driversLicence]: null })),
        submission('later', starterValues({ [CHC_FIELD_IDS.inductionDate]: LATER_MONDAY })),
      ],
    });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/inductions/cohorts`, { headers: authHeader(OWNER) });
      const body = await jsonBody(res);
      expect(body.cohorts.map((c: { date: string }) => c.date)).toEqual([VALID_MONDAY, LATER_MONDAY]);

      const first = body.cohorts[0];
      expect(first.seats).toBe(1);
      expect(first.readyCount).toBe(1);
      expect(first.blockedCount).toBe(1);
      expect(first.starters.map((s: { submissionId: string }) => s.submissionId)).toEqual([
        'ready-1',
        'blocked-1',
      ]);
    } finally {
      server.close();
    }
  });

  it('narrows to a single date when asked', async () => {
    mockDbValue = fakeDb({
      submissions: [
        submission('ready-1', starterValues()),
        submission('later', starterValues({ [CHC_FIELD_IDS.inductionDate]: LATER_MONDAY })),
      ],
    });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/inductions/cohorts?date=${LATER_MONDAY}`, {
        headers: authHeader(OWNER),
      });
      const body = await jsonBody(res);
      expect(body.cohorts).toHaveLength(1);
      expect(body.cohorts[0].date).toBe(LATER_MONDAY);
    } finally {
      server.close();
    }
  });
});

describe('GET /inductions/dates', () => {
  it('returns successive bookable Mondays', async () => {
    mockDbValue = fakeDb();
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/inductions/dates?count=3`, { headers: authHeader(OWNER) });
      const body = await jsonBody(res);
      expect(body.dates.map((d: { date: string }) => d.date)).toEqual([
        '2026-03-16',
        '2026-03-23',
        '2026-03-30',
      ]);
      for (const entry of body.dates) {
        expect(new Date(`${entry.date}T00:00:00`).getDay()).toBe(1);
        expect(entry.holidayListExpired).toBe(false);
      }
      expect(body.holidaysCoverThrough).toBe('2026-12-28');
    } finally {
      server.close();
    }
  });

  it('flags dates past the end of the public-holiday list', async () => {
    vi.setSystemTime(new Date('2026-12-01T09:00:00'));
    mockDbValue = fakeDb();
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/inductions/dates?count=8`, { headers: authHeader(OWNER) });
      const body = (await jsonBody(res)) as { dates: { date: string; holidayListExpired: boolean }[] };
      const expired = body.dates.filter((d) => d.holidayListExpired);
      expect(expired.length).toBeGreaterThan(0);
      expect(expired.every((d) => d.date > '2026-12-28')).toBe(true);
    } finally {
      server.close();
    }
  });

  it('rejects an out-of-range count', async () => {
    mockDbValue = fakeDb();
    const { server, base } = startApp();
    try {
      expect((await fetch(`${base}/inductions/dates?count=0`, { headers: authHeader(OWNER) })).status).toBe(400);
      expect((await fetch(`${base}/inductions/dates?count=99`, { headers: authHeader(OWNER) })).status).toBe(400);
    } finally {
      server.close();
    }
  });
});
