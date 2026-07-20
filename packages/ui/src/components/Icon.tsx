import { createElement } from 'react';
import { cn } from '../utils/cn.js';

export interface IconProps {
  /** Lucide icon name, e.g. "arrow-right". */
  name: string;
  size?: number;
  className?: string;
  /** Inline color; defaults to currentColor. */
  color?: string;
  'aria-label'?: string;
}

/**
 * Lucide-via-Iconify wrapper. Inherits currentColor unless `color` is set.
 * Rendered via createElement so no custom-element JSX augmentation is needed
 * across package boundaries.
 */
export function Icon({ name, size = 18, className, color, ...aria }: IconProps) {
  return createElement('iconify-icon', {
    icon: `lucide:${name}`,
    width: size,
    height: size,
    className: cn('inline-flex align-middle', className),
    style: color ? { color } : undefined,
    'aria-hidden': aria['aria-label'] ? undefined : true,
    'aria-label': aria['aria-label'],
  });
}
