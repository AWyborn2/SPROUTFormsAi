import { useCallback, useMemo, useState } from 'react';
import type { FormField, SubmissionValue, TheoryRetryMode } from '@formai/shared';
import { isChoiceField, isMatchingQuestion } from '@formai/shared';
import { Button, Icon } from '@formai/ui';
import { FieldInput } from '../fields/FieldRenderer.js';
import { MatchingField } from '../fields/MatchingField.js';
import { fillSpanClass, resolveFillSpan } from '../../lib/fill-layout.js';
import type { TheoryPage } from '../../lib/theory-pages.js';
import { QuizOptionCards } from './QuizOptionCards.js';
import { TheoryResults } from './TheoryResults.js';

/** Per-question feedback state after the candidate submits an answer. */
interface QuestionFeedback {
  correct: boolean;
  hint?: string | null;
}

export interface TheoryQuizProps {
  pages: TheoryPage[];
  values: Record<string, SubmissionValue>;
  writable: Set<string>;
  /** off = no retry; immediate = "Try again" on the spot; end = re-take on fail. */
  retryMode: TheoryRetryMode;
  passPercent: number;
  partLabel: string;
  partKey: string;
  caseId: string;
  attemptId: string;
  onValueChange: (fieldId: string, value: SubmissionValue) => void;
  onCheckQuestion: (
    fieldId: string,
    value: SubmissionValue,
  ) => Promise<{ correct: boolean; hint?: string | null }>;
  onSave: () => Promise<void>;
  onSubmit: () => Promise<{
    outcome?: string;
    correctCount?: number;
    totalCount?: number;
  }>;
  onTryAgain: () => void;
  onBack: () => void;
  submitting: boolean;
  saving: boolean;
}

type QuizPhase = 'quiz' | 'results';

/**
 * Interactive theory quiz — one question per screen with submit, feedback,
 * and a results screen at the end.
 */
export function TheoryQuiz({
  pages,
  values,
  writable,
  retryMode,
  passPercent,
  partLabel,
  onValueChange,
  onCheckQuestion,
  onSave,
  onSubmit,
  onTryAgain,
  onBack,
  submitting,
  saving,
}: TheoryQuizProps) {
  const [pageIndex, setPageIndex] = useState(0);
  const [phase, setPhase] = useState<QuizPhase>('quiz');
  const [feedback, setFeedback] = useState<Record<string, QuestionFeedback>>({});
  const [checking, setChecking] = useState(false);
  const [submitted, setSubmitted] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<{
    outcome?: string;
    correctCount?: number;
    totalCount?: number;
  } | null>(null);

  const page = pages[Math.min(pageIndex, Math.max(0, pages.length - 1))];
  const questionField = useMemo(
    () => page?.fields.find((f) => (f.options?.length ?? 0) > 0),
    [page],
  );
  const questionId = questionField?.id;

  const isAnswered = useCallback(
    (fId: string) => {
      const v = values[fId];
      if (v === null || v === undefined || v === '') return false;
      return !Array.isArray(v) || v.length > 0;
    },
    [values],
  );

  const currentAnswered = questionId ? isAnswered(questionId) : false;
  const currentFeedback = questionId ? feedback[questionId] : undefined;
  const currentSubmitted = questionId ? submitted.has(questionId) : false;
  const isLastPage = pageIndex >= pages.length - 1;

  /*
    A PAGE WITH NO MULTIPLE-CHOICE QUESTION still has to be completable.

    The quiz keys everything off a choice field — Submit checks its answer
    against the key, and the progress count only ticks when one is submitted. A
    page whose field is a signature, or any short-answer input, has no such
    field and no key to check, so it was a dead end: `questionId` was undefined,
    `currentAnswered` stayed false and the Submit button was disabled forever
    (the signature-only part that could never be handed in). Such a page is done
    the moment its own required inputs are filled — there is nothing to mark.
  */
  const requiredInputsDone = useMemo(() => {
    if (!page) return true;
    return page.fields
      .filter(
        (f) =>
          writable.has(f.id) &&
          f.required &&
          (f.options?.length ?? 0) === 0 &&
          f.type !== 'section_header',
      )
      .every((f) => isAnswered(f.id));
  }, [page, writable, isAnswered]);

  // Only the immediate mode lets a wrong answer be retried on the spot. The
  // 'end' mode instead offers a fresh whole-quiz attempt from the results screen.
  const canRetry =
    retryMode === 'immediate' && currentFeedback && !currentFeedback.correct;

  async function handleCheckAnswer() {
    if (!questionId || checking) return;
    const value = values[questionId] ?? null;
    if (!isAnswered(questionId)) return;

    setChecking(true);
    try {
      const result = await onCheckQuestion(questionId, value);
      setFeedback((prev) => ({ ...prev, [questionId]: result }));
      setSubmitted((prev) => new Set(prev).add(questionId));
    } catch {
      // If the check fails, let them proceed without feedback
      setFeedback((prev) => ({ ...prev, [questionId]: { correct: true } }));
      setSubmitted((prev) => new Set(prev).add(questionId));
    } finally {
      setChecking(false);
    }
  }

  function handleRetry() {
    if (!questionId) return;
    setFeedback((prev) => {
      const next = { ...prev };
      delete next[questionId];
      return next;
    });
    setSubmitted((prev) => {
      const next = new Set(prev);
      next.delete(questionId);
      return next;
    });
  }

  function handleNext() {
    if (isLastPage) {
      handleFinish();
    } else {
      setPageIndex((i) => Math.min(pages.length - 1, i + 1));
    }
  }

  async function handleFinish() {
    try {
      await onSave();
      const result = await onSubmit();
      setResults(result);
      setPhase('results');
    } catch {
      // Error handled by the caller's toast
    }
  }

  if (phase === 'results' && results) {
    return (
      <TheoryResults
        correctCount={results.correctCount ?? 0}
        totalCount={results.totalCount ?? 0}
        passPercent={passPercent}
        outcome={results.outcome}
        partLabel={partLabel}
        // A fresh whole-quiz attempt is offered on failure only in the 'end'
        // mode; 'off' and 'immediate' leave a re-attempt to the assessor.
        allowReattempt={retryMode === 'end'}
        onTryAgain={onTryAgain}
        onBack={onBack}
      />
    );
  }

  if (!page) return null;

  // A page is done when its multiple-choice question has been submitted, or —
  // for a page with no choice question (a signature, a short answer) — when its
  // required inputs are filled. Keeps the progress count and the segment colours
  // honest for a part that mixes quiz questions with a sign-off page.
  const isChoice = (f: FormField) => (f.options?.length ?? 0) > 0;
  const pageDone = (p: TheoryPage) => {
    const q = p.fields.find(isChoice);
    if (q) return submitted.has(q.id);
    return p.fields
      .filter((f) => writable.has(f.id) && f.required && f.type !== 'section_header')
      .every((f) => isAnswered(f.id));
  };
  const answered = pages.filter(pageDone).length;

  return (
    <div className="fai-rise mx-auto max-w-[680px] p-[30px_28px_60px]">
      <button
        type="button"
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-text-secondary hover:text-text-primary"
      >
        <Icon name="chevron-left" size={15} />
        Back to case
      </button>

      <header className="mb-6">
        <p className="text-[11.5px] font-semibold uppercase tracking-wider text-text-tertiary">
          Question
        </p>
        <p className="font-heading text-[28px] font-bold text-accent">
          {String(pageIndex + 1).padStart(2, '0')}
          <span className="text-text-quaternary"> / {String(pages.length).padStart(2, '0')}</span>
        </p>
      </header>

      {/* Progress bar */}
      <div className="mb-6">
        <div className="flex gap-1">
          {pages.map((_, i) => {
            const p = pages[i]!;
            const pField = p.fields.find(isChoice);
            const pFeedback = pField ? feedback[pField.id] : undefined;
            const isDone = pageDone(p);
            return (
              <div
                key={i}
                className="h-1.5 flex-1 overflow-hidden rounded-full transition-colors duration-300"
                style={{
                  backgroundColor: isDone
                    ? // A checked choice question shows right/wrong; a filled
                      // non-choice page (a signature) just shows done.
                      pField
                      ? pFeedback?.correct
                        ? 'var(--success)'
                        : 'var(--danger)'
                      : 'var(--success)'
                    : i === pageIndex
                      ? 'var(--accent)'
                      : 'var(--surface-sunken)',
                }}
              />
            );
          })}
        </div>
        <p className="mt-1.5 text-right text-[11px] text-text-tertiary">
          {answered} of {pages.length} answered
        </p>
      </div>

      {/* Divider */}
      <hr className="mb-6 border-border" />

      {/* Question content */}
      <div className="grid grid-cols-12 gap-[16px]">
        {page.fields.map((f) => {
          const isOption = isChoiceField(f.type) && (f.options?.length ?? 0) > 0;
          if (isOption) {
            const locked = !writable.has(f.id) || (currentSubmitted && !canRetry);
            /*
              A MATCHING QUESTION RENDERS AS A MATCH, NOT A FLAT LIST — the same
              choice as `FieldRenderer`. It is stored as a choice field whose
              options are the pairings, so it reaches this branch; without this
              the case quiz drew it as "select all correct answers" cards and
              dropped the pictures entirely. Presentation only — the value is
              the same array of pairing strings `markTheory` reads.
            */
            const matching = isMatchingQuestion(f.options) && f.matchPresentation;
            return (
              <div key={f.id} className="col-span-12">
                <div id={`${f.id}-q`} className="mb-3 text-[13px] font-semibold text-text-primary">
                  {f.label}
                  {f.required && <span className="ml-0.5 text-danger">*</span>}
                </div>
                {matching ? (
                  <MatchingField
                    options={f.options ?? []}
                    value={Array.isArray(values[f.id]) ? (values[f.id] as string[]) : []}
                    presentation={f.matchPresentation!}
                    disabled={locked}
                    labelId={`${f.id}-q`}
                    onChange={(v) => onValueChange(f.id, v)}
                  />
                ) : (
                  <QuizOptionCards
                    field={f}
                    value={values[f.id] ?? null}
                    disabled={locked}
                    onChange={(v) => onValueChange(f.id, v)}
                    feedback={currentSubmitted && questionId === f.id ? currentFeedback ?? null : null}
                  />
                )}
              </div>
            );
          }
          return (
            <div key={f.id} className={fillSpanClass(resolveFillSpan(f, false))}>
              <FieldInput
                field={f}
                value={values[f.id] ?? null}
                disabled={!writable.has(f.id)}
                onChange={(v) => onValueChange(f.id, v)}
              />
            </div>
          );
        })}
      </div>

      {/*
        Action buttons — only the way IN to a check lives inline: Submit for a
        choice question, or Finish for a page with no choice question (a
        signature/short answer), unlocked once its required inputs are filled.
        Everything AFTER a submit — the result and the way forward — lives in
        the result modal below, matching the South32 LMS moment.
      */}
      <div className="mt-6 flex items-center justify-center gap-3">
        {questionId
          ? !currentSubmitted && (
              <Button
                onClick={handleCheckAnswer}
                disabled={!currentAnswered || checking}
                className="min-w-[140px]"
              >
                {checking ? 'Checking…' : 'Submit'}
              </Button>
            )
          : (
              <Button
                onClick={handleNext}
                disabled={!requiredInputsDone || submitting || saving}
                className="min-w-[140px]"
              >
                {isLastPage ? (submitting ? 'Finishing…' : 'Finish') : 'Next'}
              </Button>
            )}
      </div>

      {/*
        South32-style result modal — a green tick for Correct, a red cross for
        Incorrect, then the single way forward: Next/Finish, or (immediate mode,
        wrong answer only) Try again. Keeping the forward action inside the modal
        preserves the "no way past a wrong answer while a retry is on the table"
        rule — there is no Next/Finish rendered until the retry is spent.
      */}
      {currentFeedback && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={currentFeedback.correct ? 'Correct' : 'Incorrect'}
          className="fai-fade fixed inset-0 z-50 flex items-center justify-center bg-[var(--surface-overlay)] p-4"
        >
          <div className="fai-pop w-full max-w-[380px] rounded-2xl bg-surface-card p-7 text-center shadow-xl">
            <div
              className={`mx-auto flex h-16 w-16 items-center justify-center rounded-full text-white ${
                currentFeedback.correct ? 'bg-[var(--success)]' : 'bg-[var(--danger)]'
              }`}
            >
              <Icon
                name={currentFeedback.correct ? 'check' : 'x'}
                size={32}
                className="stroke-[3]"
              />
            </div>
            <p className="mt-4 text-[20px] font-bold text-text-primary">
              {currentFeedback.correct ? 'Correct' : 'Incorrect'}
            </p>
            {!currentFeedback.correct && currentFeedback.hint && (
              <p className="mt-1.5 text-[13px] text-text-secondary">
                {currentFeedback.hint}
              </p>
            )}
            <div className="mt-6 flex justify-center">
              {canRetry ? (
                <Button
                  variant="outline"
                  leadingIcon="rotate-ccw"
                  onClick={handleRetry}
                  className="min-w-[160px]"
                >
                  Try again
                </Button>
              ) : (
                <Button
                  onClick={handleNext}
                  disabled={submitting || saving}
                  className="min-w-[160px]"
                >
                  {isLastPage ? (submitting ? 'Finishing…' : 'Finish') : 'Next'}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
