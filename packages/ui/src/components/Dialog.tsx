import { useCallback, useEffect, useRef } from 'react';
import { cn } from '../utils/cn.js';
import { Icon } from './Icon.js';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  /** Max panel width. */
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZES = {
  sm: 'max-w-[380px]',
  md: 'max-w-[520px]',
  lg: 'max-w-[720px]',
} as const;

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog with a focus trap, Escape-to-close, backdrop dismiss, and
 * focus restoration to the previously-focused element on close.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  className,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  const trap = useCallback((e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (n) => n.offsetParent !== null,
    );
    if (nodes.length === 0) {
      e.preventDefault();
      panel.focus();
      return;
    }
    const first = nodes[0]!;
    const last = nodes[nodes.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  // Auto-focus + focus-restore. Keyed ONLY on `open` so it fires on genuine
  // open/close transitions and nothing else — in particular, it must not
  // depend on `onClose`/`trap`, since callers routinely pass an unmemoized
  // `onClose` that gets a new reference on every re-render (e.g. typing into
  // a child <Input> re-renders the parent). If this effect re-ran on those
  // renders it would re-run `querySelector(FOCUSABLE)?.focus()` and steal
  // focus away from whatever the user is typing into.
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    // Focus the first focusable control, else the panel.
    const firstFocusable = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (firstFocusable ?? panel)?.focus();

    return () => {
      restoreRef.current?.focus?.();
    };
  }, [open]);

  // Escape-to-close + Tab focus-trap. Safe to re-subscribe on every
  // `onClose`/`trap` change — unlike the effect above, re-running this one
  // has no focus side effects, so it doesn't reproduce the focus-stealing
  // bug. Keeping it separate also means Escape/Tab always use the latest
  // `onClose` rather than a stale closure.
  useEffect(() => {
    if (!open) return;

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      trap(e);
    }
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose, trap]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={cn(
          'fai-fade w-full overflow-hidden rounded-xl border border-border bg-surface-card shadow-xl focus:outline-none',
          SIZES[size],
          className,
        )}
        style={{ animation: 'faiPop var(--duration-base) var(--ease-entrance)' }}
      >
        {(title || description) && (
          <div className="flex items-start gap-3 border-b border-border-subtle px-6 py-5">
            <div className="min-w-0 flex-1">
              {title && <h3 className="text-lg font-bold">{title}</h3>}
              {description && (
                <p className="mt-1 text-[13.5px] text-text-secondary">{description}</p>
              )}
            </div>
            <button
              onClick={onClose}
              aria-label="Close dialog"
              className="grid h-8 w-8 flex-none place-items-center rounded-md text-text-tertiary hover:bg-surface-hover"
            >
              <Icon name="x" size={17} />
            </button>
          </div>
        )}
        {children != null && <div className="px-6 py-5">{children}</div>}
        {footer != null && (
          <div className="flex items-center justify-end gap-3 border-t border-border-subtle px-6 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
