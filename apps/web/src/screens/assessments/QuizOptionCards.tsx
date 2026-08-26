import type { FormField, SubmissionValue } from '@formai/shared';
import { Icon } from '@formai/ui';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export interface QuizOptionCardsProps {
  field: FormField;
  value: SubmissionValue;
  disabled: boolean;
  onChange: (value: SubmissionValue) => void;
  /** After check-question, drives per-option highlighting. */
  feedback?: { correct: boolean } | null;
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Selection styling shared by the lettered rows and the thumbs cards.
 *
 * The South32 look keeps three states visually separate: YELLOW means "you
 * picked this", GREEN (after submit) means the pick was right, RED means it was
 * wrong. Because the answer key never reaches the client, only the candidate's
 * own choice is ever marked — a wrong pick turns red but the deck never reveals
 * which option was correct.
 */
function pickClasses(
  isSelected: boolean,
  submittedThisCard: boolean,
  correct: boolean,
): string {
  if (submittedThisCard) {
    return correct
      ? 'border-[var(--success)] bg-[var(--success)] text-white'
      : 'border-[var(--danger)] bg-[var(--danger)] text-white';
  }
  if (isSelected) {
    return 'border-[var(--quiz-pick-border)] bg-[var(--quiz-pick)] text-[var(--quiz-pick-ink)]';
  }
  return 'border-border bg-surface-page text-text-primary';
}

/**
 * Quiz answer cards — the quiz-mode replacement for plain Radio/Checkbox
 * inputs, styled to match the South32 LMS. A single-select True/False (or
 * Yes/No) question renders as two thumbs cards; everything else renders as
 * lettered A/B/C rows. Handles single-select (radio) and multi-select
 * (checkbox_group) fields.
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

  // A two-way True/False or Yes/No single-select gets the thumbs treatment.
  const labels = options.map(norm);
  const isThumbs =
    !multi &&
    options.length === 2 &&
    ((labels.includes('true') && labels.includes('false')) ||
      (labels.includes('yes') && labels.includes('no')));

  const role = multi ? 'group' : 'radiogroup';
  const instruction = isThumbs
    ? labels.includes('true')
      ? 'Choose True or False.'
      : 'Choose Yes or No.'
    : multi
      ? 'Select all the correct answer(s) from the given options.'
      : 'Select the correct answer.';

  return (
    <div>
      <p className="mb-3 text-center text-[12.5px] italic text-text-tertiary">
        {instruction}
      </p>

      {isThumbs ? (
        <div role={role} aria-label={field.label} className="grid grid-cols-2 gap-3">
          {options.map((option) => {
            const isSelected = selected.has(option);
            const submittedThisCard = hasSubmitted && isSelected;
            const positive = ['true', 'yes'].includes(norm(option));

            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={isSelected}
                aria-label={option}
                disabled={disabled}
                onClick={() => toggle(option)}
                className={[
                  'flex min-h-[132px] flex-col items-center justify-center gap-2.5 rounded-2xl border-2 px-4 py-5 transition-all duration-150',
                  pickClasses(isSelected, submittedThisCard, feedback?.correct ?? false),
                  disabled
                    ? 'cursor-default opacity-70'
                    : 'cursor-pointer hover:shadow-sm focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1',
                ].join(' ')}
              >
                <Icon name={positive ? 'thumbs-up' : 'thumbs-down'} size={38} />
                <span className="text-[16px] font-bold">{option}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div
          role={role}
          aria-label={field.label}
          className="grid grid-cols-1 gap-2.5 sm:grid-cols-2"
        >
          {options.map((option, i) => {
            const isSelected = selected.has(option);
            const submittedThisCard = hasSubmitted && isSelected;
            const letter = LETTERS[i] ?? String(i + 1);

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
                  pickClasses(isSelected, submittedThisCard, feedback?.correct ?? false),
                  disabled
                    ? 'cursor-default opacity-70'
                    : 'cursor-pointer hover:shadow-sm focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1',
                ].join(' ')}
              >
                <span
                  className={[
                    'flex h-[34px] w-[34px] flex-none items-center justify-center rounded-lg text-[14px] font-bold transition-colors duration-150',
                    submittedThisCard
                      ? 'bg-white/25 text-current'
                      : isSelected
                        ? 'bg-[var(--quiz-pick-ink)] text-[var(--quiz-pick)]'
                        : 'bg-surface-sunken text-text-secondary group-hover:bg-[var(--surface-3,var(--surface-sunken))]',
                  ].join(' ')}
                >
                  {letter}
                </span>
                <span className="text-[13.5px] leading-snug">{option}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
