/**
 * Where the search for a question's answers has to STOP.
 *
 * Reported from a real mapping session: Q1 proposed nothing while Q2 proposed
 * correctly. Both are True/False questions, one directly above the other.
 *
 * The search ran a fixed number of rows forward from the question, so Q1's window
 * reached into Q2 and found "True" twice — and finding an option twice is
 * ambiguity, which refuses. Q2 succeeded only because the question BELOW it has
 * different answers, so its own window happened to be clean. Nothing about Q1 was
 * wrong; it was simply the one with a like-for-like neighbour, and every
 * consecutive pair of True/False questions on the paper has the same problem.
 */
import { describe, expect, it } from 'vitest';
import { proposeInlineOptionCells } from './pdf-geometry.js';
import type { PositionedText, TextPage } from './pdf-geometry.js';

const A4 = { pageWidth: 595, pageHeight: 842 };

const Q1 = 'The track dozer must be isolated with a lock and hasp before maintenance';
const Q2 = '3 points of contact is always required when accessing or egressing';
const Q3 = 'What is the purpose of performing a walk around pre-start inspection';

/** One numbered question with lettered True/False answers beneath it. */
function trueFalse(n: number, text: string, top: number): PositionedText[] {
  return [
    { text: `${n}.`, x: 40, y: top, width: 8 },
    { text, x: 58, y: top, width: 300 },
    { text: 'a)', x: 70, y: top - 16.8, width: 9 },
    { text: 'True', x: 88, y: top - 16.8, width: 18 },
    { text: 'b)', x: 70, y: top - 33.6, width: 9 },
    { text: 'False', x: 88, y: top - 33.6, width: 20 },
  ];
}

/** Q3's shape: four prose answers, so it cannot collide with True/False. */
function fourChoice(n: number, text: string, top: number): PositionedText[] {
  return [
    { text: `${n}.`, x: 40, y: top, width: 8 },
    { text, x: 58, y: top, width: 320 },
    { text: 'a)', x: 70, y: top - 16.8, width: 9 },
    { text: 'Inspect for damage', x: 88, y: top - 16.8, width: 90 },
    { text: 'b)', x: 70, y: top - 33.6, width: 9 },
    { text: 'Identify faults with the machine', x: 88, y: top - 33.6, width: 140 },
  ];
}

/** The measured page shape: Q1 and Q2 both True/False, Q3 a four-choice. */
const page: TextPage = {
  width: 595,
  height: 842,
  items: [
    ...trueFalse(1, Q1, 700),
    ...trueFalse(2, Q2, 640),
    ...fourChoice(3, Q3, 580),
  ],
};

const propose = (label: string) =>
  proposeInlineOptionCells({ page: 2, ...A4, items: page.items, label, options: ['True', 'False'] });

describe('the answer search stops at the next question', () => {
  it('proposes for a True/False question followed by another one', () => {
    // The reported failure. Q1 is 60pt above Q2, well inside any fixed window.
    const res = propose(`Q1. ${Q1}`);

    expect(res).not.toBeNull();
    expect(res!.segments).toHaveLength(2);
  });

  it('takes Q1 own answers, not the next question ones', () => {
    const res = propose(`Q1. ${Q1}`)!;

    // Q1's markers sit at 683.2 and 666.4; Q2's at 623.2 and 606.4. Reaching
    // into Q2 would place Q1's verdict against a different question entirely.
    expect(res.segments[0]!.y).toBeGreaterThan(660);
    expect(res.segments[1]!.y).toBeGreaterThan(640);
  });

  it('still proposes for the question that already worked', () => {
    const res = propose(`Q2. ${Q2}`)!;

    expect(res).not.toBeNull();
    expect(res.segments).toHaveLength(2);
  });

  it('keeps each question answers separate from the other', () => {
    const first = propose(`Q1. ${Q1}`)!;
    const second = propose(`Q2. ${Q2}`)!;

    // No shared box between two questions asking the same thing.
    expect(first.segments[0]!.y).not.toBeCloseTo(second.segments[0]!.y, 1);
    expect(first.segments[0]!.y).toBeGreaterThan(second.segments[0]!.y);
  });

  it('refuses when an option really is duplicated inside one question', () => {
    // The ambiguity guard still has to work. Two "True" rows under ONE question,
    // with no intervening question to bound the search.
    const messy: PositionedText[] = [
      { text: '1.', x: 40, y: 700, width: 8 },
      { text: Q1, x: 58, y: 700, width: 300 },
      { text: 'True', x: 88, y: 683.2, width: 18 },
      { text: 'True', x: 88, y: 666.4, width: 18 },
      { text: 'False', x: 88, y: 649.6, width: 20 },
    ];

    expect(
      proposeInlineOptionCells({
        page: 2,
        ...A4,
        items: messy,
        label: `Q1. ${Q1}`,
        options: ['True', 'False'],
      }),
    ).toBeNull();
  });
});
