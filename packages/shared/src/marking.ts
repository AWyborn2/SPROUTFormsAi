/**
 * Auto-marking for theory questions.
 *
 * ONE RULE: exact set match. A question's answer key lists the options that
 * together make it correct, and the candidate must select all of them and
 * nothing else. A strict subset is wrong (they missed a required option) and so
 * is a superset (they picked a wrong one). That single rule covers both printed
 * shapes — an ordinary single-answer question is a one-element key, a "select
 * correct answers" question is a multi-element one — so there is no
 * partial-credit mode to configure, and no second rule for two surfaces to
 * disagree about.
 *
 * UNANSWERED IS INCORRECT, NEVER SKIPPED. A blank question on a competency
 * paper is not a question that didn't happen; it is one the candidate did not
 * answer, and it must count against them. Skipping blanks would let a candidate
 * reach 100% on a mandatory section by answering nothing.
 *
 * MARKS ARE ORDINARY VALUES. Marking returns values keyed exactly like any
 * other answer, so the round-trip exporter draws them with no special case and
 * a reviewer reading stored data sees the same mark the PDF shows.
 *
 * HIDDEN QUESTIONS DO NOT COUNT. Marking runs over the VISIBLE field set, so a
 * candidate on one location stream is never marked on another stream's
 * questions. This reuses `visibility.ts` rather than reimplementing the rule.
 */

import { fieldsInPart, partMarkFieldIds, signOffMarkFieldIds } from './assessment.js';
import type {
  AssessmentPart,
  AssessmentToolManifest,
  DeclaredMark,
  PartOutcome,
} from './assessment.js';
import { SELF_ANSWERING_TYPES, isChoiceField } from './form-field.js';
import type { FormField, FormFieldType, OutcomeTarget } from './form-field.js';
import type { RepeatingRowValue, SubmissionValue } from './submission.js';
import type { ValueSource } from './workflow.js';
import { visibleFields, type VisibilityAnswers } from './visibility.js';

/**
 * Field types that are STRUCTURAL — furniture in the printed document, not
 * questions a candidate answers. A part's automatic marking turns only on its
 * real questions, so these are excluded from the keyed-ness test: a
 * `section_header` (the part's own anchor) and a `signature` box can hold no
 * answer key, and reading them into the test would stop any real part from ever
 * self-marking.
 */
const STRUCTURAL_FIELD_TYPES: ReadonlySet<FormFieldType> = new Set(['section_header', 'signature']);

/**
 * Whether a part MARKS ITSELF (U15, R66–R68): it carries at least one real
 * question and EVERY real question has both a non-empty answer key and an
 * outcome target.
 *
 * Decided by keyed-ness, not by `part.kind`. The domain is stated on purpose:
 * `fieldsInPart` returns a contiguous slice carrying the part's structural
 * furniture, the ✓/✗ OUTCOME CELLS each question's mark is written into, any
 * assessor-name/date boxes the part prints, and the LOCATION-STREAM question that
 * gates which sections show — none of which holds an answer key or is a
 * competency question. All of those are excluded and every remaining real
 * question must be keyed.
 * Requiring only SOME question be keyed would let a partly-keyed part mark itself
 * against the keys it happens to hold and pass the rest unchecked — the exact
 * failure this replaces — so a part with any unkeyed question, or no real
 * question at all, reaches an assessor instead.
 *
 * Pass the FULL version field set — the slice is taken here — and unstripped, so
 * the answer keys are visible to the test.
 */
export function isSelfMarking(
  fields: readonly FormField[],
  manifest: AssessmentToolManifest,
  partKey: string,
): boolean {
  const partFields = fieldsInPart(fields, manifest, partKey);
  const part = manifest.parts.find((p) => p.key === partKey);

  // Furniture the candidate does not answer: the part's own printed
  // assessor-name and date boxes, and every field a question WRITES ITS MARK
  // INTO (a check_cross box, or the repeating group a margin table addresses).
  const furniture = new Set<string>();
  if (part?.assessorNameFieldId) furniture.add(part.assessorNameFieldId);
  if (part?.signedDateFieldId) furniture.add(part.signedDateFieldId);
  // The location-stream selector gates which sections a candidate sees; it is
  // answered but carries no answer key, so it is not a question to mark.
  if (manifest.locationStreamFieldId) furniture.add(manifest.locationStreamFieldId);
  for (const f of partFields) if (f.outcomeTarget) furniture.add(f.outcomeTarget.fieldId);
  /*
    AND THE BOXES MARKING ITSELF WRITES — the part's verdict pair, its "detail
    further action", the cover's sign-off.

    Without these a part that declares a verdict pair stops self-marking. "The
    Candidate's responses were: ☐ Satisfactory ☐ Not Satisfactory" prints at the
    END of a part, so it lands inside the slice; it carries no answer key
    because nobody keys it — `markTheory` writes it from the arithmetic. The
    test below then saw an unkeyed field and concluded a person had to judge the
    part, which is the exact opposite of what declaring the pair was for.
  */
  for (const id of partMarkFieldIds(part)) furniture.add(id);
  // The cover's boxes too, for the tools that print the certification block
  // inside a part's slice rather than only on the front page.
  for (const id of signOffMarkFieldIds(manifest)) furniture.add(id);
  /*
    AND EVERY FIELD THE AUTHOR LOCKED TO `auto`. An auto-sourced field is
    written by marking, never answered by a person — the workflow editor's
    whole meaning for the setting. The one that bit: a theory part's printed
    verdict radio locked to `auto` (so `autoVerdictWrite` fills it at hand-in)
    read here as an unkeyed question, and the part stopped self-marking — the
    switch that turns the auto-verdict ON was the same switch turning the
    quiz's marking OFF.
  */
  for (const s of manifest.workflow?.sections ?? []) {
    for (const [id, source] of Object.entries(s.fieldSource ?? {})) {
      if (source === 'auto') furniture.add(id);
    }
  }

  const questions = partFields.filter(
    (f) => !STRUCTURAL_FIELD_TYPES.has(f.type) && !furniture.has(f.id),
  );
  return (
    questions.length > 0 &&
    questions.every((f) => (f.answerKey?.length ?? 0) > 0 && f.outcomeTarget !== undefined)
  );
}

/** One question's verdict. */
export interface QuestionMark {
  fieldId: string;
  correct: boolean;
  /** True when the candidate recorded no answer at all. Still `correct: false`. */
  unanswered: boolean;
  target: OutcomeTarget;
  /** Whether this question sits in the part's must-pass-entirely section. */
  mandatory: boolean;
}

export interface TheoryMarkingResult {
  marks: QuestionMark[];
  /**
   * Derived answers to merge into the attempt's values — the ✓/✗ each question
   * earned, keyed by the field it lands on.
   */
  derivedValues: Record<string, SubmissionValue>;
  /** Correct / total across the marked (visible, keyed) questions. */
  correctCount: number;
  totalCount: number;
  /**
   * Whether the part's GATE was cleared — the same boolean `outcome` is derived
   * from.
   *
   * Normally that gate is the mandatory section. When a part names none, the
   * whole part is the gate instead, and when nothing was marked at all this is
   * false rather than vacuously true. See the reasoning at the computation:
   * `[].every(...)` returning `true` is what used to pass a candidate who got
   * every question wrong.
   */
  mandatoryAllCorrect: boolean;
  outcome: PartOutcome;
}

/**
 * The options a candidate selected, as a set of strings.
 *
 * A multi-select answer arrives as an array; a single-select as a scalar. A
 * boolean is normalized to `'true'`/`'false'` so a yes/no question can carry an
 * answer key like any other. Absent, null and empty string all mean unanswered.
 */
function selectedOptions(value: SubmissionValue | undefined): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) {
    // A repeating-group value cannot be a question answer.
    if (value.some((v) => typeof v === 'object' && v !== null)) return undefined;
    const options = (value as string[]).map(String).filter((s) => s !== '');
    return options.length > 0 ? options : undefined;
  }
  if (typeof value === 'boolean') return [value ? 'true' : 'false'];
  if (typeof value === 'number') return [String(value)];
  if (typeof value === 'string') return [value];
  return undefined;
}

/** Exact set equality, order- and duplicate-insensitive. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const item of left) if (!right.has(item)) return false;
  return true;
}

/**
 * Write each mark onto the values map at its target.
 *
 * A scalar target takes the boolean directly. A repeating target addresses one
 * cell, so the row is found by `rowKey` (or appended when absent) and the
 * column set on it — which is how a printed outcome column beside each question
 * is actually shaped.
 */
function applyMarks(
  marks: readonly QuestionMark[],
  base: Record<string, SubmissionValue>,
): Record<string, SubmissionValue> {
  const out: Record<string, SubmissionValue> = { ...base };

  for (const mark of marks) {
    const { fieldId, rowKey, columnKey } = mark.target;

    if (!rowKey || !columnKey) {
      out[fieldId] = mark.correct;
      continue;
    }

    const existing = Array.isArray(out[fieldId]) ? (out[fieldId] as RepeatingRowValue[]) : [];
    const rows: RepeatingRowValue[] = existing.map((row) => ({ ...row }));
    const found = rows.find((row) => row.__key === rowKey);

    if (found) {
      found[columnKey] = mark.correct;
    } else {
      rows.push({ __key: rowKey, [columnKey]: mark.correct });
    }
    out[fieldId] = rows;
  }

  return out;
}

/**
 * Fields with the marking secrets removed — what a FILL surface may be served.
 *
 * `answerKey` is the complete answer key to the assessment; serving it to the
 * browser that renders the questions hands every candidate the answers in
 * devtools. `modelAnswer` is the same secret in prose — a written question's
 * expected answer — so it strips on exactly the same rule, and the assessor's
 * copy travels through a separate role-gated channel instead of un-stripping.
 * Marking never runs client-side (the outcome route computes it from the
 * stored attempt), so no fill surface has any use for these properties — only
 * the builder, where keys are authored, may see them.
 *
 * Returns the same array when nothing carried a key, so callers can cheaply
 * skip no-op copies.
 */
export function stripMarkingSecrets(fields: readonly FormField[]): FormField[] {
  if (!fields.some((f) => f.answerKey || f.outcomeTarget || f.answerHint || f.modelAnswer)) return fields as FormField[];
  return fields.map((f) => {
    if (!f.answerKey && !f.outcomeTarget && !f.answerHint && !f.modelAnswer) return f;
    const { answerKey: _key, outcomeTarget: _target, answerHint: _hint, modelAnswer: _model, ...rest } = f;
    return rest;
  });
}

/**
 * The questions a candidate did not get right, named as the paper names them.
 *
 * WHAT GOES IN "DETAIL FURTHER ACTION". The printed box asks the assessor what
 * happens next after a not-satisfactory result, and the answer on a keyed
 * theory part is always the same shape: these are the questions to go back
 * over. An assessor writing that by hand is reading thirty ticks off a page and
 * transcribing the crosses — which is both the slowest part of marking and the
 * easiest to get wrong.
 *
 * WRONG AND UNANSWERED ARE DISTINGUISHED, because they call for different
 * coaching: a wrong answer is a misunderstanding to correct, a blank is a
 * question the candidate never reached. Rolling them together would hide which
 * happened on the one document that records it.
 *
 * The LABEL is what identifies each question, because that is what is printed
 * beside it — these papers number their questions in the label itself ("7. Which
 * sign means…"), so the reference an assessor would cite comes along for free.
 * Long labels are cut at a word boundary: this lands in a printed box a couple
 * of lines high, and an overrun draws over whatever is beneath it.
 *
 * Returns EMPTY when nothing was missed, and the caller writes nothing. A box
 * reading "None" beside a passed assessment is a sentence nobody wrote.
 */
export function incorrectQuestionsNote(
  marks: readonly QuestionMark[],
  fields: readonly FormField[],
): string {
  const labelById = new Map(fields.map((f) => [f.id, f.label]));
  const name = (id: string) => {
    const label = (labelById.get(id) ?? id).trim();
    if (label.length <= INCORRECT_LABEL_CHARS) return label;
    const cut = label.slice(0, INCORRECT_LABEL_CHARS);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > INCORRECT_LABEL_CHARS / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
  };

  const wrong = marks.filter((m) => !m.correct && !m.unanswered).map((m) => name(m.fieldId));
  const blank = marks.filter((m) => m.unanswered).map((m) => name(m.fieldId));

  const parts: string[] = [];
  if (wrong.length > 0) parts.push(`Answered incorrectly: ${wrong.join('; ')}.`);
  if (blank.length > 0) parts.push(`Not answered: ${blank.join('; ')}.`);
  return parts.join(' ');
}

/** How much of a question's printed label the further-action box carries. */
const INCORRECT_LABEL_CHARS = 70;

export interface MarkTheoryInput {
  /** The full field set of the template version. */
  fields: readonly FormField[];
  /** The candidate's answers, including whatever seeds visibility. */
  /**
   * The candidate's answers. NULLABLE because an attempt that was opened and
   * never typed into stores no value map at all, and that is a real state to
   * mark: every question comes out unanswered, which is incorrect.
   */
  values: Record<string, SubmissionValue> | null | undefined;
  /**
   * The theory part being marked — supplies the mandatory section, and the
   * printed boxes the verdict is written into.
   *
   * A part naming none of the verdict boxes marks exactly as it always has: the
   * per-question ✓/✗ and nothing else. That is what keeps every tool authored
   * before this existed unchanged.
   */
  part: Pick<
    AssessmentPart,
    'mandatoryFieldIds' | 'outcomeSatisfactory' | 'outcomeNotSatisfactory' | 'furtherActionFieldId'
  >;
  /**
   * Pass threshold as a percentage (1–100). When set, the part is satisfactory
   * if `correctCount / totalCount >= passPercent / 100`. Absent or undefined
   * means the pre-existing mandatory-all-correct rule applies instead.
   */
  passPercent?: number;
}

/**
 * Mark the visible KEYED questions and nothing else — the arithmetic core of
 * `markTheory`, without any of its part-level consequences.
 *
 * Returns each keyed question's verdict plus the value map with every ✓/✗
 * written at its target. Deliberately NO part verdict, NO further-action note,
 * NO outcome: those are claims about a whole part, and in a MIXED part — keyed
 * choice questions alongside assessor-judged written ones — the machine holds
 * only some of the evidence. The keyed marks are honest pre-marks the assessor
 * builds on; letting this function tick "Satisfactory" would certify a part on
 * the four questions it can read while ignoring the eleven it cannot.
 *
 * An unkeyed question — written or otherwise — is skipped entirely, even when
 * it declares an `outcomeTarget`: that cell is the assessor's to tick.
 *
 * `mandatoryFieldIds` is optional so callers pre-marking a judged part need no
 * part at hand; each mark's `mandatory` flag is then false, which is correct —
 * the must-pass gate is `markTheory`'s concern, and this function draws none
 * of the conclusions that read the flag.
 */
export function markKeyedQuestions(
  fields: readonly FormField[],
  values: Record<string, SubmissionValue> | null | undefined,
  mandatoryFieldIds?: readonly string[],
): { marks: QuestionMark[]; derivedValues: Record<string, SubmissionValue> } {
  // An untouched attempt has no map. Marking it is meaningful — every question
  // is unanswered — so normalize rather than refusing, which would have made an
  // assessor unable to fail a candidate who wrote nothing.
  const answers = values ?? {};
  const visible = visibleFields(fields, answers as VisibilityAnswers);

  const mandatoryIds = new Set(mandatoryFieldIds ?? []);

  const marks: QuestionMark[] = [];

  for (const field of visible) {
    if (!field.answerKey || field.answerKey.length === 0) continue;
    if (!field.outcomeTarget) continue;

    const selected = selectedOptions(answers[field.id]);
    const unanswered = selected === undefined;

    marks.push({
      fieldId: field.id,
      correct: !unanswered && sameSet(selected, field.answerKey),
      unanswered,
      target: field.outcomeTarget,
      mandatory: mandatoryIds.has(field.id),
    });
  }

  return { marks, derivedValues: applyMarks(marks, answers) };
}

/**
 * Mark every visible keyed question and decide the part's outcome.
 *
 * The outcome turns on the mandatory section alone: questions outside it are
 * marked and reported, but a wrong answer there does not by itself make the
 * part unsatisfactory. That mirrors the paper, where the must-pass section is
 * the gate and the location-specific sets are evidence.
 */
export function markTheory({ fields, values, part, passPercent }: MarkTheoryInput): TheoryMarkingResult {
  const answers = values ?? {};
  // The per-question arithmetic is shared with the mixed-marking pre-mark path
  // (`markKeyedQuestions`); everything below it — verdict box, further-action
  // note, outcome — is the part-level judgment only a fully-keyed part may make.
  const { marks, derivedValues } = markKeyedQuestions(fields, answers, part.mandatoryFieldIds);

  const correctCount = marks.filter((m) => m.correct).length;
  const mandatoryMarks = marks.filter((m) => m.mandatory);

  /*
    AN EMPTY MUST-PASS SET USED TO PASS EVERYBODY.

    `[].every(...)` is `true`. So a theory part that named no mandatory
    questions — or named some that were all hidden by the location stream, or
    all unkeyed — computed `mandatoryAllCorrect === true` and returned
    SATISFACTORY. A candidate who got every question on the paper wrong was
    marked satisfactory, automatically, on a competency record. Nothing
    anywhere said so: no validator refused the manifest, and the printed
    verdict box was ticked by the same code path as a genuine pass.

    The gate that did not run is the whole problem, so the fix is to say what
    happens when there is nothing in it rather than to let `every` answer for
    us. Three cases, and only one of them is the old behaviour:

    1. THE SET HAS MARKS — unchanged. Every mandatory question must be correct;
       questions outside the set are marked and reported but do not gate.

    2. THE SET IS EMPTY AND THE PART HAS MARKS — the WHOLE PART is the gate.
       An author who never narrowed the must-pass set has not said "nothing
       matters"; the natural reading of "every question in the must-pass set"
       when nobody narrowed it is every question. This neither passes a
       candidate who got things wrong nor fails one who got everything right,
       which a blanket `not_satisfactory` would have done to a perfect paper.

    3. NOTHING WAS MARKED AT ALL — not satisfactory. "Satisfactory" would be a
       claim about an assessment that did not happen, and on this document that
       claim is a certificate. Failing here is recoverable — the candidate is
       coached and sits it again — where passing is not.
  */
  const gate = mandatoryMarks.length > 0 ? mandatoryMarks : marks;
  const mandatoryAllCorrect = gate.length > 0 && gate.every((m) => m.correct);

  /*
    PERCENTAGE PASS RULE — when the author chose `overall_percentage`.

    The percentage gate replaces mandatory-all-correct: the part passes when
    `correctCount / totalCount >= passPercent / 100`. The mandatory set is
    still marked and reported, but it is not the gate — the overall score is.

    Absent passPercent means the pre-existing rule, so no stored tool changes.
  */
  const passedByPercent =
    passPercent !== undefined && marks.length > 0
      ? correctCount / marks.length >= passPercent / 100
      : undefined;
  const outcome: PartOutcome =
    passedByPercent !== undefined
      ? passedByPercent
        ? 'satisfactory'
        : 'not_satisfactory'
      : mandatoryAllCorrect
        ? 'satisfactory'
        : 'not_satisfactory';

  /*
    THE PART'S OWN VERDICT BOX, written from the same arithmetic that produced
    the ✓/✗ above.

    "The Candidate's responses were: ☐ Satisfactory ☐ Not Satisfactory" is
    printed at the end of each part, and on a fully-keyed theory part it is a
    restatement of `outcome` — an assessor ticking it is transcribing a sum,
    thirty questions after doing nothing else the machine did not do.

    EXACTLY ONE OF THE PAIR IS WRITTEN. Ticking both, or deriving one from the
    other's absence, would leave the record saying two things or nothing; two
    boxes are printed because both answers are positive statements.
  */
  const verdict = outcome === 'satisfactory' ? part.outcomeSatisfactory : part.outcomeNotSatisfactory;
  if (verdict) writeDeclared(derivedValues, verdict);

  /*
    "Detail further action" — the questions to go back over.

    Only on a NOT-satisfactory part, and only when something was actually
    missed. A satisfactory part leaves the box alone: an empty box beside a
    passed assessment is correct, and "None" is a sentence nobody wrote.

    Written only where the box is EMPTY. An assessor who has already typed into
    it has said something this cannot improve on, and overwriting a person's
    words on a competency record is not a thing an automatic mark may do.
  */
  if (outcome === 'not_satisfactory' && part.furtherActionFieldId) {
    const existing = derivedValues[part.furtherActionFieldId];
    const untouched = existing === undefined || existing === null || existing === '';
    const note = incorrectQuestionsNote(marks, fields);
    if (untouched && note) derivedValues[part.furtherActionFieldId] = note;
  }

  return {
    marks,
    derivedValues,
    correctCount,
    totalCount: marks.length,
    mandatoryAllCorrect,
    outcome,
  };
}

/**
 * Write one declared mark into a value map — the marking-side twin of the
 * exporter's `writeMark`.
 *
 * Duplicated rather than shared for now because the two live either side of the
 * package boundary and this one has no repeating-group case to get wrong: a
 * part's verdict box is a printed tick, not a table cell. If a paper ever prints
 * one inside a grid, this grows the same row/column handling and the two should
 * be folded together at that point rather than before.
 */
function writeDeclared(values: Record<string, SubmissionValue>, mark: DeclaredMark): void {
  if (mark.rowKey && mark.columnKey) {
    const existing = Array.isArray(values[mark.fieldId])
      ? (values[mark.fieldId] as RepeatingRowValue[])
      : [];
    const rows: RepeatingRowValue[] = existing.map((r) => ({ ...r }));
    const cell = mark.value;
    // A non-primitive in a cell exports as nothing (the PDF writer refuses it),
    // so refusing here keeps the two sides agreeing about what was written.
    if (cell !== null && typeof cell === 'object') return;
    const row = rows.find((r) => r.__key === mark.rowKey);
    if (row) row[mark.columnKey] = cell;
    else rows.push({ __key: mark.rowKey, [mark.columnKey]: cell });
    values[mark.fieldId] = rows;
    return;
  }
  values[mark.fieldId] = mark.value;
}

/*
  ── The verdict vocabulary ─────────────────────────────────────────────────
  Which printed option means "passed" and which means "not yet". Kept identical
  to `markableValue` in `builder-manifest.ts`, which proposes the verdict pair at
  build time, so the mark-time derivation below can never disagree with the
  authoring layer about the single most consequential cell on a competency
  record. If either moves, move both.
*/
const VERDICT_YES = /^(?:yes|satisfactory|competent|candidate competent|pass(?:ed)?)$/i;
const VERDICT_NO = /^(?:no|not satisfactory|not yet competent|candidate not yet competent|fail(?:ed)?)$/i;

/**
 * The value that ticks a verdict field for a wanted outcome, or null if the
 * field cannot carry it.
 *
 * A self-answering box (`check_cross` / `boolean_yes_no`) takes the boolean; a
 * choice field takes the option whose printed words say so, and REQUIRES a hit
 * — falling back to the first option would be a coin toss on the verdict.
 */
export function verdictValueFor(
  field: Pick<FormField, 'type' | 'options'>,
  want: boolean,
): SubmissionValue | null {
  if (SELF_ANSWERING_TYPES.includes(field.type)) return want;
  const options = field.options ?? [];
  if (options.length === 0) return null;
  const wanted = options.find((o) => (want ? VERDICT_YES : VERDICT_NO).test(o.trim()));
  return wanted ?? null;
}

/** Both halves of a verdict over one field, when the field can carry them both. */
export function verdictPairOf(
  field: Pick<FormField, 'type' | 'options'>,
): { yes: SubmissionValue; no: SubmissionValue } | null {
  const yes = verdictValueFor(field, true);
  const no = verdictValueFor(field, false);
  if (yes === null || no === null || yes === no) return null;
  return { yes, no };
}

/** Whether a Yes/No (`boolean_yes_no`) or ✓/✗ (`check_cross`) box reads as passed. */
export function isYesValue(value: SubmissionValue | undefined): boolean {
  if (value === true) return true;
  if (typeof value === 'string') return VERDICT_YES.test(value.trim());
  return false;
}

/**
 * Derive a practical part's outcome from its Yes/No checklist, when the author
 * has LOCKED its verdict field to `auto`.
 *
 * The gap this fills: a practical demonstration is not keyed, so `markTheory`
 * never runs, and setting the verdict field to `auto` locked it without ever
 * filling it — the assessor was left with a blank, un-editable radio. Here every
 * criterion ticked Yes makes the part satisfactory and writes the "Competent"
 * value; any No, or a box left untouched, makes it not-satisfactory and writes
 * "not yet Competent". A box left untouched fails on purpose — "satisfactory" on
 * a criterion nobody judged is a finding nobody made.
 *
 * Returns null — leave the part to the assessor — unless BOTH hold: the part has
 * a choice field whose options resolve to a competent / not-competent pair that
 * the author set to `auto` (the deliberate "derive this" signal; an ordinary
 * verdict the assessor still picks stays `entry`), and it has at least one Yes/No
 * criterion to read. `verdictSource` is the part section's `fieldSource` map.
 */
/**
 * The write a part's auto-locked verdict field takes for a KNOWN outcome —
 * the theory-side twin of `deriveChecklistOutcome`'s final step, sharing its
 * discovery rule exactly.
 *
 * A practical derives its outcome FROM the checklist, so the derivation above
 * owns the whole journey. A theory part already knows its outcome — the quiz
 * marking computed it — but its printed verdict radio ("The Candidate's
 * responses were: Satisfactory / Not Satisfactory") was left blank: locking it
 * to `auto` made it un-typable without anything ever filling it, the same gap
 * the checklist derivation closed for practicals. Same signal, same field
 * rule: a choice field in the part whose options resolve to a verdict pair,
 * locked to `auto` by the author. Returns null when the part prints no such
 * field, which is most theory papers.
 */
export function autoVerdictWrite(
  fields: readonly FormField[],
  manifest: AssessmentToolManifest,
  part: AssessmentPart,
  outcome: PartOutcome,
  verdictSource: Record<string, ValueSource> | undefined,
): { fieldId: string; value: SubmissionValue } | null {
  const partFields = fieldsInPart(fields, manifest, part.key);
  const verdictField = partFields.find(
    (f) => isChoiceField(f.type) && verdictPairOf(f) !== null && verdictSource?.[f.id] === 'auto',
  );
  if (!verdictField) return null;
  const pair = verdictPairOf(verdictField)!;
  return {
    fieldId: verdictField.id,
    value: outcome === 'satisfactory' ? pair.yes : pair.no,
  };
}

export function deriveChecklistOutcome(
  fields: readonly FormField[],
  manifest: AssessmentToolManifest,
  part: AssessmentPart,
  values: Record<string, SubmissionValue> | undefined,
  verdictSource: Record<string, ValueSource> | undefined,
): { outcome: PartOutcome; derivedValues: Record<string, SubmissionValue> } | null {
  const answers = values ?? {};
  const partFields = fieldsInPart(fields, manifest, part.key);

  const verdictField = partFields.find(
    (f) => isChoiceField(f.type) && verdictPairOf(f) !== null && verdictSource?.[f.id] === 'auto',
  );
  if (!verdictField) return null;
  const pair = verdictPairOf(verdictField)!;

  // The criteria: the part's Yes/No boxes, minus anything marking itself writes
  // (a verdict pair, a question's own ✓/✗ cell) so nothing marks itself.
  const written = new Set<string>(partMarkFieldIds(part));
  for (const f of partFields) if (f.outcomeTarget) written.add(f.outcomeTarget.fieldId);
  const criteria = partFields.filter(
    (f) => SELF_ANSWERING_TYPES.includes(f.type) && !written.has(f.id),
  );
  if (criteria.length === 0) return null;

  const allPass = criteria.every((c) => isYesValue(answers[c.id]));
  const derivedValues: Record<string, SubmissionValue> = { ...answers };
  writeDeclared(derivedValues, { fieldId: verdictField.id, value: allPass ? pair.yes : pair.no });
  return { outcome: allPass ? 'satisfactory' : 'not_satisfactory', derivedValues };
}
