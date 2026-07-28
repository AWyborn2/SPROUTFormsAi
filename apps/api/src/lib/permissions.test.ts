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

  it('denies when the database is unavailable', async () => {
    mockDbValue = null;

    expect(await hasPermission(tenant, 'assessments', 'view')).toBe(false);
  });

  it('denies an unknown role with no stored row', async () => {
    mockDbValue = dbWithMatrix(undefined);

    expect(await hasPermission({ orgId: 'org-1', role: 'wizard' }, 'assessments', 'view')).toBe(
      false,
    );
  });
});

/**
 * A known role with no stored row resolves to the product default.
 *
 * This is what seeds roles added after an org was created — PostgreSQL forbids
 * using an enum value in the transaction that added it, and drizzle applies all
 * pending migrations in one transaction, so new-role matrices cannot be
 * backfilled in SQL beside the enum change. These pin that the fallback is
 * narrow: known roles only, and never when the database is unreachable.
 */
describe('default-matrix fallback', () => {
  it('resolves a known role with no stored row to its product default', async () => {
    mockDbValue = dbWithMatrix(undefined);

    // The candidate default is own-scoped, so it must read as own — not as
    // denied (the pre-fallback behaviour) and not as org-wide.
    expect(await permissionScope(tenant, 'assessments', 'view')).toBe('own');
    expect(await hasPermission(tenant, 'assessments', 'view')).toBe(false);
  });

  it('gives an unseeded assessor org-wide assessment access', async () => {
    mockDbValue = dbWithMatrix(undefined);

    expect(await hasPermission({ orgId: 'org-1', role: 'assessor' }, 'assessments', 'create')).toBe(
      true,
    );
  });

  it('prefers a stored row over the default when one exists', async () => {
    mockDbValue = dbWithMatrix(orgWide);

    expect(await permissionScope(tenant, 'assessments', 'view')).toBe('all');
  });

  it('does not fall back for an unknown role', async () => {
    mockDbValue = dbWithMatrix(undefined);

    expect(await permissionScope({ orgId: 'org-1', role: 'wizard' }, 'assessments', 'view')).toBe(
      'none',
    );
  });

  it('does not fall back when the database is unavailable', async () => {
    mockDbValue = null;

    expect(await permissionScope({ orgId: 'org-1', role: 'assessor' }, 'assessments', 'create')).toBe(
      'none',
    );
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
