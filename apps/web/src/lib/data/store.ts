/**
 * Data layer. `listForms`/`getForm`/`publishBuilder`/`publishImport`/
 * `listSubmissions`/`getSubmission` (Phase 2) and `listMembers`/
 * `setMemberRole`/`removeMember`/`perms`/`togglePermission`/`auditLog`/
 * `listCompetencies`/`listCompetencyRules`/`addRule`/`toggleRule`/
 * `removeRule` (Phase 3) are wired to the real `apps/api` (see
 * `api-client.ts`), as is `dashboard` (org-scoped aggregates via
 * `GET /dashboard`); the external fill flow rides the PUBLIC fill-link
 * routes (`getFillForm`/`submitFill` against `/fill/:token`, managed via
 * `createFillLink`/`listFillLinks`/`revokeFillLink` on `/forms/:id/fill-links`).
 * `billing` aggregates data from `GET /org/billing` (real plan/seat/feature data).
 * `updatePlan` calls `POST /org/plan` (dev/test only — no payment processing).
 * `inviteMember` persists via `POST /team/members`, and `updateOrg` (with
 * `updateWhiteLabel`, which writes through it) persists the org name and
 * branding kit via `PATCH /org`. See the PR description(s) for detail.
 * Query hooks in `hooks.ts` read through this; the hook surface —
 * and therefore the screens — is unchanged either way.
 */
import type { ImportSnapshot } from './import-draft-store.js';
import type {
  BrandingKit,
  FormBrand,
  FormBrandInput,
  FormContainer,
  FormField,
  PermissionCategory,
  PermissionMatrix,
  Role,
  SmartFillRequest,
  SmartFillResult,
  SubmissionStatus,
  SubmissionValue,
} from '@formai/shared';
import { geometrySegments, ROLE_LABELS } from '@formai/shared';
import { ApiError, apiClient } from './api-client.js';
import { ROLE_NAMES } from './types.js';
import type {
  ApiKey,
  AuditCategory,
  AuditEntry,
  CreatedApiKey,
  BrandPdfScan,
  BrandScanProposal,
  Competency,
  CompetencyHolder,
  CompetencyRule,
  DashboardSummary,
  FillLink,
  FormDetail,
  FormSourceType,
  FormSummary,
  FormVersionDetail,
  Member,
  MemberStatus,
  OrgBilling,
  PermAction,
  PermState,
  PlanTier,
  PublicFillForm,
  PublicInvite,
  PublishImportInput,
  RoleName,
  SubmissionDetail,
  SubmissionRow,
  MemberPlacement,
  Taxonomy,
  TaxDepartment,
  TaxLocation,
  TaxRole,
  TaxonomySettings,
  TemplateStatus,
} from './types.js';
import type {
  AssessmentToolManifest,
  RequiredAssessmentsChangeEffects,
  TaxonomyStatus,
} from '@formai/shared';

/** Shape returned by `PATCH /org` (see apps/api routes/org.ts). */
export interface OrgSettingsDto {
  id: string;
  name: string;
  branding: BrandingKit;
  teamSize: string | null;
  onboardingCompletedAt: string | null;
}

/** Raw shapes returned by `apps/api`'s forms/submissions routes (see forms.ts/submissions.ts). */
interface FormSummaryDto {
  id: string;
  name: string;
  dept: string;
  sourceType: FormSourceType;
  status: TemplateStatus;
  currentVersionId: string | null;
  currentVersionLabel: string | null;
  submissionsCount: number;
  updatedAt: string;
}

interface FormDetailDto extends FormSummaryDto {
  fields: FormField[];
  container: FormContainer;
  /** Per-form voice override; null (or absent on older payloads) = inherit. */
  voiceInput?: boolean | null;
  /** The brand the form is presented in; null/absent = the org's own theme. */
  brandId?: string | null;
  versions: Array<{
    id: string;
    label: string;
    state: 'draft' | 'published';
    fieldCount: number;
    publishedAt: string | null;
    publishedByName: string | null;
  }>;
}

interface SubmissionRowDto {
  id: string;
  formId: string;
  form: string;
  who: string;
  email: string;
  status: SubmissionStatus;
  flag: string;
  createdAt: string;
  /** Stamped identity from the users join; null/absent for public or legacy rows. */
  submittedBy?: { userId: string; name: string } | null;
}

interface SubmissionDetailDto extends SubmissionRowDto {
  templateVersionId: string;
  values: Record<string, SubmissionValue>;
  sourcePdfAssetId: string | null;
  fields: FormField[];
}

/** Coarse relative-time formatter for API timestamps ("2 days ago"). */
function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

function iconForSourceType(sourceType: FormSourceType): string {
  return sourceType === 'pdf_import' ? 'upload' : 'file-text';
}

function toFormSummary(dto: FormSummaryDto): FormSummary {
  return {
    id: dto.id,
    name: dto.name,
    dept: dto.dept,
    icon: iconForSourceType(dto.sourceType),
    status: dto.status,
    sourceType: dto.sourceType,
    currentVersionId: dto.currentVersionId,
    version: dto.currentVersionLabel ?? '—',
    submissions: dto.submissionsCount,
    updated: relativeTime(dto.updatedAt),
  };
}

function toFormDetail(dto: FormDetailDto): FormDetail {
  return {
    ...toFormSummary(dto),
    fields: dto.fields,
    container: dto.container,
    voiceInput: dto.voiceInput ?? null,
    brandId: dto.brandId ?? null,
    versions: dto.versions.map((v) => ({
      id: v.id,
      label: v.label,
      state: v.state,
      fieldCount: v.fieldCount,
      publishedAt: v.publishedAt ? relativeTime(v.publishedAt) : '—',
      publishedBy: v.publishedByName ?? '—',
    })),
  };
}

function toSubmissionRow(dto: SubmissionRowDto): SubmissionRow {
  return {
    id: dto.id,
    formId: dto.formId,
    form: dto.form,
    who: dto.who,
    email: dto.email,
    date: relativeTime(dto.createdAt),
    status: dto.status,
    flag: dto.flag,
    submittedBy: dto.submittedBy ?? null,
  };
}

function toSubmissionDetail(dto: SubmissionDetailDto): SubmissionDetail {
  return {
    ...toSubmissionRow(dto),
    templateVersionId: dto.templateVersionId,
    values: dto.values,
    sourcePdfAssetId: dto.sourcePdfAssetId,
    fields: dto.fields,
  };
}

/**
 * Whether a submission's pinned version can round-trip into a filled PDF.
 *
 * Keyed on whether anything can actually be PLACED, not on which extraction
 * path produced the form. "Does any field carry a sourcePosition" was a fair
 * proxy while only the AcroForm path ever recorded positions; it became wrong
 * the moment a reviewer could confirm geometry on an AI-extracted form.
 * `geometrySegments` answers the real question for both sources, so a form
 * round-trips exactly when at least one field has somewhere recorded to draw.
 */
export function canExportSubmission(fields: FormField[]): boolean {
  return fields.some((f) => geometrySegments(f).length > 0);
}

/** `undefined` for a 404 (not found / cross-tenant), rethrows anything else. */
async function getOrUndefined<T>(promise: Promise<T>): Promise<T | undefined> {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return undefined;
    throw err;
  }
}

/** Raw shapes returned by `apps/api`'s team/audit/competency routes. */
interface MemberDto {
  id: string;
  /** The user behind the membership; null on a pending invite, absent on the
   *  create/patch responses, which project a single membership. */
  userId?: string | null;
  name: string;
  email: string;
  role: Role;
  status: 'active' | 'invited' | 'suspended';
  emailSent?: boolean;
  /** Present on a freshly created invite — the link to hand over or print. */
  acceptPath?: string;
}

interface AuditEntryDto {
  id: string;
  actorName: string;
  action: string;
  target: string;
  category: AuditCategory;
  icon: string;
  createdAt: string;
}

/** A saved import, without its snapshot. */
export interface ImportDraftSummary {
  id: string;
  name: string;
  assetId: string;
  savedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CompetencyDto {
  id: string;
  name: string;
  code: string;
  holders: number;
  /** Optional: the column is nullable, and JSON drops an undefined. */
  validForMonths?: number | null;
  gracePeriodDays?: number | null;
}

/** Shape returned by `GET /dashboard` (see apps/api routes/dashboard.ts). */
interface DashboardDto {
  activeForms: number;
  submissionsTotal: number;
  pendingReview: number;
  recentActivity: AuditEntryDto[];
}

interface CompetencyRuleDto {
  id: string;
  templateId: string;
  form: string;
  sectionRef: string;
  competencyId: string;
  competency: string;
  enabled: boolean;
}

/** Raw shape from `apps/api`'s /api-keys routes. */
interface ApiKeyDto {
  id: string;
  name: string;
  role: Role;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

function toApiKey(dto: ApiKeyDto): ApiKey {
  return {
    id: dto.id,
    name: dto.name,
    role: ROLE_LABELS[dto.role] as RoleName,
    prefix: dto.prefix,
    createdAt: dto.createdAt,
    lastUsedAt: dto.lastUsedAt,
    revokedAt: dto.revokedAt,
  };
}

function toMember(dto: MemberDto): Member {
  return {
    id: dto.id,
    userId: dto.userId ?? null,
    name: dto.name,
    email: dto.email,
    role: ROLE_LABELS[dto.role] as RoleName,
    status: (dto.status === 'active' ? 'active' : 'invited') as MemberStatus,
  };
}

function toPermState(dto: Partial<Record<Role, PermissionMatrix>>): PermState {
  const result = {} as PermState;
  for (const roleName of ROLE_NAMES) {
    const role = roleName.toLowerCase() as Role;
    result[roleName] = (dto[role] ?? {}) as PermState[RoleName];
  }
  return result;
}

function toAuditEntry(dto: AuditEntryDto): AuditEntry {
  return {
    id: dto.id,
    actor: dto.actorName,
    action: dto.action,
    target: dto.target,
    category: dto.category,
    icon: dto.icon,
    time: relativeTime(dto.createdAt),
  };
}

/**
 * Smart Fill waits on a model round-trip over a transcript that can run to the
 * API's 4000-character cap, which outlasts the client's 30s default often
 * enough to matter. A timeout here reads to the respondent as "voice is
 * broken", so it is raised rather than left to abort a call that was working.
 */
const SMART_FILL_TIMEOUT_MS = 60_000;

const COMPETENCY_COLOR_PALETTE = ['var(--warning)', 'var(--info)', 'var(--danger)', 'var(--accent)'];
function colorForCompetency(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return COMPETENCY_COLOR_PALETTE[hash % COMPETENCY_COLOR_PALETTE.length]!;
}

function toCompetency(dto: CompetencyDto): Competency {
  return {
    id: dto.id,
    name: dto.name,
    code: dto.code,
    holders: dto.holders,
    validForMonths: dto.validForMonths ?? null,
    gracePeriodDays: dto.gracePeriodDays ?? null,
    color: colorForCompetency(dto.id),
  };
}

function toCompetencyRule(dto: CompetencyRuleDto): CompetencyRule {
  return {
    id: dto.id,
    formId: dto.templateId,
    form: dto.form,
    section: dto.sectionRef,
    competencyId: dto.competencyId,
    competency: dto.competency,
    enabled: dto.enabled,
  };
}

export const store = {
  listForms(): Promise<FormSummary[]> {
    return apiClient.get<FormSummaryDto[]>('/forms').then((rows) => rows.map(toFormSummary));
  },

  getForm(id: string): Promise<FormDetail | undefined> {
    return getOrUndefined(apiClient.get<FormDetailDto>(`/forms/${id}`).then(toFormDetail));
  },

  listSubmissions(): Promise<SubmissionRow[]> {
    return apiClient.get<SubmissionRowDto[]>('/submissions').then((rows) => rows.map(toSubmissionRow));
  },

  getSubmission(id: string): Promise<SubmissionDetail | undefined> {
    return getOrUndefined(apiClient.get<SubmissionDetailDto>(`/submissions/${id}`).then(toSubmissionDetail));
  },

  /**
   * Records a submission on the AUTHED path. `submitterName`/`submitterEmail`
   * are deliberately not sent: the API stamps identity from the session and
   * ignores any claim in the body (AE3), so passing one would only suggest it
   * mattered. `versionId` is echoed from the version the screen actually
   * rendered, pinning the submission to what the filler saw (AE2).
   */
  createSubmission(input: {
    templateId: string;
    versionId: string;
    values: Record<string, SubmissionValue>;
  }): Promise<SubmissionRow> {
    return apiClient.post<SubmissionRowDto>('/submissions', input).then(toSubmissionRow);
  },

  /**
   * The export sends the submission id and nothing else: the API loads the
   * pinned version's fields and the stored values itself and applies the
   * visibility filter server-side (U11). Sending fields/values from here would
   * make the exported PDF a render of whatever the browser said, rather than
   * evidence of what was recorded.
   */
  exportSubmissionPdf(detail: SubmissionDetail): Promise<Blob> {
    return apiClient.postForBlob('/pdf/round-trip', { submissionId: detail.id });
  },

  setSubmissionStatus(input: { id: string; status: 'approved' | 'rejected' }): Promise<SubmissionRow> {
    return apiClient
      .patch<SubmissionRowDto>(`/submissions/${input.id}`, { status: input.status })
      .then(toSubmissionRow);
  },

  dashboard(): Promise<DashboardSummary> {
    return apiClient.get<DashboardDto>('/dashboard').then((dto) => ({
      activeForms: dto.activeForms,
      submissionsTotal: dto.submissionsTotal,
      pendingReview: dto.pendingReview,
      activity: dto.recentActivity.map(toAuditEntry),
    }));
  },

  publishBuilder(input: { name: string; fields: FormField[]; container: FormContainer }): Promise<FormSummary> {
    return apiClient
      .post<FormSummaryDto>('/forms', {
        name: input.name,
        sourceType: 'built_from_scratch',
        fields: input.fields,
        container: input.container,
        publish: true,
      })
      .then(toFormSummary);
  },

  publishVersion(input: { formId: string; fields: FormField[]; container: FormContainer }): Promise<FormSummary> {
    return apiClient
      .post<FormSummaryDto>(`/forms/${input.formId}/versions`, {
        fields: input.fields,
        container: input.container,
        publish: true,
      })
      .then(toFormSummary);
  },

  publishImport(input: PublishImportInput): Promise<FormSummary> {
    return apiClient
      .post<FormSummaryDto>('/forms', {
        name: input.name,
        sourceType: 'pdf_import',
        fields: input.fields,
        ...(input.sourcePdfAssetId ? { sourcePdfAssetId: input.sourcePdfAssetId } : {}),
        publish: true,
      })
      .then(toFormSummary);
  },

  /** Re-extract: a new version of an EXISTING form carrying the re-imported PDF. */
  createVersionFromImport(input: {
    formId: string;
    fields: FormField[];
    sourcePdfAssetId?: string;
    publish: boolean;
  }): Promise<FormSummary> {
    return apiClient
      .post<FormSummaryDto>(`/forms/${input.formId}/versions`, {
        fields: input.fields,
        ...(input.sourcePdfAssetId ? { sourcePdfAssetId: input.sourcePdfAssetId } : {}),
        publish: input.publish,
      })
      .then(toFormSummary);
  },

/**
   * One version's own fields — what the geometry editor reads.
   *
   * `form(id)` serves the CURRENT version, which is the wrong answer while
   * editing a draft fork.
   */
  formVersion(input: { formId: string; versionId: string }): Promise<FormVersionDetail> {
    return apiClient.get<FormVersionDetail>(`/forms/${input.formId}/versions/${input.versionId}`);
  },

  /**
   * Save edited fields onto a DRAFT version.
   *
   * The API refuses a published version outright — submissions pin to a
   * version, so rewriting one rewrites what already-signed records render
   * against. Fork a draft and publish that instead.
   */
  saveVersionFields(input: {
    formId: string;
    versionId: string;
    fields: FormField[];
  }): Promise<{ id: string; state: string; fieldCount: number }> {
    return apiClient.patch(`/forms/${input.formId}/versions/${input.versionId}`, {
      fields: input.fields,
    });
  },

/**
   * Fork the current version into an editable DRAFT, same fields, same ids.
   *
   * The route inherits `sourcePdfAssetId` and the container from the current
   * version, so the fork can be drawn against the same original document. Field
   * IDS ARE PRESERVED, which is the whole point: a re-import would re-extract
   * and renumber them, invalidating any assessment tool keyed to them.
   */
  forkDraftVersion(input: {
    formId: string;
    fields: FormField[];
  }): Promise<{ form: FormSummary; versionId: string }> {
    return apiClient
      .post<FormSummaryDto & { createdVersionId: string }>(`/forms/${input.formId}/versions`, {
        fields: input.fields,
        publish: false,
      })
      .then((dto) => ({ form: toFormSummary(dto), versionId: dto.createdVersionId }));
  },

  /**
   * Create a form whose first version is a DRAFT, and hand back both ids.
   *
   * The builder needs somewhere to put geometry before anything is published:
   * geometry lives on a version's fields, so the version has to exist while the
   * tool is still being authored. `publishImport` cannot be reused — it
   * hardcodes `publish: true`, which would put an unfinished assessment in front
   * of fillers.
   *
   * `POST /forms` returns the created version's id as `currentVersionId` whether
   * or not it published, so one call is enough; the template's status stays
   * `draft` until the builder publishes it.
   */
  createDraftForm(input: {
    name: string;
    fields: FormField[];
    sourcePdfAssetId?: string;
  }): Promise<{ formId: string; versionId: string }> {
    return apiClient
      .post<FormSummaryDto>('/forms', {
        name: input.name,
        sourceType: 'pdf_import',
        fields: input.fields,
        ...(input.sourcePdfAssetId ? { sourcePdfAssetId: input.sourcePdfAssetId } : {}),
        publish: false,
      })
      .then((dto) => ({ formId: dto.id, versionId: dto.currentVersionId ?? '' }));
  },

  /**
   * Create the assessment tool for a published template version.
   *
   * The server validates the manifest and the answer keys against the
   * template's CURRENT version, which is only set once a version publishes —
   * so this is the last call in the publish sequence, not the first. The
   * builder runs the same two validators before any of it, so this refusing is
   * a bug rather than a normal outcome.
   */
  createAssessmentTool(input: {
    templateId: string;
    name: string;
    manifest: AssessmentToolManifest;
  }): Promise<{ id: string }> {
    return apiClient.post<{ id: string }>('/assessment-tools', input);
  },

  publishFormVersion(input: { formId: string; versionId: string }): Promise<FormSummary> {
    return apiClient
      .post<FormSummaryDto>(`/forms/${input.formId}/versions/${input.versionId}/publish`, {})
      .then(toFormSummary);
  },

  /**
   * Per-form voice override: true/false pins the form, null returns it to the
   * workspace default. Takes effect on live fill links immediately — the
   * setting lives on the mutable template, not a frozen version.
   */
  setFormVoiceInput(input: { formId: string; voiceInput: boolean | null }): Promise<void> {
    return apiClient
      .patch<{ id: string; voiceInput: boolean | null }>(
        `/forms/${input.formId}/voice-input`,
        { voiceInput: input.voiceInput },
      )
      .then(() => undefined);
  },

  /** Which client's brand a form is presented in. Null returns it to the org's. */
  setFormBrand(input: { formId: string; brandId: string | null }): Promise<void> {
    return apiClient
      .patch<{ id: string; brandId: string | null }>(`/forms/${input.formId}/brand`, {
        brandId: input.brandId,
      })
      .then(() => undefined);
  },

  listFormBrands(): Promise<FormBrand[]> {
    return apiClient.get<FormBrand[]>('/form-brands');
  },

  createFormBrand(input: FormBrandInput): Promise<FormBrand> {
    return apiClient.post<FormBrand>('/form-brands', input);
  },

  updateFormBrand(input: { id: string } & Partial<FormBrandInput>): Promise<FormBrand> {
    const { id, ...body } = input;
    return apiClient.patch<FormBrand>(`/form-brands/${id}`, body);
  },

  /**
   * Read a client's colours and logo off their PDF. Returns a PROPOSAL —
   * nothing is stored, and no brand is created or changed.
   */
  scanBrandFromPdf(input: { assetId?: string; pdfBase64?: string }): Promise<BrandPdfScan> {
    return apiClient.post<BrandPdfScan>('/form-brands/scan', input);
  },

  deleteFormBrand(id: string): Promise<void> {
    return apiClient.delete<void>(`/form-brands/${id}`).then(() => undefined);
  },

  archiveForm(id: string): Promise<FormSummary> {
    return apiClient.post<FormSummaryDto>(`/forms/${id}/archive`, {}).then(toFormSummary);
  },

  restoreForm(id: string): Promise<FormSummary> {
    return apiClient.post<FormSummaryDto>(`/forms/${id}/restore`, {}).then(toFormSummary);
  },

  deleteForm(id: string): Promise<void> {
    return apiClient.delete<void>(`/forms/${id}`);
  },

  /* ── Public fill links ─────────────────────────────────────────────────── */

  getFillForm(token: string): Promise<PublicFillForm | undefined> {
    return getOrUndefined(apiClient.get<PublicFillForm>(`/fill/${encodeURIComponent(token)}`));
  },

  submitFill(input: {
    token: string;
    versionId: string;
    submitterName?: string;
    submitterEmail?: string;
    values: Record<string, SubmissionValue>;
  }): Promise<{ id: string; status: SubmissionStatus; createdAt: string }> {
    return apiClient.post(`/fill/${encodeURIComponent(input.token)}/submissions`, {
      versionId: input.versionId,
      values: input.values,
      ...(input.submitterName ? { submitterName: input.submitterName } : {}),
      ...(input.submitterEmail ? { submitterEmail: input.submitterEmail } : {}),
    });
  },

  /**
   * Smart Fill on the PUBLIC path. Transcript only — the audio never left the
   * device, and the form's identity comes from the route, so a caller cannot
   * hand the model a field list of its own. The link's org is the entitlement
   * holder, which the API resolves from the token; there is no session here to
   * check a plan against.
   *
   * A 403 `feature_not_available` is the org's plan answering, not a failure.
   */
  smartFillPublic(input: { token: string; transcript: string }): Promise<SmartFillResult> {
    const body: SmartFillRequest = { transcript: input.transcript };
    return apiClient.post<SmartFillResult>(
      `/fill/${encodeURIComponent(input.token)}/smart-fill`,
      body,
      { timeoutMs: SMART_FILL_TIMEOUT_MS },
    );
  },

  /**
   * Smart Fill on an AUTHED surface (builder preview, mobile inspection), where
   * the session's org carries the entitlement. Draft versions are accepted so a
   * builder can try the feature before publishing.
   */
  smartFill(input: { templateVersionId: string; transcript: string }): Promise<SmartFillResult> {
    return apiClient.post<SmartFillResult>('/voice/smart-fill', input, {
      timeoutMs: SMART_FILL_TIMEOUT_MS,
    });
  },

  getInvite(token: string): Promise<PublicInvite | undefined> {
    return getOrUndefined(apiClient.get<PublicInvite>(`/invites/${encodeURIComponent(token)}`));
  },

  acceptInvite(token: string): Promise<{ orgId: string; role: string }> {
    return apiClient.post(`/invites/${encodeURIComponent(token)}/accept`, {});
  },

  /**
   * Ask the server for a one-time link that lets a member set their OWN
   * password. Returns a link, never a password — see the route for why.
   */
  issuePasswordReset(memberId: string): Promise<{ resetUrl: string; expiresAt: string; name: string }> {
    return apiClient
      .post<{ resetPath: string; expiresAt: string; name: string }>(
        `/team/members/${memberId}/password-reset`,
        {},
      )
      .then((dto) => ({
        ...dto,
        resetUrl: new URL(dto.resetPath, window.location.origin).toString(),
      }));
  },

  /** Confirms a reset link is live before showing the form. Name only. */
  getPasswordReset(token: string): Promise<{ name: string } | undefined> {
    return getOrUndefined(apiClient.get<{ name: string }>(`/reset-password/${encodeURIComponent(token)}`));
  },

  completePasswordReset(input: { token: string; password: string }): Promise<{ ok: boolean }> {
    return apiClient.post(`/reset-password/${encodeURIComponent(input.token)}`, {
      password: input.password,
    });
  },

  createFillLink(formId: string): Promise<FillLink> {
    return apiClient.post<FillLink>(`/forms/${formId}/fill-links`, {});
  },

  listFillLinks(formId: string): Promise<FillLink[]> {
    return apiClient.get<FillLink[]>(`/forms/${formId}/fill-links`);
  },

  revokeFillLink(input: { formId: string; linkId: string }): Promise<FillLink> {
    return apiClient.delete<FillLink>(`/forms/${input.formId}/fill-links/${input.linkId}`);
  },

  /* ── Enterprise & org ──────────────────────────────────────────────────── */

  listMembers(): Promise<Member[]> {
    return apiClient.get<MemberDto[]>('/team/members').then((rows) => rows.map(toMember));
  },

  perms(): Promise<PermState> {
    return apiClient.get<Partial<Record<Role, PermissionMatrix>>>('/team/permissions').then(toPermState);
  },

  auditLog(): Promise<AuditEntry[]> {
    return apiClient.get<AuditEntryDto[]>('/audit').then((rows) => rows.map(toAuditEntry));
  },

  listApiKeys(): Promise<ApiKey[]> {
    return apiClient.get<ApiKeyDto[]>('/api-keys').then((rows) => rows.map(toApiKey));
  },

  /**
   * Creates a key. The response carries the plaintext, and that is the only
   * moment it exists outside the caller — nothing here persists it.
   */
  createApiKey(input: { name: string; role: RoleName }): Promise<CreatedApiKey> {
    return apiClient
      .post<ApiKeyDto & { key: string }>('/api-keys', {
        name: input.name.trim(),
        role: input.role.toLowerCase(),
      })
      .then((dto) => ({ ...toApiKey(dto), key: dto.key }));
  },

  revokeApiKey(id: string): Promise<ApiKey> {
    return apiClient.delete<ApiKeyDto>(`/api-keys/${encodeURIComponent(id)}`).then(toApiKey);
  },

  /** Real plan/seat/feature data from `GET /org/billing`. */
  billing(): Promise<OrgBilling> {
    return apiClient.get<OrgBilling>('/org/billing');
  },

  /**
   * DEV/TESTING ONLY — switches the org's plan tier directly without any
   * payment processing. Replace with real billing integration before going live.
   */
  updatePlan(planTier: PlanTier): Promise<{ planTier: PlanTier; seatLimit: number }> {
    return apiClient.post('/org/plan', { planTier });
  },

  /**
   * Invite someone — the concierge flow.
   *
   * `email` is optional: leaving it out produces a QR/link invite for a
   * candidate with no work address, in which case `name` is what identifies the
   * pending row. Either way the caller gets `acceptUrl` back so it can show a
   * QR code, because an emailed invite can still fail to arrive.
   */
  inviteMember(input: {
    email?: string;
    name?: string;
    role: RoleName;
  }): Promise<(Member & { emailSent: boolean; acceptUrl: string }) | null> {
    const email = input.email?.trim();
    const name = input.name?.trim();
    return apiClient
      .post<MemberDto>('/team/members', {
        ...(email ? { email } : {}),
        ...(name ? { name } : {}),
        role: input.role.toLowerCase(),
      })
      .then((dto) => ({
        ...toMember(dto),
        emailSent: dto.emailSent === true,
        // Absolute, because the point of it is to be pasted or scanned on
        // another device.
        acceptUrl: dto.acceptPath ? new URL(dto.acceptPath, window.location.origin).toString() : '',
      }))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 409) return null;
        throw err;
      });
  },

  /**
   * Create an account from an invite and sign in as it.
   *
   * Separate from `acceptInvite`, which attaches an EXISTING session to an org.
   * This is the path for someone who has no account at all.
   */
  signupFromInvite(input: {
    token: string;
    name: string;
    email: string;
    password: string;
  }): Promise<{ orgId: string; role: string }> {
    const { token, ...body } = input;
    return apiClient.post(`/invites/${encodeURIComponent(token)}/signup`, body);
  },

  setMemberRole(input: { id: string; role: RoleName }): Promise<Member | undefined> {
    return getOrUndefined(
      apiClient
        .patch<MemberDto>(`/team/members/${input.id}`, { role: input.role.toLowerCase() })
        .then(toMember),
    );
  },

  removeMember(id: string): Promise<void> {
    return apiClient.delete(`/team/members/${id}`);
  },

  togglePermission(input: { role: RoleName; category: string; action: PermAction }): Promise<PermState> {
    return apiClient
      .patch<Partial<Record<Role, PermissionMatrix>>>('/team/permissions', {
        role: input.role.toLowerCase(),
        category: input.category as PermissionCategory,
        action: input.action,
      })
      .then(toPermState);
  },

  updateOrg(input: {
    name?: string;
    branding?: BrandingKit;
    teamSize?: string;
    onboardingComplete?: true;
  }): Promise<OrgSettingsDto> {
    return apiClient.patch<OrgSettingsDto>('/org', input);
  },

  /**
   * Uploads an org logo via `POST /org/logo` and returns the public relative
   * URL to store in `branding.logoAssetUrl`. The URL is same-origin and
   * unauthenticated to fetch, so it also renders for logged-out respondents
   * on a public fill page. Callers rasterise SVG to PNG first — the API only
   * accepts PNG/JPEG/WebP, verified by magic bytes server-side.
   */
  uploadOrgLogo(input: {
    imageBase64: string;
    mimeType: string;
    /** What the logo is for — drives the audit wording, nothing else. */
    usage?: 'org' | 'brand';
  }): Promise<{ url: string }> {
    return apiClient.post<{ url: string }>('/org/logo', input);
  },

  updateWhiteLabel(input: { branding: BrandingKit }): Promise<OrgSettingsDto> {
    return store.updateOrg({ branding: input.branding });
  },

  /**
   * Propose branding from the org's own website. Returns a draft only —
   * nothing is persisted until the owner reviews it and saves.
   */
  scanBrandFromWebsite(input: { url: string }): Promise<BrandScanProposal> {
    return apiClient.post<BrandScanProposal>('/org/brand-scan', input);
  },

  /* ── Taxonomy (Locations, Departments, Roles) ──────────────────────────── */

  getTaxonomy(): Promise<Taxonomy> {
    return apiClient.get<Taxonomy>('/taxonomy');
  },
  createLocation(name: string): Promise<TaxLocation> {
    return apiClient.post<TaxLocation>('/taxonomy/locations', { name });
  },
  updateLocation(id: string, patch: { name?: string; status?: TaxonomyStatus }): Promise<TaxLocation> {
    return apiClient.patch<TaxLocation>(`/taxonomy/locations/${id}`, patch);
  },
  createDepartment(input: { name: string; allowsMultipleRoles?: boolean }): Promise<TaxDepartment> {
    return apiClient.post<TaxDepartment>('/taxonomy/departments', input);
  },
  updateDepartment(
    id: string,
    patch: { name?: string; allowsMultipleRoles?: boolean; status?: TaxonomyStatus },
  ): Promise<TaxDepartment> {
    return apiClient.patch<TaxDepartment>(`/taxonomy/departments/${id}`, patch);
  },
  createRole(departmentId: string, name: string): Promise<TaxRole> {
    return apiClient.post<TaxRole>(`/taxonomy/departments/${departmentId}/roles`, { name });
  },
  updateRole(id: string, patch: { name?: string; status?: TaxonomyStatus }): Promise<TaxRole> {
    return apiClient.patch<TaxRole>(`/taxonomy/roles/${id}`, patch);
  },
  getRoleRequiredAssessments(roleId: string): Promise<{ configured: boolean; toolIds: string[] }> {
    return apiClient.get(`/taxonomy/roles/${roleId}/required-assessments`);
  },
  /** The blast radius of a proposed change, computed without committing (U12). */
  previewRoleRequiredAssessments(
    roleId: string,
    toolIds: string[],
  ): Promise<{ effects: RequiredAssessmentsChangeEffects }> {
    return apiClient.post(`/taxonomy/roles/${roleId}/required-assessments/preview`, { toolIds });
  },
  setRoleRequiredAssessments(
    roleId: string,
    toolIds: string[],
  ): Promise<{ configured: boolean; toolIds: string[]; effects: RequiredAssessmentsChangeEffects }> {
    return apiClient.put(`/taxonomy/roles/${roleId}/required-assessments`, { toolIds });
  },
  updateTaxonomySettings(patch: Partial<TaxonomySettings>): Promise<TaxonomySettings> {
    return apiClient.patch<TaxonomySettings>('/taxonomy/settings', patch);
  },
  getMemberPlacement(membershipId: string): Promise<MemberPlacement> {
    return apiClient.get<MemberPlacement>(`/team/members/${membershipId}/placement`);
  },
  setMemberPlacement(membershipId: string, input: MemberPlacement): Promise<MemberPlacement> {
    return apiClient.put<MemberPlacement>(`/team/members/${membershipId}/placement`, input);
  },

  /* ── Competency gating ─────────────────────────────────────────────────── */

  listCompetencies(): Promise<Competency[]> {
    return apiClient.get<CompetencyDto[]>('/competencies').then((rows) => rows.map(toCompetency));
  },

  /**
   * Add a competency to the register.
   *
   * `POST /competencies` has existed since gating shipped, but nothing called
   * it — so an org with an empty register had no way to populate one except
   * hand-written SQL, and the first real deployment reached sign-off with zero
   * competencies recorded. Every assessment signed off granted nothing: the
   * case still went competent and the certificate still printed, and only the
   * register stayed empty.
   *
   * There is deliberately no matching delete. `competency_holders.competency_id`
   * cascades, so removing a competency erases every record of who held it —
   * the exact erasure the revoke path was just fixed to avoid. Deleting one
   * stays a deliberate act performed against the API.
   */
  createCompetency(input: {
    name: string;
    code: string;
    validForMonths: number | null;
    gracePeriodDays: number | null;
  }): Promise<Competency> {
    return apiClient.post<CompetencyDto>('/competencies', input).then(toCompetency);
  },

  /**
   * Change how long a competency stays valid.
   *
   * Applies to everyone who already holds it, immediately: expiry is counted
   * from each person's own grant date rather than frozen when the grant was
   * made, so setting "36 months" dates every existing ticket from when it was
   * actually earned. Sending null makes the competency perpetual again.
   */
  setCompetencyValidity(
    id: string,
    validity: { validForMonths: number | null; gracePeriodDays: number | null },
  ): Promise<Competency> {
    return apiClient.patch<CompetencyDto>(`/competencies/${id}`, validity).then(toCompetency);
  },

  /**
   * Who holds one competency, and whether each of them is still current.
   *
   * Returned already sorted by urgency — expired first, then grace, expiring,
   * held — because the reason to open this list is to find who needs booking.
   * Screens render it in order rather than re-sorting.
   */
  listCompetencyHolders(competencyId: string): Promise<CompetencyHolder[]> {
    return apiClient.get<CompetencyHolder[]>(`/competencies/${competencyId}/holders`);
  },

  /* ── Saved imports ─────────────────────────────────────────────────────── */

  /**
   * Save a half-mapped import under a name, on the server.
   *
   * Distinct from the wizard's local autosave, which covers an interruption.
   * This is for what a browser copy cannot survive — a dead laptop, a form one
   * person starts and another finishes, a mapping parked while the paper
   * document goes through a revision. Saving under a name already used
   * overwrites it, which is what "save" means everywhere else.
   */
  saveImportDraft(input: { name: string; assetId: string; snapshot: ImportSnapshot }): Promise<ImportDraftSummary> {
    return apiClient.post<ImportDraftSummary>('/import-drafts', input);
  },

  /** Every saved import in this org, most recently touched first. Summaries only. */
  listImportDrafts(): Promise<ImportDraftSummary[]> {
    return apiClient.get<ImportDraftSummary[]>('/import-drafts');
  },

  /** One saved import WITH its snapshot — what resuming actually loads. */
  getImportDraft(id: string): Promise<ImportDraftSummary & { snapshot: ImportSnapshot }> {
    return apiClient.get<ImportDraftSummary & { snapshot: ImportSnapshot }>(`/import-drafts/${id}`);
  },

  discardImportDraft(id: string): Promise<void> {
    return apiClient.delete<void>(`/import-drafts/${id}`);
  },

  listCompetencyRules(): Promise<CompetencyRule[]> {
    return apiClient.get<CompetencyRuleDto[]>('/competency-rules').then((rows) => rows.map(toCompetencyRule));
  },

  addRule(input: { formId: string; competencyId: string; section: string }): Promise<CompetencyRule | null> {
    const section = input.section.trim();
    if (!section) return Promise.resolve(null);
    return apiClient
      .post<CompetencyRuleDto>('/competency-rules', {
        templateId: input.formId,
        competencyId: input.competencyId,
        sectionRef: section,
      })
      .then(toCompetencyRule);
  },

  async toggleRule(id: string): Promise<CompetencyRule[]> {
    await apiClient.patch(`/competency-rules/${id}`, {});
    const rows = await apiClient.get<CompetencyRuleDto[]>('/competency-rules');
    return rows.map(toCompetencyRule);
  },

  removeRule(id: string): Promise<void> {
    return apiClient.delete(`/competency-rules/${id}`);
  },

  /* ── Mobile field app ──────────────────────────────────────────────────── */

  submitInspection(input: {
    templateId: string;
    /** The version the fill surface rendered — pins the submission server-side. */
    versionId: string;
    values: Record<string, SubmissionValue>;
    submitterName?: string;
    submitterEmail?: string;
  }): Promise<SubmissionRow> {
    return apiClient
      .post<SubmissionRowDto>('/submissions', {
        templateId: input.templateId,
        versionId: input.versionId,
        values: input.values,
        ...(input.submitterName ? { submitterName: input.submitterName } : {}),
        ...(input.submitterEmail ? { submitterEmail: input.submitterEmail } : {}),
      })
      .then(toSubmissionRow);
  },
};
