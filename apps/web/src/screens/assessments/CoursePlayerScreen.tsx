import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Icon, useToast } from '@formai/ui';
import { useCaseCourse, useSaveCourseProgress } from '../../lib/data/hooks.js';

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

  const course = data?.course ?? null;

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

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      // Only the embedded package's frame is listened to — any other window
      // posting a matching shape is ignored.
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const d = e.data as { type?: unknown; index?: unknown };
      if (!d || d.type !== 'course-slide' || typeof d.index !== 'number') return;
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
          className="min-h-0 w-full flex-1 rounded-md border border-border"
          style={{ background: '#1D1D1B' }}
        />
      )}
    </div>
  );
}
