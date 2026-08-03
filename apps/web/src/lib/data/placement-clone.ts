/**
 * Copying a placement onto a field that prints the same thing somewhere else.
 *
 * Parts 2, 4 and 6 of the Track Dozer are ONE checklist printed three times.
 * Placing each from scratch means measuring the same twenty-two rows and the
 * same tick/cross/N-A columns three times over, on three pages, by hand — and
 * the third one is no more accurate than the first, just slower.
 *
 * WHAT IS COPIED IS THE SHAPE, NOT THE ANSWER. A clone lands unconfirmed and
 * always will: the columns and rows come across, the reviewer still looks at
 * the page and says yes. That is the same rule `proposeGeometry` already
 * enforces for a freshly derived grid, and for the same reason — only confirmed
 * geometry publishes, because a grid nobody checked is how a tick ends up in
 * the wrong row of a competency record.
 *
 * REFUSES RATHER THAN GUESSES when the two fields are not actually the same
 * shape. This module is mostly that refusal. A grid stretched over the wrong
 * number of rows does not fail visibly — it lands every mark one row out, on a
 * document certifying that somebody is safe to operate a dozer, and the export
 * has no way to know. `deriveForField` already takes this line within a page;
 * this is the same line drawn between fields.
 */
import type { FormField, PageBox } from '@formai/shared';

/** The parts of a field that decide whether a placement can be reused on it. */
export type ClonableField = Pick<FormField, 'id' | 'label' | 'type' | 'options' | 'columns' | 'fixedRows'>;

/**
 * How a field is referred to in a refusal. Its label, falling back to its id
 * for a field the extractor could not name.
 */
function named(field: ClonableField): string {
  const label = field.label?.trim();
  return label ? `“${label}”` : field.id;
}

/** "1 row" / "22 rows". A refusal that reads badly reads as a bug in the tool. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * Why these two fields cannot share a placement, or null when they can.
 *
 * The message is shown to the reviewer, so it names the SOURCE and states both
 * numbers in a fixed order — "‘Part 2 checklist’ has 22 rows, this one has 24"
 * rather than "different number of rows: 22 and 24", which leaves the reader to
 * work out which is which on the one screen where getting it backwards means
 * marks land a row out. The usual cause is a real difference between the two
 * printed tables, which is generally what they wanted to know.
 */
export function cloneRefusal(source: ClonableField, target: ClonableField): string | null {
  if (source.id === target.id) return 'That is the same field.';

  if (source.type !== target.type) {
    return `These are different kinds of field — ${source.type} and ${target.type}.`;
  }

  if (source.type === 'repeating_group') {
    const sourceCols = source.columns?.length ?? 0;
    const targetCols = target.columns?.length ?? 0;
    if (sourceCols !== targetCols) {
      return `${named(source)} has ${count(sourceCols, 'column')}, this one has ${targetCols}.`;
    }
    /*
      Column KEYS, not just the count. The bands in a placement are addressed by
      key, so two tables with three columns each but different keys would copy a
      grid whose bands name columns the target does not have — the marks then
      have nowhere to land, silently.
    */
    const sourceKeys = (source.columns ?? []).map((c) => c.key).join('|');
    const targetKeys = (target.columns ?? []).map((c) => c.key).join('|');
    if (sourceKeys !== targetKeys) {
      return 'The columns are named differently, so the placement would not line up.';
    }

    const sourceRows = source.fixedRows?.length ?? 0;
    const targetRows = target.fixedRows?.length ?? 0;
    if (sourceRows !== targetRows) {
      return `${named(source)} has ${count(sourceRows, 'row')}, this one has ${targetRows}.`;
    }
  }

  /*
    A choice field carries one box per option, keyed by the option value, so the
    options must match — same values, same order. A copy across a field with
    different options would place some options and silently leave others
    unplaced, which exports as a mark that simply never appears.
  */
  const sourceOptions = source.options ?? [];
  const targetOptions = target.options ?? [];
  if (sourceOptions.length !== targetOptions.length) {
    return `${named(source)} has ${count(sourceOptions.length, 'option')}, this one has ${targetOptions.length}.`;
  }
  if (sourceOptions.some((o, i) => o !== targetOptions[i])) {
    return 'The options differ, so each box would target a different answer.';
  }

  return null;
}

/**
 * The same box, on another page.
 *
 * Only the page changes. The horizontal position, the size and every band come
 * across untouched, because the case this exists for is one layout printed
 * repeatedly — the columns sit at the same x on every copy of it, and a table
 * that started at a different x is a different table.
 *
 * The vertical position is the part that genuinely varies between pages, and it
 * is deliberately NOT guessed here: the reviewer drags it into place and
 * confirms, which they have to do anyway. A vertical offset inferred from
 * anything available would be right often enough to be trusted and wrong often
 * enough to matter.
 */
export function clonedBox(box: PageBox, toPage: number, pageWidth: number, pageHeight: number): PageBox {
  return {
    ...box,
    page: toPage,
    pageWidth,
    pageHeight,
    ...(box.columnBands ? { columnBands: box.columnBands.map((b) => ({ ...b })) } : {}),
    ...(box.rowBands ? { rowBands: box.rowBands.map((b) => ({ ...b })) } : {}),
  };
}

/**
 * Fields whose placement could be reused on this one, with why each cannot.
 *
 * Returns the refusals as well as the offers, because "no sources available" on
 * a page of visibly similar tables reads as a broken feature — where "different
 * number of rows: 22 and 24" tells the reviewer something true about their
 * document, and is usually the thing they actually wanted to know.
 */
export function cloneCandidates(
  target: ClonableField,
  fields: readonly ClonableField[],
  hasPlacement: (fieldId: string) => boolean,
): { field: ClonableField; refusal: string | null }[] {
  return fields
    .filter((f) => f.id !== target.id && hasPlacement(f.id))
    .map((field) => ({ field, refusal: cloneRefusal(field, target) }));
}
