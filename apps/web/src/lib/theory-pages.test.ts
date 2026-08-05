/**
 * Paging a theory part.
 *
 * The paging is presentation only — same fields, same ids, same values — so
 * what these tests defend is that the WINDOW is honest: no page shows a control
 * whose question is on another screen, and progress never reads finished while
 * a question is unanswered.
 */
import { describe, expect, it } from 'vitest';
import type { FormField } from '@formai/shared';
import { answeredPages, theoryPages } from './theory-pages.js';

function field(over: Partial<FormField> & { id: string }): FormField {
  return { label: over.id, type: 'text', required: false, source: 'imported', ...over };
}

const q = (id: string) => field({ id, type: 'radio', options: ['a', 'b'] });
const outcome = (id: string) => field({ id, type: 'check_cross' });
const heading = (id: string) => field({ id, type: 'section_header' });

describe('theoryPages', () => {
  it('gives each question its own page', () => {
    const pages = theoryPages([q('q1'), q('q2'), q('q3')]);
    expect(pages.map((p) => p.fields.map((f) => f.id))).toEqual([['q1'], ['q2'], ['q3']]);
  });

  it('KEEPS A QUESTION’S OUTCOME BOX ON ITS OWN PAGE', () => {
    /*
      An outcome box on a page of its own shows a candidate a tick box for a
      question they cannot see, and separates the assessor's verdict from the
      thing being judged.
    */
    const pages = theoryPages([q('q1'), outcome('o1'), q('q2'), outcome('o2')]);
    expect(pages.map((p) => p.fields.map((f) => f.id))).toEqual([
      ['q1', 'o1'],
      ['q2', 'o2'],
    ]);
  });

  it('leads the first page with anything printed before the first question', () => {
    // A screen carrying only a heading is a screen with nothing to do on it.
    const pages = theoryPages([heading('h1'), field({ id: 'note' }), q('q1'), q('q2')]);
    expect(pages[0]!.fields.map((f) => f.id)).toEqual(['h1', 'note', 'q1']);
    expect(pages[1]!.fields.map((f) => f.id)).toEqual(['q2']);
  });

  it('carries a mid-part heading onto the page of the question below it', () => {
    const pages = theoryPages([q('q1'), heading('h2'), q('q2')]);
    expect(pages[1]!.fields.map((f) => f.id)).toEqual(['h2', 'q2']);
  });

  it('returns one page for a part with no questions at all', () => {
    // A part that is all prose still has to render.
    const pages = theoryPages([heading('h1'), field({ id: 'note' })]);
    expect(pages).toHaveLength(1);
  });

  it('returns nothing for nothing', () => {
    expect(theoryPages([])).toEqual([]);
  });

  it('numbers pages from zero, in order', () => {
    expect(theoryPages([q('a'), q('b')]).map((p) => p.index)).toEqual([0, 1]);
  });
});

describe('answeredPages', () => {
  const PAGES = theoryPages([q('q1'), outcome('o1'), q('q2'), q('q3')]);

  it('counts a page only when its question has a value', () => {
    expect(answeredPages(PAGES, { q1: 'a' })).toBe(1);
    expect(answeredPages(PAGES, { q1: 'a', q3: 'b' })).toBe(2);
  });

  it('does not count an empty string or an empty array as answered', () => {
    // Both are what an untouched control posts, and counting them would let
    // progress reach the end with nothing chosen.
    expect(answeredPages(PAGES, { q1: '', q2: [] })).toBe(0);
  });

  it('ignores the outcome box when deciding whether a page is answered', () => {
    // The outcome is the assessor's verdict, not the candidate's answer. A page
    // whose question is answered is answered.
    expect(answeredPages(PAGES, { q1: 'a' })).toBe(1);
  });

  it('never counts a page that carries no question', () => {
    const prose = theoryPages([heading('h1')]);
    expect(answeredPages(prose, {})).toBe(0);
  });
});
