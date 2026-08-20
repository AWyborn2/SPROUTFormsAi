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
  PartCompletionMark,
  PrerequisiteCheck,
  ProfilePrefillKey,
  TheoryRendering,
  TheoryRetryMode,
  AssessmentPathway,
  AssessmentToolManifest,
  AssessmentWorkflow,
  CaseNextStep,
  DurationUnit,
  FormField,
  NotSatisfactoryDisposition,
  AssessmentCaseState,
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
  /**
   * The competency this tool grants (constrained to one at authoring time). Used
   * on the new-case form to suggest a pathway: a candidate who already holds it
   * is `experienced`, one who never has is `new`.
   */
  awardedCompetencyIds: string[];
  parts: { key: string; label: string; kind: PartKind }[];
  /**
   * Location streams whose assessor requirements differ, if any.
   *
   * The organisation's managed Locations, offered as a closed list when opening
   * a case (R77). A case is placed by choosing one, never by typing — so it
   * cannot be a near-miss of the site the assessor rule checks (R79).
   */
  locations: Array<{ id: string; name: string }>;
}

export interface AssessmentCaseRow {
  id: string;
  toolName: string;
  candidateUserId: string;
  candidateName: string;
  pathway: AssessmentPathway;
  state: AssessmentCaseState;
  /** Null on a pooled case — shown as unassigned (U13). */
  assessorUserId: string | null;
  createdAt: string;
  /** The part the case is at now — first not-yet-satisfactory. Null once competent. */
  currentPartLabel: string | null;
  /** 1-based position of that part among the pathway's required parts. */
  currentPartIndex: number | null;
  /** How many parts this pathway requires — the "of 6" in "Part 3 of 6". */
  requiredPartCount: number;
  /** Waiting on a person: a part handed in unmarked, or the final sign-off. */
  awaitingAssessor: boolean;
}

/** One unowned case an eligible assessor may pull from the shared queue (U13). */
export interface AssessorQueueItem {
  id: string;
  toolName: string;
  candidateUserId: string;
  candidateName: string;
  pathway: AssessmentPathway;
  locationId: string | null;
  locationName: string | null;
  createdAt: string;
  ageDays: number;
  /** Derived from the case's age against the org threshold (R63) — never stored. */
  overdue: boolean;
}

export interface CasePartView {
  key: string;
  label: string;
  kind: PartKind;
  ordinal: number;
  minimumHours: number | null;
  /** The unit the minimum is read in; null reads as hours. */
  durationUnit: DurationUnit | null;
  state: PartState;
  attempts: number;
  latestOutcome: PartOutcome | null;
  selfMarking: boolean;
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
  /** Who marked it (U15): 'automatic' was marked by nobody; null until marked. */
  markerKind: 'person' | 'automatic' | null;
  /** Assessor-eligibility shortfalls recorded when a person marked it (U14). */
  markingEligibilityWarnings: string[];
}

export interface AssessmentCaseDetail {
  id: string;
  toolId: string;
  toolName: string;
  candidateUserId: string;
  /** Resolved for display and for the exported document's filename. */
  candidateName: string;
  assessorUserId: string | null;
  pathway: AssessmentPathway;
  /** The managed Location this case is assessed at (R77), and its current name. */
  locationId: string | null;
  locationName: string | null;
  state: AssessmentCaseState;
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
  state: AssessmentCaseState;
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
  /**
   * How this part's theory questions should be presented (U21).
   *
   * Read off the tool's manifest by the server, not decided here: the choice
   * was made once by the author in the builder and has to reach every candidate
   * who opens the assessment. Null means `stacked`, which is what every theory
   * part rendered as before this existed.
   */
  theoryRendering?: TheoryRendering | null;
  /** When a candidate may retry a wrong theory part — resolved by the server. */
  theoryRetry?: TheoryRetryMode;
  /** Pass threshold percentage (1–100), or null for mandatory-all-correct. */
  theoryPassPercent?: number | null;
  attemptNumber: number;
  outcome: PartOutcome | null;
  /** Null until the candidate hands it in. */
  submittedAt: string | null;
  templateVersionId: string;
  /**
   * Which side of this assessment the caller is on, decided by the server from
   * the case (the candidate on the case is the candidate; anyone else with
   * access is acting as the assessor). A self-assessing candidate is
   * `candidate` — identity, not permission — which is what keeps the marking
   * guide off their own paper.
   */
  party: 'candidate' | 'assessor';
  /**
   * The assessor's marking guide: each written question's model answer, served
   * as a separate role-gated block ONLY when `party === 'assessor'`. `fields`
   * above stay stripped for everyone — this never rides on a field — and the
   * property is ABSENT (not empty) on a candidate payload, so no
   * candidate-shaped response has anywhere a secret could sit.
   */
  markingGuide?: { fieldId: string; modelAnswer: string }[];
  /** The step after this part — a "continue", or a wait on the other party. */
  nextStep: CaseNextStep;
  /**
   * The case's stream and the manifest question it answers. Either being null
   * fails OPEN: every location set renders rather than none.
   */
  locationStream: string | null;
  locationStreamFieldId: string | null;
  /** The stream question, for condition lookup — often outside this part. */
  streamField: FormField | null;
  minimumHours: number | null;
  /** The unit the minimum and logged Duration are read in; null reads as hours. */
  durationUnit: DurationUnit | null;
  durationColumnKey: string | null;
  /**
   * Per-task-type hour targets, when this logbook part declares them. Drives
   * the live per-task progress on the fill surface; a soft target, never a
   * gate.
   */
  taskMinimums: NonNullable<AssessmentToolManifest['parts'][number]['taskMinimums']> | null;
  /** Everything this caller may SEE. Hidden fields are already absent. */
  fields: FormField[];
  /**
   * Of those, the ones they may CHANGE.
   *
   * Read-only and absent answer different questions: a candidate sees the
   * practical criteria they will be marked against — that is the standard being
   * applied to them — and never sees the assessor's private comments. The
   * server decides both, and this screen renders what it is given rather than
   * working out scope a second time.
   */
  writableFieldIds: string[];
  values: Record<string, SubmissionValue>;
}

export interface CreateCaseInput {
  toolId: string;
  candidateUserId: string;
  assessorUserId?: string;
  pathway: AssessmentPathway;
  /** The managed Location id the case is assessed at, chosen from the list (R77). */
  locationId?: string;
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

/** One tool, with everything the workflow builder needs to render. */
export interface AssessmentToolDetail {
  id: string;
  name: string;
  templateId: string;
  manifest: AssessmentToolManifest;
  /** Always present — synthesised from the parts when nobody has configured one. */
  workflow: AssessmentWorkflow;
  /** True while that synthesised default is what is stored, i.e. nothing yet. */
  workflowIsDefault: boolean;
  /** The current version's fields, in document order. */
  fields: FormField[];
  /**
   * The organisation's active Locations, offered to the parts-rule editor (R76),
   * and the rule as stored (U9): Location id → the part keys required there. A
   * Location absent from the map requires every part (R75); a key may name a
   * Location since retired, so the editor merges these rather than assuming every
   * key is in `locations` (R118).
   */
  locations: Array<{ id: string; name: string }>;
  locationPartKeys: Record<string, string[]>;
  problems: string[];
  warnings: string[];
}

export const assessmentsApi = {
  listTools: () => apiClient.get<AssessmentToolSummary[]>('/assessment-tools'),

  /**
   * Publish a REVISION: one transaction that freezes the revised draft version
   * and updates this tool's manifest together. Refused with `stale_revision`
   * when the tool was republished after the revision was seeded, and with
   * `open_cases_incompatible` when the new manifest would dangle against an
   * open case's pinned fields (R14, R16).
   */
  republishTool: (input: {
    toolId: string;
    versionId: string;
    seededFromVersionId: string;
    fields: FormField[];
    manifest: AssessmentToolManifest;
    name?: string;
    revisionIdentity?: { code?: string; reviewedOn?: string; note?: string };
    /** The author's explicit untick of removed parts from Location rules. */
    dropDanglingLocationRules?: boolean;
  }) =>
    apiClient.post<{ id: string; templateId: string; versionId: string; versionLabel: string; warnings: string[] }>(
      `/assessment-tools/${input.toolId}/republish`,
      {
        versionId: input.versionId,
        seededFromVersionId: input.seededFromVersionId,
        fields: input.fields,
        manifest: input.manifest,
        ...(input.name ? { name: input.name } : {}),
        ...(input.revisionIdentity ? { revisionIdentity: input.revisionIdentity } : {}),
        ...(input.dropDanglingLocationRules ? { dropDanglingLocationRules: true } : {}),
      },
    ),

  /**
   * One tool with everything the workflow builder renders.
   *
   * The manifest AND the version's fields in one response — the builder draws
   * the document beside the process, so fetching them separately would let it
   * show half a screen against a version the other half does not describe.
   */
  getTool: (id: string) => apiClient.get<AssessmentToolDetail>(`/assessment-tools/${id}`),

  /**
   * Save a workflow.
   *
   * WARNINGS come back with a 200: an unfinished configuration is a real thing
   * to save and return to, and refusing it would make the builder unusable
   * halfway through a first pass. Structural problems 400 and nothing is
   * written, because a half-applied workflow decides who may write a competency
   * record.
   */
  saveWorkflow: (
    id: string,
    workflow: AssessmentWorkflow,
    profilePrefill?: Record<string, ProfilePrefillKey> | null,
    prerequisiteChecks?: PrerequisiteCheck[] | null,
    fieldDefaults?: Record<string, SubmissionValue> | null,
    partCompletionMarks?: PartCompletionMark[] | null,
    signOff?: AssessmentToolManifest['signOff'] | null,
    pathwayMarks?: AssessmentToolManifest['pathwayMarks'] | null,
  ) =>
    apiClient.patch<{ id: string; workflow: AssessmentWorkflow; warnings: string[] }>(
      `/assessment-tools/${id}`,
      // Absent leaves the stored map alone; null clears it. Sent only when the
      // editor actually touched it, so a plain workflow save cannot erase it.
      {
        workflow,
        ...(profilePrefill !== undefined ? { profilePrefill } : {}),
        ...(prerequisiteChecks !== undefined ? { prerequisiteChecks } : {}),
        ...(fieldDefaults !== undefined ? { fieldDefaults } : {}),
        ...(partCompletionMarks !== undefined ? { partCompletionMarks } : {}),
        ...(signOff !== undefined ? { signOff } : {}),
        ...(pathwayMarks !== undefined ? { pathwayMarks } : {}),
      },
    ),

  /**
   * Declare which parts apply at each Location (U9).
   *
   * Its own call, not part of `saveWorkflow`, because the server gates it on the
   * Admin access level rather than the authoring permission (R73) — the rule
   * decides which sections a candidate must complete to be certified, not how the
   * document is worded. The map holds only the exceptions: a Location left out
   * requires every part (R75).
   */
  setLocationParts: (id: string, locationPartKeys: Record<string, string[]>) =>
    apiClient.patch<{ id: string; locationPartKeys: Record<string, string[]> }>(
      `/assessment-tools/${id}/location-parts`,
      { locationPartKeys },
    ),

  listCases: () => apiClient.get<AssessmentCaseRow[]>('/assessment-cases'),

  /** The shared pool of unowned cases the reading assessor is eligible for (U13). */
  listQueue: () => apiClient.get<AssessorQueueItem[]>('/assessment-cases/queue'),

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
   * A person-judged part stays reversible until an assessor marks it — nothing
   * has been judged yet, so a mis-tap costs nobody anything. A fully-keyed part
   * MARKS ITSELF at hand-in, and the response says how it went: `outcome`
   * arrives when marking ran, so the screen can tell the candidate the result
   * in the same breath.
   */
  submitAttempt: (caseId: string, attemptId: string) =>
    apiClient.post<{
      id: string;
      submittedAt: string | null;
      outcome?: PartOutcome;
      caseState?: AssessmentCaseState;
      correctCount?: number;
      totalCount?: number;
    }>(`/assessment-cases/${caseId}/attempts/${attemptId}/submit`, {}),

  reopenAttempt: (caseId: string, attemptId: string) =>
    apiClient.post<{ id: string; submittedAt: string | null }>(
      `/assessment-cases/${caseId}/attempts/${attemptId}/reopen`,
      {},
    ),

  checkQuestion: (caseId: string, attemptId: string, fieldId: string, value: SubmissionValue) =>
    apiClient.post<{ correct: boolean; hint?: string | null }>(
      `/assessment-cases/${caseId}/attempts/${attemptId}/check-question`,
      { fieldId, value },
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

/**
   * The completed assessment as a filled copy of the ORIGINAL PDF.
   *
   * A blob rather than JSON: the server overlays the case's answers onto the
   * source document and streams the bytes back, because the artefact an auditor
   * reads has to be the form the candidate actually sat, not a rendering of our
   * own devising.
   *
   * Every way this can fail is a distinct condition the caller has to explain —
   * see `caseExportProblem`. A generic "export failed" would leave a training
   * officer with no idea whether to place geometry, pass a part, or call someone.
   */
  exportCasePdf: (caseId: string) =>
    apiClient.postForBlob(`/assessment-cases/${caseId}/export`),

  recordOutcome: ({ caseId, attemptId, ...body }: RecordOutcomeInput) =>
    apiClient.post<{
      id: string;
      outcome: PartOutcome;
      caseState: string;
      parts: { key: string; state: PartState }[];
    }>(`/assessment-cases/${caseId}/attempts/${attemptId}/outcome`, body),

  /**
   * The assessor's final approval. `granted` names the competencies this put on
   * the register; `warnings` carries anything that did not stop the sign-off —
   * an assessor missing a competency of their own, or a grant that could not be
   * made. The date is server-stamped and is not sent.
   */
  signOffCase: ({ caseId, ...body }: { caseId: string; assessorName: string; signature: string }) =>
    apiClient.post<{
      state: AssessmentCaseState;
      signedOffAt: string;
      signedOffName: string;
      granted?: string[];
      warnings?: string[];
      alreadySignedOff?: boolean;
    }>(`/assessment-cases/${caseId}/sign-off`, body),
};
