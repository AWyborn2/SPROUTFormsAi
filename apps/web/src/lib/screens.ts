/**
 * Screen registry — the single source for routes, nav metadata, and the
 * command-palette / screen-index entries. Mirrors the prototype's screens[]
 * array. Each entry maps a route path to its display metadata.
 */

import type { Role } from '@formai/shared';

export type ShellKind = 'none' | 'app' | 'external' | 'mobile';

export interface ScreenDef {
  key: string;
  path: string;
  group: string;
  label: string;
  /** Lucide icon name. */
  icon: string;
  shell: ShellKind;
  /** Show in the left app nav. */
  inNav?: boolean;
  /**
   * Minimum access level a member needs to see this screen in the nav. Absent
   * means every level sees it. 'admin' also admits an owner. Filtering the nav
   * this way keeps an Admin-only surface off every other level's sidebar rather
   * than showing an entry that 403s on click.
   */
  minAccessLevel?: Role;
  /**
   * A plan feature the organisation must hold for this screen to appear.
   *
   * The API already refuses these surfaces below their tier — every route
   * behind them carries `requirePlanFeature`, and the profile ones resolve the
   * same rule through `tierCarriesProfiles`. Without this the nav advertised
   * them anyway and the click 403d, which reads as a broken product rather
   * than a plan boundary.
   *
   * NOT a security control. The API is the boundary; this only stops the nav
   * offering what the organisation cannot use.
   */
  requiresFeature?: string;
}

/**
 * Access-level ordering for nav gating. Owner holds everything Admin holds, so
 * an 'admin' minimum admits both. Levels below can never satisfy an Admin gate.
 */
const ACCESS_RANK: Record<string, number> = {
  owner: 100,
  admin: 90,
  builder: 50,
  reviewer: 40,
  assessor: 30,
  viewer: 20,
  candidate: 0,
};

export const SCREENS: ScreenDef[] = [
  // Onboarding & account
  { key: 'login', path: '/login', group: 'Onboarding & account', label: 'Sign in / sign up', icon: 'log-in', shell: 'none' },
  { key: 'org-setup', path: '/setup', group: 'Onboarding & account', label: 'Organisation setup', icon: 'building-2', shell: 'none' },
  { key: 'branding', path: '/setup/branding', group: 'Onboarding & account', label: 'Branding kit', icon: 'palette', shell: 'none' },

  // Core product loop
  { key: 'dashboard', path: '/app', group: 'Core product loop', label: 'Dashboard', icon: 'layout-dashboard', shell: 'app', inNav: true },
  { key: 'templates', path: '/app/forms', group: 'Core product loop', label: 'Form library', icon: 'folder', shell: 'app', inNav: true },
  { key: 'builder', path: '/app/forms/build', group: 'Core product loop', label: 'Form builder', icon: 'layout-template', shell: 'app' },
  { key: 'import-1', path: '/app/import', group: 'Core product loop', label: 'PDF import · upload', icon: 'file-up', shell: 'app' },
  { key: 'import-2', path: '/app/import/review', group: 'Core product loop', label: 'PDF import · review', icon: 'scan-search', shell: 'app' },
  { key: 'import-3', path: '/app/import/publish', group: 'Core product loop', label: 'PDF import · publish', icon: 'badge-check', shell: 'app' },
  { key: 'submissions', path: '/app/submissions', group: 'Core product loop', label: 'Submissions', icon: 'table-2', shell: 'app', inNav: true },
  { key: 'submission-detail', path: '/app/submissions/detail', group: 'Core product loop', label: 'Submission detail', icon: 'file-check-2', shell: 'app' },
  // Public token-addressed fill page (no auth — the token is the credential).
  // The post-submit confirmation renders inline on the same screen.
  { key: 'fill', path: '/fill/:token', group: 'Core product loop', label: 'Form fill (external)', icon: 'pen-line', shell: 'external' },
  // Invite landing — the invite email's destination. Outside RequireAuth: the
  // invitee must be able to read what they're joining before signing in.
  { key: 'invite', path: '/invite/:token', group: 'Onboarding & account', label: 'Accept invite', icon: 'user-plus', shell: 'external' },
  // Password reset — also outside RequireAuth, because someone who has lost
  // their password by definition cannot sign in to reach it. The token is the
  // credential and it is single-use.
  { key: 'reset-password', path: '/reset-password/:token', group: 'Onboarding & account', label: 'Set a new password', icon: 'key-round', shell: 'external' },

  // CHC @ BBM — the purpose-built intake form. `shell: 'app'` (authenticated):
  // it records real submissions and uploads identity documents, so it is never
  // a public surface. The same form also exists as an editable template,
  // reachable from the form library.
  { key: 'chc-intake', path: '/app/chc-intake', group: 'Core product loop', label: 'CHC induction intake', icon: 'hard-hat', shell: 'app', inNav: true },

  // Enterprise & org
  { key: 'team', path: '/app/team', group: 'Enterprise & org', label: 'Team management', icon: 'users', shell: 'app', inNav: true },
  { key: 'taxonomy', path: '/app/taxonomy', group: 'Enterprise & org', label: 'Locations & roles', icon: 'map-pin', shell: 'app', inNav: true, minAccessLevel: 'admin' , requiresFeature: 'assessments' },
  { key: 'roles', path: '/app/roles', group: 'Enterprise & org', label: 'Access levels', icon: 'shield', shell: 'app', inNav: true },
  { key: 'working-list', path: '/app/working-list', group: 'Enterprise & org', label: 'Working list', icon: 'list-checks', shell: 'app', inNav: true, minAccessLevel: 'admin' , requiresFeature: 'assessments' },
  { key: 'compliance', path: '/app/compliance', group: 'Enterprise & org', label: 'Compliance', icon: 'shield-check', shell: 'app', inNav: true, minAccessLevel: 'admin' , requiresFeature: 'assessments' },
  // The member record (U38). SERVES EVERY MEMBER, not only candidates — an
  // assessor's and an administrator's record is this same screen. No
  // `minAccessLevel`: the `profiles` matrix category is the real gate, and a
  // candidate reaches their OWN record here on the fixed path (R49), so a level
  // floor would lock out the very reader R49 admits.
  { key: 'profile', path: '/app/profile/:id', group: 'Enterprise & org', label: 'Member record', icon: 'user', shell: 'app' , requiresFeature: 'assessments' },
  { key: 'my-profile', path: '/app/profile', group: 'Enterprise & org', label: 'My record', icon: 'user', shell: 'app', inNav: true , requiresFeature: 'assessments' },
  // Bulk workforce import (U23, U24). Admin-only and behind the assessments
  // tier, matching its routes: a row cannot be built without taxonomy the tier
  // does not carry.
  { key: 'workforce-import', path: '/app/workforce-import', group: 'Enterprise & org', label: 'Import workforce', icon: 'upload', shell: 'app', inNav: true, minAccessLevel: 'admin', requiresFeature: 'assessments' },
  { key: 'audit', path: '/app/audit', group: 'Enterprise & org', label: 'Audit log', icon: 'scroll-text', shell: 'app', inNav: true , requiresFeature: 'auditExport' },
  { key: 'billing', path: '/app/billing', group: 'Enterprise & org', label: 'Billing', icon: 'credit-card', shell: 'app', inNav: true },
  { key: 'competency', path: '/app/competency', group: 'Competency gating', label: 'Competency gating', icon: 'graduation-cap', shell: 'app', inNav: true , requiresFeature: 'competencyGating' },

  // Multi-part assessments. The case list is one screen for two audiences —
  // an assessor sees the org's cases, a candidate sees their own — because the
  // API scopes the read by permission rather than the screen filtering it.
  { key: 'assessments', path: '/app/assessments', group: 'Assessments', label: 'Assessments', icon: 'clipboard-check', shell: 'app', inNav: true , requiresFeature: 'assessments' },
  // Progress across every case in one table. Declared BEFORE the case route so
  // the literal segment is listed ahead of the parameter it would otherwise be
  // read as; the API declares its matching endpoint in the same order.
  { key: 'assessment-progress', path: '/app/assessments/progress', group: 'Assessments', label: 'Assessment progress', icon: 'gauge', shell: 'app' , requiresFeature: 'assessments' },
  // Literal 'queue' segment, so it is not read as `/app/assessments/:id`; the API
  // gate is the real access boundary, this only hides the nav entry (U13).
  { key: 'assessment-queue', path: '/app/assessments/queue', group: 'Assessments', label: 'Assessment queue', icon: 'inbox', shell: 'app', inNav: true, minAccessLevel: 'assessor' , requiresFeature: 'assessments' },
  // Who fills each section of an assessment, and in what order. Under a literal
  // /tools/ segment rather than another parameter on /assessments/:id, which
  // would be read as a case id — the same reason `progress` is declared above.
  { key: 'workflow-builder', path: '/app/assessments/tools/:toolId/workflow', group: 'Assessments', label: 'Assessment workflow', icon: 'workflow', shell: 'app' },
  // Building an assessment tool from a printed PDF. Declared BEFORE
  // `assessment-case` for the same reason `progress` is: `/app/assessments/builder`
  // would otherwise match `/app/assessments/:id` and be read as a case id.
  { key: 'assessment-builder', path: '/app/assessments/builder', group: 'Assessments', label: 'Assessment builder', icon: 'sparkles', shell: 'app' },
  { key: 'assessment-builder-draft', path: '/app/assessments/builder/:draftId', group: 'Assessments', label: 'Assessment builder', icon: 'sparkles', shell: 'app' },
  { key: 'assessment-case', path: '/app/assessments/:id', group: 'Assessments', label: 'Assessment case', icon: 'clipboard-list', shell: 'app' },
  // Filling one part of a case. Addressed by ATTEMPT id, not part key: a retry
  // is a distinct attempt row, and the URL has to say which one is being
  // answered or a resumed link would reopen the wrong one.
  // Placing field geometry on an existing form, without re-importing it. A
  // re-import re-extracts and re-assigns every field id, which silently
  // invalidates any assessment tool keyed to those ids.
  { key: 'geometry-editor', path: '/app/forms/:id/versions/:versionId/placement', group: 'Core product loop', label: 'Field placement', icon: 'square-dashed', shell: 'app' },
  { key: 'assessment-part-fill', path: '/app/assessments/:id/attempts/:attemptId', group: 'Assessments', label: 'Complete assessment part', icon: 'pen-line', shell: 'app' },
  { key: 'api-keys', path: '/app/settings/api-keys', group: 'Enterprise & org', label: 'API keys', icon: 'key', shell: 'app', inNav: true },
  { key: 'whitelabel', path: '/app/settings/branding', group: 'Enterprise & org', label: 'Branding', icon: 'sliders-horizontal', shell: 'app', inNav: true },
  // The identities this org's forms are presented in — usually clients', not
  // its own. Declared AFTER `whitelabel` so the more specific static path is
  // matched on its own terms rather than by the branding route.
  { key: 'client-brands', path: '/app/settings/client-brands', group: 'Enterprise & org', label: 'Client brands', icon: 'palette', shell: 'app', inNav: true },

  // Mobile (responsive web)
  { key: 'mobile', path: '/m', group: 'Mobile app', label: 'Mobile field app', icon: 'smartphone', shell: 'mobile' },
];

export const NAV_SCREENS = SCREENS.filter((s) => s.inNav);

/**
 * The nav screens a member of the given access level may see. A screen with no
 * `minAccessLevel` is visible to everyone; one that sets it is hidden from
 * levels that do not rank high enough (an Admin-only screen never appears on a
 * viewer's or candidate's sidebar).
 */
export function navScreensFor(
  role: string | undefined,
  /*
    The organisation's resolved plan features, from the session. UNDEFINED means
    not yet known (the session is still loading), and is treated as "hide the
    gated entries" — an entry that appears and then vanishes is worse than one
    that appears a moment late, and this is the only reading that never
    advertises a surface the organisation does not hold.
  */
  features?: Readonly<Record<string, boolean>> | null,
): ScreenDef[] {
  const rank = ACCESS_RANK[role ?? ''] ?? 0;
  return NAV_SCREENS.filter(
    (s) =>
      (!s.minAccessLevel || rank >= (ACCESS_RANK[s.minAccessLevel] ?? Number.POSITIVE_INFINITY)) &&
      (!s.requiresFeature || features?.[s.requiresFeature] === true),
  );
}

export function screenByPath(pathname: string): ScreenDef | undefined {
  return SCREENS.find((s) => s.path === pathname);
}
