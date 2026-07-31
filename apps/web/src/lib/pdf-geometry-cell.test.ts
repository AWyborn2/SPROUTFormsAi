/**
 * Placing a scalar box in the printed CELL beneath its caption.
 *
 * Roughly 35 boxes on the Track Dozer — names, dates, swipe-card numbers — had
 * no rule at all and every one was drawn by hand. They cannot be derived from
 * text: `PositionedText` is {text, x, y, width}, with no height and no strokes,
 * so a text-only rule must invent a vertical position, and an invented y on a
 * competency record is a mark in whatever box happens to be there.
 *
 * The fixtures below are the REAL geometry, measured off the document before
 * this rule was designed (an earlier design assumed a write-on line beside the
 * caption and placed nothing at all):
 *
 *   "Candidate's Company Name"    caption cell y 702→720, answer y 678→702, x 222.3→384.8
 *   "Employee Swipe card Number"  caption cell y 702→720, answer y 678→702, x 385.3→563.5
 *   "Name of Assessor [Print]"    caption cell y 182.9→200.4, answer y 150.4→182.9, x 165.6→322.0
 *
 * The first two share a baseline with a third caption, and their row also
 * carries the table's outer border at the same y — which is what makes "measure
 * the caption, not the row" load-bearing rather than tidy.
 */
import { describe, expect, it } from 'vitest';
import type { TextPage } from './pdf-geometry.js';
import { proposeScalarCell } from './pdf-geometry.js';

const run = (text: string, x: number, y: number, width: number) => ({ text, x, y, width });
const rule = (y: number, x1: number, x2: number) => ({ y, x1, x2 });

const PAGE_W = 595;
const PAGE_H = 842;

const COMPANY = "Candidate's Company Name";
const SWIPE = 'Employee Swipe card Number';
const NAME = "Candidate's Name";

/** The cover-page row, reproduced from the measured document. */
function coverPage(over: Partial<TextPage> = {}): TextPage {
  return {
    items: [
      run(NAME, 36.1, 707.6, 86.7),
      run(COMPANY, 227.5, 707.6, 135.0),
      run(SWIPE, 390.5, 707.6, 143.4),
    ],
    width: PAGE_W,
    height: PAGE_H,
    rules: [
      // Caption row: three cell borders plus the table's outer border.
      rule(720.0, 31.4, 221.8),
      rule(720.0, 222.3, 384.8),
      rule(720.0, 385.3, 563.5),
      rule(720.4, 29.9, 565.0),
      rule(701.5, 31.4, 221.8),
      rule(701.5, 222.3, 384.8),
      rule(701.5, 385.3, 563.5),
      rule(701.9, 31.4, 563.5),
      // Answer row's floor.
      rule(677.9, 31.4, 221.8),
      rule(677.9, 222.3, 384.8),
      rule(677.9, 385.3, 563.5),
    ],
    ...over,
  };
}

describe('proposeScalarCell — the cell beneath the caption', () => {
  it('measures the caption’s own cell, not the row’s', () => {
    const out = proposeScalarCell({ pages: [coverPage()], type: 'text', label: COMPANY });

    expect(out.placed).toBe(true);
    if (!out.placed) return;
    // Every edge is a printed stroke — including the height, which an earlier
    // design had to hardcode.
    expect(Math.round(out.proposal.box.x)).toBe(222);
    expect(Math.round(out.proposal.box.width)).toBe(163); // 384.8 - 222.3
    expect(Math.round(out.proposal.box.y)).toBe(678);
    expect(Math.round(out.proposal.box.height)).toBe(24);
  });

  it('gives each caption on a shared row its OWN cell', () => {
    /*
      The defect this exists to prevent. Three captions share y=707.6; measuring
      the row rather than the caption matched the table's outer border and gave
      all three the same box — two different fields proposing an identical
      placement, which is how a value lands in another field's cell.
    */
    const a = proposeScalarCell({ pages: [coverPage()], type: 'text', label: COMPANY });
    const b = proposeScalarCell({ pages: [coverPage()], type: 'text', label: SWIPE });

    expect(a.placed && b.placed).toBe(true);
    if (!a.placed || !b.placed) return;
    expect(Math.round(a.proposal.box.x)).toBe(222);
    expect(Math.round(b.proposal.box.x)).toBe(385);
    expect(a.proposal.box.x).not.toBe(b.proposal.box.x);
    // And neither box reaches into the other's cell.
    expect(a.proposal.box.x + a.proposal.box.width).toBeLessThanOrEqual(b.proposal.box.x + 1);
  });

  it('reports what it measured, in points', () => {
    // The reviewer confirms this against the page; a proposal that cannot say
    // what it measured can only be accepted on faith.
    const out = proposeScalarCell({ pages: [coverPage()], type: 'text', label: COMPANY });

    if (!out.placed) throw new Error('expected a placement');
    expect(out.proposal.notes.join(' ')).toMatch(/printed cell/i);
    expect(out.proposal.notes.join(' ')).toMatch(/163/);
    expect(out.proposal.confidence).toBe(0.75);
  });
});

describe('proposeScalarCell — what it refuses', () => {
  it('refuses a type whose export path would deface the page', () => {
    // signature draws a base64 data URL; standalone checkbox draws the letter X
    // left-anchored; textarea wraps 24pt per line regardless of box height.
    for (const type of ['signature', 'checkbox', 'textarea', 'check_cross', 'radio'] as const) {
      const out = proposeScalarCell({ pages: [coverPage()], type, label: COMPANY });
      expect(out.placed).toBe(false);
      if (!out.placed) expect(out.code).toBe('unsupported-type');
    }
  });

  it('refuses a label too short to identify a place', () => {
    const out = proposeScalarCell({ pages: [coverPage()], type: 'text', label: 'Name' });

    expect(out.placed).toBe(false);
    if (!out.placed) expect(out.code).toBe('label-too-short');
  });

  it('refuses when the same caption appears twice', () => {
    const twice: TextPage = {
      ...coverPage(),
      items: [...coverPage().items, run(COMPANY, 227.5, 400, 135)],
    };
    const out = proposeScalarCell({ pages: [twice], type: 'text', label: COMPANY });

    expect(out.placed).toBe(false);
    if (!out.placed) expect(out.code).toBe('label-ambiguous');
  });

  it('distinguishes "no lines were read" from "not in a cell"', () => {
    // Opposite fixes: one means the extractor never ran, the other that this
    // caption is simply not inside a bordered cell.
    const notMeasured = proposeScalarCell({
      pages: [{ ...coverPage(), rules: undefined }],
      type: 'text',
      label: COMPANY,
    });
    expect(notMeasured.placed).toBe(false);
    if (!notMeasured.placed) expect(notMeasured.code).toBe('no-rule-data');

    const noCell = proposeScalarCell({
      pages: [{ ...coverPage(), rules: [] }],
      type: 'text',
      label: COMPANY,
    });
    expect(noCell.placed).toBe(false);
    if (!noCell.placed) expect(noCell.code).toBe('caption-not-in-a-cell');
  });

  it('refuses a caption with a border under it but none over it', () => {
    // A heading with a rule beneath is not a table cell, and the space below it
    // is not an answer area. Both strokes or nothing.
    const page = coverPage();
    const out = proposeScalarCell({
      pages: [{ ...page, rules: page.rules!.filter((r) => r.y < 710) }],
      type: 'text',
      label: COMPANY,
    });

    expect(out.placed).toBe(false);
    if (!out.placed) expect(out.code).toBe('caption-not-in-a-cell');
  });

  it('refuses when the caption cell has no cell beneath it', () => {
    const page = coverPage();
    const out = proposeScalarCell({
      pages: [{ ...page, rules: page.rules!.filter((r) => r.y > 690) }],
      type: 'text',
      label: COMPANY,
    });

    expect(out.placed).toBe(false);
    if (!out.placed) expect(out.code).toBe('no-cell-beneath');
  });

  it('refuses a cell that already has something printed in it', () => {
    /*
      Corroboration from evidence the derivation did not consume: the box came
      from the strokes, this reads the text. On the real document it is what
      correctly refuses "Title of Training Package", whose row carries a
      pre-printed value rather than a blank answer area — and on a filled copy
      it refuses rather than drawing over an existing entry.
    */
    const page = coverPage();
    const out = proposeScalarCell({
      pages: [{ ...page, items: [...page.items, run('BBM Pty Ltd', 240, 690, 80)] }],
      type: 'text',
      label: COMPANY,
    });

    expect(out.placed).toBe(false);
    if (!out.placed) expect(out.code).toBe('cell-not-blank');
  });

  it('refuses a cell too small to hold a value', () => {
    const page = coverPage();
    const out = proposeScalarCell({
      pages: [
        {
          ...page,
          // Floor raised to within 4pt of the caption cell's underside.
          rules: [...page.rules!.filter((r) => r.y > 690), rule(698, 222.3, 384.8)],
        },
      ],
      type: 'text',
      label: COMPANY,
    });

    expect(out.placed).toBe(false);
    if (!out.placed) expect(out.code).toBe('cell-too-small');
  });

  it('always states a reason, never just declines', () => {
    // An invisible refusal is nearly as harmful as a wrong box: the reviewer
    // cannot tell "this looked and declined" from "nothing ever ran", so they
    // do not know the field still needs drawing by hand.
    const cases = [
      { type: 'signature' as const, label: COMPANY },
      { type: 'text' as const, label: 'Not printed on this page at all' },
      { type: 'text' as const, label: 'Name' },
    ];
    for (const c of cases) {
      const out = proposeScalarCell({ pages: [coverPage()], ...c });
      expect(out.placed).toBe(false);
      if (!out.placed) {
        expect(out.code).toBeTruthy();
        expect(out.reason.length).toBeGreaterThan(10);
      }
    }
  });
});
