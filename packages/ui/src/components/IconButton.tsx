import { forwardRef } from 'react';
import { cn } from '../utils/cn.js';
import { Icon } from './Icon.js';
import type { ButtonSize, ButtonVariant } from './Button.js';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Lucide icon name. */
  icon: string;
  /** Accessible label — required, since there is no visible text. */
  'aria-label': string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const SIZES: Record<ButtonSize, { box: string; icon: number }> = {
  sm: { box: 'h-8 w-8', icon: 16 },
  md: { box: 'h-[42px] w-[42px]', icon: 18 },
  lg: { box: 'h-12 w-12', icon: 20 },
};

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-[#12321f] hover:bg-accent-hover',
  secondary: 'bg-solid text-solid-contrast hover:bg-solid-hover',
  outline: 'bg-surface-card text-text-primary border border-border-strong hover:bg-surface-hover',
  ghost: 'bg-transparent text-text-secondary hover:bg-surface-hover',
  subtle: 'bg-surface-sunken text-text-primary hover:bg-surface-hover',
  danger: 'bg-danger text-white hover:brightness-95',
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, variant = 'ghost', size = 'md', className, ...props },
  ref,
) {
  const s = SIZES[size];
  return (
    <button
      ref={ref}
      className={cn(
        'inline-grid place-items-center rounded-md transition-colors duration-fast ease-standard',
        'active:translate-y-[0.5px] disabled:opacity-50 disabled:pointer-events-none',
        s.box,
        VARIANTS[variant],
        className,
      )}
      {...props}
    >
      <Icon name={icon} size={s.icon} />
    </button>
  );
});
