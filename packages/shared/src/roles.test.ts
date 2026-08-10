/**
 * Two jobs here.
 *
 * CHARACTERIZATION: the five original roles had their capability matrix fixed
 * long before `'own'` existed. Widening the matrix value type must not move any
 * of them, so their grants are pinned here first — a diff in these tests means
 * the widening changed existing access, which is the failure mode the whole
 * fail-closed design exists to prevent (U2, R25).
 *
 * NEW BEHAVIOUR: `'own'` must read as DENIED through the old boolean path.
 * Every pre-existing call site tests the matrix for a true value, so a scoped
 * grant they don't understand has to fail closed rather than read as full
 * access.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROLE_PERMISSIONS,
  matrixAllows,
  PERMISSION_CATEGORIES,
  resolveScope,
  ROLES,
  type PermissionMatrix,
} from './roles.js';

describe('existing role grants (characterization)', () => {
  it('keeps owner and admin fully privileged on forms and submissions', () => {
    for (const role of ['owner', 'admin'] as const) {
      const m = DEFAULT_ROLE_PERMISSIONS[role];
      expect(m.forms).toMatchObject({ view: true, create: true, edit: true, delete: true });
      expect(m.submissions).toMatchObject({ view: true, export: true, delete: true });
      expect(m.team).toMatchObject({ view: true, invite: true, manage: true });
      expect(m.audit).toMatchObject({ view: true });
    }
  });

  it('keeps billing manage as the owner/admin difference', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.owner.billing).toMatchObject({ view: true, manage: true });
    expect(DEFAULT_ROLE_PERMISSIONS.admin.billing).toMatchObject({ view: true, manage: false });
  });

  it('keeps builder able to create forms but not delete them', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.builder.forms).toMatchObject({
      view: true,
      create: true,
      edit: true,
      delete: false,
    });
    expect(DEFAULT_ROLE_PERMISSIONS.builder.audit).toMatchObject({ view: false });
  });

  it('keeps reviewer read-and-export with audit visibility', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.reviewer.forms).toMatchObject({ create: false, edit: false });
    expect(DEFAULT_ROLE_PERMISSIONS.reviewer.submissions).toMatchObject({ view: true, export: true });
    expect(DEFAULT_ROLE_PERMISSIONS.reviewer.audit).toMatchObject({ view: true });
  });

  it('keeps viewer the weakest role', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.viewer.submissions).toMatchObject({ view: true, export: false });
    expect(DEFAULT_ROLE_PERMISSIONS.viewer.team).toMatchObject({ view: false });
  });

  it('still grants every original role org-wide submission visibility', () => {
    // This is the property that made a candidate role necessary: no existing
    // role can be narrowed to its own records.
    for (const role of ['owner', 'admin', 'builder', 'reviewer', 'viewer'] as const) {
      expect(DEFAULT_ROLE_PERMISSIONS[role].submissions?.view).toBe(true);
    }
  });
});

describe('matrixAllows', () => {
  const matrix = (v: unknown): PermissionMatrix =>
    ({ submissions: { view: v } }) as unknown as PermissionMatrix;

  it('allows a true grant', () => {
    expect(matrixAllows(matrix(true), 'submissions', 'view')).toBe(true);
  });

  it('denies a scoped grant, so legacy call sites fail closed', () => {
    expect(matrixAllows(matrix('own'), 'submissions', 'view')).toBe(false);
  });

  it('denies false, an unset action, and a missing category', () => {
    expect(matrixAllows(matrix(false), 'submissions', 'view')).toBe(false);
    expect(matrixAllows(matrix(true), 'submissions', 'delete')).toBe(false);
    expect(matrixAllows({} as PermissionMatrix, 'submissions', 'view')).toBe(false);
  });
});

describe('resolveScope', () => {
  const matrix = (v: unknown): PermissionMatrix =>
    ({ submissions: { view: v } }) as unknown as PermissionMatrix;

  it('resolves a true grant to all', () => {
    expect(resolveScope(matrix(true), 'submissions', 'view')).toBe('all');
  });

  it('resolves a scoped grant to own', () => {
    expect(resolveScope(matrix('own'), 'submissions', 'view')).toBe('own');
  });

  it('resolves false, unset and missing to none', () => {
    expect(resolveScope(matrix(false), 'submissions', 'view')).toBe('none');
    expect(resolveScope(matrix(true), 'submissions', 'delete')).toBe('none');
    expect(resolveScope({} as PermissionMatrix, 'submissions', 'view')).toBe('none');
  });

  it('treats an unrecognised value as none rather than guessing', () => {
    expect(resolveScope(matrix('everything'), 'submissions', 'view')).toBe('none');
  });
});

describe('new roles', () => {
  it('registers assessor and candidate', () => {
    expect(ROLES).toContain('assessor');
    expect(ROLES).toContain('candidate');
  });

  it('gives every role an entry for every category', () => {
    for (const role of ROLES) {
      for (const category of PERMISSION_CATEGORIES) {
        expect(DEFAULT_ROLE_PERMISSIONS[role][category]).toBeDefined();
      }
    }
  });

  it('scopes the candidate to its own assessment records only', () => {
    const m = DEFAULT_ROLE_PERMISSIONS.candidate;

    expect(resolveScope(m, 'assessments', 'view')).toBe('own');
    expect(resolveScope(m, 'assessments', 'edit')).toBe('own');
    expect(matrixAllows(m, 'assessments', 'view')).toBe(false);
  });

  it('denies the candidate everything outside its own records', () => {
    const m = DEFAULT_ROLE_PERMISSIONS.candidate;

    expect(resolveScope(m, 'submissions', 'view')).toBe('none');
    expect(resolveScope(m, 'team', 'view')).toBe('none');
    expect(resolveScope(m, 'billing', 'view')).toBe('none');
    expect(resolveScope(m, 'audit', 'view')).toBe('none');
    expect(resolveScope(m, 'assessments', 'delete')).toBe('none');
  });

  it('gives the assessor org-wide assessment create and edit', () => {
    const m = DEFAULT_ROLE_PERMISSIONS.assessor;

    expect(resolveScope(m, 'assessments', 'view')).toBe('all');
    expect(resolveScope(m, 'assessments', 'create')).toBe('all');
    expect(resolveScope(m, 'assessments', 'edit')).toBe('all');
    expect(matrixAllows(m, 'assessments', 'view')).toBe(true);
  });

  it('does not give the assessor team or billing management', () => {
    const m = DEFAULT_ROLE_PERMISSIONS.assessor;

    expect(matrixAllows(m, 'team', 'manage')).toBe(false);
    expect(matrixAllows(m, 'billing', 'manage')).toBe(false);
  });

  it('leaves the original roles without assessment create rights', () => {
    for (const role of ['builder', 'reviewer', 'viewer'] as const) {
      expect(matrixAllows(DEFAULT_ROLE_PERMISSIONS[role], 'assessments', 'create')).toBe(false);
    }
  });
});

describe('profiles category (R33, R34, R35)', () => {
  it('carries a profiles grant for every access level', () => {
    for (const role of ROLES) {
      expect(DEFAULT_ROLE_PERMISSIONS[role].profiles).toBeDefined();
    }
  });

  it('admits an assessor to view profiles and approve documents, but not edit (R35)', () => {
    const p = DEFAULT_ROLE_PERMISSIONS.assessor.profiles;
    expect(matrixAllows(DEFAULT_ROLE_PERMISSIONS.assessor, 'profiles', 'view')).toBe(true);
    expect(matrixAllows(DEFAULT_ROLE_PERMISSIONS.assessor, 'profiles', 'approve')).toBe(true);
    expect(p?.edit).toBe(false);
  });

  it('grants a candidate nothing through the category — own-record access is outside it (R36)', () => {
    expect(matrixAllows(DEFAULT_ROLE_PERMISSIONS.candidate, 'profiles', 'view')).toBe(false);
    expect(matrixAllows(DEFAULT_ROLE_PERMISSIONS.candidate, 'profiles', 'approve')).toBe(false);
  });

  it('leaves every pre-existing category denying the new approve action (R34)', () => {
    for (const role of ROLES) {
      for (const category of ['forms', 'submissions', 'team', 'billing', 'audit', 'assessments'] as const) {
        expect(matrixAllows(DEFAULT_ROLE_PERMISSIONS[role], category, 'approve')).toBe(false);
      }
    }
  });

  it('never grants export through the category — export stays Admin-only (R34)', () => {
    // The profiles category grants view/edit/approve; exporting a member's
    // record is not one of its switches, so no level is granted it here.
    for (const role of ROLES) {
      expect(matrixAllows(DEFAULT_ROLE_PERMISSIONS[role], 'profiles', 'export')).toBe(false);
    }
  });
});
