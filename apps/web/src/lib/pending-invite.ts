/**
 * Carries an invite token across the sign-in round trip.
 *
 * Replit's hosted login (`/api/auth/login` → `replit.com/auth_with_repl_site`)
 * takes a domain and nothing else — there is no return-path parameter to pass
 * `/invite/:token` through, and the browser lands back on `/`. Without this,
 * an invitee who isn't signed in yet — the common case, since the whole point
 * of an invite is reaching someone new — signs in and silently arrives in
 * their own auto-provisioned org, invite unaccepted and forgotten.
 *
 * `sessionStorage` (not `localStorage`) so the pending token dies with the tab
 * rather than ambushing a later, unrelated sign-in.
 */
const KEY = 'formai.pendingInvite';

export function rememberPendingInvite(token: string): void {
  try {
    sessionStorage.setItem(KEY, token);
  } catch {
    // Storage disabled (private mode, embedded webview): the invitee just has
    // to re-open the emailed link after signing in. Not worth failing over.
  }
}

/** Reads and clears in one step — a pending invite must only redirect once. */
export function takePendingInvite(): string | null {
  try {
    const token = sessionStorage.getItem(KEY);
    if (token) sessionStorage.removeItem(KEY);
    return token;
  } catch {
    return null;
  }
}
