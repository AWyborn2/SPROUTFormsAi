import { Icon } from '@formai/ui';
import { BUILDER_STEPS, BUILDER_STEP_LABELS, stepIndex, type BuilderStep } from '@formai/shared';

/**
 * The builder's seven-step progress rail.
 *
 * TWO PRESENTATIONS OF ONE THING. The full stepper heads every step that has
 * the page to itself. Steps 2 and 3 do not: their left column is a full-height
 * structure panel or chat that runs flush to the app sidebar, so a header above
 * it would push the column off the bottom of the screen. Those steps get the
 * compact rail instead, which sits inside the artifact column directly above
 * the form.
 *
 * Both are here rather than in two files because they are the same control and
 * have to stay in step: the same steps, the same order, the same done/current
 * tones, and the same click-to-jump.
 */

const STEP_ICONS: Record<BuilderStep, string> = {
  upload: 'upload',
  generate: 'sparkles',
  units: 'blocks',
  answer_key: 'key-round',
  placement: 'square-dashed',
  workflow: 'workflow',
};

export interface StepperProps {
  current: BuilderStep;
  onGo: (step: BuilderStep) => void;
  /** Steps that cannot be reached yet, e.g. before a document has been read. */
  disabled?: readonly BuilderStep[];
}

export function BuilderStepper({ current, onGo, disabled = [] }: StepperProps) {
  const at = stepIndex(current);

  return (
    <div className="mx-auto mb-7 flex max-w-[1000px] items-start justify-between">
      {BUILDER_STEPS.map((step, i) => {
        const isComplete = i < at;
        const isCurrent = i === at;
        const isBlocked = disabled.includes(step);
        return (
          <div key={step} className="flex flex-1 items-start last:flex-none">
            <button
              type="button"
              disabled={isBlocked}
              onClick={() => onGo(step)}
              aria-current={isCurrent ? 'step' : undefined}
              className="flex flex-col items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span
                className={`grid h-9 w-9 place-items-center rounded-full text-[13px] font-bold transition-colors ${
                  isComplete
                    ? 'bg-success text-white'
                    : isCurrent
                      ? 'bg-accent text-accent-contrast'
                      : 'bg-surface-sunken text-text-tertiary'
                }`}
              >
                <Icon name={isComplete ? 'check' : STEP_ICONS[step]} size={16} />
              </span>
              <span
                className={`whitespace-nowrap text-[11.5px] font-semibold ${
                  isComplete
                    ? 'text-success'
                    : isCurrent
                      ? 'text-text-primary'
                      : 'text-text-tertiary'
                }`}
              >
                {BUILDER_STEP_LABELS[step]}
              </span>
            </button>
            {i < BUILDER_STEPS.length - 1 && (
              <div
                className={`mx-2.5 mt-[17px] h-[3px] flex-1 rounded-full transition-colors ${
                  isComplete ? 'bg-success' : 'bg-border'
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The compact rail for steps 2 and 3.
 *
 * START-ALIGNED, DELIBERATELY. `justify-content: flex-end` makes overflow spill
 * past the START edge, which browsers do not make scrollable — so at a narrow
 * width the first chips become unreachable with no scrollbar to say so. Aligned
 * to the start, the overflow spills right and scrolls.
 */
export function BuilderMiniSteps({ current, onGo, disabled = [] }: StepperProps) {
  const at = stepIndex(current);

  return (
    <span className="fai-scroll flex min-w-0 flex-1 items-center justify-start gap-[3px] overflow-x-auto">
      {BUILDER_STEPS.map((step, i) => {
        const isComplete = i < at;
        const isCurrent = i === at;
        const isBlocked = disabled.includes(step);
        return (
          <button
            key={step}
            type="button"
            disabled={isBlocked}
            onClick={() => onGo(step)}
            title={`Step ${i + 1} — ${BUILDER_STEP_LABELS[step]}`}
            aria-current={isCurrent ? 'step' : undefined}
            className={`inline-flex flex-none items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-1 text-[10.5px] font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${
              isCurrent
                ? 'border-border-accent bg-surface-accent-soft text-text-accent'
                : isComplete
                  ? 'border-transparent text-success'
                  : 'border-transparent text-text-tertiary'
            }`}
          >
            <Icon name={isComplete ? 'check' : STEP_ICONS[step]} size={11} />
            {BUILDER_STEP_LABELS[step]}
          </button>
        );
      })}
    </span>
  );
}
