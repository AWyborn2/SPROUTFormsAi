import type { FormField, SubmissionValue } from '@formai/shared';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export interface QuizOptionCardsProps {
  field: FormField;
  value: SubmissionValue;
  disabled: boolean;
  onChange: (value: SubmissionValue) => void;
  /** After check-question, drives per-option highlighting. */
  feedback?: { correct: boolean } | null;
}

/**
 * Lettered option cards in a responsive grid — the quiz-mode replacement for
 * plain Radio/Checkbox inputs. Handles both single-select (radio) and
 * multi-select (checkbox_group) fields.
 */
export function QuizOptionCards({
  field,
  value,
  disabled,
  onChange,
  feedback,
}: QuizOptionCardsProps) {
  const options = field.options ?? [];
  if (options.length === 0) return null;

  const multi = field.type === 'checkbox_group';
  const selected = multi
    ? new Set(Array.isArray(value) ? (value as string[]) : [])
    : new Set(typeof value === 'string' && value ? [value] : []);
  const hasSubmitted = feedback !== undefined && feedback !== null;

  function toggle(option: string) {
    if (disabled) return;
    if (multi) {
      const next = new Set(selected);
      if (next.has(option)) next.delete(option);
      else next.add(option);
      onChange([...next]);
    } else {
      onChange(selected.has(option) ? '' : option);
    }
  }

  const role = multi ? 'group' : 'radiogroup';
  const instruction = multi
    ? 'Select all the correct answer(s) from the given options.'
    : 'Select the correct answer.';

  return (
    <div>
      <p className="mb-3 text-center text-[12.5px] italic text-text-tertiary">
        {instruction}
      </p>

      <div
        role={role}
        aria-label={field.label}
        className="grid grid-cols-1 gap-2.5 sm:grid-cols-2"
      >
        {options.map((option, i) => {
          const isSelected = selected.has(option);
          const letter = LETTERS[i] ?? String(i + 1);

          let cardStyle: string;
          if (hasSubmitted && isSelected) {
            cardStyle = feedback.correct
              ? 'border-[var(--success)] bg-[var(--success-bg,oklch(0.96_0.02_145))]'
              : 'border-[var(--danger)] bg-[var(--danger-bg,oklch(0.96_0.02_25))]';
          } else if (isSelected) {
            cardStyle = 'border-accent bg-[var(--accent-bg,oklch(0.96_0.03_250))]';
          } else {
            cardStyle = 'border-border bg-surface-page';
          }

          return (
            <button
              key={option}
              type="button"
              role={multi ? 'checkbox' : 'radio'}
              aria-checked={isSelected}
              aria-label={`${letter}. ${option}`}
              disabled={disabled}
              onClick={() => toggle(option)}
              className={[
                'group flex items-center gap-3 rounded-xl border-2 px-3.5 py-3 text-left transition-all duration-150',
                cardStyle,
                disabled
                  ? 'cursor-default opacity-70'
                  : 'cursor-pointer hover:shadow-sm focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1',
              ].join(' ')}
            >
              <span
                className={[
                  'flex h-[34px] w-[34px] flex-none items-center justify-center rounded-lg text-[14px] font-bold transition-colors duration-150',
                  isSelected
                    ? 'bg-accent text-white'
                    : 'bg-surface-sunken text-text-secondary group-hover:bg-[var(--surface-3,var(--surface-sunken))]',
                ].join(' ')}
              >
                {letter}
              </span>
              <span className="text-[13.5px] leading-snug text-text-primary">
                {option}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
