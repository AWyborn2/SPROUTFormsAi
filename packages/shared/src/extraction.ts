/**
 * PDF extraction schema — the shape Claude returns via the forced
 * `extract_form_fields` tool call (with a text/```json fallback). Proven on
 * real compliance forms; see the implementation plan's PDF pipeline section.
 */

import type { AnswerSet, FormFieldType, RepeatingColumn, SourcePosition } from './form-field.js';

/** Per-field review status in the import UI. */
export type ExtractionStatus = 'ok' | 'review' | 'low';

/**
 * A single extracted field. Superset of the built-field shape — carries a
 * confidence score and (where known) the source position for round-trip.
 */
export interface ExtractedField {
  /** Stable id assigned during extraction. */
  id: string;
  label: string;
  type: FormFieldType;
  /** [0,1]. Low values are surfaced distinctly in the review UI. */
  confidence: number;
  required?: boolean;
  description?: string;
  options?: string[];
  selectionType?: 'single' | 'multiple';
  /** For repeating_group — extracted once, never per blank row. */
  columns?: RepeatingColumn[];
  /**
   * For repeating_group — column groups the extractor believes share one answer
   * per row (`OK`/`NA`, `✓`/`×`/`N-A`). A proposal, never applied silently: the
   * reviewer accepts, ungroups, or regroups before publish.
   */
  answerSets?: AnswerSet[];
  /**
   * For repeating_group — ordered pre-printed item labels of a fixed-item
   * checklist table; the labels also occupy the first (text) column. Absent
   * for open row-entry tables; never an empty array.
   */
  fixedRows?: string[];
  sourcePosition?: SourcePosition;
  /** Reviewer-facing note, e.g. "detected as text — likely a signature field". */
  note?: string;
}

/** The full result of an extraction run. */
export interface ExtractionResult {
  sourceType: 'pdf_import';
  /** Which path produced this: deterministic AcroForm read vs AI extraction. */
  path: 'acroform' | 'ai';
  fileName: string;
  pageCount: number;
  fields: ExtractedField[];
  /**
   * Free-text observations that don't map to any single field but help whoever
   * reviews the extraction (mergeable duplicate sections, validation needs).
   */
  designNotes: string[];
}

/** Confidence threshold below which a field is flagged for manual review. */
export const LOW_CONFIDENCE_THRESHOLD = 0.75;

export function statusForConfidence(confidence: number): ExtractionStatus {
  if (confidence < 0.65) return 'low';
  if (confidence < LOW_CONFIDENCE_THRESHOLD) return 'review';
  return 'ok';
}
