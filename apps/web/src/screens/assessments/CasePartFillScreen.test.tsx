// @vitest-environment jsdom
/**
 * The assessor's marking pass on a handed-in attempt (U7).
 *
 * A submitted-unmarked attempt used to be read-only for everyone. Now the
 * server serves `party`, a role-gated `markingGuide`, pre-marked keyed ✓/✗
 * cells merged under the stored values, and a `writableFieldIds` narrowed to
 * the MARKING SURFACE — and this screen opens for exactly that surface. These
 * pin the four things that must not drift:
 *
 *  - the assessor may tick, but the candidate's prose stays frozen;
 *  - the model answers render for the assessor and NOWHERE for the candidate
 *    (the leak pin — the guide is absent from their payload, and no candidate
 *    render may contain the text);
 *  - a marking-pass save PATCHes ONLY writable entries — the served pre-marks
 *    sit at auto-locked cells, and echoing them back would be refused as
 *    foreign fields;
 *  - a marked attempt is a locked record for the assessor too.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { FormField } from '@formai/shared';
import type { AttemptFillView } from '../../lib/data/assessments.js';

// The real renderers drag in dictation and canvas; the screen's own contract is
// which fields it DISABLES and what it saves, so the stub exposes exactly that.
vi.mock('../fields/FieldRenderer.js', () => ({
  FieldInput: ({
    field,
    value,
    disabled,
    onChange,
  }: {
    field: FormField;
    value: unknown;
    disabled: boolean;
    onChange: (v: unknown) => void;
  }) => (
    <div>
      <input
        data-testid={`field-${field.id}`}
        disabled={disabled}
        value={value === null || value === undefined ? '' : String(value)}
        readOnly
      />
      {/* A deterministic way for a test to "tick" a box through the screen's
          own setValue path, dirty-tracking included. */}
      <button data-testid={`set-${field.id}`} onClick={() => onChange(true)} />
    </div>
  ),
}));
vi.mock('./TheoryQuiz.js', () => ({ TheoryQuiz: () => <div data-testid="theory-quiz" /> }));
vi.mock('./LogbookProgress.js', () => ({ LogbookProgress: () => null }));

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useParams: () => ({ id: 'case-1', attemptId: 'att-1' }),
}));

// The toast context would otherwise demand a provider; everything else from the
// UI kit (Button, Icon) renders as-is so the role queries are the real DOM.
vi.mock('@formai/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@formai/ui')>()),
  useToast: () => ({ toast: vi.fn() }),
}));

const saveMutate = vi.fn();
const hookState: { attempt: AttemptFillView | undefined } = { attempt: undefined };
vi.mock('../../lib/data/hooks.js', () => ({
  useAssessmentAttempt: () => ({ data: hookState.attempt, isLoading: false }),
  useSaveAttempt: () => ({ mutate: saveMutate, isPending: false }),
  useSetAttemptSubmitted: () => ({ mutate: vi.fn(), isPending: false }),
  useOpenAttempt: () => ({ mutate: vi.fn(), isPending: false }),
  useCheckQuestion: () => ({ mutateAsync: vi.fn() }),
  useSession: () => ({ data: { userName: 'Alex Assessor' } }),
}));

const { CasePartFillScreen } = await import('./CasePartFillScreen.js');

const field = (over: Partial<FormField> & { id: string }): FormField => ({
  label: over.id,
  type: 'text',
  required: false,
  source: 'imported',
  ...over,
});

const MODEL_TEXT = 'Isolate the plant and report to the supervisor before re-entry';

/*
  A mixed part as the fill route serves it on the MARKING PASS: the written
  question q1 and the keyed radio q2 are frozen (not in `writableFieldIds`),
  q1's ✓/✗ and the assessor-name box are the marking surface, and q2's ✓/✗ is
  auto-locked but arrives PRE-MARKED in the values.
*/
const attempt = (over: Partial<AttemptFillView> = {}): AttemptFillView => ({
  id: 'att-1',
  partKey: 'part-2',
  partLabel: 'Theory questions',
  partKind: 'theory',
  attemptNumber: 1,
  outcome: null,
  submittedAt: '2026-08-20T00:00:00Z',
  templateVersionId: 'ver-1',
  party: 'assessor',
  markingGuide: [{ fieldId: 'q1', modelAnswer: MODEL_TEXT }],
  nextStep: { kind: 'done' },
  locationStream: null,
  locationStreamFieldId: null,
  streamField: null,
  minimumHours: null,
  durationUnit: null,
  durationColumnKey: null,
  taskMinimums: null,
  fields: [
    field({ id: 'q1', type: 'textarea', label: 'Q1 — written' }),
    field({ id: 'q1_mark', type: 'check_cross', label: 'Q1 ✓/✗' }),
    field({ id: 'q2', type: 'radio', options: ['A', 'B'], label: 'Q2 — keyed' }),
    field({ id: 'q2_mark', type: 'check_cross', label: 'Q2 ✓/✗' }),
    field({ id: 'assessor_name', label: 'Assessor name' }),
  ],
  writableFieldIds: ['q1_mark', 'assessor_name'],
  values: { q1: 'Stop tipping and call the spotter', q2: 'B', q2_mark: true },
  ...over,
});

afterEach(() => {
  vi.clearAllMocks();
  hookState.attempt = undefined;
});

function renderScreen(a: AttemptFillView) {
  hookState.attempt = a;
  render(<CasePartFillScreen />);
}

const input = (id: string) => screen.getByTestId(`field-${id}`) as HTMLInputElement;

describe('CasePartFillScreen — the assessor marking pass (U7)', () => {
  it('opens the marking surface: prose frozen, ticks live, pre-marks shown locked, guide visible, Save only', () => {
    renderScreen(attempt());

    // The candidate's answers are evidence now — disabled even for the marker.
    expect(input('q1').disabled).toBe(true);
    expect(input('q2').disabled).toBe(true);
    // The written question's ✓/✗ and the sign-off box are the assessor's to fill.
    expect(input('q1_mark').disabled).toBe(false);
    expect(input('assessor_name').disabled).toBe(false);
    // The keyed question arrived pre-marked at an auto-locked cell: value shown,
    // box disabled — nobody hand-ticks what the key already decided.
    expect(input('q2_mark').disabled).toBe(true);
    expect(input('q2_mark').value).toBe('true');

    // The model answer renders beside the written question, plainly labelled.
    expect(screen.getByText('Model answer — assessor guide')).toBeDefined();
    expect(screen.getByText(MODEL_TEXT)).toBeDefined();

    // Save is the assessor's only act here — the attempt is already handed in,
    // so no hand-in button; the outcome is recorded from the case screen.
    expect(screen.getByRole('button', { name: /save answers/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: /hand in for marking/i })).toBeNull();
  });

  it('never renders the candidate quiz on a marking pass, even for a one-per-screen theory part', () => {
    renderScreen(attempt({ theoryRendering: 'one_per_screen' }));
    // The quiz is the candidate's SITTING presentation (check-answer, retry,
    // hand-in). The marker gets the stacked surface with the guide instead.
    expect(screen.queryByTestId('theory-quiz')).toBeNull();
    expect(screen.getByText('Model answer — assessor guide')).toBeDefined();
  });

  it('saves ONLY writable-field entries — the served pre-marks are never echoed back', () => {
    renderScreen(attempt());

    // Tick the written question's box through the screen's own value path…
    fireEvent.click(screen.getByTestId('set-q1_mark'));
    fireEvent.click(screen.getByRole('button', { name: /save answers/i }));

    // …and the PATCH body carries the tick alone. The seeded state also holds
    // q1, q2 and the pre-marked q2_mark; q2_mark is not in the STORED map, so
    // echoing it would 403 as a foreign field and refuse the whole save.
    expect(saveMutate).toHaveBeenCalledTimes(1);
    expect(saveMutate).toHaveBeenCalledWith(
      { attemptId: 'att-1', values: { q1_mark: true } },
      expect.anything(),
    );
  });

  it('shows the marking one-liner and NEVER the candidate’s reopen banner or its live button', () => {
    /*
      The reopen banner used to render by state alone, so the marking pass got
      candidate-voiced copy ("you can still take it back") beside a LIVE
      button that un-hands-in the paper mid-marking. The banner is the
      candidate's by party; the marker gets a one-line statement of the state.
    */
    renderScreen(attempt());

    expect(screen.queryByRole('button', { name: /take it back/i })).toBeNull();
    expect(screen.queryByText(/you can still take it back/i)).toBeNull();
    expect(screen.getByText(/candidate's answers are frozen/i)).toBeDefined();
  });

  it('keeps a MARKED attempt read-only for the assessor too', () => {
    renderScreen(attempt({ outcome: 'satisfactory', markingGuide: [] }));
    expect(input('q1_mark').disabled).toBe(true);
    expect(input('assessor_name').disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /save answers/i })).toBeNull();
  });
});

describe('CasePartFillScreen — the candidate on the same handed-in attempt', () => {
  /*
    The candidate payload for the identical attempt: no `markingGuide` property
    at all (absent, not empty — pinned server-side), no pre-mark at q2_mark, and
    the server's writable list doesn't matter because handed-in is read-only for
    the candidate regardless.
  */
  const candidateAttempt = (): AttemptFillView => {
    const a = attempt({ party: 'candidate', writableFieldIds: [] });
    delete a.markingGuide;
    delete (a.values as Record<string, unknown>)['q2_mark'];
    return a;
  };

  it('stays fully read-only, with no model answer anywhere in the DOM (leak pin)', () => {
    renderScreen(candidateAttempt());

    for (const id of ['q1', 'q1_mark', 'q2', 'q2_mark', 'assessor_name']) {
      expect(input(id).disabled).toBe(true);
    }
    // The leak pin: not merely unlabelled — the model text itself must be
    // absent from the render, because it was absent from the payload.
    expect(screen.queryByText(MODEL_TEXT)).toBeNull();
    expect(screen.queryByText('Model answer — assessor guide')).toBeNull();
    // Frozen means no editing controls at all — reopen ("Take it back") is the
    // candidate's only move, exactly as before this round.
    expect(screen.queryByRole('button', { name: /save answers/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /hand in for marking/i })).toBeNull();
    expect(screen.getByRole('button', { name: /take it back/i })).toBeDefined();
  });
});
