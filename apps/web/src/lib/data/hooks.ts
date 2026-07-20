/**
 * TanStack Query hooks over the `store`, which wraps the real `apps/api` calls
 * (see `store.ts` / `api-client.ts`). Screens depend only on this hook surface,
 * so the async data source stays behind the seam: Query gives them loading /
 * error state, caching, and invalidation on mutation.
 */
import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BrandingKit, FormContainer, FormField, SessionInfo, SubmissionValue } from '@formai/shared';
import { apiClient } from './api-client.js';
import { store } from './store.js';
import type {
  FormDetail,
  FormSummary,
  OrgBilling,
  PermAction,
  PlanTier,
  PublishImportInput,
  RoleName,
  SubmissionDetail,
  SubmissionRow,
} from './types.js';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: false },
  },
});

const keys = {
  session: ['session'] as const,
  forms: ['forms'] as const,
  form: (id: string) => ['forms', id] as const,
  submissions: ['submissions'] as const,
  submission: (id: string) => ['submissions', id] as const,
  dashboard: ['dashboard'] as const,
  members: ['members'] as const,
  perms: ['perms'] as const,
  auditLog: ['auditLog'] as const,
  billing: ['billing'] as const,
  competencies: ['competencies'] as const,
  competencyRules: ['competencyRules'] as const,
  fillForm: (token: string) => ['fillForm', token] as const,
  fillLinks: (formId: string) => ['fillLinks', formId] as const,
  invite: (token: string) => ['invite', token] as const,
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
 * source-PDF asset to /pdf/round-trip; resolves the filled PDF as a Blob.
 */
export function useExportSubmissionPdf() {
  return useMutation({
    mutationFn: async (detail: SubmissionDetail) => store.exportSubmissionPdf(detail),
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

export function useDashboard() {
  return useQuery({ queryKey: keys.dashboard, queryFn: () => store.dashboard() });
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
    mutationFn: async (input: { email: string; role: RoleName }) => store.inviteMember(input),
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
 * Update the org's name, branding, teamSize, and/or onboarding completion via
 * `PATCH /org`. Invalidates the session (the app shell shows `orgName` and
 * onboarding state from `/auth/me`) and the audit log (the API records the
 * change server-side).
 */
/**
 * Uploads an org logo and resolves to its public URL. Deliberately does NOT
 * invalidate the session: the wizard holds the returned URL in local state
 * and only persists it when the whole branding kit is saved via `PATCH /org`.
 */
export function useUploadOrgLogo() {
  return useMutation({
    mutationFn: async (input: { imageBase64: string; mimeType: string }) =>
      store.uploadOrgLogo(input),
  });
}

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

/* ── Competency gating (Phase 4) ─────────────────────────────────────────── */

export function useCompetencies() {
  return useQuery({ queryKey: keys.competencies, queryFn: () => store.listCompetencies() });
}

export function useCompetencyRules() {
  return useQuery({ queryKey: keys.competencyRules, queryFn: () => store.listCompetencyRules() });
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
