/**
 * True for a Postgres SERIALIZATION FAILURE (error code 40001) — the abort a
 * repeatable-read (or serializable) transaction takes when a concurrent commit
 * made its snapshot untenable.
 *
 * It is never a bug in the statement that raised it: the correct response is
 * always "re-read and decide again", which for a fingerprint-guarded write is
 * exactly what the stale-echo 409 tells the client to do.
 */
export function isSerializationFailure(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '40001';
}

/** True for a Postgres unique-constraint violation (error code 23505). */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/**
 * True for a unique violation on one NAMED constraint.
 *
 * A row can breach more than one unique index, and retrying the wrong one is
 * worse than not retrying at all: username issuance re-rolls its suffix on a
 * collision, and without this it would also re-roll — and eventually give up
 * with a username error — on a duplicate EMAIL, hiding the real conflict behind
 * the wrong message. Postgres puts the index name in `constraint`.
 */
export function isUniqueViolationOn(err: unknown, constraint: string): boolean {
  if (!isUniqueViolation(err)) return false;
  const name = (err as { constraint?: string }).constraint;
  // A driver that does not surface the constraint name leaves us unable to
  // tell which index broke; treating that as "not this one" is the safe read,
  // since the caller's fallback is to report the error rather than to loop.
  return typeof name === 'string' && name === constraint;
}
