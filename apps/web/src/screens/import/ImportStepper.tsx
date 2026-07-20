import { Icon } from '@formai/ui';

const STEPS = [
  { label: 'Upload PDF', icon: 'upload' },
  { label: 'Review fields', icon: 'file-search' },
  { label: 'Confirm & publish', icon: 'rocket' },
] as const;

export function ImportStepper({ currentStep }: { currentStep: number }) {
  return (
    <div className="mx-auto mb-7 flex max-w-[620px] items-center justify-between">
      {STEPS.map((step, i) => {
        const isComplete = i < currentStep;
        const isCurrent = i === currentStep;
        const isUpcoming = i > currentStep;
        return (
          <div key={step.label} className="flex flex-1 items-center last:flex-none">
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={`grid h-9 w-9 place-items-center rounded-full text-[13px] font-bold transition-colors ${
                  isComplete
                    ? 'bg-success text-white'
                    : isCurrent
                    ? 'bg-accent text-[#12321f]'
                    : 'bg-surface-sunken text-text-tertiary'
                }`}
              >
                {isComplete ? (
                  <Icon name="check" size={16} />
                ) : (
                  <Icon name={step.icon} size={16} />
                )}
              </div>
              <span
                className={`whitespace-nowrap text-[11.5px] font-semibold ${
                  isComplete
                    ? 'text-success'
                    : isCurrent
                    ? 'text-text-primary'
                    : 'text-text-tertiary'
                }`}
              >
                {step.label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div
                className={`mx-3 h-[3px] flex-1 rounded-full transition-colors ${
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
