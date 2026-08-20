/**
 * Multi-part assessment vocabulary — the shape of an assessment tool, the
 * pathways a candidate can take through it, and the outcomes each part can
 * reach.
 *
 * Two ideas carry this module.
 *
 * 1. PARTS ARE DECLARED, NOT INFERRED. A printed assessment paper is one
 *    template holding every part in sequence. Rather than tagging each field
 *    with a part, the tool declares the field each part BEGINS AT, and a part
 *    runs from there to the next part's start. Importing an 18-page paper
 *    needs one authoring pass instead of a field-level migration.
 *
 *    The anchor is any field, not a `section_header`. Extraction emits the
 *    fields a person fills in; a printed heading is not one, so a
 *    header-anchored model could not describe a real import at all.
 *
 * 2. PATHWAY MEMBERSHIP LIVES ON THE PART. Which parts a pathway requires is
 *    declared per part rather than computed from part numbers. Hardcoding
 *    "experienced means parts 1 and 2" would be true of one document and wrong
 *    of the next; declaring it keeps the model general across every assessment
 *    tool of this shape.
 *
 * Nothing here decides which part is currently OPEN — that is case state, and
 * it is deliberately not field visibility. See the plan's layered-gating
 * decision.
 */

import type { FormField, FormFieldType } from './form-field.js';
import { geometrySegments } from './geometry.js';
import type { RepeatingRowValue, SubmissionValue } from './submission.js';
import { visibleFields, type VisibilityAnswers } from './visibility.js';
import type { AssessmentWorkflow } from './workflow.js';

/**
 * The routes through an assessment tool.
 *
 * `rpl` (Recognition of Prior Learning) is a real third pathway, not a variant
 * of `experienced`: both may require the same parts, but an RPL case records a
 * justification for waiving the logged-hours parts and an experienced case does
 * not, so collapsing them would lose the reason the hours were skipped.
 */
export const ASSESSMENT_PATHWAYS = ['experienced', 'new', 'rpl'] as const;
export type AssessmentPathway = (typeof ASSESSMENT_PATHWAYS)[number];

/**
 * The pathway a candidate's competency history suggests, to prefill the new-case
 * form: `experienced` when they already hold — or have held — any competency this
 * tool awards, `new` otherwise. An experienced candidate has operated the plant
 * before, so the shorter path fits; a first-timer takes the full assessment.
 *
 * Never `rpl`: recognition of prior learning waives the logged-hours parts and
 * carries a justification, so it is a deliberate assessor decision that history
 * alone cannot make. And only a SUGGESTION — the assessor sees it and overrides
 * when they know better, which is the whole point of leaving the box editable.
 *
 * Pass the candidate's held competency ids as they come from `/held/:userId`,
 * which already excludes revoked grants; an expired-but-not-revoked ticket still
 * counts as experience, because they did operate the machine.
 */
export function pathwayFromHistory(
  awardedCompetencyIds: readonly string[],
  heldCompetencyIds: Iterable<string>,
): AssessmentPathway {
  const held = heldCompetencyIds instanceof Set ? heldCompetencyIds : new Set(heldCompetencyIds);
  return awardedCompetencyIds.some((id) => held.has(id)) ? 'experienced' : 'new';
}

/**
 * What kind of evidence a part gathers. Drives which surface fills it and how
 * it completes — a logbook accumulates over weeks against an hours minimum, a
 * practical is marked in one sitting, theory is auto-marked.
 *
 * `declaration` is the one that is NOT an assessment: "I was told what this
 * involves and I am ready" is an attestation, not evidence anyone judges.
 * It completes the moment the candidate hands it in with every required box
 * filled — no answer keys, no assessor verdict — and it still GATES: a
 * pathway that requires it cannot reach sign-off unsigned, which is the whole
 * reason it is a part rather than furniture.
 */
export const PART_KINDS = ['theory', 'practical', 'logbook', 'declaration'] as const;
export type PartKind = (typeof PART_KINDS)[number];

/**
 * How a theory part's questions are PRESENTED to a candidate.
 *
 * Lives here rather than with the builder's own setup answers because it
 * outlives the draft: the fill surface reads it off the published tool, long
 * after the builder session that chose it is gone. A tool that names none is
 * resolved by `theoryRenderingOf` below — never by a local fallback.
 */
export const THEORY_RENDERINGS = ['one_per_screen', 'stacked'] as const;
export type TheoryRendering = (typeof THEORY_RENDERINGS)[number];

/**
 * How a tool that names no rendering presents its theory.
 *
 * `one_per_screen`, and this reverses the previous answer. Two defaults
 * disagreed: the builder's setup answers have always started at
 * `one_per_screen`, while a stored manifest naming nothing resolved to
 * `stacked` — "what every theory part has always rendered as". So an author
 * who never touched the toggle chose paged and shipped stacked, and the only
 * way to get the product's own default was to toggle it off and on again.
 *
 * `stacked` remains authorable and is now the value worth STORING, since it is
 * the one that differs from the default.
 */
export const DEFAULT_THEORY_RENDERING: TheoryRendering = 'one_per_screen';

/**
 * A tool's theory rendering, resolved.
 *
 * One rule, because the API serves this to the fill surface and the builder
 * previews it: two `?? 'stacked'` fallbacks in different files is how a
 * candidate's screen and an author's preview come to disagree about the same
 * assessment.
 */
export function theoryRenderingOf(
  manifest: Pick<AssessmentToolManifest, 'theoryRendering'>,
): TheoryRendering {
  return manifest.theoryRendering ?? DEFAULT_THEORY_RENDERING;
}

/**
 * When a candidate may retry a theory part they got wrong.
 *
 *  - `off` — one attempt; a wrong answer is final and a failed quiz does not
 *    offer another go (the assessor reopens it if they choose to).
 *  - `immediate` — one question per screen only: a wrong answer shows "Try
 *    again" on the spot, and the candidate cannot move on until it is right.
 *  - `end` — no per-question retry; a failed quiz offers a fresh attempt at the
 *    whole thing from the results screen.
 */
export const THEORY_RETRY_MODES = ['off', 'immediate', 'end'] as const;
export type TheoryRetryMode = (typeof THEORY_RETRY_MODES)[number];

/**
 * A tool's theory-retry mode, resolved — one rule the API and the builder both
 * read, so a candidate's screen never disagrees with the author's preview.
 *
 * Honours the legacy boolean `theoryAllowRetry` for tools authored before the
 * mode existed: `true` was the on-the-spot retry (`immediate`), and `false` was
 * the state that still offered a whole-quiz re-attempt on failure (`end`) — so
 * neither existing tool changes behaviour. A tool naming a `theoryRetry`
 * outright uses it.
 */
export function theoryRetryOf(
  manifest: Pick<AssessmentToolManifest, 'theoryRetry' | 'theoryAllowRetry'>,
): TheoryRetryMode {
  return manifest.theoryRetry ?? (manifest.theoryAllowRetry ? 'immediate' : 'end');
}

/** The two outcomes the printed paper offers. There is no third. */
export const PART_OUTCOMES = ['satisfactory', 'not_satisfactory'] as const;
export type PartOutcome = (typeof PART_OUTCOMES)[number];

/**
 * What an assessor decides after a not-satisfactory outcome. The system records
 * the decision and its reason; it never makes the decision.
 */
export const NS_DISPOSITIONS = [
  'retry',
  'coaching_then_retry',
  'change_pathway',
  'not_yet_competent',
] as const;
export type NotSatisfactoryDisposition = (typeof NS_DISPOSITIONS)[number];

/**
 * Case-level state.
 *
 * `competent` and `closed` are both terminal; they are distinct because a
 * closed case reached no competence and an auditor must be able to tell those
 * apart at a glance.
 *
 * `awaiting_sign_off` sits between: every required part has passed, but the
 * assessor has not yet approved. It is NOT terminal — the assessment is not
 * finished until a person says so, and the printed record carries their name,
 * signature and date. Deriving this from the attempt rows instead would leave
 * the product unable to answer "what is waiting on me", which is the one
 * question an assessor opens it to ask.
 */
export const CASE_STATES = [
  'open',
  'awaiting_sign_off',
  'competent',
  'closed',
  /*
    Abandoned because the candidate was deactivated, and retained as history
    along with anything already signed on it. Distinct from `closed` because a
    closed case reads as one that finished, and a returner begins that
    assessment as a NEW case rather than resuming this one.
  */
  'invalidated',
] as const;
export type AssessmentCaseState = (typeof CASE_STATES)[number];

/**
 * States in which the case is finished and `closedAt` means something.
 *
 * Exists because the single state writer used to stamp `closedAt` on anything
 * that was not `open` — a ternary that silently dates a live case the moment a
 * fourth, non-terminal state exists. Ask this instead of comparing to 'open'.
 *
 * `invalidated` belongs here even though it is not an outcome anyone wanted: the
 * candidate has left, nobody will work it again, and `closedAt` dates the
 * abandonment. What distinguishes it from `closed` is its own state value, NOT
 * its terminality — and treating it as in-flight would have every sweep over
 * live work pick it up, re-creating assessments for somebody who is gone.
 */
export const TERMINAL_CASE_STATES: readonly AssessmentCaseState[] = [
  'competent',
  'closed',
  'invalidated',
];

export function isTerminalCaseState(state: AssessmentCaseState): boolean {
  return TERMINAL_CASE_STATES.includes(state);
}

/**
 * What a profile can prefill onto a form, named from the CANDIDATE's side.
 *
 * A closed list rather than free profile paths, because each key is a promise
 * the API keeps: every consumer (attempt open, case export) must know how to
 * resolve it, and an author must never be able to map a field to an attribute
 * nothing supplies — that is a box that silently prints blank.
 */
export const PROFILE_PREFILL_KEYS = [
  'candidate_name',
  'company_name',
  'swipe_card',
  'employee_number',
] as const;
export type ProfilePrefillKey = (typeof PROFILE_PREFILL_KEYS)[number];

export const PROFILE_PREFILL_LABELS: Record<ProfilePrefillKey, string> = {
  candidate_name: "Candidate's name",
  company_name: 'Company name',
  swipe_card: 'Swipe card number',
  employee_number: 'Employee number',
};

/** What the caller resolved from the profile, ready to map onto fields. */
export interface ProfilePrefillSource {
  candidateName?: string | null;
  companyName?: string | null;
  swipeCard?: string | null;
  employeeNumber?: string | null;
}

/**
 * The values a manifest's prefill map produces, keyed by field id.
 *
 * Blank attributes are SKIPPED rather than written as empty strings: an absent
 * value leaves the field empty on screen and on paper, which reads as "not on
 * file" — an empty string stored as an answer reads as "answered with nothing",
 * and the two must stay distinguishable on an evidence document.
 */
export function profilePrefillValues(
  manifest: Pick<AssessmentToolManifest, 'profilePrefill'>,
  source: ProfilePrefillSource,
): Record<string, string> {
  const byKey: Record<ProfilePrefillKey, string | null | undefined> = {
    candidate_name: source.candidateName,
    company_name: source.companyName,
    swipe_card: source.swipeCard,
    employee_number: source.employeeNumber,
  };
  const out: Record<string, string> = {};
  for (const [fieldId, key] of Object.entries(manifest.profilePrefill ?? {})) {
    const value = byKey[key];
    if (typeof value === 'string' && value.trim() !== '') out[fieldId] = value;
  }
  return out;
}

/**
 * Problems with a prefill map, in the validators' own voice.
 *
 * Shared by `validateManifest` and the tool PATCH route, so the map an editor
 * can save and the map a manifest can carry are the same set — two validators
 * is how a workflow save starts refusing a manifest publish accepted.
 */
export function validateProfilePrefill(
  map: Record<string, string> | undefined,
  fields: readonly FormField[],
): string[] {
  const problems: string[] = [];
  const byId = new Map(fields.map((f) => [f.id, f]));
  for (const [fieldId, key] of Object.entries(map ?? {})) {
    if (!(PROFILE_PREFILL_KEYS as readonly string[]).includes(key)) {
      problems.push(`Prefill for field "${fieldId}" names unknown profile attribute "${key}".`);
      continue;
    }
    const field = byId.get(fieldId);
    if (!field) {
      problems.push(`Prefill names field "${fieldId}", which is not in this version.`);
      continue;
    }
    /*
      TEXT ONLY. The values these keys resolve to are strings, and the export
      draws them as text. Mapped onto a check_cross or a signature the value
      would misprint or vanish — and a signature box that "prefills" is a
      person's attestation typed by a machine, which is not a bug class to
      leave open.
    */
    if (field.type !== 'text') {
      problems.push(
        `Prefill maps "${field.label}" (${field.type}), but only a text field can carry a profile value.`,
      );
    }
  }
  return problems;
}

/**
 * A printed prerequisite tied to the candidate's COMPETENCY REGISTER.
 *
 * "Q50001782 Drivers Licence C or higher" is a claim about the candidate, not
 * a question for them — the register already knows the answer, because a
 * licence is a competency with a class and an expiry (R33). Mapping the
 * printed box to the competency is what lets the system answer it: the box
 * fills itself from the register, nobody types it, and the check re-runs on
 * every read so a licence that expires mid-programme shows expired.
 *
 * DELIBERATELY NON-BLOCKING DURING THE ASSESSMENT. An unsatisfied prerequisite
 * must not stop a candidate sitting theory — practice is that the paperwork
 * catches up — but it MUST stop the sign-off: certifying somebody whose
 * prerequisite lapsed is exactly the certificate an auditor pulls. Soft
 * warning on the way through, hard gate at `competent`.
 */
export interface PrerequisiteCheck {
  /** The printed ✓/✗ box the verdict lands in. */
  fieldId: string;
  /** The competency whose currency answers it. */
  competencyId: string;
}

/**
 * One printed checklist row that ticks when its part completes — see
 * `partCompletionMarks` on the manifest.
 *
 * Addressed by POSITION (a fixed-row index) rather than a row key, because
 * fixed-row identity is positional everywhere: the fill surface seeds row i
 * from `fixedRows[i]`, and the exporter maps value rows to printed bands the
 * same way.
 *
 * Several marks may name the SAME row — one entry per part — and the row then
 * ticks when every named part that applies to the case has passed; see
 * `completionTickRows`.
 */
export interface PartCompletionMark {
  /** The part whose SATISFACTORY final state ticks the row. */
  partKey: string;
  /** The printed checklist — a fixed-row repeating table. */
  fieldId: string;
  /** Which printed row, as an index into the field's `fixedRows`. */
  rowIndex: number;
  /** The column the tick lands in. */
  columnKey: string;
}

/**
 * The checklist rows a case's progress has earned, merged over what is stored.
 *
 * `marks` are the entries for ONE field. The result is POSITIONAL — row i is
 * printed row i — with gaps filled by empty rows so a tick at row 5 cannot
 * slide up through a hole at row 2 when the exporter consumes rows in order.
 * Only SATISFACTORY parts write, and they write `true` into their own cell:
 * a failed or unstarted part leaves its row exactly as stored, because
 * un-ticked means "not completed", never "failed".
 *
 * SEVERAL MARKS MAY SHARE ONE ROW, and then the row ticks when EVERY mapped
 * part THAT APPLIES TO THIS CASE has passed. The case that forced the rule:
 * the Track Dozer's "Theory" method row covers three theory parts — General
 * plus one of two location-specific papers — so "any passed" ticks after
 * General alone, and "all passed" never ticks because no candidate sits both
 * locations' papers. `applicablePartKeys` is the case's own required set
 * (pathway ∩ location rule, see `casePartKeys`); a mapped part outside it
 * simply does not count. Omitted means every mapped part applies, which is
 * exact for single-mark rows and for tools with no location rule. A row none
 * of whose mapped parts apply stays untouched — it is not this case's row to
 * tick.
 */
export function completionTickRows(
  marks: readonly PartCompletionMark[],
  progress: readonly PartProgress[],
  existing?: SubmissionValue,
  applicablePartKeys?: ReadonlySet<string>,
): RepeatingRowValue[] {
  const rows: RepeatingRowValue[] = Array.isArray(existing)
    ? (existing as RepeatingRowValue[]).map((r) =>
        r && typeof r === 'object' && !Array.isArray(r) ? { ...r } : {},
      )
    : [];

  const satisfied = new Set(
    progress.filter((p) => p.state === 'satisfactory').map((p) => p.part.key),
  );

  const byRow = new Map<number, PartCompletionMark[]>();
  for (const mark of marks) {
    const group = byRow.get(mark.rowIndex);
    if (group) group.push(mark);
    else byRow.set(mark.rowIndex, [mark]);
  }

  for (const [rowIndex, group] of byRow) {
    const applicable = applicablePartKeys
      ? group.filter((m) => applicablePartKeys.has(m.partKey))
      : group;
    if (applicable.length === 0) continue;
    if (!applicable.every((m) => satisfied.has(m.partKey))) continue;
    while (rows.length <= rowIndex) rows.push({});
    for (const mark of applicable) rows[rowIndex]![mark.columnKey] = true;
  }

  return rows;
}

/**
 * The part keys THIS CASE actually requires: the pathway's parts, narrowed by
 * the tool's per-Location rule when the case names a Location.
 *
 * The one derivation `completionTickRows` needs to judge a multi-part row,
 * kept here so its answer can never drift from the planning engine's — both
 * sides read `resolveLocationParts`, whose absence rule (an unlisted Location
 * requires everything) errs toward the longer assessment.
 */
export function casePartKeys(
  manifest: AssessmentToolManifest,
  pathway: AssessmentPathway,
  locationPartKeys: LocationPartKeys | undefined,
  locationId: string | null | undefined,
): Set<string> {
  const pathwayKeys = requiredParts(manifest, pathway).map((p) => p.key);
  return new Set(
    resolveLocationParts(pathwayKeys, locationPartKeys ?? {}, locationId ? [locationId] : []),
  );
}

/** Problems with completion-mark mappings — shared by publish and validation. */
export function validatePartCompletionMarks(
  marks: readonly PartCompletionMark[] | undefined,
  manifest: Pick<AssessmentToolManifest, 'parts'>,
  fields: readonly FormField[],
): string[] {
  const problems: string[] = [];
  const partKeys = new Set(manifest.parts.map((p) => p.key));
  const byId = new Map(fields.map((f) => [f.id, f]));

  for (const mark of marks ?? []) {
    if (!partKeys.has(mark.partKey)) {
      problems.push(`Completion mark names part "${mark.partKey}", which this tool has no part for.`);
      continue;
    }
    const field = byId.get(mark.fieldId);
    if (!field) {
      problems.push(`Completion mark names field "${mark.fieldId}", which is not in this version.`);
      continue;
    }
    if (field.type !== 'repeating_group') {
      problems.push(
        `Completion mark for part "${mark.partKey}" targets "${mark.fieldId}", a ${field.type} — only a fixed-row table has rows to tick.`,
      );
      continue;
    }
    const rowCount = field.fixedRows?.length ?? 0;
    if (!Number.isInteger(mark.rowIndex) || mark.rowIndex < 0 || mark.rowIndex >= rowCount) {
      problems.push(
        `Completion mark for part "${mark.partKey}" names row ${mark.rowIndex}, but "${mark.fieldId}" prints ${rowCount} row${rowCount === 1 ? '' : 's'}.`,
      );
    }
    if (!(field.columns ?? []).some((c) => c.key === mark.columnKey)) {
      problems.push(
        `Completion mark for part "${mark.partKey}" names column "${mark.columnKey}", which "${mark.fieldId}" does not have.`,
      );
    }
  }

  return problems;
}

/**
 * One declared mark's destination, checked the same way everywhere: the field
 * must exist, and a cell address must name a real column of a real table.
 * `what` prefixes each problem so the caller's context survives into the
 * message ("The 'new' pathway box names field …").
 */
function declaredMarkProblems(
  mark: DeclaredMark,
  what: string,
  byId: ReadonlyMap<string, FormField>,
): string[] {
  const field = byId.get(mark.fieldId);
  if (!field) return [`${what} names field "${mark.fieldId}", which is not in this version.`];
  if (mark.columnKey !== undefined) {
    if (field.type !== 'repeating_group') {
      return [`${what} addresses a cell of "${mark.fieldId}", a ${field.type} — only a table has cells.`];
    }
    if (!(field.columns ?? []).some((c) => c.key === mark.columnKey)) {
      return [`${what} names column "${mark.columnKey}", which "${mark.fieldId}" does not have.`];
    }
  }
  return [];
}

/** Problems with the pathway → printed-box mapping — shared by publish and the tool PATCH. */
export function validatePathwayMarks(
  marks: AssessmentToolManifest['pathwayMarks'],
  fields: readonly FormField[],
): string[] {
  const problems: string[] = [];
  const byId = new Map(fields.map((f) => [f.id, f]));
  for (const [pathway, mark] of Object.entries(marks ?? {})) {
    if (!mark) continue;
    problems.push(...declaredMarkProblems(mark, `The "${pathway}" pathway box`, byId));
  }
  return problems;
}

/**
 * Problems with the sign-off block's destinations — used by the tool PATCH,
 * where an editor actively points these at fields and a ghost id is a bug in
 * the picker rather than history. (Publish-time manifests may carry pointers
 * from older versions; there the exporter's silent skip remains the contract.)
 */
export function validateSignOffMarks(
  signOff: AssessmentToolManifest['signOff'],
  fields: readonly FormField[],
): string[] {
  if (!signOff) return [];
  const problems: string[] = [];
  const byId = new Map(fields.map((f) => [f.id, f]));
  const pointers: Array<[string | undefined, string]> = [
    [signOff.assessorNameFieldId, 'The sign-off assessor-name box'],
    [signOff.assessorSignatureFieldId, 'The sign-off signature box'],
    [signOff.signedDateFieldId, 'The sign-off date box'],
  ];
  for (const [id, what] of pointers) {
    if (id && !byId.has(id)) problems.push(`${what} names field "${id}", which is not in this version.`);
  }
  const marks: Array<[DeclaredMark | undefined, string]> = [
    [signOff.overallSatisfactory, 'The "Candidate Competent" box'],
    [signOff.overallNotSatisfactory, 'The "not yet Competent" box'],
    [signOff.moreCoachingRequiredYes, 'The "more coaching — Yes" box'],
    [signOff.moreCoachingRequiredNo, 'The "more coaching — No" box'],
  ];
  for (const [mark, what] of marks) {
    if (mark) problems.push(...declaredMarkProblems(mark, what, byId));
  }
  return problems;
}

/** Problems with prerequisite mappings — shared by publish and the tool PATCH. */
export function validatePrerequisiteChecks(
  checks: readonly PrerequisiteCheck[] | undefined,
  fields: readonly FormField[],
): string[] {
  const problems: string[] = [];
  const byId = new Map(fields.map((f) => [f.id, f]));
  const seen = new Set<string>();
  for (const check of checks ?? []) {
    const field = byId.get(check.fieldId);
    if (!field) {
      problems.push(`Prerequisite names field "${check.fieldId}", which is not in this version.`);
      continue;
    }
    if (field.type !== 'check_cross' && field.type !== 'boolean_yes_no') {
      problems.push(
        `Prerequisite maps "${field.label}" (${field.type}), but the verdict needs a ✓/✗ or yes/no box to land in.`,
      );
    }
    if (seen.has(check.fieldId)) {
      problems.push(`Field "${field.label}" carries two prerequisite checks; one box answers one claim.`);
    }
    seen.add(check.fieldId);
    if (!check.competencyId) {
      problems.push(`Prerequisite on "${field.label}" names no competency.`);
    }
  }
  return problems;
}

/** One part of an assessment tool. */
export interface AssessmentPart {
  /** Stable key, referenced by attempts. Survives relabelling. */
  key: string;
  /** 1-based printed part number; defines document order. */
  ordinal: number;
  label: string;
  kind: PartKind;
  /** Pathways that require this part. */
  pathways: AssessmentPathway[];
  /**
   * The field this part BEGINS AT, inclusive. Any field type.
   *
   * Deliberately not restricted to `section_header`. Extraction emits the
   * fields a person fills in, and a printed heading is not one — requiring a
   * header anchor made a real 18-page import unanchorable, with none of its
   * nine part boundaries resolvable. A part now runs from this field to the
   * next part's start field, which needs no furniture in the document.
   */
  startFieldId: string;
  /**
   * Logbook parts only — the target amount, in the part's {@link durationUnit}.
   * Named `minimumHours` for history; it holds minutes when the part's unit is
   * minutes. Compared as a plain number against the logged Duration total, so
   * the unit is a label, not a conversion.
   */
  minimumHours?: number;
  /**
   * Logbook parts only — the unit the minimums and the logged Duration column
   * are read in. Omitted means `hours`, which every existing tool uses and which
   * keeps prior behaviour exactly. `minutes` changes only how the numbers are
   * LABELLED and entered: the engine compares the logged Duration total to the
   * minimums as plain numbers, so a part whose rows and minimums are both in
   * minutes gates and progresses identically — only "hrs"/"min" differs. It is
   * per part because one paper mixes them: the Scraper logs five task types in
   * hours and its General Items coached exercises at ~15 minutes apiece.
   */
  durationUnit?: 'hours' | 'minutes';
  /**
   * Logbook parts only — the column of the part's table that carries each
   * entry's hours. Declared rather than assumed: an imported PDF may extract
   * that column under any key, and totalling a column that does not exist
   * silently reports zero hours against a safety threshold. Validation
   * verifies the column really exists in the part's table at authoring time.
   *
   * When the template gives this column a `machine_hours` calc, the cell is
   * derived from start/finish meter readings and the filler cannot type an
   * arbitrary total; a tool without meter readings simply omits the calc and
   * the column is entered directly. That is the declared-per-tool flexibility.
   */
  durationColumnKey?: string;
  /**
   * Logbook parts only — per-task-type hour minimums WITHIN the one table.
   *
   * The multi-stage logbook (the Scraper's Part 5): one printed checklist, a
   * task-type dropdown column, and a minimum number of hours per task type on
   * top of the part's overall `minimumHours`. The candidate logs against any
   * task in any order — exposure to a task type is driven by operations, not a
   * training sequence — so this NEVER gates progression. It is a target the
   * fill surface shows the candidate, the assessor reads before signing, and
   * the save route notifies on, exactly as the overall minimum already is: a
   * soft target, not a lock.
   */
  taskMinimums?: {
    /** The table column whose value names the task type — a dropdown column. */
    columnKey: string;
    /** Minimum hours required for each task-type value. */
    targets: Array<{ value: string; minimumHours: number }>;
  };
  /**
   * Logbook parts only — where each task type's rows PRINT on the evidence PDF.
   *
   * The multi-stage logbook fills ONE table (the source, carrying the task-type
   * column), but the paper prints a separate grid per task type. At export the
   * source's rows are partitioned by task value and written into the print-only
   * table field each task maps to — so the renderer, which draws every field
   * against its own geometry, needs no notion of tasks at all, and the export
   * path stays untouched. A task whose rows exceed its printed grid's row count
   * prints what fits; the hours still count, and the full record lives in the
   * system.
   */
  logbookRouting?: {
    /** The filled source table — the one carrying the task-type column. */
    sourceFieldId: string;
    /** That table's task-type column. */
    columnKey: string;
    /** Each task value → the print-only table field its rows render into. */
    routes: Array<{ value: string; fieldId: string }>;
  };
  /**
   * The page-one assessment-method entry this part ticks once it passes.
   *
   * Replaces the bare `checklistFieldId`, which named a field but not what to
   * write into it — and a bare id cannot address a cell of a table, which is
   * how the method list is usually printed. It had no reader, no writer and no
   * validator, and no stored manifest ever carried one, so reshaping it now is
   * free.
   */
  checklistMark?: DeclaredMark;
  /** This part's own printed "assessor name" box, if it prints one. */
  assessorNameFieldId?: string;
  /** This part's own printed date box, if it prints one. */
  signedDateFieldId?: string;
  /**
   * Theory parts only — the questions that must ALL be answered correctly for
   * the part to reach satisfactory.
   *
   * Listed explicitly rather than derived from a section, for the same reason
   * `startFieldId` was relaxed: a document may carry no section boundary to
   * derive them from. Questions outside this list are still marked and
   * reported; they simply do not gate the outcome. Absent or empty means the
   * part has no must-pass-entirely set.
   */
  mandatoryFieldIds?: string[];

  /**
   * This part's own printed verdict pair — "The Candidate's responses were:
   * ☐ Satisfactory  ☐ Not Satisfactory".
   *
   * WRITTEN FROM THE MARKING, NOT BY THE ASSESSOR. On a fully-keyed theory part
   * the verdict is arithmetic: every mandatory question correct is satisfactory
   * and anything less is not. An assessor ticking that box by hand is
   * transcribing a sum the machine already did, thirty questions at a time, and
   * a transcription is a place to be wrong.
   *
   * TWO MARKS RATHER THAN ONE BOOLEAN, for the same reason the coaching pair is
   * two: both answers are positive statements printed as their own box, and
   * encoding "not satisfactory" as the absence of a tick makes it
   * indistinguishable from a part nobody marked.
   */
  outcomeSatisfactory?: DeclaredMark;
  outcomeNotSatisfactory?: DeclaredMark;

  /**
   * Where "Detail further action" is written when this part is NOT
   * satisfactory — the questions the candidate got wrong.
   *
   * A field id rather than a `DeclaredMark`, because the value is derived from
   * the marking rather than declared: which questions were missed is not
   * knowable when the tool is authored.
   *
   * Nothing is written on a satisfactory part. An empty box beside a passed
   * assessment is correct; "None" would be a sentence nobody wrote.
   */
  furtherActionFieldId?: string;
}

/**
 * A mark the export writes on the case's behalf, and the exact value it writes.
 *
 * THE VALUE IS CARRIED, NEVER INFERRED. A `check_cross` field renders `false`
 * as a CROSS, which this document's convention means "I checked this and it
 * failed" — so "more coaching required: No" cannot be encoded as `false` on the
 * No box. It is a tick on the No box, i.e. the literal `true`. Any scheme that
 * derives a mark from a boolean gets this backwards on at least one field, and
 * on a competency record that reads as a finding nobody made.
 *
 * `rowKey`/`columnKey` address a cell of a repeating group, because a printed
 * method checklist is usually a table rather than a column of loose boxes.
 */
export interface DeclaredMark {
  fieldId: string;
  /** Repeating-group targets only: which row. */
  rowKey?: string;
  /** Repeating-group targets only: which column. */
  columnKey?: string;
  /** Written verbatim into the export's value map. */
  value: SubmissionValue;
}

/** The part structure of one assessment tool, against one template. */
export interface AssessmentToolManifest {
  parts: AssessmentPart[];
  /**
   * Field whose answer selects the location stream, e.g. Mining vs Raw
   * Materials. Named here so the export can seed it from the case rather than
   * trusting whatever a filler typed: the stream decided which sections
   * applied during the assessment, so it must decide which sections render on
   * the evidence document too. Absent on a tool with no location-specific
   * content.
   */
  locationStreamFieldId?: string;
  /**
   * The cover page's candidate-name box.
   *
   * Seeded from the CASE at export. It belongs to no part, so nobody can type
   * into it through the fill surface — without this the evidence document
   * certifies a verdict for an unnamed person.
   */
  candidateNameFieldId?: string;

  /**
   * The cover page's candidate-signature box.
   *
   * Extraction folds printed signature boxes into TEXT inputs, so the stored
   * type is often `text`. The fill surface overrides it to `signature` when
   * this pointer is set, so the candidate draws rather than types.
   */
  candidateSignatureFieldId?: string;

  /**
   * Fields filled FROM THE CANDIDATE'S PROFILE, by field id.
   *
   * `candidateNameFieldId`, generalised. That pointer seeds one box from the
   * case; this seeds any text field from the profile the case names — name,
   * company, swipe card, employee number — so "Candidate Details" fills itself
   * when a case opens and nobody types identity data that the database already
   * holds.
   *
   * A mapped field is unwritable by every role: `derivedWorkflow` marks it
   * `prefill`, `canWrite` refuses non-`entry` fields, and the attempt route
   * drops mapped ids from `writableFieldIds` even under an authored workflow.
   * A typed value over a derived fact, on the identity line of a competency
   * record, is exactly the edit nobody should be able to make.
   */
  profilePrefill?: Record<string, ProfilePrefillKey>;

  /**
   * Printed prerequisites answered from the competency register — see
   * `PrerequisiteCheck`. Evaluated on read, gated at sign-off, never typed.
   */
  prerequisiteChecks?: PrerequisiteCheck[];

  /**
   * Printed checklist rows ticked as parts COMPLETE — the live record of what
   * a candidate has finished, derived on every read and never stored.
   *
   * "Assessment Methods used" prints one row per part, and the paper practice
   * is that the assessor ticks a row when that part of the training is done.
   * Mapping each part to its printed row makes the document keep itself: the
   * moment a part's final outcome is SATISFACTORY, its row ticks on the fill
   * surface and the export — computed from the attempt rows exactly like part
   * state itself, so it can never disagree with the progress it reports.
   *
   * A part that is failed, in progress, or not in this case's pathway leaves
   * its row untouched: un-ticked means "not completed", never "failed", and
   * writing false would print a finding nobody made.
   */
  partCompletionMarks?: PartCompletionMark[];

  /**
   * Tool-declared DEFAULT answers, by field id — applied wherever no answer
   * exists yet, and only there.
   *
   * What "Assessment Methods" needs: a theory-only tool always uses
   * Written/Verbal Questions, so the author presets that row ticked and the
   * assessor adjusts it if the day differed. Unlike `profilePrefill` this is a
   * DEFAULT, not a derived fact — the field stays writable, a stored answer
   * always wins over it, and it never overwrites anything.
   */
  fieldDefaults?: Record<string, SubmissionValue>;
  /**
   * Who does what, and in what order — see `workflow.ts`.
   *
   * Optional, and absent on every tool authored before it existed. A tool
   * without one behaves exactly as it always has: `workflowOf` synthesises a
   * section per part in document order, so nothing changes until somebody
   * configures it.
   */
  workflow?: AssessmentWorkflow;
  /**
   * How a theory part's questions are presented — see `THEORY_RENDERINGS`.
   *
   * Absent means `stacked`, which is what every theory part rendered as before
   * this existed, so no stored tool changes meaning by gaining the property.
   */
  theoryRendering?: TheoryRendering;
  /**
   * The percentage of questions that must be correct for a theory part to be
   * satisfactory, when the author chose `overall_percentage` as the pass rule.
   *
   * 100 = every question correct (the default). 80 = 80% required, etc.
   * Absent means mandatory-all-correct, which is the pre-existing rule and
   * what every tool authored before this existed still uses.
   */
  theoryPassPercent?: number;
  /**
   * @deprecated Superseded by `theoryRetry`; still read by `theoryRetryOf` for
   * tools authored before the mode existed. `true` meant on-the-spot retry.
   *
   * Whether a candidate may retry individual questions after seeing feedback
   * in interactive theory mode.
   */
  theoryAllowRetry?: boolean;
  /**
   * When a candidate may retry a theory part they got wrong — off, on the spot
   * (`immediate`), or a whole-quiz re-attempt at the end (`end`). Resolved by
   * `theoryRetryOf`, which falls back to the legacy `theoryAllowRetry`. Absent
   * on tools authored before the mode existed.
   */
  theoryRetry?: TheoryRetryMode;
  /**
   * The front page's certification block.
   *
   * Manifest-level, not part-level, because the front page belongs to no part:
   * `fieldsInPart` slices from a part's anchor onward, and the first anchor is
   * the "PART 1" heading — so cover-page fields fall in no part's range at all.
   *
   * Every entry is optional and nothing is inferred from a missing one. A tool
   * naming none of these exports its front page exactly as it does today:
   * blank.
   */
  signOff?: {
    /** Printed "Name of Assessor" box. Written from the sign-off, not an attempt. */
    assessorNameFieldId?: string;
    /** Printed signature box. Any field that can carry one — extraction folds
     *  signatures into TEXT inputs, so this is rarely typed `signature`. */
    assessorSignatureFieldId?: string;
    /** Printed date box. Server-stamped at sign-off; never client-supplied. */
    signedDateFieldId?: string;
    /** The overall "satisfactory" mark, written when the case reaches competent. */
    overallSatisfactory?: DeclaredMark;
    /**
     * The "Candidate not yet Competent" box — the negative half of the printed
     * Assessment Result pair.
     *
     * A DIFFERENT GATE FROM ITS PARTNER, deliberately. `overallSatisfactory` is
     * the certification and prints only once an assessor has SIGNED: a
     * competency claim on a record nobody signed is the one thing this export
     * must never manufacture. "Not yet competent" certifies nothing — it is the
     * absence of a claim — so it prints as soon as the case is RESOLVED and not
     * competent, which is the state a failed case actually ends in, often with
     * no sign-off ever taking place.
     *
     * Without this the pair was half-written: a passed case ticked Competent
     * and a failed one ticked nothing, so the two outcomes were told apart only
     * by a box that was empty either way until somebody signed.
     */
    overallNotSatisfactory?: DeclaredMark;
    /**
     * The "more coaching required" pair. Exactly one is written on a RESOLVED
     * case, chosen from the parts' FINAL outcomes — a part that failed once and
     * passed on retry counts as satisfactory.
     *
     * Two separate marks rather than one boolean, because both answers are
     * positive statements on the page and the printed form prints two boxes.
     * Encoding "no coaching needed" as the absence of a tick would make it
     * indistinguishable from a form nobody finished.
     */
    moreCoachingRequiredYes?: DeclaredMark;
    moreCoachingRequiredNo?: DeclaredMark;
  };
  /**
   * The printed pathway tick — "New and inexperienced candidates" /
   * "Experienced candidates or Re-assessments" — written from the CASE.
   *
   * The pathway is decided when the case is created (suggested from the
   * candidate's competency history, adjustable by the assessor) and it is what
   * chose which parts the candidate sat. The printed box saying so is
   * therefore a case fact, not an answer: seeded at export exactly like the
   * location stream, so the ticked pathway can never disagree with the parts
   * the document actually shows filled.
   *
   * Keyed by pathway so two pathways may share one printed box (RPL papers
   * often tick the experienced line). A pathway with no entry prints nothing,
   * which is the exporter's safe failure everywhere.
   */
  pathwayMarks?: Partial<Record<AssessmentPathway, DeclaredMark>>;
}

/**
 * The fields belonging to one part — from its start field, inclusive, up to
 * the next part's start field.
 *
 * Ranges are computed from the manifest's own ordering rather than from
 * document furniture, so a part is well defined even in a template with no
 * section headers at all. A part whose start field is missing from the version
 * yields nothing rather than the remainder of the document: a stale anchor
 * must produce an empty part, never silently swallow every field after it.
 */
/**
 * Every field the MANIFEST declares as a destination for a derived mark.
 *
 * THE FIELDS MARKING WRITES ARE NOT FIELDS MARKING READS, and conflating the
 * two broke self-marking on every part that declares its own verdict.
 *
 * "The Candidate's responses were: ☐ Satisfactory ☐ Not Satisfactory" is
 * printed at the end of a part, so it falls inside that part's slice. It
 * carries no answer key, because nobody keys it — `markTheory` WRITES it from
 * the arithmetic. But `isSelfMarking` asks whether every question in the slice
 * is keyed, saw an unkeyed field, and concluded a person had to judge the
 * part. The result: declare the verdict pair the workflow needs and the tool
 * silently stops marking itself.
 *
 * Same for "Detail further action", written on a not-satisfactory part, and
 * for the cover's sign-off boxes when they fall inside a slice.
 *
 * DECLARATIONS ONLY — nothing is inferred from a field's type or a part's
 * kind. A part declaring none of this returns an empty set and behaves exactly
 * as it did. The per-question `outcomeTarget` cells are NOT here: they are
 * read off the fields rather than the manifest, and each caller already has
 * the field list to do it.
 */
export function partMarkFieldIds(
  part?: Pick<
    AssessmentPart,
    'outcomeSatisfactory' | 'outcomeNotSatisfactory' | 'furtherActionFieldId' | 'checklistMark'
  >,
): Set<string> {
  const out = new Set<string>();
  const add = (id: string | undefined) => {
    if (id) out.add(id);
  };
  add(part?.outcomeSatisfactory?.fieldId);
  add(part?.outcomeNotSatisfactory?.fieldId);
  add(part?.checklistMark?.fieldId);
  add(part?.furtherActionFieldId);
  return out;
}

/**
 * The cover's sign-off boxes, which the EXPORT writes from the case's state.
 *
 * Separate from the part's own because the two are scoped differently: a
 * part's verdict belongs to that part, while the front page belongs to no part
 * at all. `derivedWorkflow` attaches these to the first section only — the one
 * that reliably exists — and locking them in every section instead would be a
 * different claim about a document that prints them once.
 */
export function signOffMarkFieldIds(manifest: AssessmentToolManifest): Set<string> {
  const out = new Set<string>();
  const add = (id: string | undefined) => {
    if (id) out.add(id);
  };
  const signOff = manifest.signOff;
  add(signOff?.overallSatisfactory?.fieldId);
  add(signOff?.overallNotSatisfactory?.fieldId);
  add(signOff?.moreCoachingRequiredYes?.fieldId);
  add(signOff?.moreCoachingRequiredNo?.fieldId);
  return out;
}

export function fieldsInPart(
  fields: readonly FormField[],
  manifest: AssessmentToolManifest,
  partKey: string,
): FormField[] {
  const ordered = orderedParts(manifest);
  const index = ordered.findIndex((p) => p.key === partKey);
  if (index < 0) return [];

  const start = fields.findIndex((f) => f.id === ordered[index]!.startFieldId);
  if (start < 0) return [];

  // The next part whose anchor actually resolves bounds this one. Skipping
  // unresolvable anchors stops one broken part from truncating its neighbour.
  let end = fields.length;
  for (let i = index + 1; i < ordered.length; i++) {
    const at = fields.findIndex((f) => f.id === ordered[i]!.startFieldId);
    if (at > start) {
      end = at;
      break;
    }
  }

  return fields.slice(start, end);
}

/**
 * Parts in document order. Authoring order is not guaranteed — a manifest built
 * by hand or edited later can list parts in any sequence, and every consumer
 * (fill, export, progress) needs the printed order rather than the stored one.
 */
export function orderedParts(manifest: AssessmentToolManifest): AssessmentPart[] {
  return [...manifest.parts].sort((a, b) => a.ordinal - b.ordinal);
}

/** The parts a pathway requires, in document order. */
export function requiredParts(
  manifest: AssessmentToolManifest,
  pathway: AssessmentPathway,
): AssessmentPart[] {
  return orderedParts(manifest).filter((p) => p.pathways.includes(pathway));
}

/**
 * A tool's parts rule (U9): Location id → the part keys required at that
 * Location. Keyed by id, not name, so a Location rename cannot silently detach a
 * rule from the site it governs.
 */
export type LocationPartKeys = Readonly<Record<string, readonly string[]>>;

/**
 * The part keys required for a person placed at `locationIds`, given a tool's
 * parts rule (R74, R75, R80, R81).
 *
 * A Location the rule LISTS requires exactly its listed keys; a Location the
 * rule does not mention requires every part `allPartKeys` names — whether no
 * rule was ever configured or the Location postdates the tool (R75). The answer
 * is the union across every Location held, returned in `allPartKeys` order, so a
 * person at several sites is assessed ONCE against the combined set rather than
 * once per site (R80, R81).
 *
 * The absence rule is the safe direction: the worst outcome of a missing entry
 * is a longer assessment, never a skipped part. A person with no Location at all
 * narrows nothing and is therefore required every part, on the same reasoning.
 * A listed key the manifest no longer declares is dropped rather than surfaced.
 */
export function resolveLocationParts(
  allPartKeys: readonly string[],
  rule: LocationPartKeys,
  locationIds: readonly string[],
): string[] {
  const all = [...allPartKeys];
  if (locationIds.length === 0) return all;

  const required = new Set<string>();
  for (const locationId of locationIds) {
    const listed = rule[locationId];
    if (listed === undefined) {
      // No rule at this Location — every part applies (R75), which is already
      // the whole set, so nothing the other Locations add can widen it.
      return all;
    }
    for (const key of listed) required.add(key);
  }
  // Document order, and only keys the manifest still declares.
  return all.filter((key) => required.has(key));
}

/**
 * The fields belonging to the section anchored by `headerFieldId` — from the
 * anchor up to the next `section_header`.
 *
 * THE ANCHOR IS INCLUDED WHEN IT IS A REAL FIELD, EXCLUDED WHEN IT IS THE
 * SECTION'S HEADING. A part anchors on its `section_header` where the section
 * has one, and on its FIRST FILLABLE FIELD where it does not — a section an
 * author built by grouping has no printed heading to point at. Slicing
 * unconditionally from after the anchor was correct only for the header case:
 * on a header-less logbook section the anchor IS the table, so skipping it left
 * the table out of its own section — the column picker then offered a
 * neighbour's fields and the validator reported the declared duration column
 * "is not a column of its table". Keeping a non-header anchor puts the section's
 * own first field back where it belongs.
 *
 * This mirrors the header-to-next-header rule `visibility.ts` applies to section
 * scope. It lives here too because part membership and mandatory-section
 * membership are structural questions asked outside visibility evaluation, and
 * an unknown anchor returns nothing rather than the whole form: a manifest
 * pointing at a field that no longer exists must yield an empty section, never
 * silently claim every field in the document.
 */
export function fieldsInSection(
  fields: readonly FormField[],
  headerFieldId: string,
): FormField[] {
  const start = fields.findIndex((f) => f.id === headerFieldId);
  if (start < 0) return [];

  const anchorIsHeader = fields[start]!.type === 'section_header';
  const out: FormField[] = [];
  for (let i = anchorIsHeader ? start + 1 : start; i < fields.length; i++) {
    const field = fields[i]!;
    // The anchor never terminates its own section; only a LATER header does.
    if (i !== start && field.type === 'section_header') break;
    out.push(field);
  }
  return out;
}

/**
 * Problems that make a manifest unusable, as human-readable strings. Empty
 * means valid.
 *
 * Returning a LIST rather than throwing on the first problem is deliberate:
 * authoring a manifest for an 18-page paper is error-prone, and surfacing every
 * problem at once beats a fix-one-rerun loop.
 */
export function validateManifest(
  manifest: AssessmentToolManifest,
  fields: readonly FormField[],
): string[] {
  const problems: string[] = [];
  const parts = manifest.parts;

  if (parts.length === 0) {
    problems.push('Manifest declares no parts.');
    return problems;
  }

  const seenKeys = new Set<string>();
  const seenOrdinals = new Set<number>();
  const byFieldId = new Map(fields.map((f) => [f.id, f]));
  const fieldIds = new Set(byFieldId.keys());

  for (const part of parts) {
    if (seenKeys.has(part.key)) problems.push(`Duplicate part key "${part.key}".`);
    seenKeys.add(part.key);

    if (seenOrdinals.has(part.ordinal)) {
      problems.push(`Duplicate ordinal ${part.ordinal} (part "${part.key}").`);
    }
    seenOrdinals.add(part.ordinal);

    if (part.pathways.length === 0) {
      problems.push(`Part "${part.key}" belongs to no pathway.`);
    }

    // A start field that isn't in the version means the manifest was authored
    // against a different template version. Exporting that would silently drop
    // the part's values, so it is a hard problem rather than a warning. The
    // field may be of ANY type — see `startFieldId`.
    if (!fieldIds.has(part.startFieldId)) {
      problems.push(
        `Part "${part.key}" starts at field "${part.startFieldId}", which is not in this version.`,
      );
    }

    for (const id of part.mandatoryFieldIds ?? []) {
      if (!fieldIds.has(id)) {
        problems.push(`Part "${part.key}" names mandatory field "${id}", which is not in this version.`);
        continue;
      }

      /*
        A MUST-PASS QUESTION THAT CANNOT BE MARKED IS A LIE.

        `markTheory` skips any field without an `answerKey` — and
        `validateAnswerKeys` only inspects fields that HAVE one, so an unkeyed
        question passed every check while contributing nothing. Listing it here
        says it gates the part's outcome; the marking code never looks at it.
        The part could reach 100% with the question never assessed, and nothing
        anywhere said so.

        That is exactly what the theory paper's matching questions do today:
        extracted as free-response text, sitting in the must-pass section,
        silently unmarked.

        A hard problem rather than a warning, because both fixes are cheap and
        the status quo is not: give the question an answer key (see
        `buildMatchingQuestion` for the matching shape), or take it out of the
        mandatory set. An unmarked question genuinely does not gate the outcome
        — removing it makes the manifest say what the code does.
      */
      const field = byFieldId.get(id);
      if (field && (!field.answerKey || field.answerKey.length === 0)) {
        problems.push(
          `Part "${part.key}" makes field "${id}" mandatory, but it has no answer key, so marking ` +
            'skips it and it cannot gate the outcome. Give it an answer key or drop it from ' +
            'mandatoryFieldIds.',
        );
      }
    }

    if (part.kind === 'logbook') {
      // Resolved once: both the duration column and the per-task targets check
      // against the part's own table.
      const table = fieldsInSection(fields, part.startFieldId).find(
        (f) => f.type === 'repeating_group',
      );

      if (!(part.minimumHours && part.minimumHours > 0)) {
        problems.push(`Logbook part "${part.key}" has no positive minimumHours.`);
      }
      if (!part.durationColumnKey) {
        problems.push(`Logbook part "${part.key}" declares no durationColumnKey.`);
      } else if (!table) {
        // The declared column must exist in the part's own table. Totalling a
        // column that is not there silently reports zero hours against a
        // safety threshold, so the mismatch is an authoring error — caught
        // here, where an author can fix it.
        problems.push(`Logbook part "${part.key}" has no repeating table in its section.`);
      } else if (table.columns && !table.columns.some((c) => c.key === part.durationColumnKey)) {
        problems.push(
          `Logbook part "${part.key}" names duration column "${part.durationColumnKey}", which is not a column of its table.`,
        );
      }

      /*
        Per-task-type hour targets. Every pointer validated where an author can
        still fix it: a target on a column that is not there, or a task value
        the dropdown never offers, would silently never accrue and never be met
        — the hours would land nowhere and the target read as unreachable on a
        candidate who did the work.
      */
      if (part.taskMinimums) {
        const tm = part.taskMinimums;
        const col = table?.columns?.find((c) => c.key === tm.columnKey);
        if (table?.columns && !col) {
          problems.push(
            `Logbook part "${part.key}" names task column "${tm.columnKey}", which is not a column of its table.`,
          );
        }
        if (col && (col.options?.length ?? 0) === 0) {
          problems.push(
            `Logbook part "${part.key}" task column "${tm.columnKey}" has no options for a filler to choose from.`,
          );
        }
        if (tm.targets.length === 0) {
          problems.push(`Logbook part "${part.key}" declares task minimums with no targets.`);
        }
        const seen = new Set<string>();
        for (const t of tm.targets) {
          if (!(t.minimumHours > 0)) {
            problems.push(`Logbook part "${part.key}" task "${t.value}" has no positive minimumHours.`);
          }
          if (seen.has(t.value)) {
            problems.push(`Logbook part "${part.key}" lists task target "${t.value}" more than once.`);
          }
          seen.add(t.value);
          if (col?.options && col.options.length > 0 && !col.options.includes(t.value)) {
            problems.push(
              `Logbook part "${part.key}" task target "${t.value}" is not one of task column "${tm.columnKey}" options.`,
            );
          }
        }
      }

      /*
        Row routing to the printed task grids. Every pointer checked here, at
        authoring time: a route to a field that is not a table, or to the same
        table as another task, would silently drop or overwrite a task's rows on
        the evidence document — and a route onto the source itself would replace
        the candidate's own logbook with one task's slice of it.
      */
      if (part.logbookRouting) {
        const r = part.logbookRouting;
        const source = byFieldId.get(r.sourceFieldId);
        if (!source || source.type !== 'repeating_group') {
          problems.push(
            `Logbook part "${part.key}" routing source "${r.sourceFieldId}" is not a table in this version.`,
          );
        }
        const col = source?.columns?.find((c) => c.key === r.columnKey);
        if (source?.columns && !col) {
          problems.push(
            `Logbook part "${part.key}" routing column "${r.columnKey}" is not a column of its source table.`,
          );
        }
        if (col && (col.options?.length ?? 0) === 0) {
          problems.push(
            `Logbook part "${part.key}" routing column "${r.columnKey}" has no options to route on.`,
          );
        }
        if (r.routes.length === 0) {
          problems.push(`Logbook part "${part.key}" declares routing with no routes.`);
        }
        const seenValues = new Set<string>();
        const seenTargets = new Set<string>();
        for (const route of r.routes) {
          if (col?.options && col.options.length > 0 && !col.options.includes(route.value)) {
            problems.push(
              `Logbook part "${part.key}" routes task "${route.value}", which is not an option of column "${r.columnKey}".`,
            );
          }
          if (seenValues.has(route.value)) {
            problems.push(`Logbook part "${part.key}" routes task "${route.value}" more than once.`);
          }
          seenValues.add(route.value);

          const target = byFieldId.get(route.fieldId);
          if (!target || target.type !== 'repeating_group') {
            problems.push(
              `Logbook part "${part.key}" routes task "${route.value}" to "${route.fieldId}", which is not a table in this version.`,
            );
          }
          if (route.fieldId === r.sourceFieldId) {
            problems.push(
              `Logbook part "${part.key}" routes task "${route.value}" onto its own source table, which would overwrite the candidate's log.`,
            );
          }
          if (seenTargets.has(route.fieldId)) {
            problems.push(
              `Logbook part "${part.key}" routes two tasks to the same table "${route.fieldId}" — their rows would overwrite each other.`,
            );
          }
          seenTargets.add(route.fieldId);
        }
      }
    }

    /*
      EVERY POINTER GETS A RULE, IN THE SAME COMMIT THAT ADDS IT.

      `checklistFieldId` shipped as a type and a zod line with no reader, no
      writer and no validator, and nobody noticed for weeks — because an
      unvalidated pointer that resolves to nothing simply draws nothing. On a
      competency record that silence is indistinguishable from a part nobody
      assessed, so a pointer has to be checked at authoring time, where an
      author can still fix it, rather than discovered at export.
    */
    for (const [what, id] of [
      ['assessorNameFieldId', part.assessorNameFieldId],
      ['signedDateFieldId', part.signedDateFieldId],
      ['checklistMark', part.checklistMark?.fieldId],
      ['outcomeSatisfactory', part.outcomeSatisfactory?.fieldId],
      ['outcomeNotSatisfactory', part.outcomeNotSatisfactory?.fieldId],
      ['furtherActionFieldId', part.furtherActionFieldId],
    ] as const) {
      if (id && !fieldIds.has(id)) {
        problems.push(`Part "${part.key}" names ${what} "${id}", which is not in this version.`);
      }
    }
  }

  /*
    No two parts may claim the same printed box. `assembleCaseValues` merges
    parts in order with Object.assign, so on a collision the last part silently
    wins and one part's assessor or date is overwritten by another's, with
    nothing to notice it.
  */
  const claimed = new Map<string, string>();
  const claim = (id: string | undefined, by: string) => {
    if (!id) return;
    const prior = claimed.get(id);
    if (prior) problems.push(`Field "${id}" is claimed by both ${prior} and ${by}.`);
    else claimed.set(id, by);
  };

  /**
   * Claim a satisfactory / not-satisfactory pair, allowing the two halves to
   * share one printed cell.
   *
   * Sharing is legitimate and common — a single ✓/✗ box says both things — and
   * safe, because exactly one half is ever written. The failure it CAN hide is
   * the two halves carrying the same value, which prints a pass and a fail
   * identically: an auditor reading the record could not tell which happened,
   * and neither could anyone re-deriving it.
   */
  const claimVerdictPair = (
    yes: DeclaredMark | undefined,
    no: DeclaredMark | undefined,
    what: string,
  ) => {
    const sameCell =
      yes && no && yes.fieldId === no.fieldId && yes.rowKey === no.rowKey && yes.columnKey === no.columnKey;
    if (sameCell) {
      if (yes.value === no.value) {
        problems.push(
          `${what} writes the same value for both outcomes, so a pass and a fail would print identically.`,
        );
      }
      claim(yes.fieldId, what);
      return;
    }
    claim(yes?.fieldId, `${what} (satisfactory)`);
    claim(no?.fieldId, `${what} (not satisfactory)`);
  };
  for (const part of parts) {
    claim(part.assessorNameFieldId, `part "${part.key}" assessorNameFieldId`);
    claim(part.signedDateFieldId, `part "${part.key}" signedDateFieldId`);
    claim(part.checklistMark?.fieldId, `part "${part.key}" checklistMark`);
    /*
      The verdict pair is claimed as ONE unit, and that is not a shortcut.

      Two printed shapes are both real. A form may print two boxes — "☐
      Satisfactory ☐ Not Satisfactory" — which is two fields and two marks. Or
      it may print ONE ✓/✗ cell whose tick means satisfactory and whose cross
      means not, which extraction reads as a single `check_cross` field and
      which both halves therefore name. Claiming each half separately would
      reject that second shape as a self-collision, refusing the exact layout
      the paper this was built for actually uses.

      Exactly one half is ever written, so sharing a field cannot clobber
      anything. What it CAN do is carry the same value twice, which would print
      a pass and a fail identically — that is checked instead.
    */
    claimVerdictPair(
      part.outcomeSatisfactory,
      part.outcomeNotSatisfactory,
      `part "${part.key}" verdict`,
    );
    claim(part.furtherActionFieldId, `part "${part.key}" furtherActionFieldId`);
  }

  /*
    A mark addressing a table CELL must carry a primitive. The exporter refuses
    a non-primitive rather than writing "[object Object]" into a competency
    record, so without this the mark would silently never appear.
  */
  const marksNamingCells: [string, DeclaredMark | undefined][] = [
    ...parts.map((p) => [`part "${p.key}" checklistMark`, p.checklistMark] as [string, DeclaredMark | undefined]),
    ...parts.flatMap((p) => [
      [`part "${p.key}" outcomeSatisfactory`, p.outcomeSatisfactory],
      [`part "${p.key}" outcomeNotSatisfactory`, p.outcomeNotSatisfactory],
    ] as [string, DeclaredMark | undefined][]),
    ['signOff.overallSatisfactory', manifest.signOff?.overallSatisfactory],
    ['signOff.overallNotSatisfactory', manifest.signOff?.overallNotSatisfactory],
    ['signOff.moreCoachingRequiredYes', manifest.signOff?.moreCoachingRequiredYes],
    ['signOff.moreCoachingRequiredNo', manifest.signOff?.moreCoachingRequiredNo],
  ];
  for (const [what, mark] of marksNamingCells) {
    if (!mark?.rowKey || !mark.columnKey) continue;
    if (mark.value !== null && typeof mark.value === 'object') {
      problems.push(`${what} addresses a table cell but its value is not a primitive.`);
    }
  }

  const signOff = manifest.signOff;
  if (signOff) {
    claim(signOff.assessorNameFieldId, 'signOff.assessorNameFieldId');
    claim(signOff.signedDateFieldId, 'signOff.signedDateFieldId');
    claim(signOff.assessorSignatureFieldId, 'signOff.assessorSignatureFieldId');

    for (const [what, id] of [
      ['signOff.assessorNameFieldId', signOff.assessorNameFieldId],
      ['signOff.signedDateFieldId', signOff.signedDateFieldId],
      ['signOff.assessorSignatureFieldId', signOff.assessorSignatureFieldId],
      ['signOff.overallSatisfactory', signOff.overallSatisfactory?.fieldId],
      ['signOff.overallNotSatisfactory', signOff.overallNotSatisfactory?.fieldId],
      ['signOff.moreCoachingRequiredYes', signOff.moreCoachingRequiredYes?.fieldId],
      ['signOff.moreCoachingRequiredNo', signOff.moreCoachingRequiredNo?.fieldId],
    ] as const) {
      if (id && !fieldIds.has(id)) {
        problems.push(`Manifest names ${what} "${id}", which is not in this version.`);
      }
    }

    /*
      THIS USED TO DEMAND type === 'signature', and that was unsatisfiable.

      Extraction never emits a `signature` field — buttons, signatures and
      unknown surfaces are all classified as text inputs (extract.ts). So no
      imported document could satisfy the rule, and naming the box an author
      could actually see was rejected.

      The original reasoning — that a text field would route the PNG down the
      scalar path, where the renderer refuses it — was true when written and is
      no longer. The renderer's signature branch keys on the VALUE being a
      `data:` URL rather than on the field's type, precisely because extraction
      folds signatures into text.

      What must still be refused is a field that structurally cannot hold one. A
      choice field, a table, an outcome cell or a heading named here would drop
      the signature or draw something else in its place, and on a certificate
      that is worse than an empty box.
    */
    const SIGNABLE: readonly FormFieldType[] = ['signature', 'text', 'textarea'];
    const sig = fields.find((f) => f.id === signOff.assessorSignatureFieldId);
    if (sig && !SIGNABLE.includes(sig.type)) {
      problems.push(
        `signOff.assessorSignatureFieldId "${sig.id}" is a ${sig.type}, which cannot carry a signature.`,
      );
    }

    // Both coaching boxes or neither. One alone cannot express the answer it is
    // missing, so half a pair prints an unanswerable front page.
    if (!!signOff.moreCoachingRequiredYes !== !!signOff.moreCoachingRequiredNo) {
      problems.push(
        'signOff declares only one of moreCoachingRequiredYes / moreCoachingRequiredNo — the front page prints both boxes.',
      );
    }
  }

  /*
    Retrofit: `locationStreamFieldId` had no check at all. Same class of
    pointer, and this whole exercise exists because an unvalidated one draws
    nothing and reports nothing. This may surface a latent break on an existing
    tool, which is the point.
  */
  problems.push(...validateProfilePrefill(manifest.profilePrefill, fields));
  problems.push(...validatePrerequisiteChecks(manifest.prerequisiteChecks, fields));
  problems.push(...validatePartCompletionMarks(manifest.partCompletionMarks, manifest, fields));
  problems.push(...validatePathwayMarks(manifest.pathwayMarks, fields));
  for (const id of Object.keys(manifest.fieldDefaults ?? {})) {
    if (!fieldIds.has(id)) {
      problems.push(`Default answer names field "${id}", which is not in this version.`);
    }
  }

  if (manifest.candidateNameFieldId && !fieldIds.has(manifest.candidateNameFieldId)) {
    problems.push(
      `Manifest names candidateNameFieldId "${manifest.candidateNameFieldId}", which is not in this version.`,
    );
  }

  if (manifest.candidateSignatureFieldId && !fieldIds.has(manifest.candidateSignatureFieldId)) {
    problems.push(
      `Manifest names candidateSignatureFieldId "${manifest.candidateSignatureFieldId}", which is not in this version.`,
    );
  }

  if (manifest.locationStreamFieldId && !fieldIds.has(manifest.locationStreamFieldId)) {
    problems.push(
      `Manifest names locationStreamFieldId "${manifest.locationStreamFieldId}", which is not in this version.`,
    );
  }

  return problems;
}

/**
 * Where a part stands. Derived from its attempts — never stored, because a
 * stored copy is a second source of truth that can disagree with the rows it
 * summarises.
 */
export type PartState = 'locked' | 'open' | 'satisfactory' | 'not_satisfactory';

/** The attempt facts progress is computed from. */
export interface AttemptFact {
  partKey: string;
  attemptNumber: number;
  /** Null while the attempt is still open. */
  outcome: PartOutcome | null;
}

export interface PartProgress {
  part: AssessmentPart;
  state: PartState;
  /** How many attempts have been made at this part. */
  attempts: number;
  /** Outcome of the highest-numbered attempt, or null if none is resolved. */
  latestOutcome: PartOutcome | null;
}

/** Attempts for one part, highest attempt number first. */
function attemptsForPart(attempts: readonly AttemptFact[], partKey: string): AttemptFact[] {
  return attempts
    .filter((a) => a.partKey === partKey)
    .sort((a, b) => b.attemptNumber - a.attemptNumber);
}

/**
 * Every part the pathway requires, with its derived state, in document order.
 *
 * Parts unlock in sequence: a part is `open` only once every EARLIER required
 * part has a satisfactory attempt. That is what stops a candidate sitting the
 * final demonstration before logging the hours it depends on. A part that has
 * ever passed stays `satisfactory` regardless of later attempts, because the
 * evidence document renders the passing attempt and the audit trail keeps the
 * rest.
 *
 * AN AUTHORED WORKFLOW CAN SAY OTHERWISE. When the covering section declares
 * `requires`, those dependencies REPLACE the document-order rule for that part:
 * it is locked until each named section's part has passed, and nothing else
 * locks it. An empty list means "opens straight away". A section declaring
 * nothing keeps the sequential rule, so every tool authored before this
 * existed behaves exactly as it always has. Process order and printed order
 * are different facts on purpose — a declaration prints on the cover page and
 * is signed after the theory it vouches for.
 *
 * A dependency that cannot bite is waived rather than deadlocked: a required
 * section with no part, or whose part this pathway does not include (RPL
 * waives the logbooks), never blocks anything.
 */
export function caseProgress(
  manifest: AssessmentToolManifest,
  pathway: AssessmentPathway,
  attempts: readonly AttemptFact[],
): PartProgress[] {
  const required = requiredParts(manifest, pathway);

  // Pass/fail per part first: dependencies may point FORWARD in document
  // order (the cover-page declaration depending on the theory printed after
  // it), so lock states cannot be decided in one sequential sweep.
  const passedByKey = new Map<string, boolean>();
  for (const part of required) {
    passedByKey.set(
      part.key,
      attemptsForPart(attempts, part.key).some((a) => a.outcome === 'satisfactory'),
    );
  }

  // Only the AUTHORED workflow is consulted — a derived one declares nothing.
  const sections = manifest.workflow?.sections ?? [];
  const partKeyBySection = new Map(
    sections.filter((s) => s.partKey).map((s) => [s.key, s.partKey!] as const),
  );
  const dependencySatisfied = (sectionKey: string): boolean => {
    const partKey = partKeyBySection.get(sectionKey);
    if (!partKey || !passedByKey.has(partKey)) return true;
    return passedByKey.get(partKey)!;
  };

  const out: PartProgress[] = [];
  let earlierAllSatisfied = true;

  for (const part of required) {
    const mine = attemptsForPart(attempts, part.key);
    const passed = passedByKey.get(part.key)!;
    const latestOutcome = mine.find((a) => a.outcome !== null)?.outcome ?? null;

    const declared = sections.find((s) => s.partKey === part.key)?.requires;
    const blocked = declared === undefined
      ? !earlierAllSatisfied
      : !declared.every(dependencySatisfied);

    let state: PartState;
    if (passed) {
      state = 'satisfactory';
    } else if (blocked) {
      state = 'locked';
    } else {
      state = latestOutcome === 'not_satisfactory' ? 'not_satisfactory' : 'open';
    }

    out.push({ part, state, attempts: mine.length, latestOutcome });
    if (!passed) earlierAllSatisfied = false;
  }

  return out;
}

/** A case is competent only when every required part has passed. */
export function isCaseCompetent(progress: readonly PartProgress[]): boolean {
  return progress.length > 0 && progress.every((p) => p.state === 'satisfactory');
}

/**
 * Whether the front page's "more coaching required" answer is Yes.
 *
 * Reads each part's FINAL state, not its history: a part failed once and passed
 * on the retry counts as satisfactory, because coaching happened and worked and
 * the record's job is to state where the candidate ended up. (Deliberate call by
 * the training authority; the attempt history still holds every failure for
 * anyone who needs the journey.)
 *
 * Returns null when NOTHING should be ticked — a case still in progress. A part
 * nobody has attempted is not a coaching finding, it is an unfinished form, and
 * ticking either box there would assert a conclusion nobody reached. Only a
 * resolved case gets a mark, which is also the only way the Yes box is ever
 * reachable: sign-off requires every part satisfactory, so a signed case is
 * always No.
 */
export function moreCoachingRequired(progress: readonly PartProgress[]): boolean | null {
  if (progress.length === 0) return null;
  if (progress.some((p) => p.latestOutcome === 'not_satisfactory')) return true;
  if (progress.every((p) => p.state === 'satisfactory')) return false;
  return null;
}

/**
 * What comes after the part just finished, from the point of view of whoever
 * finished it — the "continue, or wait for someone else" step.
 *
 * Whether a part is the viewer's to fill is decided by workflow access
 * (`partFieldAccess`), the same authority the open-attempt route enforces, so
 * this only ever OFFERS a step the server would then allow. A part carries two
 * booleans: whether the candidate may fill it, and whether any staff role
 * (assessor / supervisor / SME) may — computed by the caller so this stays a
 * pure decision.
 */
export interface NextStepPart {
  key: string;
  label: string;
  state: PartState;
  /** The candidate has `fill` access to a field in this part. */
  candidateFills: boolean;
  /** A staff role (assessor / supervisor / SME) has `fill` access to one. */
  staffFills: boolean;
}

export type CaseNextStep =
  /** The viewer can start the next part themselves. */
  | { kind: 'continue'; partKey: string; label: string }
  /** The next part belongs to someone else (or is not yet unlocked). */
  | { kind: 'awaiting_other'; label: string; filledBy: string }
  /** Nothing left for the viewer — every later part is already satisfactory. */
  | { kind: 'done' };

/**
 * The next step after `currentKey` for the party that just completed it.
 *
 * The next part is the first one AFTER the current in document order that is not
 * yet satisfactory — the next thing anyone has to do. A `locked` next part (its
 * dependencies unmet) is never offered as "continue"; it reads as waiting on the
 * other party, because from here that is what unblocks it. `viewerIsCandidate`
 * rather than a role, so this needs no `WorkflowRole` import and cannot go stale
 * against the role list.
 */
export function nextStepAfter(
  parts: readonly NextStepPart[],
  currentKey: string,
  viewerIsCandidate: boolean,
): CaseNextStep {
  const index = parts.findIndex((p) => p.key === currentKey);
  const next = (index === -1 ? [] : parts.slice(index + 1)).find((p) => p.state !== 'satisfactory');
  if (!next) return { kind: 'done' };

  const viewerFills = viewerIsCandidate ? next.candidateFills : next.staffFills;
  if (viewerFills && next.state !== 'locked') {
    return { kind: 'continue', partKey: next.key, label: next.label };
  }
  return {
    kind: 'awaiting_other',
    label: next.label,
    filledBy: viewerIsCandidate ? 'your assessor' : 'the candidate',
  };
}

/**
 * WHICH rows a logbook part's hours are counted from — the one rule, shared.
 *
 * There were three, and they disagreed. The threshold notification counted the
 * rows under the part's declared table; the progress dashboard counted every
 * array on the attempt; the retry carry-forward had its own copy of the lookup.
 * Two readers of the same attempt could therefore report different totals with
 * no retry involved at all — and an auditor comparing the dashboard against the
 * audit trail would find a contradiction with nothing to explain it.
 *
 * The rule is the part's DECLARED table: the repeating group inside the part's
 * own section. That is what the manifest says the hours come from, so it is what
 * counts.
 *
 * The fallback exists because saved values are not validated against the part —
 * the save route stores whatever keys the client sends, and real data already
 * carries logbook rows under keys the manifest never named. Ignoring those would
 * silently zero a candidate's hours, which is worse than reading them from an
 * unexpected key. It is narrowed to arrays OF OBJECTS: a checkbox group's
 * answers are an array of strings, and the threshold's old fallback would have
 * happily counted one as a logbook.
 */
export function logbookRows(
  fields: readonly FormField[],
  part: Pick<AssessmentPart, 'startFieldId' | 'durationColumnKey'>,
  values: Record<string, SubmissionValue> | null | undefined,
): RepeatingRowValue[] {
  const all = values ?? {};
  const isRowList = (v: unknown): v is RepeatingRowValue[] =>
    Array.isArray(v) && v.length > 0 && v.every((r) => typeof r === 'object' && r !== null);

  const table = fieldsInSection(fields, part.startFieldId).find((f) => f.type === 'repeating_group');
  const declared = table ? all[table.id] : undefined;
  if (isRowList(declared)) return declared;

  // The fallback also requires the DURATION COLUMN. A row list that does not
  // carry the column this part totals is not this part's log — most obviously
  // another part's table, which an attempt should never hold but nothing
  // enforces. Without this the fallback would count someone else's hours.
  const key = part.durationColumnKey;
  if (!key) return [];
  return Object.values(all).find((v) => isRowList(v) && key in (v[0] ?? {})) as
    | RepeatingRowValue[]
    | undefined ?? [];
}

/**
 * EVERY logged row a logbook part totals its hours from — across ALL of the
 * part's tables, not just the first.
 *
 * `logbookRows` answers "the part's DECLARED table": one table, because the
 * retry carry-forward re-keys each table on its own and must not merge them.
 * The HOURS total is a different question. A part can hold more than one
 * repeating table — Part 5's supervised and minimal-supervision logs both
 * accrue against the same minimum — and the total is the sum over every one of
 * them. Reading only the first table under-reports a candidate's experience,
 * which for a figure measured against a safety threshold is the wrong error
 * direction.
 *
 * Value-based on purpose. An attempt's values hold only its own part's fields —
 * the save route writes nothing else — so "every row list carrying this
 * column" is exactly this part's logs, and it needs neither the field list nor
 * the manifest. That is what lets the client progress meter and the server
 * threshold compute the identical figure, and what lets it span tables the
 * section-scoped `logbookRows` never reaches when each table sits in its own
 * sub-section.
 */
export function logbookDurationRows(
  part: Pick<AssessmentPart, 'durationColumnKey'>,
  values: Record<string, SubmissionValue> | null | undefined,
): RepeatingRowValue[] {
  const key = part.durationColumnKey;
  if (!key) return [];
  const all = values ?? {};
  const isRowList = (v: unknown): v is RepeatingRowValue[] =>
    Array.isArray(v) && v.length > 0 && v.every((r) => typeof r === 'object' && r !== null);
  const out: RepeatingRowValue[] = [];
  for (const v of Object.values(all)) {
    // A row list is one of this part's logs if ANY of its rows carries the
    // duration column — not merely the first. A logbook filled a shift at a
    // time often leads with a blank row left ready for the next entry, and a
    // table whose duration is typed rather than calculated has no cell there
    // until someone fills one; keying off the first row alone would drop the
    // whole table's hours in both cases.
    if (isRowList(v) && v.some((r) => key in r)) out.push(...v);
  }
  return out;
}

/** A logbook part's duration unit, defaulting the omitted case to hours. */
export type DurationUnit = 'hours' | 'minutes';

/** Short unit label for a logged/target figure — "hrs" or "min". */
export function durationUnitShort(unit: DurationUnit | undefined): string {
  return unit === 'minutes' ? 'min' : 'hrs';
}

/** Long unit label, for prose like "Minimum 15 minutes". */
export function durationUnitLong(unit: DurationUnit | undefined): string {
  return unit === 'minutes' ? 'minutes' : 'hours';
}

/**
 * Convert a duration figure between units, rounded to 2dp to keep float noise
 * out of authored minimums (0.1h → 6min, 15min → 0.25h). Same unit is a no-op.
 * Used when an author flips a part's unit so the meaning is preserved rather
 * than the digits — the minimums and the logged column share one unit, so both
 * move together.
 */
export function convertDurationValue(value: number, from: DurationUnit, to: DurationUnit): number {
  if (from === to || !Number.isFinite(value)) return value;
  const raw = to === 'minutes' ? value * 60 : value / 60;
  return Math.round(raw * 100) / 100;
}

/**
 * Hours logged in a logbook part, summed from a duration column.
 *
 * "Hours" by name and by the default unit; a minutes part sums minutes the same
 * way — the figure is in the part's own unit, compared to a minimum in that
 * same unit. Non-numeric cells contribute nothing rather than throwing: a
 * logbook is filled over weeks by someone in a cab, and one malformed row must
 * not make the whole total unreadable.
 */
export function totalLoggedHours(
  rows: readonly Record<string, unknown>[],
  durationKey: string,
): number {
  let total = 0;
  for (const row of rows) {
    const raw = row?.[durationKey];
    const value = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? ''));
    if (Number.isFinite(value) && value > 0) total += value;
  }
  return Math.round(total * 100) / 100;
}

/**
 * Logbook rows grouped by task type, each group in first-seen order.
 *
 * The partition behind BOTH per-task hours and the evidence PDF's row routing:
 * export sends each task's rows to its own printed grid, and the same grouping
 * underlies the per-task totals. A row with a blank task is left out of every
 * group — an unclassified entry belongs to no task table. Generic over the row
 * type so the caller keeps its own row shape (the exporter needs
 * `RepeatingRowValue[]` back, not `Record`s).
 */
export function rowsByTask<T extends Record<string, unknown>>(
  rows: readonly T[],
  taskColumnKey: string,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const task = row?.[taskColumnKey];
    if (typeof task !== 'string' || task.trim() === '') continue;
    const list = out.get(task);
    if (list) list.push(row);
    else out.set(task, [row]);
  }
  return out;
}

/**
 * Hours logged PER TASK TYPE — the multi-stage logbook's totals, summed from
 * the duration column and grouped by the task column.
 *
 * A row with a blank task, or a non-positive / non-numeric duration, contributes
 * nothing: the same tolerance `totalLoggedHours` has, because the same
 * cab-filled data reaches here and one malformed row must not distort a task's
 * total. Each task's running sum is rounded the same way the overall total is,
 * so per-task and overall figures reconcile.
 */
export function hoursByTask(
  rows: readonly Record<string, unknown>[],
  taskColumnKey: string,
  durationKey: string,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const task = row?.[taskColumnKey];
    if (typeof task !== 'string' || task.trim() === '') continue;
    const raw = row?.[durationKey];
    const value = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? ''));
    if (!Number.isFinite(value) || value <= 0) continue;
    totals.set(task, Math.round(((totals.get(task) ?? 0) + value) * 100) / 100);
  }
  return totals;
}

/** One task type's progress toward its logbook hour minimum. */
export interface TaskHourProgress {
  value: string;
  minimumHours: number;
  loggedHours: number;
  /** Hours logged have reached the minimum. A SOFT target — never a gate. */
  met: boolean;
}

/**
 * Per-task progress for a logbook part, in the order the targets are declared.
 *
 * The one read behind the candidate's progress chips, the assessor's pre-sign
 * readout, and the per-task "minimum reached" notice — so those three can never
 * disagree about a task's hours. A target with no matching rows still appears,
 * at zero: a task never started is exactly what the candidate and assessor most
 * need to see.
 */
export function logbookTaskProgress(
  rows: readonly Record<string, unknown>[],
  taskMinimums: NonNullable<AssessmentPart['taskMinimums']>,
  durationKey: string,
): TaskHourProgress[] {
  const totals = hoursByTask(rows, taskMinimums.columnKey, durationKey);
  return taskMinimums.targets.map((t) => {
    const loggedHours = totals.get(t.value) ?? 0;
    return { value: t.value, minimumHours: t.minimumHours, loggedHours, met: loggedHours >= t.minimumHours };
  });
}

/**
 * Problems with auto-marking configuration on a field set. Empty means valid.
 *
 * A field with neither an answer key nor an outcome target is ordinary and
 * always valid — most fields on an assessment paper are not auto-marked.
 */
export function validateAnswerKeys(fields: readonly FormField[]): string[] {
  const problems: string[] = [];
  const byId = new Map(fields.map((f) => [f.id, f]));

  for (const field of fields) {
    /*
      A MODEL ANSWER ON A CHOICE QUESTION IS AUTHOR CONFUSION, not a richer
      configuration. A question that offers options is marked by exact-set
      `answerKey`; a written question is judged by an assessor reading prose
      against `modelAnswer`. An options-bearing field carrying a model answer
      means the author reached for the wrong instrument — the guide would sit
      beside a question the machine already marks, and nobody would ever read
      it. Written questions (no options) pass with or without an
      `outcomeTarget`: the target is where the ASSESSOR'S tick lands, and a
      guide with no declared cell is still a legitimate marking aid.
    */
    if (field.modelAnswer && (field.options?.length ?? 0) > 0) {
      problems.push(
        `Field "${field.id}" has a model answer but offers options — a choice question takes an answer key, not a written marking guide.`,
      );
    }

    if (!field.answerKey) continue;

    if (field.answerKey.length === 0) {
      problems.push(`Field "${field.id}" has an empty answer key.`);
    }

    if (!field.outcomeTarget) {
      problems.push(`Field "${field.id}" has an answer key but no outcome target.`);
      continue;
    }

    if (!byId.has(field.outcomeTarget.fieldId)) {
      problems.push(
        `Field "${field.id}" targets outcome field "${field.outcomeTarget.fieldId}", which is not in this version.`,
      );
    }

    // Every keyed option must be selectable, or the question can never be
    // answered correctly — a typo in the key would otherwise fail every
    // candidate silently.
    const options = field.options ?? [];
    if (options.length > 0) {
      for (const correct of field.answerKey) {
        if (!options.includes(correct)) {
          problems.push(
            `Field "${field.id}" keys option "${correct}", which is not one of its options.`,
          );
        }
      }
    }
  }

  return problems;
}

/**
 * Every mark destination the export writes that has NO BOX to draw into.
 *
 * The exporter's rule is "silence is the safe failure": a field with no
 * geometry is skipped without an error, because a confident mark in a guessed
 * position asserts a finding nobody made. The cost of that rule is that a
 * whole class of authoring gap is invisible — the ✓/✗ column beside thirty
 * questions can compute thirty verdicts that print NOWHERE, and nothing
 * anywhere says so. The values exist, the marking ran, the document simply
 * never shows it.
 *
 * This names those silences, using the SAME resolver the exporter draws with
 * (`geometrySegments`, legacy `sourcePosition` bridge included) so the two can
 * never disagree about what "placed" means. A ghost id — a destination naming
 * a field the version lacks — is NOT reported here; that is `validateManifest`'s
 * problem and a harder one.
 *
 * WARNINGS, NEVER GATES. A tool with unplaced marks still assesses, marks and
 * certifies correctly — only the printed record is incomplete — and blocking
 * publish on it would strand an author mid-build over boxes they may be about
 * to place.
 */
export function unplacedMarkDestinations(
  manifest: AssessmentToolManifest,
  fields: readonly FormField[],
): string[] {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const out: string[] = [];
  const seen = new Set<string>();

  const short = (label: string) =>
    label.length > 48 ? `${label.slice(0, 48).trimEnd()}…` : label;

  const check = (id: string | undefined, what: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const field = byId.get(id);
    if (!field) return;
    if (geometrySegments(field).length > 0) return;
    out.push(`${what} has no box on the document — its mark computes but prints nowhere.`);
  };

  for (const field of fields) {
    if ((field.answerKey?.length ?? 0) > 0 && field.outcomeTarget) {
      check(field.outcomeTarget.fieldId, `The ✓/✗ box for "${short(field.label)}"`);
    }
  }

  for (const part of manifest.parts) {
    check(part.outcomeSatisfactory?.fieldId, `Part "${part.label}" — the Satisfactory verdict box`);
    check(
      part.outcomeNotSatisfactory?.fieldId,
      `Part "${part.label}" — the Not Satisfactory verdict box`,
    );
    check(part.furtherActionFieldId, `Part "${part.label}" — the further-action box`);
    check(part.assessorNameFieldId, `Part "${part.label}" — the assessor-name box`);
    check(part.signedDateFieldId, `Part "${part.label}" — the signed-date box`);
    check(part.checklistMark?.fieldId, `Part "${part.label}" — its checklist mark`);
  }

  const signOff = manifest.signOff;
  if (signOff) {
    check(signOff.assessorNameFieldId, 'The sign-off assessor-name box');
    check(signOff.assessorSignatureFieldId, 'The sign-off signature box');
    check(signOff.signedDateFieldId, 'The sign-off date box');
    check(signOff.overallSatisfactory?.fieldId, 'The "Candidate Competent" box');
    check(signOff.overallNotSatisfactory?.fieldId, 'The "not yet Competent" box');
    check(signOff.moreCoachingRequiredYes?.fieldId, 'The "more coaching — Yes" box');
    check(signOff.moreCoachingRequiredNo?.fieldId, 'The "more coaching — No" box');
  }

  for (const [pathway, mark] of Object.entries(manifest.pathwayMarks ?? {})) {
    check(mark?.fieldId, `The "${pathway}" pathway box`);
  }

  for (const prereq of manifest.prerequisiteChecks ?? []) {
    check(prereq.fieldId, 'A prerequisite ✓/✗ box');
  }
  for (const fieldId of Object.keys(manifest.profilePrefill ?? {})) {
    const label = byId.get(fieldId)?.label;
    check(fieldId, `The profile-prefilled box${label ? ` "${short(label)}"` : ''}`);
  }
  check(manifest.candidateNameFieldId, "The candidate's-name box");
  for (const mark of manifest.partCompletionMarks ?? []) {
    check(mark.fieldId, 'The assessment-methods checklist');
  }

  return out;
}

/**
 * The required boxes a declaration hand-in has not filled.
 *
 * A declaration completes at submit with nobody judging it, so submit is the
 * only gate there is — and "signed" has to mean the required boxes actually
 * hold something. Without this an empty tap on Submit would auto-complete the
 * attestation, and the printed record would carry a satisfied declaration
 * with a blank signature box: an attestation nobody made.
 *
 * VISIBILITY IS RESPECTED, over the full field list — a section the
 * candidate's stream hides is not theirs to sign. Structural furniture
 * (headers) can hold no value and is skipped by type.
 */
export function missingDeclarationFields(
  fields: readonly FormField[],
  manifest: AssessmentToolManifest,
  partKey: string,
  values: Record<string, SubmissionValue> | null | undefined,
): { id: string; label: string }[] {
  const answers = values ?? {};
  const visible = new Set(visibleFields(fields, answers as VisibilityAnswers).map((f) => f.id));
  const empty = (v: SubmissionValue | undefined): boolean => {
    if (v === undefined || v === null) return true;
    if (typeof v === 'string') return v.trim() === '';
    if (Array.isArray(v)) return v.length === 0;
    return false;
  };

  return fieldsInPart(fields, manifest, partKey)
    .filter(
      (f) =>
        f.required &&
        f.type !== 'section_header' &&
        visible.has(f.id) &&
        empty(answers[f.id]),
    )
    .map((f) => ({ id: f.id, label: f.label }));
}
