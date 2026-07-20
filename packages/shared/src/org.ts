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
}

/** `GET /auth/me` response — the sealed session plus display fields the client needs. */
export interface SessionInfo extends TenantContext {
  orgName: string;
  userName: string;
  userEmail: string;
  /** Whether the org is a solo workspace ('individual') or a shared team ('team'). */
  accountKind: 'individual' | 'team';
  /** The org's branding kit; null when the org row could not be resolved. */
  branding: BrandingKit | null;
  /** Self-reported team size bucket from onboarding (e.g. '2-5'); null until set. */
  teamSize: string | null;
  /** ISO timestamp of onboarding wizard completion; null while the wizard is pending. */
  onboardingCompletedAt: string | null;
}
