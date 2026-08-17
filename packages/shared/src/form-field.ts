/**
 * Form field model — the shared shape for both built-from-scratch and
 * PDF-imported fields. Fields live inside an (immutable) template version.
 */

/**
 * Field types. The first group is the builder's palette; the extraction-only
 * structural types (repeating_group, checkbox_group, boolean_yes_no) come from
 * the validated PDF extraction schema and are distinct on purpose.
 */
export const FORM_FIELD_TYPES = [
  'text',
  'number',
  'date',
  /**
   * Time of day, stored as an `HH:MM` 24-hour string (the native time input's
   * value format). Renders with a "Now" stamp button on fill surfaces; the
   * stamped value stays manually adjustable.
   */
  'time',
  'checkbox',
  'radio',
  'dropdown',
  'signature',
  'file_upload',
  'section_header',
  // structural / extraction types
  'repeating_group',
  'checkbox_group',
  'boolean_yes_no',
  /**
   * ✓ / ✗ — the same two-state-plus-unanswered shape as `boolean_yes_no`,
   * kept a DISTINCT type so the audit intent survives in the stored data: a
   * reviewer, an export or a later analysis can tell a pass/fail assessment
   * from an ordinary Yes/No question. Answered-ness deliberately routes
   * through the `boolean_yes_no` branch rather than a second rule, so a tick
   * is `true`, a cross is an explicit `false`, and only `null` is unanswered.
   */
  'check_cross',
  'textarea',
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

/**
 * The types whose answer is chosen from an `options` list — dropdown, radio
 * ("multiple choice") and checkbox_group.
 *
 * The single source of truth for "is this a choice field", shared by the editor
 * (which seeds and renders `options`) and the geometry path (which lets each
 * option carry its own placement box, drawn as a checkmark on export). One
 * predicate is what keeps those consumers from drifting apart.
 */
export const CHOICE_FIELD_TYPES: readonly FormFieldType[] = ['dropdown', 'radio', 'checkbox_group'];

/** Does this field answer from `options`? */
export function isChoiceField(type: FormFieldType): boolean {
  return CHOICE_FIELD_TYPES.includes(type);
}

/**
 * Types whose `false` is a RECORDED finding rather than an empty cell — the
 * only types a derived ✓/✗ can actually land in.
 *
 * A plain `checkbox` that is false is simply unticked, and drawing anything
 * would invent an answer. A `check_cross` that is false is an assessor saying
 * "I checked this and it failed" — which on the one artefact an investigation
 * reads must not be identical to never-assessed.
 *
 * THIS LIST WAS ALREADY WRITTEN TWICE — once in the PDF exporter, once in the
 * web app's mark description — and a third copy was about to be written by the
 * outcome-box picker. The exporter's copy is the one that decides whether a
 * mark reaches paper, so a picker offering a target the exporter would not draw
 * in is a mark an author believes is on a competency record and is not. One
 * list makes that divergence unexpressible.
 *
 * `string` rather than `FormFieldType` because repeating-group COLUMN types are
 * checked against the same rule, and a column's type is not a `FormFieldType`.
 */
export const SELF_ANSWERING_TYPES: readonly string[] = ['check_cross', 'boolean_yes_no'];

/** Is this type's `false` a finding in its own right? */
export function isSelfAnswering(type: string): boolean {
  return SELF_ANSWERING_TYPES.includes(type);
}

/** Field source — how it got into the template. */
export type FieldSource = 'built' | 'imported';

/** Validation rule descriptor (kept intentionally open for v1). */
export interface FieldValidation {
  kind: 'none' | 'email' | 'number' | 'regex' | 'minLength' | 'maxLength';
  /** Pattern / bound depending on `kind`. */
  value?: string | number;
  message?: string;
}

/**
 * Bounding box of an imported field on the source PDF, stored in PDF POINT
 * space (origin bottom-left, 72 units/inch) so it survives a re-render at any
 * DPI. Review-UI overlays convert points -> rendered pixels via the render
 * scale; export overlays values back at these exact points with pdf-lib.
 */
export interface SourcePosition {
  /** Zero-based page index. */
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Page dimensions in points — needed to map into any rendered raster. */
  pageWidth: number;
  pageHeight: number;
}

/**
 * A span along one axis in PDF points — x for a column, y for a row. `end` is
 * exclusive, so bands that touch are adjacent rather than overlapping, which is
 * how printed tables share a cell border.
 */
export interface GeometryBand {
  /** Column key for a column band; a stable row identity for a row band. */
  key: string;
  start: number;
  end: number;
}

/** One page's worth of a field's footprint, in PDF point space. */
export interface PageBox {
  /** Zero-based, and always the real page — never a default. */
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** That page's own dimensions; a mixed-orientation document needs these per page. */
  pageWidth: number;
  pageHeight: number;
  /** Explicit column spans. Absent on a scalar field. */
  columnBands?: GeometryBand[];
  /** Explicit row spans. Absent on a scalar field. */
  rowBands?: GeometryBand[];
  /**
   * For a checkbox_group / choice field: which option this box targets. A
   * multi-option field carries one segment per option, each naming its option
   * here, so the exporter draws a mark in the box of every SELECTED option.
   * Absent on a scalar or table segment, which targets the field as a whole.
   */
  optionKey?: string;
  /**
   * What this box draws, when an author has said.
   *
   * ABSENT IS THE DEFAULT AND THE DEFAULT IS TODAY'S BEHAVIOUR: the exporter
   * derives the mark from the field's type, exactly as it always has. That is
   * what keeps every placement authored before this existed byte-identical on
   * export — a stored geometry segment does not change meaning by gaining an
   * optional property nobody set.
   */
  markStyle?: MarkStyle;
}

/**
 * What a placed box draws, when an author overrides the type default.
 *
 * The vocabulary lives HERE, beside the geometry it hangs off, because this
 * file holds the shapes and imports nothing; `builder.ts` holds the authoring
 * layer and `geometry.ts` the resolvers, which is the same split `AnswerSet`
 * and `VisibilityCondition` already follow.
 *
 * NOT EVERY GLYPH DRAWS YET — `MARK_STYLES_DRAWN` in `builder.ts` is the honest
 * list, and the placement inspector says so beside the ones that do not. A
 * style the exporter silently ignored would be a mark an author believes is on
 * a competency record and is not.
 */
export const GLYPH_KINDS = [
  'tick_hand',
  'tick_block',
  'cross_hand',
  'ring',
  'typed',
  'signature',
  'stamp_pass',
  'stamp_na',
  'stamp_date',
  'initials',
  'highlight',
  'match_line',
] as const;
export type GlyphKind = (typeof GLYPH_KINDS)[number];

/** Ink a mark is drawn in. Three, because a competency record is not a palette. */
export const MARK_INKS = ['default', 'assessor_blue', 'ink_black'] as const;
export type MarkInk = (typeof MARK_INKS)[number];

export const MARK_SIZES = ['s', 'm', 'l'] as const;
export type MarkSize = (typeof MARK_SIZES)[number];

/** Every property optional; an absent `MarkStyle` is the field type's default. */
export interface MarkStyle {
  glyph?: GlyphKind;
  ink?: MarkInk;
  size?: MarkSize;
}

/**
 * How a matching question is PRESENTED. Never how it is marked.
 *
 * A matching question is stored as a choice field whose options are the
 * pairings (`matching.ts`), and `markTheory` reads `answerKey` and nothing
 * else. This decides only what the candidate manipulates on screen: dots and
 * connecting lines, or a tray of answers dragged into slots.
 *
 * Separate from the field's data for one reason: if presentation could reach
 * marking, there would be two places a question's verdict comes from.
 */
export const MATCH_MODES = ['line', 'drag'] as const;
export type MatchMode = (typeof MATCH_MODES)[number];

export interface MatchPresentation {
  mode: MatchMode;
  /** Render the prompt side as pictures. */
  leftImages?: boolean;
  /** Render the answer side as pictures. */
  rightImages?: boolean;
  /**
   * Uploaded picture per entry, by side and printed index — `l0`, `r2`.
   *
   * Asset ids, not data URLs. A data URL here would put a few hundred kilobytes
   * of base64 into every copy of the field, including the one served to a fill
   * surface and the one an export reads.
   */
  images?: Record<string, string>;
}

/**
 * A field's footprint across the document — the successor to `SourcePosition`
 * for anything that is not a single box on a single page. Resolvers and the
 * drop reasons for malformed geometry live in `geometry.ts`.
 *
 * There is deliberately no `confirmed` flag: only geometry a reviewer has
 * confirmed is ever written onto a published field, so absent means
 * unconfirmed. A flag would let an unconfirmed proposal be published and then
 * rely on every consumer remembering to check it.
 */
export interface FieldGeometry {
  segments: PageBox[];
}

/**
 * An ordered group of repeating-table columns that share ONE answer per row —
 * `OK`/`NA`, `✓`/`×`/`N-A`, `Pass`/`Fail`/`NA`. The columns keep their own
 * definitions; this is the grouping layer over them. Resolvers, validation
 * rules, and the drop reasons for malformed sets live in `answer-set.ts`.
 *
 * Single-answer only, deliberately. A multi-select variant would need its own
 * render affordance, its own definition of a complete row, and its own export
 * semantics — none of which the single-answer path implies.
 */
export interface AnswerSet {
  /** Stable within the field; survives column renames. */
  key: string;
  /** Optional heading for the collapsed narrow-viewport presentation. */
  label?: string;
  /** Member columns, in the order the source document printed them. */
  columnKeys: string[];
  /** Every row must carry an answer. Independent of the field's own `required`. */
  required?: boolean;
}

/** How a visibility condition compares the source field's answer. */
export type VisibilityOperator = 'equals' | 'notEquals';

/**
 * Shows or hides a field based on another field's ANSWER — distinct from
 * competency gating, which keys off what the filler holds. On a `section_header`
 * the condition governs every field up to the next header, so a multi-location
 * assessment is one authored condition rather than one per field.
 *
 * Sources are restricted to non-repeating fields, so evaluation needs no row
 * state and cannot loop.
 */
export interface VisibilityCondition {
  /** Id of the field whose answer is read. */
  fieldId: string;
  op: VisibilityOperator;
  value: string;
}

/**
 * Auto-calculation config for a repeating column — the cell computes itself
 * from the row's other cells and renders read-only on fill surfaces.
 *
 * Named calculations only, deliberately: a general formula engine would need
 * its own parser, cycle rules and error surface; a named calculation is one
 * tested function. The semantics live in `time-calc.ts`.
 *
 * - `total_hours` — the timesheet shape: finish − start − lunch, times of day
 *   in `HH:MM`, result in decimal hours.
 * - `machine_hours` — the equipment-logbook shape: finish − start where both
 *   are METER READINGS (plain decimals off the machine's hour meter), result
 *   in decimal hours. Distinct from `total_hours` because meter readings are
 *   not times of day: there is no midnight wrap, and a finish at or below the
 *   start is a mis-entry rather than a night shift. Making the filler enter
 *   both readings and deriving the duration is what stops a logbook hour
 *   column being typed as whatever reaches a threshold.
 */
export interface ColumnCalc {
  kind: 'total_hours' | 'machine_hours';
  /** Key of the start column — `HH:MM` time, or a meter reading. */
  startKey: string;
  /** Key of the finish column — `HH:MM` time, or a meter reading. */
  finishKey: string;
  /**
   * `total_hours` only — key of the lunch column, subtracted as a DURATION
   * (`HH:MM` or a plain decimal-hours number). Optional: absent, blank or zero
   * subtracts nothing (a task finished before any break).
   */
  lunchKey?: string;
}

/** A column definition inside a repeating group (never enumerates blank rows). */
export interface RepeatingColumn {
  key: string;
  label: string;
  type: FormFieldType;
  options?: string[];
  required?: boolean;
  /** Present ⇒ the cell auto-computes and is read-only on fill surfaces. */
  calc?: ColumnCalc;
  /**
   * `date` / `time` columns only — seed the cell with today's date (or the
   * current time) the MOMENT a new row is added, instead of leaving it blank
   * for manual entry. The value stays editable: a shift logged the morning
   * after can be corrected, and a "Today" / "Now" button re-stamps it. Opt-in,
   * so a table without it keeps blank-on-add.
   *
   * The point on a task logbook: an operator adds a row to start logging what
   * they are on right now, and the date they started is exactly today — asking
   * them to type it is a step that only ever produces the value the app already
   * knows. Not a hard timestamp: it is a default, not a lock, because honest
   * back-dating of a prior shift must stay possible.
   */
  autoStamp?: boolean;
}

export interface FormField {
  id: string;
  type: FormFieldType;
  label: string;
  required: boolean;
  help?: string;
  placeholder?: string;
  description?: string;
  source: FieldSource;

  /** For dropdown / radio. */
  options?: string[];

  /** For checkbox_group. */
  selectionType?: 'single' | 'multiple';

  /**
   * For a choice field (dropdown / radio): draw the SELECTED VALUE as text in a
   * single hand-drawn placement box, instead of a checkmark in each selected
   * option's own box. Absent/false is the default — per-option marks. This is
   * the write-in case: a PDF with one blank to print the chosen value into,
   * rather than a row of tick boxes.
   */
  printSelectedValue?: boolean;

  validation?: FieldValidation;

  /** For repeating_group — the column shape, extracted once. */
  columns?: RepeatingColumn[];

  /**
   * For repeating_group — column groups sharing one answer per row. Absent
   * means every column is an independent cell, which is the pre-existing
   * behaviour and stays valid.
   */
  answerSets?: AnswerSet[];

  /** Hides this field (or, on a section_header, its whole section) by answer. */
  visibleWhen?: VisibilityCondition;

  /**
   * For repeating_group — ordered pre-printed item labels of a fixed-item
   * checklist table (e.g. "Engine oil level"). The labels live in the FIRST
   * column (always text); absent for open row-entry tables. Never an empty
   * array (normalized to undefined).
   */
  fixedRows?: string[];

  /** For PDF-imported fields — round-trip render anchor. */
  sourcePosition?: SourcePosition;

  /**
   * For PDF-imported fields — multi-page footprint with explicit column and
   * row bands, for tables that span page breaks or whose columns are not
   * evenly spaced. Supersedes `sourcePosition` where present, but never
   * replaces it: an AcroForm widget is one box and stays described by one.
   * Written only once a reviewer has confirmed it, so absent means unconfirmed.
   * See geometry.ts.
   */
  geometry?: FieldGeometry;

  /** Confidence [0,1] from extraction; undefined for built fields. */
  confidence?: number;

  /** Layout hint on a 12-col grid (builder). */
  colSpan?: number;

  /**
   * For an auto-marked choice question: the option values that TOGETHER make a
   * correct answer. Marking is exact-set-match — a strict subset is wrong (the
   * candidate missed a required option) and so is a superset (they picked a
   * wrong one). That single rule covers both printed shapes: an ordinary
   * single-answer question is a one-element key, and a "select correct answers"
   * question is a multi-element one, with no separate partial-credit mode to
   * configure or disagree about.
   *
   * Absent means the question is not auto-marked and contributes no mark.
   */
  answerKey?: string[];

  /**
   * A choice the ASSESSOR makes, recording a judgement — not a question with a
   * right answer.
   *
   * An assessment paper is full of these: "Assessment Result — Candidate
   * Competent / Candidate not yet Competent", "More coaching required? Yes /
   * No", "The Candidate's responses were: Satisfactory / Not Satisfactory".
   * Extraction reads each as an ordinary choice question, because on the page
   * that is exactly what it looks like — a prompt with two printed options.
   *
   * WITHOUT THIS THEY SIT IN THE ANSWER-KEY LIST FOREVER. There is no correct
   * answer to key, so the author cannot clear them, the "N of M keyed" counter
   * can never complete, and a genuinely unkeyed question is hidden among a
   * dozen that were never keyable.
   *
   * NOT A TYPE CHANGE, deliberately. Retyping to `check_cross` would drop the
   * printed option labels and put a bare ✓/✗ where the paper says "Candidate
   * Competent" — the online form would stop matching the document at exactly
   * the cell an auditor reads first. The field stays what it is; this says how
   * it is JUDGED.
   *
   * A verdict field never carries an `answerKey`: `markTheory` skips a field
   * without one, so marking already does the right thing, and the authoring
   * layer clears any key when the flag is set rather than storing both.
   */
  assessorVerdict?: boolean;

  /**
   * Shown to the candidate when they answer this question incorrectly in
   * interactive theory mode. Optional — absent means no hint is shown.
   * Authored in the builder's Answer Key step.
   */
  answerHint?: string;

  /**
   * Where this question's derived ✓/✗ is written. Required whenever
   * `answerKey` is set — a key with nowhere to land would compute a mark that
   * never reaches the page, which on an evidence document reads as an
   * unanswered question rather than a marked one.
   */
  outcomeTarget?: OutcomeTarget;

  /**
   * For a matching question — how it is drawn on a fill surface.
   *
   * Render-only. Marking reads `answerKey`, the exporter reads the geometry,
   * and neither looks at this. Absent means the grouped pairing list that
   * `FieldRenderer` already renders, which stays the correct fallback for a
   * question nobody has chosen a presentation for.
   */
  matchPresentation?: MatchPresentation;

  /**
   * A builder-authoring override: this question is NOT a matching question,
   * whatever the extraction read.
   *
   * The extraction can false-positive an ordinary multiple-choice as a matching
   * question — it emits `matchLeft`/`matchRight` and empties `options` — and the
   * Answer Key step then hides the type and keying controls, because a matching
   * question is authored through the pair builder. That left the field
   * unfixable: nothing on the editable copy could say "the extraction was
   * wrong". This flag is that escape hatch. Builder-only; marking and export
   * never read it.
   */
  notMatching?: boolean;
}

/**
 * Where a derived mark lands. Either a scalar field of its own (typically a
 * `check_cross`), or one cell of a repeating group addressed by row and column
 * — the shape printed assessment papers actually use, where each question's
 * outcome box is a cell in the margin table rather than a standalone widget.
 */
export interface OutcomeTarget {
  fieldId: string;
  /** Repeating-group targets only: which row. */
  rowKey?: string;
  /** Repeating-group targets only: which column. */
  columnKey?: string;
}

/** Container/layout config for a template (builder canvas). */
export interface FormContainer {
  maxWidth: number;
  padding: number;
  radius: number;
  borderWidth: number;
  borderColor: string;
  background: string;
  shadow: 'none' | 'sm' | 'md' | 'lg';
}

export const DEFAULT_CONTAINER: FormContainer = {
  maxWidth: 600,
  padding: 26,
  radius: 14,
  borderWidth: 1,
  borderColor: '',
  background: '',
  shadow: 'lg',
};
