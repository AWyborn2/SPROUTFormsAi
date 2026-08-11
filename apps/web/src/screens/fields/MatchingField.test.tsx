// @vitest-environment jsdom
/**
 * The matching interactive.
 *
 * ONE PROPERTY CARRIES THIS FILE: whatever the candidate does on screen, the
 * value written is the same array of pairing strings the grouped checkbox list
 * produces. `markTheory` compares that array against `answerKey` as an exact set
 * and looks at nothing else, so if this holds, marking, storage, the evidence
 * export and every existing test are untouched by the presentation.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { pairingOption } from '@formai/shared';
import { MatchingField } from './MatchingField.js';

const OPTIONS = [
  pairingOption('Restricted area', 'Red triangle'),
  pairingOption('Restricted area', 'Blue circle'),
  pairingOption('Fire point', 'Red triangle'),
  pairingOption('Fire point', 'Blue circle'),
];

function setup(over: { value?: string[]; disabled?: boolean } = {}) {
  const onChange = vi.fn();
  render(
    <MatchingField
      options={OPTIONS}
      value={over.value ?? []}
      presentation={{ mode: 'line' }}
      disabled={over.disabled}
      labelId="q1"
      onChange={onChange}
    />,
  );
  return { onChange };
}

const pick = (statement: string) => fireEvent.click(screen.getByText(statement));
const match = (statement: string, answer: string) =>
  fireEvent.click(screen.getByRole('button', { name: `Match ${statement} to ${answer}` }));

describe('MatchingField', () => {
  it('writes exactly the pairing option the grouped list would write', () => {
    const { onChange } = setup();

    pick('Restricted area');
    match('Restricted area', 'Red triangle');

    expect(onChange).toHaveBeenCalledWith([pairingOption('Restricted area', 'Red triangle')]);
  });

  it('REPLACES a statement’s answer rather than accumulating', () => {
    // A line from a dot and a card in a slot are both singular by shape.
    // Accumulating would let a candidate produce a set the paper cannot express.
    const { onChange } = setup({ value: [pairingOption('Restricted area', 'Red triangle')] });

    pick('Restricted area');
    match('Restricted area', 'Blue circle');

    expect(onChange).toHaveBeenCalledWith([pairingOption('Restricted area', 'Blue circle')]);
  });

  it('leaves the OTHER statements’ answers alone', () => {
    // Editing one pairing is an edit, not a reset.
    const { onChange } = setup({ value: [pairingOption('Fire point', 'Blue circle')] });

    pick('Restricted area');
    match('Restricted area', 'Red triangle');

    expect(onChange.mock.calls[0]![0]).toEqual([
      pairingOption('Fire point', 'Blue circle'),
      pairingOption('Restricted area', 'Red triangle'),
    ]);
  });

  it('clears exactly one statement’s answer', () => {
    const { onChange } = setup({
      value: [
        pairingOption('Restricted area', 'Red triangle'),
        pairingOption('Fire point', 'Blue circle'),
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Clear the answer for Restricted area' }));

    expect(onChange).toHaveBeenCalledWith([pairingOption('Fire point', 'Blue circle')]);
  });

  it('offers every distinct answer to every statement', () => {
    // The answer side is a shared pool: any statement may take any answer, and
    // limiting the offer would make a correct response unreachable.
    setup();
    pick('Fire point');

    expect(screen.getByRole('button', { name: 'Match Fire point to Red triangle' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Match Fire point to Blue circle' })).toBeTruthy();
  });

  it('shows a statement’s current answer without opening the picker', () => {
    setup({ value: [pairingOption('Restricted area', 'Red triangle')] });
    expect(screen.getByText('Red triangle')).toBeTruthy();
    // Not picking, so no match buttons are rendered.
    expect(screen.queryByRole('button', { name: /^Match / })).toBeNull();
  });

  it('writes nothing while disabled', () => {
    const { onChange } = setup({ disabled: true });
    pick('Restricted area');
    expect(screen.queryByRole('button', { name: /^Match / })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders one row per statement, not one per pairing', () => {
    // Four options, two statements. A row per option is the flat list this
    // presentation exists to replace.
    setup();
    expect(screen.getByText('Restricted area')).toBeTruthy();
    expect(screen.getByText('Fire point')).toBeTruthy();
  });
});

/**
 * Two things this component promised and did not do.
 */
function setupWith(
  presentation: Parameters<typeof MatchingField>[0]['presentation'],
  over: { value?: string[]; disabled?: boolean } = {},
) {
  const onChange = vi.fn();
  render(
    <MatchingField
      options={OPTIONS}
      value={over.value ?? []}
      presentation={presentation}
      disabled={over.disabled}
      labelId="q1"
      onChange={onChange}
    />,
  );
  return { onChange };
}

describe('MatchingField — drag mode actually drags', () => {
  /*
    `mode: 'drag'` rendered "Drop an answer here" over a tap-to-pick control.
    Nothing was draggable, nothing accepted a drop, and a candidate who followed
    the instruction literally got stuck on a competency assessment.
  */
  const drag = (answer: string, statement: string) => {
    const chip = screen.getByText(answer, { selector: 'span[draggable]' });
    // jsdom synthesises no `dataTransfer`; a real browser always supplies one.
    fireEvent.dragStart(chip, { dataTransfer: { setData: vi.fn(), effectAllowed: '' } });
    const row = screen.getByText(statement).closest('div[class*="rounded-"]')!;
    fireEvent.dragOver(row);
    fireEvent.drop(row);
  };

  it('OFFERS A TRAY OF DRAGGABLE ANSWERS', () => {
    setupWith({ mode: 'drag' });

    const chip = screen.getByText('Red triangle', { selector: 'span[draggable]' });
    expect(chip.getAttribute('draggable')).toBe('true');
  });

  it('WRITES THE PAIRING WHEN AN ANSWER IS DROPPED ON A STATEMENT', () => {
    const { onChange } = setupWith({ mode: 'drag' });

    drag('Red triangle', 'Restricted area');

    expect(onChange).toHaveBeenCalledWith([pairingOption('Restricted area', 'Red triangle')]);
  });

  it('keeps an answer in the tray after use, because one sign can answer two statements', () => {
    setupWith({ mode: 'drag', ...{} }, { value: [pairingOption('Restricted area', 'Red triangle')] });

    expect(screen.getByText('Red triangle', { selector: 'span[draggable]' })).toBeDefined();
  });

  it('TAP STILL WORKS IN DRAG MODE, because a phone fires no drag events', () => {
    // A site assessment is filled on a phone, where HTML5 drag-and-drop does
    // not fire at all — so drag is an addition, never the only way through.
    const { onChange } = setupWith({ mode: 'drag' });

    pick('Restricted area');
    match('Restricted area', 'Blue circle');

    expect(onChange).toHaveBeenCalledWith([pairingOption('Restricted area', 'Blue circle')]);
  });

  it('does not make the tray draggable when the field is disabled', () => {
    setupWith({ mode: 'drag' }, { disabled: true });

    expect(
      screen.getByText('Red triangle', { selector: 'span[draggable]' }).getAttribute('draggable'),
    ).toBe('false');
  });

  it('shows no tray in line mode', () => {
    setupWith({ mode: 'line' });

    expect(screen.queryByText('Red triangle', { selector: 'span[draggable]' })).toBeNull();
  });
});

describe('MatchingField — the pictures the author uploaded', () => {
  /*
    `MatchPresentation` has carried an asset id per entry since the pair builder
    could upload one, and this component rendered none of it. On "match the
    statement with the appropriate signage" the candidate saw the extraction's
    WORDS for each sign instead of the sign — a reading question about a
    description of signage, not a matching question about signage.
  */
  const WITH_IMAGES = {
    mode: 'drag' as const,
    rightImages: true,
    images: { r0: 'org/red.png', r1: 'org/blue.png' },
  };

  it('RENDERS AN ANSWER’S PICTURE FROM ITS ASSET ID', () => {
    setupWith(WITH_IMAGES);

    const img = screen.getAllByAltText('Red triangle')[0]!;
    expect(img.getAttribute('src')).toBe('/api/uploads/file/org/red.png');
  });

  it('keeps the text alongside, so a failed load is not an unlabelled box', () => {
    // The text is also what the stored answer is keyed on, and what a screen
    // reader gets.
    setupWith(WITH_IMAGES);

    expect(screen.getByText('Red triangle')).toBeDefined();
  });

  it('renders nothing for an entry with no uploaded picture', () => {
    setupWith({ mode: 'drag', rightImages: true, images: { r0: 'org/red.png' } });

    expect(screen.queryByAltText('Blue circle')).toBeNull();
  });

  it('RENDERS NOTHING WHEN THE AUTHOR DID NOT TURN THAT SIDE ON', () => {
    // An id left over from a side the author switched off is not a picture they
    // asked to show.
    setupWith({ mode: 'drag', images: { r0: 'org/red.png' } });

    expect(screen.queryByAltText('Red triangle')).toBeNull();
  });
});
