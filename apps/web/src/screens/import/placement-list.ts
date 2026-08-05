/**
 * The placement screen's field list: grouped, counted, filterable, and paired.
 *
 * WHY THIS EXISTS. The Track Dozer paper produces roughly three hundred boxes,
 * and the list was a single flat run of them with no grouping, no counts and no
 * filter — the two-hour manual session `docs/runbooks/track-dozer-first-end-to-end.md`
 * describes is mostly navigating it. Grouping by part turns "where am I" into a
 * glance, and the per-group counts turn "am I finished" into a number rather
 * than a scroll.
 *
 * AND IT MAKES THE TWO-LOCATION REQUIREMENT VISIBLE. A marked theory question
 * has TWO printed places: where the candidate's ANSWER appears, and where the
 * assessor's VERDICT appears. Both are geometry — the response on the question
 * field, the outcome on the field its `outcomeTarget` names — but they are one
 * unit of authoring work. Shown as two unrelated rows in a list of three
 * hundred, one of them is how the other ends up unplaced: the export then draws
 * the candidate's answer with no verdict beside it, or a verdict with no answer,
 * on the document that says whether somebody may operate the machine.
 *
 * Nothing here reads or writes geometry. It decides what the list SAYS.
 */

import { geometrySegments, type FormField } from '@formai/shared';

/* ------------------------------------------------------------------ *
 * Pairs
 * ------------------------------------------------------------------ */

/**
 * A question and the outcome box its `outcomeTarget` names.
 *
 * Derived on every render rather than stored, so it cannot disagree with the
 * fields it describes.
 */
export interface PlacementPair {
  question: FormField;
  /**
   * The `check_cross` field the question's outcome lands in.
   *
   * Null when `outcomeTarget` names a field this version does not contain,
   * which is a real state and not a rendering accident: the manifest was
   * authored against a different version, or the reference never resolved. The
   * row says so rather than offering a chip that places nothing.
   */
  outcome: FormField | null;
  /** Present when outcomeTarget named something and it did not resolve. */
  unresolvedOutcomeId?: string;
  responsePlaced: boolean;
  outcomePlaced: boolean;
}

/**
 * Pair every question that declares an outcome target.
 *
 * A question WITHOUT an `outcomeTarget` is not paired and is not a defect —
 * plenty of fields are placed on their own. Only a declared link creates the
 * two-location unit of work.
 */
export function pairsFor(fields: readonly FormField[]): PlacementPair[] {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const pairs: PlacementPair[] = [];

  for (const question of fields) {
    const target = question.outcomeTarget;
    if (!target) continue;
    const outcome = byId.get(target.fieldId) ?? null;
    pairs.push({
      question,
      outcome,
      ...(outcome ? {} : { unresolvedOutcomeId: target.fieldId }),
      responsePlaced: geometrySegments(question).length > 0,
      outcomePlaced: outcome ? geometrySegments(outcome).length > 0 : false,
    });
  }

  return pairs;
}

/** Every field id that appears as some question's outcome box. */
export function outcomeFieldIds(fields: readonly FormField[]): Set<string> {
  const ids = new Set<string>();
  for (const field of fields) {
    if (field.outcomeTarget) ids.add(field.outcomeTarget.fieldId);
  }
  return ids;
}

/* ------------------------------------------------------------------ *
 * Filtering
 * ------------------------------------------------------------------ */

/**
 * Whether a field matches the filter text.
 *
 * Matches the LABEL and the DESCRIPTION, because on this document class the
 * question text is routinely the longer of the two and an author searching for
 * "isolate the machine" is remembering the question, not its label. Also
 * matches the field id, so a validator message naming an id can be pasted
 * straight in.
 *
 * Case- and whitespace-insensitive on both sides; an empty filter matches
 * everything rather than nothing.
 */
export function matchesFilter(field: FormField, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  return (
    field.label.toLowerCase().includes(needle) ||
    (field.description ?? '').toLowerCase().includes(needle) ||
    field.id.toLowerCase().includes(needle)
  );
}

/* ------------------------------------------------------------------ *
 * Grouping
 * ------------------------------------------------------------------ */

export interface PlacementGroup {
  key: string;
  label: string;
  fields: FormField[];
  /** Fields in this group whose boxes are all placed. */
  placed: number;
  /** Fields in this group that need at least one box. */
  total: number;
}

/** How many boxes a field needs: one per option for a ticking choice field. */
export type ExpectedBoxes = (field: FormField) => number;

/**
 * Group the placeable fields under the `section_header` that precedes them.
 *
 * DOCUMENT ORDER IS THE GROUPING, because that is the order the boxes are
 * printed in and therefore the order an author works through the page. A
 * grouping by type would scatter one printed page across four places in the
 * list.
 *
 * Fields printed before any heading go into a leading group rather than being
 * dropped — a cover page routinely has no heading above it, and losing those
 * fields from the list would lose them from the placement session entirely.
 */
export function groupFields(
  fields: readonly FormField[],
  expected: ExpectedBoxes,
  filter = '',
): PlacementGroup[] {
  const groups: PlacementGroup[] = [];
  let current: PlacementGroup | null = null;

  const open = (key: string, label: string) => {
    current = { key, label, fields: [], placed: 0, total: 0 };
    groups.push(current);
    return current;
  };

  for (const field of fields) {
    if (field.type === 'section_header') {
      open(field.id, field.label || 'Section');
      continue;
    }
    const group = current ?? open('__lead__', 'Before the first heading');

    /*
      THE COUNTS ARE OF THE WHOLE GROUP, NOT OF WHAT THE FILTER LEFT.

      A filtered list showing "2 of 2 placed" while thirty unplaced fields sit
      behind the filter reads as finished. The filter decides what is SHOWN;
      the counts always describe the group.
    */
    group.total += 1;
    if (geometrySegments(field).length >= expected(field)) group.placed += 1;
    if (matchesFilter(field, filter)) group.fields.push(field);
  }

  // A group the filter emptied is dropped, so the list is the answer to the
  // search rather than a page of empty headings to scroll past.
  return groups.filter((g) => g.fields.length > 0);
}

/** Total placed / total placeable, for the header line. */
export function overallCounts(
  fields: readonly FormField[],
  expected: ExpectedBoxes,
): { placed: number; total: number } {
  const placeable = fields.filter((f) => f.type !== 'section_header');
  return {
    placed: placeable.filter((f) => geometrySegments(f).length >= expected(f)).length,
    total: placeable.length,
  };
}
