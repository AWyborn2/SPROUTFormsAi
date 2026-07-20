/**
 * View-model types for the web data layer. These are the shapes screens read;
 * they align with @formai/shared domain types where practical and add the
 * display-only fields the UI carries (icon, version label, relative "updated"
 * strings). The `store` maps the raw `apps/api` DTOs into these shapes behind
 * the hook surface, so screens never see the wire format.
 */
import type {
  BrandingKit,
  ExtractionResult,
  FormContainer,
  FormField,
  SubmissionStatus,
  SubmissionValue,
} from '@formai/shared';

export type TemplateStatus = 'draft' | 'published' | 'archived';
export type FormSourceType = 'pdf_import' | 'built_from_scratch';

/** A row in the form library / dashboard "your forms" list. */
export interface FormSummary {
  id: string;
  name: string;
  dept: string;
  /** Lucide icon name for the form's tile. */
  icon: string;
  status: TemplateStatus;
  sourceType: FormSourceType;
  /**
   * Id of the template's current version — the version a fill surface renders,
   * echoed back on submit so the server pins what the filler actually saw.
   * Null while the template has no published version.
   */
  currentVersionId: string | null;
  /** Current published version label, e.g. "v3". */
  version: string;
  submissions: number;
  /** Relative recency string, e.g. "2 days ago". */
  updated: string;
}

/** One immutable version in a template's history. */
export interface FormVersionSummary {
  id: string;
  label: string;
  state: 'draft' | 'published';
  fieldCount: number;
  publishedAt: string;
  publishedBy: string;
  note?: string;
}

/** Full template detail incl. the fields of the current version (builder/fill). */
export interface FormDetail extends FormSummary {
  fields: FormField[];
  container: FormContainer;
  versions: FormVersionSummary[];
}

/** A submissions-table row. */
export interface SubmissionRow {
  id: string;
  formId: string;
  form: string;
  who: string;
  email: string;
  date: string;
  status: SubmissionStatus;
  /** Free-text flag, e.g. "2 fails logged", "ABN mismatch". */
  flag: string;
}

/** A single submission with captured values (detail view). */
export interface SubmissionDetail extends SubmissionRow {
  templateVersionId: string;
  values: Record<string, SubmissionValue>;
  /** Storage handle of the version's original source PDF; null for built-from-scratch forms. */
  sourcePdfAssetId: string | null;
  /** The pinned version's frozen field set (carries `sourcePosition` for AcroForm imports). */
  fields: FormField[];
}

export interface ActivityEntry {
  id: string;
  icon: string;
  actor: string;
  action: string;
  target: string;
  time: string;
}

export interface DashboardStat {
  label: string;
  icon: string;
  iconColor: string;
  value: string;
  delta: string;
  deltaIcon: string;
  deltaTone: 'success' | 'warning' | 'danger';
}

export interface ComplianceRow {
  icon: string;
  tone: 'success' | 'warning' | 'danger';
  label: string;
  value: string;
}

/**
 * Real dashboard aggregates from `GET /dashboard`. Only carries what the API
 * can honestly compute: org-scoped counts plus the recent audit activity —
 * no fabricated deltas or compliance score (those were fixture-only).
 */
export interface DashboardSummary {
  /** Published templates in the org. */
  activeForms: number;
  submissionsTotal: number;
  /** Submissions still awaiting a reviewer decision (submitted/review/pending). */
  pendingReview: number;
  activity: ActivityEntry[];
}

/** Input for publishing an imported PDF as a new form template. */
export interface PublishImportInput {
  name: string;
  fields: FormField[];
  /** Storage handle of the uploaded source PDF (`POST /pdf/upload`) — persisted for the round-trip export. */
  sourcePdfAssetId: string | null;
}

/* ── Enterprise & org (Phase 3) ──────────────────────────────────────────── */

/**
 * Display role names. The prototype keys members and the permission matrix by
 * these capitalised labels; we mirror that here rather than the lowercase
 * `Role` union in @formai/shared, so screens read the same strings the design
 * validated. (@formai/shared `ROLE_LABELS` maps the two if needed later.)
 */
export const ROLE_NAMES = ['Owner', 'Admin', 'Builder', 'Reviewer', 'Viewer'] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

/** Roles that can be assigned via the invite dialog (Owner is not invitable). */
export const INVITABLE_ROLES: RoleName[] = ['Admin', 'Builder', 'Reviewer', 'Viewer'];

export type MemberStatus = 'active' | 'invited';

/** A team member (membership projection). */
export interface Member {
  id: string;
  name: string;
  email: string;
  role: RoleName;
  status: MemberStatus;
}

/** Category keys used to colour/icon and filter audit entries. */
export type AuditCategory = 'forms' | 'submissions' | 'team' | 'settings' | 'security' | 'general';

/** An audit-log row (denormalised for display, matching the prototype shape). */
export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  target: string;
  category: AuditCategory;
  /** Lucide icon name for the row glyph. */
  icon: string;
  /** Relative or absolute time string, e.g. "Just now", "2 days ago". */
  time: string;
}

/** Permission actions across all categories. */
export type PermAction = 'view' | 'create' | 'edit' | 'delete' | 'export' | 'invite' | 'manage';

/** One capability category and the actions it exposes in the matrix. */
export interface PermCategoryDef {
  key: string;
  label: string;
  /** [action key, action label] pairs, in display order. */
  actions: Array<[PermAction, string]>;
}

/** role → category → action → allowed. Mirrors the prototype `perms` object. */
export type PermState = Record<RoleName, Record<string, Partial<Record<PermAction, boolean>>>>;

/* ── Billing / plan tiers ─────────────────────────────────────────────────── */

export type PlanTier = 'individual' | 'team' | 'business' | 'enterprise';

export interface PlanFeatures {
  branding: boolean;
  sso: boolean;
  auditExport: boolean;
  competencyGating: boolean;
}

export interface PlanTierConfig {
  seatLimit: number;
  features: PlanFeatures;
}

/**
 * Real billing data from `GET /org/billing`. Replaces the old fixture-based
 * BillingData shape. Screens use this for current plan info, seat usage, and
 * the dev plan switcher.
 */
export interface OrgBilling {
  planTier: PlanTier;
  seatLimit: number;
  accountKind: 'individual' | 'team';
  seatUsed: number;
  features: PlanFeatures;
  planConfig: Record<PlanTier, PlanTierConfig>;
}

/* ── Public fill links ───────────────────────────────────────────────────── */

/**
 * A shareable public link for a form template (authed management surface,
 * `/forms/:id/fill-links`). `url` is a path only ("/fill/<token>") — prefix
 * the web origin for display/copy (see `fillLinkUrl`).
 */
export interface FillLink {
  id: string;
  token: string;
  url: string;
  /** ISO timestamp of the hard expiry, or null for never. */
  expiresAt: string | null;
  active: boolean;
  createdAt: string;
}

/**
 * What the public `GET /fill/:token` serves an anonymous visitor: the form
 * itself plus just enough org identity to brand the page. `versionId` pins
 * the exact published version served — the submit echoes it back.
 */
/** What `GET /invites/:token` discloses before sign-in: enough to decide, nothing more. */
export interface PublicInvite {
  orgName: string;
  role: string;
  /** The address the invite was sent to — shown for recognition, never used to authorize. */
  email: string;
}

export interface PublicFillForm {
  formName: string;
  orgName: string;
  orgBranding: BrandingKit | null;
  versionId: string;
  fields: FormField[];
  container: FormContainer;
}

/* ── Competency gating (Phase 4) ─────────────────────────────────────────── */

/** A held-competency record synced from the org's LMS. */
export interface Competency {
  id: string;
  name: string;
  /** Nationally-recognised code, e.g. "RIIWHS204E". */
  code: string;
  /** How many people currently hold it. */
  holders: number;
  /** CSS-var colour token for the competency's dot. */
  color: string;
}

/** A rule gating one form section behind a required competency. */
export interface CompetencyRule {
  id: string;
  formId: string;
  /** Denormalised form name for display. */
  form: string;
  /** Human reference to the gated section, e.g. "Roof & height access items". */
  section: string;
  competencyId: string;
  /** Denormalised competency name for display. */
  competency: string;
  enabled: boolean;
}
