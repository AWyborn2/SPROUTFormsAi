/**
 * Turning the builder's arrangement into an `AssessmentToolManifest`.
 *
 * WHAT THIS REPLACES. `packages/db/scripts/author-track-dozer-tool.mjs` builds
 * this object today: it anchors parts by matching heading TEXT against a hard-
 * coded list, infers each part's kind from that same text, and refuses to write
 * unless it finds exactly six anchors. Its own comments call it heuristic. Every
 * one of those heuristics exists because a script cannot ask — and this surface
 * can, so the rules port across and the guesses do not.
 *
 * TWO ORDERS, AND THEY ARE NOT THE SAME ORDER. `ordinal` is the part's PRINTED
 * position and never moves: it is what ties a part to the paper a candidate
 * signs, and renumbering it would silently re-point a stored attempt at a
 * different part of the document. The ARRAY order is the process order — which
 * part an assessor works through first — and that is what reordering in the UI
 * changes. Conflating them is R14's whole point.
 *
 * NOTHING HERE VALIDATES. `validateManifest` already owns every rule and its
 * messages are written for a person; this module builds the object and hands it
 * over. A second set of rules here would be a second thing to keep true, and the
 * two would disagree exactly when it mattered.
 */

import {
  fieldsInSection,
  isSelfAnswering,
  type AssessmentPart,
  type AssessmentPathway,
  type AssessmentToolManifest,
  type ExtractedField,
  type FormField,
  type FormFieldType,
  type PartKind,
  type SetupAnswers,
  type StructureSection,
  type DeclaredMark,
  type DraftAnswerKey,
  type SubmissionValue,
} from '@formai/shared';

/* ------------------------------------------------------------------ *
 * Kind
 * ------------------------------------------------------------------ */

/**
 * What kind of evidence a section gathers, from what it CONTAINS.
 *
 * The authoring script reads this off the heading text ("PART 3 — DIRECT
 * OBSERVATION LOG" → logbook), which works on exactly one document and fails
 * silently on the next customer's paper. A section's contents are the same
 * evidence in every document of this class:
 *
 *  · an OPEN repeating group — rows the filler adds over weeks — is a logbook;
 *  · a FIXED-ROW repeating group is a practical observation checklist;
 *  · anything with keyable questions is theory.
 *
 * Ordered so the table shapes win: a practical part often carries a question or
 * two alongside its checklist, and calling that part theory would auto-mark a
 * demonstration nobody watched.
 */
export function inferKind(sectionFields: readonly FormField[]): PartKind {
  const tables = sectionFields.filter((f) => f.type === 'repeating_group');
  if (tables.some((t) => !t.fixedRows || t.fixedRows.length === 0)) return 'logbook';
  if (tables.length > 0) return 'practical';
  return 'theory';
}

/**
 * The column that records elapsed time, by the key the extraction profile asks
 * for and then by what the column is called.
 *
 * Rule 6 of the assessment profile instructs the model to give this column the
 * key "duration" whatever its printed label, so the declared key is the first
 * thing to look for. The label fallback exists for tables extracted before that
 * rule, and for a document that prints something the rule did not anticipate —
 * and where neither resolves, this returns undefined and `validateManifest`
 * says so by name, which is the outcome that gets it fixed. Guessing a column
 * here totals a column that may not exist, and reports zero hours against a
 * safety minimum.
 */
export function findDurationColumn(table: FormField | undefined): string | undefined {
  const columns = table?.columns ?? [];
  const byKey = columns.find((c) => c.key === 'duration');
  if (byKey) return byKey.key;
  const byLabel = columns.find((c) => /hour|duration|time/i.test(c.label ?? ''));
  return byLabel?.key;
}

/* ------------------------------------------------------------------ *
 * Parts
 * ------------------------------------------------------------------ */

/** One section, as the units step shows it before it becomes a part. */
export interface DerivedPart extends AssessmentPart {
  /** The structure section this came from. Not part of the manifest. */
  sectionKey: string;
}

export interface DeriveInput {
  structure: readonly StructureSection[];
  fields: readonly FormField[];
  setup: SetupAnswers;
  keys: readonly DraftAnswerKey[];
  excluded: ReadonlySet<string>;
}

/**
 * Derive one part per non-cover section, in printed order.
 *
 * COVER SECTIONS ARE NOT PARTS. `fieldsInPart` slices from a part's anchor
 * onward and the first anchor is the first real part, so cover fields fall in
 * no part's range by design — the manifest addresses them through
 * `candidateNameFieldId` and `signOff` instead. Emitting a cover part would
 * give those fields two owners.
 */
export function derivePartsFromStructure({
  structure,
  fields,
  setup,
  keys,
  excluded,
}: DeriveInput): DerivedPart[] {
  const keyed = new Set(keys.map((k) => k.fieldId));
  const parts: DerivedPart[] = [];
  let ordinal = 0;

  for (const section of structure) {
    if (section.cover) continue;

    const sectionFields = section.fields
      .map((f) => fields.find((x) => x.id === f.id))
      .filter((f): f is FormField => !!f);
    const fillable = sectionFields.filter((f) => f.type !== 'section_header');
    // A section with nothing in it is not a part. It is a heading the author
    // has emptied, and declaring it would produce a part with no start field.
    if (fillable.length === 0) continue;

    ordinal += 1;
    const kind = inferKind(sectionFields);

    /*
      THE ANCHOR IS THE SECTION'S HEADING WHERE IT HAS ONE, AND ITS FIRST
      FILLABLE FIELD WHERE IT DOES NOT.

      `startFieldId` is deliberately not restricted to a `section_header` —
      requiring one made a real 18-page import unanchorable, because a printed
      heading is not a field somebody fills in. But PREFERRING one matters:
      `fieldsInSection` slices from AFTER the anchor, and both `validateManifest`
      and the column picker use it to find a logbook's table. Anchor a logbook
      part at its own table and the slice starts past it — the validator reports
      "has no repeating table in its section" about a part whose table is the
      very field it points at, and the picker offers no columns to declare.

      Falling back to the first fillable field keeps a header-less document
      anchorable, which is what the relaxation was for.
    */
    const startFieldId = section.headerFieldId ?? fillable[0]!.id;

    /*
      MANDATORY QUESTIONS ARE THE ONES THAT ARE BOTH KEYED AND NOT EXCLUDED.

      `validateManifest` hard-errors on a mandatory question with no answer key,
      because marking skips it and it cannot gate anything — the part could
      reach 100% with the question never assessed. Proposing only keyed
      questions means the default manifest is valid on arrival, and an author
      adding an unkeyed one is told immediately rather than at publish.

      Only theory parts get one: a practical's criteria are ticked by an
      assessor, not auto-marked, so a mandatory set there would name fields
      `markTheory` never looks at.
    */
    const mandatoryFieldIds =
      kind === 'theory'
        ? fillable.filter((f) => keyed.has(f.id) && !excluded.has(f.id)).map((f) => f.id)
        : [];

    const table = sectionFields.find((f) => f.type === 'repeating_group');
    const durationColumnKey = kind === 'logbook' ? findDurationColumn(table) : undefined;

    parts.push({
      sectionKey: section.key,
      key: section.key,
      ordinal,
      label: section.label,
      kind,
      // Every pathway the tool offers, as a starting point. Which parts a route
      // actually requires is printed on the cover (rule 16) and is the author's
      // to narrow — but a part belonging to NO pathway is a hard validator
      // problem, so the default has to be non-empty.
      pathways: [...setup.pathways],
      startFieldId,
      ...(mandatoryFieldIds.length > 0 ? { mandatoryFieldIds } : {}),
      ...(durationColumnKey ? { durationColumnKey } : {}),
      /*
        The part's own verdict boxes, read off its printed labels. Scoped to
        this section's fields, because the certification block repeats once per
        part — a whole-document search would find one per part and be unable to
        say which belongs here.
      */
      ...proposePartMarks(sectionFields),
    });
  }

  return parts;
}

/**
 * Reorder the PROCESS order without touching the printed order.
 *
 * R14. The array is what an assessor works through; `ordinal` is where the part
 * sits on the paper. Renumbering ordinals on a reorder would re-point every
 * stored attempt at a different part of the document — an attempt records a
 * part key, and the ordinal is what says which printed pages that key means.
 */
export function movePart(parts: readonly DerivedPart[], key: string, delta: number): DerivedPart[] {
  const at = parts.findIndex((p) => p.key === key);
  if (at < 0) return parts as DerivedPart[];
  const to = at + delta;
  // Returning the SAME array when nothing moves keeps this idempotent by
  // reference, as every other builder operation is — a held arrow key produces
  // one change and then no-ops.
  if (to < 0 || to >= parts.length) return parts as DerivedPart[];
  const next = [...parts];
  const [moved] = next.splice(at, 1);
  next.splice(to, 0, moved!);
  return next;
}

/** Set which pathways require a part. */
export function setPathways(
  parts: readonly DerivedPart[],
  key: string,
  pathways: readonly AssessmentPathway[],
): DerivedPart[] {
  return parts.map((p) => (p.key === key ? { ...p, pathways: [...pathways] } : p));
}

/** Patch one part. Used for kind, minimum hours and the duration column. */
export function updatePart(
  parts: readonly DerivedPart[],
  key: string,
  patch: Partial<Omit<DerivedPart, 'key' | 'ordinal' | 'sectionKey'>>,
): DerivedPart[] {
  return parts.map((p) => (p.key === key ? { ...p, ...patch } : p));
}

/* ------------------------------------------------------------------ *
 * The manifest
 * ------------------------------------------------------------------ */

/**
 * Cover fields the manifest addresses directly, because they belong to no part.
 *
 * Proposed from the extraction's `coverSection`, which rule 8 sets on every box
 * printed on the document's FIRST page. A wrong proposal here is visible and
 * correctable; a missing one exports a certificate with a blank name on it.
 *
 * Takes the EXTRACTED fields rather than the builder's editable copy, because
 * `coverSection` lives on `ExtractedField` — the same split as `questionRef`
 * and the matching sides. What the document said and what the author has done
 * since are two different records, and this proposal is drawn from the first.
 */
export function proposeCoverPointers(
  extracted: readonly Pick<ExtractedField, 'id' | 'label' | 'coverSection'>[],
): { candidateNameFieldId?: string } {
  const candidate = extracted.find(
    (f) =>
      f.coverSection === 'candidate_declaration' &&
      /candidate.*name|name.*candidate|full name/i.test(f.label),
  );
  return candidate ? { candidateNameFieldId: candidate.id } : {};
}

/* ------------------------------------------------------------------ *
 * Automatic marking: finding the printed boxes the verdict is written into
 * ------------------------------------------------------------------ */

/**
 * The declared boxes the marking writes, proposed from the PRINTED LABELS.
 *
 * WHY THIS IS PROPOSED RATHER THAN AUTHORED. `signOff` and the per-part verdict
 * marks have existed in the manifest model for a while and nothing in the
 * builder has ever written one — they were populated only by the authoring
 * SCRIPT this builder replaces. So a tool built here has always exported its
 * front page blank, and adding a verdict-writing engine without this would have
 * changed nothing an author could see.
 *
 * Asking instead would be worse than it sounds: this paper repeats its
 * certification block once per part, so a form with six parts would ask an
 * author to point at eighteen boxes before anything marked itself. The labels
 * are printed and consistent; reading them is the same trade
 * `proposeCoverPointers` already makes for the candidate name.
 *
 * A PROPOSAL IS NOT A DECISION, and every one of these is overridable and
 * absent-by-default. Nothing is written where the label does not clearly say
 * what the box is: a mark in the wrong box on a competency record states a
 * finding nobody made, and a blank box is the failure someone notices.
 */

/** Phrases that identify each printed box. Deliberately narrow. */
const SATISFACTORY = /candidate'?s?\s+responses?\s+were|responses?\s+were\s*:?\s*$|^satisfactory$/i;
const COACHING = /more\s+coaching|coaching\s+and\s*\/?\s*or\s+training/i;
const FURTHER_ACTION = /detail\s+further\s+action|further\s+action/i;
const RESULT = /assessment\s+result|overall\s+performance\s+meets|candidate\s+competent|not\s+yet\s+competent/i;
const ASSESSOR_NAME = /name\s+of\s+assessor|assessor'?s?\s+name/i;
const ASSESSOR_SIGNATURE = /assessor'?s?\s+signature/i;

/**
 * A field the verdict can be written into.
 *
 * `check_cross` and `boolean_yes_no` are the types whose FALSE is a recorded
 * finding, which is what lets one cell carry both halves of a pair. A choice
 * field with printed options works too — the value written is the option text
 * — but anything else (a text box, a signature) would take a boolean and render
 * it as the word "true", so it is refused rather than mis-marked.
 */
function markableValue(f: Pick<MarkingProposalField, 'type' | 'options'>, want: boolean): SubmissionValue | null {
  if (isSelfAnswering(f.type)) return want;
  const options = f.options ?? [];
  if (options.length === 0) return null;
  /*
    Match the option to the outcome by its own printed words, and REQUIRE a
    hit. Falling back to "the first option" would tick whichever box the model
    happened to list first, which on a Competent / Not-yet-Competent pair is a
    coin toss on the most consequential cell of the document.
  */
  const yes = /^(?:yes|satisfactory|competent|candidate competent|pass(?:ed)?)$/i;
  const no = /^(?:no|not satisfactory|not yet competent|candidate not yet competent|fail(?:ed)?)$/i;
  const wanted = options.find((o) => (want ? yes : no).test(o.trim()));
  return wanted ?? null;
}

/** Both halves of a verdict pair over one field, where the field can carry them. */
function pairOn(
  f: Pick<MarkingProposalField, 'id' | 'type' | 'options'>,
): { yes: DeclaredMark; no: DeclaredMark } | null {
  const yes = markableValue(f, true);
  const no = markableValue(f, false);
  if (yes === null || no === null || yes === no) return null;
  return { yes: { fieldId: f.id, value: yes }, no: { fieldId: f.id, value: no } };
}

/**
 * The little a marking proposal reads.
 *
 * Structural rather than `Pick<ExtractedField, …>` because both sides feed it:
 * the front page from the EXTRACTION (which is where `coverSection` lives, and
 * which is how the cover slice is taken) and each part from the builder's own
 * `FormField` list. A Pick of either would exclude the other.
 */
export interface MarkingProposalField {
  id: string;
  label: string;
  type: FormFieldType;
  options?: readonly string[];
}

/**
 * Propose the case-level sign-off block from the assessor-declaration fields.
 *
 * Scoped to the fields the caller gives it, which for the front page is the
 * COVER slice — this paper prints the same certification block at the end of
 * every part, so a whole-document search finds seven of each and could not say
 * which is the front one. That is the same trap the authoring script fell into,
 * where a global search matched seven fields, refused all seven as ambiguous,
 * and shipped an empty `signOff` that exported a certificate with no assessor
 * name, no date and no verdict.
 */
export function proposeSignOff(
  fields: readonly MarkingProposalField[],
): AssessmentToolManifest['signOff'] | undefined {
  const one = (re: RegExp) => {
    const hits = fields.filter((f) => re.test(f.label));
    // Exactly one, or nothing. Two candidates means the labels do not say which
    // box is meant, and picking either is a guess printed on a certificate.
    return hits.length === 1 ? hits[0]! : undefined;
  };

  const out: NonNullable<AssessmentToolManifest['signOff']> = {};

  const name = one(ASSESSOR_NAME);
  if (name) out.assessorNameFieldId = name.id;
  const signature = one(ASSESSOR_SIGNATURE);
  if (signature) out.assessorSignatureFieldId = signature.id;
  const date = fields.filter((f) => /^date$|signed\s+date|date\s+signed/i.test(f.label.trim()));
  if (date.length === 1) out.signedDateFieldId = date[0]!.id;

  const coaching = one(COACHING);
  const coachingPair = coaching ? pairOn(coaching) : null;
  if (coachingPair) {
    // Yes means coaching IS required, so it is the NOT-satisfactory half.
    out.moreCoachingRequiredYes = coachingPair.no;
    out.moreCoachingRequiredNo = coachingPair.yes;
  }

  const result = one(RESULT);
  const resultPair = result ? pairOn(result) : null;
  if (resultPair) {
    out.overallSatisfactory = resultPair.yes;
    out.overallNotSatisfactory = resultPair.no;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Propose one part's verdict boxes from the fields printed inside it.
 *
 * Scoped to the part's own slice for the same reason the sign-off is scoped to
 * the cover: the block repeats, and a part must claim its own copy or none.
 */
export function proposePartMarks(
  fields: readonly MarkingProposalField[],
): Pick<AssessmentPart, 'outcomeSatisfactory' | 'outcomeNotSatisfactory' | 'furtherActionFieldId'> {
  const out: Pick<
    AssessmentPart,
    'outcomeSatisfactory' | 'outcomeNotSatisfactory' | 'furtherActionFieldId'
  > = {};

  const verdicts = fields.filter((f) => SATISFACTORY.test(f.label));
  const verdict = verdicts.length === 1 ? pairOn(verdicts[0]!) : null;
  if (verdict) {
    out.outcomeSatisfactory = verdict.yes;
    out.outcomeNotSatisfactory = verdict.no;
  }

  const actions = fields.filter((f) => FURTHER_ACTION.test(f.label));
  if (actions.length === 1) out.furtherActionFieldId = actions[0]!.id;

  return out;
}

/** Assemble the manifest the publish step will validate and write. */
/** The sign-off block, from the cover's assessor-declaration fields alone. */
function signOffFrom(
  extracted: readonly Pick<ExtractedField, 'id' | 'label' | 'type' | 'options' | 'coverSection'>[],
): AssessmentToolManifest['signOff'] | undefined {
  return proposeSignOff(extracted.filter((f) => f.coverSection === 'assessor_declaration'));
}

export function buildManifest(
  parts: readonly DerivedPart[],
  extracted: readonly Pick<ExtractedField, 'id' | 'label' | 'type' | 'options' | 'coverSection'>[],
  setup?: Pick<SetupAnswers, 'theoryRendering'>,
): AssessmentToolManifest {
  return {
    // `sectionKey` is builder bookkeeping and must not reach the stored record.
    parts: parts.map(({ sectionKey: _sectionKey, ...part }) => part),
    ...proposeCoverPointers(extracted),
    /*
      THE FRONT PAGE, from the assessor-declaration slice only.

      Nothing in this builder has ever written `signOff`, so every tool it
      produced exported its certification block blank — no assessor name, no
      date, no verdict. That was invisible because a manifest with an empty
      `signOff` is perfectly valid and the export raises nothing.

      Scoped to `assessor_declaration` because this paper reprints the same
      block after every part. The authoring script searched the whole document,
      matched seven of each box, refused all seven as ambiguous, and shipped the
      empty `signOff` that made a signed competent case export a certificate
      with nobody's name on it.
    */
    ...(signOffFrom(extracted) ? { signOff: signOffFrom(extracted) } : {}),
    /*
      The setup answer follows the tool, not the draft.

      Step 1 asks how theory should be presented, and until now the answer had
      nowhere to live past publish: SetupAnswers is draft state, and the draft is
      gone by the time a candidate opens the assessment. `stacked` is the
      default and is what every theory part rendered as before, so only a
      deliberate one_per_screen is worth storing.
    */
    ...(setup?.theoryRendering === 'one_per_screen' ? { theoryRendering: 'one_per_screen' as const } : {}),
  };
}

/**
 * The logbook table for a part, for the UI to offer its columns from.
 *
 * Uses the same `fieldsInSection` slice `validateManifest` uses to check the
 * declared column exists, so the list an author picks from and the list the
 * validator checks against cannot disagree.
 */
export function logbookColumnsFor(
  part: Pick<AssessmentPart, 'startFieldId'>,
  fields: readonly FormField[],
): { key: string; label: string }[] {
  const table = fieldsInSection(fields, part.startFieldId).find((f) => f.type === 'repeating_group');
  return (table?.columns ?? []).map((c) => ({ key: c.key, label: c.label ?? c.key }));
}
