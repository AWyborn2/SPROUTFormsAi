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
  'textarea',
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

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

  validation?: FieldValidation;

  /** For repeating_group — the column shape, extracted once. */
  columns?: RepeatingColumn[];

  /**
   * For repeating_group — ordered pre-printed item labels of a fixed-item
   * checklist table (e.g. "Engine oil level"). The labels live in the FIRST
   * column (always text); absent for open row-entry tables. Never an empty
   * array (normalized to undefined).
   */
  fixedRows?: string[];

  /** For PDF-imported fields — round-trip render anchor. */
  sourcePosition?: SourcePosition;

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
