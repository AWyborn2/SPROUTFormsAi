import { useState } from 'react';
import { Icon } from '@formai/ui';
import type { FormField, SubmissionValue } from '@formai/shared';
import { FieldInput } from '../fields/FieldRenderer.js';
import {
  buildSteps,
  canAdvance,
  progressAt,
  stepIndexForField,
  totalScreens,
  unansweredRequired,
} from '../../lib/fill-steps.js';

interface ConversationalFillProps {
  fields: FormField[];
  values: Record<string, SubmissionValue>;
  errors: Record<string, string>;
  setValue: (id: string, value: SubmissionValue) => void;
  onSubmit: () => void;
  submitting: boolean;
  /** Rendered on the first screen so identity is captured before questions. */
  header: React.ReactNode;
}

/**
 * One question group per screen, with progress, next/back and a review step.
 *
 * All sequencing decisions live in `lib/fill-steps.ts` — this component only
 * renders them. That split exists because components cannot be rendered in
 * this workspace's test environment, and "can the respondent advance past a
 * required field" is a silent data-loss bug when it is wrong, not a cosmetic
 * one.
 *
 * The submitted payload is identical to the single-page layout's: same fields,
 * same values, same endpoint. Only the pacing differs.
 */
export function ConversationalFill({
  fields,
  values,
  errors,
  setValue,
  onSubmit,
  submitting,
  header,
}: ConversationalFillProps) {
  const steps = buildSteps(fields);
  const [index, setIndex] = useState(0);
  const [touched, setTouched] = useState(false);

  const onReview = index >= steps.length;
  const step = steps[index];
  const blocking = onReview ? [] : unansweredRequired(step, values);
  const progress = progressAt(index, steps);

  // A submit-time failure must return the respondent to the screen that owns
  // the field, not strand them on review with an off-screen cause.
  const jumpToFirstError = () => {
    const firstErrorId = Object.keys(errors)[0];
    if (!firstErrorId) return false;
    const target = stepIndexForField(steps, firstErrorId);
    if (target >= 0) {
      setIndex(target);
      setTouched(true);
      return true;
    }
    return false;
  };

  if (steps.length === 0) {
    return <div className="py-4 text-center text-[13px] text-text-tertiary">This form has no fields.</div>;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="mb-1.5 flex items-center justify-between text-[11.5px] text-text-tertiary">
          <span>
            {onReview ? 'Review' : `Question ${index + 1} of ${steps.length}`}
          </span>
          <span>{Math.round(progress * 100)}%</span>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-border-subtle">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${progress * 100}%`, background: 'var(--org-accent)' }}
          />
        </div>
      </div>

      {index === 0 && header}

      {onReview ? (
        <div>
          <div className="mb-3 text-sm font-bold text-text-primary">Check your answers</div>
          <ul className="flex flex-col divide-y divide-border-subtle">
            {steps.flatMap((s, si) =>
              s.fields.map((f) => (
                <li key={f.id} className="flex items-start justify-between gap-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] text-text-tertiary">{f.label}</span>
                    <span className="block text-[13px] text-text-primary">
                      {formatAnswer(values[f.id])}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setIndex(si)}
                    className="flex-none text-[12px] font-semibold text-accent"
                  >
                    Edit
                  </button>
                </li>
              )),
            )}
          </ul>
        </div>
      ) : (
        <div>
          {step?.title && (
            <div
              className="mb-3"
              style={{
                fontSize: 'var(--org-heading-size)',
                fontWeight: 'var(--org-heading-weight)' as unknown as number,
              }}
            >
              {step.title}
            </div>
          )}
          <div className="flex flex-col gap-5">
            {step?.fields.map((f) => (
              <FieldInput
                key={f.id}
                field={f}
                value={(values[f.id] ?? null) as never}
                error={
                  errors[f.id] ||
                  (touched && blocking.includes(f.id) ? 'This question is required.' : undefined)
                }
                onChange={(v) => setValue(f.id, v)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => {
            setTouched(false);
            setIndex((i) => Math.max(0, i - 1));
          }}
          disabled={index === 0}
          className="fai-chip-btn rounded-md border border-border px-3.5 py-2 text-[13px] font-semibold text-text-secondary disabled:opacity-40"
        >
          Back
        </button>

        {onReview ? (
          <button
            type="button"
            onClick={() => {
              if (!jumpToFirstError()) onSubmit();
            }}
            disabled={submitting}
            className="fai-lift flex items-center gap-2 px-5 py-2.5 text-[15px] font-bold disabled:opacity-60"
            style={{
              background: 'var(--org-accent)',
              color: 'var(--org-accent-text)',
              borderRadius: 'var(--org-button-radius)',
              fontFamily: 'var(--org-font)',
            }}
          >
            {submitting ? 'Submitting…' : 'Submit'}
            <Icon name="arrow-right" size={16} />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              if (!canAdvance(steps, index, values)) {
                setTouched(true);
                return;
              }
              setTouched(false);
              setIndex((i) => Math.min(totalScreens(steps) - 1, i + 1));
            }}
            className="fai-lift flex items-center gap-2 px-5 py-2.5 text-[15px] font-bold"
            style={{
              background: 'var(--org-accent)',
              color: 'var(--org-accent-text)',
              borderRadius: 'var(--org-button-radius)',
              fontFamily: 'var(--org-font)',
            }}
          >
            Next
            <Icon name="arrow-right" size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

/** Human-readable echo of an answer on the review screen. */
function formatAnswer(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return 'Provided';
  return String(value);
}
