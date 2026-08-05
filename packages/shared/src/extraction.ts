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
  /**
   * The question reference as PRINTED on the page — "Q1", "BBM Q3", "7".
   *
   * Carried by a question AND by its outcome box, which is what links the two.
   * A printed reference rather than adjacency because adjacency shifts: a single
   * question whose outcome box the model missed re-pairs every question after
   * it, silently, and the result reads as a complete mapping. A reference has to
   * MATCH, so a gap stays a gap.
   *
   * Not unique document-wide — this paper restarts its numbering in each
   * section — so it is resolved locally. See `linkOutcomeTargets`.
   */
  questionRef?: string;
  /**
   * Which of the cover page's three sections this field belongs to.
   *
   * A competency paper's front page is three documents on one sheet — who the
   * candidate is, what they must already hold and which route they take, and
   * what the assessor concluded — and the split is ALWAYS those three. Naming
   * the section on the field is what lets the parts be anchored without
   * depending on the model having emitted a heading in the right place.
   *
   * Absent on every field that is not on the cover page, and on any extraction
   * that predates the rule.
   */
  coverSection?: CoverSection;
  /**
   * A matching question's PROMPT side, verbatim, in printed order.
   *
   * Present together with `matchRight` or not at all. Carried as two lists
   * rather than as pre-built options because the pairing options and the answer
   * key are DERIVED from them (`buildMatchingQuestion`), and a model asked for
   * the derived form guesses at pairings nobody printed.
   *
   * Where the prompts are pictures, each entry describes its image ("Sign photo
   * — red pyramid"); the picture itself is supplied during authoring.
   */
  matchLeft?: string[];
  /** A matching question's ANSWER side, verbatim, in printed order. */
  matchRight?: string[];
  /**
   * The printed page range the extraction pass that produced this field was
   * looking at.
   *
   * STAMPED IN CODE, NEVER ASKED FOR. A long document is extracted a few pages
   * at a time, and the splitter knows exactly which pages went into each call —
   * so this is a fact the pipeline already has and the model can only guess at.
   * Asking for it would put a hallucinable number on the one thing that
   * disambiguates three character-identical practical parts.
   *
   * NOT `sourcePosition`, which needs the full x/y/width/height geometry the AI
   * path cannot produce. This says which pages a field came from, not where on
   * one it sits.
   *
   * 1-based and inclusive, matching the page numbers printed in a footer.
   */
  sourcePages?: { from: number; to: number };
  sourcePosition?: SourcePosition;
  /** Reviewer-facing note, e.g. "detected as text — likely a signature field". */
  note?: string;
}

/**
 * The three sections a competency paper's cover page always splits into.
 *
 * Fixed rather than free text, and fixed at THREE, because the split is a
 * property of the document class rather than of any one paper: identity,
 * eligibility, verdict. A free-text section name would let two extractions of
 * the same page disagree about which boxes gate enrolment.
 */
export const COVER_SECTIONS = [
  'candidate_declaration',
  'pathway_prerequisites',
  'assessor_declaration',
] as const;
export type CoverSection = (typeof COVER_SECTIONS)[number];

/** Human labels, in printed order. */
export const COVER_SECTION_LABELS: Record<CoverSection, string> = {
  candidate_declaration: 'Candidate declaration',
  pathway_prerequisites: 'Pathway & prerequisites',
  assessor_declaration: 'Assessor feedback & declaration',
};

/**
 * A matching question the extraction read both sides of.
 *
 * `isAuthorableMatch` is the question the authoring UI actually asks: can the
 * pair builder open pre-filled, or does it start blank? One side is worth
 * seeding from and is NOT enough to build a question — see `matching.ts`.
 */
export function hasBothMatchSides(
  field: Pick<ExtractedField, 'matchLeft' | 'matchRight'>,
): boolean {
  return (field.matchLeft?.length ?? 0) > 0 && (field.matchRight?.length ?? 0) > 0;
}

/** Whether the extraction saw anything of a matching question's two sides. */
export function hasAnyMatchSide(
  field: Pick<ExtractedField, 'matchLeft' | 'matchRight'>,
): boolean {
  return (field.matchLeft?.length ?? 0) > 0 || (field.matchRight?.length ?? 0) > 0;
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
