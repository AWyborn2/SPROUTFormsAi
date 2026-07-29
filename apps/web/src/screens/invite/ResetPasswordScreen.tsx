import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Icon, useToast } from '@formai/ui';
import { useCompletePasswordReset, usePasswordReset } from '../../lib/data/hooks.js';
import { ExternalShell } from '../fill/ExternalShell.js';

/**
 * Set a new password — `/reset-password/:token`.
 *
 * Reached from a link an administrator issued but cannot complete. The admin
 * hands over the link (printed, scanned, or emailed) and the person chooses the
 * password here, so nobody who administers or marks their assessments ever
 * knows it.
 *
 * Deliberately does NOT sign anyone in on success. The link may have arrived on
 * paper, and possession of a slip of paper shouldn't become a live session on
 * whatever device scanned it — so it ends at the sign-in page.
 */
export function ResetPasswordScreen() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data: reset, isLoading } = usePasswordReset(token);
  const complete = useCompletePasswordReset();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  if (isLoading) {
    return (
      <ExternalShell orgName="FormAI" branding={null}>
        <div className="grid flex-1 place-items-center py-24 text-sm text-muted">Checking link…</div>
      </ExternalShell>
    );
  }

  // Unknown, expired, and already-used are one indistinguishable 404 from the
  // API, so they get one honest message here.
  if (!reset) {
    return (
      <ExternalShell orgName="FormAI" branding={null}>
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-24 text-center">
          <Icon name="link-2-off" size={32} className="text-muted" />
          <h1 className="font-heading text-lg font-semibold">This link isn't valid</h1>
          <p className="text-sm text-muted">
            It may have expired or already been used. Ask your supervisor for a new one.
          </p>
        </div>
      </ExternalShell>
    );
  }

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;
  const mismatch = confirm.length > 0 && password !== confirm;
  const ready = password.length >= MIN_PASSWORD && password === confirm;
  const field = 'w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm';

  return (
    <ExternalShell orgName="FormAI" branding={null}>
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-20 text-center">
        <Icon name="key-round" size={32} color="var(--org-primary)" />
        <h1 className="font-heading text-xl font-semibold">Set a new password</h1>
        <p className="text-sm text-muted">
          {reset.name ? `${reset.name}, choose` : 'Choose'} a password only you know. Nobody who set up
          this link can see it.
        </p>

        <form
          className="mt-1 w-full space-y-3 text-left"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ready || !token || complete.isPending) return;
            complete.mutate(
              { token, password },
              {
                onSuccess: () => {
                  toast({ variant: 'success', message: 'Password updated — sign in to continue.' });
                  navigate('/login');
                },
                onError: () => {
                  toast({
                    variant: 'warning',
                    message: "Couldn't set your password. The link may have expired.",
                  });
                },
              },
            );
          }}
        >
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted">New password</span>
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
            disabled={!ready || complete.isPending}
            className="w-full rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            style={{ background: 'var(--org-primary)' }}
          >
            {complete.isPending ? 'Saving…' : 'Set password'}
          </button>
        </form>
      </div>
    </ExternalShell>
  );
}

const MIN_PASSWORD = 8;
