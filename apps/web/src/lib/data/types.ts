/**
 * View-model types for the web data layer. These are the shapes screens read;
 * they align with @formai/shared domain types where practical and add the
 * display-only fields the UI carries (icon, version label, relative "updated"
 * strings). The `store` maps the raw `apps/api` DTOs into these shapes behind
 * the hook surface, so screens never see the wire format.
 */
import type {
  BrandingKit,
  CompetencyStatus,
  DisplayIdentifier,
  ExtractionResult,
  FormContainer,
  FormField,
  SubmissionStatus,
  SubmissionValue,
  TaxonomyStatus,
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
  /**
   * Per-form voice-input override: null inherits the workspace default,
   * true/false pins this form. Edited from the form library rail.
   */
  voiceInput: boolean | null;
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
  /**
   * Server-stamped submitter identity (session user, verified server-side);
   * null for public fill-link / legacy rows, whose `who` is a free-text claim.
   */
  submittedBy: { userId: string; name: string } | null;
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
  /** The MEMBERSHIP id — what team management routes address. */
  id: string;
  /**
   * The USER id — what anything recording something against a person keys on
   * (an assessment case, a competency grant). Null for a pending invite, which
   * has no user yet. Distinct from `id`: passing a membership id where a user
   * id is wanted validates as a UUID and then matches nothing.
   */
  userId: string | null;
  name: string;
  email: string;
  role: RoleName;
  status: MemberStatus;
}

/* ── API keys ─────────────────────────────────────────────────────────────── */

/**
 * A machine credential, as the settings screen sees it.
 *
 * There is no `key` field: the plaintext exists once, in the create response
 * (`CreatedApiKey`), and is never retrievable afterwards. `prefix` is what
 * identifies a key in the list.
 */
export interface ApiKey {
  id: string;
  name: string;
  role: RoleName;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** The create response — the only place the plaintext ever appears. */
export interface CreatedApiKey extends ApiKey {
  key: string;
}

/** Roles a key may carry. Candidate is scoped to its own records, so it is not offered. */
export const API_KEY_ROLES: RoleName[] = ['Admin', 'Builder', 'Reviewer', 'Viewer'];

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

/**
 * Mirror of `PlanFeatures` in `packages/db/src/plans.ts`, which `GET /org/billing`
 * serves verbatim.
 *
 * Duplicated on purpose — `apps/web` does not depend on `@formai/db`, and it
 * must not: pulling the DB package into the browser bundle would drag drizzle
 * and the schema along with it. The cost is that the two definitions can drift,
 * so a flag added there has to be added here in the same change or the payload
 * quietly grows a key no screen can read.
 */
export interface PlanFeatures {
  /** Logo, colours and font on forms. Free at every tier (R9). */
  branding: boolean;
  /** Custom domain / sender address / badge removal. Business+ only. */
  whiteLabel: boolean;
  /**
   * Smart Fill — AI mapping of one spoken transcript onto many fields at once.
   * Business+ only. Gates the AI step alone; on-device dictation into a single
   * field is free at every tier and never reads this.
   */
  smartFill: boolean;
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

/** What `GET /invites/:token` discloses before sign-in: enough to decide, nothing more. */
export interface PublicInvite {
  orgName: string;
  role: string;
  /**
   * The address the invite was sent to — shown for recognition, never used to
   * authorize. NULL on a QR/link invite handed over in person, which has no
   * address at all.
   */
  email: string | null;
  /** Who the invite was raised for, so a QR invite still identifies itself. */
  inviteeName: string;
}

/**
 * What the public `GET /fill/:token` serves an anonymous visitor: the form
 * itself plus just enough org identity to brand the page. `versionId` pins
 * the exact published version served — the submit echoes it back.
 */
export interface PublicFillForm {
  formName: string;
  orgName: string;
  orgBranding: BrandingKit | null;
  versionId: string;
  fields: FormField[];
  container: FormContainer;
  /**
   * Whether this org's plan includes Smart Fill. The only plan detail on the
   * anonymous payload, and deliberately a bare boolean: this page has no
   * session and no `useBilling()`, so without it the mic can only be offered
   * optimistically and withdrawn after the first 403 — a control that fails on
   * press. The tier itself stays server-side.
   */
  smartFillEnabled: boolean;
  /**
   * Voice input for THIS form, already resolved server-side (form override <-
   * workspace default <- on), exactly as the theme arrives pre-merged. Gates
   * the per-field dictation mics; Smart Fill folds the same flag into
   * `smartFillEnabled` above.
   */
  voiceInputEnabled: boolean;
}

/**
 * A draft theme proposed from the org's website. Mirrors the API's
 * `BrandScanProposal`. Nothing here is saved until the owner applies it.
 */
export interface BrandScanProposal {
  sourceUrl: string;
  siteName: string | null;
  colors: { primary?: string; secondary?: string; accent?: string };
  font: string | null;
  logoCandidates: string[];
  palette: string[];
  empty: boolean;
  notes: string[];
}

/* ── Competency gating (Phase 4) ─────────────────────────────────────────── */

/** A held-competency record synced from the org's LMS. */
export interface Competency {
  id: string;
  name: string;
  /** Nationally-recognised code, e.g. "RIIWHS204E". */
  code: string;
  /**
   * How many people have been granted it and not had it revoked. NOT how many
   * are currently in date — expiry moves with the calendar, and a stored count
   * cannot. Currency is per person, from `GET /competencies/held/:userId`.
   */
  holders: number;
  /** How long it stays valid from the day it was earned. Null never expires. */
  validForMonths: number | null;
  /** How long past expiry it still counts while the holder requalifies. */
  gracePeriodDays: number | null;
  /** CSS-var colour token for the competency's dot. */
  color: string;
}

/**
 * One person's hold on one competency, and whether it still counts.
 *
 * This is what `Competency.holders` cannot tell you: which people, and how many
 * of them are actually in date. The list arrives already sorted by what needs
 * doing — expired, then grace, then expiring, then held — so screens render it
 * in order rather than re-deriving urgency.
 */
export interface CompetencyHolder {
  userId: string;
  /** "Unknown user" when the grant outlived the user row it points at. */
  name: string;
  email: string | null;
  /** Free-text pointer at an external record. Display only; nothing resolves it. */
  evidenceRef: string | null;
  grantedAt: string;
  /** ISO instant, or null when the competency has no validity period. */
  expiresAt: string | null;
  status: CompetencyStatus;
  /** Still satisfies a requirement — held, expiring or grace. */
  current: boolean;
  /** Wording for a status worth saying out loud; null when there is nothing. */
  note: string | null;
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

/**
 * One template version, read on its own rather than through the form.
 *
 * Carries `sourcePdfAssetId` because the geometry editor has nothing to place
 * boxes on without the original page images.
 */
export interface FormVersionDetail {
  id: string;
  templateId: string;
  label: string;
  state: 'draft' | 'published' | 'archived';
  /** True when this version is the one live fills and submissions pin to. */
  isCurrent: boolean;
  fields: FormField[];
  container: FormContainer;
  sourcePdfAssetId: string | null;
}

/* ── Taxonomy (Locations, Departments, Roles) ─────────────────────────────── */

/** A managed Location the organisation assesses at. */
export interface TaxLocation {
  id: string;
  name: string;
  status: TaxonomyStatus;
  createdAt: string;
}

/** A job Role offered within a Department. */
export interface TaxRole {
  id: string;
  departmentId: string;
  name: string;
  status: TaxonomyStatus;
  createdAt: string;
}

/** A Department, carrying the Roles it offers and its one-or-several rule (R5). */
export interface TaxDepartment {
  id: string;
  name: string;
  allowsMultipleRoles: boolean;
  status: TaxonomyStatus;
  createdAt: string;
  roles: TaxRole[];
}

/** The three organisation settings that govern how far a person may spread (R24, R25, R40). */
export interface TaxonomySettings {
  allowMultipleLocations: boolean;
  allowMultipleDepartments: boolean;
  displayIdentifier: DisplayIdentifier;
}

/** The whole taxonomy in one read, for the settings screen. */
export interface Taxonomy {
  locations: TaxLocation[];
  departments: TaxDepartment[];
  settings: TaxonomySettings;
}

/** Where a member is placed — the ids on their membership (R21). */
export interface MemberPlacement {
  locationIds: string[];
  departmentIds: string[];
  roleIds: string[];
}
