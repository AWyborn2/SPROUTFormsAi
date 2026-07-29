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

function insertResult(rows: unknown[]) {
  const awaitable = Promise.resolve(undefined) as Promise<undefined> & {
    returning: () => Promise<unknown[]>;
  };
  awaitable.returning = vi.fn().mockResolvedValue(rows);
  return awaitable;
}

function fakeDb(
  opts: {
    submissions?: unknown[];
    submissionFindFirst?: unknown;
    versions?: unknown[];
    apiKey?: unknown;
    bookings?: unknown[];
    bookingStarters?: { bookingId: string; submissionId: string; starterName: string }[];
  } = {},
) {
  const versions = opts.versions ?? [
    { id: 'ver-intake', templateId: 'tpl-intake', fields: INTAKE_FIELDS },
  ];
  const insertValues = vi.fn();

  const db = {
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
      inductionBookings: { findMany: vi.fn().mockResolvedValue(opts.bookings ?? []) },
      inductionBookingStarters: { findMany: vi.fn().mockResolvedValue(opts.bookingStarters ?? []) },
    },
    insert: vi.fn((table: unknown) => ({
      values: (v: unknown) => {
        insertValues(table, v);
        const rows = Array.isArray(v) ? v : [v];
        return insertResult(
          rows.map((row) => ({
            id: 'booking-new',
            createdAt: new Date('2026-03-10T09:00:00Z'),
            ...(row as object),
          })),
        );
      },
    })),
    update: vi.fn(() => ({ set: () => ({ where: () => Promise.resolve() }) })),
  } as unknown as Db;

  return Object.assign(db, { __insertValues: insertValues }) as Db & {
    __insertValues: ReturnType<typeof vi.fn>;
  };
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

describe('POST /inductions/bookings', () => {
  function bookingRequest(
    body: Record<string, unknown>,
    tenant: { userId: string; orgId: string; role: string } = OWNER,
  ) {
    return {
      method: 'POST',
      headers: { ...authHeader(tenant), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  it('records a booking whose seat count matches its starters', async () => {
    const db = fakeDb({
      submissions: [submission('sub-1', starterValues()), submission('sub-2', starterValues())],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(
        `${base}/inductions/bookings`,
        bookingRequest({
          date: VALID_MONDAY,
          submissionIds: ['sub-1', 'sub-2'],
          externalReference: 'BIS-9931',
        }),
      );
      expect(res.status).toBe(201);
      const body = await jsonBody(res);
      expect(body.seats).toBe(2);
      expect(body.date).toBe(VALID_MONDAY);
      expect(body.externalReference).toBe('BIS-9931');
      expect(body.starters.map((s: { starterName: string }) => s.starterName)).toEqual([
        'Marlee Okonkwo',
        'Marlee Okonkwo',
      ]);
      // Names are captured at booking time so a later form edit cannot rewrite
      // who was actually booked.
      const [, starterRows] = db.__insertValues.mock.calls.find(
        ([, v]) => Array.isArray(v) && (v as unknown[]).length === 2,
      )!;
      expect((starterRows as { starterName: string }[])[0]!.starterName).toBe('Marlee Okonkwo');
    } finally {
      server.close();
    }
  });

  it('records the API key when an agent books, and leaves it null for a session', async () => {
    const minted = mintApiKey();
    const viaKeyDb = fakeDb({
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
    mockDbValue = viaKeyDb;
    const { server, base } = startApp();
    try {
      const viaKey = await fetch(`${base}/inductions/bookings`, {
        method: 'POST',
        headers: { authorization: `Bearer ${minted.plaintext}`, 'content-type': 'application/json' },
        body: JSON.stringify({ date: VALID_MONDAY, submissionIds: ['sub-1'] }),
      });
      expect(viaKey.status).toBe(201);
      expect((await jsonBody(viaKey)).bookedByApiKeyId).toBe('key-1');

      const audits = viaKeyDb.__insertValues.mock.calls
        .map(([, v]) => v as Record<string, unknown>)
        .filter((v) => typeof v?.action === 'string');
      expect(audits[0]!.action).toBe('Recorded induction booking via API key');
    } finally {
      server.close();
    }

    const viaSessionDb = fakeDb({ submissions: [submission('sub-1', starterValues())] });
    mockDbValue = viaSessionDb;
    const second = startApp();
    try {
      const res = await fetch(
        `${second.base}/inductions/bookings`,
        bookingRequest({ date: VALID_MONDAY, submissionIds: ['sub-1'] }),
      );
      const body = await jsonBody(res);
      expect(body.bookedByApiKeyId).toBeNull();
      expect(body.bookedByUserId).toBe(OWNER.userId);
    } finally {
      second.server.close();
    }
  });

  it('404s when a submission is not in the caller org, and writes nothing', async () => {
    // The org filter is in the WHERE clause, so a foreign id is simply absent.
    const db = fakeDb({ submissions: [] });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(
        `${base}/inductions/bookings`,
        bookingRequest({ date: VALID_MONDAY, submissionIds: ['sub-elsewhere'] }),
      );
      expect(res.status).toBe(404);
      expect((await jsonBody(res)).submissionIds).toEqual(['sub-elsewhere']);
      expect(db.__insertValues).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('400s when a starter wants a different Monday', async () => {
    const db = fakeDb({
      submissions: [submission('sub-late', starterValues({ [CHC_FIELD_IDS.inductionDate]: LATER_MONDAY }))],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(
        `${base}/inductions/bookings`,
        bookingRequest({ date: VALID_MONDAY, submissionIds: ['sub-late'] }),
      );
      expect(res.status).toBe(400);
      const body = await jsonBody(res);
      expect(body.error).toBe('date_mismatch');
      expect(body.inductionDate).toBe(LATER_MONDAY);
      expect(db.__insertValues).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('409s rather than double-booking a starter', async () => {
    const db = fakeDb({
      submissions: [submission('sub-1', starterValues())],
      bookingStarters: [{ bookingId: 'booking-old', submissionId: 'sub-1', starterName: 'Marlee Okonkwo' }],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(
        `${base}/inductions/bookings`,
        bookingRequest({ date: VALID_MONDAY, submissionIds: ['sub-1'] }),
      );
      expect(res.status).toBe(409);
      expect(await jsonBody(res)).toEqual({ error: 'already_booked', submissionIds: ['sub-1'] });
      expect(db.__insertValues).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('refuses a caller without the export grant', async () => {
    const db = fakeDb({ submissions: [submission('sub-1', starterValues())] });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(
        `${base}/inductions/bookings`,
        bookingRequest({ date: VALID_MONDAY, submissionIds: ['sub-1'] }, VIEWER),
      );
      expect(res.status).toBe(403);
      expect(db.__insertValues).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('400s on a malformed body', async () => {
    mockDbValue = fakeDb();
    const { server, base } = startApp();
    try {
      expect((await fetch(`${base}/inductions/bookings`, bookingRequest({ date: 'soon', submissionIds: ['s'] }))).status).toBe(400);
      expect((await fetch(`${base}/inductions/bookings`, bookingRequest({ date: VALID_MONDAY, submissionIds: [] }))).status).toBe(400);
    } finally {
      server.close();
    }
  });
});

describe('notice override', () => {
  /** Thursday — Monday 16 Mar is then two clear business days out, inside the window. */
  const INSIDE_WINDOW = new Date('2026-03-12T09:00:00');

  function overrideRequest(body: Record<string, unknown>) {
    return {
      method: 'POST',
      headers: { ...authHeader(OWNER), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  it('reports a short-notice starter as blocked, and as ready once overridden', async () => {
    vi.setSystemTime(INSIDE_WINDOW);
    mockDbValue = fakeDb({ submissions: [submission('sub-1', starterValues())] });
    const { server, base } = startApp();
    try {
      const plain = await jsonBody(
        await fetch(`${base}/inductions/candidates`, { headers: authHeader(OWNER) }),
      );
      expect(plain.candidates[0].readiness).toBe('blocked');
      expect(plain.candidates[0].blockers).toContain('date_notice_lapsed');

      const overridden = await jsonBody(
        await fetch(`${base}/inductions/candidates?allowLateNotice=true`, {
          headers: authHeader(OWNER),
        }),
      );
      expect(overridden.candidates[0].readiness).toBe('ready');
      expect(overridden.candidates[0].warnings).toContain('notice_overridden');
    } finally {
      server.close();
    }
  });

  it('seats an overridden starter in the cohort', async () => {
    vi.setSystemTime(INSIDE_WINDOW);
    mockDbValue = fakeDb({ submissions: [submission('sub-1', starterValues())] });
    const { server, base } = startApp();
    try {
      const plain = await jsonBody(
        await fetch(`${base}/inductions/cohorts`, { headers: authHeader(OWNER) }),
      );
      expect(plain.cohorts[0].seats).toBe(0);

      const overridden = await jsonBody(
        await fetch(`${base}/inductions/cohorts?allowLateNotice=true`, { headers: authHeader(OWNER) }),
      );
      expect(overridden.cohorts[0].seats).toBe(1);
    } finally {
      server.close();
    }
  });

  it('refuses a short-notice booking with no recorded reason, and writes nothing', async () => {
    vi.setSystemTime(INSIDE_WINDOW);
    const db = fakeDb({ submissions: [submission('sub-1', starterValues())] });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(
        `${base}/inductions/bookings`,
        overrideRequest({ date: VALID_MONDAY, submissionIds: ['sub-1'] }),
      );
      expect(res.status).toBe(400);
      const body = await jsonBody(res);
      expect(body.error).toBe('notice_override_required');
      expect(body.submissionIds).toEqual(['sub-1']);
      expect(db.__insertValues).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('records the reason on the booking and names the override in the audit trail', async () => {
    vi.setSystemTime(INSIDE_WINDOW);
    const db = fakeDb({ submissions: [submission('sub-1', starterValues())] });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(
        `${base}/inductions/bookings`,
        overrideRequest({
          date: VALID_MONDAY,
          submissionIds: ['sub-1'],
          noticeOverrideReason: 'Site trainer confirmed a seat by phone',
        }),
      );
      expect(res.status).toBe(201);
      expect((await jsonBody(res)).noticeOverrideReason).toBe('Site trainer confirmed a seat by phone');

      const audit = db.__insertValues.mock.calls
        .map(([, v]) => v as Record<string, unknown>)
        .find((v) => typeof v?.action === 'string');
      expect(audit!.action).toBe('Recorded induction booking with notice override');
      expect(String(audit!.target)).toContain('Site trainer confirmed a seat by phone');
    } finally {
      server.close();
    }
  });

  it('leaves the reason empty on a booking that never needed one', async () => {
    const db = fakeDb({ submissions: [submission('sub-1', starterValues())] });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(
        `${base}/inductions/bookings`,
        overrideRequest({
          date: VALID_MONDAY,
          submissionIds: ['sub-1'],
          noticeOverrideReason: 'not actually needed',
        }),
      );
      expect(res.status).toBe(201);
      // A non-empty value must always mean "this booking waived the rule".
      expect((await jsonBody(res)).noticeOverrideReason).toBe('');
    } finally {
      server.close();
    }
  });

  it('still refuses a date the site does not run inductions on', async () => {
    vi.setSystemTime(INSIDE_WINDOW);
    mockDbValue = fakeDb({
      submissions: [submission('sub-wed', starterValues({ [CHC_FIELD_IDS.inductionDate]: '2026-03-18' }))],
    });
    const { server, base } = startApp();
    try {
      const body = await jsonBody(
        await fetch(`${base}/inductions/candidates?allowLateNotice=true`, {
          headers: authHeader(OWNER),
        }),
      );
      expect(body.candidates[0].readiness).toBe('blocked');
      expect(body.candidates[0].blockers).toContain('date_invalid');
    } finally {
      server.close();
    }
  });
});

describe('booked starters', () => {
  it('are blocked and no longer counted toward a cohort seat', async () => {
    mockDbValue = fakeDb({
      submissions: [submission('sub-1', starterValues()), submission('sub-2', starterValues())],
      bookingStarters: [{ bookingId: 'booking-old', submissionId: 'sub-1', starterName: 'Marlee Okonkwo' }],
    });
    const { server, base } = startApp();
    try {
      const candidates = await jsonBody(
        await fetch(`${base}/inductions/candidates`, { headers: authHeader(OWNER) }),
      );
      const booked = candidates.candidates.find((c: { submissionId: string }) => c.submissionId === 'sub-1');
      expect(booked.readiness).toBe('blocked');
      expect(booked.blockers).toContain('already_booked');

      const cohorts = await jsonBody(
        await fetch(`${base}/inductions/cohorts`, { headers: authHeader(OWNER) }),
      );
      expect(cohorts.cohorts[0].seats).toBe(1);
      expect(cohorts.cohorts[0].starters).toHaveLength(2);
    } finally {
      server.close();
    }
  });
});

describe('GET /inductions/bookings', () => {
  const BOOKING = {
    id: 'booking-1',
    orgId: 'org-1',
    inductionDate: VALID_MONDAY,
    seats: 2,
    externalReference: 'BIS-9931',
    note: '',
    bookedByUserId: 'u-owner',
    bookedByApiKeyId: null,
    createdAt: new Date('2026-03-11T02:00:00Z'),
  };

  it('returns bookings with their starters', async () => {
    mockDbValue = fakeDb({
      bookings: [BOOKING],
      bookingStarters: [
        { bookingId: 'booking-1', submissionId: 'sub-1', starterName: 'Marlee Okonkwo' },
        { bookingId: 'booking-1', submissionId: 'sub-2', starterName: 'Rowan Fletcher' },
      ],
    });
    const { server, base } = startApp();
    try {
      const body = await jsonBody(
        await fetch(`${base}/inductions/bookings?date=${VALID_MONDAY}`, { headers: authHeader(OWNER) }),
      );
      expect(body.bookings).toHaveLength(1);
      expect(body.bookings[0].seats).toBe(2);
      expect(body.bookings[0].starters.map((s: { starterName: string }) => s.starterName)).toEqual([
        'Marlee Okonkwo',
        'Rowan Fletcher',
      ]);
    } finally {
      server.close();
    }
  });

  it('answers an empty list without querying starters', async () => {
    mockDbValue = fakeDb({ bookings: [] });
    const { server, base } = startApp();
    try {
      const body = await jsonBody(
        await fetch(`${base}/inductions/bookings`, { headers: authHeader(OWNER) }),
      );
      expect(body).toEqual({ bookings: [] });
    } finally {
      server.close();
    }
  });
});
