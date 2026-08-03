// @vitest-environment jsdom
/**
 * Matching questions on the fill surface.
 *
 * A matching question is stored as a checkbox group whose options are every
 * possible PAIRING — three statements against three signs is nine options — so
 * the flat renderer gave a candidate nine lines each repeating a whole
 * statement. That is not a rendering nicety on a safety assessment: a question
 * somebody has to decode before they can answer is a question that measures
 * something other than what it claims to.
 *
 * The value is deliberately untouched by the layout. Marking, storage and the
 * exported evidence must see exactly what a flat group would have produced, so
 * every test here checks what `onChange` emits, not only what is drawn.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { buildMatchingQuestion } from '@formai/shared';
import type { FormField } from '@formai/shared';
import { FieldInput, canDictateField } from './FieldRenderer.js';

const SIGNAGE = buildMatchingQuestion({
  lefts: ['Restricted area', 'Permission to pass'],
  rights: ['Biosecurity sign', 'Traffic hazard sign'],
  correct: [
    { left: 'Restricted area', right: 'Biosecurity sign' },
    { left: 'Permission to pass', right: 'Traffic hazard sign' },
  ],
});

function matchingField(extra: Partial<FormField> = {}): FormField {
  return {
    id: 'q7',
    type: 'checkbox_group',
    label: 'Match the statement with the appropriate signage.',
    required: true,
    source: 'imported',
    options: SIGNAGE.options,
    ...extra,
  };
}

function plainGroup(): FormField {
  return {
    id: 'ppe',
    type: 'checkbox_group',
    label: 'PPE worn',
    required: false,
    source: 'imported',
    options: ['Helmet', 'Gloves'],
  };
}

describe('FieldInput — matching questions', () => {
  it('shows each statement once, not once per option', () => {
    // Four options over two statements. Flat, "Restricted area" would appear
    // twice; grouped, it is a heading above its own choices.
    render(<FieldInput field={matchingField()} value={[]} onChange={vi.fn()} />);

    expect(screen.getAllByText('Restricted area')).toHaveLength(1);
    expect(screen.getAllByText('Permission to pass')).toHaveLength(1);
  });

  it('labels each choice with the sign alone, since the statement is above it', () => {
    render(<FieldInput field={matchingField()} value={[]} onChange={vi.fn()} />);

    // Two statements × two signs: each sign name appears once per group.
    expect(screen.getAllByLabelText('Biosecurity sign')).toHaveLength(2);
    expect(screen.getAllByLabelText('Traffic hazard sign')).toHaveLength(2);
    // And the whole pairing string is never rendered as a label.
    expect(screen.queryByText(/Restricted area ->/)).toBeNull();
  });

  it('emits the WHOLE pairing, not the half it displayed', () => {
    /*
      The layout is presentation only. What lands in the submission has to be
      the exact option string the answer key was built from, or marking compares
      "Biosecurity sign" against "Restricted area -> Biosecurity sign" and every
      candidate fails.
    */
    const onChange = vi.fn();
    render(<FieldInput field={matchingField()} value={[]} onChange={onChange} />);

    fireEvent.click(screen.getAllByLabelText('Biosecurity sign')[0]!);

    expect(onChange).toHaveBeenCalledWith(['Restricted area -> Biosecurity sign']);
    expect(SIGNAGE.options).toContain('Restricted area -> Biosecurity sign');
  });

  it('adds to the existing selection rather than replacing it', () => {
    // A matching answer is a SET — one pairing per statement — so ticking the
    // second must not clear the first.
    const onChange = vi.fn();
    render(
      <FieldInput
        field={matchingField()}
        value={['Restricted area -> Biosecurity sign']}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getAllByLabelText('Traffic hazard sign')[1]!);

    expect(onChange).toHaveBeenCalledWith([
      'Restricted area -> Biosecurity sign',
      'Permission to pass -> Traffic hazard sign',
    ]);
  });

  it('unticks by removing exactly that pairing', () => {
    const onChange = vi.fn();
    render(
      <FieldInput
        field={matchingField()}
        value={['Restricted area -> Biosecurity sign', 'Permission to pass -> Traffic hazard sign']}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getAllByLabelText('Biosecurity sign')[0]!);

    expect(onChange).toHaveBeenCalledWith(['Permission to pass -> Traffic hazard sign']);
  });

  it('reflects what is already selected', () => {
    render(
      <FieldInput
        field={matchingField()}
        value={['Restricted area -> Biosecurity sign']}
        onChange={vi.fn()}
      />,
    );

    expect((screen.getAllByLabelText('Biosecurity sign')[0] as HTMLInputElement).checked).toBe(true);
    expect((screen.getAllByLabelText('Biosecurity sign')[1] as HTMLInputElement).checked).toBe(false);
  });

  it('leaves an ordinary checkbox group flat', () => {
    // The branch keys on the OPTIONS being pairings, not on the type. Every
    // existing checkbox group in every form must render exactly as before.
    const onChange = vi.fn();
    render(<FieldInput field={plainGroup()} value={[]} onChange={onChange} />);

    fireEvent.click(screen.getByLabelText('Helmet'));

    expect(onChange).toHaveBeenCalledWith(['Helmet']);
  });
});

describe('canDictateField', () => {
  it('refuses a matching question', () => {
    /*
      A mic here would let a candidate answer "Match the statement with the
      appropriate SIGNAGE" by saying the sign's name — the visual-recognition
      bypass the question exists to test for, offered by the form itself. And
      coercing speech into a set of "statement -> sign" strings would be noise
      even if that were not true.
    */
    expect(canDictateField(matchingField())).toBe(false);
  });

  it('still allows an ordinary checkbox group', () => {
    expect(canDictateField(plainGroup())).toBe(true);
  });
});
