/**
 * Outcome cells, placed from an exemplar a human drew.
 *
 * The 31 outcome cells on the Track Dozer are unreachable by both other rules.
 * Their labels ("Q1 Outcome", "7. Outcome") are names the extractor invented and
 * appear nowhere on the page, so nothing matches by label; and a page whose only
 * right-hand column is a single tick box yields ONE anchor where `findHeaderRows`
 * requires two, so the column derivation cannot see it either.
 *
 * So the column is copied from a cell somebody placed and looked at, and only the
 * ROW is derived. What these tests pin is that division: the column and size are
 * never inferred, the vertical offset is measured rather than assumed, and every
 * uncertain case refuses instead of guessing a row.
 *
 * In a separate file from `pdf-geometry.test.ts` only because that one is already
 * long; the fixtures follow the same measured-coordinate discipline.
 */
import { describe, expect, it } from 'vitest';
import { proposeFromExemplar } from './pdf-geometry.js';
import type { PositionedText, TextPage } from './pdf-geometry.js';
import type { PageBox } from '@formai/shared';

const A4 = { width: 595, height: 842 };
const page = (items: PositionedText[]): TextPage => ({ ...A4, items });

/** Two numbered questions, each with lettered answers beneath it. */
function theoryPage(): TextPage {
  return page([
    { text: '1.', x: 40, y: 630.8, width: 8 },
    { text: 'The track dozer must be isolated with a lock and hasp', x: 58, y: 630.8, width: 260 },
    { text: 'a)', x: 70, y: 614, width: 9 },
    { text: 'True', x: 88, y: 614, width: 18 },
    { text: '2.', x: 40, y: 580.3, width: 8 },
    { text: '3 points of contact is always required when egressing', x: 58, y: 580.3, width: 255 },
    { text: 'a)', x: 70, y: 563.5, width: 9 },
    { text: 'True', x: 88, y: 563.5, width: 18 },
  ]);
}

/** The cell a reviewer drew against question 1, in the right-hand column. */
const EXEMPLAR: PageBox = {
  page: 0,
  x: 520,
  y: 627,
  width: 16,
  height: 12,
  pageWidth: 595,
  pageHeight: 842,
};

const Q2 = '3 points of contact is always required when egressing';

const propose = (questionLabel: string, pages: TextPage[] = [theoryPage()], exemplar = EXEMPLAR) =>
  proposeFromExemplar({ pages, exemplar, questionLabel });

describe('proposeFromExemplar', () => {
  it('reuses the exemplar column and size exactly', () => {
    const res = propose(`Q2. ${Q2}`)!;

    expect(res).not.toBeNull();
    const box = res.segments[0]!;
    // Nothing about the column is inferred — it is the human's, unchanged.
    expect(box.x).toBe(EXEMPLAR.x);
    expect(box.width).toBe(EXEMPLAR.width);
    expect(box.height).toBe(EXEMPLAR.height);
  });

  it('moves the cell onto its own question row', () => {
    const res = propose(`Q2. ${Q2}`)!;

    // Question 1 sits at 630.8 and question 2 at 580.3. The exemplar is 3.8pt
    // below its own baseline, so question 2's cell belongs 3.8pt below 580.3.
    expect(res.segments[0]!.y).toBeCloseTo(576.5, 5);
    expect(res.segments[0]!.y).not.toBe(EXEMPLAR.y);
  });

  it('measures the vertical offset rather than assuming one', () => {
    // A form that sits its boxes higher in the row has to stay consistent down
    // the page; a hard-coded offset would drift every cell by the same amount.
    const higher: PageBox = { ...EXEMPLAR, y: 633 };
    const res = propose(`Q2. ${Q2}`, [theoryPage()], higher)!;

    // 2.2pt above question 1's baseline, so 2.2pt above question 2's.
    expect(res.segments[0]!.y).toBeCloseTo(582.5, 5);
  });

  it('finds a question on a page other than the exemplar’s', () => {
    // The realistic case: the reviewer drew one cell on the page they were
    // looking at, and the next question is overleaf.
    const overleaf = page([
      { text: '3.', x: 40, y: 700, width: 8 },
      { text: 'What is the purpose of performing a walk around pre-start inspection', x: 58, y: 700, width: 320 },
    ]);
    const res = propose(
      'Q3. What is the purpose of performing a walk around pre-start inspection',
      [theoryPage(), overleaf],
    )!;

    expect(res).not.toBeNull();
    expect(res.segments[0]!.page).toBe(1);
    // The page's own dimensions travel with the box — a mixed-orientation
    // document has no single page size to fall back on.
    expect(res.segments[0]!.pageWidth).toBe(A4.width);
  });

  it('anchors a wrapped question to its first printed line', () => {
    const wrapped = page([
      { text: '1.', x: 40, y: 630.8, width: 8 },
      { text: 'The track dozer must be isolated with a lock and hasp before you', x: 58, y: 630.8, width: 300 },
      { text: 'carry out any maintenance', x: 58, y: 620.4, width: 120 },
    ]);
    const res = propose(
      'Q1. The track dozer must be isolated with a lock and hasp before you carry out any maintenance',
      [wrapped],
    )!;

    // The printed cell sits against the opening line, not the middle of the wrap.
    expect(res.segments[0]!.y).toBeCloseTo(627, 5);
  });

  it('never reports full confidence', () => {
    const res = propose(`Q2. ${Q2}`)!;

    // The column is a human's, but the row is derived and the offset copied from
    // a single sample. A reviewer should still look at it.
    expect(res.confidence).toBeLessThan(1);
    expect(res.notes.join(' ')).toMatch(/page 1/);
  });
});

describe('proposeFromExemplar — refusals', () => {
  const rows: PositionedText[] = [
    { text: 'The track dozer must be isolated with a lock and hasp', x: 58, y: 630.8, width: 260 },
    { text: Q2, x: 58, y: 580.3, width: 255 },
  ];

  it('refuses when the question is printed twice on one page', () => {
    const dup = page([...rows, { ...rows[1]!, y: 400 }]);

    expect(proposeFromExemplar({ pages: [dup], exemplar: EXEMPLAR, questionLabel: Q2 })).toBeNull();
  });

  it('refuses when the question appears on two different pages', () => {
    expect(
      proposeFromExemplar({
        pages: [page(rows), page(rows)],
        exemplar: EXEMPLAR,
        questionLabel: Q2,
      }),
    ).toBeNull();
  });

  it('refuses when the question is nowhere in the document', () => {
    expect(
      proposeFromExemplar({
        pages: [page(rows)],
        exemplar: EXEMPLAR,
        questionLabel: 'Q9. When ripping you must only rip in one direction',
      }),
    ).toBeNull();
  });

  it('refuses a label too short to identify a row', () => {
    expect(
      proposeFromExemplar({ pages: [page(rows)], exemplar: EXEMPLAR, questionLabel: 'Q1' }),
    ).toBeNull();
  });

  it('refuses when the exemplar sits on no row, leaving the offset unknown', () => {
    // A box floating in white space gives no baseline to measure against, and a
    // guessed offset would drift every proposed cell by the same wrong amount.
    expect(
      proposeFromExemplar({
        pages: [page(rows)],
        exemplar: { ...EXEMPLAR, y: 120 },
        questionLabel: Q2,
      }),
    ).toBeNull();
  });

  it('refuses when the exemplar names a page the document does not have', () => {
    expect(
      proposeFromExemplar({
        pages: [page(rows)],
        exemplar: { ...EXEMPLAR, page: 7 },
        questionLabel: Q2,
      }),
    ).toBeNull();
  });
});
