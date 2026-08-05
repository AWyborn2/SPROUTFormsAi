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
  type AssessmentPart,
  type AssessmentPathway,
  type AssessmentToolManifest,
  type ExtractedField,
  type FormField,
  type PartKind,
  type SetupAnswers,
  type StructureSection,
  type DraftAnswerKey,
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

/** Assemble the manifest the publish step will validate and write. */
export function buildManifest(
  parts: readonly DerivedPart[],
  extracted: readonly Pick<ExtractedField, 'id' | 'label' | 'coverSection'>[],
  setup?: Pick<SetupAnswers, 'theoryRendering'>,
): AssessmentToolManifest {
  return {
    // `sectionKey` is builder bookkeeping and must not reach the stored record.
    parts: parts.map(({ sectionKey: _sectionKey, ...part }) => part),
    ...proposeCoverPointers(extracted),
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
