import { useNavigate, useParams } from 'react-router-dom';
import { Icon, useToast } from '@formai/ui';
import { ApiError } from '../../lib/data/api-client.js';
import { useAcceptInvite, useInvite, useSession } from '../../lib/data/hooks.js';
import { rememberPendingInvite } from '../../lib/pending-invite.js';
import { ExternalShell } from '../fill/ExternalShell.js';

/**
 * Invite landing page — `/invite/:token`, the destination of the invite email.
 * Reachable logged out so the invitee can see what they're being asked to join
 * before signing in.
 *
 * The token in the URL is the whole credential: accepting binds the invited
 * membership to whoever is signed in when they press the button, which is why
 * this screen never asks for (or trusts) the invited email address. It shows
 * the address purely so the recipient recognises the invite.
 */
export function InviteScreen() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data: invite, isLoading } = useInvite(token);
  const { data: session } = useSession();
  const accept = useAcceptInvite();

  if (isLoading) {
    return (
      <ExternalShell orgName="FormAI" branding={null}>
        <div className="grid flex-1 place-items-center py-24 text-sm text-muted">Loading invite…</div>
      </ExternalShell>
    );
  }

  // Unknown, expired, revoked, and already-accepted are one indistinguishable
  // 404 from the API, so they get one honest message here.
  if (!invite) {
    return (
      <ExternalShell orgName="FormAI" branding={null}>
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-24 text-center">
          <Icon name="link-2-off" size={32} className="text-muted" />
          <h1 className="font-heading text-lg font-semibold">This invite link isn't valid</h1>
          <p className="text-sm text-muted">
            It may have expired, been revoked, or already been used. Ask whoever invited you to send a
            new one.
          </p>
        </div>
      </ExternalShell>
    );
  }

  function onAccept() {
    if (!token) return;
    accept.mutate(token, {
      onSuccess: () => {
        toast({ variant: 'success', message: `You've joined ${invite!.orgName}.` });
        navigate('/app');
      },
      onError: (err: unknown) => {
        const status = err instanceof ApiError ? err.status : undefined;
        if (status === 409) {
          toast({ variant: 'info', message: `You're already a member of ${invite!.orgName}.` });
          navigate('/app');
          return;
        }
        toast({
          variant: 'warning',
          message:
            status === 404
              ? 'This invite link is no longer valid.'
              : "Couldn't accept the invite. Please try again.",
        });
      },
    });
  }

  return (
    <ExternalShell orgName={invite.orgName} branding={null}>
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-20 text-center">
        <Icon name="user-plus" size={32} color="var(--org-primary)" />
        <h1 className="font-heading text-xl font-semibold">Join {invite.orgName}</h1>
        <p className="text-sm text-muted">
          You've been invited as a <span className="font-medium text-fg">{invite.role}</span>. The invite
          was sent to <span className="font-medium text-fg">{invite.email}</span>.
        </p>

        {session ? (
          <>
            <button
              type="button"
              onClick={onAccept}
              disabled={accept.isPending}
              className="mt-2 rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              style={{ background: 'var(--org-primary)' }}
            >
              {accept.isPending ? 'Joining…' : `Accept invite`}
            </button>
            {/* The membership attaches to this session, so say whose it is —
                a shared computer shouldn't silently join the wrong account. */}
            <p className="text-xs text-muted">
              You'll join as {session.userName}. Signed in as someone else?{' '}
              <a href="/login" className="underline">
                Switch account
              </a>
              .
            </p>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => {
                if (token) rememberPendingInvite(token);
                navigate('/login');
              }}
              className="mt-2 rounded-lg px-4 py-2 text-sm font-medium text-white"
              style={{ background: 'var(--org-primary)' }}
            >
              Sign in to accept
            </button>
            <p className="text-xs text-muted">You'll come back here once you're signed in.</p>
          </>
        )}
      </div>
    </ExternalShell>
  );
}
