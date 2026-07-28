/**
 * The API-layer split between "granted org-wide" and "granted for own records".
 *
 * `resolveScope` itself is exercised in @formai/shared; what matters here is
 * that the two exported wrappers disagree in the one way they must — a scoped
 * grant is DENIED to `hasPermission` (the question every pre-scoping route
 * asks) while `permissionScope` reports it as `own`. If they ever agreed, a
 * candidate would either see nothing or see the whole org.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@formai/db';
import type { PermissionMatrix } from '@formai/shared';

let mockDbValue: Db | null = null;
vi.mock('../db.js', () => ({
  get db() {
    return mockDbValue;
  },
  getDbStatus: () => 'unconfigured',
}));

const { hasPermission, permissionScope } = await import('./permissions.js');

const tenant = { orgId: 'org-1', role: 'candidate' };

function dbWithMatrix(matrix: PermissionMatrix | undefined) {
  return {
    query: {
      rolePermissions: {
        findFirst: vi.fn().mockResolvedValue(matrix ? { matrix } : undefined),
      },
    },
  } as unknown as Db;
}

const scoped = { assessments: { view: 'own' } } as unknown as PermissionMatrix;
const orgWide = { assessments: { view: true } } as unknown as PermissionMatrix;

afterEach(() => {
  vi.clearAllMocks();
  mockDbValue = null;
});

describe('hasPermission', () => {
  it('denies a scoped grant so pre-scoping call sites fail closed', async () => {
    mockDbValue = dbWithMatrix(scoped);

    expect(await hasPermission(tenant, 'assessments', 'view')).toBe(false);
  });

  it('allows an org-wide grant', async () => {
    mockDbValue = dbWithMatrix(orgWide);

    expect(await hasPermission(tenant, 'assessments', 'view')).toBe(true);
  });

  it('denies when there is no matrix row', async () => {
    mockDbValue = dbWithMatrix(undefined);

    expect(await hasPermission(tenant, 'assessments', 'view')).toBe(false);
  });

  it('denies when the database is unavailable', async () => {
    mockDbValue = null;

    expect(await hasPermission(tenant, 'assessments', 'view')).toBe(false);
  });
});

describe('permissionScope', () => {
  it('reports a scoped grant as own', async () => {
    mockDbValue = dbWithMatrix(scoped);

    expect(await permissionScope(tenant, 'assessments', 'view')).toBe('own');
  });

  it('reports an org-wide grant as all', async () => {
    mockDbValue = dbWithMatrix(orgWide);

    expect(await permissionScope(tenant, 'assessments', 'view')).toBe('all');
  });

  it('reports an unset action as none', async () => {
    mockDbValue = dbWithMatrix(orgWide);

    expect(await permissionScope(tenant, 'assessments', 'delete')).toBe('none');
  });

  it('reports none when the database is unavailable', async () => {
    mockDbValue = null;

    expect(await permissionScope(tenant, 'assessments', 'view')).toBe('none');
  });
});
