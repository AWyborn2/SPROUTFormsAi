import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@formai/db';

/**
 * Password verification, shared by login, password confirmation, and the
 * signature gate on case sign-off — one primitive, so the constant-time
 * discipline below cannot drift between callers.
 */

/** Cost factor for every bcrypt hash the app mints. Exported so the
 * invite-signup path cannot drift to a weaker cost than signup. */
export const BCRYPT_COST = 12;

/**
 * Structurally valid, full-cost bcrypt hash of a random string, minted once at
 * module load. When a check hits an unknown user or an account with no
 * password we still run bcrypt.compare against this hash so the request does
 * the same full-cost work as a real compare — a malformed constant would let
 * bcrypt short-circuit and reopen the enumeration timing oracle. It hashes
 * random bytes, so no input can ever match it. Exported for tests only.
 */
export const DUMMY_HASH = bcrypt.hashSync(randomBytes(32).toString('hex'), BCRYPT_COST);

/**
 * Compare a password against a hash that may be absent, in constant time.
 * A null hash (invite-created account that never set a password) compares
 * against the dummy and is always false — the caller cannot tell "no such
 * hash" from "wrong password", and neither can a timing observer.
 */
export async function comparePassword(
  password: string,
  passwordHash: string | null | undefined,
): Promise<boolean> {
  const valid = await bcrypt.compare(password, passwordHash ?? DUMMY_HASH);
  return valid && passwordHash != null;
}

/**
 * Verify a password for a known user id. False for a wrong password, an
 * unknown id, or an account with no password — one answer shape, one timing.
 */
export async function verifyUserPassword(
  dbc: Db,
  userId: string,
  password: string,
): Promise<boolean> {
  const user = await dbc.query.users.findFirst({ where: eq(schema.users.id, userId) });
  return comparePassword(password, user?.passwordHash ?? null);
}
