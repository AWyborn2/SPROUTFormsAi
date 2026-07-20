const STEPS = ['Organisation', 'Branding', 'Done'];

/** The onboarding progress bars (three steps). `active` is a zero-based index. */
export function Stepper({ active }: { active: number }) {
  return (
    <div className="mb-[30px] flex gap-2">
      {STEPS.map((label, i) => {
        const done = i <= active;
        return (
          <div key={label} className="flex flex-1 flex-col gap-[7px]">
            <div
              className="h-1 rounded-full"
              style={{ background: done ? 'var(--brand-green)' : 'var(--border-default)' }}
            />
            <div
              className="font-mono text-[10.5px] tracking-wide"
              style={{ color: done ? 'var(--text-secondary)' : 'var(--text-tertiary)' }}
            >
              {label}
            </div>
          </div>
        );
      })}
    </div>
  );
}
