/**
 * PDF extraction schema — the shape Claude returns via the forced
 * `extract_form_fields` tool call (with a text/```json fallback). Proven on
 * real compliance forms; see the implementation plan's PDF pipeline section.
 */

import type { AnswerSet, FormFieldType, RepeatingColumn, SourcePosition } from './form-field.js';

/** Per-field review status in the import UI. */
export type ExtractionStatus = 'ok' | 'review' | 'low';

/**
 * What kind of document is being imported.
 *
 * Extraction reads very differently by document class, and a single generic
 * prompt gets some classes badly wrong. The case that forced this: on a
 * competency assessment paper, half the theory questions came back as
 * answerable choice fields and half as rows inside a summary table — the same
 * content, two incompatible treatments, leaving fifteen questions unanswerable.
 * A per-type instruction set tells the model what the class's structures MEAN.
 *
 * `generic` keeps the original behaviour and stays the default, so an
 * unclassified import behaves exactly as it did before types existed.
 */
export const DOCUMENT_TYPES = [
  'generic',
  'assessment',
  'checklist',
  'report',
  'timesheet',
  'order_form',
  'record',
  'plan',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** Human labels for the import-time picker. */
export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  generic: 'General form',
  assessment: 'Competency assessment',
  checklist: 'Inspection checklist',
  report: 'Report',
  timesheet: 'Timesheet',
  order_form: 'Order form',
  record: 'Record',
  plan: 'Plan',
};

/** One-line hints shown beside each choice at import. */
export const DOCUMENT_TYPE_HINTS: Record<DocumentType, string> = {
  generic: 'No special handling — the default reading.',
  assessment: 'Theory questions, practical checklists, logbooks, sign-off outcomes.',
  checklist: 'Repeating item rows with tick or N/A columns.',
  report: 'Narrative sections with supporting figures.',
  timesheet: 'Dated rows with start, finish and hours.',
  order_form: 'Line items with quantity, description and price.',
  record: 'A register of entries kept over time.',
  plan: 'Staged or scheduled work with owners and dates.',
};

/**
 * Which of the N printed groups a split-table field is, in left-to-right order.
 *
 * Review-only, produced by `splitTableGroups` when the reviewer breaks one
 * flattened side-by-side block into its printed groups — never emitted by
 * extraction and never published. It rides on the review field so grid
 * derivation can select the correspondingly-positioned proposal on the page
 * instead of coin-flipping between structurally-identical tables (R2).
 */
export interface GroupOrdinal {
  /** 0-based position among the groups, in printed left-to-right order. */
  index: number;
  /** How many groups the source table was split into (the ordinal's range). */
  count: number;
}

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
  /**
   * For a choice field — a reviewer decision (never extracted): print the
   * selected value as text in one box instead of a checkmark per option. Mirrors
   * `FormField.printSelectedValue` so it survives the review round-trip.
   */
  printSelectedValue?: boolean;
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
  /**
   * For a fixed-item checklist printed as N side-by-side column groups sharing
   * one header — the number of those groups. A reviewer-facing hint the split
   * control pre-fills, never a value applied on its own: extraction proposes it,
   * the reviewer chooses the final count. Absent when the table is a single
   * column of items; never `< 2`.
   */
  columnGroups?: number;
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
