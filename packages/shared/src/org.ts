/**
 * Tenant / identity entities — app-side projections of the Replit Auth user.
 */

import type { BrandingKit } from './branding.js';
import type { MembershipStatus, Role } from './roles.js';

export interface Organization {
  id: string;
  name: string;
  plan: string;
  branding: BrandingKit;
  createdAt: string;
}

export interface User {
  id: string;
  /** Replit user id from X-Replit-User-Id header. */
  replitUserId: string;
  name: string;
  email: string;
  createdAt: string;
}

export interface Membership {
  id: string;
  userId: string;
  orgId: string;
  role: Role;
  status: MembershipStatus;
  createdAt: string;
}

/** The resolved tenant context attached to every authenticated API request. */
export interface TenantContext {
  userId: string;
  orgId: string;
  role: Role;
  /**
   * The name an audit entry carries INSTEAD of resolving the user's own.
   *
   * Set only on a machine call whose issuing Admin has since been deactivated.
   * An API key is the ORGANISATION's credential — its own role, its own
   * lifecycle, revoked by any Admin — so it keeps working when the person who
   * issued it leaves. But naming that person as the actor on every write it
   * makes afterwards would have the audit trail claim somebody who cannot sign
   * in is still working, which is a different and worse defect than the access
   * itself.
   *
   * `actorId` still points at the issuer, so the entry stays traceable to whoever
   * authorised the key. Only the displayed name changes.
   *
   * NEVER SEALED into a session cookie: a human session leaves this unset and
   * `recordAudit` falls back to the user's own name.
   */
  actorLabel?: string;
}

/** `GET /auth/me` response — the sealed session plus display fields the client needs. */
export interface SessionInfo extends TenantContext {
  orgName: string;
  userName: string;
  userEmail: string;
  /**
   * The person's saved signature — a PNG data URL — remembered from their last
   * sign-off and prefilled at the next, so an assessor draws it once. Null until
   * they have signed anything.
   */
  signature: string | null;
  /**
   * Whether the account has a password to re-enter. Invite-created users may
   * have none — for them the client hides every "confirm with your password"
   * affordance (applying a stored signature) rather than offering a prompt
   * that can never succeed; drawing fresh stays available regardless.
   */
  hasPassword: boolean;
  /** Whether the org is a solo workspace ('individual') or a shared team ('team'). */
  accountKind: 'individual' | 'team';
  /** The org's branding kit; null when the org row could not be resolved. */
  branding: BrandingKit | null;
  /** Self-reported team size bucket from onboarding (e.g. '2-5'); null until set. */
  teamSize: string | null;
  /** ISO timestamp of onboarding wizard completion; null while the wizard is pending. */
  onboardingCompletedAt: string | null;
  /**
   * What the organisation's plan includes, RESOLVED SERVER-SIDE.
   *
   * Sent on the session rather than left for the web to derive, for two
   * reasons. The tier-to-feature mapping lives in `packages/db/src/plans.ts`
   * and the web cannot import it, so deriving there would mean a hand-copied
   * mirror — and the one the web already keeps for the billing screen has
   * drifted twice. And the nav needs this on first paint: reading it from a
   * separate billing call would leave every gated entry flickering in or out
   * once that call returned.
   *
   * Null only where the org row could not be resolved, which the nav treats as
   * "show nothing gated" — the API is the real boundary either way.
   */
  features: PlanFeatureFlags | null;
}

/**
 * The plan-feature flags a session carries.
 *
 * Structurally the same as `PlanFeatures` in `packages/db/src/plans.ts`, stated
 * here as an index signature rather than a field list so it CANNOT drift: a
 * feature added there flows through without an edit, and the nav's
 * `requiresFeature` is checked against the keys actually present.
 */
export type PlanFeatureFlags = Readonly<Record<string, boolean>>;
