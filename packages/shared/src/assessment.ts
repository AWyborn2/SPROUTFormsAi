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
import type { RepeatingRowValue, SubmissionValue } from './submission.js';
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
 * What kind of evidence a part gathers. Drives which surface fills it and how
 * it completes — a logbook accumulates over weeks against an hours minimum, a
 * practical is marked in one sitting, theory is auto-marked.
 */
export const PART_KINDS = ['theory', 'practical', 'logbook'] as const;
export type PartKind = (typeof PART_KINDS)[number];

/**
 * How a theory part's questions are PRESENTED to a candidate.
 *
 * Lives here rather than with the builder's own setup answers because it
 * outlives the draft: the fill surface reads it off the published tool, long
 * after the builder session that chose it is gone. A tool that names none gets
 * `stacked`, which is what every theory part has always rendered as.
 */
export const THEORY_RENDERINGS = ['one_per_screen', 'stacked'] as const;
export type TheoryRendering = (typeof THEORY_RENDERINGS)[number];

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
export const CASE_STATES = ['open', 'awaiting_sign_off', 'competent', 'closed'] as const;
export type AssessmentCaseState = (typeof CASE_STATES)[number];

/**
 * States in which the case is finished and `closedAt` means something.
 *
 * Exists because the single state writer used to stamp `closedAt` on anything
 * that was not `open` — a ternary that silently dates a live case the moment a
 * fourth, non-terminal state exists. Ask this instead of comparing to 'open'.
 */
export const TERMINAL_CASE_STATES: readonly AssessmentCaseState[] = ['competent', 'closed'];

export function isTerminalCaseState(state: AssessmentCaseState): boolean {
  return TERMINAL_CASE_STATES.includes(state);
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
  /** Logbook parts only — hours before the next demonstration is prompted. */
  minimumHours?: number;
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
 * The fields belonging to the section opened by `headerFieldId` — everything
 * after that header up to the next `section_header`, header excluded.
 *
 * This is the same header-to-next-header rule `visibility.ts` applies to
 * section scope. It lives here too because part membership and mandatory-section
 * membership are structural questions asked outside visibility evaluation, and
 * an unknown header returns nothing rather than the whole form: a manifest
 * pointing at a field that no longer exists must yield an empty section, never
 * silently claim every field in the document.
 */
export function fieldsInSection(
  fields: readonly FormField[],
  headerFieldId: string,
): FormField[] {
  const start = fields.findIndex((f) => f.id === headerFieldId);
  if (start < 0) return [];

  const out: FormField[] = [];
  for (let i = start + 1; i < fields.length; i++) {
    const field = fields[i]!;
    if (field.type === 'section_header') break;
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
      if (!(part.minimumHours && part.minimumHours > 0)) {
        problems.push(`Logbook part "${part.key}" has no positive minimumHours.`);
      }
      if (!part.durationColumnKey) {
        problems.push(`Logbook part "${part.key}" declares no durationColumnKey.`);
      } else {
        // The declared column must exist in the part's own table. Totalling a
        // column that is not there silently reports zero hours against a
        // safety threshold, so the mismatch is an authoring error — caught
        // here, where an author can fix it.
        const table = fieldsInSection(fields, part.startFieldId).find(
          (f) => f.type === 'repeating_group',
        );
        if (!table) {
          problems.push(`Logbook part "${part.key}" has no repeating table in its section.`);
        } else if (
          table.columns &&
          !table.columns.some((c) => c.key === part.durationColumnKey)
        ) {
          problems.push(
            `Logbook part "${part.key}" names duration column "${part.durationColumnKey}", which is not a column of its table.`,
          );
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
  if (manifest.candidateNameFieldId && !fieldIds.has(manifest.candidateNameFieldId)) {
    problems.push(
      `Manifest names candidateNameFieldId "${manifest.candidateNameFieldId}", which is not in this version.`,
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
 */
export function caseProgress(
  manifest: AssessmentToolManifest,
  pathway: AssessmentPathway,
  attempts: readonly AttemptFact[],
): PartProgress[] {
  const required = requiredParts(manifest, pathway);
  const out: PartProgress[] = [];
  let earlierAllSatisfied = true;

  for (const part of required) {
    const mine = attemptsForPart(attempts, part.key);
    const passed = mine.some((a) => a.outcome === 'satisfactory');
    const latestOutcome = mine.find((a) => a.outcome !== null)?.outcome ?? null;

    let state: PartState;
    if (passed) {
      state = 'satisfactory';
    } else if (!earlierAllSatisfied) {
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
 * Hours logged in a logbook part, summed from a duration column.
 *
 * Non-numeric cells contribute nothing rather than throwing: a logbook is
 * filled over weeks by someone in a cab, and one malformed row must not make
 * the whole total unreadable.
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
 * Problems with auto-marking configuration on a field set. Empty means valid.
 *
 * A field with neither an answer key nor an outcome target is ordinary and
 * always valid — most fields on an assessment paper are not auto-marked.
 */
export function validateAnswerKeys(fields: readonly FormField[]): string[] {
  const problems: string[] = [];
  const byId = new Map(fields.map((f) => [f.id, f]));

  for (const field of fields) {
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
