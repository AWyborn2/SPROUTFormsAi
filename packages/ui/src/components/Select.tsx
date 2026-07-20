import { forwardRef, useId } from 'react';
import { cn } from '../utils/cn.js';
import { Icon } from './Icon.js';

export interface SelectOption {
  label: string;
  value: string;
}

export interface SelectProps
  extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  label?: string;
  options: Array<SelectOption | string>;
  error?: string;
  placeholder?: string;
}

/** Styled native select with a chevron affordance. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, options, error, placeholder, id, className, required, ...props },
  ref,
) {
  const autoId = useId();
  const selectId = id ?? autoId;
  const opts = options.map((o) => (typeof o === 'string' ? { label: o, value: o } : o));

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={selectId} className="font-ui text-sm font-semibold text-text-primary">
          {label}
          {required && <span className="ml-0.5 text-danger">*</span>}
        </label>
      )}
      <div className="relative">
        <select
          ref={ref}
          id={selectId}
          required={required}
          aria-invalid={error ? true : undefined}
          className={cn(
            'h-[42px] w-full appearance-none rounded-md border bg-surface-card px-3 pr-9',
            'font-body text-sm text-text-primary',
            'transition-[border-color,box-shadow] duration-fast ease-standard',
            'focus:outline-none focus-visible:border-border-accent focus-visible:shadow-focus',
            error ? 'border-danger' : 'border-border-strong',
            className,
          )}
          {...props}
        >
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary">
          <Icon name="chevron-down" size={16} />
        </span>
      </div>
      {error && <p className="font-ui text-xs text-danger-text">{error}</p>}
    </div>
  );
});
