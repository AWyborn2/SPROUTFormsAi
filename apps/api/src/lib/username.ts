import { randomInt } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Db } from '@formai/db';
import { isUniqueViolationOn } from './db-errors.js';

/**
 * The generated sign-in identity every person is issued (R21, KTD21).
 *
 * WHY A USERNAME AT ALL. An email address is a field an Admin corrects, and if
 * sign-in hung off it a correction would move who the person is to the system.
 * That reasoning is about signing in rather than about candidates, so everyone
 * the organisation holds a record for gets one, whatever access level they
 * carry — and R22 lets them sign in with either.
 *
 * WHY IT LIVES ON `users`. Sign-in is product-wide; the profile is per
 * organisation. A person working for two customers signs in once.
 *
 * WHY ISSUANCE IS ONE FUNCTION. R21 binds at the four places a person is
 * actually born — the three inserts into `users` that exist (first sign-in
 * provisioning, self-signup, invite acceptance) plus the import's creation
 * service — and wiring only some of them would leave a population that arrives
 * after this ships unable to sign in by username at all. `insertUserWithUsername`
 * owns the insert so no caller can forget, and so the collision retry is written
 * once rather than three times.
 */

/** Fixed width, so a saturated namespace is a bounded space rather than an open one. */
const SUFFIX_DIGITS = 4;
const SUFFIX_MIN = 10 ** (SUFFIX_DIGITS - 1);
const SUFFIX_MAX = 10 ** SUFFIX_DIGITS;

/**
 * How many times issuance re-rolls before giving up.
 *
 * Bounded deliberately. The suffix space is nine thousand per surname, so a
 * handful of retries covers any realistic organisation; an unbounded loop on a
 * genuinely saturated namespace would hang a backfill mid-migration with no
 * error to read. Failing loudly after a fixed number of attempts turns that into
 * a named error somebody can act on.
 */
const MAX_ATTEMPTS = 8;

/** The index name the retry keys on — see `isUniqueViolationOn` for why it must be named. */
const USERNAME_INDEX = 'users_username_unique';

export class UsernameExhaustedError extends Error {
  constructor(base: string) {
    super(`Could not issue a unique username for "${base}" after ${MAX_ATTEMPTS} attempts`);
    this.name = 'UsernameExhaustedError';
  }
}

/**
 * The stem a username is built from: first initial plus surname (R21).
 *
 * Normalised for what real names actually carry — spaces, hyphens and
 * apostrophes ("O'Brien", "van der Berg", "Smith-Jones") — because the stem ends
 * up in a credential somebody types. Case is folded at generation rather than at
 * lookup: `users.email` is compared case-sensitively today, and a
 * case-INsensitive username lookup added beside it could resolve two rows the
 * unique index had allowed, while a case-sensitive one makes the identifier
 * brittle for the person typing it. Folding once, here, avoids both.
 */
export function usernameStem(firstName: string, lastName: string): string {
  const clean = (s: string) =>
    s
      .normalize('NFKD')
      // Strip combining marks so an accented surname yields a typable stem.
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');

  const initial = clean(firstName).slice(0, 1);
  const surname = clean(lastName);
  const stem = `${initial}${surname}`;
  // A name that normalises to nothing at all still needs a stem to hang a
  // suffix off; `user` is the neutral fallback and the suffix keeps it unique.
  return stem.length > 0 ? stem : 'user';
}

/** One candidate: the stem plus a fresh random suffix. */
export function usernameCandidate(firstName: string, lastName: string): string {
  return `${usernameStem(firstName, lastName)}${randomInt(SUFFIX_MIN, SUFFIX_MAX)}`;
}

/**
 * Split a single stored name into first and last.
 *
 * `users.name` is one undivided string and existing rows have no profile to
 * read first and last names from, so the backfill and self-signup derive them
 * here. A single-word name yields an empty surname, which `usernameStem` handles
 * — the person still gets a username rather than the migration stopping on them.
 */
export function splitStoredName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0]!, lastName: '' };
  return { firstName: parts[0]!, lastName: parts[parts.length - 1]! };
}

export interface NewUserValues {
  name: string;
  email: string;
  passwordHash?: string | null;
  clerkUserId?: string | null;
}

type UserRow = typeof schema.users.$inferSelect;

/**
 * The root client OR an open transaction.
 *
 * Issuance must be runnable on the caller's transaction handle: invite
 * acceptance creates the user, claims the invite and inserts the membership as
 * one indivisible step, and a user inserted on the root client would survive a
 * rollback of the rest. Mirrors `SeatDb` in `lib/seats.ts`, which widened for
 * the same reason.
 */
export type UserDb = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Insert a `users` row carrying a freshly issued username, retrying the suffix
 * on collision.
 *
 * The retry is against the unique index rather than a pre-check, so two
 * concurrent issues cannot both pass a lookup and then collide — with a
 * pre-check the race is real and silent, and the loser's insert fails with an
 * error nobody expected. It retries ONLY on the username index: a duplicate
 * email is a different conflict with a different meaning, and re-rolling on it
 * would report a username failure for a problem that has nothing to do with one.
 *
 * `nameParts` lets a caller that holds real first and last names supply them; a
 * caller holding only the single stored string gets the split above.
 */
export async function insertUserWithUsername(
  db: UserDb,
  values: NewUserValues,
  nameParts?: { firstName: string; lastName: string },
): Promise<UserRow> {
  const { firstName, lastName } = nameParts ?? splitStoredName(values.name);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      /*
        Each attempt in its own savepoint. When `db` is a caller's transaction
        (invite acceptance, an import row), a 23505 aborts the WHOLE transaction,
        so a bare retry would re-issue the INSERT on an already-aborted handle
        and fail hard — the retry would be dead exactly where it is needed. A
        nested transaction is a SAVEPOINT: a collision rolls back only the
        attempt and the next runs clean. On the root client it is an ordinary
        one-statement transaction.
      */
      return await db.transaction(async (sp) => {
        const [row] = await sp
          .insert(schema.users)
          .values({ ...values, username: usernameCandidate(firstName, lastName) })
          .returning();
        return row!;
      });
    } catch (err) {
      if (isUniqueViolationOn(err, USERNAME_INDEX)) continue;
      throw err;
    }
  }
  throw new UsernameExhaustedError(usernameStem(firstName, lastName));
}

/**
 * Give an existing `users` row a username, for the one-shot backfill (KTD21).
 *
 * Idempotent, and idempotent under CONCURRENCY — which the early-return alone
 * did not achieve. That check reads the row the caller fetched, which is a
 * snapshot: two overlapping runs both see the same null usernames, and an UPDATE
 * keyed on the id alone would let the second overwrite a username the first had
 * already committed and possibly already shown to the person.
 *
 * So the guard is IN THE STATEMENT. `username IS NULL` in the WHERE makes the
 * claim atomic, and an empty `returning()` means somebody else got there first —
 * reported as null, exactly as a row that already held one.
 *
 * Returns the username the row ends up with, or null when it already had one.
 */
export async function backfillUsername(db: UserDb, user: { id: string; name: string; username: string | null }): Promise<string | null> {
  // Cheap short-circuit on the snapshot. Not the guard — the WHERE below is.
  if (user.username) return null;
  const { firstName, lastName } = splitStoredName(user.name);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const candidate = usernameCandidate(firstName, lastName);
    try {
      const claimed = await db
        .update(schema.users)
        .set({ username: candidate })
        .where(and(eq(schema.users.id, user.id), isNull(schema.users.username)))
        .returning({ id: schema.users.id });
      /*
        No row claimed means the username stopped being null between the read
        and the write — a concurrent run issued one. Nothing to do and nothing
        to report: this row is done, by somebody else.
      */
      if (claimed.length === 0) return null;
      return candidate;
    } catch (err) {
      if (isUniqueViolationOn(err, USERNAME_INDEX)) continue;
      throw err;
    }
  }
  throw new UsernameExhaustedError(usernameStem(firstName, lastName));
}

