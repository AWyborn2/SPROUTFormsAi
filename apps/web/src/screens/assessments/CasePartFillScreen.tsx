import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { SubmissionValue } from '@formai/shared';
import { Button, Icon, todayISODate, useToast } from '@formai/ui';
import { ApiError } from '../../lib/data/api-client.js';
import { dateFieldToStamp } from './signature-date-stamp.js';
import {
  useAssessmentAttempt,
  useOpenAttempt,
  useSaveAttempt,
  useSetAttemptSubmitted,
} from '../../lib/data/hooks.js';
import { partVisibility } from '../../lib/assessment-fill.js';
import { fillSpanClass, resolveFillSpan, visibleFillFields } from '../../lib/fill-layout.js';
import { FieldInput } from '../fields/FieldRenderer.js';
import { answeredPages, theoryPages } from '../../lib/theory-pages.js';

/**
 * Completing one part of an assessment case — the candidate's working surface.
 *
 * Addressed by ATTEMPT id rather than part key, because a retry is a distinct
 * attempt row: a bookmarked part-key URL would reopen whichever attempt happened
 * to be current, which is the wrong record to be typing into.
 *
 * Three things this screen deliberately does NOT do:
 *
 *  - It does not fork the field renderer. Questions render through the same
 *    `FieldInput` the public fill page uses, so a control fixed there is fixed
 *    here.
 *  - It does not filter fields for scope. The server sends exactly the part's
 *    fields, with answer keys and outcome targets already removed. Re-filtering
 *    here would imply the browser had been sent more than it should have.
 *  - It does not record an outcome. Marking is the assessor's step (and for
 *    theory the server computes it from a key nobody here can see).
 */
export function CasePartFillScreen() {
  const { id: caseId, attemptId } = useParams<{ id: string; attemptId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data: attempt, isLoading } = useAssessmentAttempt(caseId, attemptId);
  const save = useSaveAttempt(caseId ?? '');
  const setSubmitted = useSetAttemptSubmitted(caseId ?? '');
  const openAttempt = useOpenAttempt(caseId ?? '');

  const [values, setValues] = useState<Record<string, SubmissionValue>>({});
  const [dirty, setDirty] = useState(false);
  /**
   * Seeded once PER ATTEMPT. Re-seeding on every fetch would discard whatever
   * the candidate had typed since — a background refetch mid-answer must not
   * wipe the page. Navigating to a different attempt (a retry) re-arms it, or
   * the new attempt would render the old one's answers.
   */
  const seeded = useRef(false);

  useEffect(() => {
    seeded.current = false;
  }, [attemptId]);

  useEffect(() => {
    if (!attempt || seeded.current) return;
    setValues(attempt.values ?? {});
    seeded.current = true;
  }, [attempt]);

  /*
    A MARKED ATTEMPT SHOWS THE SERVER'S COPY. Hand-in can mark on the spot now,
    and marking writes the per-question ✓/✗ and the further-action note into
    the stored values — which the seeded-once local state predates. The screen
    is read-only here, so adopting the refetch loses nobody's typing.
  */
  useEffect(() => {
    if (attempt && attempt.outcome !== null) setValues(attempt.values ?? {});
  }, [attempt]);

  /**
   * How this part's fields are gated by the case's location stream: Part 1
   * shows the General set plus exactly one location set. See `partVisibility`
   * for why the answer and its source field are decided together — supplying
   * one without the other inverts the result.
   */
  const { answers, sources } = useMemo(
    () =>
      partVisibility(values, {
        locationStream: attempt?.locationStream ?? null,
        locationStreamFieldId: attempt?.locationStreamFieldId ?? null,
        streamField: attempt?.streamField ?? null,
      }),
    [values, attempt?.locationStream, attempt?.locationStreamFieldId, attempt?.streamField],
  );

  /**
   * The fields this candidate actually sees, after location-stream gating.
   *
   * A hook, and ABOVE the early returns below, because every hook in this
   * component must run on every render — the first render of a fresh
   * navigation always takes the `isLoading` return, so anything below it would
   * be a hook the first render never ran. Null-safe on `attempt` for the same
   * reason: on that first render there is no attempt yet.
   */
  const rendered = useMemo(
    () => (attempt ? visibleFillFields(attempt.fields, answers, sources) : []),
    [attempt, answers, sources],
  );

  /*
    ONE QUESTION PER SCREEN, WHEN THE TOOL SAYS SO (U21).

    Presentation only: every field still renders through the same `FieldInput`,
    writes the same value to the same id, and is gated by the same
    `writableFieldIds` the server decided. The paging is a WINDOW over
    `rendered`, not a different list, so nothing about marking, storage or the
    evidence export can tell which presentation a candidate used.

    The choice comes off the tool's manifest, made once by the author in the
    builder. Absent means stacked, which is what every theory part rendered as
    before this existed.
  */
  const paged = attempt?.theoryRendering === 'one_per_screen' && attempt?.partKind === 'theory';
  const pages = useMemo(() => (paged ? theoryPages(rendered) : []), [paged, rendered]);
  const [pageIndex, setPageIndex] = useState(0);

  if (isLoading) {
    return <div className="p-[30px_28px] text-sm text-text-tertiary">Loading…</div>;
  }

  // The route answers 404 for an attempt on someone else's case, so "missing"
  // and "not yours" are one message — as they should be.
  if (!attempt) {
    return (
      <div className="fai-rise mx-auto max-w-[820px] p-[30px_28px_60px]">
        <div className="flex flex-col items-center gap-3 py-20 text-center">
          <Icon name="file-question" size={30} className="text-text-tertiary" />
          <h1 className="font-heading text-lg font-semibold">This part isn't available</h1>
          <p className="text-[13px] text-text-secondary">
            It may have been withdrawn, or it belongs to someone else's assessment.
          </p>
          <Button variant="outline" onClick={() => navigate('/app/assessments')}>
            Back to my assessments
          </Button>
        </div>
      </div>
    );
  }

  // A marked attempt is a historical record. Nothing here may edit it — a
  // resolved attempt is never mutated, which is what keeps the audit trail
  // meaningful. A handed-in one is frozen too, but reversibly: the candidate can
  // take it back until it is marked.
  const marked = attempt.outcome !== null;
  const handedIn = attempt.submittedAt !== null;
  const readOnly = marked || handedIn;

  /*
    Clamped on READ rather than reset on change: a question answered on the last
    page can make an earlier one visible or hidden, and snapping the candidate
    back to page one every time the list resized would lose their place.
  */
  const page = pages[Math.min(pageIndex, Math.max(0, pages.length - 1))];
  const answered = paged ? answeredPages(pages, answers) : 0;
  const shown = page ? page.fields : rendered;
  /*
    Which fields this caller may change, as the server decided. A tool with no
    workflow authored sends every field of the part, so nothing renders
    read-only until somebody configures it.
  */
  const writable = new Set(attempt.writableFieldIds ?? []);
  // Captured so the closure below keeps the non-null narrowing from the early
  // return above — TS widens `attempt` back to possibly-undefined inside a
  // nested function.
  const partFields = attempt.fields;

  function setValue(fieldId: string, v: SubmissionValue) {
    setValues((prev) => {
      const next = { ...prev, [fieldId]: v };
      // Drawing a sign-off signature stamps the date it was signed on — but only
      // a date this party may fill, so a companion the workflow made read-only is
      // left to whoever owns it.
      const dateId = dateFieldToStamp(partFields, prev, fieldId, v);
      if (dateId && writable.has(dateId)) next[dateId] = todayISODate();
      return next;
    });
    setDirty(true);
  }

  function onSave() {
    if (!attemptId || readOnly) return;
    save.mutate(
      { attemptId, values },
      {
        onSuccess: () => {
          setDirty(false);
          toast({ variant: 'success', message: 'Answers saved.' });
        },
        onError: () => toast({ variant: 'danger', message: "Couldn't save — try again." }),
      },
    );
  }

  return (
    <div className="fai-rise mx-auto max-w-[820px] p-[30px_28px_60px]">
      <button
        type="button"
        onClick={() => navigate(`/app/assessments/${caseId}`)}
        className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-text-secondary hover:text-text-primary"
      >
        <Icon name="chevron-left" size={15} />
        Back to case
      </button>

      <header className="mb-5">
        <h1 className="font-heading text-xl font-semibold">{attempt.partLabel}</h1>
        <p className="mt-1 text-[13px] text-text-secondary">
          Attempt {attempt.attemptNumber}
          {attempt.minimumHours !== null && <> · {attempt.minimumHours} hours minimum</>}
          {attempt.locationStream && <> · {attempt.locationStream}</>}
        </p>
      </header>

      {marked && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
          <p className="text-[13px] text-text-secondary">
            {attempt.outcome === 'satisfactory'
              ? 'Marked satisfactory — this attempt is now a locked record.'
              : attempt.outcome === 'not_satisfactory'
                ? 'Marked not satisfactory. Your correct answers carry over to a new attempt — go back over the ones that were missed.'
                : 'This attempt has been marked, so it can no longer be changed.'}
          </p>
          {attempt.outcome === 'not_satisfactory' && (
            <Button
              leadingIcon="rotate-ccw"
              disabled={openAttempt.isPending}
              onClick={() =>
                openAttempt.mutate(attempt.partKey, {
                  onSuccess: (r) => navigate(`/app/assessments/${caseId}/attempts/${r.id}`),
                  onError: () =>
                    toast({
                      variant: 'warning',
                      message: "Couldn't open another attempt — your assessor may need to.",
                    }),
                })
              }
            >
              {openAttempt.isPending ? 'Opening…' : 'Try again'}
            </Button>
          )}
        </div>
      )}

      {handedIn && !marked && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
          <p className="text-[13px] text-text-secondary">
            Handed in — your assessor will mark this. You can still take it back until they do.
          </p>
          <Button
            variant="outline"
            leadingIcon="undo-2"
            disabled={setSubmitted.isPending}
            onClick={() => {
              if (!attemptId) return;
              setSubmitted.mutate(
                { attemptId, submitted: false },
                {
                  onSuccess: () => toast({ variant: 'info', message: 'Reopened — you can keep editing.' }),
                  onError: () =>
                    toast({ variant: 'warning', message: "Couldn't reopen — it may already be marked." }),
                },
              );
            }}
          >
            Take it back
          </Button>
        </div>
      )}

      {paged && pages.length > 1 && (
        <div className="flex items-center gap-3">
          <span
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-sunken"
            role="progressbar"
            aria-valuenow={answered}
            aria-valuemin={0}
            aria-valuemax={pages.length}
            aria-label="Questions answered"
          >
            <span
              className="block h-full rounded-full bg-accent"
              style={{ width: `${Math.round((answered / pages.length) * 100)}%` }}
            />
          </span>
          <span className="flex-none text-[11.5px] text-text-tertiary">
            {answered} of {pages.length} answered
          </span>
        </div>
      )}

      <div className="grid grid-cols-12 gap-[16px]">
        {shown.map((f) => (
          <div key={f.id} className={fillSpanClass(resolveFillSpan(f, false))}>
            <FieldInput
              field={f}
              value={values[f.id] ?? null}
              /*
                Two reasons a field is read-only, and neither is computed here.
                The attempt as a whole may be frozen — handed in, or marked — or
                the workflow may say this party does not fill this field, which
                is what `writableFieldIds` carries. The screen renders what the
                server decided rather than working the scope out a second time.
              */
              disabled={readOnly || !writable.has(f.id)}
              onChange={(v) => setValue(f.id, v)}
            />
          </div>
        ))}
        {shown.length === 0 && (
          <div className="col-span-12 py-6 text-center text-[13px] text-text-tertiary">
            There's nothing to complete in this part.
          </div>
        )}
      </div>

      {paged && pages.length > 1 && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={pageIndex === 0}
            onClick={() => setPageIndex((i) => Math.max(0, i - 1))}
            className="inline-flex h-[32px] items-center rounded-lg border border-border px-3 text-[12px] font-semibold text-text-secondary disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-[11.5px] text-text-tertiary">
            Question {(page?.index ?? 0) + 1} of {pages.length}
          </span>
          <button
            type="button"
            disabled={pageIndex >= pages.length - 1}
            onClick={() => setPageIndex((i) => Math.min(pages.length - 1, i + 1))}
            className="inline-flex h-[32px] items-center rounded-lg border border-border px-3 text-[12px] font-semibold text-text-secondary disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}

      {!readOnly && (
        <div className="mt-6 flex items-center justify-end gap-3">
          {/* Saving is explicit and partial by design: a candidate works through
              a logbook over weeks, so leaving mid-part must be normal and safe
              rather than something that loses the page. */}
          <span className="text-[12.5px] text-text-tertiary">
            {dirty ? 'Unsaved changes' : 'All changes saved'}
          </span>
          <Button
            variant="outline"
            leadingIcon="save"
            onClick={onSave}
            disabled={save.isPending || !dirty}
          >
            {save.isPending ? 'Saving…' : 'Save answers'}
          </Button>
          {/* Handing in is the signal an assessor waits on. Saving first means a
              candidate cannot submit a version of their answers that differs
              from the one still sitting unsaved on screen. */}
          {/* A DECLARATION is not marked — signing it IS the act, so the button
              says what actually happens and nobody is told to wait for a
              marking that will never occur. */}
          <Button
            leadingIcon="send"
            disabled={save.isPending || setSubmitted.isPending}
            onClick={() => {
              if (!attemptId) return;
              const handOff = () =>
                setSubmitted.mutate(
                  { attemptId, submitted: true },
                  {
                    // A fully-keyed part marks itself at hand-in, and the
                    // response says how it went — so say it here, not after a
                    // trip back to the case screen.
                    onSuccess: (r) => {
                      setDirty(false);
                      // Reopen shares this mutation and never marks, so the
                      // union has to be narrowed before the outcome is read.
                      const outcome = 'outcome' in r ? r.outcome : undefined;
                      if (outcome === 'satisfactory') {
                        toast({
                          variant: 'success',
                          message:
                            attempt?.partKind === 'declaration'
                              ? 'Declaration signed — you can start the assessment.'
                              : 'Marked satisfactory — this part is done.',
                        });
                      } else if (outcome === 'not_satisfactory') {
                        toast({
                          variant: 'warning',
                          message: 'Marked — some answers need another look. You can try again.',
                        });
                      } else {
                        toast({ variant: 'success', message: 'Handed in for marking.' });
                      }
                    },
                    onError: (err) => {
                      // The one refusal with its own next step: the declaration
                      // names the boxes still empty, so say them.
                      const body =
                        err instanceof ApiError && err.body && typeof err.body === 'object'
                          ? (err.body as { error?: string; detail?: string })
                          : null;
                      toast({
                        variant: 'danger',
                        message:
                          body?.error === 'declaration_incomplete' && body.detail
                            ? body.detail
                            : "Couldn't hand in — try again.",
                      });
                    },
                  },
                );
              if (!dirty) return handOff();
              save.mutate(
                { attemptId, values },
                {
                  onSuccess: handOff,
                  onError: () =>
                    toast({ variant: 'danger', message: "Couldn't save your answers — nothing was handed in." }),
                },
              );
            }}
          >
            {setSubmitted.isPending
              ? attempt?.partKind === 'declaration'
                ? 'Signing…'
                : 'Handing in…'
              : attempt?.partKind === 'declaration'
                ? 'Sign and continue'
                : 'Hand in for marking'}
          </Button>
        </div>
      )}
    </div>
  );
}
