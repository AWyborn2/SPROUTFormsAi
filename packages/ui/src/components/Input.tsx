import { forwardRef, useId } from 'react';
import { cn } from '../utils/cn.js';
import { Icon } from './Icon.js';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  /** Lucide icon rendered inside the field, leading edge. */
  leadingIcon?: string;
  error?: string;
  help?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, leadingIcon, error, help, id, className, required, ...props },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const describedBy = error ? `${inputId}-err` : help ? `${inputId}-help` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={inputId} className="font-ui text-sm font-semibold text-text-primary">
          {label}
          {required && <span className="ml-0.5 text-danger">*</span>}
        </label>
      )}
      <div className="relative">
        {leadingIcon && (
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary">
            <Icon name={leadingIcon} size={16} />
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            'h-[42px] w-full rounded-md border bg-surface-card font-body text-sm text-text-primary',
            'placeholder:text-text-tertiary',
            'transition-[border-color,box-shadow] duration-fast ease-standard',
            'focus:outline-none focus-visible:border-border-accent focus-visible:shadow-focus',
            leadingIcon ? 'pl-9 pr-3' : 'px-3',
            error ? 'border-danger' : 'border-border-strong',
            className,
          )}
          {...props}
        />
      </div>
      {error ? (
        <p id={`${inputId}-err`} className="font-ui text-xs text-danger-text">
          {error}
        </p>
      ) : help ? (
        <p id={`${inputId}-help`} className="font-ui text-xs text-text-tertiary">
          {help}
        </p>
      ) : null}
    </div>
  );
});
