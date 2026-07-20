import { cn } from '../utils/cn.js';

export type BadgeVariant = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

export interface BadgeProps {
  variant?: BadgeVariant;
  /** Show a leading status dot. */
  dot?: boolean;
  size?: 'sm' | 'md';
  className?: string;
  children: React.ReactNode;
}

const VARIANTS: Record<BadgeVariant, string> = {
  neutral: 'bg-surface-sunken text-text-secondary',
  success: 'bg-success-soft text-success-text',
  warning: 'bg-warning-soft text-warning-text',
  danger: 'bg-danger-soft text-danger-text',
  info: 'bg-info-soft text-info-text',
  accent: 'bg-surface-accent-soft text-text-accent',
};

const DOT: Record<BadgeVariant, string> = {
  neutral: 'bg-text-tertiary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
  accent: 'bg-accent',
};

export function Badge({ variant = 'neutral', dot, size = 'sm', className, children }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-pill font-ui font-medium',
        size === 'sm' ? 'h-[22px] px-2.5 text-xs' : 'h-7 px-3 text-[13px]',
        VARIANTS[variant],
        className,
      )}
    >
      {dot && <span className={cn('h-1.5 w-1.5 rounded-full', DOT[variant])} />}
      {children}
    </span>
  );
}
