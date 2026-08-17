/**
 * The structured diff between a RAW extraction and the form the reviewer
 * published — the training signal of the (human-gated) extraction learning loop.
 *
 * Stage 2a stores the raw extraction (`extraction_captures`). This module is
 * Stage 2b's engine: a pure function that aligns the raw fields against the
 * reviewed fields and records, per field, what the reviewer changed. It RECORDS;
 * it does not judge which side was right and it does not cluster — clustering
 * into content-free shapes (the cross-org privacy boundary) is a later step that
 * reads these records. See docs/plans/2026-08-17-001-feat-extraction-learning-loop-plan.md.
 *
 * WHY A PURE FUNCTION IN SHARED. The two sides only ever sit together on the
 * client, at publish, inside the import review session — the raw
 * `ExtractionResult` and the reviewer's edited field list. The API stores the
 * review snapshot opaque on purpose, so it cannot compute this itself. Keeping
 * the diff here makes it testable without a browser and reusable server-side if
 * the snapshot shape is ever exposed.
 *
 * WHAT IS AND IS NOT A CORRECTION. Geometry/placement edits and the
 * `resolved`/confirm flags are excluded: placement is layout, and `resolved` is
 * the reviewer affirming a field, not correcting it. Neither says the extraction
 * read the page wrongly, which is the only thing this signal is for.
 */
import type { AnswerSet, FormFieldType } from './form-field.js';
import type { DocumentType } from './extraction.js';

/** The correction kinds, one per way a reviewer changes an extracted field. */
export type CorrectionKind =
  | 'retype'
  | 'selection-type-changed'
  | 'options-edited'
  | 'fixed-rows-edited'
  | 'answer-sets-changed'
  | 'label-rewritten'
  | 'question-ref-edited'
  | 'split'
  | 'deleted'
  | 'added';

/** The 1-based printed page range the raw field was extracted from, when known. */
export interface SourcePages {
  from: number;
  to: number;
}

interface CorrectionBase {
  /** The field this correction concerns — the raw id, except `added` (new id). */
  fieldId: string;
  /**
   * The page range the raw field came from, copied verbatim. Present only where
   * the raw field carried one (the batched AI path). It is what lets a later
   * step tell a batch-boundary correction from an ordinary one, so it is kept on
   * the correction rather than looked up.
   */
  sourcePages?: SourcePages;
}

/**
 * One recorded change. A single field can yield several — a retype AND an
 * options edit, say — because each is a distinct signal about a distinct
 * failure. Verbatim text (`from`/`to`/`wasLabel`/`label`) is kept because the
 * record is org-scoped; the cross-org clustering step derives content-free keys
 * from these and never uses the text itself.
 */
export type Correction =
  | (CorrectionBase & { kind: 'retype'; from: FormFieldType; to: FormFieldType })
  | (CorrectionBase & {
      kind: 'selection-type-changed';
      from?: 'single' | 'multiple';
      to?: 'single' | 'multiple';
    })
  | (CorrectionBase & { kind: 'options-edited'; from: string[]; to: string[] })
  | (CorrectionBase & { kind: 'fixed-rows-edited'; from: string[]; to: string[] })
  | (CorrectionBase & { kind: 'answer-sets-changed'; fromCount: number; toCount: number })
  | (CorrectionBase & { kind: 'label-rewritten'; from: string; to: string })
  | (CorrectionBase & { kind: 'question-ref-edited'; from?: string; to?: string })
  /** One raw table the reviewer broke into `into` printed groups. */
  | (CorrectionBase & { kind: 'split'; into: number })
  /** A raw field the reviewer removed — often a spurious or orphaned extraction. */
  | (CorrectionBase & { kind: 'deleted'; wasType: FormFieldType; wasLabel: string })
  /** A field the reviewer added — a box the extraction missed. */
  | (CorrectionBase & {
      kind: 'added';
      addedType: FormFieldType;
      label: string;
      /** The reviewed field this one follows, or null when it is first. */
      afterFieldId: string | null;
    });

/** The full diff for one extraction → publish, plus the context to slice it by. */
export interface ExtractionCorrections {
  /** The capture (`extraction_captures.id`) this diff is against, when known. */
  captureId?: string;
  documentType?: DocumentType;
  path: 'acroform' | 'ai';
  pageCount: number;
  corrections: Correction[];
}

/**
 * The minimal field shape the diff reads. Both `ExtractedField` (raw) and a
 * reviewed `FormField` (with its review-side `questionRef` folded back in) are
 * structurally assignable to it, so callers pass their own arrays unchanged.
 */
export interface DiffField {
  id: string;
  type: FormFieldType;
  label: string;
  options?: string[];
  selectionType?: 'single' | 'multiple';
  fixedRows?: string[];
  answerSets?: AnswerSet[];
  questionRef?: string;
  sourcePages?: SourcePages;
}

/** Context the caller supplies; it is not derivable from the field lists alone. */
export interface DiffContext {
  captureId?: string;
  documentType?: DocumentType;
  path: 'acroform' | 'ai';
  pageCount: number;
}

function arraysEqual(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** Answer sets compared by identity of membership, order-insensitive within a set. */
function answerSetsEqual(a: AnswerSet[] | undefined, b: AnswerSet[] | undefined): boolean {
  const norm = (sets: AnswerSet[] | undefined): string =>
    JSON.stringify(
      (sets ?? [])
        .map((s) => ({ key: s.key, columnKeys: [...s.columnKeys].sort() }))
        .sort((p, q) => p.key.localeCompare(q.key)),
    );
  return norm(a) === norm(b);
}

/** Escape a string for use as a literal inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The reviewed split-children of a raw table, if the reviewer split it.
 *
 * `splitTableGroups` mints new ids and labels the parts "<label> (g of N)". So a
 * raw table the reviewer split leaves its id absent from the reviewed list and
 * two-or-more new-id fields whose labels match that pattern against the source
 * label. Recognising them lets the diff record ONE `split` rather than a delete
 * plus N adds — the signal is "one table became N", not "a field vanished and
 * some appeared".
 */
function splitChildrenOf(raw: DiffField, reviewed: readonly DiffField[]): DiffField[] {
  const pattern = new RegExp(`^${escapeRegExp(raw.label)} \\(\\d+ of (\\d+)\\)$`);
  const children = reviewed.filter((f) => pattern.test(f.label));
  if (children.length < 2) return [];
  // Only treat it as a split when the printed count agrees across the children —
  // a stray "(1 of 2)" label that isn't really a split of this table shouldn't
  // swallow unrelated added fields.
  const counts = new Set(children.map((f) => Number(pattern.exec(f.label)![1])));
  if (counts.size !== 1) return [];
  return children;
}

/**
 * Diff a raw extraction against the reviewer's published fields.
 *
 * Aligns by stable id: a field present on both sides yields one correction per
 * property the reviewer changed; a raw id gone from the reviewed list is a
 * `deleted` (unless it was split); a reviewed id absent from the raw list is an
 * `added` (unless it is a split child). Deterministic order: corrections for
 * raw fields in raw order, then additions in reviewed order.
 */
export function diffExtraction(
  raw: readonly DiffField[],
  reviewed: readonly DiffField[],
  context: DiffContext,
): ExtractionCorrections {
  const reviewedById = new Map(reviewed.map((f) => [f.id, f]));
  const corrections: Correction[] = [];
  // Reviewed ids accounted for as split children, so they are not read as `added`.
  const consumedReviewedIds = new Set<string>();

  for (const rawField of raw) {
    const base: CorrectionBase = {
      fieldId: rawField.id,
      ...(rawField.sourcePages ? { sourcePages: rawField.sourcePages } : {}),
    };
    const reviewedField = reviewedById.get(rawField.id);

    if (!reviewedField) {
      // The id is gone. Either the reviewer split this table into new-id parts,
      // or they deleted it outright.
      const children = splitChildrenOf(rawField, reviewed);
      if (children.length >= 2) {
        for (const c of children) consumedReviewedIds.add(c.id);
        corrections.push({ ...base, kind: 'split', into: children.length });
      } else {
        corrections.push({
          ...base,
          kind: 'deleted',
          wasType: rawField.type,
          wasLabel: rawField.label,
        });
      }
      continue;
    }

    // Present on both sides — record every property the reviewer changed.
    if (rawField.type !== reviewedField.type) {
      corrections.push({ ...base, kind: 'retype', from: rawField.type, to: reviewedField.type });
    }
    if (rawField.selectionType !== reviewedField.selectionType) {
      corrections.push({
        ...base,
        kind: 'selection-type-changed',
        ...(rawField.selectionType ? { from: rawField.selectionType } : {}),
        ...(reviewedField.selectionType ? { to: reviewedField.selectionType } : {}),
      });
    }
    if (!arraysEqual(rawField.options, reviewedField.options)) {
      corrections.push({
        ...base,
        kind: 'options-edited',
        from: rawField.options ?? [],
        to: reviewedField.options ?? [],
      });
    }
    if (!arraysEqual(rawField.fixedRows, reviewedField.fixedRows)) {
      corrections.push({
        ...base,
        kind: 'fixed-rows-edited',
        from: rawField.fixedRows ?? [],
        to: reviewedField.fixedRows ?? [],
      });
    }
    if (!answerSetsEqual(rawField.answerSets, reviewedField.answerSets)) {
      corrections.push({
        ...base,
        kind: 'answer-sets-changed',
        fromCount: rawField.answerSets?.length ?? 0,
        toCount: reviewedField.answerSets?.length ?? 0,
      });
    }
    if (rawField.label !== reviewedField.label) {
      corrections.push({
        ...base,
        kind: 'label-rewritten',
        from: rawField.label,
        to: reviewedField.label,
      });
    }
    if ((rawField.questionRef ?? '') !== (reviewedField.questionRef ?? '')) {
      corrections.push({
        ...base,
        kind: 'question-ref-edited',
        ...(rawField.questionRef ? { from: rawField.questionRef } : {}),
        ...(reviewedField.questionRef ? { to: reviewedField.questionRef } : {}),
      });
    }
  }

  // Anything in the reviewed list with no raw id and not a split child is a field
  // the reviewer added — a box the extraction missed. `afterFieldId` is the
  // reviewed field it follows, so a later step can place it in context.
  const rawIds = new Set(raw.map((f) => f.id));
  let previousReviewedId: string | null = null;
  for (const reviewedField of reviewed) {
    if (
      !rawIds.has(reviewedField.id) &&
      !consumedReviewedIds.has(reviewedField.id)
    ) {
      corrections.push({
        fieldId: reviewedField.id,
        kind: 'added',
        addedType: reviewedField.type,
        label: reviewedField.label,
        afterFieldId: previousReviewedId,
      });
    }
    previousReviewedId = reviewedField.id;
  }

  return {
    ...(context.captureId ? { captureId: context.captureId } : {}),
    ...(context.documentType ? { documentType: context.documentType } : {}),
    path: context.path,
    pageCount: context.pageCount,
    corrections,
  };
}
