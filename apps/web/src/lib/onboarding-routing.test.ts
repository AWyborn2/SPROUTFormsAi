import { describe, expect, it } from 'vitest';
import type { SessionInfo } from '@formai/shared';
import { DEFAULT_BRANDING } from '@formai/shared';
import {
  DEFAULT_TEAM_SIZE,
  invitePath,
  onboardingSeedFromSession,
  postSignInDestination,
  postSignupDestination,
  setupGuardDecision,
  summarizeInviteResults,
  toRoleName,
  whiteLabelSeed,
} from './onboarding-routing.js';

function session(patch: Partial<SessionInfo> = {}): SessionInfo {
  return {
    userId: 'u1',
    orgId: 'o1',
    role: 'owner',
    orgName: 'Acme Corp',
    userName: 'Jane',
    userEmail: 'jane@acme.test',
    accountKind: 'team',
    branding: null,
    teamSize: null,
    onboardingCompletedAt: null,
    ...patch,
  };
}

describe('post-signup destination', () => {
  // AE2: the signup form defaults to `team`, so without the pending-invite
  // check first a fresh invitee is captured in the wizard for their own
  // auto-provisioned org instead of accepting the invite they clicked.
  it('routes a pending invite to the accept screen, never /setup', () => {
    expect(postSignupDestination({ accountKind: 'team', pendingInvite: 'tok-123' })).toBe(
      '/invite/tok-123',
    );
    expect(postSignupDestination({ accountKind: 'individual', pendingInvite: 'tok-123' })).toBe(
      '/invite/tok-123',
    );
  });

  it('sends a team signup without an invite to the wizard', () => {
    expect(postSignupDestination({ accountKind: 'team', pendingInvite: null })).toBe('/setup');
  });

  // AE1.
  it('sends an individual signup straight to the app', () => {
    expect(postSignupDestination({ accountKind: 'individual', pendingInvite: null })).toBe('/app');
  });

  it('percent-encodes the token it interpolates', () => {
    expect(invitePath('a/b')).toBe('/invite/a%2Fb');
  });
});

describe('post-sign-in destination', () => {
  it('honours a pending invite, otherwise goes to the app', () => {
    expect(postSignInDestination({ pendingInvite: 'tok-9' })).toBe('/invite/tok-9');
    expect(postSignInDestination({ pendingInvite: null })).toBe('/app');
  });

  it('never routes a returning user into the wizard', () => {
    expect(postSignInDestination({ pendingInvite: null })).not.toBe('/setup');
  });
});

describe('setup guard', () => {
  it('waits while the session is loading', () => {
    expect(setupGuardDecision({ session: undefined, isLoading: true })).toEqual({ kind: 'loading' });
  });

  it('sends an unauthenticated visitor to /login', () => {
    expect(setupGuardDecision({ session: null, isLoading: false })).toEqual({
      kind: 'redirect',
      to: '/login',
    });
  });

  it('allows an eligible team owner with onboarding still pending', () => {
    expect(setupGuardDecision({ session: session(), isLoading: false })).toEqual({ kind: 'allow' });
    expect(setupGuardDecision({ session: session({ role: 'admin' }), isLoading: false })).toEqual({
      kind: 'allow',
    });
  });

  it('redirects an individual account to /app', () => {
    expect(
      setupGuardDecision({ session: session({ accountKind: 'individual' }), isLoading: false }),
    ).toEqual({ kind: 'redirect', to: '/app' });
  });

  it('redirects a non-owner/admin member to /app', () => {
    for (const role of ['builder', 'reviewer', 'viewer'] as const) {
      expect(setupGuardDecision({ session: session({ role }), isLoading: false })).toEqual({
        kind: 'redirect',
        to: '/app',
      });
    }
  });

  it('redirects once onboarding is already complete', () => {
    expect(
      setupGuardDecision({
        session: session({ onboardingCompletedAt: '2026-07-20T00:00:00.000Z' }),
        isLoading: false,
      }),
    ).toEqual({ kind: 'redirect', to: '/app' });
  });
});

describe('wizard hydration from the session', () => {
  // AE3's no-clobber property: a resumed wizard must edit the saved kit rather
  // than seed defaults over the top of it.
  it('seeds branding, team size and org name from the session when present', () => {
    const saved = { ...DEFAULT_BRANDING, primaryColor: '#123456', formFont: 'Spectral' };
    const seed = onboardingSeedFromSession(
      session({ branding: saved, teamSize: '10–50', orgName: 'Northwind' }),
    );
    expect(seed.branding).toEqual(saved);
    expect(seed.teamSize).toBe('10–50');
    expect(seed.orgName).toBe('Northwind');
  });

  it('falls back to defaults when the session carries nothing', () => {
    const seed = onboardingSeedFromSession(session());
    expect(seed.branding).toEqual(DEFAULT_BRANDING);
    expect(seed.teamSize).toBe(DEFAULT_TEAM_SIZE);
    expect(seed.orgName).toBe('Acme Corp');
  });

  it('tolerates a missing session entirely', () => {
    const seed = onboardingSeedFromSession(null);
    expect(seed.branding).toEqual(DEFAULT_BRANDING);
    expect(seed.orgName).toBe('');
  });

  it('backfills any branding key the saved kit is missing', () => {
    const seed = onboardingSeedFromSession(
      session({ branding: { primaryColor: '#000000' } as never }),
    );
    expect(seed.branding.primaryColor).toBe('#000000');
    expect(seed.branding.accentColor).toBe(DEFAULT_BRANDING.accentColor);
  });

  it('derives no fictional white-label defaults', () => {
    const wl = whiteLabelSeed();
    expect(wl.customDomain).toBe('');
    expect(wl.senderEmail).toBe('');
  });
});

describe('invite result aggregation', () => {
  const seatLimit = {
    status: 403,
    body: { error: 'seat_limit_reached', message: 'Your free plan allows 5 seats.', seatLimit: 5, seatUsed: 5 },
  };

  it('reports every row and never fails completion when one hits the seat limit', () => {
    const summary = summarizeInviteResults([
      { email: 'a@x.test', ok: true, value: { emailSent: true } },
      { email: 'b@x.test', ok: false, error: seatLimit },
    ]);

    expect(summary.results).toHaveLength(2);
    expect(summary.results[0]).toMatchObject({ email: 'a@x.test', status: 'sent' });
    expect(summary.results[1]).toMatchObject({ email: 'b@x.test', status: 'failed' });
    expect(summary.results[1]?.detail).toContain('5 seats');
    expect(summary.sentCount).toBe(1);
    expect(summary.failedCount).toBe(1);
    expect(summary.completionFailed).toBe(false);
  });

  it('distinguishes an already-invited member (409 swallowed to null) from a send', () => {
    const summary = summarizeInviteResults([
      { email: 'dup@x.test', ok: true, value: null },
      { email: 'quiet@x.test', ok: true, value: { emailSent: false } },
    ]);
    expect(summary.results[0]?.status).toBe('existing');
    expect(summary.results[1]?.status).toBe('invited');
    expect(summary.failedCount).toBe(0);
  });

  it('falls back to a generic message for an unrecognised error', () => {
    const summary = summarizeInviteResults([{ email: 'c@x.test', ok: false, error: new Error('x') }]);
    expect(summary.results[0]?.status).toBe('failed');
    expect(summary.results[0]?.detail.length).toBeGreaterThan(0);
    expect(summary.completionFailed).toBe(false);
  });

  it('is empty for no rows', () => {
    expect(summarizeInviteResults([])).toMatchObject({ results: [], sentCount: 0, failedCount: 0 });
  });
});

describe('role name mapping', () => {
  it('maps the lowercase wizard role onto the invite hook RoleName', () => {
    expect(toRoleName('admin')).toBe('Admin');
    expect(toRoleName('builder')).toBe('Builder');
  });
});
