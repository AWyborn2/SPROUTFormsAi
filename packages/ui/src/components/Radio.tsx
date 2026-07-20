import { forwardRef, useId } from 'react';
import { cn } from '../utils/cn.js';

export interface RadioProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  label?: React.ReactNode;
}

/**
 * A single radio option. Group them by giving every option the same `name`;
 * native arrow-key roving between same-named radios is handled by the browser.
 */
export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio(
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
      <span className="relative inline-grid h-[18px] w-[18px] flex-none place-items-center">
        <input
          ref={ref}
          id={inputId}
          type="radio"
          disabled={disabled}
          className="peer absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-full border border-border-strong bg-surface-card transition-colors duration-fast checked:border-accent focus-visible:shadow-focus disabled:cursor-not-allowed"
          {...props}
        />
        <span className="pointer-events-none h-2 w-2 rounded-full bg-accent opacity-0 peer-checked:opacity-100" />
      </span>
      {label != null && <span className="font-ui text-sm text-text-primary">{label}</span>}
    </label>
  );
});
