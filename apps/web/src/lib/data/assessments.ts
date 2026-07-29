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
