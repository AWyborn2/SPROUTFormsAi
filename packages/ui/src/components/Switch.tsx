import { forwardRef, useId } from 'react';
import { cn } from '../utils/cn.js';

export interface SwitchProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  label?: React.ReactNode;
}

/**
 * On/off switch. A visually-hidden native checkbox owns state + keyboard
 * (Space), so it participates in forms and is fully accessible.
 */
export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { label, id, className, disabled, ...props },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;

  return (
    <label
      htmlFor={inputId}
      className={cn(
        'inline-flex cursor-pointer select-none items-center gap-2.5',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      <span className="relative inline-block h-[22px] w-[38px] flex-none">
        <input
          ref={ref}
          id={inputId}
          type="checkbox"
          role="switch"
          disabled={disabled}
          className="peer absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-pill border border-border-strong bg-surface-sunken transition-colors duration-fast checked:border-accent checked:bg-accent focus-visible:shadow-focus disabled:cursor-not-allowed"
          {...props}
        />
        <span className="pointer-events-none absolute left-[3px] top-1/2 h-[16px] w-[16px] -translate-y-1/2 rounded-full bg-white shadow-xs transition-transform duration-fast peer-checked:translate-x-[16px]" />
      </span>
      {label != null && <span className="font-ui text-sm text-text-primary">{label}</span>}
    </label>
  );
});
