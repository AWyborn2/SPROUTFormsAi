import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Icon, useToast } from '@formai/ui';
import { ApiError } from '../../lib/data/api-client.js';
import {
  useAcceptInvite,
  useInvite,
  useSession,
  useSignupFromInvite,
} from '../../lib/data/hooks.js';
import { rememberPendingInvite } from '../../lib/pending-invite.js';
import { ExternalShell } from '../fill/ExternalShell.js';

/**
 * Invite landing page — `/invite/:token`, reached from an invite email or by
 * scanning a printed QR code. Reachable logged out so the invitee can see what
 * they're being asked to join before committing to anything.
 *
 * Two ways through it, because invitees arrive in two states:
 *
 *  - **No account yet** (the common case for a candidate) — they create one
 *    here, choosing their own password, and land signed in. Ordinary signup
 *    would provision them a private organisation they never wanted, so this
 *    path exists to make the invite the account's origin instead.
 *  - **Already signed in** — the existing membership-attach flow.
 *
 * The token in the URL is the whole credential: it decides the org and the
 * role, and nothing typed on this page can change either. The address field is
 * the invitee's own claim about themselves, checked against the invite only
 * when the invite was emailed to a specific address.
 */
export function InviteScreen() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data: invite, isLoading } = useInvite(token);
  const { data: session } = useSession();
  const accept = useAcceptInvite();
  const signup = useSignupFromInvite();

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
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center">
        <Icon name="user-plus" size={32} color="var(--org-primary)" />
        <h1 className="font-heading text-xl font-semibold">Join {invite.orgName}</h1>
        <p className="text-sm text-muted">
          {invite.inviteeName ? `${invite.inviteeName}, you've` : "You've"} been invited as a{' '}
          <span className="font-medium text-fg">{invite.role}</span>
          {/* A QR invite was handed over in person and names no address, so
              there is nothing to show for recognition. */}
          {invite.email ? (
            <>
              . The invite was sent to <span className="font-medium text-fg">{invite.email}</span>.
            </>
          ) : (
            '.'
          )}
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
          <CreateAccountForm
            token={token}
            invite={invite}
            pending={signup.isPending}
            onSubmit={(values) => {
              if (!token) return;
              signup.mutate(
                { token, ...values },
                {
                  onSuccess: () => {
                    toast({ variant: 'success', message: `Welcome to ${invite.orgName}.` });
                    navigate('/app');
                  },
                  onError: (err: unknown) => {
                    const status = err instanceof ApiError ? err.status : undefined;
                    const body = err instanceof ApiError ? (err.body as { error?: string } | null) : null;
                    if (status === 409 && body?.error === 'account_exists') {
                      // Deliberately NOT an offer to reset their password:
                      // this page proves possession of an invite, not of the
                      // address, so it must never touch an existing account.
                      toast({
                        variant: 'info',
                        message: 'That email already has an account — sign in instead.',
                      });
                      if (token) rememberPendingInvite(token);
                      navigate('/login');
                      return;
                    }
                    toast({
                      variant: 'warning',
                      message:
                        status === 409 && body?.error === 'email_mismatch'
                          ? 'Use the email address this invite was sent to.'
                          : status === 404
                            ? 'This invite link is no longer valid.'
                            : "Couldn't create your account. Please try again.",
                    });
                  },
                },
              );
            }}
          />
        )}
      </div>
    </ExternalShell>
  );
}

const MIN_PASSWORD = 8;

interface CreateAccountValues {
  name: string;
  email: string;
  password: string;
}

/**
 * Account creation for an invitee who has none.
 *
 * The password is set HERE, by the person it belongs to. Nobody who issued the
 * invite ever sees or chooses it — that's what keeps an administrator from
 * being able to sign in as a candidate whose assessment records they also mark.
 */
function CreateAccountForm({
  token,
  invite,
  pending,
  onSubmit,
}: {
  token: string | undefined;
  invite: { email: string | null; inviteeName: string };
  pending: boolean;
  onSubmit: (values: CreateAccountValues) => void;
}) {
  const navigate = useNavigate();
  const [name, setName] = useState(invite.inviteeName);
  // Prefilled and fixed when the invite named an address: the server refuses
  // any other, so an editable box would only invite a rejected submission.
  const [email, setEmail] = useState(invite.email ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const mismatch = confirm.length > 0 && password !== confirm;
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;
  const ready =
    name.trim().length > 0 &&
    email.trim().length > 0 &&
    password.length >= MIN_PASSWORD &&
    password === confirm;

  const field = 'w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm';

  return (
    <form
      className="mt-2 w-full space-y-3 text-left"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !pending) onSubmit({ name: name.trim(), email: email.trim(), password });
      }}
    >
      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted">Your name</span>
        <input className={field} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
      </label>

      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted">Email</span>
        <input
          className={field}
          type="email"
          value={email}
          readOnly={Boolean(invite.email)}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted">Choose a password</span>
        <input
          className={field}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted">Confirm password</span>
        <input
          className={field}
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
        />
      </label>

      {tooShort && (
        <p className="text-xs text-warning">Passwords must be at least {MIN_PASSWORD} characters.</p>
      )}
      {mismatch && <p className="text-xs text-warning">Those passwords don't match.</p>}

      <button
        type="submit"
        disabled={!ready || pending}
        className="w-full rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        style={{ background: 'var(--org-primary)' }}
      >
        {pending ? 'Creating your account…' : 'Create account and join'}
      </button>

      <p className="text-center text-xs text-muted">
        Already have an account?{' '}
        <button
          type="button"
          className="underline"
          onClick={() => {
            if (token) rememberPendingInvite(token);
            navigate('/login');
          }}
        >
          Sign in instead
        </button>
        .
      </p>
    </form>
  );
}
