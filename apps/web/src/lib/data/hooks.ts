/**
 * TanStack Query hooks over the `store`, which wraps the real `apps/api` calls
 * (see `store.ts` / `api-client.ts`). Screens depend only on this hook surface,
 * so the async data source stays behind the seam: Query gives them loading /
 * error state, caching, and invalidation on mutation.
 */
import {
  MutationCache,
  QueryCache,
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  AssessmentPathway,
  PrerequisiteCheck,
  ProfilePrefillKey,
  AssessmentToolManifest,
  AssessmentWorkflow,
  BrandingKit,
  FormBrandInput,
  FormContainer,
  FormField,
  SessionInfo,
  SubmissionValue,
} from '@formai/shared';
import { ApiError, apiClient } from './api-client.js';
import type { ImportSnapshot } from './import-draft-store.js';
import { store } from './store.js';
import {
  assessmentsApi,
  type CreateCaseInput,
  type RecordOutcomeInput,
} from './assessments.js';
import type {
  FormDetail,
  FormSummary,
  OrgBilling,
  PermAction,
  PlanTier,
  PublishImportInput,
  RoleName,
  SaveBuilderDraftInput,
  SubmissionDetail,
  SubmissionRow,
  TaxonomySettings,
  RoleRequirementTiers,
} from './types.js';
import type { TaxonomyStatus } from '@formai/shared';

/**
 * A 401 from any request means the `fai_session` cookie has expired or gone
 * missing mid-session. The route guards (`RequireAuth`) only re-decide when the
 * cached session changes, so without this a stale-but-truthy session left the
 * user on `/app` while every request quietly 401'd — surfacing as misleading
 * per-feature errors like the import wizard's generic "Import failed". Clearing
 * the cached session flips `useSession` to unauthenticated, which redirects to
 * `/login` where the cookie is re-minted. `/auth/me`'s own logged-out 401 lands
 * here too, but setting the session to undefined there is exactly what already
 * happens — idempotent, and it triggers no refetch, so there is no loop.
 */
function handleUnauthorized(error: unknown): void {
  if (error instanceof ApiError && error.status === 401) {
    queryClient.setQueryData(keys.session, undefined);
  }
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: false },
  },
  queryCache: new QueryCache({ onError: handleUnauthorized }),
  mutationCache: new MutationCache({ onError: handleUnauthorized }),
});

export const keys = {
  session: ['session'] as const,
  forms: ['forms'] as const,
  builderDrafts: ['builderDrafts'] as const,
  /*
    DELIBERATELY NOT NESTED UNDER `builderDrafts`, which is the one place in
    this file that breaks the convention.

    Nesting a detail under its list is normally what you want — invalidating
    the list refreshes the rows too. Here it is actively harmful. Autosave
    invalidates the list on every write, `invalidateQueries` matches by PREFIX,
    and `['builderDrafts', id]` is a prefix match — so a mounted builder would
    refetch its own draft every two seconds while the author works. That
    payload is a whole extraction plus every field and every key: megabytes,
    pulled down repeatedly, for a value the builder already holds a newer
    version of in React state.

    `staleTime: Infinity` does not prevent this. An explicit invalidation
    overrides staleness by design.
  */
  builderDraft: (id: string) => ['builderDraft', id] as const,
  form: (id: string) => ['forms', id] as const,
  submissions: ['submissions'] as const,
  submission: (id: string) => ['submissions', id] as const,
  dashboard: ['dashboard'] as const,
  members: ['members'] as const,
  perms: ['perms'] as const,
  auditLog: ['auditLog'] as const,
  billing: ['billing'] as const,
  importDrafts: ['importDrafts'] as const,
  competencies: ['competencies'] as const,
  /**
   * Nested under `competencies` on purpose: changing a competency's validity
   * re-dates every one of its holders, so invalidating the list has to sweep
   * the registers too. A sibling key would leave an open register showing
   * statuses computed against the old period.
   */
  competencyHolders: (id: string) => ['competencies', id, 'holders'] as const,
  assessmentTools: ['assessmentTools'] as const,
  /**
   * The backfill worklist — tools awarding nothing (U4, R3, KTD5). A SIBLING
   * of `assessmentTools`, not nested under it: the worklist is admin-only and
   * must be invalidatable (and skippable) on its own, without sweeping the
   * tool list every role can read.
   */
  unlinkedTools: ['unlinkedTools'] as const,
  /** A Role's required-assessment list (U10). Keyed by role so each editor caches apart. */
  roleRequiredAssessments: (roleId: string) => ['roleRequiredAssessments', roleId] as const,
  /** The people a Department tightening still has to resolve (U17). Keyed by department. */
  tighteningReview: (departmentId: string) => ['tighteningReview', departmentId] as const,
  /** The people still holding any retired value (U18). */
  retirementReview: ['retirementReview'] as const,
  /** The org's pending voluntary training requests (U22). */
  trainingRequests: ['trainingRequests'] as const,
  /** The caller's own expiry notices (U21). */
  myNotices: ['myNotices'] as const,
  /** Everything waiting on an Admin, from all sources (U19). */
  workingList: ['workingList'] as const,
  /** How the workforce stands, for compliance reporting (U20). */
  compliance: ['compliance'] as const,
  assessmentCases: ['assessmentCases'] as const,
  /**
   * The shared assessor queue (U13). A SIBLING of assessmentCases — it shares no
   * key prefix, so invalidating assessmentCases does NOT reach it; every
   * case-mutating hook invalidates this key explicitly alongside.
   */
  assessorQueue: ['assessorQueue'] as const,
  /**
   * Deliberately NOT `['assessmentCases', 'progress']`: that shape is
   * `assessmentCase('progress')`, so invalidating one case would sweep the
   * dashboard and vice versa. A sibling key keeps the two independent.
   */
  assessmentProgress: ['assessmentProgress'] as const,
  assessmentCase: (id: string) => ['assessmentCases', id] as const,
  formVersion: (formId: string, versionId: string) => ['forms', formId, 'versions', versionId] as const,
  assessmentAttempt: (caseId: string, attemptId: string) =>
    ['assessmentCases', caseId, 'attempts', attemptId] as const,
  competencyRules: ['competencyRules'] as const,
  fillForm: (token: string) => ['fillForm', token] as const,
  fillLinks: (formId: string) => ['fillLinks', formId] as const,
  invite: (token: string) => ['invite', token] as const,
  apiKeys: ['apiKeys'] as const,
  taxonomy: ['taxonomy'] as const,
  formBrands: ['formBrands'] as const,
  memberPlacement: (id: string) => ['members', id, 'placement'] as const,
  /** One member's profile, keyed on the MEMBERSHIP the record belongs to (R1). */
  profile: (membershipId: string) => ['profiles', membershipId] as const,
  /** The caller's own membership id, for the fixed own-record read (R49). */
  myProfileMembership: ['profiles', 'mine'] as const,
  /** One import run's report, addressable long after the page closed (U24). */
  importRun: (runId: string) => ['workforceImport', 'run', runId] as const,
  /** Whether an import is in flight for this organisation, asked on load (U24). */
  activeImportRun: ['workforceImport', 'active'] as const,
  /** What an induction submission would seed onto a profile (U40). */
  profileSeed: (submissionId: string) => ['profiles', 'seed', submissionId] as const,
  /** One person's held competencies, keyed on the USER the grants belong to. */
  heldCompetencies: (userId: string) => ['competencies', 'held', userId] as const,
  /**
   * The caller's OWN recommended competencies (U7, R12). Nested under the
   * `competencies` prefix on purpose: granting or creating a competency can
   * change `held` and the rows themselves, and the register invalidations
   * already sweep that prefix.
   */
  myRecommended: ['competencies', 'recommended', 'mine'] as const,
};

/**
 * `data` is the resolved tenant when a valid session cookie exists, or
 * `undefined` while loading or when unauthenticated (a 401 from `/auth/me`
 * is a normal, expected outcome here — not a real query failure). Route
 * guards in `router.tsx` are the only consumers; screens don't need this.
 */
export function useSession() {
  return useQuery({
    queryKey: keys.session,
    queryFn: () => apiClient.get<SessionInfo>('/auth/me'),
  });
}

/** Clears the server-side session cookie, then wipes all cached queries — the next screen is `/login`. */
export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.post<void>('/auth/logout'),
    onSuccess: () => {
      qc.setQueryData(keys.session, undefined);
      qc.clear();
    },
  });
}

/**
 * Permanently deletes the caller's account — and, if they're the only member
 * of their org, the whole organization with it. See `DELETE /account` on the
 * API for the exact cascade/last-owner rules.
 */
export function useDeleteAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.delete<{ orgDeleted: boolean }>('/account'),
    onSuccess: () => {
      qc.setQueryData(keys.session, undefined);
      qc.clear();
    },
  });
}

export function useForms() {
  return useQuery({ queryKey: keys.forms, queryFn: () => store.listForms() });
}

export function useForm(id: string | undefined) {
  return useQuery({
    queryKey: keys.form(id ?? ''),
    queryFn: () => store.getForm(id!) ?? null,
    enabled: !!id,
  });
}

export function useSubmissions() {
  return useQuery({ queryKey: keys.submissions, queryFn: () => store.listSubmissions() });
}

export function useSubmission(id: string | undefined) {
  return useQuery({
    queryKey: keys.submission(id ?? ''),
    queryFn: () => store.getSubmission(id!) ?? null,
    enabled: !!id,
  });
}

/**
 * Round-trip export: POST the submission's version fields + values + stored
 * submission id to /pdf/round-trip; the API loads the pinned version's fields
 * and the stored values itself, so the request cannot forge either. Resolves
 * the filled PDF as a Blob.
 */
export function useExportSubmissionPdf() {
  return useMutation({
    mutationFn: async (detail: SubmissionDetail) => store.exportSubmissionPdf(detail),
  });
}

/** Record a submission from an authenticated surface. */
export function useCreateSubmission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      templateId: string;
      versionId: string;
      values: Record<string, SubmissionValue>;
    }) => store.createSubmission(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.submissions });
      qc.invalidateQueries({ queryKey: keys.dashboard });
      qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

/** Approve or reject a submission; the API records the audit entry server-side. */
export function useSetSubmissionStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; status: 'approved' | 'rejected' }) =>
      store.setSubmissionStatus(input),
    onSuccess: (_row, input) => {
      qc.invalidateQueries({ queryKey: keys.submissions });
      qc.invalidateQueries({ queryKey: keys.submission(input.id) });
      qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

/*
  The `enabled` option on this and the three reads below exists for the shell:
  nav badges and the dashboard tile reuse these exact query keys (KTD1), but
  must not fire the fetch for readers whose role the API would 403 — the
  screens themselves only mount for readers the nav already admits, so every
  existing call site passes nothing and keeps `enabled: true`.
*/
export function useDashboard(options?: { enabled?: boolean; staleTime?: number }) {
  return useQuery({
    queryKey: keys.dashboard,
    queryFn: () => store.dashboard(),
    enabled: options?.enabled ?? true,
    ...(options?.staleTime !== undefined ? { staleTime: options.staleTime } : {}),
  });
}

/** Publish a builder session as a brand-new template (first version, published). */
export function usePublishBuilder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; fields: FormField[]; container: FormContainer }) =>
      store.publishBuilder(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.forms });
      qc.invalidateQueries({ queryKey: keys.dashboard });
    },
  });
}

/** Publish edited fields as a new version of an existing template (`POST /forms/:id/versions`). */
export function usePublishVersion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { formId: string; fields: FormField[]; container: FormContainer }) =>
      store.publishVersion(input),
    onSuccess: (_summary, input) => {
      qc.invalidateQueries({ queryKey: keys.forms });
      qc.invalidateQueries({ queryKey: keys.form(input.formId) });
      qc.invalidateQueries({ queryKey: keys.dashboard });
    },
  });
}

export function usePublishImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: PublishImportInput) => store.publishImport(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.forms });
      qc.invalidateQueries({ queryKey: keys.dashboard });
    },
  });
}

/** Re-extract: save the re-imported PDF as a new version (draft or published) of an existing form. */
export function useCreateVersionFromImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      formId: string;
      fields: FormField[];
      sourcePdfAssetId?: string;
      publish: boolean;
    }) => store.createVersionFromImport(input),
    onSuccess: (_summary, input) => {
      qc.invalidateQueries({ queryKey: keys.forms });
      qc.invalidateQueries({ queryKey: keys.form(input.formId) });
      qc.invalidateQueries({ queryKey: keys.dashboard });
    },
  });
}

/**
 * Create the builder's draft form + version.
 *
 * Called once, when the builder first needs somewhere to place geometry. From
 * that point the VERSION owns the fields — the builder draft owns the structure,
 * the answer keys and the manifest that sit on top of them — so there is exactly
 * one copy of the field list and it is the one the exporter reads.
 */
export function useCreateDraftForm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; fields: FormField[]; sourcePdfAssetId?: string }) =>
      store.createDraftForm(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.forms });
    },
  });
}

/**
 * Create the assessment tool once its template version has published.
 *
 * `awardedCompetencyIds` is required with exactly one element (U5, R1): the
 * API 400s `invalid_award` without it, so every path that creates a tool —
 * the fresh publish AND the deleted-form recovery — must have asked the
 * author what this assessment awards before calling this.
 */
export function useCreateAssessmentTool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      templateId: string;
      name: string;
      manifest: AssessmentToolManifest;
      awardedCompetencyIds: string[];
    }) => store.createAssessmentTool(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.forms });
    },
  });
}

/** Publish an existing draft version from version history — flips live fill links to it immediately. */
/** One version's own fields — the geometry editor's read. */
export function useFormVersion(formId: string | undefined, versionId: string | undefined) {
  return useQuery({
    queryKey: keys.formVersion(formId ?? '', versionId ?? ''),
    queryFn: () => store.formVersion({ formId: formId!, versionId: versionId! }),
    enabled: Boolean(formId && versionId),
  });
}

/** Save edited fields onto a draft version. Refused on a published one. */
export function useSaveVersionFields(formId: string, versionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fields: FormField[]) => store.saveVersionFields({ formId, versionId, fields }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.formVersion(formId, versionId) });
      void qc.invalidateQueries({ queryKey: keys.form(formId) });
    },
  });
}

/** Fork the current version into a draft so its placement can be edited. */
export function useForkDraftVersion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { formId: string; fields: FormField[]; sourcePdfAssetId?: string }) =>
      store.forkDraftVersion(input),
    onSuccess: (_r, input) => {
      void qc.invalidateQueries({ queryKey: keys.form(input.formId) });
      void qc.invalidateQueries({ queryKey: keys.forms });
    },
  });
}

export function usePublishFormVersion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { formId: string; versionId: string }) =>
      store.publishFormVersion(input),
    onSuccess: (_summary, input) => {
      qc.invalidateQueries({ queryKey: keys.forms });
      qc.invalidateQueries({ queryKey: keys.form(input.formId) });
      qc.invalidateQueries({ queryKey: keys.dashboard });
      qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

/** Set or clear a form's voice-input override; live fill links react at once. */
export function useSetFormVoiceInput() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { formId: string; voiceInput: boolean | null }) =>
      store.setFormVoiceInput(input),
    onSuccess: (_void, input) => {
      qc.invalidateQueries({ queryKey: keys.form(input.formId) });
      qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

/**
 * The brands a form can be presented in — usually clients', not the org's own.
 *
 * A workspace-wide list rather than per-form: a subcontractor holds a handful
 * of brands and dozens of forms, so this is fetched once and every picker
 * reads the same cache entry.
 */
export function useFormBrands() {
  return useQuery({ queryKey: keys.formBrands, queryFn: () => store.listFormBrands() });
}

export function useCreateFormBrand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: FormBrandInput) => store.createFormBrand(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.formBrands });
      qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

export function useUpdateFormBrand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string } & Partial<FormBrandInput>) => store.updateFormBrand(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.formBrands });
      /*
        Every form that uses the brand renders differently now, and neither this
        hook nor the cache knows which ones those are — so the whole form list
        and every open form detail go stale together. Editing a brand is a rare
        act; a targeted invalidation would trade a real risk of a stale colour
        for a refetch nobody notices.
      */
      qc.invalidateQueries({ queryKey: keys.forms });
      qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

/**
 * Propose a brand from a client's document. Read-only on the server — the
 * result is a draft the author confirms, so there is nothing to invalidate.
 */
export function useScanBrandFromPdf() {
  return useMutation({
    mutationFn: (input: { assetId?: string; pdfBase64?: string }) => store.scanBrandFromPdf(input),
  });
}

/**
 * Describe a change to a brand. Read-only on the server — the proposal is a
 * draft the author confirms, so there is nothing to invalidate.
 */
export function useEditFormBrandByChat() {
  return useMutation({
    mutationFn: (input: { id: string; instruction: string }) => store.editFormBrandByChat(input),
  });
}

export function useDeleteFormBrand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => store.deleteFormBrand(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.formBrands });
      // Forms that used it are NOT deleted — they fall back to the org's
      // theme, so they need refetching for the same reason as an edit.
      qc.invalidateQueries({ queryKey: keys.forms });
      qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

/** Point a form at a brand, or clear it back to the org's own theme. */
export function useSetFormBrand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { formId: string; brandId: string | null }) => store.setFormBrand(input),
    onSuccess: (_void, input) => {
      qc.invalidateQueries({ queryKey: keys.form(input.formId) });
      qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

/**
 * Every saved assessment-builder draft.
 *
 * WHAT THIS UNBLOCKS. `/app/assessments/builder/:draftId` resumes a draft and
 * has since it was written; the list route and the delete route exist too. What
 * did not exist was anything that LINKED to them — so an author who left the
 * builder half-way had no route back in, and every abandoned run stayed in the
 * form library as an undeletable-looking draft with no way to finish it either.
 */
export function useBuilderDrafts() {
  return useQuery({
    queryKey: keys.builderDrafts,
    queryFn: async () => store.listBuilderDrafts(),
  });
}

/**
 * One draft with its state — the read that resuming is built on.
 *
 * `staleTime: Infinity` because this is a HANDOVER, not a live view. The
 * builder takes the state into its own React state and is then the authority;
 * a refetch would hand back the version on the server, which is by definition
 * older than what the author is currently editing, and overwrite it.
 */
export function useBuilderDraft(id: string | undefined) {
  return useQuery({
    queryKey: keys.builderDraft(id ?? ''),
    queryFn: async () => store.getBuilderDraft(id!),
    enabled: Boolean(id),
    staleTime: Infinity,
    // A draft that 404s is gone; asking three more times does not bring it
    // back and only delays the builder giving up and opening empty.
    retry: false,
  });
}

/**
 * Save the draft. Upserts on (org, name), so autosave overwrites its own row.
 *
 * The draft LIST is invalidated but the draft itself is not: the author's
 * browser holds the newest state by definition, and refetching what was just
 * written would replace live edits with a snapshot of them.
 */
export function useSaveBuilderDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveBuilderDraftInput) => store.saveBuilderDraft(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.builderDrafts });
    },
  });
}

export function useDiscardBuilderDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => store.discardBuilderDraft(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.builderDrafts });
      // Discarding a draft does not remove the draft FORM it created, which is
      // the form library's own delete — but the library's counts move.
      qc.invalidateQueries({ queryKey: keys.forms });
    },
  });
}

export function useArchiveForm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => store.archiveForm(id),
    onSuccess: (_summary, id) => {
      qc.invalidateQueries({ queryKey: keys.forms });
      qc.invalidateQueries({ queryKey: keys.form(id) });
      qc.invalidateQueries({ queryKey: keys.dashboard });
      qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

export function useRestoreForm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => store.restoreForm(id),
    onSuccess: (_summary, id) => {
      qc.invalidateQueries({ queryKey: keys.forms });
      qc.invalidateQueries({ queryKey: keys.form(id) });
      qc.invalidateQueries({ queryKey: keys.dashboard });
      qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

export function useDeleteForm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => store.deleteForm(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.forms });
      qc.invalidateQueries({ queryKey: keys.dashboard });
      qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

export function useFillForm(token: string | undefined) {
  return useQuery({
    queryKey: keys.fillForm(token ?? ''),
    queryFn: async () => (await store.getFillForm(token!)) ?? null,
    enabled: !!token,
  });
}

export function useSubmitFill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      token: string;
      versionId: string;
      submitterName?: string;
      submitterEmail?: string;
      values: Record<string, SubmissionValue>;
    }) => store.submitFill(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.submissions });
      qc.invalidateQueries({ queryKey: keys.dashboard });
    },
  });
}

/* ── Voice: Smart Fill ───────────────────────────────────────────────────── */

/**
 * Whole-utterance Smart Fill on a public fill link.
 *
 * Nothing is persisted — the API answers with proposals the respondent still
 * has to review and submit — so there is deliberately nothing to invalidate.
 * The transcript is produced on-device; no audio is uploaded.
 */
export function usePublicSmartFill() {
  return useMutation({
    mutationFn: async (input: { token: string; transcript: string }) =>
      store.smartFillPublic(input),
  });
}

/** The authed door (builder preview / mobile inspection): session + plan gated. */
export function useSmartFill() {
  return useMutation({
    mutationFn: async (input: { templateVersionId: string; transcript: string }) =>
      store.smartFill(input),
  });
}

export function useInvite(token: string | undefined) {
  return useQuery({
    queryKey: keys.invite(token ?? ''),
    queryFn: async () => (await store.getInvite(token!)) ?? null,
    enabled: !!token,
  });
}

export function useAcceptInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => store.acceptInvite(token),
    onSuccess: () => qc.clear(),
  });
}

/**
 * Create an account FROM an invite and land signed in.
 *
 * Clears the cache like `useAcceptInvite` does: the session changes identity
 * mid-flight, so anything already fetched belongs to nobody.
 */
export function useSignupFromInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { token: string; name: string; email: string; password: string }) =>
      store.signupFromInvite(input),
    onSuccess: () => qc.clear(),
  });
}

/** Admin-side: mint a set-your-own-password link to hand over. */
export function useIssuePasswordReset() {
  return useMutation({ mutationFn: (memberId: string) => store.issuePasswordReset(memberId) });
}

/** Public: is this reset link still live, and whose is it? */
export function usePasswordReset(token: string | undefined) {
  return useQuery({
    queryKey: ['password-reset', token ?? ''],
    queryFn: () => store.getPasswordReset(token!),
    enabled: Boolean(token),
    retry: false,
  });
}

export function useCompletePasswordReset() {
  return useMutation({
    mutationFn: (input: { token: string; password: string }) => store.completePasswordReset(input),
  });
}

/* ── Fill-link management (authed) ───────────────────────────────────────── */

export function useFillLinks(formId: string | undefined) {
  return useQuery({
    queryKey: keys.fillLinks(formId ?? ''),
    queryFn: () => store.listFillLinks(formId!),
    enabled: !!formId,
  });
}

export function useCreateFillLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { formId: string }) => store.createFillLink(input.formId),
    onSuccess: (_link, input) => {
      qc.invalidateQueries({ queryKey: keys.fillLinks(input.formId) });
      qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

export function useRevokeFillLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { formId: string; linkId: string }) => store.revokeFillLink(input),
    onSuccess: (_link, input) => {
      qc.invalidateQueries({ queryKey: keys.fillLinks(input.formId) });
      qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

/* ── Enterprise & org (Phase 3) ──────────────────────────────────────────── */

export function useMembers() {
  return useQuery({ queryKey: keys.members, queryFn: () => store.listMembers() });
}

/** The full permission matrix (role → category → action → allowed). */
export function useRoles() {
  return useQuery({ queryKey: keys.perms, queryFn: () => store.perms() });
}

export function useAuditLog() {
  return useQuery({ queryKey: keys.auditLog, queryFn: () => store.auditLog() });
}

/* ── API keys ─────────────────────────────────────────────────────────────── */

export function useApiKeys() {
  return useQuery({ queryKey: keys.apiKeys, queryFn: () => store.listApiKeys() });
}

export function useCreateApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; role: RoleName }) => store.createApiKey(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.apiKeys });
      qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

export function useRevokeApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => store.revokeApiKey(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.apiKeys });
      qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

/** Real plan/seat/feature data from `GET /org/billing`. */
export function useBilling() {
  return useQuery<OrgBilling>({ queryKey: keys.billing, queryFn: () => store.billing() });
}

/**
 * DEV/TESTING ONLY — switches the org's plan tier directly without any
 * payment processing. Replace with real billing integration before going live.
 * Invalidates the billing query and session on success.
 */
export function useUpdatePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (planTier: PlanTier) => store.updatePlan(planTier),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.billing });
      qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

export function useInviteMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { email?: string; name?: string; role: RoleName }) =>
      store.inviteMember(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.members });
      qc.invalidateQueries({ queryKey: keys.auditLog });
      qc.invalidateQueries({ queryKey: keys.billing });
    },
  });
}

export function useSetMemberRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; role: RoleName }) => store.setMemberRole(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.members });
      qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

export function useRemoveMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => store.removeMember(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.members });
      qc.invalidateQueries({ queryKey: keys.auditLog });
      qc.invalidateQueries({ queryKey: keys.billing });
    },
  });
}

export function useTogglePermission() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { role: RoleName; category: string; action: PermAction }) =>
      store.togglePermission(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.perms });
    },
  });
}

/**
 * Uploads an org logo and resolves to its public URL. Deliberately does NOT
 * invalidate the session: the wizard holds the returned URL in local state
 * and only persists it when the whole branding kit is saved via `PATCH /org`.
 */
export function useUploadOrgLogo() {
  return useMutation({
    mutationFn: async (input: {
      imageBase64: string;
      mimeType: string;
      usage?: 'org' | 'brand';
    }) => store.uploadOrgLogo(input),
  });
}

/**
 * Propose branding from the org's website. Read-only on the server: the
 * result is a draft the owner reviews, so there is nothing to invalidate.
 */
export function useBrandScan() {
  return useMutation({
    mutationFn: async (input: { url: string }) => store.scanBrandFromWebsite(input),
  });
}

/**
 * Update the org's name, branding, teamSize, and/or onboarding completion via
 * `PATCH /org`. Invalidates the session (the app shell shows `orgName` and
 * onboarding state from `/auth/me`) and the audit log (the API records the
 * change server-side).
 */
export function useUpdateOrg() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      name?: string;
      branding?: BrandingKit;
      teamSize?: string;
      onboardingComplete?: true;
    }) => store.updateOrg(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.session });
      qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

/** Persist a white-label branding save — writes through `PATCH /org` (audit entry recorded server-side). */
export function useUpdateWhiteLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { branding: BrandingKit }) => store.updateWhiteLabel(input),
    onSuccess: () => {
      // The session carries the org's branding, and the app shell reads it —
      // without this the sidebar keeps the old logo/accent until a reload.
      qc.invalidateQueries({ queryKey: keys.session });
      qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

/* ── Saved imports ───────────────────────────────────────────────────────── */

/**
 * Imports saved on the server, as distinct from the wizard's local autosave.
 * Summaries only — a snapshot is an entire extraction, and the list exists to
 * choose from rather than to load from.
 */
export function useImportDrafts() {
  return useQuery({ queryKey: keys.importDrafts, queryFn: () => store.listImportDrafts() });
}

export function useSaveImportDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; assetId: string; snapshot: ImportSnapshot }) =>
      store.saveImportDraft(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.importDrafts });
      qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

export function useDiscardImportDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => store.discardImportDraft(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.importDrafts });
      qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

/* ── Competency gating (Phase 4) ─────────────────────────────────────────── */

export function useCompetencies() {
  return useQuery({ queryKey: keys.competencies, queryFn: () => store.listCompetencies() });
}

export function useCompetencyRules() {
  return useQuery({ queryKey: keys.competencyRules, queryFn: () => store.listCompetencyRules() });
}

/** Add a competency to the register. */
export function useCreateCompetency() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      name: string;
      code: string | null;
      validForMonths: number | null;
      gracePeriodDays: number | null;
    }) => store.createCompetency(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.competencies });
      qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

/**
 * Who holds one competency, and whether each is still current.
 *
 * No `enabled` guard and no nullable id: the register is mounted only for the
 * competency actually expanded, so calling this hook IS the decision to fetch.
 * A hook that took null and disabled itself would put that decision in two
 * places and let a caller mount the component without meaning to load it.
 */
export function useCompetencyHolders(competencyId: string) {
  return useQuery({
    queryKey: keys.competencyHolders(competencyId),
    queryFn: () => store.listCompetencyHolders(competencyId),
  });
}

/** Grant a competency to a person by hand — external evidence, licences. */
export function useGrantCompetency(competencyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { userId: string; evidenceRef?: string; expiresAt?: string | null }) =>
      store.grantCompetency({ competencyId, ...input }),
    onSuccess: () => {
      // The competencies prefix sweeps the holder register too — holders are
      // nested under it for exactly this reason.
      void qc.invalidateQueries({ queryKey: keys.competencies });
    },
  });
}

/** Set, change or clear how long a competency stays valid. */
export function useSetCompetencyValidity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      validForMonths: number | null;
      gracePeriodDays: number | null;
    }) =>
      store.setCompetencyValidity(input.id, {
        validForMonths: input.validForMonths,
        gracePeriodDays: input.gracePeriodDays,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.competencies });
      qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

/* ── Award backfill (U4 — R3, KTD5) ──────────────────────────────────────── */

/**
 * The tools still awarding nothing — the one-time backfill worklist.
 *
 * `enabled` matters here more than on most reads: the endpoint is admin-only
 * (accepting a row converts Role requirements and creates cases), so a screen
 * mounted for an assessor or candidate must pass `enabled: false` rather than
 * fire a request the API would 403.
 */
export function useUnlinkedTools(options?: { enabled?: boolean; staleTime?: number }) {
  return useQuery({
    queryKey: keys.unlinkedTools,
    queryFn: () => store.listUnlinkedTools(),
    enabled: options?.enabled ?? true,
    ...(options?.staleTime !== undefined ? { staleTime: options.staleTime } : {}),
  });
}

/**
 * Preview a first award link (U4, KTD10). Read-only on the server — the
 * effects are shown for the admin to confirm, so there is nothing to
 * invalidate. A mutation rather than a query because it runs per click, on
 * a (tool, competency) pair the admin is actively considering.
 */
export function usePreviewAwardLink() {
  return useMutation({
    mutationFn: (input: { toolId: string; competencyId: string }) =>
      store.previewAwardLink(input.toolId, input.competencyId),
  });
}

/**
 * Apply a first award link — the previewed conversion (U4, R3, R15).
 *
 * The invalidation sweep is wide because the write is: the tool gains its
 * award (worklist + tool list), Roles gain direct links (every open role
 * editor's cache), and the activation creates real cases (case list, queue,
 * the admin working list, and the compliance numbers standing derives).
 */
export function useApplyAwardLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { toolId: string; competencyId: string }) =>
      store.applyAwardLink(input.toolId, input.competencyId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.unlinkedTools });
      qc.invalidateQueries({ queryKey: keys.assessmentTools });
      // Prefix match reaches every per-role editor cache — the conversion
      // moved that role's requirement from the legacy rows to a direct link.
      qc.invalidateQueries({ queryKey: ['roleRequiredAssessments'] });
      qc.invalidateQueries({ queryKey: keys.assessmentCases });
      qc.invalidateQueries({ queryKey: keys.assessorQueue });
      qc.invalidateQueries({ queryKey: keys.workingList });
      qc.invalidateQueries({ queryKey: keys.compliance });
      qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

export function useAddRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { formId: string; competencyId: string; section: string }) =>
      store.addRule(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.competencyRules });
      qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

export function useToggleRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => store.toggleRule(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.competencyRules });
    },
  });
}

export function useRemoveRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => store.removeRule(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.competencyRules });
    },
  });
}

/* ── Mobile field app (Phase 5) ──────────────────────────────────────────── */

export function useSubmitInspection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      templateId: string;
      /** The version the fill surface rendered — pins the submission server-side. */
      versionId: string;
      values: Record<string, SubmissionValue>;
      submitterName?: string;
      submitterEmail?: string;
    }) => store.submitInspection(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.submissions });
      qc.invalidateQueries({ queryKey: keys.dashboard });
    },
  });
}

export type { FormSummary, FormDetail, SubmissionRow, SubmissionDetail };


// ── assessments ─────────────────────────────────────────────────────────────
//
// Case reads are invalidated on every mutation rather than patched in place:
// part state is DERIVED server-side from the attempt rows, so the server's view
// is the only correct one. Optimistically editing a cached case would mean
// re-implementing the unlock and outcome rules in the browser, and any drift
// between the two would show a candidate a part the API would refuse.

export function useAssessmentTools() {
  return useQuery({ queryKey: keys.assessmentTools, queryFn: () => assessmentsApi.listTools() });
}

/** One tool, with its workflow and the current version's fields. */
export function useAssessmentTool(toolId: string) {
  return useQuery({
    queryKey: [...keys.assessmentTools, toolId] as const,
    queryFn: () => assessmentsApi.getTool(toolId),
  });
}

/** Save a workflow. Resolves with whatever warnings the server raised. */
export function useSaveWorkflow(toolId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      workflow: AssessmentWorkflow;
      profilePrefill?: Record<string, ProfilePrefillKey> | null;
      prerequisiteChecks?: PrerequisiteCheck[] | null;
      fieldDefaults?: Record<string, SubmissionValue> | null;
    }) =>
      assessmentsApi.saveWorkflow(
        toolId,
        input.workflow,
        input.profilePrefill,
        input.prerequisiteChecks,
        input.fieldDefaults,
      ),
    onSuccess: () => {
      // Prefix invalidation, so the detail AND the list refresh: the list
      // carries each tool's parts, and a workflow change can alter what a
      // candidate is shown.
      qc.invalidateQueries({ queryKey: keys.assessmentTools });
      qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

/** Declare which parts apply at each Location (U9). Admin-gated server-side. */
export function useSetLocationParts(toolId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (locationPartKeys: Record<string, string[]>) =>
      assessmentsApi.setLocationParts(toolId, locationPartKeys),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.assessmentTools });
      qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

export function useAssessmentCases(options?: { enabled?: boolean; staleTime?: number }) {
  return useQuery({
    queryKey: keys.assessmentCases,
    queryFn: () => assessmentsApi.listCases(),
    enabled: options?.enabled ?? true,
    ...(options?.staleTime !== undefined ? { staleTime: options.staleTime } : {}),
  });
}

/** The shared assessor queue — unowned cases the reader is eligible for (U13). */
export function useAssessorQueue(options?: { enabled?: boolean; staleTime?: number }) {
  return useQuery({
    queryKey: keys.assessorQueue,
    queryFn: () => assessmentsApi.listQueue(),
    enabled: options?.enabled ?? true,
    ...(options?.staleTime !== undefined ? { staleTime: options.staleTime } : {}),
  });
}

/**
 * Build the evidence PDF for a case.
 *
 * A mutation rather than a query: it is an action someone waits on, and caching
 * a document that changes every time a part is marked would eventually hand
 * somebody a stale competency record.
 */
export function useExportCasePdf() {
  return useMutation({ mutationFn: (caseId: string) => assessmentsApi.exportCasePdf(caseId) });
}

/** Every case's progress in one read — the dashboard's only query. */
export function useAssessmentProgress() {
  return useQuery({ queryKey: keys.assessmentProgress, queryFn: () => assessmentsApi.listProgress() });
}

export function useAssessmentCase(id: string | undefined) {
  return useQuery({
    queryKey: keys.assessmentCase(id ?? ''),
    queryFn: () => assessmentsApi.getCase(id!),
    enabled: !!id,
  });
}

/** One attempt's fillable surface — part-scoped fields plus saved answers. */
export function useAssessmentAttempt(caseId: string | undefined, attemptId: string | undefined) {
  return useQuery({
    queryKey: keys.assessmentAttempt(caseId ?? '', attemptId ?? ''),
    queryFn: () => assessmentsApi.getAttempt(caseId!, attemptId!),
    enabled: Boolean(caseId && attemptId),
  });
}

export function useCreateAssessmentCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCaseInput) => assessmentsApi.createCase(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.assessmentCases });
      void qc.invalidateQueries({ queryKey: keys.assessorQueue });
      void qc.invalidateQueries({ queryKey: keys.assessmentProgress });
    },
  });
}

export function useOpenAttempt(caseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (partKey: string) => assessmentsApi.openAttempt(caseId, partKey),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.assessmentCase(caseId) });
      void qc.invalidateQueries({ queryKey: keys.assessmentProgress });
    },
  });
}

export function useSaveAttempt(caseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { attemptId: string; values: Record<string, SubmissionValue> }) =>
      assessmentsApi.saveAttempt(caseId, input.attemptId, input.values),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.assessmentCase(caseId) });
      // Saving a logbook moves its hours, which is a column of the dashboard.
      void qc.invalidateQueries({ queryKey: keys.assessmentProgress });
    },
  });
}

/** Hand a part in, or take it back while it is still unmarked. */
export function useSetAttemptSubmitted(caseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { attemptId: string; submitted: boolean }) =>
      input.submitted
        ? assessmentsApi.submitAttempt(caseId, input.attemptId)
        : assessmentsApi.reopenAttempt(caseId, input.attemptId),
    onSuccess: (_r, input) => {
      void qc.invalidateQueries({ queryKey: keys.assessmentCase(caseId) });
      void qc.invalidateQueries({ queryKey: keys.assessmentAttempt(caseId, input.attemptId) });
    },
  });
}

export function useCheckQuestion(caseId: string, attemptId: string | undefined) {
  return useMutation({
    mutationFn: (input: { fieldId: string; value: SubmissionValue }) =>
      assessmentsApi.checkQuestion(caseId, attemptId!, input.fieldId, input.value),
  });
}

export function useRecordOutcome(caseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<RecordOutcomeInput, 'caseId'>) =>
      assessmentsApi.recordOutcome({ caseId, ...input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.assessmentCase(caseId) });
      void qc.invalidateQueries({ queryKey: keys.assessmentCases });
      void qc.invalidateQueries({ queryKey: keys.assessorQueue });
      void qc.invalidateQueries({ queryKey: keys.assessmentProgress });
    },
  });
}

/** The assessor's final approval. Invalidates the same three views an outcome does. */
export function useSignOffCase(caseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { assessorName: string; signature: string }) =>
      assessmentsApi.signOffCase({ caseId, ...input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.assessmentCase(caseId) });
      void qc.invalidateQueries({ queryKey: keys.assessmentCases });
      void qc.invalidateQueries({ queryKey: keys.assessorQueue });
      void qc.invalidateQueries({ queryKey: keys.assessmentProgress });
    },
  });
}

export function useChangePathway(caseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { pathway: AssessmentPathway; reason: string; rplJustification?: string }) =>
      assessmentsApi.changePathway(caseId, input.pathway, input.reason, input.rplJustification),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.assessmentCase(caseId) });
      void qc.invalidateQueries({ queryKey: keys.assessmentCases });
      void qc.invalidateQueries({ queryKey: keys.assessorQueue });
      void qc.invalidateQueries({ queryKey: keys.assessmentProgress });
    },
  });
}

/* ── Taxonomy (Locations, Departments, Roles) ─────────────────────────────── */

export function useTaxonomy() {
  return useQuery({ queryKey: keys.taxonomy, queryFn: () => store.getTaxonomy() });
}

/** Every taxonomy mutation re-reads the whole taxonomy and refreshes the audit feed. */
function useTaxonomyMutation<TArgs>(fn: (args: TArgs) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.taxonomy });
      void qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

export function useCreateLocation() {
  return useTaxonomyMutation((name: string) => store.createLocation(name));
}
export function useUpdateLocation() {
  return useTaxonomyMutation((input: { id: string; name?: string; status?: TaxonomyStatus }) =>
    store.updateLocation(input.id, { name: input.name, status: input.status }),
  );
}
export function useCreateDepartment() {
  return useTaxonomyMutation((input: { name: string; allowsMultipleRoles?: boolean }) =>
    store.createDepartment(input),
  );
}
export function useUpdateDepartment() {
  return useTaxonomyMutation(
    (input: { id: string; name?: string; allowsMultipleRoles?: boolean; status?: TaxonomyStatus }) =>
      store.updateDepartment(input.id, {
        name: input.name,
        allowsMultipleRoles: input.allowsMultipleRoles,
        status: input.status,
      }),
  );
}
export function useCreateRole() {
  return useTaxonomyMutation((input: { departmentId: string; name: string }) =>
    store.createRole(input.departmentId, input.name),
  );
}
export function useUpdateRole() {
  return useTaxonomyMutation((input: { id: string; name?: string; status?: TaxonomyStatus }) =>
    store.updateRole(input.id, { name: input.name, status: input.status }),
  );
}

/**
 * Stop offering a Role (U17, R52): retire it AND withdraw it from every holder.
 * Distinct from retiring, which leaves holders in place. Refreshes the taxonomy
 * and audit feed; competency reads change too, since a withdrawn Role's
 * competencies may demote to optional through the standing derivation.
 */
export function useStopOfferingRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (roleId: string) => store.stopOfferingRole(roleId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.taxonomy });
      void qc.invalidateQueries({ queryKey: keys.competencies });
      void qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

/** The people a Department tightening still has to resolve (U17, R112). */
export function useTighteningReview(departmentId: string | undefined) {
  return useQuery({
    queryKey: keys.tighteningReview(departmentId ?? ''),
    queryFn: () => store.getTighteningReview(departmentId!),
    enabled: Boolean(departmentId),
  });
}

/**
 * Apply one person's tightening choice (U17, R113). On success the review is
 * re-read so the resolved person drops off it, and competency reads refresh
 * because a withdrawn Role's competencies may demote to optional.
 */
export function useResolveTightening(departmentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { membershipId: string; survivingRoleId: string }) =>
      store.resolveTightening(departmentId, input.membershipId, input.survivingRoleId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.tighteningReview(departmentId) });
      void qc.invalidateQueries({ queryKey: keys.competencies });
      void qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

/** The people still holding any retired value (U18). */
export function useRetirementReview() {
  return useQuery({
    queryKey: keys.retirementReview,
    queryFn: () => store.getRetirementReview(),
  });
}

/** What a Location transfer would move, before committing (U18, R132). */
export function usePreviewLocationTransfer() {
  return useMutation({
    mutationFn: (input: { locationId: string; replacementLocationId: string }) =>
      store.previewLocationTransfer(input.locationId, input.replacementLocationId),
  });
}

/** Shared invalidation after a retirement transfer — the review shrinks and standing may shift. */
function useTransferMutation<TArgs>(fn: (args: TArgs) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.retirementReview });
      void qc.invalidateQueries({ queryKey: keys.taxonomy });
      void qc.invalidateQueries({ queryKey: keys.competencies });
      void qc.invalidateQueries({ queryKey: keys.assessmentCases });
      void qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

/** Move everyone off a retired Location, carrying or rewriting their cases (U18, R133). */
export function useTransferLocation() {
  return useTransferMutation(
    (input: { locationId: string; replacementLocationId: string; caseOutcome: 'carry' | 'rewrite' }) =>
      store.transferLocation(input.locationId, input.replacementLocationId, input.caseOutcome),
  );
}

/** Move everyone off a retired Role to a replacement; cases untouched (U18, R135). */
export function useTransferRole() {
  return useTransferMutation((input: { roleId: string; replacementRoleId: string }) =>
    store.transferRole(input.roleId, input.replacementRoleId),
  );
}

/** Everything waiting on an Admin, from all sources, on one list (U19). */
export function useWorkingList(options?: { enabled?: boolean; staleTime?: number }) {
  return useQuery({
    queryKey: keys.workingList,
    queryFn: () => store.getWorkingList(),
    enabled: options?.enabled ?? true,
    ...(options?.staleTime !== undefined ? { staleTime: options.staleTime } : {}),
  });
}

/** How the workforce stands — expired, expiring, never-held, unreachable (U20). */
export function useComplianceReport(options?: { enabled?: boolean; staleTime?: number }) {
  return useQuery({
    queryKey: keys.compliance,
    queryFn: () => store.getComplianceReport(),
    enabled: options?.enabled ?? true,
    ...(options?.staleTime !== undefined ? { staleTime: options.staleTime } : {}),
  });
}

/** The caller's own expiry notices — the login delivery route (U21, R98). */
export function useMyNotices() {
  return useQuery({ queryKey: keys.myNotices, queryFn: () => store.listMyNotices() });
}

/** Request voluntary training for a tool — own-scope (U22, R37). */
export function useRequestTraining() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (toolId: string) => store.requestTraining(toolId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.trainingRequests });
      void qc.invalidateQueries({ queryKey: keys.workingList });
    },
  });
}

/** The org's pending training requests, for the Admin approval surface (U22). */
export function useTrainingRequests() {
  return useQuery({ queryKey: keys.trainingRequests, queryFn: () => store.listTrainingRequests() });
}

/** Shared invalidation after deciding a request — it leaves the pending list and the working list. */
function useDecideTrainingRequest(fn: (id: string) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.trainingRequests });
      void qc.invalidateQueries({ queryKey: keys.workingList });
      void qc.invalidateQueries({ queryKey: keys.assessmentCases });
      void qc.invalidateQueries({ queryKey: keys.assessorQueue });
      void qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

/** Approve a request — assigns the tool through the ordinary path (U22, R94). */
export function useApproveTrainingRequest() {
  return useDecideTrainingRequest((id: string) => store.approveTrainingRequest(id));
}

/** Decline a request — nothing assigned (U22). */
export function useDeclineTrainingRequest() {
  return useDecideTrainingRequest((id: string) => store.declineTrainingRequest(id));
}

/** Move everyone off a retired Department to a replacement; cases untouched (U18, R135). */
export function useTransferDepartment() {
  return useTransferMutation(
    (input: { departmentId: string; replacementDepartmentId: string }) =>
      store.transferDepartment(input.departmentId, input.replacementDepartmentId),
  );
}
export function useUpdateTaxonomySettings() {
  return useTaxonomyMutation((patch: Partial<TaxonomySettings>) =>
    store.updateTaxonomySettings(patch),
  );
}

/**
 * A Role's requirements in COMPETENCY terms (U6, U3): two tiers, the legacy
 * `awaitingLink` rows, and the KTD9 fingerprint every write must echo.
 * `configured` distinguishes never-set from emptied (R50).
 */
export function useRoleRequiredAssessments(roleId: string | undefined) {
  return useQuery({
    queryKey: keys.roleRequiredAssessments(roleId ?? ''),
    queryFn: () => store.getRoleRequiredAssessments(roleId!),
    enabled: Boolean(roleId),
  });
}

/**
 * Project a proposed change's blast radius without committing it (U12, KTD10).
 * Takes both tiers plus optional legacy removals — the awaitingLink exit
 * previews through this same door (KTD9).
 */
export function usePreviewRoleRequiredAssessments(roleId: string) {
  return useMutation({
    mutationFn: (body: RoleRequirementTiers & { removeLegacyToolIds?: string[] }) =>
      store.previewRoleRequiredAssessments(roleId, body),
  });
}

/** The invalidation sweep both requirement writes share — what a save or legacy removal goes stale. */
function useRequirementWriteInvalidation(roleId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: keys.roleRequiredAssessments(roleId) });
    // The taxonomy read carries each Role's configured flag; a new case can
    // reach the case list AND the progress dashboard (a deliberate sibling key,
    // so it must be swept explicitly); the audit feed logs the change. The
    // recommended surfaces derive from the same links (U7), and standing feeds
    // the compliance numbers (U8), so both refetch too.
    void qc.invalidateQueries({ queryKey: keys.taxonomy });
    void qc.invalidateQueries({ queryKey: keys.assessmentCases });
    void qc.invalidateQueries({ queryKey: keys.assessorQueue });
    void qc.invalidateQueries({ queryKey: keys.assessmentProgress });
    void qc.invalidateQueries({ queryKey: keys.myRecommended });
    void qc.invalidateQueries({ queryKey: keys.compliance });
    void qc.invalidateQueries({ queryKey: keys.auditLog });
  };
}

/** Replace both tiers, echoing the fingerprint (KTD9 — a stale echo 409s `requirements_changed`). */
export function useSetRoleRequiredAssessments(roleId: string) {
  const invalidate = useRequirementWriteInvalidation(roleId);
  return useMutation({
    mutationFn: (body: RoleRequirementTiers & { fingerprint: string }) =>
      store.setRoleRequiredAssessments(roleId, body),
    onSuccess: invalidate,
  });
}

/**
 * Remove ONE awaitingLink legacy row (U6, KTD9) — the exit for a tool that
 * will never be linked. Fingerprint-guarded like the PUT, and confirmed
 * through the same preview before the editor calls this.
 */
export function useRemoveLegacyRequirement(roleId: string) {
  const invalidate = useRequirementWriteInvalidation(roleId);
  return useMutation({
    mutationFn: (input: { toolId: string; fingerprint: string }) =>
      store.removeLegacyRequirement(roleId, input.toolId, input.fingerprint),
    onSuccess: invalidate,
  });
}

/**
 * The caller's OWN recommended competencies (U7, R12) — powers the candidate
 * record and dashboard. Self-scope, so no admin gate and no `enabled` dance:
 * mounting the surface IS the decision to ask.
 */
export function useMyRecommended() {
  return useQuery({ queryKey: keys.myRecommended, queryFn: () => store.listMyRecommended() });
}

export function useMemberPlacement(membershipId: string | undefined) {
  return useQuery({
    queryKey: keys.memberPlacement(membershipId ?? ''),
    queryFn: () => store.getMemberPlacement(membershipId!),
    enabled: !!membershipId,
  });
}

export function useSetMemberPlacement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      membershipId: string;
      locationIds: string[];
      departmentIds: string[];
      roleIds: string[];
    }) =>
      store.setMemberPlacement(input.membershipId, {
        locationIds: input.locationIds,
        departmentIds: input.departmentIds,
        roleIds: input.roleIds,
      }),
    onSuccess: (_data, input) => {
      void qc.invalidateQueries({ queryKey: keys.memberPlacement(input.membershipId) });
      void qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

/* ── Member profile (U29, U38) ────────────────────────────────────────────── */

/**
 * One member's record, with what THIS reader may do with it.
 *
 * The access block comes back from the same call rather than being inferred
 * here, so the screen renders the sections it is admitted to instead of
 * guessing and 403ing on click (R44).
 */
export function useProfile(membershipId: string | undefined) {
  return useQuery({
    queryKey: keys.profile(membershipId ?? ''),
    queryFn: () => store.getProfile(membershipId!),
    enabled: !!membershipId,
    // A record the caller may not read is a settled answer, not a blip.
    retry: false,
  });
}

/** The caller's own membership id — the candidate's fixed own-record path (R49). */
export function useMyProfileMembership() {
  return useQuery({
    queryKey: keys.myProfileMembership,
    queryFn: () => store.getMyProfileMembership(),
  });
}

export function useSaveProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { membershipId: string; values: Record<string, string>; create?: boolean }) =>
      input.create
        ? store.createProfile(input.membershipId, input.values)
        : store.updateProfile(input.membershipId, input.values),
    onSuccess: (_data, input) => {
      void qc.invalidateQueries({ queryKey: keys.profile(input.membershipId) });
      // A profile edit can clear an owed-file item and always writes an audit
      // entry, so both surfaces are stale the moment this returns.
      void qc.invalidateQueries({ queryKey: keys.workingList });
      void qc.invalidateQueries({ queryKey: keys.auditLog });
    },
  });
}

/** One person's held competencies, with standing beside currency (U38, R37). */
export function useHeldCompetencies(userId: string | undefined) {
  return useQuery({
    queryKey: keys.heldCompetencies(userId ?? ''),
    queryFn: () => store.getHeldCompetencies(userId!),
    enabled: !!userId,
  });
}

/** What an induction submission would seed, and whether it may (U40, R89). */
export function useProfileSeed(submissionId: string | undefined) {
  return useQuery({
    queryKey: keys.profileSeed(submissionId ?? ''),
    queryFn: () => store.getProfileSeed(submissionId!),
    enabled: !!submissionId,
    retry: false,
  });
}

/* ── Workforce import (U23, U24) ──────────────────────────────────────────── */

/** Price a filled file. A mutation because it POSTs, but it writes nothing (R144). */
export function useValidateWorkforceImport() {
  return useMutation({ mutationFn: (csv: string) => store.validateWorkforceImport(csv) });
}

/**
 * Confirm and START the import.
 *
 * Resolves with the run id as soon as the run exists, NOT when it finishes — the
 * work continues server-side either way. Invalidates the team list and the
 * working list because both go stale as rows land, and the active-run query
 * because there is now one in flight.
 */
export function useRunWorkforceImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (csv: string) => store.runWorkforceImport(csv),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.members });
      void qc.invalidateQueries({ queryKey: keys.workingList });
      void qc.invalidateQueries({ queryKey: keys.auditLog });
      void qc.invalidateQueries({ queryKey: keys.activeImportRun });
    },
  });
}

/**
 * One run's report: progress while it runs, the whole thing after.
 *
 * Polls on STATUS rather than on `completedAt`, which is the difference between
 * a screen that stops and one that spins forever. A failed run — including one
 * whose process died and was reaped — is finished, and polling it would be
 * asking a question already answered.
 */
export function useWorkforceImportRun(runId: string | undefined) {
  return useQuery({
    queryKey: keys.importRun(runId ?? ''),
    queryFn: () => store.getWorkforceImportRun(runId!),
    enabled: !!runId,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 1000 : false),
  });
}

/**
 * Whether this organisation has an import in flight.
 *
 * ASKED BEFORE THE SCREEN OFFERS TO START ONE. Without it, a page loaded after a
 * timeout has no idea a run exists and shows an upload form beside a live
 * confirm button — which is exactly what nearly put a 191-person file through
 * production twice. `staleTime: 0` because the whole value here is being
 * current at the moment the form would otherwise be drawn.
 */
export function useActiveWorkforceImport() {
  return useQuery({
    queryKey: keys.activeImportRun,
    queryFn: () => store.getActiveWorkforceImport(),
    staleTime: 0,
  });
}
