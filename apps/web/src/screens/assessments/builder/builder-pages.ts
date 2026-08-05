/**
 * Sections → preview pages.
 *
 * The arrangement in Step 2 is a list of sections; what a candidate meets is a
 * sequence of PAGES. Those are not the same list, for one reason that comes
 * straight off the paper: a competency paper's cover crams identity,
 * eligibility and verdict onto one sheet, and the three read as one page even
 * though the builder holds them as three sections.
 *
 * So consecutive COVER sections that nobody has flagged "own page" collapse
 * into a single page. Everything else is one page per section. Nothing here is
 * stored — pages are derived from the arrangement on every render, so the
 * preview cannot disagree with the editor beside it.
 *
 * Pure module: no React, no DOM.
 */

import type { BuilderStructure, FormField, StructureSection } from '@formai/shared';

/**
 * What a page is FOR, which decides how it renders.
 *
 * Derived from the fields the section actually contains rather than from its
 * label, because a label is whatever an author typed. A section holding a
 * fixed-row checklist is a practical demonstration whatever it is called.
 */
export type PageKind = 'cover' | 'theory' | 'practical' | 'logbook' | 'fields';

export interface PreviewPage {
  key: string;
  kind: PageKind;
  /** What the pager's chip and heading say. */
  label: string;
  /** The sections this page draws, in order. More than one only on a cover run. */
  sectionKeys: string[];
}

/** Choice fields and outcome cells — the shapes a theory section is made of. */
function isQuestionField(field: FormField): boolean {
  return (
    field.type === 'radio' ||
    field.type === 'checkbox_group' ||
    field.type === 'dropdown' ||
    field.type === 'check_cross'
  );
}

/**
 * What kind of page one section renders as.
 *
 * The order of these checks is the specificity order and matters. A practical
 * part's criteria table is a `repeating_group` WITH pre-printed rows; a
 * logbook's is the same type WITHOUT them, because its rows are added over
 * weeks. Testing for the table first and the rows second is what tells them
 * apart — and a section holding both is a practical, since a criteria list is
 * the more specific claim.
 */
export function sectionKind(section: StructureSection, byId: Map<string, FormField>): PageKind {
  if (section.cover) return 'cover';

  const fields = section.fields.map((f) => byId.get(f.id)).filter((f): f is FormField => !!f);
  const tables = fields.filter((f) => f.type === 'repeating_group');

  if (tables.some((t) => (t.fixedRows?.length ?? 0) > 0)) return 'practical';
  if (tables.length > 0) return 'logbook';
  if (fields.some(isQuestionField)) return 'theory';
  return 'fields';
}

/**
 * A cover page's title, built from the sections it actually contains.
 *
 * The design prototype titled every cover page from the first section it held,
 * so splitting the run by reordering produced two chips reading "Candidate
 * declaration" and no way to tell them apart. Naming the first and counting the
 * rest keeps the label bounded — a run of five sections must not produce a chip
 * nobody can read — while still saying the two pages are different.
 */
function coverLabel(sections: readonly StructureSection[]): string {
  const first = sections[0]?.label ?? 'Cover';
  if (sections.length === 1) return first;
  return `${first} + ${sections.length - 1} more`;
}

/**
 * The pages a preview shows, in the author's order.
 *
 * An empty section contributes no page: it is a real part of the arrangement
 * and it is visible in the editor, but a blank page in a preview says nothing
 * about the form and pushes the pages an author wants to see further away.
 */
export function previewPages(
  structure: BuilderStructure,
  fields: readonly FormField[],
): PreviewPage[] {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const pages: PreviewPage[] = [];
  let coverRun: { page: PreviewPage; sections: StructureSection[] } | null = null;

  for (const section of structure) {
    if (section.fields.length === 0) continue;
    const kind = sectionKind(section, byId);

    if (kind === 'cover' && !section.ownPage) {
      if (coverRun) {
        coverRun.sections.push(section);
        coverRun.page.sectionKeys.push(section.key);
        coverRun.page.label = coverLabel(coverRun.sections);
        continue;
      }
      const page: PreviewPage = {
        key: section.key,
        kind: 'cover',
        label: section.label,
        sectionKeys: [section.key],
      };
      coverRun = { page, sections: [section] };
      pages.push(page);
      continue;
    }

    // Anything that is not a continuing cover section ends the run — including
    // a cover section the author flagged "own page", which is exactly how they
    // say "this one is not part of that sheet".
    coverRun = null;
    pages.push({ key: section.key, kind, label: section.label, sectionKeys: [section.key] });
  }

  return pages;
}

/** Keep a pager index inside a page list that may have just got shorter. */
export function clampPage(index: number, pageCount: number): number {
  if (pageCount <= 0) return 0;
  return Math.min(Math.max(index, 0), pageCount - 1);
}

/**
 * A field's label with the trailing answer words the extraction leaves on it
 * stripped.
 *
 * A printed Yes/No question reads "More coaching and/or training required?
 * No Yes" across the page, and extraction folds the two boxes into the label
 * because on paper they ARE beside the text. Rendering that verbatim beside a
 * pair of Yes/No controls asks the question twice.
 *
 * Only for a field that renders its own Yes/No control, and only at the END of
 * the label, so a question genuinely about the words ("When would you answer
 * Yes?") keeps them.
 */
export function previewLabel(field: FormField): string {
  if (field.type !== 'boolean_yes_no') return field.label;
  return field.label.replace(/\s*\b(no\s*\/?\s*yes|yes\s*\/?\s*no)\b\s*$/i, '').trim() || field.label;
}
