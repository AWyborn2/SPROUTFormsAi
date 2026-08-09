import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@formai/db';
import { DEFAULT_ROLE_PERMISSIONS, type PermissionMatrix } from '@formai/shared';

const ORG = 'org-1';
const SUBJECT_MEMBERSHIP = 'm-1';
const SUBJECT_USER = 'u-1';

const admin = { userId: 'u-admin', orgId: ORG, role: 'admin' as const };
const assessor = { userId: 'u-assessor', orgId: ORG, role: 'assessor' as const };
const subjectCandidate = { userId: SUBJECT_USER, orgId: ORG, role: 'candidate' as const };
const otherCandidate = { userId: 'u-other', orgId: ORG, role: 'candidate' as const };

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
function authHeader(t: { userId: string; orgId: string; role: string }) {
  return { cookie: `fai_session=${sealSession(t)}` };
}

const PROFILE = {
  membershipId: SUBJECT_MEMBERSHIP,
  orgId: ORG,
  firstName: 'Jane',
  middleName: 'Alexandra',
  lastName: 'Smith',
  gender: 'Female',
  ethnicity: 'Aboriginal',
  dateOfBirth: '1990-04-17',
  addressStreet: '12 Mill Road',
  suburb: 'Boddington',
  postcode: '6390',
  mobile: '0400 000 000',
  emergencyContactName: 'Chris Smith',
  emergencyContactPhone: '0400 111 111',
  starterType: 'New starter',
  employeeNumber: 'E100',
  swipeCardNumber: null,
  inductionDate: null,
};

function fakeDb(opts: {
  planTier?: string;
  matrix?: PermissionMatrix;
  profile?: Record<string, unknown> | undefined;
  membershipOrg?: string;
  /** Competency grants, their documents and the competencies they name (U39, R29). */
  grants?: unknown[];
  documents?: unknown[];
  competencies?: unknown[];
} = {}) {
  const updates: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const db = {
    query: {
      organizations: {
        findFirst: vi.fn().mockResolvedValue({
          id: ORG,
          planTier: opts.planTier ?? 'business',
          displayIdentifier: 'employee_number',
        }),
      },
      rolePermissions: { findFirst: vi.fn().mockResolvedValue(opts.matrix ? { matrix: opts.matrix } : undefined) },
      memberships: {
        /*
          `membershipForProfile` narrows by orgId, so a membership belonging to
          another organisation finds NOTHING rather than being found and then
          denied. The double models that: returning the row regardless would let
          the 404-not-403 assertion pass against a route that leaked the
          difference.
        */
        findFirst: vi.fn().mockResolvedValue(
          (opts.membershipOrg ?? ORG) === ORG
            ? { id: SUBJECT_MEMBERSHIP, userId: SUBJECT_USER, orgId: ORG }
            : undefined,
        ),
      },
      memberProfiles: {
        findFirst: vi.fn().mockResolvedValue('profile' in opts ? opts.profile : PROFILE),
      },
      users: {
        findFirst: vi.fn().mockResolvedValue({ id: admin.userId, name: 'Admin', email: 'jane@x.io' }),
      },
      /* The document side of an export (R29). Empty unless a case supplies them. */
      competencyHolders: { findMany: vi.fn().mockResolvedValue(opts.grants ?? []) },
      competencyDocuments: { findMany: vi.fn().mockResolvedValue(opts.documents ?? []) },
      competencies: { findMany: vi.fn().mockResolvedValue(opts.competencies ?? []) },
    },
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => {
          updates.push(v);
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        const rows = [{ membershipId: SUBJECT_MEMBERSHIP, ...v }];
        audits.push(v);
        void table;
        return { returning: async () => rows, then: (r: (x: unknown) => void) => r(rows) };
      },
    }),
  };
  mockDbValue = db as unknown as Db;
  return { db, updates, audits };
}

afterEach(() => {
  vi.clearAllMocks();
  mockDbValue = null;
});

describe('GET /profiles/:membershipId', () => {
  it('shows an assessor the record on the shipped defaults', async () => {
    // AE1: fields, competencies, history and documents, with approve.
    fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.assessor });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/profiles/${SUBJECT_MEMBERSHIP}`, { headers: authHeader(assessor) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { profile: Record<string, unknown>; access: Record<string, unknown> };
      expect(body.profile.dateOfBirth).toBe('1990-04-17');
      expect(body.access).toMatchObject({ canViewDocuments: true, canViewCompetencies: true, canApprove: true });
      // Not edit — the assessor default is a read plus approval (R55).
      expect(body.access.editableFields).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('hides it from an assessor in an organisation that has tightened the category', async () => {
    // AE29.
    fakeDb({
      matrix: {
        ...DEFAULT_ROLE_PERMISSIONS.assessor,
        profiles: { view: false, edit: false, approve: true, view_documents: true, view_competencies: true },
      } as PermissionMatrix,
    });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/profiles/${SUBJECT_MEMBERSHIP}`, { headers: authHeader(assessor) });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('lets a candidate read every field on their own record, tightened matrix or not', async () => {
    // AE51 / R49 — fixed rather than configured.
    fakeDb({
      matrix: {
        ...DEFAULT_ROLE_PERMISSIONS.candidate,
        profiles: { view: false, edit: false, approve: false, view_documents: false, view_competencies: false },
      } as PermissionMatrix,
    });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/profiles/${SUBJECT_MEMBERSHIP}`, { headers: authHeader(subjectCandidate) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { profile: Record<string, unknown>; access: Record<string, unknown> };
      expect(body.profile.dateOfBirth).toBe('1990-04-17');
      expect(body.access.isSubject).toBe(true);
    } finally {
      server.close();
    }
  });

  it('refuses a candidate reading somebody else’s record', async () => {
    fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.candidate });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/profiles/${SUBJECT_MEMBERSHIP}`, { headers: authHeader(otherCandidate) });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('derives the display name and Indigenous status rather than returning stored ones', async () => {
    // R3: no middle name on the display. R15: derived from the ethnicity.
    fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.admin });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/profiles/${SUBJECT_MEMBERSHIP}`, { headers: authHeader(admin) });
      const body = (await res.json()) as { profile: Record<string, unknown> };
      expect(body.profile.displayName).toBe('Jane Smith');
      expect(body.profile.indigenousStatus).toBe('indigenous');
      expect(body.profile.identifier).toBe('E100');
    } finally {
      server.close();
    }
  });

  it('404s rather than 403s for a membership in another organisation', async () => {
    // A probe must not be able to tell an existing record elsewhere from an
    // absent one.
    fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.admin, membershipOrg: 'org-2' });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/profiles/${SUBJECT_MEMBERSHIP}`, { headers: authHeader(admin) });
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('reaches no profile at all below the tier that carries assessments', async () => {
    fakeDb({ planTier: 'team', matrix: DEFAULT_ROLE_PERMISSIONS.admin });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/profiles/${SUBJECT_MEMBERSHIP}`, { headers: authHeader(admin) });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });
});

describe('POST /profiles/:membershipId', () => {
  const createBody = {
    firstName: 'Jane',
    middleName: 'Alexandra',
    lastName: 'Smith',
    gender: 'Female',
    ethnicity: 'Aboriginal',
    dateOfBirth: '1990-04-17',
    addressStreet: '12 Mill Road',
    suburb: 'Boddington',
    postcode: '6390',
    mobile: '0400 000 000',
    emergencyContactName: 'Chris Smith',
    emergencyContactPhone: '0400 111 111',
    starterType: 'New starter',
    employeeNumber: 'E100',
  };

  it('refuses the subject creating their own record — that is never the subject’s (R51)', async () => {
    fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.candidate });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/profiles/${SUBJECT_MEMBERSHIP}`, {
        method: 'POST',
        headers: { ...authHeader(subjectCandidate), 'content-type': 'application/json' },
        body: JSON.stringify(createBody),
      });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('refuses an access level the matrix grants no edit (AE25)', async () => {
    // The assessor default is read + approve, no edit — editableFields is empty.
    fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.assessor });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/profiles/${SUBJECT_MEMBERSHIP}`, {
        method: 'POST',
        headers: { ...authHeader(assessor), 'content-type': 'application/json' },
        body: JSON.stringify(createBody),
      });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('400s on an invalid body', async () => {
    fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.admin });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/profiles/${SUBJECT_MEMBERSHIP}`, {
        method: 'POST',
        headers: { ...authHeader(admin), 'content-type': 'application/json' },
        body: JSON.stringify({ dateOfBirth: 12345 }),
      });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('creates the record for an Admin and writes an audit entry (201)', async () => {
    const f = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.admin });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/profiles/${SUBJECT_MEMBERSHIP}`, {
        method: 'POST',
        headers: { ...authHeader(admin), 'content-type': 'application/json' },
        body: JSON.stringify(createBody),
      });
      expect(res.status).toBe(201);
      expect(f.audits.some((a) => a.action === 'Created profile')).toBe(true);
    } finally {
      server.close();
    }
  });

  it('409s when the membership already carries a profile or the number is taken (R1, R7)', async () => {
    const f = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.admin });
    f.db.insert = (() => ({
      values: () => ({
        returning: async () => {
          throw Object.assign(new Error('duplicate'), { code: '23505' });
        },
      }),
    })) as never;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/profiles/${SUBJECT_MEMBERSHIP}`, {
        method: 'POST',
        headers: { ...authHeader(admin), 'content-type': 'application/json' },
        body: JSON.stringify(createBody),
      });
      expect(res.status).toBe(409);
    } finally {
      server.close();
    }
  });
});

describe('PATCH /profiles/:membershipId', () => {
  it('saves a candidate’s mobile and silently drops their attempt on the employee number', async () => {
    // AE2 / R51, R53: the mobile saves and the identifier is not theirs to write.
    const { updates } = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.candidate });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/profiles/${SUBJECT_MEMBERSHIP}`, {
        method: 'PATCH',
        headers: { ...authHeader(subjectCandidate), 'content-type': 'application/json' },
        body: JSON.stringify({ mobile: '0411 222 333', employeeNumber: 'E999' }),
      });
      expect(res.status).toBe(200);
      expect(updates[0]).toMatchObject({ mobile: '0411 222 333' });
      expect(updates[0]).not.toHaveProperty('employeeNumber');
    } finally {
      server.close();
    }
  });

  it('refuses a write from an access level the matrix grants no edit', async () => {
    fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.assessor });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/profiles/${SUBJECT_MEMBERSHIP}`, {
        method: 'PATCH',
        headers: { ...authHeader(assessor), 'content-type': 'application/json' },
        body: JSON.stringify({ mobile: '0411 222 333' }),
      });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('refuses a change that would empty a required field', async () => {
    // R12: a required field must carry a value, and a decline is a value (R13).
    fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.admin });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/profiles/${SUBJECT_MEMBERSHIP}`, {
        method: 'PATCH',
        headers: { ...authHeader(admin), 'content-type': 'application/json' },
        body: JSON.stringify({ dateOfBirth: '' }),
      });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('writes ONE audit entry per changed field, each naming its field (R57)', async () => {
    /*
      Per field rather than per request, because R58 confines the sensitive ones
      to Admin — a single entry covering a date of birth and a mobile number
      would have to be hidden or shown whole.
    */
    const { audits } = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.admin });
    const { server, base } = startApp();
    try {
      await fetch(`${base}/profiles/${SUBJECT_MEMBERSHIP}`, {
        method: 'PATCH',
        headers: { ...authHeader(admin), 'content-type': 'application/json' },
        body: JSON.stringify({ mobile: '0411 222 333', dateOfBirth: '1991-01-01' }),
      });
      const entries = audits.filter((a) => a.category === 'profiles');
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.field).sort()).toEqual(['dateOfBirth', 'mobile']);
      // Old and new value both recorded (R57).
      expect(String(entries.find((e) => e.field === 'mobile')!.target)).toContain('0400 000 000');
      expect(String(entries.find((e) => e.field === 'mobile')!.target)).toContain('0411 222 333');
    } finally {
      server.close();
    }
  });

  it('writes no audit entry for a field submitted unchanged', async () => {
    const { audits } = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.admin });
    const { server, base } = startApp();
    try {
      await fetch(`${base}/profiles/${SUBJECT_MEMBERSHIP}`, {
        method: 'PATCH',
        headers: { ...authHeader(admin), 'content-type': 'application/json' },
        body: JSON.stringify({ mobile: PROFILE.mobile }),
      });
      expect(audits.filter((a) => a.category === 'profiles')).toHaveLength(0);
    } finally {
      server.close();
    }
  });
});

describe('PUT /profiles/:membershipId/unreachable (U36, R16)', () => {
  const put = (base: string, tenant: Parameters<typeof authHeader>[0], unreachable: boolean) =>
    fetch(`${base}/profiles/${SUBJECT_MEMBERSHIP}/unreachable`, {
      method: 'PUT',
      headers: { ...authHeader(tenant), 'content-type': 'application/json' },
      body: JSON.stringify({ unreachable }),
    });

  it('marks the address and leaves the record itself untouched (AE54, R16)', async () => {
    const { updates, audits } = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.admin });
    const { server, base } = startApp();
    try {
      const res = await put(base, admin, true);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ unreachable: true });

      const written = updates.at(-1)!;
      expect(written.emailUnreachableAt).toBeInstanceOf(Date);
      expect(written.emailUnreachableBy).toBe(admin.userId);
      /*
        Nothing about the address, the name or any other field is written. What
        R16 requires is that a profile CARRIES an address, not a working one —
        so the profile stays valid with nothing outstanding on it, and the
        address stays on the record for somebody to try again later.
      */
      expect(Object.keys(written).sort()).toEqual([
        'emailUnreachableAt',
        'emailUnreachableBy',
        'updatedAt',
      ]);
      expect(audits.filter((a) => a.action === 'Marked address unreachable')).toHaveLength(1);
    } finally {
      server.close();
    }
  });

  it('clears the mark, nulling both columns', async () => {
    const { updates } = fakeDb({
      matrix: DEFAULT_ROLE_PERMISSIONS.admin,
      profile: { ...PROFILE, emailUnreachableAt: new Date(), emailUnreachableBy: admin.userId },
    });
    const { server, base } = startApp();
    try {
      const res = await put(base, admin, false);
      expect(await res.json()).toMatchObject({ unreachable: false });
      expect(updates.at(-1)).toMatchObject({ emailUnreachableAt: null, emailUnreachableBy: null });
    } finally {
      server.close();
    }
  });

  it('is idempotent, writing and auditing nothing when already in that state', async () => {
    // A retried click is not a mistake, and re-stamping the date would
    // misreport when the bouncing was discovered.
    const { updates, audits } = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.admin });
    const { server, base } = startApp();
    try {
      const res = await put(base, admin, false); // already unmarked
      expect(res.status).toBe(200);
      expect(updates).toHaveLength(0);
      expect(audits.filter((a) => a.category === 'profiles')).toHaveLength(0);
    } finally {
      server.close();
    }
  });

  it('refuses a non-Admin, even one the matrix admits to profile edits', async () => {
    /*
      Deliberately NOT resolved through the matrix. `profiles.edit` governs the
      record's fields; this is a note about the world beside the record, and an
      organisation that lets a Reviewer correct a surname has not thereby said a
      Reviewer may declare somebody uncontactable.
    */
    const { updates } = fakeDb({
      matrix: { ...DEFAULT_ROLE_PERMISSIONS.assessor, profiles: { view: true, edit: true } } as PermissionMatrix,
    });
    const { server, base } = startApp();
    try {
      expect((await put(base, assessor, true)).status).toBe(403);
      expect((await put(base, subjectCandidate, true)).status).toBe(403);
      expect(updates).toHaveLength(0);
    } finally {
      server.close();
    }
  });

  it('404s for a membership belonging to another organisation', async () => {
    fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.admin, membershipOrg: 'org-2' });
    const { server, base } = startApp();
    try {
      expect((await put(base, admin, true)).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('shows the mark on the record beside the address it applies to', async () => {
    const marked = new Date('2026-08-01T00:00:00Z');
    fakeDb({
      matrix: DEFAULT_ROLE_PERMISSIONS.admin,
      profile: { ...PROFILE, emailUnreachableAt: marked },
    });
    const { server, base } = startApp();
    try {
      const body = (await (
        await fetch(`${base}/profiles/${SUBJECT_MEMBERSHIP}`, { headers: authHeader(admin) })
      ).json()) as { profile: Record<string, unknown> };
      expect(body.profile.emailUnreachableAt).toBe(marked.toISOString());
      // The record is otherwise exactly as it was.
      expect(body.profile.suburb).toBe('Boddington');
    } finally {
      server.close();
    }
  });
});

describe('GET /profiles/:membershipId/export (U39, R54)', () => {
  const GRANT = { id: 'h-1', orgId: ORG, userId: SUBJECT_USER, competencyId: 'c-1' };
  const HELD_DOC = {
    id: 'doc-1',
    orgId: ORG,
    competencyHolderId: 'h-1',
    fileName: 'hr-licence.pdf',
    contentType: 'application/pdf',
    storageKey: 'org-1/doc-1.pdf',
    state: 'held',
  };
  const COMPETENCY = { id: 'c-1', orgId: ORG, name: 'HR Licence' };

  const exportFor = (base: string, tenant: Parameters<typeof authHeader>[0]) =>
    fetch(`${base}/profiles/${SUBJECT_MEMBERSHIP}/export`, { headers: authHeader(tenant) });

  it('lets an Admin export, and writes it to the audit naming both parties (AE25)', async () => {
    /*
      The unredacted files are what make the audit line necessary: a licence
      image carries a date of birth, an address and a photograph, so a leak has
      to be traceable. Traceable to WHOM is half the answer — "who ran an
      export" without "whose record left" cannot answer the question asked
      after an incident.
    */
    const { audits } = fakeDb({
      matrix: DEFAULT_ROLE_PERMISSIONS.admin,
      grants: [GRANT],
      documents: [HELD_DOC],
      competencies: [COMPETENCY],
    });
    const { server, base } = startApp();
    try {
      const res = await exportFor(base, admin);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        membershipId: string;
        fields: Record<string, string | null>;
        documents: Array<{ fileName: string; storageKey: string; competencyName: string }>;
        exportedAt: string;
      };

      expect(body.membershipId).toBe(SUBJECT_MEMBERSHIP);
      expect(body.fields.firstName).toBe('Jane');
      expect(body.fields.emergencyContactName).toBe('Chris Smith');
      expect(body.documents).toEqual([
        {
          id: 'doc-1',
          fileName: 'hr-licence.pdf',
          contentType: 'application/pdf',
          competencyName: 'HR Licence',
          storageKey: 'org-1/doc-1.pdf',
        },
      ]);

      const entry = audits.find((a) => a.action === 'Exported member record');
      expect(entry).toMatchObject({ target: SUBJECT_MEMBERSHIP, category: 'profiles' });
      expect(entry?.actorId).toBe(admin.userId);
    } finally {
      server.close();
    }
  });

  it('emits NOTHING redacted, because R54 admits only callers who hold every field', async () => {
    const { audits } = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.admin });
    const { server, base } = startApp();
    try {
      const body = (await (await exportFor(base, admin)).json()) as {
        fields: Record<string, string | null>;
      };
      // The sensitive fields are present. The redaction is a pure function in
      // shared with no caller on this route — proved there, not here.
      expect(body.fields.dateOfBirth).toBe('1990-04-17');
      expect(body.fields.addressStreet).toBe('12 Mill Road');
      expect(body.fields.ethnicity).toBe('Aboriginal');
      expect(audits.some((a) => a.action === 'Exported member record')).toBe(true);
    } finally {
      server.close();
    }
  });

  it('refuses an ASSESSOR whom the defaults admit to the record in full (AE25)', async () => {
    /*
      The assessor default is a read of every section plus approval, so this
      caller sees the whole record on the profile route — and still cannot
      export it. Export is not a stronger read; it is a different act.
    */
    const { audits } = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.assessor });
    const { server, base } = startApp();
    try {
      expect((await exportFor(base, assessor)).status).toBe(403);
      expect(audits.some((a) => a.action === 'Exported member record')).toBe(false);
    } finally {
      server.close();
    }
  });

  it('refuses the CANDIDATE reading their own record in full (R54)', async () => {
    fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.candidate });
    const { server, base } = startApp();
    try {
      expect((await exportFor(base, subjectCandidate)).status).toBe(403);
      expect((await exportFor(base, otherCandidate)).status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('refuses even where the organisation has loosened the matrix as far as it goes', async () => {
    // No matrix setting grants export, so a fully-open `profiles` category
    // changes nothing here. The tempting implementation is an `export` action
    // on the category, and this is why it would be wrong.
    fakeDb({
      matrix: {
        ...DEFAULT_ROLE_PERMISSIONS.assessor,
        profiles: { view: true, edit: true, approve: true, view_documents: true, view_competencies: true },
      } as PermissionMatrix,
    });
    const { server, base } = startApp();
    try {
      expect((await exportFor(base, assessor)).status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('lets an OWNER export, as the level holding everything Admin holds', async () => {
    fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.owner });
    const owner = { userId: 'u-owner', orgId: ORG, role: 'owner' as const };
    const { server, base } = startApp();
    try {
      expect((await exportFor(base, owner)).status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('carries only the documents the record currently stands on (R31, R32)', async () => {
    // A superseded or removed document is RETAINED as history but is not what
    // this person holds today, and exporting it would misrepresent them.
    fakeDb({
      matrix: DEFAULT_ROLE_PERMISSIONS.admin,
      grants: [GRANT],
      documents: [
        HELD_DOC,
        { ...HELD_DOC, id: 'doc-old', state: 'superseded' },
        { ...HELD_DOC, id: 'doc-gone', state: 'removed' },
      ],
      competencies: [COMPETENCY],
    });
    const { server, base } = startApp();
    try {
      const body = (await (await exportFor(base, admin)).json()) as { documents: Array<{ id: string }> };
      expect(body.documents.map((d) => d.id)).toEqual(['doc-1']);
    } finally {
      server.close();
    }
  });

  it('404s for a membership belonging to another organisation', async () => {
    fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.admin, membershipOrg: 'org-2' });
    const { server, base } = startApp();
    try {
      expect((await exportFor(base, admin)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe('the tier gate reaches every profile surface', () => {
  /*
    `resolveProfileAccess` applies it for the record's own reads and writes, but
    the unreachable mark and the export are Admin acts that need no matrix
    resolution and so do not pass through it. An organisation below the tier
    that carries assessments holds no profiles at all — neither route may be its
    way in, and a passing suite does not prove a gate exists unless something
    asserts it.
  */
  const belowTier = { planTier: 'individual' as const, matrix: DEFAULT_ROLE_PERMISSIONS.admin };

  it('refuses the unreachable mark below the tier', async () => {
    const { updates } = fakeDb(belowTier);
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/profiles/${SUBJECT_MEMBERSHIP}/unreachable`, {
        method: 'PUT',
        headers: { ...authHeader(admin), 'content-type': 'application/json' },
        body: JSON.stringify({ unreachable: true }),
      });
      expect(res.status).toBe(403);
      expect(updates).toHaveLength(0);
    } finally {
      server.close();
    }
  });

  it('refuses the export below the tier, and records nothing', async () => {
    const { audits } = fakeDb(belowTier);
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/profiles/${SUBJECT_MEMBERSHIP}/export`, {
        headers: authHeader(admin),
      });
      expect(res.status).toBe(403);
      expect(audits.some((a) => a.action === 'Exported member record')).toBe(false);
    } finally {
      server.close();
    }
  });

  it('admits both on a tier that carries assessments', async () => {
    // The other half of the assertion: the gate refuses the right tier rather
    // than refusing everything.
    fakeDb({ planTier: 'business', matrix: DEFAULT_ROLE_PERMISSIONS.admin });
    const { server, base } = startApp();
    try {
      expect((await fetch(`${base}/profiles/${SUBJECT_MEMBERSHIP}/export`, { headers: authHeader(admin) })).status).toBe(200);
    } finally {
      server.close();
    }
  });
});
