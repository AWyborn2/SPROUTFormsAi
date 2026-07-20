import { forwardRef } from 'react';
import { cn } from '../utils/cn.js';
import { Icon } from './Icon.js';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'outline'
  | 'ghost'
  | 'subtle'
  | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  loading?: boolean;
  /** Lucide icon name rendered before the label. */
  leadingIcon?: string;
  /** Lucide icon name rendered after the label. */
  trailingIcon?: string;
}

const VARIANTS: Record<ButtonVariant, string> = {
  // Green fill: dark ink text on green (never white — contrast rule).
  primary:
    'bg-accent text-[#12321f] hover:bg-accent-hover active:bg-accent-active border border-transparent',
  secondary:
    'bg-solid text-solid-contrast hover:bg-solid-hover active:bg-solid-active border border-transparent',
  outline:
    'bg-surface-card text-text-primary border border-border-strong hover:bg-surface-hover',
  ghost: 'bg-transparent text-text-primary hover:bg-surface-hover border border-transparent',
  subtle:
    'bg-surface-sunken text-text-primary hover:bg-surface-hover border border-transparent',
  danger: 'bg-danger text-white hover:brightness-95 border border-transparent',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5',
  md: 'h-[42px] px-4 text-sm gap-2',
  lg: 'h-12 px-5 text-[15px] gap-2',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    block,
    loading,
    leadingIcon,
    trailingIcon,
    disabled,
    className,
    children,
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center rounded-md font-ui font-semibold',
        'transition-[color,background-color,border-color,box-shadow] duration-fast ease-standard',
        'active:translate-y-[0.5px] disabled:opacity-50 disabled:pointer-events-none',
        SIZES[size],
        VARIANTS[variant],
        block && 'w-full',
        className,
      )}
      {...props}
    >
      {loading ? (
        <Icon name="loader-circle" size={16} className="animate-spin" />
      ) : (
        leadingIcon && <Icon name={leadingIcon} size={16} />
      )}
      {children}
      {trailingIcon && !loading && <Icon name={trailingIcon} size={16} />}
    </button>
  );
});
