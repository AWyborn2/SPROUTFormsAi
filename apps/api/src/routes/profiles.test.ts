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
      users: { findFirst: vi.fn().mockResolvedValue({ id: admin.userId, name: 'Admin' }) },
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
