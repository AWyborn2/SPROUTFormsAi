// @vitest-environment jsdom
/**
 * One-per-screen fill can finish a page that has no multiple-choice question.
 *
 * The quiz was built entirely around a choice field: Submit checked its answer
 * against the key, and the completion gate keyed off it. A page whose only field
 * is a signature — or any short answer — has no choice field and no key, so it
 * became a dead end: Submit stayed disabled forever and the part could not be
 * handed in. These defend that such a page finishes once its required inputs are
 * filled, while the choice-question path is untouched.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { FormField } from '@formai/shared';
import type { TheoryPage } from '../../lib/theory-pages.js';

// The field renderers are exercised by their own suites; here they would only
// drag in dictation and canvas. Stub them so the test is about the quiz's own
// completion gating.
vi.mock('../fields/FieldRenderer.js', () => ({
  FieldInput: ({ field }: { field: FormField }) => <div data-testid={`field-${field.id}`} />,
}));
vi.mock('./QuizOptionCards.js', () => ({
  QuizOptionCards: ({ field }: { field: FormField }) => <div data-testid={`quiz-${field.id}`} />,
}));
vi.mock('./TheoryResults.js', () => ({
  TheoryResults: () => <div data-testid="results" />,
}));

const { TheoryQuiz } = await import('./TheoryQuiz.js');

const field = (over: Partial<FormField> & { id: string }): FormField => ({
  label: over.id,
  type: 'text',
  required: false,
  source: 'imported',
  ...over,
});

const page = (fields: FormField[], index = 0): TheoryPage => ({ fields, index });

function renderQuiz(over: Partial<ComponentProps<typeof TheoryQuiz>> = {}) {
  const props: ComponentProps<typeof TheoryQuiz> = {
    pages: [page([field({ id: 't1', required: true })])],
    values: {},
    writable: new Set(['t1']),
    allowRetry: false,
    passPercent: 100,
    partLabel: 'Candidate declaration',
    partKey: 'part-1',
    caseId: 'case-1',
    attemptId: 'att-1',
    onValueChange: vi.fn(),
    onCheckQuestion: vi.fn().mockResolvedValue({ correct: true }),
    onSave: vi.fn().mockResolvedValue(undefined),
    onSubmit: vi.fn().mockResolvedValue({ outcome: 'satisfactory' }),
    onTryAgain: vi.fn(),
    onBack: vi.fn(),
    submitting: false,
    saving: false,
    ...over,
  };
  render(<TheoryQuiz {...props} />);
  return props;
}

const button = (name: RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('TheoryQuiz — a page with no choice question', () => {
  it('shows Finish, not the choice-answer Submit', () => {
    renderQuiz();
    // The quiz "Submit" (check-answer) is a choice-question control; a signature
    // page has none, so it never appears — only Finish does.
    expect(screen.queryByRole('button', { name: /^submit$/i })).toBeNull();
    expect(button(/finish/i)).toBeTruthy();
  });

  it('keeps Finish disabled until the required input is filled', () => {
    renderQuiz({ values: {} });
    expect(button(/finish/i).disabled).toBe(true);
  });

  it('enables Finish once the required input is filled (the signature was drawn)', () => {
    renderQuiz({ values: { t1: 'data:image/png;base64,AAAA' } });
    expect(button(/finish/i).disabled).toBe(false);
  });

  it('does not gate on an OPTIONAL non-choice field', () => {
    renderQuiz({
      pages: [page([field({ id: 'opt', required: false })])],
      writable: new Set(['opt']),
      values: {},
    });
    expect(button(/finish/i).disabled).toBe(false);
  });
});

describe('TheoryQuiz — a choice-question page is unchanged', () => {
  it('still renders the check-answer Submit', () => {
    renderQuiz({
      pages: [page([field({ id: 'q1', type: 'radio', options: ['a', 'b'], required: true })])],
      writable: new Set(['q1']),
      values: {},
    });
    // Submit is the choice path; it is present (disabled until answered) and no
    // Finish button shows in its place.
    expect(button(/submit/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /finish/i })).toBeNull();
  });
});
