import {
  caseProgress,
  completionTickRows,
  isCaseCompetent,
  isSelfMarking,
  markTheory,
  moreCoachingRequired,
  requiredParts,
  validateManifest,
  type AssessmentPathway,
  type AssessmentToolManifest,
  type DeclaredMark,
  type FormField,
  type PartOutcome,
  type RepeatingRowValue,
  type SubmissionValue,
} from '@formai/shared';
import { roundTripExport } from './round-trip.js';

/**
 * Assembling one evidence document from a case's many part attempts.
 *
 * The source document is ONE template with every part printed in it, and a case
 * holds one attempt row per try at each part. Export therefore has to choose
 * which attempts speak: for each part the pathway requires, the latest attempt
 * that PASSED. A part whose attempts all failed contributes nothing and prints
 * blank, exactly as the paper form would if it were never signed off.
 *
 * That selection is the whole reason this module exists. It is deliberately
 * separate from `round-trip.ts`, which knows how to draw values onto a page and
 * nothing about assessments — it stays a pure renderer, and this stays a pure
 * chooser, so neither has to understand the other.
 *
 * FAILS LOUD, NOT BLANK. A manifest that does not match the version it is
 * exported against would silently produce a document missing whole parts, which
 * on a competency record is worse than no document at all. Every such mismatch
 * raises instead.
 */

/** A mismatch that would make the exported document misrepresent the case. */
export class CaseExportError extends Error {
  readonly problems: string[];

  constructor(message: string, problems: string[] = []) {
    super(message);
    this.name = 'CaseExportError';
    this.problems = problems;
  }
}

export interface CaseAttemptRecord {
  partKey: string;
  attemptNumber: number;
  outcome: PartOutcome | null;
  values: Record<string, SubmissionValue>;
  /** Who marked this part. Stored as a COLUMN, so it is not in `values`. */
  assessorName?: string;
  /** When this part was marked. Also a column. */
  signedAt?: Date | null;
}

/** The assessor's approval of the whole case, once they have given it. */
export interface CaseSignOff {
  at: Date;
  name: string;
  /** PNG data URL. */
  signature: string;
}

export interface AssembleCaseInput {
  manifest: AssessmentToolManifest;
  pathway: AssessmentPathway;
  /** The case's declared stream, seeded so visibility matches the assessment. */
  locationStream?: string | null;
  /**
   * Who was assessed. Seeded onto the cover page, which belongs to no part and
   * is therefore fillable by nobody — without it the document certifies a
   * verdict for an unnamed person.
   */
  candidateName?: string | null;
  /**
   * `manifest.profilePrefill`, resolved — field id to profile value. Merged
   * onto the cover exactly as `candidateName` is, so the printed identity block
   * matches what the fill surface showed. The route resolves; this only draws.
   */
  prefillValues?: Record<string, string> | null;
  /**
   * `manifest.prerequisiteChecks`, answered from the register at export time —
   * field id to the ✓ (true) or ✗ (false) the box prints.
   */
  prerequisiteValues?: Record<string, boolean> | null;
  attempts: readonly CaseAttemptRecord[];
  /**
   * Null until the assessor signs. The whole certification block is gated on
   * this, so a mid-programme export prints the front page exactly as it does
   * today: blank.
   */
  signOff?: CaseSignOff | null;
  /**
   * Whether the case is RESOLVED — competent, or closed as not yet competent.
   * The coaching pair is written only on a resolved case: an unfinished form is
   * not a coaching finding, and ticking either box early prints a conclusion
   * nobody reached.
   */
  resolved?: boolean;
}

export interface AssembledCase {
  /** One merged answer map, ready for the renderer. */
  values: Record<string, SubmissionValue>;
  /** Part keys that contributed values, in document order. */
  rendered: string[];
  /** Required part keys with no passing attempt — these print blank. */
  blank: string[];
}

/**
 * The passing attempt that speaks for a part, or undefined.
 *
 * Highest attempt number among the satisfactory ones. Ordering by attempt
 * number rather than by time is deliberate — it is the number the paper record
 * and the audit trail both cite.
 */
function authoritativeAttempt(
  attempts: readonly CaseAttemptRecord[],
  partKey: string,
): CaseAttemptRecord | undefined {
  return attempts
    .filter((a) => a.partKey === partKey && a.outcome === 'satisfactory')
    .sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
}

/**
 * Re-derive the marks a self-marked attempt should carry, filling only gaps.
 *
 * The ✓/✗ each question earned, the part's verdict pair and the further-action
 * note are all written into the attempt's stored values AT MARKING — but only
 * by the marking code that ran then. An attempt marked before that code
 * existed, or before the manifest declared its verdict boxes, stores the
 * answers alone, and the printed outcome column exports blank on exactly the
 * paper the marks were computed for.
 *
 * Re-run the same arithmetic over the same stored answers with the same
 * version's keys, and MERGE UNDER the stored values: anything marking (or a
 * person) already recorded wins, so a certified record is never rewritten —
 * only its silences are filled. Skipped entirely unless the attempt PASSED and
 * the part marks itself: a failed attempt never prints, and a judged part's
 * marks belong to the person who judged it.
 */
export function withDerivedMarks(
  attempt: CaseAttemptRecord,
  versionFields: readonly FormField[],
  manifest: AssessmentToolManifest,
): CaseAttemptRecord {
  if (attempt.outcome !== 'satisfactory') return attempt;
  const part = manifest.parts.find((p) => p.key === attempt.partKey);
  if (!part) return attempt;
  if (!isSelfMarking(versionFields, manifest, part.key)) return attempt;

  const marked = markTheory({ fields: versionFields, values: attempt.values, part });
  return { ...attempt, values: { ...marked.derivedValues, ...(attempt.values ?? {}) } };
}

/**
 * Merge the attempts that count into a single answer map.
 *
 * Parts outside the pathway are not consulted at all, so they print blank —
 * which mirrors the printed tool, where an experienced candidate's booklet
 * still contains Parts 3 to 6 with nothing written in them.
 */
/**
 * Write a declared mark into the value map.
 *
 * The value is written VERBATIM — never derived, never negated. A `check_cross`
 * renders `false` as a cross meaning "checked and failed", so a scheme that
 * inferred marks from booleans would put a failure on the page wherever the
 * answer happened to be "no".
 *
 * A repeating-group target addresses one cell, leaving the rest of the row and
 * every other row alone.
 */
function writeMark(values: Record<string, SubmissionValue>, mark: DeclaredMark | undefined): void {
  if (!mark) return;
  if (!mark.rowKey || !mark.columnKey) {
    values[mark.fieldId] = mark.value;
    return;
  }
  /*
    A table CELL holds a primitive. A manifest naming a row and column but
    carrying an array or a file reference is an authoring error — caught by
    validateManifest — and writing it anyway would put "[object Object]" in a
    cell of a competency record. Refusing leaves the cell blank, which is the
    safe failure everywhere else in this module.
  */
  const cell = mark.value;
  if (cell !== null && typeof cell === 'object') return;

  const existing = values[mark.fieldId];
  const rows: RepeatingRowValue[] = Array.isArray(existing)
    ? (existing as RepeatingRowValue[]).map((r) => ({ ...r }))
    : [];
  const row = rows.find((r) => r._key === mark.rowKey);
  if (row) {
    row[mark.columnKey] = cell;
  } else {
    rows.push({ _key: mark.rowKey, [mark.columnKey]: cell });
  }
  values[mark.fieldId] = rows;
}

/** Written as `dd/mm/yyyy`, matching how the printed forms date everything. */
function formatSignedDate(at: Date): string {
  const dd = String(at.getDate()).padStart(2, '0');
  const mm = String(at.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${at.getFullYear()}`;
}

export function assembleCaseValues({
  manifest,
  pathway,
  locationStream,
  candidateName,
  prefillValues,
  prerequisiteValues,
  attempts,
  signOff,
  resolved,
}: AssembleCaseInput): AssembledCase {
  const known = new Set(manifest.parts.map((p) => p.key));
  const unknown = [...new Set(attempts.map((a) => a.partKey))].filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new CaseExportError(
      'case_export_unknown_part',
      unknown.map((k) => `Attempt references part "${k}", which this tool's manifest does not declare.`),
    );
  }

  /*
    Tool-declared DEFAULTS seed the map FIRST, so every later merge — attempt
    values, identity prefill, prerequisite verdicts, the sign-off block — wins
    over them. A default is what the paper says when nobody said otherwise:
    the theory-only tool's "Written/Verbal Questions" method prints ticked
    unless an assessor recorded something else.
  */
  const values: Record<string, SubmissionValue> = { ...(manifest.fieldDefaults ?? {}) };
  const rendered: string[] = [];
  const blank: string[] = [];

  const passing = requiredParts(manifest, pathway);
  for (const part of passing) {
    const attempt = authoritativeAttempt(attempts, part.key);
    if (!attempt) {
      blank.push(part.key);
      continue;
    }
    Object.assign(values, attempt.values);
    rendered.push(part.key);

    /*
      Per-part name and date live as COLUMNS on the attempt row, so they never
      arrive in `attempt.values` and the printed boxes stayed empty on every
      export. An empty name writes nothing rather than an empty string: a blank
      box says "nobody recorded this", and drawing '' against a real date would
      say a nameless person marked it.
    */
    if (part.assessorNameFieldId && attempt.assessorName) {
      values[part.assessorNameFieldId] = attempt.assessorName;
    }
    if (part.signedDateFieldId && attempt.signedAt) {
      values[part.signedDateFieldId] = formatSignedDate(attempt.signedAt);
    }
  }

  // Seeded LAST so the case wins. The stream recorded on the case is what
  // decided which sections applied during the assessment; if an attempt happens
  // to carry a different answer, rendering that one would show a reviewer a
  // different set of questions than the candidate was actually assessed on.
  if (manifest.locationStreamFieldId && locationStream) {
    values[manifest.locationStreamFieldId] = locationStream;
  }

  /*
    WHO THIS CERTIFIES.

    The cover page's identity boxes belong to NO part — `fieldsInPart` slices
    from part 1's anchor onward, so they fall outside every part's range, and
    the fill route serves only a part's fields. Neither the candidate nor the
    assessor can type into them, and nothing else wrote them either.

    So the exported document carried the assessor's name, the date and the
    verdict for NOBODY: a certificate with no subject. An auditor holding it
    could not tell who had been assessed.

    Seeded from the CASE rather than from a filled field, for the same reason as
    the location stream above — the case is what the assessment was conducted
    against, so it is what the evidence document has to say.
  */
  for (const [fieldId, value] of Object.entries(prefillValues ?? {})) {
    values[fieldId] = value;
  }
  for (const [fieldId, value] of Object.entries(prerequisiteValues ?? {})) {
    values[fieldId] = value;
  }
  if (manifest.candidateNameFieldId && candidateName) {
    values[manifest.candidateNameFieldId] = candidateName;
  }

  /*
    THE COMPLETION CHECKLIST TICKS ITSELF (manifest.partCompletionMarks).
    Derived from the same attempt rows part state comes from, on an OPEN case
    as much as a resolved one — a mid-programme export is exactly where "what
    has this candidate finished so far" is being asked. Written over whatever
    an attempt stored for the field, so the printed record can never claim a
    completion the progress does not back.
  */
  const completionMarks = manifest.partCompletionMarks ?? [];
  if (completionMarks.length > 0) {
    const progress = caseProgress(
      manifest,
      pathway,
      attempts.map((a) => ({ partKey: a.partKey, attemptNumber: a.attemptNumber, outcome: a.outcome })),
    );
    for (const fieldId of new Set(completionMarks.map((m) => m.fieldId))) {
      const rows = completionTickRows(
        completionMarks.filter((m) => m.fieldId === fieldId),
        progress,
        values[fieldId],
      );
      if (rows.length > 0) values[fieldId] = rows;
    }
  }

  /*
    THE FRONT PAGE. Written after the per-part merge so no part's Object.assign
    can clobber a cover-page key, and every entry gated on the manifest actually
    naming it — a field the manifest does not name is written nothing at all and
    exports blank. On a competency record, silence is the safe failure; a
    confident mark in the wrong box asserts a finding nobody made.
  */
  for (const part of passing) {
    if (rendered.includes(part.key)) writeMark(values, part.checklistMark);
  }

  const marks = manifest.signOff;
  if (marks) {
    /*
      The coaching pair. Exactly one box is ticked, and only once the case is
      RESOLVED — while it is still open, neither is written, because an
      unfinished form is not a finding of "no coaching required".

      Read from the parts' FINAL outcomes, so a part failed once and passed on
      retry counts as satisfactory.
    */
    if (resolved) {
      const progress = caseProgress(manifest, pathway, attempts.map((a) => ({
        partKey: a.partKey,
        attemptNumber: a.attemptNumber,
        outcome: a.outcome,
      })));
      const coaching = moreCoachingRequired(progress);
      if (coaching === true) writeMark(values, marks.moreCoachingRequiredYes);
      if (coaching === false) writeMark(values, marks.moreCoachingRequiredNo);

      /*
        "Candidate not yet Competent" — the negative half of the printed
        Assessment Result pair.

        A DIFFERENT GATE FROM ITS PARTNER, and the asymmetry is the point.
        `overallSatisfactory` is the certification and waits for a signature
        below: a competency claim on a record nobody signed is the one thing
        this file must never manufacture. "Not yet competent" certifies
        nothing — it is the absence of a claim — and a failed case very often
        ends with no sign-off at all, so gating it the same way would leave the
        box permanently blank on exactly the records that need it.

        Without this the pair was half-written: a passed case ticked Competent
        and a failed one ticked nothing, so the two were told apart only by a
        box that was empty either way until somebody signed.
      */
      if (!isCaseCompetent(progress)) writeMark(values, marks.overallNotSatisfactory);
    }

    /*
      The certification itself renders ONLY once an assessor has signed. This is
      the gate that keeps a mid-programme export honest: it prints the document
      with the front page empty, exactly as it does today.
    */
    if (signOff) {
      if (marks.assessorNameFieldId) values[marks.assessorNameFieldId] = signOff.name;
      if (marks.signedDateFieldId) values[marks.signedDateFieldId] = formatSignedDate(signOff.at);
      if (marks.assessorSignatureFieldId) values[marks.assessorSignatureFieldId] = signOff.signature;
      writeMark(values, marks.overallSatisfactory);
    }
  }

  return { values, rendered, blank };
}

export interface ExportCaseInput extends AssembleCaseInput {
  originalPdf: Uint8Array;
  /** The full field set of the version being exported against. */
  fields: FormField[];
}

/**
 * Regenerate the complete source document for a case.
 *
 * The manifest is validated against the version's ACTUAL fields first: a part
 * whose start field is missing from this version contributes nothing, and an
 * export that quietly drops a part is indistinguishable from one where the
 * candidate never did it.
 */
export async function exportCasePdf(input: ExportCaseInput): Promise<Uint8Array> {
  /*
    EVERYTHING BUT THE RENDERER'S OWN INPUTS FLOWS THROUGH UNTOUCHED. This used
    to re-list every assemble field by hand, and the list drifted: the route
    resolved `prefillValues` and `prerequisiteValues` and this seam silently
    dropped both, so the printed identity block and the prerequisite ✓ exported
    blank on every case while the code that computed them ran for nothing. A
    rest-spread cannot drift — a field added to `AssembleCaseInput` reaches
    `assembleCaseValues` without this function knowing it exists.
  */
  const { originalPdf, fields, ...assemble } = input;

  const problems = validateManifest(assemble.manifest, fields);
  if (problems.length > 0) {
    throw new CaseExportError('case_export_invalid_manifest', problems);
  }

  const { values, blank } = assembleCaseValues(assemble);

  /*
    A SIGNED CASE WITH A BLANK REQUIRED PART IS A CONTRADICTION.

    Sign-off refuses unless every required part has passed, so reaching here
    means the manifest or the pathway moved underneath the case after it was
    certified. The alternative to refusing is a front page carrying an
    assessor's signature over a document whose required parts print empty —
    precisely the misrepresentation this module exists to prevent.

    `blank` was previously destructured away and never consulted.
  */
  if (assemble.signOff && blank.length > 0) {
    throw new CaseExportError(
      'case_export_competent_with_blank_parts',
      blank.map(
        (k) =>
          `Part "${k}" is required by this pathway but has no passing attempt, yet the case is signed off.`,
      ),
    );
  }

  // `roundTripExport` applies the visibility filter itself, so a section the
  // candidate's stream excluded cannot appear carrying an answer.
  return roundTripExport({ originalPdf, fields, values });
}
