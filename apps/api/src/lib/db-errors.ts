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
