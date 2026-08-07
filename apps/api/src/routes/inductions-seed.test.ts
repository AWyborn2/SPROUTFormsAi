import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@formai/db';
import { CHC_FIELD_IDS, chcIntakeFields, type SubmissionValue } from '@formai/shared';

/*
  U40's route has its own file rather than joining `inductions.test.ts`, which
  is a large suite built around the booking workflow and its fixed clock. This
  one route is a READ over a submission with no booking, no dates and no
  cohorts, so it shares none of that setup — and a seed test failing for a
  reason to do with public holidays would be a bad day.
*/

let mockDbValue: Db | null = null;
vi.mock('../db.js', () => ({
  get db() {
    return mockDbValue;
  },
  getDbStatus: () => 'unconfigured',
}));

const { createApp } = await import('../app.js');
const { sealSession } = await import('../auth/replit-auth.js');

const OWNER = { userId: 'u-owner', orgId: 'org-1', role: 'owner' as const };
const CANDIDATE = { userId: 'u-cand', orgId: 'org-1', role: 'candidate' as const };

const INTAKE_FIELDS = chcIntakeFields();

function startApp() {
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}
function authHeader(t: { userId: string; orgId: string; role: string }) {
  return { cookie: `fai_session=${sealSession(t)}` };
}

function fileRef(fileName: string, contentType: string): SubmissionValue {
  return { kind: 'file', key: 'org-1/upload-secret-key.jpg', fileName, contentType, size: 2048 };
}

function starterValues(overrides: Record<string, SubmissionValue> = {}) {
  return {
    [CHC_FIELD_IDS.firstName]: 'Marlee',
    [CHC_FIELD_IDS.lastName]: 'Okonkwo',
    [CHC_FIELD_IDS.gender]: 'Female',
    [CHC_FIELD_IDS.ethnicity]: 'Aboriginal',
    [CHC_FIELD_IDS.starterType]: 'New starter',
    [CHC_FIELD_IDS.inductionDate]: '2026-03-16',
    [CHC_FIELD_IDS.department]: 'Operations',
    [CHC_FIELD_IDS.roleOperations]: ['Dozer Operator'],
    [CHC_FIELD_IDS.mobile]: '0412 345 678',
    [CHC_FIELD_IDS.email]: 'marlee@example.com',
    [CHC_FIELD_IDS.dob]: '1994-02-11',
    [CHC_FIELD_IDS.addressStreet]: '14 Marradong Rd',
    [CHC_FIELD_IDS.suburb]: 'Boddington',
    [CHC_FIELD_IDS.postcode]: '6390',
    [CHC_FIELD_IDS.emergencyContactName]: 'Sam Okonkwo',
    [CHC_FIELD_IDS.emergencyContactPhone]: '0498 765 432',
    [CHC_FIELD_IDS.photo]: fileRef('marlee.jpg', 'image/jpeg'),
    [CHC_FIELD_IDS.driversLicence]: fileRef('licence.pdf', 'application/pdf'),
    ...overrides,
  };
}

function fakeDb(
  opts: {
    values?: Record<string, SubmissionValue>;
    /** The person already on file at this address, if any. */
    user?: unknown;
    membership?: unknown;
    /** The pinned version's fields — what decides whether this IS a candidate. */
    fields?: unknown[];
    departments?: unknown[];
    jobRoles?: unknown[];
    submission?: unknown;
    /** The organisation row the tier gate reads. Defaults to a tier that carries profiles. */
    org?: unknown;
  } = {},
) {
  const db = {
    query: {
      submissions: {
        findFirst: vi.fn().mockResolvedValue(
          'submission' in opts
            ? opts.submission
            : {
                id: 'sub-1',
                orgId: 'org-1',
                templateVersionId: 'ver-intake',
                values: opts.values ?? starterValues(),
              },
        ),
      },
      formTemplateVersions: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: 'ver-intake', fields: opts.fields ?? INTAKE_FIELDS }),
      },
      rolePermissions: { findFirst: vi.fn().mockResolvedValue(undefined) },
      organizations: {
        findFirst: vi.fn().mockResolvedValue(opts.org ?? { id: 'org-1', planTier: 'business' }),
      },
      users: { findFirst: vi.fn().mockResolvedValue(opts.user) },
      memberships: { findFirst: vi.fn().mockResolvedValue(opts.membership) },
      departments: {
        findMany: vi
          .fn()
          .mockResolvedValue(opts.departments ?? [{ id: 'd-1', name: 'Operations', status: 'active' }]),
      },
      jobRoles: {
        findMany: vi
          .fn()
          .mockResolvedValue(opts.jobRoles ?? [{ id: 'r-1', name: 'Dozer Operator', status: 'active' }]),
      },
    },
  };
  mockDbValue = db as unknown as Db;
  return db;
}

const seedFor = (base: string, tenant: Parameters<typeof authHeader>[0], id = 'sub-1') =>
  fetch(`${base}/inductions/candidates/${id}/profile-seed`, { headers: authHeader(tenant) });

afterEach(() => {
  vi.clearAllMocks();
  mockDbValue = null;
});

describe('GET /inductions/candidates/:id/profile-seed (U40)', () => {
  it('maps the submission onto the profile fields (F2, R87, R88)', async () => {
    fakeDb();
    const { server, base } = startApp();
    try {
      const res = await seedFor(base, OWNER);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        disposition: string;
        seed: { fields: Record<string, string>; department: string; roles: string[]; indigenousStatus: string };
      };
      expect(body.disposition).toBe('create');
      expect(body.seed.fields).toMatchObject({
        firstName: 'Marlee',
        lastName: 'Okonkwo',
        dateOfBirth: '1994-02-11',
        addressStreet: '14 Marradong Rd',
        emergencyContactName: 'Sam Okonkwo',
      });
      expect(body.seed.department).toBe('Operations');
      expect(body.seed.roles).toEqual(['Dozer Operator']);
      // Derived from the ethnicity answer, never mapped (R15).
      expect(body.seed.indigenousStatus).toBe('indigenous');
    } finally {
      server.close();
    }
  });

  it('carries no document, because the bytes were never kept (R91)', async () => {
    // The submission holds a file MARKER; the file itself was never retained.
    // Seeding one would record evidence nobody holds.
    fakeDb();
    const { server, base } = startApp();
    try {
      const body = (await (await seedFor(base, OWNER)).json()) as { seed: { fields: Record<string, string> } };
      expect(body.seed.fields).not.toHaveProperty('profilePictureKey');
      expect(JSON.stringify(body.seed)).not.toContain('upload-secret-key');
    } finally {
      server.close();
    }
  });

  it('creates NOTHING for somebody who already holds a record, and says so (R89, R90)', async () => {
    /*
      Two records for one person is the failure this rule exists to prevent, and
      it is unrecoverable without a merge. The route reports the existing
      membership so an Admin can open the record rather than retype it.
    */
    fakeDb({
      user: { id: 'u-1', email: 'marlee@example.com' },
      membership: { id: 'm-1', userId: 'u-1', orgId: 'org-1', status: 'active' },
    });
    const { server, base } = startApp();
    try {
      const body = (await (await seedFor(base, OWNER)).json()) as {
        disposition: string;
        membershipId: string | null;
      };
      expect(body.disposition).toBe('existing_record');
      expect(body.membershipId).toBe('m-1');
    } finally {
      server.close();
    }
  });

  it('routes a DEACTIVATED person to an Admin to reactivate rather than doing it (R90)', async () => {
    // Reactivation takes a seat and may buy a block (R78, R86) — not a decision
    // to take automatically off the back of a form submission.
    fakeDb({
      user: { id: 'u-1', email: 'marlee@example.com' },
      membership: { id: 'm-1', userId: 'u-1', orgId: 'org-1', status: 'suspended' },
    });
    const { server, base } = startApp();
    try {
      const body = (await (await seedFor(base, OWNER)).json()) as { disposition: string };
      expect(body.disposition).toBe('deactivated');
    } finally {
      server.close();
    }
  });

  it('reports a value the current lists no longer offer as a suggestion (R94)', async () => {
    /*
      Reaches only a HISTORICAL submission — one raised since the organisation's
      lists exist can carry only values those lists hold. A retired Department
      is exactly one the answer may no longer be written to, so it is excluded
      from the current lists and the answer comes back for an Admin to resolve.
    */
    fakeDb({
      departments: [
        { id: 'd-1', name: 'Operations', status: 'retired' },
        { id: 'd-2', name: 'Maintenance', status: 'active' },
      ],
    });
    const { server, base } = startApp();
    try {
      const body = (await (await seedFor(base, OWNER)).json()) as {
        seed: { unmatched: Array<{ key: string; value: string }> };
      };
      expect(body.seed.unmatched).toContainEqual({ key: 'department', value: 'Operations' });
    } finally {
      server.close();
    }
  });

  it('reports nothing unmatched where every answer is still offered', async () => {
    fakeDb();
    const { server, base } = startApp();
    try {
      const body = (await (await seedFor(base, OWNER)).json()) as { seed: { unmatched: unknown[] } };
      expect(body.seed.unmatched).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('refuses below the tier that carries assessments', async () => {
    /*
      The permission check reads the MATRIX, which knows nothing about the plan.
      An organisation below the assessments tier holds no profiles at all, so
      this route must not be its way in — and a seed is the entry point to
      creating one.
    */
    fakeDb({ org: { id: 'org-1', planTier: 'individual' } });
    const { server, base } = startApp();
    try {
      expect((await seedFor(base, OWNER)).status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('refuses a caller with no profile edit grant', async () => {
    // Seeding is the entry point to CREATING a record, so it is an Admin act
    // rather than a read of the submission.
    fakeDb();
    const { server, base } = startApp();
    try {
      expect((await seedFor(base, CANDIDATE)).status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('404s for a submission that is not an induction candidate', async () => {
    /*
      Candidacy turns on the pinned VERSION carrying the CHC intake fields, not
      on what the submission answered — a version that never asked the questions
      cannot produce a starter, whatever values happen to be stored against it.
    */
    fakeDb({ fields: [], values: { some_other_field: 'x' } as Record<string, SubmissionValue> });
    const { server, base } = startApp();
    try {
      const res = await seedFor(base, OWNER);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: 'not_an_induction_candidate' });
    } finally {
      server.close();
    }
  });

  it('404s for a submission in another organisation', async () => {
    // Not-found rather than forbidden: telling a caller an id exists elsewhere
    // is itself a cross-tenant disclosure.
    fakeDb({ submission: undefined });
    const { server, base } = startApp();
    try {
      expect((await seedFor(base, OWNER)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
