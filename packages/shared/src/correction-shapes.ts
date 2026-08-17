/**
 * Cluster key for one correction — the CROSS-ORG PRIVACY BOUNDARY of the
 * extraction learning loop.
 *
 * A stored `Correction` (see `extraction-corrections.ts`) carries verbatim field
 * text, because a correction record is org-scoped and the org's own reviewer can
 * be shown its own examples. But the distiller aggregates corrections ACROSS
 * orgs to see which mistakes recur — and a general rule distilled from many orgs
 * must never carry one org's content. `shapeOf` is what enforces that: it maps a
 * correction to a content-free key built ONLY from types, counts and structural
 * predicates. The label that a predicate matched on (a bare lettered option, a
 * cleared option list) decides the key but never enters it.
 *
 * Two corrections that differ only in their field text share a shape; that is
 * the whole point — the shape is what recurs, the text is what doesn't.
 */
import type { Correction, CorrectionKind } from './extraction-corrections.js';
import type { FormFieldType } from './form-field.js';

/**
 * A label that is nothing but a lettered/numbered option marker — "c)", "b.",
 * "iv)" — with little or no text after it. This is the shape of a choice
 * orphaned from its question by a page-batch boundary (rule 19): the reviewer
 * deletes it. The MATCH is used to pick the key; the matched text is discarded.
 */
export function isBareLetteredOption(label: string): boolean {
  const trimmed = label.trim();
  // A single letter/roman-ish marker or digit, then a ) or . delimiter, then at
  // most a few words — a real question stem runs much longer.
  if (!/^(?:[a-z]|[ivx]{1,4}|\d{1,2})\s*[).]/i.test(trimmed)) return false;
  const after = trimmed.replace(/^(?:[a-z]|[ivx]{1,4}|\d{1,2})\s*[).]\s*/i, '');
  // Count words, not characters, so the length of the words themselves (the
  // content) does not affect the decision.
  return after.split(/\s+/).filter(Boolean).length <= 5;
}

/** The direction a count moved, as a content-free descriptor. */
function delta(from: number, to: number): 'added' | 'removed' | 'changed' {
  if (to > from) return 'added';
  if (to < from) return 'removed';
  return 'changed';
}

/** Whether a nullable side is present, as a content-free flag. */
function presence(v: string | undefined): 'set' | 'unset' {
  return v ? 'set' : 'unset';
}

/**
 * The content-free cluster key for a correction. Stable and deterministic: the
 * same shape of change always yields the same string, and no field text ever
 * appears in it.
 */
export function shapeOf(correction: Correction): string {
  switch (correction.kind) {
    case 'retype':
      return `retype:${correction.from}→${correction.to}`;
    case 'selection-type-changed':
      return `selection-type:${correction.from ?? 'none'}→${correction.to ?? 'none'}`;
    case 'options-edited':
      return `options-edited:${
        correction.to.length === 0
          ? 'cleared'
          : correction.from.length === 0
            ? 'added'
            : delta(correction.from.length, correction.to.length)
      }`;
    case 'fixed-rows-edited':
      return `fixed-rows-edited:${delta(correction.from.length, correction.to.length)}`;
    case 'answer-sets-changed':
      return `answer-sets-changed:${delta(correction.fromCount, correction.toCount)}`;
    case 'label-rewritten':
      return 'label-rewritten';
    case 'question-ref-edited':
      return `question-ref-edited:${presence(correction.from)}→${presence(correction.to)}`;
    case 'split':
      return `split:into-${correction.into}`;
    case 'deleted':
      // The rule-19 signal: an orphaned lettered choice the reviewer removed,
      // told apart from any other deletion by the label's SHAPE, not its text.
      return isBareLetteredOption(correction.wasLabel)
        ? 'deleted:orphan-option'
        : `deleted:${correction.wasType}`;
    case 'added':
      return `added:${correction.addedType}`;
    default: {
      // Exhaustiveness guard: a new CorrectionKind must add a case above.
      const never: never = correction;
      return `unknown:${(never as { kind: CorrectionKind }).kind}`;
    }
  }
}

/** Every distinct shape in a batch of corrections, with how often each occurs. */
export function tallyShapes(corrections: readonly Correction[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of corrections) {
    const shape = shapeOf(c);
    counts.set(shape, (counts.get(shape) ?? 0) + 1);
  }
  return counts;
}

/** The field types a shape key can name, re-exported for callers building filters. */
export type ShapeFieldType = FormFieldType;
