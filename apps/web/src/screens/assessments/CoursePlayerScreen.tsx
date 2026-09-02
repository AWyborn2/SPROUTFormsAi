import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { SubmissionValue } from '@formai/shared';
import { Button, Icon, useToast } from '@formai/ui';
import {
  useAssessmentCase,
  useCaseCourse,
  useOpenAttempt,
  useSaveCourseProgress,
} from '../../lib/data/hooks.js';
import { assessmentsApi } from '../../lib/data/assessments.js';
import { ApiError } from '../../lib/data/api-client.js';

/**
 * What to tell the reader when a graded answer could not be recorded — the
 * server's refusal named plainly, or the network. The deck shows this beside
 * Submit immediately instead of waiting out its own timeout.
 */
function describeRelayFailure(err: unknown): [string, string] {
  if (err instanceof ApiError) {
    const code = (err.body as { error?: unknown } | null)?.error;
    switch (code) {
      case 'field_not_in_part':
        return ['field_not_in_part', 'This question is not in the open theory part — go back to the assessment and check which part is open.'];
      case 'part_locked':
        return ['part_locked', 'Complete the earlier part of the assessment first — then your answers here are recorded.'];
      case 'attempt_submitted':
      case 'attempt_resolved':
      case 'part_already_satisfied':
        return ['attempt_closed', 'The theory has already been handed in — this answer is not recorded.'];
      case 'course_not_complete':
        return ['course_not_complete', 'Finish reading the course before the theory opens.'];
      default:
        return ['request_failed', `The server refused this answer (${err.status}) — press Submit to try again.`];
    }
  }
  return ['network', 'Could not reach the server — press Submit to try again.'];
}

/**
 * The course player: the case's course package running in a sandboxed iframe,
 * with reading progress recorded against the case as it happens.
 *
 * THE PACKAGE IS UNTRUSTED CONTENT. It runs with `sandbox="allow-scripts"`
 * and no `allow-same-origin`, so it executes from an opaque origin: no
 * cookies, no reach into this app's DOM or storage. Everything it needs
 * arrives through the capability-token URLs the server minted, and the only
 * thing it can say to us is a postMessage.
 *
 * A deck package reports `{type: 'course-slide', index}` as the reader pages
 * through; those indexes batch up here and PATCH to the case every second or
 * so. Completion is the SERVER's call — this screen just renders whatever
 * count and completed-at come back. Packages with no slide stream (SCORM,
 * plain HTML) get an explicit "Mark as read through" control instead.
 */
export function CoursePlayerScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data, isLoading, error } = useCaseCourse(id ?? '');
  const save = useSaveCourseProgress(id ?? '');
  // The case's parts, so the deck's Start Assessment can drop the reader
  // straight into the first part's questions rather than back at the case
  // overview.
  const { data: caseDetail } = useAssessmentCase(id);
  const openAttempt = useOpenAttempt(id ?? '');

  const course = data?.course ?? null;

  /**
   * Reached from the deck's "Start Assessment" button. Open an attempt on the
   * first part the reader can start and go straight to its questions; if
   * nothing is open (all parts done, or the workflow hands the first step to
   * someone else) or the open fails, fall back to the case overview so they're
   * never stranded. Guarded so a double-tap can't open two attempts.
   */
  const startingRef = useRef(false);
  const startAssessment = useCallback(() => {
    if (!id || startingRef.current) return;
    const target = (caseDetail?.parts ?? []).find((p) => p.state === 'open');
    if (!target) {
      navigate(`/app/assessments/${id}`);
      return;
    }
    startingRef.current = true;
    openAttempt.mutate(target.key, {
      onSuccess: (res) => navigate(`/app/assessments/${id}/attempts/${res.id}`),
      onError: () => {
        startingRef.current = false;
        navigate(`/app/assessments/${id}`);
      },
    });
  }, [id, caseDetail, navigate, openAttempt]);
  // Held in a ref so the message listener stays stable (re-subscribing it could
  // drop or double-count slide reports).
  const startRef = useRef(startAssessment);
  useEffect(() => {
    startRef.current = startAssessment;
  }, [startAssessment]);

  // Live reading state — seeded from the fetched record once, then driven by
  // PATCH responses. Kept outside react-query so a progress tick never
  // refetches (and so never reloads) the iframe.
  const [viewedCount, setViewedCount] = useState<number | null>(null);
  const [completedAt, setCompletedAt] = useState<string | null | undefined>(undefined);

  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const seenRef = useRef<Set<number>>(new Set());
  const pendingRef = useRef<number[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A closed case answers 409 to every progress report; one such answer stops
  // the reporting rather than toasting on every slide turn.
  const deadRef = useRef(false);

  const flush = useCallback(() => {
    timerRef.current = null;
    if (deadRef.current || pendingRef.current.length === 0) return;
    const batch = pendingRef.current.splice(0, pendingRef.current.length);
    save.mutate(
      { visitedSlides: batch },
      {
        onSuccess: (result) => {
          setViewedCount(result.viewedCount);
          setCompletedAt(result.completedAt);
        },
        onError: (err) => {
          const status = (err as { status?: number }).status;
          if (status === 409 || status === 404) {
            deadRef.current = true;
            return;
          }
          // Transient failure — put the batch back so the next turn retries it.
          pendingRef.current.push(...batch);
        },
      },
    );
  }, [save]);

  const scheduleFlush = useCallback(() => {
    if (timerRef.current !== null) return;
    timerRef.current = setTimeout(flush, 900);
  }, [flush]);

  // ── In-deck graded answers ────────────────────────────────────────────────
  // The sandboxed deck can't reach the API, so it posts each graded answer and
  // we relay it to the server, then post the verdict back into the frame. The
  // theory attempt is opened LAZILY on the first answer — the attempt-open gate
  // is relaxed for an in-deck assessment (course.assessmentInDeck) — and reused
  // after. Held as a promise so several quick answers await one open rather than
  // racing to open several attempts.
  /*
    THE THEORY PART, NOT "THE FIRST OPEN PART". The deck's graded questions
    belong to the theory. On a tool that opens with a candidate declaration the
    first open part is that declaration, and an answer posted against ITS
    attempt is refused by the server — the field is outside that part. That
    refusal used to be swallowed here, which left the reader on the deck's own
    "Checking…" timeout with nothing to go on. So the theory is targeted by
    kind; a theory that is locked (the declaration not yet signed), a refusal,
    or a network failure is posted straight back as a `course-answer-error`,
    which the deck shows at once and keeps Submit live for. Older case DTOs without a
    part kind fall back to the first open part, as before.
  */
  const theoryPart = useMemo(() => {
    const parts = caseDetail?.parts ?? [];
    return (
      parts.find((p) => p.kind === 'theory' && p.state === 'open') ??
      parts.find((p) => p.kind === 'theory') ??
      parts.find((p) => p.state === 'open') ??
      null
    );
  }, [caseDetail]);
  const blockingPart = useMemo(
    () => (caseDetail?.parts ?? []).find((p) => p.state === 'open' && p.key !== theoryPart?.key) ?? null,
    [caseDetail, theoryPart],
  );
  const attemptPromiseRef = useRef<Promise<string> | null>(null);
  const relayAnswer = useCallback(
    async (fieldId: string, value: SubmissionValue) => {
      const win = frameRef.current?.contentWindow;
      if (!id || !win) return;
      // A distinct message type, not a `course-answer-result` with an error on it:
      // a deck built before errors existed treats any result as a verdict and
      // would show "Incorrect" and complete the slide for an answer that was
      // never recorded. An unknown type it simply ignores and falls back to its
      // own timeout — degraded, but honest.
      const fail = (error: string, message: string) =>
        win.postMessage({ type: 'course-answer-error', fieldId, error, message }, '*');
      const target = theoryPart;
      if (!target) {
        fail('no_theory_part', 'This assessment has no theory part to record answers against — go back to the assessment.');
        return;
      }
      if (target.state === 'locked') {
        fail(
          'part_locked',
          blockingPart
            ? `Complete "${blockingPart.label}" in the assessment first — after that your answers here are recorded.`
            : 'The theory is not open yet — go back to the assessment and open it first.',
        );
        return;
      }
      if (target.state !== 'open') {
        fail('part_closed', 'The theory has already been marked — this answer is not recorded.');
        return;
      }
      if (!attemptPromiseRef.current) {
        attemptPromiseRef.current = (async () => {
          try {
            return (await assessmentsApi.openAttempt(id, target.key)).id;
          } catch (err) {
            attemptPromiseRef.current = null; // let a later answer retry the open
            throw err;
          }
        })();
      }
      let attemptId: string;
      try {
        attemptId = await attemptPromiseRef.current;
      } catch (err) {
        fail(...describeRelayFailure(err));
        return;
      }
      try {
        const res = await assessmentsApi.answerQuestion(id, attemptId, fieldId, value);
        win.postMessage(
          { type: 'course-answer-result', fieldId, correct: res.correct, hint: res.hint ?? undefined },
          '*',
        );
      } catch (err) {
        fail(...describeRelayFailure(err));
      }
    },
    [id, theoryPart, blockingPart],
  );
  const relayRef = useRef(relayAnswer);
  useEffect(() => {
    relayRef.current = relayAnswer;
  }, [relayAnswer]);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      // Only the embedded package's frame is listened to — any other window
      // posting a matching shape is ignored.
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const d = e.data as { type?: unknown; index?: unknown };
      if (!d) return;
      // The deck's own "Start Assessment" button at the end of the reading:
      // the package can't navigate the app (it's sandboxed with no
      // allow-top-navigation), so it asks us to. Send the reader back to the
      // case, where the now-satisfied gate lets them open the first part.
      if (d.type === 'course-start-assessment') {
        startRef.current();
        return;
      }
      // A graded in-deck question was submitted: relay it to the server (the
      // sandboxed deck has no network of its own) and post the verdict back.
      if (d.type === 'course-answer' && typeof (d as { fieldId?: unknown }).fieldId === 'string') {
        relayRef.current(
          (d as { fieldId: string }).fieldId,
          (d as { value?: SubmissionValue }).value ?? null,
        );
        return;
      }
      if (d.type !== 'course-slide' || typeof d.index !== 'number') return;
      if (seenRef.current.has(d.index)) return;
      seenRef.current.add(d.index);
      pendingRef.current.push(d.index);
      scheduleFlush();
    }
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [scheduleFlush]);

  if (isLoading) {
    return (
      <div className="p-[30px_28px]">
        <p className="text-[13.5px] text-text-tertiary">Loading course…</p>
      </div>
    );
  }
  if (error || !data || !course) {
    return (
      <div className="p-[30px_28px]">
        <p role="alert" className="text-[13.5px] text-danger">
          {course === null && !error
            ? 'This assessment has no course material.'
            : 'The course could not be loaded.'}
        </p>
        <button
          onClick={() => navigate(`/app/assessments/${id}`)}
          className="mt-2 text-[13.5px] text-text-tertiary"
        >
          Back to the assessment
        </button>
      </div>
    );
  }

  const total = course.totalSlides;
  const viewed = viewedCount ?? course.viewedCount;
  const done = (completedAt === undefined ? course.completedAt : completedAt) !== null;
  const isDeck = course.kind === 'deck';

  return (
    <div className="fai-rise flex h-[calc(100vh-56px)] flex-col p-[18px_28px_20px]">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate(`/app/assessments/${id}`)}
            className="inline-flex items-center gap-1 text-[13px] text-text-tertiary hover:text-text-secondary"
          >
            <Icon name="arrow-left" size={14} />
            Assessment
          </button>
          <h1 className="font-heading text-[17px] font-bold">
            {course.title ?? 'Course material'}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          {done ? (
            <span
              className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium"
              style={{ background: 'var(--success-soft)', color: 'var(--success-text)' }}
            >
              <Icon name="circle-check" size={13} />
              Read through — the assessment can start
            </span>
          ) : isDeck && total !== null ? (
            <div className="flex items-center gap-2">
              <div className="h-[6px] w-[160px] overflow-hidden rounded-full bg-surface-sunken">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${total > 0 ? Math.round((Math.min(viewed, total) / total) * 100) : 0}%`,
                    background: 'var(--accent)',
                  }}
                />
              </div>
              <span className="text-[12px] tabular-nums text-text-tertiary">
                {Math.min(viewed, total)} of {total} slides
              </span>
            </div>
          ) : (
            <Button
              variant="outline"
              leadingIcon="circle-check"
              disabled={save.isPending}
              onClick={() =>
                save.mutate(
                  { confirmRead: true },
                  {
                    onSuccess: (result) => setCompletedAt(result.completedAt),
                    onError: () =>
                      toast({
                        variant: 'warning',
                        message: 'Couldn’t record the read-through — try again.',
                      }),
                  },
                )
              }
            >
              Mark as read through
            </Button>
          )}
        </div>
      </div>

      {course.assessmentInDeck && theoryPart && theoryPart.state === 'locked' && (
        <div
          role="status"
          className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border p-[10px_14px]"
          style={{ background: 'var(--warning-soft)', borderColor: 'var(--border-warning)' }}
        >
          <p className="text-[13px]" style={{ color: 'var(--warning-text)' }}>
            {blockingPart ? (
              <>
                Your theory answers can’t be recorded yet — complete <strong>{blockingPart.label}</strong> in the
                assessment first.
              </>
            ) : (
              'Your theory answers can’t be recorded yet — the theory part is not open.'
            )}
          </p>
          <Button variant="outline" onClick={() => navigate(`/app/assessments/${id}`)}>
            Open the assessment
          </Button>
        </div>
      )}
      {course.missing || !course.launchUrl ? (
        <div
          className="rounded-md border p-[14px_16px]"
          style={{ background: 'var(--warning-soft)', borderColor: 'var(--border-warning)' }}
        >
          <p className="text-[13px]" style={{ color: 'var(--warning-text)' }}>
            The course package this assessment links to is no longer available.
          </p>
        </div>
      ) : (
        <iframe
          ref={frameRef}
          title={course.title ?? 'Course material'}
          src={`/api${course.launchUrl}`}
          // Scripts yes — the deck is interactive — but an opaque origin, no
          // forms, no popups, no reach back into the app. See the header note.
          sandbox="allow-scripts"
          // Seed the package with what the case already recorded, so a
          // reopened deck resumes at its frontier instead of re-locking from
          // slide zero. '*' is right here: the sandboxed frame's origin is
          // opaque ("null"), so no origin string could match it, and the
          // payload is the reader's own progress — nothing another listener
          // could abuse.
          onLoad={() => {
            const win = frameRef.current?.contentWindow;
            if (!win || course.visitedSlides.length === 0) return;
            for (const n of course.visitedSlides) seenRef.current.add(n);
            win.postMessage({ type: 'course-progress-seed', visited: course.visitedSlides }, '*');
          }}
          className="min-h-0 w-full flex-1 rounded-md border border-border"
          style={{ background: '#1D1D1B' }}
        />
      )}
    </div>
  );
}
