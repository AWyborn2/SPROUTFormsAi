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

/** A column definition inside a repeating group (never enumerates blank rows). */
export interface RepeatingColumn {
  key: string;
  label: string;
  type: FormFieldType;
  options?: string[];
  required?: boolean;
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
