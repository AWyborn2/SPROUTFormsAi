import { forwardRef, useEffect, useId, useRef } from 'react';
import { cn } from '../utils/cn.js';
import { Icon } from './Icon.js';

export interface CheckboxProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  label?: React.ReactNode;
  /** Tri-state visual — the native checkbox stays a boolean. */
  indeterminate?: boolean;
}

/**
 * Accessible checkbox. The native input drives state and keyboard (Space); the
 * styled box is a sibling that reflects `:checked`/`:focus-visible`.
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, indeterminate, id, className, disabled, ...props },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const localRef = useRef<HTMLInputElement | null>(null);

  // Merge the forwarded ref with the local one used for `indeterminate`.
  useEffect(() => {
    if (localRef.current) localRef.current.indeterminate = !!indeterminate;
  }, [indeterminate]);

  return (
    <label
      htmlFor={inputId}
      className={cn(
        'group inline-flex cursor-pointer select-none items-center gap-2.5',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      <span className="relative inline-grid h-[18px] w-[18px] flex-none place-items-center">
        <input
          ref={(node) => {
            localRef.current = node;
            if (typeof ref === 'function') ref(node);
            else if (ref) (ref as React.MutableRefObject<HTMLInputElement | null>).current = node;
          }}
          id={inputId}
          type="checkbox"
          disabled={disabled}
          className="peer absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-[5px] border border-border-strong bg-surface-card transition-colors duration-fast checked:border-accent checked:bg-accent indeterminate:border-accent indeterminate:bg-accent focus-visible:shadow-focus disabled:cursor-not-allowed"
          {...props}
        />
        <span className="pointer-events-none text-[#12321f] opacity-0 peer-checked:opacity-100 peer-indeterminate:opacity-100">
          <Icon name={indeterminate ? 'minus' : 'check'} size={13} className="stroke-[3]" />
        </span>
      </span>
      {label != null && (
        <span className="font-ui text-sm text-text-primary">{label}</span>
      )}
    </label>
  );
});
