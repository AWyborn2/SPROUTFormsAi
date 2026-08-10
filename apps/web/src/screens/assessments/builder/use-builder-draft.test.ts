/**
 * What Step 1 reports about a document it has just read.
 *
 * The counts are the first thing an author checks and the last thing anybody
 * questions, so each one has to mean what its label says:
 *
 *  · "Fields" is what somebody fills in. Section headers are structure — the
 *    assessment profile asks for them precisely so parts can be anchored — and
 *    counting them inflates the number the placement step is measured against,
 *    which then reads as boxes nobody placed;
 *  · "Parts detected" counts PART headings, not headings generally. A count
 *    including every sub-heading promises structure the manifest step cannot
 *    anchor a part to;
 *  · a matching question read one-sided is counted SEPARATELY, because it is
 *    the one shape that cannot be keyed without somebody typing the rest of it.
 */
import { describe, expect, it } from 'vitest';
import type { ExtractedField, ExtractionResult } from '@formai/shared';
import { statsFor } from './use-builder-draft.js';

function field(over: Partial<ExtractedField> & { id: string }): ExtractedField {
  return { label: over.id, type: 'text', confidence: 0.9, ...over };
}

function extraction(fields: ExtractedField[], pageCount = 18): ExtractionResult {
  return {
    sourceType: 'pdf_import',
    path: 'ai',
    fileName: 'Authorised to Operate Track Dozer.pdf',
    pageCount,
    fields,
    designNotes: [],
  };
}

describe('statsFor', () => {
  it('counts only the headings a part can be anchored to', () => {
    const stats = statsFor(
      extraction([
        field({ id: 'h1', type: 'section_header', label: 'PART 1 — THEORY ASSESSMENT' }),
        field({ id: 'h2', type: 'section_header', label: 'Written or Verbal Questions (General)' }),
        field({ id: 'h3', type: 'section_header', label: 'PART 2 — PRACTICAL DEMONSTRATION' }),
        field({ id: 'h4', type: 'section_header', label: 'BBM Mining Only' }),
      ]),
    );

    expect(stats.parts).toBe(2);
  });

  it('excludes section headers from the field count', () => {
    // The placement step is measured against this number. Counting a heading
    // as a field makes it permanently short by however many headings there are.
    const stats = statsFor(
      extraction([
        field({ id: 'h1', type: 'section_header', label: 'PART 1' }),
        field({ id: 'f1', type: 'text', label: 'Candidate name' }),
        field({ id: 'f2', type: 'signature', label: 'Candidate signature' }),
      ]),
    );

    expect(stats.fields).toBe(2);
  });

  it('counts choice questions and matching questions together', () => {
    const stats = statsFor(
      extraction([
        field({ id: 'q1', type: 'radio', options: ['True', 'False'] }),
        field({ id: 'q2', type: 'checkbox_group', options: ['a', 'b', 'c'] }),
        field({
          id: 'q3',
          type: 'checkbox_group',
          matchLeft: ['3 blasts', '2 blasts'],
          matchRight: ['Starting', 'Moving off'],
        }),
        field({ id: 'f1', type: 'text' }),
      ]),
    );

    expect(stats.questions).toBe(3);
  });

  it('does not count a choice field that has no options as a question', () => {
    // A choice field with nothing to choose from is a mis-read, not a
    // question — reporting it as one hides the mis-read behind a plausible
    // total.
    const stats = statsFor(extraction([field({ id: 'q1', type: 'radio' })]));

    expect(stats.questions).toBe(0);
  });

  it('separates a matching question that came back one-sided', () => {
    const stats = statsFor(
      extraction([
        field({
          id: 'q1',
          type: 'checkbox_group',
          matchLeft: ['a', 'b'],
          matchRight: ['x', 'y'],
        }),
        field({ id: 'q2', type: 'checkbox_group', matchLeft: ['a', 'b', 'c'] }),
      ]),
    );

    expect(stats.matchesComplete).toBe(1);
    expect(stats.matchesIncomplete).toBe(1);
    // Both are still questions — one simply cannot be keyed yet.
    expect(stats.questions).toBe(2);
  });

  it('counts the prerequisite rows the cover page declared', () => {
    const stats = statsFor(
      extraction([
        field({
          id: 'p1',
          type: 'check_cross',
          label: 'Q50001782 Driver’s Licence C or higher class',
          coverSection: 'pathway_prerequisites',
        }),
        field({ id: 'p2', type: 'check_cross', coverSection: 'pathway_prerequisites' }),
        field({ id: 'c1', type: 'text', coverSection: 'candidate_declaration' }),
      ]),
    );

    expect(stats.prerequisites).toBe(2);
  });

  it('reports zero prerequisites rather than guessing when none were marked', () => {
    // Zero is what makes Step 1 raise it. A guessed prerequisite would be a
    // gating fact nobody stated.
    const stats = statsFor(extraction([field({ id: 'c1', type: 'text' })]));

    expect(stats.prerequisites).toBe(0);
  });

  it('takes the page count from the document, not from the fields', () => {
    const stats = statsFor(extraction([], 18));

    expect(stats.pages).toBe(18);
  });
});
