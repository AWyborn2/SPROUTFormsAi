/**
 * Screen registry — the single source for routes, nav metadata, and the
 * command-palette / screen-index entries. Mirrors the prototype's screens[]
 * array. Each entry maps a route path to its display metadata.
 */

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
}

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

  // Enterprise & org
  { key: 'team', path: '/app/team', group: 'Enterprise & org', label: 'Team management', icon: 'users', shell: 'app', inNav: true },
  { key: 'roles', path: '/app/roles', group: 'Enterprise & org', label: 'Roles & permissions', icon: 'shield', shell: 'app', inNav: true },
  { key: 'audit', path: '/app/audit', group: 'Enterprise & org', label: 'Audit log', icon: 'scroll-text', shell: 'app', inNav: true },
  { key: 'billing', path: '/app/billing', group: 'Enterprise & org', label: 'Billing', icon: 'credit-card', shell: 'app', inNav: true },
  { key: 'competency', path: '/app/competency', group: 'Competency gating', label: 'Competency gating', icon: 'graduation-cap', shell: 'app', inNav: true },
  { key: 'whitelabel', path: '/app/settings/branding', group: 'Enterprise & org', label: 'White-label settings', icon: 'sliders-horizontal', shell: 'app', inNav: true },

  // Mobile (responsive web)
  { key: 'mobile', path: '/m', group: 'Mobile app', label: 'Mobile field app', icon: 'smartphone', shell: 'mobile' },
];

export const NAV_SCREENS = SCREENS.filter((s) => s.inNav);

export function screenByPath(pathname: string): ScreenDef | undefined {
  return SCREENS.find((s) => s.path === pathname);
}
