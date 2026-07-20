/**
 * Decision logic for the signup → onboarding-wizard path.
 *
 * These are deliberately pure functions living outside the screens: the web
 * app's vitest environment is `node` (no jsdom), so component rendering is not
 * testable here. Keeping the routing, guard, hydration and invite-aggregation
 * rules as data-in/data-out helpers means the parts that can silently strand a
 * new user — or overwrite their saved branding — are covered by unit tests,
 * and the screens stay thin wiring.
 */

import type { BrandingKit, Role, SessionInfo } from '@formai/shared';
import { DEFAULT_BRANDING, ROLE_LABELS } from '@formai/shared';
import type { RoleName } from './data/types.js';
import type { WhiteLabelState } from './onboarding.js';
import { SCREENS } from './screens.js';

export const APP_PATH = '/app';
export const LOGIN_PATH = '/login';
export const SETUP_PATH = '/setup';

/** Team-size bucket used until the org reports one of its own. */
export const DEFAULT_TEAM_SIZE = '50–200';

/** Roles allowed to run the org onboarding wizard. */
const SETUP_ROLES: readonly Role[] = ['owner', 'admin'];

const INVITE_TEMPLATE = SCREENS.find((s) => s.key === 'invite')?.path ?? '/invite/:token';

/** Concrete accept-invite URL for a token, from the registry's route template. */
export function invitePath(token: string): string {
  return INVITE_TEMPLATE.replace(':token', encodeURIComponent(token));
}

/**
 * Where a completed signup lands. The pending invite is checked *first*: the
 * signup form defaults to `team`, so branching on account kind first would
 * capture a fresh invitee in the wizard for their own auto-provisioned org
 * (which keeps incomplete onboarding by design) and lose the invite.
 */
export function postSignupDestination(input: {
  accountKind: 'individual' | 'team';
  pendingInvite: string | null;
}): string {
  if (input.pendingInvite) return invitePath(input.pendingInvite);
  return input.accountKind === 'team' ? SETUP_PATH : APP_PATH;
}

/** Sign-in honours a pending invite and otherwise enters the app — never the wizard. */
export function postSignInDestination(input: { pendingInvite: string | null }): string {
  return input.pendingInvite ? invitePath(input.pendingInvite) : APP_PATH;
}

export type SetupGuardDecision =
  | { kind: 'loading' }
  | { kind: 'redirect'; to: string }
  | { kind: 'allow' };

/**
 * `/setup` and `/setup/branding` are only for an owner/admin of a team org
 * whose onboarding has not been stamped yet. Everyone else — solo workspaces,
 * ordinary members, anyone who already finished — belongs in the app.
 */
export function setupGuardDecision(input: {
  session: SessionInfo | null | undefined;
  isLoading: boolean;
}): SetupGuardDecision {
  if (input.isLoading) return { kind: 'loading' };
  const session = input.session;
  if (!session) return { kind: 'redirect', to: LOGIN_PATH };
  if (session.accountKind !== 'team') return { kind: 'redirect', to: APP_PATH };
  if (!SETUP_ROLES.includes(session.role)) return { kind: 'redirect', to: APP_PATH };
  if (session.onboardingCompletedAt != null) return { kind: 'redirect', to: APP_PATH };
  return { kind: 'allow' };
}

/**
 * Whether the authed shell shows the "finish your branding" nudge (R5).
 *
 * Deliberately the same three conditions the `/setup` guard allows on: the
 * banner is a doorway into the wizard, so offering it to anyone the guard
 * would bounce would be a link straight to a redirect. Loading resolves to
 * `false` rather than `true` so the banner never flashes on a first paint that
 * a resolved session then contradicts.
 */
export function shouldShowBrandingNudge(input: {
  session: SessionInfo | null | undefined;
  isLoading: boolean;
}): boolean {
  return setupGuardDecision(input).kind === 'allow';
}

export interface OnboardingSeed {
  orgName: string;
  teamSize: string;
  branding: BrandingKit;
}

type SessionSeedFields = Pick<SessionInfo, 'orgName' | 'teamSize' | 'branding'>;

/**
 * Wizard state seeded from server truth. Without this a resumed wizard opens on
 * `DEFAULT_BRANDING` and "Finish setup" writes those defaults straight over the
 * kit the user already saved.
 */
export function onboardingSeedFromSession(
  session: Partial<SessionSeedFields> | null | undefined,
): OnboardingSeed {
  return {
    orgName: session?.orgName ?? '',
    teamSize: session?.teamSize ?? DEFAULT_TEAM_SIZE,
    // Spread over the defaults so a kit persisted before a field existed still
    // yields a complete BrandingKit.
    branding: { ...DEFAULT_BRANDING, ...(session?.branding ?? {}) },
  };
}

/** Neutral white-label starting point — nothing is known until the org sets it. */
export function whiteLabelSeed(): WhiteLabelState {
  return { customDomain: '', senderEmail: '', removeBadge: true };
}

/** The wizard holds lowercase `Role`; the invite hook takes the display `RoleName`. */
export function toRoleName(role: Role): RoleName {
  return ROLE_LABELS[role] as RoleName;
}

/** One settled invite attempt. `value: null` is the store's swallowed 409. */
export type InviteSettled =
  | { email: string; ok: true; value: { emailSent: boolean } | null }
  | { email: string; ok: false; error: unknown };

export interface InviteResult {
  email: string;
  status: 'sent' | 'invited' | 'existing' | 'failed';
  detail: string;
}

export interface InviteSummary {
  results: InviteResult[];
  sentCount: number;
  failedCount: number;
  /**
   * Always false: invites are best-effort and never undo the completion stamp
   * that was already written. Present so the finish screen reads the intent
   * rather than re-deriving it.
   */
  completionFailed: false;
}

/** Pulls the API's human-facing message out of an ApiError-shaped rejection. */
function errorDetail(error: unknown): string {
  if (error && typeof error === 'object' && 'body' in error) {
    const body = (error as { body?: unknown }).body;
    if (body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string') {
      return (body as { message: string }).message;
    }
  }
  return 'Could not send this invite — you can retry from the Team screen.';
}

function toInviteResult(settled: InviteSettled): InviteResult {
  if (!settled.ok) {
    return { email: settled.email, status: 'failed', detail: errorDetail(settled.error) };
  }
  if (settled.value === null) {
    return { email: settled.email, status: 'existing', detail: 'Already invited' };
  }
  return settled.value.emailSent
    ? { email: settled.email, status: 'sent', detail: 'Invite email sent' }
    : { email: settled.email, status: 'invited', detail: 'Invited — share the link from Team' };
}

/** Per-row outcomes for the finish screen; completion is never marked failed. */
export function summarizeInviteResults(settled: InviteSettled[]): InviteSummary {
  const results = settled.map(toInviteResult);
  return {
    results,
    sentCount: results.filter((r) => r.status === 'sent').length,
    failedCount: results.filter((r) => r.status === 'failed').length,
    completionFailed: false,
  };
}
