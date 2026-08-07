import { describe, expect, it } from 'vitest';
import type { Db } from '@formai/db';
import { identifyMember, loadDisplayIdentities } from './display-identity.js';

/**
 * A hand-rolled db double over the three reads the resolver makes. The API
 * suite has no live database (see the harness note in the org-settings work), so
 * every lib test here shapes its own fixture rather than sharing a store.
 */
function fakeDb(opts: {
  displayIdentifier?: 'employee_number' | 'swipe_card_number';
  memberships?: Array<{ id: string; userId: string; orgId: string }>;
  profiles?: Array<{
    membershipId: string;
    firstName: string;
    lastName: string;
    employeeNumber?: string | null;
    swipeCardNumber?: string | null;
  }>;
  orgMissing?: boolean;
}): Db {
  /*
    The resolver narrows by the ids it was given, so the double has to as well —
    a fixture that returns every row regardless would let a "resolves one person"
    assertion pass against a query that fetched the whole organisation.
    `requested` captures the id list drizzle would have put in the `inArray`.
  */
  let requestedMembershipIds: string[] = [];
  return {
    query: {
      organizations: {
        findFirst: async () =>
          opts.orgMissing ? undefined : { displayIdentifier: opts.displayIdentifier ?? 'employee_number' },
      },
      memberships: {
        findMany: async () => {
          const rows = (opts.memberships ?? []).filter((m) => requestedUserIds.includes(m.userId));
          requestedMembershipIds = rows.map((m) => m.id);
          return rows;
        },
      },
      memberProfiles: {
        findMany: async () => (opts.profiles ?? []).filter((p) => requestedMembershipIds.includes(p.membershipId)),
      },
    },
  } as unknown as Db;
}

/** The user ids the current `loadDisplayIdentities` call asked for. */
let requestedUserIds: string[] = [];

/** Calls the resolver with the double primed to narrow the way drizzle would. */
async function resolve(db: Db, orgId: string, userIds: string[]) {
  requestedUserIds = userIds;
  return loadDisplayIdentities(db, orgId, userIds);
}

const MEMBERSHIPS = [
  { id: 'm-1', userId: 'u-1', orgId: 'org-1' },
  { id: 'm-2', userId: 'u-2', orgId: 'org-1' },
  { id: 'm-3', userId: 'u-3', orgId: 'org-1' },
];

/** AE22: three members sharing a name, holding between them both numbers, one, and neither. */
const CHRIS_TAYLORS = [
  { membershipId: 'm-1', firstName: 'Chris', lastName: 'Taylor', employeeNumber: 'E100', swipeCardNumber: null },
  { membershipId: 'm-2', firstName: 'Chris', lastName: 'Taylor', employeeNumber: null, swipeCardNumber: 'S900' },
  { membershipId: 'm-3', firstName: 'Chris', lastName: 'Taylor', employeeNumber: null, swipeCardNumber: null },
];

describe('loadDisplayIdentities', () => {
  it('resolves each member against the organisation choice, falling back per person', async () => {
    const lookup = await resolve(
      fakeDb({ displayIdentifier: 'employee_number', memberships: MEMBERSHIPS, profiles: CHRIS_TAYLORS }),
      'org-1',
      ['u-1', 'u-2', 'u-3'],
    );

    expect(lookup.byUserId.get('u-1')?.identifier).toBe('E100');
    // Holds only the number the organisation did NOT choose — shown by that one.
    expect(lookup.byUserId.get('u-2')?.identifier).toBe('S900');
    expect(lookup.byUserId.get('u-2')?.fellBack).toBe(true);
    // Holds neither — the name stands alone until one is issued.
    expect(lookup.byUserId.get('u-3')?.identifier).toBeNull();
  });

  it('follows the organisation setting when it names the swipe card number', async () => {
    const lookup = await resolve(
      fakeDb({ displayIdentifier: 'swipe_card_number', memberships: MEMBERSHIPS, profiles: CHRIS_TAYLORS }),
      'org-1',
      ['u-1', 'u-2'],
    );
    expect(lookup.byUserId.get('u-2')?.identifier).toBe('S900');
    expect(lookup.byUserId.get('u-2')?.fellBack).toBe(false);
    // The one holding only an employee number now falls back the other way.
    expect(lookup.byUserId.get('u-1')?.identifier).toBe('E100');
    expect(lookup.byUserId.get('u-1')?.fellBack).toBe(true);
  });

  it('defaults to the employee number when the organisation row carries no choice', async () => {
    const lookup = await resolve(
      fakeDb({ orgMissing: true, memberships: MEMBERSHIPS, profiles: CHRIS_TAYLORS }),
      'org-1',
      ['u-1'],
    );
    expect(lookup.choice).toBe('employee_number');
  });

  it('returns an empty lookup for an organisation whose members hold no profiles yet', async () => {
    // The ordinary state until the workforce is entered or imported. A surface
    // that names people must keep working through it.
    const lookup = await resolve(
      fakeDb({ memberships: MEMBERSHIPS, profiles: [] }),
      'org-1',
      ['u-1'],
    );
    expect(lookup.byUserId.size).toBe(0);
  });

  it('asks for nothing when given no user ids', async () => {
    const lookup = await resolve(fakeDb({}), 'org-1', []);
    expect(lookup.byUserId.size).toBe(0);
  });

  it('resolves a repeated user id once', async () => {
    const lookup = await resolve(
      fakeDb({ memberships: MEMBERSHIPS, profiles: CHRIS_TAYLORS }),
      'org-1',
      ['u-1', 'u-1', 'u-1'],
    );
    expect(lookup.byUserId.size).toBe(1);
  });
});

describe('identifyMember', () => {
  it('prefers the profile display name over the product-wide user name', async () => {
    // R3's display name is built from first and last names an Admin corrects per
    // organisation; `users.name` is one string no organisation owns.
    const lookup = await resolve(
      fakeDb({ memberships: MEMBERSHIPS, profiles: CHRIS_TAYLORS }),
      'org-1',
      ['u-1'],
    );
    expect(identifyMember(lookup, 'u-1', 'C. Taylor (stale)')).toEqual({
      name: 'Chris Taylor',
      identifier: 'E100',
    });
  });

  it('falls back to the name the surface already had when no profile exists', async () => {
    const lookup = await resolve(fakeDb({ memberships: MEMBERSHIPS, profiles: [] }), 'org-1', ['u-1']);
    expect(identifyMember(lookup, 'u-1', 'Chris Taylor')).toEqual({
      name: 'Chris Taylor',
      identifier: null,
    });
  });

  it('handles a null user id, as a pending invite carries', async () => {
    const lookup = await resolve(fakeDb({}), 'org-1', []);
    expect(identifyMember(lookup, null, 'Pending invite')).toEqual({
      name: 'Pending invite',
      identifier: null,
    });
  });
});
