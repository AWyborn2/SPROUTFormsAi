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
        {/* Checked = SOLID accent circle with a contrasting inner dot. The old
            state only recolored the ring and drew an 8px dot in the same pale
            accent on a white well, which read as "outlined, not selected". A
            card-colored dot on a filled circle keeps contrast in both themes,
            mirroring how the calendar renders its selected day. */}
        <input
          ref={ref}
          id={inputId}
          type="radio"
          disabled={disabled}
          className="peer absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-full border border-border-strong bg-surface-card transition-colors duration-fast checked:border-accent checked:bg-accent focus-visible:shadow-focus disabled:cursor-not-allowed"
          {...props}
        />
        {/* `relative` is load-bearing: the input above is absolutely
            positioned, and a positioned element paints OVER later in-flow
            content in the same stacking context — without this the dot is
            drawn underneath the input's opaque background, never visible. */}
        <span className="pointer-events-none relative h-[7px] w-[7px] rounded-full bg-surface-card opacity-0 peer-checked:opacity-100" />
      </span>
      {label != null && <span className="font-ui text-sm text-text-primary">{label}</span>}
    </label>
  );
});
