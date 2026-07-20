import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { cn } from '../utils/cn.js';
import { Icon } from './Icon.js';

export type ToastVariant = 'success' | 'info' | 'warning' | 'danger';

export interface ToastOptions {
  message: string;
  variant?: ToastVariant;
  /** Auto-dismiss delay in ms; 0 keeps it until dismissed. */
  duration?: number;
}

interface ActiveToast extends Required<Omit<ToastOptions, 'duration'>> {
  id: number;
}

interface ToastCtx {
  toast: (opts: ToastOptions) => void;
}

const Ctx = createContext<ToastCtx | null>(null);

const ICONS: Record<ToastVariant, string> = {
  success: 'check-circle-2',
  info: 'info',
  warning: 'alert-triangle',
  danger: 'alert-circle',
};

const ACCENTS: Record<ToastVariant, string> = {
  success: 'text-success',
  info: 'text-info',
  warning: 'text-warning',
  danger: 'text-danger',
};

/** Mounts a live region + stacked toasts. Call `useToast().toast(...)`. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ActiveToast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    ({ message, variant = 'info', duration = 4000 }: ToastOptions) => {
      const id = nextId.current++;
      setToasts((list) => [...list, { id, message, variant }]);
      if (duration > 0) window.setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );

  return (
    <Ctx.Provider value={{ toast }}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-5 right-5 z-[60] flex w-[340px] max-w-[calc(100vw-2.5rem)] flex-col gap-2.5"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-surface-card px-4 py-3 shadow-lg"
            style={{ animation: 'faiToast var(--duration-base) var(--ease-entrance)' }}
          >
            <span className={cn('mt-0.5 flex-none', ACCENTS[t.variant])}>
              <Icon name={ICONS[t.variant]} size={17} />
            </span>
            <span className="min-w-0 flex-1 font-ui text-[13.5px] text-text-primary">
              {t.message}
            </span>
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="grid h-6 w-6 flex-none place-items-center rounded text-text-tertiary hover:bg-surface-hover"
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
