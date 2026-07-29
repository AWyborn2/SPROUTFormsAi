import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Icon } from '@formai/ui';
import { joinLinksApi } from '../../lib/data/assessments.js';
import { useSession } from '../../lib/data/hooks.js';

/**
 * Where a scanned QR code lands.
 *
 * Public by necessity: the person holding the phone has no account yet. The
 * page shows only the organisation's name and the role on offer — enough to
 * decide whether to sign up, and nothing about its members or work.
 *
 * Signing in comes FIRST and joining second, always. The token says which
 * organisation to join; it never says who is joining. That separation is what
 * stops a shared code from being an identity.
 */

const REFUSALS: Record<string, string> = {
  revoked: 'This link has been turned off. Ask your trainer for a current one.',
  expired: 'This link has expired. Ask your trainer for a current one.',
  exhausted: 'This link has reached its limit. Ask your trainer for a current one.',
};

export function JoinScreen() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { data: session, isLoading: sessionLoading } = useSession();

  const { data: target, isLoading, error } = useQuery({
    queryKey: ['joinLink', token],
    queryFn: () => joinLinksApi.describe(token!),
    enabled: !!token,
    retry: false,
  });

  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  // Remember where to come back to, so signing in returns here rather than
  // dropping someone on a dashboard with no idea why they scanned anything.
  useEffect(() => {
    if (token) sessionStorage.setItem('pendingJoinToken', token);
  }, [token]);

  async function join() {
    if (!token) return;
    setJoining(true);
    setJoinError(null);
    try {
      await joinLinksApi.accept(token);
      sessionStorage.removeItem('pendingJoinToken');
      navigate('/app/assessments');
    } catch (e) {
      setJoinError(e instanceof Error ? e.message : 'Could not complete joining.');
      setJoining(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-surface-0 p-6">
      <div className="w-full max-w-[430px] rounded-md border border-border bg-surface-card p-[26px_28px] shadow-xs">
        {(isLoading || sessionLoading) && (
          <p className="text-[13.5px] text-text-tertiary">Checking this link…</p>
        )}

        {error && (
          <>
            <Icon name="link-2-off" size={26} className="text-text-tertiary" />
            <h1 className="mt-3 font-heading text-[20px] font-bold">Link not recognised</h1>
            <p className="mt-1.5 text-[13.5px] text-text-tertiary">
              Check the address, or ask your trainer for a current link.
            </p>
          </>
        )}

        {target && !target.usable && (
          <>
            <Icon name="clock-alert" size={26} className="text-warning-text" />
            <h1 className="mt-3 font-heading text-[20px] font-bold">This link is no longer active</h1>
            <p className="mt-1.5 text-[13.5px] text-text-tertiary">
              {REFUSALS[target.reason ?? ''] ?? 'Ask your trainer for a current link.'}
            </p>
          </>
        )}

        {target && target.usable && (
          <>
            <Icon name="clipboard-check" size={26} className="text-accent" />
            <h1 className="mt-3 font-heading text-[20px] font-bold">Join {target.orgName}</h1>
            <p className="mt-1.5 text-[13.5px] text-text-tertiary">
              {target.label
                ? `${target.label} — you'll be enrolled as a candidate.`
                : 'You’ll be enrolled as a candidate.'}
            </p>

            <ul className="mt-3.5 flex flex-col gap-1.5 text-[13px] text-text-secondary">
              <li className="flex items-start gap-2">
                <Icon name="check" size={15} className="mt-0.5 flex-none text-success-text" />
                See the assessments assigned to you
              </li>
              <li className="flex items-start gap-2">
                <Icon name="check" size={15} className="mt-0.5 flex-none text-success-text" />
                Complete your theory and log your hours
              </li>
              <li className="flex items-start gap-2">
                <Icon name="lock" size={15} className="mt-0.5 flex-none text-text-tertiary" />
                You won’t see anyone else’s records
              </li>
            </ul>

            {joinError && (
              <p role="alert" className="mt-3 text-[13px] text-danger">{joinError}</p>
            )}

            <div className="mt-5">
              {session ? (
                <Button onClick={join} disabled={joining} trailingIcon="arrow-right">
                  {joining ? 'Joining…' : `Join as ${session.userName || 'me'}`}
                </Button>
              ) : (
                <>
                  <Button onClick={() => navigate('/login')} trailingIcon="arrow-right">
                    Sign in to continue
                  </Button>
                  <p className="mt-2 text-[12.5px] text-text-tertiary">
                    You’ll come back here once you’ve signed in. No account? Create one on that
                    screen first.
                  </p>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
