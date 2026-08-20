/**
 * Paging a theory part into one question per screen.
 *
 * PRESENTATION ONLY. Every field still renders through the same `FieldInput`,
 * writes the same value to the same id, and is gated by the same
 * `writableFieldIds` the server decided. Nothing about marking, storage or the
 * evidence export can tell which presentation a candidate used — the paging is
 * a window over the list, not a different list.
 *
 * WHY IT IS WORTH HAVING. The Track Dozer paper's theory part is 31 questions.
 * On a phone, in a site office, that is a scroll with no sense of progress and
 * no way to tell whether the bottom of the screen is the end of the question or
 * the end of the section. One question at a time is what the printed paper does
 * with a page turn.
 */

import type { FormField } from '@formai/shared';

/** One screen of a paged theory part. */
export interface TheoryPage {
  /** The question this page is about, and anything bound to it. */
  fields: FormField[];
  /** 0-based index among the pages. */
  index: number;
}

/**
 * Whether a field starts a new page.
 *
 * A QUESTION IS ANYTHING WITH OPTIONS. Everything else — a heading, a note, and
 * critically the `check_cross` outcome box a question's mark lands in — travels
 * with the question ABOVE it rather than taking a page of its own. An outcome
 * box on its own screen is a page showing a candidate a tick box for a question
 * they cannot see, and on the assessor's side it separates the verdict from the
 * thing being judged.
 */
function startsPage(field: FormField): boolean {
  return (field.options?.length ?? 0) > 0;
}

/**
 * The fields a QUIZ actually shows: headings, plus what the caller may write.
 *
 * A question's ✓/✗ outcome cell — and any other field marking writes, like a
 * part's verdict radio locked to `auto` — is a results box for the printed
 * PDF, not a question. The server already refuses writes to those (they are
 * dropped from `writableFieldIds`), so rendering them in the quiz puts an
 * unanswerable control under every question, and an auto verdict radio would
 * even claim a page of its own that no candidate could complete. Headings
 * stay: they introduce the question below them and were never writable.
 *
 * QUIZ MODE ONLY. The stacked view keeps showing read-only cells — an
 * assessor reviewing a marked paper reads the ✓/✗ beside each question there.
 */
export function quizFields(
  fields: readonly FormField[],
  writableIds: ReadonlySet<string>,
): FormField[] {
  return fields.filter((f) => f.type === 'section_header' || writableIds.has(f.id));
}

/**
 * Split a part's visible fields into one page per question.
 *
 * Anything printed BEFORE the first question — a part heading, an instruction —
 * leads the first page rather than becoming a page of its own, because a screen
 * carrying only a heading is a screen with nothing to do on it.
 *
 * Returns a single page when there are no questions at all, so a part that is
 * all prose still renders rather than paging into nothing.
 */
export function theoryPages(fields: readonly FormField[]): TheoryPage[] {
  if (fields.length === 0) return [];

  const pages: TheoryPage[] = [];
  let current: FormField[] = [];
  /*
    NON-QUESTIONS ATTACH IN DIFFERENT DIRECTIONS, and getting it wrong puts
    text on the wrong screen.

    A `section_header` INTRODUCES what follows — "BBM Mining Only" heads the
    questions beneath it — so it waits and leads the next page. Everything else,
    and the `check_cross` outcome box above all, belongs to the question it
    follows: an outcome box on its own screen shows a tick box for a question
    the reader cannot see.
  */
  let pending: FormField[] = [];

  for (const field of fields) {
    if (field.type === 'section_header') {
      pending.push(field);
      continue;
    }

    // A new question closes the page before it — unless nothing has opened yet,
    // in which case the leading matter joins this first question.
    if (startsPage(field) && current.some(startsPage)) {
      pages.push({ fields: current, index: pages.length });
      current = [];
    }
    if (pending.length > 0) {
      current.push(...pending);
      pending = [];
    }
    current.push(field);
  }

  // A heading with nothing beneath it still has to render, or the last thing
  // the document printed would silently vanish from the form.
  if (pending.length > 0) current.push(...pending);
  if (current.length > 0) pages.push({ fields: current, index: pages.length });

  return pages;
}

/**
 * How many of a part's pages have been answered.
 *
 * A page counts when EVERY question on it has a value. Counting a partly
 * answered page would let a progress bar reach the end with questions
 * unanswered, which on an assessment is a claim the candidate is finished.
 */
export function answeredPages(
  pages: readonly TheoryPage[],
  values: Record<string, unknown>,
): number {
  return pages.filter((page) => {
    const questions = page.fields.filter(startsPage);
    if (questions.length === 0) return false;
    return questions.every((q) => {
      const value = values[q.id];
      if (value === null || value === undefined || value === '') return false;
      return !Array.isArray(value) || value.length > 0;
    });
  }).length;
}
