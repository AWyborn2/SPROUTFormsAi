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
