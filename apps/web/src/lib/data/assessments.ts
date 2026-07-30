/**
 * Assessment cases — the client surface over `/assessment-tools` and
 * `/assessment-cases`.
 *
 * Kept in its own module rather than folded into `store.ts` because the
 * assessment vocabulary (parts, attempts, outcomes, dispositions) is a distinct
 * domain from forms and submissions, and the screens that consume it are new.
 *
 * SCOPE IS SERVER-SIDE. The case list a candidate receives is already filtered
 * to their own cases by the API, and a case belonging to someone else answers
 * 404. Nothing here re-filters — a client-side filter would imply the browser
 * had ever been sent the rest.
 */
import type {
  AssessmentPathway,
  FormField,
  NotSatisfactoryDisposition,
  PartKind,
  PartOutcome,
  PartState,
  SubmissionValue,
} from '@formai/shared';
import { apiClient } from './api-client.js';

export interface AssessmentToolSummary {
  id: string;
  name: string;
  templateId: string;
  parts: { key: string; label: string; kind: PartKind }[];
}

export interface AssessmentCaseRow {
  id: string;
  toolName: string;
  candidateUserId: string;
  pathway: AssessmentPathway;
  state: 'open' | 'competent' | 'closed';
  createdAt: string;
}

export interface CasePartView {
  key: string;
  label: string;
  kind: PartKind;
  ordinal: number;
  minimumHours: number | null;
  state: PartState;
  attempts: number;
  latestOutcome: PartOutcome | null;
}

export interface CaseAttemptView {
  id: string;
  partKey: string;
  attemptNumber: number;
  outcome: PartOutcome | null;
  /** Null until the candidate hands it in — the "ready to mark" signal. */
  submittedAt: string | null;
  disposition: NotSatisfactoryDisposition | null;
  dispositionReason: string | null;
  templateVersionId: string;
  signedAt: string | null;
}

export interface AssessmentCaseDetail {
  id: string;
  toolId: string;
  toolName: string;
  candidateUserId: string;
  assessorUserId: string | null;
  pathway: AssessmentPathway;
  locationStream: string | null;
  state: 'open' | 'competent' | 'closed';
  currentVersionId: string;
  prerequisiteWarnings: string[];
  appealOfCaseId: string | null;
  parts: CasePartView[];
  attempts: CaseAttemptView[];
}

/** One part of a case as the progress dashboard sees it. */
export interface CaseProgressPart {
  key: string;
  label: string;
  kind: PartKind;
  ordinal: number;
  state: PartState;
  latestOutcome: PartOutcome | null;
  attempts: number;
  minimumHours: number | null;
  /** Null for anything but a logbook — there is no threshold to meet. */
  loggedHours: number | null;
}

/**
 * One case on the progress dashboard.
 *
 * Every field here is DERIVED server-side from the attempt rows on each read —
 * the current part, each part's state, the hours logged. The screen renders what
 * it is given; recomputing any of it in the browser would be a second
 * implementation of the unlock and threshold rules, free to disagree with the
 * one that actually governs the case.
 */
export interface CaseProgressRow {
  id: string;
  toolName: string;
  candidateUserId: string;
  /** Empty when the user record cannot be resolved; the id is always present. */
  candidateName: string;
  pathway: AssessmentPathway;
  state: 'open' | 'competent' | 'closed';
  /** First part not yet satisfactory. Null once the case is competent. */
  currentPartKey: string | null;
  currentPartLabel: string | null;
  parts: CaseProgressPart[];
  createdAt: string;
}

/**
 * One attempt's fillable surface.
 *
 * `fields` arrive with answer keys and outcome targets ALREADY REMOVED by the
 * server — see the route. Nothing here re-strips them, because a client-side
 * strip would imply the browser had been sent them in the first place.
 */
export interface AttemptFillView {
  id: string;
  partKey: string;
  partLabel: string;
  partKind: PartKind;
  attemptNumber: number;
  outcome: PartOutcome | null;
  /** Null until the candidate hands it in. */
  submittedAt: string | null;
  templateVersionId: string;
  /**
   * The case's stream and the manifest question it answers. Either being null
   * fails OPEN: every location set renders rather than none.
   */
  locationStream: string | null;
  locationStreamFieldId: string | null;
  /** The stream question, for condition lookup — often outside this part. */
  streamField: FormField | null;
  minimumHours: number | null;
  durationColumnKey: string | null;
  fields: FormField[];
  values: Record<string, SubmissionValue>;
}

export interface CreateCaseInput {
  toolId: string;
  candidateUserId: string;
  assessorUserId?: string;
  pathway: AssessmentPathway;
  locationStream?: string;
  rplJustification?: string;
}

export interface RecordOutcomeInput {
  caseId: string;
  attemptId: string;
  outcome?: PartOutcome;
  disposition?: NotSatisfactoryDisposition;
  reason?: string;
  assessorName?: string;
  belowThresholdReason?: string;
}

export const assessmentsApi = {
  listTools: () => apiClient.get<AssessmentToolSummary[]>('/assessment-tools'),

  listCases: () => apiClient.get<AssessmentCaseRow[]>('/assessment-cases'),

  /**
   * Progress across every case the caller may see, in one request.
   *
   * A fixed path, so it must not be reachable as `getCase('progress')` — the
   * API declares this route before `/:id` for the same reason.
   */
  listProgress: () => apiClient.get<CaseProgressRow[]>('/assessment-cases/progress'),

  getCase: (id: string) => apiClient.get<AssessmentCaseDetail>(`/assessment-cases/${id}`),

  createCase: (input: CreateCaseInput) =>
    apiClient.post<{ id: string; pathway: AssessmentPathway; prerequisiteWarnings: string[]; parts: string[] }>(
      '/assessment-cases',
      input,
    ),

  changePathway: (caseId: string, pathway: AssessmentPathway, reason: string, rplJustification?: string) =>
    apiClient.patch<{ id: string; pathway: AssessmentPathway; parts: string[] }>(
      `/assessment-cases/${caseId}/pathway`,
      { pathway, reason, ...(rplJustification ? { rplJustification } : {}) },
    ),

  /** The fillable surface for one attempt: part-scoped fields and saved answers. */
  getAttempt: (caseId: string, attemptId: string) =>
    apiClient.get<AttemptFillView>(`/assessment-cases/${caseId}/attempts/${attemptId}`),

  /**
   * Hand a part in, or take it back.
   *
   * Reversible by the candidate right up until an assessor marks it — nothing
   * has been judged yet, so a mis-tap costs nobody anything.
   */
  submitAttempt: (caseId: string, attemptId: string) =>
    apiClient.post<{ id: string; submittedAt: string | null }>(
      `/assessment-cases/${caseId}/attempts/${attemptId}/submit`,
      {},
    ),

  reopenAttempt: (caseId: string, attemptId: string) =>
    apiClient.post<{ id: string; submittedAt: string | null }>(
      `/assessment-cases/${caseId}/attempts/${attemptId}/reopen`,
      {},
    ),

  /** Opens a new attempt, or returns the one already open for that part. */
  openAttempt: (caseId: string, partKey: string) =>
    apiClient.post<{ id: string; attemptNumber: number; reused: boolean }>(
      `/assessment-cases/${caseId}/parts/${partKey}/attempts`,
      {},
    ),

  saveAttempt: (caseId: string, attemptId: string, values: Record<string, SubmissionValue>) =>
    apiClient.patch<{ id: string; hours: number | null; thresholdReached: boolean }>(
      `/assessment-cases/${caseId}/attempts/${attemptId}`,
      { values },
    ),

  recordOutcome: ({ caseId, attemptId, ...body }: RecordOutcomeInput) =>
    apiClient.post<{
      id: string;
      outcome: PartOutcome;
      caseState: string;
      parts: { key: string; state: PartState }[];
    }>(`/assessment-cases/${caseId}/attempts/${attemptId}/outcome`, body),
};
