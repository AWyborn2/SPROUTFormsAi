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
import type {
  BrandingKit,
  FormContainer,
  FormField,
  PermissionCategory,
  PermissionMatrix,
  Role,
  SubmissionStatus,
  SubmissionValue,
} from '@formai/shared';
import { ROLE_LABELS } from '@formai/shared';
import { ApiError, apiClient } from './api-client.js';
import { ROLE_NAMES } from './types.js';
import type {
  AuditCategory,
  AuditEntry,
  Competency,
  CompetencyRule,
  DashboardSummary,
  FillLink,
  FormDetail,
  FormSourceType,
  FormSummary,
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
  TemplateStatus,
} from './types.js';

/** Shape returned by `PATCH /org` (see apps/api routes/org.ts). */
export interface OrgSettingsDto {
  id: string;
  name: string;
  branding: BrandingKit;
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
 */
export function canExportSubmission(fields: FormField[]): boolean {
  return fields.some((f) => f.sourcePosition !== undefined);
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
  name: string;
  email: string;
  role: Role;
  status: 'active' | 'invited' | 'suspended';
  emailSent?: boolean;
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

interface CompetencyDto {
  id: string;
  name: string;
  code: string;
  holders: number;
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

function toMember(dto: MemberDto): Member {
  return {
    id: dto.id,
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

const COMPETENCY_COLOR_PALETTE = ['var(--warning)', 'var(--info)', 'var(--danger)', 'var(--accent)'];
function colorForCompetency(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return COMPETENCY_COLOR_PALETTE[hash % COMPETENCY_COLOR_PALETTE.length]!;
}

function toCompetency(dto: CompetencyDto): Competency {
  return { id: dto.id, name: dto.name, code: dto.code, holders: dto.holders, color: colorForCompetency(dto.id) };
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

  exportSubmissionPdf(detail: SubmissionDetail): Promise<Blob> {
    return apiClient.postForBlob('/pdf/round-trip', {
      ...(detail.sourcePdfAssetId ? { assetId: detail.sourcePdfAssetId } : {}),
      fields: detail.fields,
      values: detail.values,
    });
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

  getInvite(token: string): Promise<PublicInvite | undefined> {
    return getOrUndefined(apiClient.get<PublicInvite>(`/invites/${encodeURIComponent(token)}`));
  },

  acceptInvite(token: string): Promise<{ orgId: string; role: string }> {
    return apiClient.post(`/invites/${encodeURIComponent(token)}/accept`, {});
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

  inviteMember(input: { email: string; role: RoleName }): Promise<(Member & { emailSent: boolean }) | null> {
    return apiClient
      .post<MemberDto>('/team/members', {
        email: input.email.trim(),
        role: input.role.toLowerCase(),
      })
      .then((dto) => ({ ...toMember(dto), emailSent: dto.emailSent === true }))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 409) return null;
        throw err;
      });
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

  updateOrg(input: { name?: string; branding?: BrandingKit }): Promise<OrgSettingsDto> {
    return apiClient.patch<OrgSettingsDto>('/org', input);
  },

  updateWhiteLabel(input: { branding: BrandingKit }): Promise<OrgSettingsDto> {
    return store.updateOrg({ branding: input.branding });
  },

  /* ── Competency gating ─────────────────────────────────────────────────── */

  listCompetencies(): Promise<Competency[]> {
    return apiClient.get<CompetencyDto[]>('/competencies').then((rows) => rows.map(toCompetency));
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
