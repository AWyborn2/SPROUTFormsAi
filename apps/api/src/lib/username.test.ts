import { describe, expect, it, vi } from 'vitest';
import {
  UsernameExhaustedError,
  backfillUsername,
  insertUserWithUsername,
  splitStoredName,
  usernameCandidate,
  usernameStem,
} from './username.js';
import type { UserDb } from './username.js';

/** The 23505 shape Postgres raises, with the constraint name the retry keys on. */
function uniqueViolation(constraint: string) {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    constraint,
  });
}

/**
 * A db double whose insert fails a given number of times before succeeding.
 * `failures` is a list of constraint names, consumed one per attempt.
 */
function insertingDb(failures: string[] = []) {
  const attempted: string[] = [];
  const surface = {
    insert: () => ({
      values: (v: { username: string }) => ({
        returning: async () => {
          attempted.push(v.username);
          const constraint = failures.shift();
          if (constraint) throw uniqueViolation(constraint);
          return [{ id: 'u-1', ...v }];
        },
      }),
    }),
  };
  // Each issue attempt runs in its own savepoint (a nested transaction), so the
  // double must run the callback rather than throw — modelling the savepoint the
  // retry depends on inside a caller's transaction.
  const db = {
    ...surface,
    transaction: async (fn: (sp: unknown) => Promise<unknown>) => fn(surface),
  } as unknown as UserDb;
  return { db, attempted };
}

describe('usernameStem', () => {
  it('is the first initial and the surname', () => {
    expect(usernameStem('Jane', 'Smith')).toBe('jsmith');
  });

  it('folds case at generation, so the issued credential is what the lookup compares', () => {
    // The email lookup beside it is case-sensitive; folding once here avoids
    // both a brittle identifier and a lookup that could resolve two rows.
    expect(usernameStem('JANE', 'SMITH')).toBe('jsmith');
  });

  it('strips the punctuation real surnames carry', () => {
    expect(usernameStem('Sean', "O'Brien")).toBe('sobrien');
    expect(usernameStem('Alex', 'Smith-Jones')).toBe('asmithjones');
    expect(usernameStem('Piet', 'van der Berg')).toBe('pvanderberg');
  });

  it('strips accents rather than emitting an untypable credential', () => {
    expect(usernameStem('José', 'Muñoz')).toBe('jmunoz');
  });

  it('falls back to a neutral stem for a name that normalises to nothing', () => {
    // The suffix still makes it unique; the alternative is a person with no
    // credential at all, which R21 does not allow for.
    expect(usernameStem('', '')).toBe('user');
    expect(usernameStem('***', '///')).toBe('user');
  });

  it('handles a single-word stored name, which the backfill will hit', () => {
    const { firstName, lastName } = splitStoredName('Cher');
    expect(usernameStem(firstName, lastName)).toBe('c');
  });
});

describe('splitStoredName', () => {
  it('takes the first and last words of an undivided name', () => {
    expect(splitStoredName('Jane Alexandra Smith')).toEqual({ firstName: 'Jane', lastName: 'Smith' });
  });

  it('leaves the surname empty for a single word rather than failing', () => {
    expect(splitStoredName('Cher')).toEqual({ firstName: 'Cher', lastName: '' });
  });

  it('survives extra whitespace and an empty string', () => {
    expect(splitStoredName('  Jane   Smith  ')).toEqual({ firstName: 'Jane', lastName: 'Smith' });
    expect(splitStoredName('')).toEqual({ firstName: '', lastName: '' });
  });
});

describe('usernameCandidate', () => {
  it('is the stem plus a four-digit suffix', () => {
    expect(usernameCandidate('Jane', 'Smith')).toMatch(/^jsmith\d{4}$/);
  });

  it('differs between two people who share a name', () => {
    // AE20: Jane Smith and John Smith in one organisation.
    const many = new Set(Array.from({ length: 50 }, () => usernameCandidate('Jane', 'Smith')));
    expect(many.size).toBeGreaterThan(1);
  });
});

describe('insertUserWithUsername', () => {
  it('issues a username with the row', async () => {
    const { db } = insertingDb();
    const row = await insertUserWithUsername(db, { name: 'Jane Smith', email: 'jane@x.io' });
    expect((row as { username: string }).username).toMatch(/^jsmith\d{4}$/);
  });

  it('re-rolls the suffix on a username collision and succeeds', async () => {
    const { db, attempted } = insertingDb(['users_username_unique', 'users_username_unique']);
    const row = await insertUserWithUsername(db, { name: 'Jane Smith', email: 'jane@x.io' });
    expect(attempted).toHaveLength(3);
    expect(new Set(attempted).size).toBe(3);
    expect((row as { username: string }).username).toBe(attempted[2]);
  });

  it('does NOT re-roll on a duplicate email — a different conflict with a different meaning', async () => {
    // Retrying here would report a username failure for a problem that has
    // nothing to do with one, and would hide the real conflict.
    const { db, attempted } = insertingDb(['users_email_unique']);
    await expect(insertUserWithUsername(db, { name: 'Jane Smith', email: 'taken@x.io' })).rejects.toMatchObject({
      code: '23505',
      constraint: 'users_email_unique',
    });
    expect(attempted).toHaveLength(1);
  });

  it('gives up loudly on a saturated namespace rather than looping', async () => {
    // A backfill over a whole table must fail with something readable rather
    // than hanging mid-migration.
    const { db, attempted } = insertingDb(Array(20).fill('users_username_unique'));
    await expect(insertUserWithUsername(db, { name: 'Jane Smith', email: 'jane@x.io' })).rejects.toBeInstanceOf(
      UsernameExhaustedError,
    );
    expect(attempted.length).toBeLessThan(20);
  });

  it('prefers supplied name parts over splitting the stored name', async () => {
    const { db, attempted } = insertingDb();
    await insertUserWithUsername(
      db,
      { name: 'ignored entirely', email: 'jane@x.io' },
      { firstName: 'Jane', lastName: 'Smith' },
    );
    expect(attempted[0]).toMatch(/^jsmith\d{4}$/);
  });
});

describe('backfillUsername', () => {
  /**
   * A db double over the real chain, which now ends in `.returning()` because
   * the claim is atomic: the UPDATE carries `username IS NULL` and reports what
   * it actually claimed.
   *
   * `claimed: false` models the concurrent loss — the row stopped being null
   * between the caller's read and this write, so the statement matches nothing.
   */
  function updatingDb(opts: { failures?: string[]; claimed?: boolean } = {}) {
    const attempted: string[] = [];
    const failures = [...(opts.failures ?? [])];
    const db = {
      update: () => ({
        set: (v: { username: string }) => ({
          where: () => ({
            returning: async () => {
              attempted.push(v.username);
              const constraint = failures.shift();
              if (constraint) throw uniqueViolation(constraint);
              return opts.claimed === false ? [] : [{ id: 'u-1' }];
            },
          }),
        }),
      }),
    } as unknown as UserDb;
    return { db, attempted };
  }

  it('issues one to a row that has none', async () => {
    const { db } = updatingDb();
    const issued = await backfillUsername(db, { id: 'u-1', name: 'Jane Smith', username: null });
    expect(issued).toMatch(/^jsmith\d{4}$/);
  });

  it('skips a row that already holds one, so a repeat run changes nothing', async () => {
    // Idempotence is what lets a partial run be repeated rather than reconciled.
    const { db, attempted } = updatingDb();
    const issued = await backfillUsername(db, { id: 'u-1', name: 'Jane Smith', username: 'jsmith1234' });
    expect(issued).toBeNull();
    expect(attempted).toHaveLength(0);
  });

  it('re-rolls on collision', async () => {
    const { db, attempted } = updatingDb({ failures: ['users_username_unique'] });
    await backfillUsername(db, { id: 'u-1', name: 'Jane Smith', username: null });
    expect(attempted).toHaveLength(2);
  });

  it('does NOT overwrite a username a concurrent run already issued', async () => {
    /*
      The early return reads the row the CALLER fetched, which is a snapshot —
      two overlapping backfills both see the same null usernames. The guard that
      matters is `username IS NULL` in the UPDATE itself: claiming nothing means
      somebody else got there first, and that row is done.

      Overwriting would replace a username that may already have been shown to
      the person, which is the one outcome a backfill must never produce.
    */
    const { db, attempted } = updatingDb({ claimed: false });
    const issued = await backfillUsername(db, { id: 'u-1', name: 'Jane Smith', username: null });

    expect(issued).toBeNull();
    // One attempt, then it stops — a lost race is settled, not retried.
    expect(attempted).toHaveLength(1);
  });

  it('issues to a person whose stored name is a single word', async () => {
    const { db } = updatingDb();
    const issued = await backfillUsername(db, { id: 'u-1', name: 'Cher', username: null });
    expect(issued).toMatch(/^c\d{4}$/);
  });
});
