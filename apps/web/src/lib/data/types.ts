/**
 * View-model types for the web data layer. These are the shapes screens read;
 * they align with @formai/shared domain types where practical and add the
 * display-only fields the UI carries (icon, version label, relative "updated"
 * strings). The `store` maps the raw `apps/api` DTOs into these shapes behind
 * the hook surface, so screens never see the wire format.
 */
import type {
  BrandingKit,
  FormBrandKit,
  CompetencyStatus,
  DateFormat,
  DisplayIdentifier,
  ExtractionResult,
  FormContainer,
  FormField,
  Standing,
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
  /** Who published the current version — the library's "owner" filter. Null on never-published drafts. */
  owner: string | null;
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
  /** The paper document's own revision identity — set by assessment-tool revisions. */
  revisionIdentity?: { code?: string; reviewedOn?: string; note?: string };
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
  /**
   * The brand this form is presented in — usually a client's, not the org's.
   * Null means the org's own theme, which is the fallback for a form nobody
   * has assigned rather than a claim that the form is ours.
   */
  brandId: string | null;
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
export const ROLE_NAMES = [
  'Owner',
  'Admin',
  'Builder',
  'Reviewer',
  'Viewer',
  'Assessor',
  'Candidate',
] as const;
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
  /**
   * The name of the Admin who issued this key, where they have since been
   * DEACTIVATED (R65); null otherwise.
   *
   * The key is the organisation's and keeps working — revoking it on somebody's
   * departure would turn an HR event into an unannounced outage — but they hold
   * a copy of the plaintext, so an Admin needs to see which keys are worth
   * rotating.
   */
  issuerDeactivatedName?: string | null;
}

/** The create response — the only place the plaintext ever appears. */
export interface CreatedApiKey extends ApiKey {
  key: string;
}

/** Roles a key may carry. Candidate is scoped to its own records, so it is not offered. */
export const API_KEY_ROLES: RoleName[] = ['Admin', 'Builder', 'Reviewer', 'Viewer'];

/** Category keys used to colour/icon and filter audit entries. */
export type AuditCategory =
  | 'forms'
  | 'submissions'
  | 'team'
  | 'settings'
  | 'security'
  | 'general'
  /** A profile field edit or the unreachable mark (U29, U36, R57). */
  | 'profiles'
  /** A candidate seat block added at the allocation boundary (U37, R86). */
  | 'billing';

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

/** Permission actions across all categories. `approve` is used by the profiles category (R34). */
export type PermAction =
  | 'view'
  | 'create'
  | 'edit'
  | 'delete'
  | 'export'
  | 'invite'
  | 'manage'
  | 'approve';

/** One capability category and the actions it exposes in the matrix. */
export interface PermCategoryDef {
  key: string;
  label: string;
  /** [action key, action label] pairs, in display order. */
  actions: Array<[PermAction, string]>;
}

/**
 * role → category → action → grant. The grant is `true` (org-wide), `false`
 * (denied), or `'own'` (scoped to the user's own records — a Candidate confined
 * to their own cases). The scoped value must survive to the screen so it renders
 * distinctly rather than as a plain ON switch a toggle would collapse.
 */
export type PermGrant = boolean | 'own';
export type PermState = Record<RoleName, Record<string, Partial<Record<PermAction, PermGrant>>>>;

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
  /**
   * Nationally-recognised code, e.g. "RIIWHS204E". Null where there genuinely
   * is none — an internal competency such as a contractor endorsement form.
   * Strongly preferred everywhere else, and rendered exactly as before when set.
   */
  code: string | null;
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
  /** Null when the source never recorded one (R153, reversed) — held, but undated. */
  grantedAt: string | null;
  /** ISO instant, or null when the competency has no validity period. */
  expiresAt: string | null;
  status: CompetencyStatus;
  /**
   * Revoked beats the date: a grant taken away by an appeal or an admin. Shown
   * as a mark rather than a status badge (R104), and never `current`.
   */
  revoked: boolean;
  /**
   * Whether this person's held Roles OBLIGE them to hold this competency (R108).
   * Answers a different question from `current`: standing is about obligation,
   * currency is about the date.
   */
  standing: Standing;
  /** Still satisfies a requirement — held, expiring or grace, and not revoked. */
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

/**
 * One person a Department tightening still has to resolve (U17, R112): they hold
 * more than one of the Department's Roles, and an Admin picks which survives. A
 * LIVE list — a person drops off it the moment they are resolved.
 */
export interface TighteningReviewItem {
  membershipId: string;
  userId: string | null;
  name: string;
  /** This Department's Roles the person holds — the Admin keeps exactly one. */
  heldRoles: Array<{ id: string; name: string }>;
}

/** One person-competency gap on the compliance report (U20). */
export interface ComplianceGap {
  userId: string;
  name: string;
  competencyId: string;
  competencyName: string;
}

/** How the workforce stands, as an auditor reads it (U20). */
export interface ComplianceReport {
  /** A required competency that lapsed on its date. */
  expired: ComplianceGap[];
  /** A required competency the person has never held. */
  neverHeld: ComplianceGap[];
  /** A held competency that lapsed but no Role requires — reported, not a failure (R102). */
  optionalLapses: ComplianceGap[];
  /** Members no notification can reach: no login AND a flagged address (R98, R99). */
  unreachable: UnreachableMember[];
}

/**
 * A member no notification can reach (U36, R98, R99).
 *
 * NOT a `ComplianceGap`: this is about a person, not a competency, so it carries
 * no competency to name. Typing it as one rendered a blank second column and
 * keyed the row on an undefined id.
 */
export interface UnreachableMember {
  userId: string;
  name: string;
  /** The profile carrying the mark — what an Admin opens to clear it. */
  membershipId: string;
}

/** One thing waiting on an Admin, from any source, on the one working list (U19). */
export interface WorkingListItem {
  kind:
    | 'training_request'
    | 'retirement_review'
    | 'overdue_case'
    | 'owed_file'
    | 'unreachable'
    | 'api_key_review';
  id: string;
  subject: string;
  createdAt: string | null;
}

/** An expiry notice served on a person's own record — a login delivery route (U21, R98). */
export interface ExpiryNotice {
  id: string;
  competencyId: string;
  competencyName: string;
  /** `YYYY-MM-DD` — when the competency expires. */
  expiresOn: string;
  sentAt: string;
}

/** A voluntary training request (U22). Pending ones wait on the working list. */
export interface TrainingRequest {
  id: string;
  userId: string;
  toolId: string;
  state: 'pending' | 'approved' | 'declined';
  createdAt: string;
}

/** One active person still holding a retired value (U18, R116). */
export interface ReviewHolder {
  membershipId: string;
  userId: string;
  name: string;
}

/** A retired value and the active people still holding it (U18). */
export interface RetiredValueReview {
  id: string;
  name: string;
  holders: ReviewHolder[];
}

/**
 * The people still holding a retired value, by axis (U18, KTD8). A pure read: a
 * value returned to active drops out because nobody holds "something retired"
 * any more (R123).
 */
export interface RetirementReview {
  locations: RetiredValueReview[];
  departments: RetiredValueReview[];
  roles: Array<RetiredValueReview & { departmentId: string }>;
}

/** The three organisation settings that govern how far a person may spread (R24, R25, R40). */
export interface TaxonomySettings {
  allowMultipleLocations: boolean;
  allowMultipleDepartments: boolean;
  displayIdentifier: DisplayIdentifier;
  /** Days before a pooled case reads as overdue (U13, R63). */
  pooledCaseOverdueDays: number;
  /** Days ahead of an expiry the sweep notifies a holder (U21, KTD12). */
  notificationLeadDays: number;
  /** How the organisation writes an ambiguous slash-separated date. */
  dateFormat: DateFormat;
}

/** The whole taxonomy in one read, for the settings screen. */
export interface Taxonomy {
  locations: TaxLocation[];
  departments: TaxDepartment[];
  settings: TaxonomySettings;
}

/** Where a member is placed — the ids on their membership (R21). */
/**
 * A member's workforce record as its reader is admitted to it (U29, U38, R1).
 *
 * `displayName` and `indigenousStatus` are DERIVED by the API and stored
 * nowhere (R3, R15, KTD19) — the screen renders them and offers no way to enter
 * them.
 */
export interface MemberProfile {
  membershipId: string;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  displayName: string;
  identifier: string | null;
  gender: string | null;
  ethnicity: string | null;
  indigenousStatus: 'indigenous' | 'not_indigenous' | 'not_stated';
  dateOfBirth: string | null;
  addressStreet: string | null;
  suburb: string | null;
  postcode: string | null;
  mobile: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  starterType: string | null;
  employeeNumber: string | null;
  swipeCardNumber: string | null;
  inductionDate: string | null;
  /**
   * On `users`, not the profile — unique product-wide and the person-record
   * lookup key (R16). Read here so the record renders it; not writable through
   * the profile route, which `editableFields` already reflects.
   */
  email: string | null;
  /** Set where an Admin flagged the address as reaching nobody (U36, R16). */
  emailUnreachableAt: string | null;
}

/**
 * What THIS reader may do with the record (R44).
 *
 * Resolved per section rather than as one grant, which is what lets an
 * organisation restrict fields while leaving documents open — a screen with only
 * two states would render that configuration as a blank page.
 */
export interface ProfileAccess {
  canViewDocuments: boolean;
  canViewCompetencies: boolean;
  canApprove: boolean;
  /** Field keys this caller may write. Empty means read-only (R51, R53). */
  editableFields: string[];
  /** True where the caller IS the member, on the fixed own-record path (R49). */
  isSubject: boolean;
}

/**
 * One held competency on a member's record (U38, R37, R104).
 *
 * STANDING and CURRENCY are two facts, not one. Standing is obligation and
 * follows the person's Roles; currency is eligibility and follows the
 * competency's own dates. A reader who cannot tell them apart reads an expired
 * OPTIONAL competency as a compliance failure, which it is not (R102).
 */
export interface HeldCompetencyRow {
  competencyId: string;
  /** The competency's display name — records never show a raw id. */
  name: string;
  code: string | null;
  evidenceRef: string | null;
  /** Set only where this grant IS a licence (R34). */
  licenceClass: string | null;
  licenceNumber: string | null;
  status: CompetencyStatus;
  standing: Standing;
  /** True while it still satisfies a requirement — held, expiring or grace. */
  current: boolean;
  expiresAt: string | null;
  note: string | null;
}

/**
 * What an induction submission would put on a profile (U40, R87-R94).
 *
 * `disposition` is the whole point: a submission for somebody who already holds
 * a record creates NOTHING and goes to an Admin instead (R89, R90).
 */
export interface ProfileSeedResponse {
  submissionId: string;
  disposition: 'create' | 'existing_record' | 'deactivated';
  seed: {
    fields: Record<string, string>;
    department: string;
    roles: string[];
    email: string;
    indigenousStatus: 'indigenous' | 'not_indigenous' | 'not_stated';
    /** Answers the organisation's CURRENT lists no longer offer (R94). */
    unmatched: Array<{ key: string; value: string }>;
  };
  /** Set on a repeat, so an Admin can open the record rather than retype it. */
  membershipId: string | null;
}

/* ── Workforce import (U23, U24) ──────────────────────────────────────────── */

/** One row the validator refused, with the reason an Admin fixes the file by. */
export interface WorkforceImportRejection {
  rowNumber: number;
  subject: string;
  reason: string;
  detail?: string;
}

/** One pool's share of what a file costs (R144). */
export interface WorkforceSeatCost {
  needed: number;
  /** Seats the allocation still has free; null when the pool is unlimited. */
  available: number | null;
  covered: number;
  overflow: number;
}

/**
 * What a filled file would cost, before anything is written (R144).
 *
 * Both pools are reported separately because each row names its own access
 * level, and one figure would cover only part of what the file spends.
 */
export interface WorkforceImportPreview {
  validRows: number;
  competencyLines: number;
  rejected: WorkforceImportRejection[];
  preview: {
    candidate: WorkforceSeatCost;
    staff: WorkforceSeatCost;
    /** Blocks the candidate overflow would buy (R84, R86). */
    blocks: Array<{ size: number; count: number; seats: number; discount: number }>;
    /** Rows the run will refuse for want of a seat — always the staff pool now. */
    refusedForSeats: number;
  };
}

/** What a completed run did — every figure derived from its recorded rows (R171). */
export interface WorkforceImportRun {
  runId: string;
  startedAt: string;
  completedAt: string | null;
  rowsTotal: number;
  rowsProcessed: number;
  profilesCreated: number;
  membershipsAdded: number;
  membershipsReactivated: number;
  peopleMerged: number;
  duplicateRows: number;
  candidateSeats: number;
  staffSeats: number;
  competenciesRecorded: number;
  linesFlaggedNoDate: number;
  assessmentsAssigned: number;
  profilesFlaggedIncomplete: number;
  differencesReported: number;
  rejected: Array<{ rowNumber: number; subject: string; reason: string; detail: string | null }>;
  flagged: Array<{ rowNumber: number; subject: string; missing: string[] }>;
  differences: Array<{
    rowNumber: number;
    subject: string;
    membershipId: string | null;
    items: Array<{ field: string; existing: string; fromFile: string }>;
  }>;
}

export interface ProfileResponse {
  profile: MemberProfile;
  /**
   * The PERSON behind the membership. Competency grants and assessment cases
   * are keyed on the user, not the membership, so the screen needs both ids.
   */
  userId: string;
  access: ProfileAccess;
}

export interface MemberPlacement {
  locationIds: string[];
  departmentIds: string[];
  roleIds: string[];
}

/**
 * What `POST /form-brands/scan` read off a client's document.
 *
 * A PROPOSAL. Colours are ordered by how often the document sets them, which
 * is not the same as how prominent they are — a table-border colour can lead
 * the list. Logos arrive as base64 rather than uploaded URLs so declining one
 * leaves nothing behind; the chosen one goes through the ordinary upload door.
 */
export interface BrandPdfScan {
  colors: string[];
  logos: Array<{
    imageBase64: string;
    mimeType: 'image/png' | 'image/jpeg';
    width: number;
    height: number;
  }>;
  /** Why the result is thin: a monochrome document, a page cap, an unreadable file. */
  notes: string[];
}

/**
 * What `POST /form-brands/:id/edit` proposed from a described change.
 *
 * A PROPOSAL over the brand's CURRENT kit — nothing is stored, and the author
 * sees it in the live preview before saving. `notes` carries what the model
 * could not do and every value that was refused: a refused value is dropped
 * rather than corrected, so saying so is what makes the author ask again.
 */
export interface BrandEditProposal {
  patch: FormBrandKit;
  /** One short sentence, in plain words rather than token names. */
  summary: string;
  notes: string[];
}

/**
 * One saved assessment-builder draft, as the picker lists it.
 *
 * Mirrors the server's `summarise` exactly — no `state`. That field carries the
 * whole extraction and every answer key, and the list is only choosing which
 * draft to reopen.
 */
export interface BuilderDraftSummary {
  id: string;
  name: string;
  assetId: string | null;
  /** Where the author stopped. A retired step resolves on load, not here. */
  step: string;
  formId: string | null;
  versionId: string | null;
  /** Set when the draft revises a published tool — one per tool, server-enforced. */
  revisionOfToolId: string | null;
  savedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A single draft read, which is the summary plus the thing resuming needs.
 *
 * `state` is typed `unknown` rather than `BuilderDraft` on purpose: the column
 * is written by whichever build of the client last saved it, and the route
 * stores it opaque so the builder can add state without a migration. Claiming a
 * shape here would be claiming today's build wrote every row.
 */
export interface BuilderDraftDetail extends BuilderDraftSummary {
  state: unknown;
}

/** The body `POST /assessment-tool-drafts` accepts. Upserts on (org, name). */
export interface SaveBuilderDraftInput {
  name: string;
  assetId: string;
  step?: string;
  state: Record<string, unknown>;
  formId?: string | null;
  versionId?: string | null;
  /** Set when the draft revises a published tool — the server enforces one per tool. */
  revisionOfToolId?: string | null;
}
