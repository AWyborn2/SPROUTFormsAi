/**
 * In-process throttle for password confirmation (the signature gate).
 *
 * The confirm endpoint verifies a password for a KNOWN user id, which makes it
 * a brute-force oracle the login form is not — the attacker already holds the
 * session and the target. This throttle sits in front of every bcrypt compare:
 * five failures inside the window lock the user out for the lock period, and
 * a locked attempt is refused before any hash work happens.
 *
 * In-process by design for the current single-instance deployment: state
 * resets on restart and does not span instances. The module is pure over an
 * injected clock so a table-backed replacement can slot in behind the same
 * three calls when deployment changes.
 */

export const CONFIRM_WINDOW_MS = 15 * 60 * 1000;
export const CONFIRM_MAX_ATTEMPTS = 5;
export const CONFIRM_LOCK_MS = 15 * 60 * 1000;

interface Entry {
  /** Failure timestamps inside the sliding window, oldest first. */
  failures: number[];
  lockedUntil: number | null;
}

const entries = new Map<string, Entry>();

function pruned(entry: Entry, now: number): Entry {
  return {
    failures: entry.failures.filter((t) => now - t < CONFIRM_WINDOW_MS),
    lockedUntil: entry.lockedUntil !== null && entry.lockedUntil > now ? entry.lockedUntil : null,
  };
}

/** Whether this user may attempt a confirmation right now. */
export function confirmAllowed(
  userId: string,
  now: number = Date.now(),
): { allowed: true } | { allowed: false; retryAfterMs: number } {
  const entry = entries.get(userId);
  if (!entry) return { allowed: true };
  const live = pruned(entry, now);
  entries.set(userId, live);
  if (live.lockedUntil !== null) {
    return { allowed: false, retryAfterMs: live.lockedUntil - now };
  }
  return { allowed: true };
}

/** Record a failed attempt; the one that fills the window starts the lock. */
export function recordConfirmFailure(userId: string, now: number = Date.now()): void {
  const entry = pruned(entries.get(userId) ?? { failures: [], lockedUntil: null }, now);
  entry.failures.push(now);
  if (entry.failures.length >= CONFIRM_MAX_ATTEMPTS) {
    entry.lockedUntil = now + CONFIRM_LOCK_MS;
    entry.failures = [];
  }
  entries.set(userId, entry);
}

/** A successful confirmation clears the user's slate. */
export function recordConfirmSuccess(userId: string): void {
  entries.delete(userId);
}

/**
 * The lockout answer, shared by every route this throttle guards — one 429
 * body, so /auth/confirm-password and the sign-off gate cannot drift apart.
 * True means the response has been written and the caller must return.
 */
export function rejectIfLocked(
  res: { status: (code: number) => { json: (body: unknown) => unknown } },
  userId: string,
): boolean {
  const gate = confirmAllowed(userId);
  if (gate.allowed) return false;
  res.status(429).json({
    error: 'too_many_attempts',
    message: 'Too many attempts. Try again later.',
    retryAfterMs: gate.retryAfterMs,
  });
  return true;
}

/** Test-only: forget everything. */
export function resetConfirmThrottle(): void {
  entries.clear();
}
