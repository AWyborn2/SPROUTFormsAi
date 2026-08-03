import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { SubmissionValue } from '@formai/shared';
import { Button, Icon, useToast } from '@formai/ui';
import {
  useAssessmentAttempt,
  useSaveAttempt,
  useSetAttemptSubmitted,
} from '../../lib/data/hooks.js';
import { partVisibility } from '../../lib/assessment-fill.js';
import { fillSpanClass, resolveFillSpan, visibleFillFields } from '../../lib/fill-layout.js';
import { FieldInput } from '../fields/FieldRenderer.js';

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

  const [values, setValues] = useState<Record<string, SubmissionValue>>({});
  const [dirty, setDirty] = useState(false);
  /**
   * Seeded once. Re-seeding on every fetch would discard whatever the candidate
   * had typed since — a background refetch mid-answer must not wipe the page.
   */
  const seeded = useRef(false);

  useEffect(() => {
    if (!attempt || seeded.current) return;
    setValues(attempt.values ?? {});
    seeded.current = true;
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
  const rendered = visibleFillFields(attempt.fields, answers, sources);
  /*
    Which fields this caller may change, as the server decided. A tool with no
    workflow authored sends every field of the part, so nothing renders
    read-only until somebody configures it.
  */
  const writable = new Set(attempt.writableFieldIds ?? []);

  function setValue(fieldId: string, v: SubmissionValue) {
    setValues((prev) => ({ ...prev, [fieldId]: v }));
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
        <p className="mb-4 rounded-[10px] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-[13px] text-text-secondary">
          This attempt has been marked, so it can no longer be changed. If you need another go, your
          assessor can open a new attempt.
        </p>
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

      <div className="grid grid-cols-12 gap-[16px]">
        {rendered.map((f) => (
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
        {rendered.length === 0 && (
          <div className="col-span-12 py-6 text-center text-[13px] text-text-tertiary">
            There's nothing to complete in this part.
          </div>
        )}
      </div>

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
          <Button
            leadingIcon="send"
            disabled={save.isPending || setSubmitted.isPending}
            onClick={() => {
              if (!attemptId) return;
              const handOff = () =>
                setSubmitted.mutate(
                  { attemptId, submitted: true },
                  {
                    onSuccess: () => {
                      setDirty(false);
                      toast({ variant: 'success', message: 'Handed in for marking.' });
                    },
                    onError: () =>
                      toast({ variant: 'danger', message: "Couldn't hand in — try again." }),
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
            {setSubmitted.isPending ? 'Handing in…' : 'Hand in for marking'}
          </Button>
        </div>
      )}
    </div>
  );
}
