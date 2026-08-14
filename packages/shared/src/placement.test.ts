import { describe, expect, it } from 'vitest';
import { validatePlacement, type PlacementContext } from './placement.js';

// Operations allows several Roles; Maintenance allows one. Two active sites —
// the offer set a location must be in since U5 (locations confer requirements).
const ctx: PlacementContext = {
  locations: [{ id: 'site-a' }, { id: 'site-b' }],
  departments: [
    { id: 'ops', allowsMultipleRoles: true },
    { id: 'maint', allowsMultipleRoles: false },
  ],
  roles: [
    { id: 'dozer', departmentId: 'ops' },
    { id: 'grader', departmentId: 'ops' },
    { id: 'loader', departmentId: 'ops' },
    { id: 'fitter', departmentId: 'maint' },
    { id: 'welder', departmentId: 'maint' },
  ],
};

describe('validatePlacement — Location precondition (R21, U11)', () => {
  it('refuses a placement with no Location', () => {
    const r = validatePlacement({ locationIds: [], departmentIds: ['ops'], roleIds: ['dozer'] }, ctx);
    expect(r).toEqual({ ok: false, error: { code: 'no_location' } });
  });

  it('accepts a placement carrying a Location', () => {
    const r = validatePlacement({ locationIds: ['site-a'], departmentIds: ['ops'], roleIds: ['dozer'] }, ctx);
    expect(r.ok).toBe(true);
  });
});

describe('validatePlacement — Location offer set (U5)', () => {
  it('refuses a Location outside the offer set — retired reads the same as unknown', () => {
    // Locations confer requirements now (R3), and a retired one confers
    // nothing (the U4 split) — so a NEW placement onto one is refused rather
    // than silently written; the escape hatch for a member already there is
    // the caller's held-value widening, not this validator.
    const r = validatePlacement(
      { locationIds: ['site-a', 'site-retired'], departmentIds: ['ops'], roleIds: ['dozer'] },
      ctx,
    );
    expect(r).toEqual({ ok: false, error: { code: 'unknown_location', subjectId: 'site-retired' } });
  });

  it('accepts a held retired Location the caller widened into the context', () => {
    // The admitHeldRoles-mirroring widening: the caller unions what the member
    // already holds into the offer set, so the same input passes.
    const widened = { ...ctx, locations: [...ctx.locations, { id: 'site-retired' }] };
    const r = validatePlacement(
      { locationIds: ['site-a', 'site-retired'], departmentIds: ['ops'], roleIds: ['dozer'] },
      widened,
    );
    expect(r.ok).toBe(true);
  });
});

describe('validatePlacement — offer set (R5)', () => {
  it('refuses a Role only another Department offers', () => {
    const r = validatePlacement(
      { locationIds: ['site-a'], departmentIds: ['maint'], roleIds: ['dozer'] },
      ctx,
    );
    expect(r).toEqual({ ok: false, error: { code: 'role_not_offered', subjectId: 'dozer' } });
  });

  it('accepts a Role either placed Department offers, combining not intersecting', () => {
    const r = validatePlacement(
      { locationIds: ['site-a'], departmentIds: ['ops', 'maint'], roleIds: ['dozer', 'fitter'] },
      ctx,
    );
    expect(r.ok).toBe(true);
  });

  it('refuses a Role that does not exist', () => {
    const r = validatePlacement(
      { locationIds: ['site-a'], departmentIds: ['ops'], roleIds: ['ghost'] },
      ctx,
    );
    expect(r).toEqual({ ok: false, error: { code: 'unknown_role', subjectId: 'ghost' } });
  });
});

describe('validatePlacement — per-Department count (R6)', () => {
  it('allows several Operations Roles when Operations allows several', () => {
    const r = validatePlacement(
      { locationIds: ['site-a'], departmentIds: ['ops'], roleIds: ['dozer', 'grader', 'loader'] },
      ctx,
    );
    expect(r.ok).toBe(true);
  });

  it('refuses a second Maintenance Role when Maintenance allows one', () => {
    const r = validatePlacement(
      { locationIds: ['site-a'], departmentIds: ['maint'], roleIds: ['fitter', 'welder'] },
      ctx,
    );
    expect(r).toEqual({ ok: false, error: { code: 'too_many_roles', subjectId: 'maint' } });
  });

  it('reads each Department`s count against its own setting only', () => {
    // Several Operations Roles AND exactly one Maintenance Role — no contradiction.
    const r = validatePlacement(
      {
        locationIds: ['site-a'],
        departmentIds: ['ops', 'maint'],
        roleIds: ['dozer', 'grader', 'fitter'],
      },
      ctx,
    );
    expect(r.ok).toBe(true);
  });

  it('does not let one Department`s several-setting excuse another`s overflow', () => {
    // ops several is fine; maint gets two → still refused on maint alone.
    const r = validatePlacement(
      {
        locationIds: ['site-a'],
        departmentIds: ['ops', 'maint'],
        roleIds: ['dozer', 'grader', 'fitter', 'welder'],
      },
      ctx,
    );
    expect(r).toEqual({ ok: false, error: { code: 'too_many_roles', subjectId: 'maint' } });
  });
});
