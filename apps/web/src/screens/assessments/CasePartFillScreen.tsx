import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { CaseNextStep, SubmissionValue } from '@formai/shared';
import { durationUnitLong, logbookDurationRows } from '@formai/shared';
import { Button, Icon, todayISODate, useToast } from '@formai/ui';
import { ApiError } from '../../lib/data/api-client.js';
import { applyAssessorSignoff, dateFieldToStamp } from './signature-date-stamp.js';
import { LogbookProgress } from './LogbookProgress.js';
import {
  useAssessmentAttempt,
  useCheckQuestion,
  useOpenAttempt,
  useSaveAttempt,
  useSession,
  useSetAttemptSubmitted,
} from '../../lib/data/hooks.js';
import { partVisibility } from '../../lib/assessment-fill.js';
import { fillSpanClass, resolveFillSpan, visibleFillFields } from '../../lib/fill-layout.js';
import { FieldInput } from '../fields/FieldRenderer.js';
import { answeredPages, quizFields, theoryPages } from '../../lib/theory-pages.js';
import { TheoryQuiz } from './TheoryQuiz.js';

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
  const checkQuestion = useCheckQuestion(caseId ?? '', attemptId);
  // The acting user, to prefill their own name into an assessor sign-off block.
  const { data: session } = useSession();

  const [values, setValues] = useState<Record<string, SubmissionValue>>({});
  const [dirty, setDirty] = useState(false);
  /**
   * Seeded once PER ATTEMPT. Re-seeding on every fetch would discard whatever
   * the candidate had typed since — a background refetch mid-answer must not
   * wipe the page. Navigating to a different attempt (a retry) re-arms it, or
   * the new attempt would render the old one's answers.
   */
  const seeded = useRef(false);
  // The assessor sign-off prefill below runs once per attempt too, but AFTER the
  // seed, on its own latch — it depends on the session, which can resolve later.
  const signoffFilled = useRef(false);

  useEffect(() => {
    seeded.current = false;
    signoffFilled.current = false;
  }, [attemptId]);

  useEffect(() => {
    if (!attempt || seeded.current) return;
    setValues(attempt.values ?? {});
    seeded.current = true;
  }, [attempt]);

  /*
    ASSESSOR SIGN-OFF PREFILL. When the assessor opens a part they are marking,
    fill their own name (from the account) and today's date into that part's
    assessor sign-off block — the same sign-once convenience the certification
    dialog gives, brought to the marking form so neither is transcribed by hand.
    This covers the case a signature draw cannot: a practical whose outcome the
    checklist auto-marks (B) is completed by ticking and handing in, with no
    signature stroke for the companion-date stamp to fire on.

    Only where the box is the caller's to fill (`writable`) and still blank, so
    the candidate's own record is untouched and an edited value is never
    re-clobbered. Once per attempt, after the seed, waiting for the session so
    the name lands in the same pass as the date.
  */
  useEffect(() => {
    if (!attempt || !seeded.current || signoffFilled.current) return;
    // Only an OPEN attempt: a marked or handed-in one is a record, and stamping
    // today's date onto it would claim a sign-off day that never happened.
    if (attempt.outcome !== null || attempt.submittedAt !== null) {
      signoffFilled.current = true;
      return;
    }
    const name = session?.userName;
    if (name === undefined) return; // session still resolving; the name needs it
    signoffFilled.current = true;
    const writable = new Set(attempt.writableFieldIds ?? []);
    setValues((prev) => applyAssessorSignoff(attempt.fields, writable, prev, name, todayISODate()));
  }, [attempt, session]);

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
  /*
    QUIZ PAGES CARRY ONLY WHAT THE CANDIDATE ANSWERS. A question's ✓/✗ outcome
    cell is marking's print box — the server refuses writes to it — so it must
    not render under the question it belongs to; see `quizFields`.
  */
  const pages = useMemo(
    () =>
      paged
        ? theoryPages(quizFields(rendered, new Set(attempt?.writableFieldIds ?? [])))
        : [],
    [paged, rendered, attempt?.writableFieldIds],
  );
  const [pageIndex, setPageIndex] = useState(0);

  /*
    The assessor's marking guide, keyed for the per-field callout below. Present
    only on an assessor payload — the server sends the property ABSENT for a
    candidate, so an empty map here is also the proof nothing leaked. Memoized
    (and above the early returns, like every hook here) because `values` is
    keystroke-hot state — rebuilding the map every render is waste.
  */
  const modelAnswers = useMemo(
    () => new Map((attempt?.markingGuide ?? []).map((g) => [g.fieldId, g.modelAnswer])),
    [attempt?.markingGuide],
  );

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
  /*
    THE MARKING PASS: the assessor on a handed-in, not-yet-marked attempt. The
    server already narrowed `writableFieldIds` to the marking surface — the
    per-question ✓/✗ boxes and the sign-off block — so the screen opens for
    editing and the field gate below does the rest: the candidate's prose stays
    disabled because it is no longer in the writable set. `party` is identity,
    decided server-side, so a self-assessing candidate is `candidate` here and
    keeps today's frozen view of their own handed-in paper.
  */
  const markingPass = attempt.party === 'assessor' && handedIn && !marked;
  const readOnly = marked || (handedIn && attempt.party === 'candidate');

  /*
    Clamped on READ rather than reset on change: a question answered on the last
    page can make an earlier one visible or hidden, and snapping the candidate
    back to page one every time the list resized would lose their place.
  */
  /*
    THE QUIZ WINDOW IS THE CANDIDATE'S. `pages` is built from `quizFields`,
    which keeps only the writable set — right for a sitting, where marking's
    print boxes must not render under the questions. But on the marking pass
    `writableFieldIds` IS the narrow marking surface, so paging there would
    hand the assessor screens of bare ✓/✗ boxes with no questions and no
    guide. The marker always gets the full stacked surface instead.
  */
  const windowed = paged && !markingPass;
  const page = windowed ? pages[Math.min(pageIndex, Math.max(0, pages.length - 1))] : undefined;
  const answered = windowed ? answeredPages(pages, answers) : 0;
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

  /*
    The logbook's rows as they stand right now, so the progress panel moves as
    the candidate types. `logbookDurationRows` totals EVERY table that carries
    the duration column — a part may hold more than one — by the same rule the
    server threshold uses, so what the candidate sees accruing is what the
    threshold reads.
  */
  const logbookHourRows = attempt.durationColumnKey
    ? logbookDurationRows({ durationColumnKey: attempt.durationColumnKey }, values)
    : [];

  function onSave() {
    if (!attemptId || readOnly) return;
    /*
      ON THE MARKING PASS, SAVE ONLY WHAT IS OURS TO WRITE. The served values
      include the keyed questions' PRE-MARKS, merged in for display at cells the
      workflow keeps `auto` — not writable by anybody. The candidate flow PATCHes
      its whole map back and the server tolerates unchanged echoes, but a
      pre-mark is NOT in the stored map yet, so echoing it reads as writing a
      foreign field and the whole save is refused. Filtering to the server's own
      writable set sends exactly the marking surface; candidates keep today's
      whole-map echo untouched.
    */
    const payload = markingPass
      ? Object.fromEntries(Object.entries(values).filter(([id]) => writable.has(id)))
      : values;
    save.mutate(
      { attemptId, values: payload },
      {
        onSuccess: () => {
          setDirty(false);
          toast({ variant: 'success', message: 'Answers saved.' });
        },
        onError: () => toast({ variant: 'danger', message: "Couldn't save — try again." }),
      },
    );
  }

  // Never the quiz on a marking pass: the quiz is the CANDIDATE'S sitting
  // presentation (check-answer, retry, hand-in) — the assessor gets the stacked
  // marking surface with the model answers beside each written question.
  if (paged && !readOnly && !markingPass && pages.length > 0) {
    return (
      <TheoryQuiz
        pages={pages}
        values={values}
        writable={writable}
        retryMode={attempt.theoryRetry ?? 'end'}
        passPercent={attempt.theoryPassPercent ?? 100}
        partLabel={attempt.partLabel}
        partKey={attempt.partKey}
        caseId={caseId!}
        attemptId={attemptId!}
        onValueChange={setValue}
        onCheckQuestion={(fieldId, value) => checkQuestion.mutateAsync({ fieldId, value })}
        onSave={() =>
          new Promise<void>((resolve, reject) =>
            save.mutate(
              { attemptId: attemptId!, values },
              { onSuccess: () => { setDirty(false); resolve(); }, onError: reject },
            ),
          )
        }
        onSubmit={() =>
          new Promise((resolve, reject) =>
            setSubmitted.mutate(
              { attemptId: attemptId!, submitted: true },
              {
                onSuccess: (r) => {
                  setDirty(false);
                  const outcome = 'outcome' in r ? (r.outcome as string) : undefined;
                  const correctCount = 'correctCount' in r ? (r.correctCount as number) : undefined;
                  const totalCount = 'totalCount' in r ? (r.totalCount as number) : undefined;
                  resolve({ outcome, correctCount, totalCount });
                },
                onError: reject,
              },
            ),
          )
        }
        onTryAgain={() =>
          openAttempt.mutate(attempt.partKey, {
            onSuccess: (r) => navigate(`/app/assessments/${caseId}/attempts/${r.id}`),
            onError: () =>
              toast({
                variant: 'warning',
                message: "Couldn't open another attempt — your assessor may need to.",
              }),
          })
        }
        onBack={() => navigate(`/app/assessments/${caseId}`)}
        submitting={setSubmitted.isPending}
        saving={save.isPending}
      />
    );
  }

  // A part with a repeating table (a logbook) needs the room for all its
  // columns, so it lays out wider than an ordinary question part where a
  // narrow measure keeps text readable.
  const wideTable = attempt.fields.some((f) => f.type === 'repeating_group');

  return (
    <div
      className={`fai-rise mx-auto ${wideTable ? 'max-w-[1180px]' : 'max-w-[820px]'} p-[30px_28px_60px]`}
    >
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
          {attempt.minimumHours !== null && (
            <> · {attempt.minimumHours} {durationUnitLong(attempt.durationUnit ?? 'hours')} minimum</>
          )}
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

      {/*
        WHERE TO GO AFTER PASSING. A signed declaration used to dead-end on the
        "locked record" banner with no way onward; now it names the next part —
        a button when the candidate may start it, a note when it is the
        assessor's. Shown only once THIS part has passed, so a part still waiting
        on a mark is not told to move on.
      */}
      {marked && attempt.outcome === 'satisfactory' && (
        <NextStepPanel
          nextStep={attempt.nextStep}
          opening={openAttempt.isPending}
          onContinue={(partKey) =>
            openAttempt.mutate(partKey, {
              onSuccess: (r) => navigate(`/app/assessments/${caseId}/attempts/${r.id}`),
              onError: () =>
                toast({
                  variant: 'warning',
                  message: "Couldn't open the next part — your assessor may need to.",
                }),
            })
          }
        />
      )}

      {/*
        THE REOPEN BANNER IS THE CANDIDATE'S, BY PARTY. "You can still take it
        back" is candidate-voiced, and the button beside it reopened the
        attempt LIVE — on the assessor's marking pass that gesture un-hands-in
        the paper they are mid-way through marking, which is the candidate's
        act, never the marker's. The marking pass gets its own one-liner
        instead, so the state is still named without offering the wrong verb.
      */}
      {handedIn && !marked && attempt.party === 'candidate' && (
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

      {markingPass && (
        <div className="mb-4 rounded-[10px] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
          <p className="text-[13px] text-text-secondary">
            Marking — tick against the guide and save; the candidate's answers are frozen.
          </p>
        </div>
      )}

      {windowed && pages.length > 1 && (
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

      <LogbookProgress
        rows={logbookHourRows}
        taskMinimums={attempt.taskMinimums}
        durationColumnKey={attempt.durationColumnKey}
        minimumHours={attempt.minimumHours}
        unit={attempt.durationUnit}
      />

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
            {/*
              MODEL ANSWER — assessor guide. Rendered BESIDE the field rather
              than inside it: `FieldInput` stays unforked, and the candidate
              never has this block because the guide itself is absent from
              their payload — there is nothing here to hide, only to render.
              Whitespace-preserving because the answer key's prose arrives with
              its own line breaks and losing them mangles multi-part answers.
            */}
            {modelAnswers.has(f.id) && (
              <div className="mt-1.5 rounded-[10px] border border-warning bg-warning-soft p-[8px_10px]">
                <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-warning-text">
                  Model answer — assessor guide
                </p>
                <p className="whitespace-pre-wrap text-[12.5px] leading-snug text-warning-text">
                  {modelAnswers.get(f.id)}
                </p>
              </div>
            )}
          </div>
        ))}
        {shown.length === 0 && (
          <div className="col-span-12 py-6 text-center text-[13px] text-text-tertiary">
            There's nothing to complete in this part.
          </div>
        )}
      </div>

      {windowed && pages.length > 1 && (
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
          {/* NOT ON THE MARKING PASS: the attempt is already handed in — the
              assessor saves ticks and records the outcome from the case screen;
              a second "hand in" here would be an act with no meaning. */}
          {!markingPass && (
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
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Where the candidate goes after a part passes.
 *
 * A signed declaration used to leave them on a "locked record" banner with no
 * way onward. Now: a button to start the next part they may fill, or a plain
 * note that it is the assessor's to complete. Which one comes off the server's
 * `nextStep`, decided from the same workflow access the open-attempt route
 * enforces — so a "Continue" is never offered for a part the server would refuse.
 */
function NextStepPanel({
  nextStep,
  opening,
  onContinue,
}: {
  nextStep: CaseNextStep;
  opening: boolean;
  onContinue: (partKey: string) => void;
}) {
  if (nextStep.kind === 'continue') {
    return (
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-border-accent bg-surface-accent-soft px-3 py-3">
        <p className="text-[13px] text-text-secondary">
          Next: <strong className="text-text-primary">{nextStep.label}</strong>
        </p>
        <Button leadingIcon="arrow-right" disabled={opening} onClick={() => onContinue(nextStep.partKey)}>
          {opening ? 'Opening…' : `Continue to ${nextStep.label}`}
        </Button>
      </div>
    );
  }

  if (nextStep.kind === 'awaiting_other') {
    return (
      <div className="mb-4 rounded-[10px] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-3">
        <p className="text-[13px] text-text-secondary">
          The next part — <strong className="text-text-primary">{nextStep.label}</strong> — is
          completed by {nextStep.filledBy}. Please arrange to complete the next part.
        </p>
      </div>
    );
  }

  // 'done' — nothing further for this party; the case moves to sign-off.
  return (
    <div className="mb-4 rounded-[10px] border border-success bg-success-soft px-3 py-3">
      <p className="text-[13px] text-success-text">
        That’s every part you needed to complete — your assessor will finish the sign-off from here.
      </p>
    </div>
  );
}
