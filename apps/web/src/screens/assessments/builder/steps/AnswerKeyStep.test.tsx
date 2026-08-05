// @vitest-environment jsdom
/**
 * Step 5 — the answer key.
 *
 * The rules this step is built on are tested where they live: exact-set marking
 * in `marking.test.ts`, the matching model in `matching.test.ts`, the pair
 * builder in `PairBuilder.test.tsx`. What is left here is the three things this
 * step alone decides, each of which is a way to mark a candidate wrong on a
 * question they answered correctly:
 *
 *   · whether a question REPLACES or ACCUMULATES its key,
 *   · what happens to a key when the question's type changes underneath it,
 *   · what happens to an attestation when the answers it attested to change.
 *
 * The hook is driven through a real `ingest` against a mocked API rather than
 * by handing the component a fabricated state object. The key operations write
 * to `fields` as well as to `keys`, so a harness that supplied fields as a prop
 * would assert against a copy the reducers never touched — and would pass with
 * the reducers broken.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { ExtractedField } from '@formai/shared';
import { AnswerKeyStep } from './AnswerKeyStep.js';
import { useBuilderDraftState, type BuilderDraftState } from '../use-builder-draft.js';

vi.mock('@formai/ui', () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

const post = vi.fn();
vi.mock('../../../../lib/data/api-client.js', () => ({
  apiClient: { post: (...args: unknown[]) => post(...args) },
  ApiError: class ApiError extends Error {
    status = 0;
    body: unknown = {};
  },
  uploadAttachment: vi.fn(),
}));

vi.mock('../../../../lib/data/import-session.js', () => ({
  fileToBase64: () => Promise.resolve('JVBERi0='),
  IMPORT_REQUEST_TIMEOUT_MS: 1000,
}));

function field(over: Partial<ExtractedField> & { id: string }): ExtractedField {
  return {
    label: over.id,
    type: 'radio',
    confidence: 0.9,
    options: ['a', 'b', 'c'],
    ...over,
  };
}

/**
 * A hook holding the given extracted fields, via the real ingest path.
 */
async function draftOf(fields: ExtractedField[]) {
  post.mockReset();
  post.mockResolvedValueOnce({ assetId: 'asset-1' }).mockResolvedValueOnce({
    sourceType: 'pdf_import',
    path: 'ai',
    fileName: 'assessment.pdf',
    pageCount: 3,
    fields,
    designNotes: [],
  });

  const { result } = renderHook(() => useBuilderDraftState());
  await act(async () => {
    await result.current.ingest(new File(['x'], 'assessment.pdf', { type: 'application/pdf' }));
  });
  return result;
}

/** Render the step against live hook state. */
function renderStep(result: { current: BuilderDraftState }) {
  function Harness() {
    return <AnswerKeyStep draft={result.current} actor="Training authority" />;
  }
  return render(<Harness />);
}

beforeEach(() => {
  post.mockReset();
});

describe('AnswerKeyStep', () => {
  it('keys a single-answer question by REPLACING, never accumulating', async () => {
    /*
      Marking is an exact set. On a one-answer question an accumulated second
      option fails every candidate who answers it correctly — so the difference
      between replace and accumulate is a correctness matter, not a UI nicety.
    */
    const result = await draftOf([field({ id: 'q1' })]);

    act(() => result.current.keyOps.toggleOption('q1', 'a', false));
    expect(result.current.keys[0]?.answerKey).toEqual(['a']);

    act(() => result.current.keyOps.toggleOption('q1', 'b', false));
    expect(result.current.keys[0]?.answerKey).toEqual(['b']);
  });

  it('accumulates a set on a several-answers question', async () => {
    const result = await draftOf([
      field({ id: 'q1', type: 'checkbox_group', selectionType: 'multiple' }),
    ]);

    act(() => result.current.keyOps.toggleOption('q1', 'a', true));
    act(() => result.current.keyOps.toggleOption('q1', 'c', true));

    expect(result.current.keys[0]?.answerKey).toEqual(['a', 'c']);
  });

  it('removes the entry entirely when the last option is unticked', async () => {
    // markTheory skips a field whose answerKey is absent OR empty, so both mean
    // "not auto-marked" — keeping an empty entry would let the UI report a
    // question as keyed that contributes no mark.
    const result = await draftOf([field({ id: 'q1' })]);

    act(() => result.current.keyOps.toggleOption('q1', 'a', false));
    expect(result.current.keys).toHaveLength(1);

    act(() => result.current.keyOps.toggleOption('q1', 'a', false));
    expect(result.current.keys).toHaveLength(0);
  });

  it('clears a question’s key when its type changes underneath it', async () => {
    /*
      THE SILENT ONE. An answer key is a list of option VALUES, and retyping
      reseeds or strips options. A key carried across that change names options
      the question no longer offers — and a stale key looks exactly like a
      current one.
    */
    const result = await draftOf([field({ id: 'q1' })]);

    act(() => result.current.keyOps.toggleOption('q1', 'a', false));
    expect(result.current.keys).toHaveLength(1);

    act(() => result.current.structureOps.setFieldType('q1', 'boolean_yes_no'));
    expect(result.current.keys).toHaveLength(0);
  });

  it('withdraws verification when the answers it attested to change', async () => {
    /*
      The attestation is "the training authority confirmed THESE answers".
      Carrying it onto a different set would let a key nobody has checked report
      itself as verified on a safety-critical assessment.
    */
    const result = await draftOf([field({ id: 'q1' })]);

    act(() => result.current.keyOps.setKey('q1', ['a']));
    act(() => result.current.keyOps.setVerified('q1', true, 'Training authority'));
    expect(result.current.keys[0]?.verifiedBy).toBe('Training authority');

    act(() => result.current.keyOps.setKey('q1', ['b']));
    expect(result.current.keys[0]?.verifiedBy).toBeUndefined();
    expect(result.current.keys[0]?.verifiedAt).toBeUndefined();
  });

  it('keeps verification when the same key is re-set in a different order', async () => {
    // Re-setting an identical set is not a change of answer, and dropping the
    // attestation for it would train an author to ignore the flag.
    const result = await draftOf([
      field({ id: 'q1', type: 'checkbox_group', selectionType: 'multiple' }),
    ]);

    act(() => result.current.keyOps.setKey('q1', ['a', 'c']));
    act(() => result.current.keyOps.setVerified('q1', true, 'Training authority'));
    act(() => result.current.keyOps.setKey('q1', ['c', 'a']));

    expect(result.current.keys[0]?.verifiedBy).toBe('Training authority');
  });

  it('drops both halves of the attestation when it is withdrawn', async () => {
    // A verifiedAt with nobody attached is a timestamp nobody stands behind.
    const result = await draftOf([field({ id: 'q1' })]);

    act(() => result.current.keyOps.setKey('q1', ['a']));
    act(() => result.current.keyOps.setVerified('q1', true, 'Training authority'));
    act(() => result.current.keyOps.setVerified('q1', false, 'Training authority'));

    expect(result.current.keys[0]?.verifiedBy).toBeUndefined();
    expect(result.current.keys[0]?.verifiedAt).toBeUndefined();
  });

  it('writes a matching question’s options onto the field and its key into the draft', async () => {
    const result = await draftOf([field({ id: 'q1' })]);

    act(() =>
      result.current.keyOps.saveMatching(
        'q1',
        { options: ['L -> R', 'L -> S'], answerKey: ['L -> R'] },
        { mode: 'line' },
      ),
    );

    const saved = result.current.fields.find((f) => f.id === 'q1');
    expect(saved?.type).toBe('checkbox_group');
    expect(saved?.selectionType).toBe('multiple');
    expect(saved?.options).toEqual(['L -> R', 'L -> S']);
    expect(saved?.matchPresentation).toEqual({ mode: 'line' });
    expect(result.current.keys[0]?.answerKey).toEqual(['L -> R']);
  });

  it('ticking an option in the rendered list keys the question', async () => {
    const result = await draftOf([field({ id: 'q1', label: 'Minimum clearance?' })]);
    renderStep(result);

    fireEvent.click(screen.getByRole('checkbox', { name: 'a is correct' }));

    expect(result.current.keys[0]).toMatchObject({ fieldId: 'q1', answerKey: ['a'] });
  });

  it('shows the printed question reference where extraction read one', async () => {
    // questionRef is what pairs a question with its outcome box; showing it is
    // what lets an author check a key against the paper rather than against a
    // position in a list.
    const result = await draftOf([field({ id: 'q1', questionRef: 'BBM Q3' })]);
    renderStep(result);

    expect(screen.getByText('BBM Q3')).toBeTruthy();
  });

  it('reports progress against the number of keyable questions', async () => {
    const result = await draftOf([field({ id: 'q1' }), field({ id: 'q2' }), field({ id: 'q3' })]);
    renderStep(result);

    expect(screen.getByRole('progressbar').getAttribute('aria-valuemax')).toBe('3');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
  });

  it('says so rather than rendering an empty list when nothing is keyable', async () => {
    const result = await draftOf([
      field({ id: 'sig', type: 'signature', options: undefined }),
      field({ id: 'name', type: 'text', options: undefined }),
    ]);
    renderStep(result);

    expect(screen.getByText(/No keyable questions were found/)).toBeTruthy();
  });
});
