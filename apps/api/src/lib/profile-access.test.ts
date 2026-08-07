import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS, type PermissionMatrix } from '@formai/shared';

let mockDbValue: unknown = null;
vi.mock('../db.js', () => ({
  get db() {
    return mockDbValue;
  },
  getDbStatus: () => 'unconfigured',
}));

const { resolveProfileAccess, tierCarriesProfiles } = await import('./profile-access.js');

const ORG = 'org-1';

/**
 * A db double over the two reads the resolution makes — the organisation row
 * (for the tier gate) and the caller's stored matrix.
 *
 * `permissionScope` reads the matrix through `../db.js`, which is why the module
 * mock above is set as well as the handle passed in.
 */
function fakeDb(opts: { planTier?: string; matrix?: PermissionMatrix | undefined; noRow?: boolean }) {
  const db = {
    query: {
      organizations: {
        findFirst: async () => ({ id: ORG, planTier: opts.planTier ?? 'business' }),
      },
      rolePermissions: {
        findFirst: async () => (opts.noRow ? undefined : { matrix: opts.matrix }),
      },
      memberships: { findFirst: async () => undefined },
    },
  };
  mockDbValue = db;
  return db as never;
}

const SUBJECT = { id: 'm-1', userId: 'u-1', orgId: ORG };

describe('the tier gate', () => {
  it('admits a tier that carries assessments and refuses one that does not', () => {
    // A profile points at Locations, Departments and Roles a lower tier cannot
    // create, so it is gated to the same tier as the taxonomy it depends on.
    expect(tierCarriesProfiles('business')).toBe(true);
    expect(tierCarriesProfiles('enterprise')).toBe(true);
    expect(tierCarriesProfiles('team')).toBe(false);
    expect(tierCarriesProfiles('individual')).toBe(false);
  });

  it('reaches no profile at all below that tier, whatever the matrix says', async () => {
    const db = fakeDb({ planTier: 'team', matrix: DEFAULT_ROLE_PERMISSIONS.admin });
    const access = await resolveProfileAccess(db, { orgId: ORG, userId: 'u-9', role: 'admin' }, SUBJECT);
    expect(access.canView).toBe(false);
    expect(access.editableFields).toEqual([]);
  });
});

describe('the subject branch — the candidate’s alone', () => {
  const CANDIDATE = { orgId: ORG, userId: 'u-1', role: 'candidate' };

  it('reads every field on their own record, including the sensitive ones', async () => {
    // AE51 / R49: fixed rather than configured — the matrix here grants nothing.
    const db = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.candidate });
    const access = await resolveProfileAccess(db, CANDIDATE, SUBJECT);
    expect(access.canView).toBe(true);
    expect(access.isSubject).toBe(true);
  });

  it('opens every document held on their own record (R50)', async () => {
    const db = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.candidate });
    const access = await resolveProfileAccess(db, CANDIDATE, SUBJECT);
    expect(access.canViewDocuments).toBe(true);
    expect(access.canViewCompetencies).toBe(true);
  });

  it('writes their mobile, address and emergency contact, and nothing else (R51)', async () => {
    const db = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.candidate });
    const access = await resolveProfileAccess(db, CANDIDATE, SUBJECT);
    expect([...access.editableFields].sort()).toEqual(
      ['addressStreet', 'emergencyContactName', 'emergencyContactPhone', 'mobile', 'postcode', 'suburb'].sort(),
    );
    // AE2 / R53: the identifiers are the organisation's to issue and correct.
    expect(access.editableFields).not.toContain('employeeNumber');
    expect(access.editableFields).not.toContain('dateOfBirth');
  });

  it('never approves — a replacement they supply waits for somebody else (R52)', async () => {
    const db = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.candidate });
    const access = await resolveProfileAccess(db, CANDIDATE, SUBJECT);
    expect(access.canApprove).toBe(false);
  });

  it('survives an organisation tightening its matrix as far as it goes', async () => {
    // AE51: no setting takes the candidate's own read away.
    const stripped = {
      ...DEFAULT_ROLE_PERMISSIONS.candidate,
      profiles: { view: false, edit: false, approve: false, view_documents: false, view_competencies: false },
    };
    const db = fakeDb({ matrix: stripped as PermissionMatrix });
    const access = await resolveProfileAccess(db, CANDIDATE, SUBJECT);
    expect(access.canView).toBe(true);
    expect(access.canViewDocuments).toBe(true);
  });

  it('does NOT apply to a candidate reading somebody else’s record', async () => {
    const db = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.candidate });
    const access = await resolveProfileAccess(db, CANDIDATE, { id: 'm-2', userId: 'u-2', orgId: ORG });
    expect(access.isSubject).toBe(false);
    expect(access.canView).toBe(false);
  });
});

describe('the matrix branch — everybody else, including on their own record', () => {
  it('sends a NON-candidate reading their own record through the matrix', async () => {
    /*
      The line that keeps the fixed rule a protection rather than a hole:
      whatever an organisation admits an access level to includes that access
      level's own record.
    */
    const db = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.assessor });
    const access = await resolveProfileAccess(db, { orgId: ORG, userId: 'u-1', role: 'assessor' }, SUBJECT);
    expect(access.isSubject).toBe(false);
    expect(access.canView).toBe(true);
  });

  it('gives an assessor the shipped default — view, competencies, documents, approve, no edit', async () => {
    // AE1 / R41, R42, R55.
    const db = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.assessor });
    const access = await resolveProfileAccess(db, { orgId: ORG, userId: 'u-9', role: 'assessor' }, SUBJECT);
    expect(access).toMatchObject({
      canView: true,
      canViewCompetencies: true,
      canViewDocuments: true,
      canApprove: true,
      editableFields: [],
    });
  });

  it('hides the profile from an assessor in an organisation that has tightened it', async () => {
    // AE29: the same assessor on the defaults would see it.
    const tightened = {
      ...DEFAULT_ROLE_PERMISSIONS.assessor,
      profiles: { view: false, edit: false, approve: true, view_documents: true, view_competencies: true },
    };
    const db = fakeDb({ matrix: tightened as PermissionMatrix });
    const access = await resolveProfileAccess(db, { orgId: ORG, userId: 'u-9', role: 'assessor' }, SUBJECT);
    expect(access.canView).toBe(false);
  });

  it('leaves documents reachable when only FIELDS are restricted (R44)', async () => {
    // The configuration R44 exists to allow: assessors kept out of personal
    // details but still approving certificates.
    const tightened = {
      ...DEFAULT_ROLE_PERMISSIONS.assessor,
      profiles: { view: false, edit: false, approve: true, view_documents: true, view_competencies: false },
    };
    const db = fakeDb({ matrix: tightened as PermissionMatrix });
    const access = await resolveProfileAccess(db, { orgId: ORG, userId: 'u-9', role: 'assessor' }, SUBJECT);
    expect(access.canView).toBe(false);
    expect(access.canViewDocuments).toBe(true);
    expect(access.canApprove).toBe(true);
  });

  it('leaves competencies reachable when only fields are restricted (R41, R55)', async () => {
    const tightened = {
      ...DEFAULT_ROLE_PERMISSIONS.assessor,
      profiles: { view: false, edit: false, approve: false, view_documents: false, view_competencies: true },
    };
    const db = fakeDb({ matrix: tightened as PermissionMatrix });
    const access = await resolveProfileAccess(db, { orgId: ORG, userId: 'u-9', role: 'assessor' }, SUBJECT);
    expect(access.canViewCompetencies).toBe(true);
    expect(access.canViewDocuments).toBe(false);
  });

  it('does not grant approve to an access level granted only view (R39)', async () => {
    const viewOnly = {
      ...DEFAULT_ROLE_PERMISSIONS.assessor,
      profiles: { view: true, edit: false, approve: false, view_documents: true, view_competencies: true },
    };
    const db = fakeDb({ matrix: viewOnly as PermissionMatrix });
    const access = await resolveProfileAccess(db, { orgId: ORG, userId: 'u-9', role: 'assessor' }, SUBJECT);
    expect(access.canView).toBe(true);
    expect(access.canApprove).toBe(false);
  });

  it('gives an Admin every entered field to write, and never a derived one', async () => {
    const db = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.admin });
    const access = await resolveProfileAccess(db, { orgId: ORG, userId: 'u-9', role: 'admin' }, SUBJECT);
    expect(access.editableFields).toContain('dateOfBirth');
    expect(access.editableFields).toContain('employeeNumber');
    // Derived and generated values are nobody's to write (R3, R15, R21).
    expect(access.editableFields).not.toContain('displayName');
    expect(access.editableFields).not.toContain('indigenousStatus');
    expect(access.editableFields).not.toContain('username');
    // The email lives on `users` and the placement on the membership.
    expect(access.editableFields).not.toContain('email');
    expect(access.editableFields).not.toContain('location');
  });

  it('falls back to the product default for an organisation with no stored row', async () => {
    // The backfill covers stored rows; this is the path that never broke.
    const db = fakeDb({ noRow: true });
    const access = await resolveProfileAccess(db, { orgId: ORG, userId: 'u-9', role: 'assessor' }, SUBJECT);
    expect(access.canView).toBe(true);
    expect(access.canApprove).toBe(true);
  });

  it('denies a stored matrix that predates the category entirely', async () => {
    /*
      The state migration 0042 exists to fix. Documented here so the backfill's
      necessity is visible in a test rather than only in the SQL header: without
      it, this is what every customised organisation gets on the day enforcement
      turns on.
    */
    const legacy = { ...DEFAULT_ROLE_PERMISSIONS.admin } as Record<string, unknown>;
    delete legacy.profiles;
    const db = fakeDb({ matrix: legacy as PermissionMatrix });
    const access = await resolveProfileAccess(db, { orgId: ORG, userId: 'u-9', role: 'admin' }, SUBJECT);
    expect(access.canView).toBe(false);
  });

  it('refuses a subject membership belonging to another organisation', async () => {
    const db = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.admin });
    const access = await resolveProfileAccess(db, { orgId: ORG, userId: 'u-9', role: 'admin' }, {
      id: 'm-9',
      userId: 'u-9',
      orgId: 'org-2',
    });
    expect(access.canView).toBe(false);
  });
});
