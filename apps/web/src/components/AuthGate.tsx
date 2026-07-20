import { Navigate, Outlet } from 'react-router-dom';
import { useSession } from '../lib/data/hooks.js';
import { takePendingInvite } from '../lib/pending-invite.js';

/** Minimal, brief — `useSession` typically resolves before this is visible. */
function CheckingSession() {
  return <div className="flex min-h-screen items-center justify-center text-text-secondary">Loading…</div>;
}

/**
 * `/` and any unmatched path land here: authenticated goes to `/app`,
 * everyone else to `/login`. Replaces the old unconditional
 * `<Navigate to="/login" />`, which ignored whether a session actually
 * existed — the reason a successful `/auth/callback` used to bounce
 * straight back to the login screen instead of landing in the app.
 *
 * An invitee signing in to accept is the exception. Replit's hosted login
 * takes a domain, not a return path (`routes/auth.ts`), so it always drops
 * people here — `takePendingInvite()` is how they get back to the invite
 * they clicked instead of silently landing in their own org.
 */
export function RootRedirect() {
  const { data: session, isLoading } = useSession();
  if (isLoading) return <CheckingSession />;
  if (!session) return <Navigate to="/login" replace />;
  const pendingInvite = takePendingInvite();
  return <Navigate to={pendingInvite ? `/invite/${pendingInvite}` : '/app'} replace />;
}

/** Gates the `/app/*` screen group — unauthenticated visitors are sent to `/login`. */
export function RequireAuth() {
  const { data: session, isLoading } = useSession();
  if (isLoading) return <CheckingSession />;
  if (!session) return <Navigate to="/login" replace />;
  return <Outlet />;
}
