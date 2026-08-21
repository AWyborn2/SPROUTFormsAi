/**
 * Rect-anchored proposals for headerless checklists (U4, R8/R9).
 *
 * The shape this exists for is the Mine Site SME cover's methods table:
 * "Observation/Practical Demonstration ☐" — five method labels sharing a left
 * margin, five printed 9pt squares at x=1231 on a 28.4pt pitch, ONE declared
 * answer column, and no header glyphs whatever. `proposeTableSegments` finds
 * columns from header glyphs and rows from label baselines, so this page
 * yielded nothing at all; `proposeRectGrid` could measure it, but only inside
 * an author-drawn box. This path is the same measurement with no hands: one
 * row band per square at the square's own extent, the column band at the
 * column's measured x, paired to the label rows beside it.
 *
 * Coordinates are the measured fixture `pdf-geometry-rect-grid.test.ts`
 * already uses, labels included at the table's own x=438 margin.
 */
import { describe, expect, it } from 'vitest';
import { resolveGeometry } from '@formai/shared';
import type { RepeatingColumn } from '@formai/shared';
import { proposeTableSegments } from './pdf-geometry.js';
import type { PositionedText } from './pdf-geometry.js';
import type { PrintedRect } from '../screens/import/inspector/geometry-actions.js';

const PAGE = { pageWidth: 1400, pageHeight: 990 };

/** The five method checkboxes, top row first as they print. */
function methodSquares(dy = 0): PrintedRect[] {
  return [0, 1, 2, 3, 4].map((i) => ({
    x: 1231,
    y: 760 - dy - i * 28.4,
    width: 9,
    height: 9,
  }));
}

/** The five method labels — one left margin, every run well clear of x=1231. */
function methodLabels(dy = 0): PositionedText[] {
  const texts = [
    'Observation/Practical Demonstration',
    'Verbal Questioning',
    'Written Assessment',
    'Third Party Report',
    'Portfolio of Evidence',
  ];
  return texts.map((text, i) => ({
    text,
    x: 438,
    y: 762 - dy - i * 28.4,
    width: 300 + i,
  }));
}

/** The table as extracted: a label column and ONE answer column. */
const COLUMNS: RepeatingColumn[] = [
  { key: 'method', label: 'Method', type: 'text' },
  { key: 'used', label: 'Used', type: 'check_cross' },
];

function propose(
  items: PositionedText[],
  rects: readonly PrintedRect[] | undefined,
  columns: RepeatingColumn[] = COLUMNS,
) {
  return proposeTableSegments({ page: 0, ...PAGE, items, columns, rects });
}

describe('proposeTableSegments — rect-anchored headerless checklists (U4)', () => {
  it('Covers AE1: proposes the Mine Site methods grid with no hands and no header', () => {
    const [proposal, ...rest] = propose(methodLabels(), methodSquares());

    expect(rest).toEqual([]);
    expect(proposal).toBeDefined();
    // The single column band is the squares' measured extent — on the printed
    // boxes, not where the longest label happened to end.
    expect(proposal!.segment.columnBands).toEqual([{ key: 'used', start: 1231, end: 1240 }]);
    // One row band per square, at the square's own extent, keyed by THIS
    // function's convention (r0…, KTD6) — proposeRectGrid's r1… would offset
    // every row through the shared exporters.
    expect(proposal!.segment.rowBands).toHaveLength(5);
    expect(proposal!.segment.rowBands![0]).toEqual({ key: 'r0', start: 760, end: 769 });
    expect(proposal!.segment.rowBands![4]).toEqual({
      key: 'r4',
      start: 760 - 4 * 28.4,
      end: 769 - 4 * 28.4,
    });
    // Needs-review by design (R9): measured coordinates, but a brand-new row
    // pairing with no printed header corroborating it.
    expect(proposal!.confidence).toBe(0.95);
    expect(proposal!.anchorsLocated).toBe(5);
    expect(proposal!.anchorsInferred).toBe(0);
    expect(proposal!.columnEvidence).toBe('printed-boxes');
    expect(proposal!.notes.join(' ')).toMatch(/no printed header/i);
  });

  it('emits a segment the shipped validator accepts unchanged (R15)', () => {
    const [proposal] = propose(methodLabels(), methodSquares());

    const resolved = resolveGeometry({ geometry: { segments: [proposal!.segment] } }, 1);

    expect(resolved.dropped).toEqual([]);
    expect(resolved.segments).toHaveLength(1);
  });

  it('proposes nothing when the page carried no rectangles — todays behaviour exactly (R1)', () => {
    expect(propose(methodLabels(), undefined)).toEqual([]);
    expect(propose(methodLabels(), [])).toEqual([]);
  });

  it('refuses a heading run crossing under the squares', () => {
    // A run reaching into the column region is a heading, not an item label —
    // the same geometric discriminator rowBands cuts tables on. Pairing it to
    // a square would put a mark against a sentence nobody can answer.
    const items = methodLabels().map((i, index) =>
      index === 0 ? { ...i, width: 800 } : i,
    );

    expect(propose(items, methodSquares())).toEqual([]);
  });

  it('refuses labels that do not share one left margin', () => {
    // A checklist's item labels print from one x; a mixed bag of margins is
    // prose that happens to sit beside squares.
    const items = methodLabels().map((i, index) =>
      index === 1 ? { ...i, x: 448 } : i,
    );

    expect(propose(items, methodSquares())).toEqual([]);
  });

  it('refuses a square without its own label row, and one with two candidates', () => {
    // A floating square pairs with nothing; two baselines inside one square's
    // reach is ambiguity. Both skip silently — the page stays as refusable as
    // today, because this path only ever ADDS proposals.
    const missingRow = methodLabels().slice(1);
    expect(propose(missingRow, methodSquares())).toEqual([]);

    const doubled = [
      ...methodLabels(),
      { text: 'A second line inside the first row', x: 438, y: 758, width: 200 },
    ];
    expect(propose(doubled, methodSquares())).toEqual([]);
  });

  it('refuses a table with more than one declared answer column (R9)', () => {
    // Without a header, nothing on the page says which printed column is
    // which option key — proposeRectGrid's own refusal, kept.
    const three: RepeatingColumn[] = [
      ...COLUMNS,
      { key: 'na', label: 'N/A', type: 'check_cross' },
    ];

    expect(propose(methodLabels(), methodSquares(), three)).toEqual([]);
  });

  it('does not double-propose a table a header derivation already claimed', () => {
    /*
      A labelled header above the same rows: the header path proposes first,
      and the square column's centre falls inside that proposal's segment, so
      the rect-anchored path skips it — header evidence outranks, one table
      never gets two proposals. (The squares still serve as refinement
      evidence on the header proposal itself.)
    */
    const header: PositionedText[] = [
      { text: 'Methods used to assess competence', x: 438, y: 790, width: 500 },
      { text: 'Used', x: 1215, y: 790, width: 20 },
      { text: 'N/A', x: 1245, y: 790, width: 15 },
    ];

    const proposals = propose([...header, ...methodLabels()], methodSquares());

    expect(proposals).toHaveLength(1);
  });

  it('Covers AE6: stacked twin checklists yield two structurally identical proposals', () => {
    // Ten squares in one x-run split at the between-tables gap into two
    // candidates, each pairing with its own label rows. Choosing between the
    // twins is table identity, which is selection's job — and selection
    // refuses a near-equal tie (asserted at the geometry-actions level).
    const items = [...methodLabels(), ...methodLabels(300)];
    const rects = [...methodSquares(), ...methodSquares(300)];

    const proposals = propose(items, rects);

    expect(proposals).toHaveLength(2);
    for (const p of proposals) {
      expect(p.confidence).toBe(0.95);
      expect(p.segment.rowBands).toHaveLength(5);
      expect(p.segment.columnBands).toEqual([{ key: 'used', start: 1231, end: 1240 }]);
    }
  });
});
