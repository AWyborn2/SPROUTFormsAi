// @vitest-environment jsdom
/**
 * The course player: an untrusted package in a sandboxed iframe, reporting
 * slide changes by postMessage; this screen batches them into progress
 * PATCHes and renders whatever completion the server derives.
 *
 * The messages are faked by dispatching on `window` with `source` pointed at
 * the iframe's contentWindow — the same shape the packaged deck's bridge
 * posts — because jsdom does not run the frame's scripts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { CaseCourseView } from '../../lib/data/assessments.js';

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'case-1' }),
  useNavigate: () => navigate,
}));

const courseResult: {
  data: { course: CaseCourseView | null } | undefined;
  isLoading: boolean;
  error: unknown;
} = { data: undefined, isLoading: false, error: null };

const saveMutate = vi.fn();
const openMutate = vi.fn((_partKey: string, opts?: { onSuccess?: (r: { id: string }) => void }) =>
  opts?.onSuccess?.({ id: 'att-9' }),
);
const caseResult: { data: { parts: { key: string; state: string }[] } | undefined } = {
  data: { parts: [{ key: 'theory', state: 'open' }] },
};
vi.mock('../../lib/data/hooks.js', () => ({
  useCaseCourse: () => courseResult,
  useSaveCourseProgress: () => ({ mutate: saveMutate, isPending: false }),
  useAssessmentCase: () => caseResult,
  useOpenAttempt: () => ({ mutate: openMutate, isPending: false }),
}));

const toast = vi.fn();
vi.mock('@formai/ui', async () => {
  const actual = await vi.importActual<typeof import('@formai/ui')>('@formai/ui');
  return { ...actual, useToast: () => ({ toast }) };
});

const { CoursePlayerScreen } = await import('./CoursePlayerScreen.js');

function deckCourse(over: Partial<CaseCourseView> = {}): CaseCourseView {
  return {
    courseId: 'course-1',
    required: true,
    missing: false,
    title: 'Mine Site SME Operating Manual',
    kind: 'deck',
    totalSlides: 3,
    viewedCount: 0,
    completedAt: null,
    launchUrl: '/courses/content/tok/index.html',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    visitedSlides: [],
    ...over,
  };
}

/** A slide-change as the packaged bridge posts it, sourced from the iframe. */
function postSlide(index: number) {
  const frame = document.querySelector('iframe')!;
  const event = new MessageEvent('message', {
    data: { type: 'course-slide', index, total: 3, skipped: [] },
  });
  Object.defineProperty(event, 'source', { value: frame.contentWindow });
  act(() => {
    window.dispatchEvent(event);
  });
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  courseResult.data = undefined;
  courseResult.isLoading = false;
  courseResult.error = null;
  caseResult.data = { parts: [{ key: 'theory', state: 'open' }] };
});

describe('CoursePlayerScreen', () => {
  it('loads the package sandboxed and batches slide reports into one PATCH', () => {
    vi.useFakeTimers();
    courseResult.data = { course: deckCourse() };
    render(<CoursePlayerScreen />);

    const frame = document.querySelector('iframe')!;
    expect(frame.getAttribute('src')).toBe('/api/courses/content/tok/index.html');
    // Scripts run; nothing else — no same-origin reach back into the app.
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');

    postSlide(0);
    postSlide(1);
    postSlide(0); // a revisit adds nothing
    expect(saveMutate).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(saveMutate).toHaveBeenCalledTimes(1);
    expect(saveMutate.mock.calls[0]![0]).toEqual({ visitedSlides: [0, 1] });
  });

  it('seeds a reopened package with the recorded slides and never re-reports them', () => {
    vi.useFakeTimers();
    courseResult.data = { course: deckCourse({ viewedCount: 2, visitedSlides: [0, 1] }) };
    render(<CoursePlayerScreen />);

    const frame = document.querySelector('iframe')!;
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    fireEvent.load(frame);
    expect(post).toHaveBeenCalledWith({ type: 'course-progress-seed', visited: [0, 1] }, '*');

    // The deck replays a seeded index as the reader resumes — already stored
    // server-side, so it must not turn into a PATCH.
    postSlide(1);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(saveMutate).not.toHaveBeenCalled();
  });

  it('the deck’s Start Assessment message opens the first part and jumps to its questions', () => {
    caseResult.data = { parts: [{ key: 'theory', state: 'open' }] };
    courseResult.data = { course: deckCourse({ viewedCount: 3, completedAt: '2026-08-24T03:00:00Z' }) };
    render(<CoursePlayerScreen />);
    const frame = document.querySelector('iframe')!;
    const event = new MessageEvent('message', { data: { type: 'course-start-assessment' } });
    Object.defineProperty(event, 'source', { value: frame.contentWindow });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(openMutate).toHaveBeenCalledWith('theory', expect.anything());
    expect(navigate).toHaveBeenCalledWith('/app/assessments/case-1/attempts/att-9');
  });

  it('Start Assessment falls back to the case overview when no part is open', () => {
    caseResult.data = { parts: [{ key: 'theory', state: 'satisfactory' }] };
    courseResult.data = { course: deckCourse({ viewedCount: 3, completedAt: '2026-08-24T03:00:00Z' }) };
    render(<CoursePlayerScreen />);
    const frame = document.querySelector('iframe')!;
    const event = new MessageEvent('message', { data: { type: 'course-start-assessment' } });
    Object.defineProperty(event, 'source', { value: frame.contentWindow });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(openMutate).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/app/assessments/case-1');
  });

  it('a message from any other window is ignored', () => {
    vi.useFakeTimers();
    courseResult.data = { course: deckCourse() };
    render(<CoursePlayerScreen />);

    const event = new MessageEvent('message', {
      data: { type: 'course-slide', index: 2 },
    });
    Object.defineProperty(event, 'source', { value: window });
    act(() => {
      window.dispatchEvent(event);
      vi.advanceTimersByTime(1000);
    });
    expect(saveMutate).not.toHaveBeenCalled();
  });

  it('renders the server-derived completion, not its own arithmetic', () => {
    vi.useFakeTimers();
    courseResult.data = { course: deckCourse({ viewedCount: 2 }) };
    render(<CoursePlayerScreen />);
    expect(screen.getByText('2 of 3 slides')).toBeDefined();

    postSlide(2);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    const onSuccess = (saveMutate.mock.calls[0]![1] as {
      onSuccess: (r: { viewedCount: number; totalSlides: number; completedAt: string }) => void;
    }).onSuccess;
    act(() => {
      onSuccess({ viewedCount: 3, totalSlides: 3, completedAt: '2026-08-24T03:00:00Z' });
    });
    expect(screen.getByText(/Read through — the assessment can start/)).toBeDefined();
  });

  it('a package with no slide stream completes by explicit confirmation', () => {
    courseResult.data = {
      course: deckCourse({ kind: 'scorm', totalSlides: null, launchUrl: '/courses/content/tok/sco.html' }),
    };
    render(<CoursePlayerScreen />);

    fireEvent.click(screen.getByText('Mark as read through'));
    expect(saveMutate.mock.calls[0]![0]).toEqual({ confirmRead: true });
  });

  it('a missing package explains itself instead of an empty frame', () => {
    courseResult.data = { course: deckCourse({ missing: true, launchUrl: null, title: null }) };
    render(<CoursePlayerScreen />);
    expect(screen.getByText(/no longer available/)).toBeDefined();
    expect(document.querySelector('iframe')).toBeNull();
  });
});
