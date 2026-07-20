import { forwardRef, useId } from 'react';
import { cn } from '../utils/cn.js';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  help?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, error, help, id, className, required, rows = 4, ...props },
  ref,
) {
  const autoId = useId();
  const areaId = id ?? autoId;
  const describedBy = error ? `${areaId}-err` : help ? `${areaId}-help` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={areaId} className="font-ui text-sm font-semibold text-text-primary">
          {label}
          {required && <span className="ml-0.5 text-danger">*</span>}
        </label>
      )}
      <textarea
        ref={ref}
        id={areaId}
        rows={rows}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(
          'w-full rounded-md border bg-surface-card px-3 py-2.5 font-body text-sm text-text-primary',
          'placeholder:text-text-tertiary',
          'transition-[border-color,box-shadow] duration-fast ease-standard',
          'focus:outline-none focus-visible:border-border-accent focus-visible:shadow-focus',
          error ? 'border-danger' : 'border-border-strong',
          className,
        )}
        {...props}
      />
      {error ? (
        <p id={`${areaId}-err`} className="font-ui text-xs text-danger-text">
          {error}
        </p>
      ) : help ? (
        <p id={`${areaId}-help`} className="font-ui text-xs text-text-tertiary">
          {help}
        </p>
      ) : null}
    </div>
  );
});
