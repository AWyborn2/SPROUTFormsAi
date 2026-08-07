/**
 * Seed data — lifted verbatim from the prototype's mock state (the
 * `data-dc-script` block) so screens render the same content the design
 * validated. Values, ids, dates, and confidence scores match the prototype.
 */
import type {
  AuditEntry,
  Competency,
  CompetencyRule,
  FormDetail,
  FormSummary,
  FormVersionSummary,
  Member,
  PermCategoryDef,
  PermState,
  RoleName,
  SubmissionRow,
} from './types.js';

/** Icon tile background/foreground per form icon (from vmDash). */
export const FORM_ICON_STYLE: Record<string, { bg: string; color: string }> = {
  handshake: { bg: 'var(--surface-accent-soft)', color: 'var(--accent)' },
  receipt: { bg: '#e9f1f6', color: 'var(--info)' },
  'clipboard-check': { bg: '#fbf1e0', color: 'var(--warning)' },
  'hard-hat': { bg: 'var(--surface-sunken)', color: 'var(--text-secondary)' },
};

/* ── Enterprise & org (Phase 3) ──────────────────────────────────────────── */

/** Per-role one-line descriptions shown in the roles rail (vmRoles §2161). */
export const ROLE_DESCRIPTIONS: Record<RoleName, string> = {
  Owner: 'Full control, including billing and deletion',
  Admin: 'Manage forms, people and settings',
  Builder: 'Create and edit forms and submissions',
  Reviewer: 'Review and export submissions',
  Viewer: 'Read-only access to forms & data',
  Assessor: 'Runs assessments; views the team and submissions',
  Candidate: 'The person being assessed; sees only their own cases',
};

/** Capability categories × actions — the permission-matrix shape (vmRoles). */
export const PERM_CATEGORIES: PermCategoryDef[] = [
  { key: 'forms', label: 'Forms & templates', actions: [['view', 'View'], ['create', 'Create'], ['edit', 'Edit'], ['delete', 'Delete']] },
  { key: 'submissions', label: 'Submissions', actions: [['view', 'View'], ['export', 'Export'], ['delete', 'Delete']] },
  { key: 'team', label: 'Team & roles', actions: [['view', 'View'], ['invite', 'Invite'], ['manage', 'Manage']] },
  { key: 'billing', label: 'Billing', actions: [['view', 'View'], ['manage', 'Manage']] },
  { key: 'audit', label: 'Audit log', actions: [['view', 'View']] },
  // Assessments were absent from the matrix, so Assessor's and Candidate's
  // capabilities — which are almost entirely assessment grants — never showed
  // (R29, R30, R31). Candidate's view/edit are scoped ('own'), rendered
  // distinctly by the screen.
  {
    key: 'assessments',
    label: 'Assessments',
    actions: [
      ['view', 'View'],
      ['create', 'Create'],
      ['edit', 'Edit'],
      ['delete', 'Delete'],
      ['export', 'Export'],
    ],
  },
  // Member profiles and personal information (R33, R34). Three grants —
  // viewing, editing and approving a document — with no export switch, because
  // exporting a member's record stays Admin-only whatever the matrix says.
  {
    key: 'profiles',
    label: 'Profiles & personal info',
    actions: [
      ['view', 'View'],
      ['edit', 'Edit'],
      ['approve', 'Approve documents'],
    ],
  },
];

/** Per-category icon + colour for audit rows (vmAudit `catMeta`). */
export const AUDIT_CATEGORY_META: Record<AuditEntry['category'], { icon: string; color: string }> = {
  forms: { icon: 'file-text', color: 'var(--info)' },
  team: { icon: 'users', color: 'var(--accent)' },
  submissions: { icon: 'inbox', color: 'var(--warning)' },
  settings: { icon: 'palette', color: 'var(--text-secondary)' },
  security: { icon: 'shield', color: 'var(--danger)' },
  general: { icon: 'activity', color: 'var(--text-secondary)' },
  /** A profile field edit or the unreachable mark (U29, U36, R57). */
  profiles: { icon: 'user', color: 'var(--accent)' },
  /** A candidate seat block bought at the allocation boundary (U37, R86). */
  billing: { icon: 'credit-card', color: 'var(--warning)' },
};

/** Category filter pills for the audit screen (vmAudit `filters`). */
export const AUDIT_FILTERS: Array<{ key: string; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'forms', label: 'Forms' },
  { key: 'submissions', label: 'Submissions' },
  { key: 'team', label: 'Team' },
  { key: 'security', label: 'Security' },
];

/* ── Competency gating (Phase 4) ─────────────────────────────────────────── */
