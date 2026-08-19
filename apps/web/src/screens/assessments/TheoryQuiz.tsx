import { useCallback, useMemo, useState } from 'react';
import type { FormField, SubmissionValue } from '@formai/shared';
import { isChoiceField } from '@formai/shared';
import { Button, Icon } from '@formai/ui';
import { FieldInput } from '../fields/FieldRenderer.js';
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
  allowRetry: boolean;
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
  allowRetry,
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

  const canRetry =
    allowRetry && currentFeedback && !currentFeedback.correct;

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
            return (
              <div key={f.id} className="col-span-12">
                <div className="mb-3 text-[13px] font-semibold text-text-primary">
                  {f.label}
                  {f.required && <span className="ml-0.5 text-danger">*</span>}
                </div>
                <QuizOptionCards
                  field={f}
                  value={values[f.id] ?? null}
                  disabled={
                    !writable.has(f.id) ||
                    (currentSubmitted && !canRetry)
                  }
                  onChange={(v) => onValueChange(f.id, v)}
                  feedback={currentSubmitted && questionId === f.id ? currentFeedback ?? null : null}
                />
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

      {/* Feedback area */}
      {currentFeedback && (
        <div
          className={`mt-5 flex flex-col items-center gap-2 rounded-xl p-5 text-center transition-all duration-300 ${
            currentFeedback.correct
              ? 'bg-[var(--success-bg,oklch(0.95_0.02_145))]'
              : 'bg-[var(--danger-bg,oklch(0.95_0.02_25))]'
          }`}
        >
          <div
            className={`flex h-12 w-12 items-center justify-center rounded-full ${
              currentFeedback.correct
                ? 'bg-[var(--success)] text-white'
                : 'bg-[var(--danger)] text-white'
            }`}
          >
            <Icon
              name={currentFeedback.correct ? 'check' : 'x'}
              size={24}
            />
          </div>
          <p className="text-[15px] font-semibold">
            {currentFeedback.correct ? 'Correct' : 'Incorrect'}
          </p>
          {!currentFeedback.correct && currentFeedback.hint && (
            <p className="text-[12.5px] text-text-secondary">{currentFeedback.hint}</p>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="mt-6 flex items-center justify-center gap-3">
        {questionId ? (
          <>
            {!currentSubmitted && (
              <Button
                onClick={handleCheckAnswer}
                disabled={!currentAnswered || checking}
                className="min-w-[140px]"
              >
                {checking ? 'Checking…' : 'Submit'}
              </Button>
            )}

            {canRetry && (
              <Button
                variant="outline"
                leadingIcon="rotate-ccw"
                onClick={handleRetry}
              >
                Try again
              </Button>
            )}

            {currentSubmitted && !canRetry && (
              <Button
                onClick={handleNext}
                disabled={submitting || saving}
                className="min-w-[140px]"
              >
                {isLastPage
                  ? submitting
                    ? 'Finishing…'
                    : 'Finish'
                  : 'Next'}
              </Button>
            )}
          </>
        ) : (
          /*
            No choice question on this page — nothing to check, so straight to
            Next/Finish, unlocked once the page's required inputs (the signature)
            are filled. This is what lets a signature-only or short-answer page
            be handed in at all.
          */
          <Button
            onClick={handleNext}
            disabled={!requiredInputsDone || submitting || saving}
            className="min-w-[140px]"
          >
            {isLastPage ? (submitting ? 'Finishing…' : 'Finish') : 'Next'}
          </Button>
        )}
      </div>
    </div>
  );
}
