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

/**
 * Outcome boxes.
 *
 * `check_cross` had no case in the renderer at all, so it drew a grey chip
 * printing the literal string "check_cross". That is the type of every theory
 * question's outcome box and of every part's satisfactory / not-yet-competent
 * pair, so on a competency assessment the placeholder was most of the screen an
 * assessor works in.
 *
 * The three-state rule is what these pin. A cross is a finding — "I checked
 * this and it failed" — and only null means nobody assessed it, which is the
 * distinction the exported evidence draws when it prints a tick, a cross, or
 * nothing at all.
 */
function outcomeField(extra: Partial<FormField> = {}): FormField {
  return {
    id: 'q1_outcome',
    type: 'check_cross',
    label: 'Q1 outcome',
    required: false,
    source: 'imported',
    ...extra,
  };
}

describe('FieldInput — check_cross outcome boxes', () => {
  it('draws a real control rather than the unsupported-type placeholder', () => {
    render(<FieldInput field={outcomeField()} value={null} onChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Satisfactory' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Not satisfactory' })).toBeTruthy();
    expect(screen.queryByText('check_cross')).toBeNull();
  });

  it('records a tick as true and a cross as an explicit false', () => {
    // Not "false is unticked": both are recorded verdicts, and the exporter
    // draws a different mark for each.
    const onChange = vi.fn();
    const { rerender } = render(
      <FieldInput field={outcomeField()} value={null} onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Satisfactory' }));
    expect(onChange).toHaveBeenLastCalledWith(true);

    rerender(<FieldInput field={outcomeField()} value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Not satisfactory' }));
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('shows which verdict is recorded', () => {
    const { rerender } = render(
      <FieldInput field={outcomeField()} value={true} onChange={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Satisfactory' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(
      screen.getByRole('button', { name: 'Not satisfactory' }).getAttribute('aria-pressed'),
    ).toBe('false');

    rerender(<FieldInput field={outcomeField()} value={false} onChange={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: 'Not satisfactory' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('lets a mis-click go back to unassessed, which a radio group could not', () => {
    // Null is the only state meaning nobody assessed this. Without a way back,
    // one wrong click permanently asserts a verdict on a competency record.
    const onChange = vi.fn();
    render(<FieldInput field={outcomeField()} value={true} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Satisfactory' }));

    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('honours disabled', () => {
    const onChange = vi.fn();
    render(<FieldInput field={outcomeField()} value={null} onChange={onChange} disabled />);

    fireEvent.click(screen.getByRole('button', { name: 'Satisfactory' }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('is never dictatable — a verdict is pressed, not transcribed', () => {
    expect(canDictateField(outcomeField())).toBe(false);
  });
});
