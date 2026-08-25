// @vitest-environment jsdom
/**
 * The guide upload control.
 *
 * The parsing and matching are tested without a DOM in `answer-guide.test.ts`
 * and against the real file in `answer-guide.ae5.test.ts`. What is left here is
 * what only this component decides — and the one that matters is that a section
 * which did NOT seed is reported at the same prominence as the count of those
 * that did. A banner reporting only successes reads as "done", and the author
 * walks away from a stream with no answers in it.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FormField, StructureSection } from '@formai/shared';
import { KeySourceChooser } from './KeySourceChooser.js';

vi.mock('@formai/ui', () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

const post = vi.fn();
vi.mock('../../../lib/data/api-client.js', () => ({
  apiClient: { post: (...args: unknown[]) => post(...args) },
  ApiError: class ApiError extends Error {},
}));

vi.mock('../../../lib/data/import-session.js', () => ({
  fileToBase64: () => Promise.resolve('JVBERi0='),
  IMPORT_REQUEST_TIMEOUT_MS: 1000,
}));

function question(id: string): FormField {
  return { id, label: id, type: 'radio', required: false, source: 'imported', options: ['a', 'b', 'c'] };
}

const FIELDS = [question('q1'), question('q2')];
const SECTIONS: StructureSection[] = [
  { key: 'general', label: 'Written or Verbal Questions (General)', cols: 1, fields: [{ id: 'q1' }, { id: 'q2' }] },
];

function setup(onSeed = vi.fn()) {
  render(
    <KeySourceChooser
      sections={SECTIONS}
      fields={FIELDS}
      excluded={new Set()}
      onSeed={onSeed}
    />,
  );
  return { onSeed };
}

/** A File whose `text()` resolves to the given JSON. */
function jsonFile(value: unknown): File {
  const file = new File([JSON.stringify(value)], 'key.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(JSON.stringify(value)) });
  return file;
}

function upload(labelPattern: RegExp, file: File) {
  const label = screen.getByText(labelPattern).closest('label')!;
  const input = label.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file] });
  fireEvent.change(input);
}

beforeEach(() => post.mockReset());

describe('KeySourceChooser — JSON', () => {
  it('seeds a matching guide and reports the count', async () => {
    const { onSeed } = setup();

    upload(
      /Upload answer key/,
      jsonFile({ sections: { general: { questions: [{ n: 1, answers: ['a'] }, { n: 2, answers: ['b'] }] } } }),
    );

    await waitFor(() => expect(onSeed).toHaveBeenCalled());
    expect(onSeed.mock.calls[0]![0]).toEqual([
      { fieldId: 'q1', answerKey: ['a'], source: 'guide_json' },
      { fieldId: 'q2', answerKey: ['b'], source: 'guide_json' },
    ]);
    expect(screen.getByText(/2 answers seeded/)).toBeTruthy();
    expect(screen.getByText(/none verified/)).toBeTruthy();
  });

  it('shows what did NOT seed, not only what did', async () => {
    /*
      THE FAILURE THIS EXISTS FOR. A count-mismatched section seeds nothing. If
      the banner reported only "0 answers seeded" the author would read it as a
      bad file rather than as a section needing attention — and a banner that
      reported only successes would read as done.
    */
    setup();

    upload(/Upload answer key/, jsonFile({ sections: { general: { questions: [{ n: 1, answers: ['a'] }] } } }));

    await waitFor(() => expect(screen.getByText(/1 answer.*for/)).toBeTruthy());
    const problem = screen.getByText(/which has 2 questions/);
    expect(problem.textContent).toContain('none were applied');
  });

  it('reports keys and MODEL ANSWERS as separate numbers', async () => {
    /*
      "15 answers seeded" over 4 keys and 11 guides would claim auto-marking
      for questions the machine never touches. The two numbers are different
      promises and the banner says both.
    */
    const written: FormField = {
      id: 'w1',
      label: 'Explain the exclusion zone',
      type: 'textarea',
      required: false,
      source: 'imported',
    };
    const onSeed = vi.fn();
    render(
      <KeySourceChooser
        sections={[
          { key: 'general', label: 'Written or Verbal Questions (General)', cols: 1, fields: [{ id: 'q1' }, { id: 'w1' }] },
        ]}
        fields={[question('q1'), written]}
        excluded={new Set()}
        onSeed={onSeed}
      />,
    );

    upload(
      /Upload answer key/,
      jsonFile({
        sections: {
          general: {
            questions: [
              { n: 1, answers: ['a'] },
              { n: 2, answers: ['Nobody enters while tipping.'] },
            ],
          },
        },
      }),
    );

    await waitFor(() => expect(onSeed).toHaveBeenCalled());
    expect(onSeed.mock.calls[0]![0]).toEqual([
      { fieldId: 'q1', answerKey: ['a'], source: 'guide_json' },
      {
        fieldId: 'w1',
        answerKey: [],
        modelAnswer: 'Nobody enters while tipping.',
        source: 'guide_json',
      },
    ]);
    expect(screen.getByText(/1 answer · 1 model answer seeded/)).toBeTruthy();
  });

  it('names both accepted shapes when the file is neither', async () => {
    setup();
    upload(/Upload answer key/, jsonFile({ nope: true }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('"sections"');
  });

  it('says the file is not JSON rather than failing silently', async () => {
    setup();
    const file = new File(['not json'], 'key.json');
    Object.defineProperty(file, 'text', { value: () => Promise.resolve('not json') });
    upload(/Upload answer key/, file);

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('could not be read as JSON');
  });
});

describe('KeySourceChooser — PDF', () => {
  it('sends every keyable question with its options, and seeds what comes back', async () => {
    // The server route matches by question TEXT, which it can only do if the
    // text is sent.
    post.mockResolvedValueOnce({ answers: { q1: ['a'] }, notes: [] });
    const { onSeed } = setup();

    upload(/Upload answer guide/, new File(['%PDF-'], 'guide.pdf', { type: 'application/pdf' }));

    await waitFor(() => expect(onSeed).toHaveBeenCalled());
    const [path, body] = post.mock.calls[0]!;
    expect(path).toBe('/answer-guides/match');
    expect((body as { questions: unknown[] }).questions).toEqual([
      { fieldId: 'q1', label: 'q1', options: ['a', 'b', 'c'], section: 'Written or Verbal Questions (General)' },
      { fieldId: 'q2', label: 'q2', options: ['a', 'b', 'c'], section: 'Written or Verbal Questions (General)' },
    ]);
    expect(onSeed.mock.calls[0]![0]).toEqual([
      { fieldId: 'q1', answerKey: ['a'], source: 'guide_document' },
    ]);
  });

  it('says how many questions the guide did not answer', async () => {
    // A guide covering half a paper is a normal outcome, and the number left is
    // the author's remaining work.
    post.mockResolvedValueOnce({ answers: { q1: ['a'] }, notes: [] });
    setup();

    upload(/Upload answer guide/, new File(['%PDF-'], 'guide.pdf', { type: 'application/pdf' }));

    const banner = await screen.findByText(/1 answer seeded/);
    expect(banner.closest('p')!.textContent).toContain('1 question still needs keying by hand.');
  });

  it('surfaces the model’s own notes as problems', async () => {
    post.mockResolvedValueOnce({
      answers: {},
      notes: ['The guide does not cover the Raw Materials stream.'],
    });
    setup();

    upload(/Upload answer guide/, new File(['%PDF-'], 'guide.pdf', { type: 'application/pdf' }));

    await waitFor(() =>
      expect(screen.getByText(/does not cover the Raw Materials stream/)).toBeTruthy(),
    );
  });

  it('reports a failed match rather than seeding nothing quietly', async () => {
    post.mockRejectedValueOnce(new Error('boom'));
    const { onSeed } = setup();

    upload(/Upload answer guide/, new File(['%PDF-'], 'guide.pdf', { type: 'application/pdf' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('could not be read');
    expect(onSeed).not.toHaveBeenCalled();
  });
});
