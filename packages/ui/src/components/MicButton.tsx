import { forwardRef, useEffect, useState } from 'react';
import { cn } from '../utils/cn.js';
import { Icon } from './Icon.js';
import type { ButtonSize } from './Button.js';

export type MicButtonStatus = 'idle' | 'loading' | 'listening' | 'error';

export interface MicButtonProps
  extends Omit<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    // The toggle contract and the accessible name are the component's job —
    // a caller overriding onClick could leave the engine running with the
    // button showing `idle`.
    'onClick' | 'type' | 'aria-pressed' | 'aria-label' | 'children'
  > {
  status: MicButtonStatus;
  /** Start dictating — fired from `idle`, and from `error` as a retry. */
  onStart: () => void;
  /** Stop dictating — fired from `listening`. */
  onStop: () => void;
  /** Accessible name. Constant across states; `aria-pressed` carries the state. */
  label?: string;
  size?: ButtonSize;
}

const SIZES: Record<ButtonSize, { box: string; icon: number }> = {
  sm: { box: 'h-8 w-8', icon: 16 },
  md: { box: 'h-[42px] w-[42px]', icon: 18 },
  lg: { box: 'h-12 w-12', icon: 20 },
};

const STATES: Record<MicButtonStatus, { icon: string; className: string }> = {
  idle: {
    icon: 'mic',
    className: 'border-border-strong bg-surface-card text-text-secondary hover:bg-surface-hover',
  },
  loading: { icon: 'loader-circle', className: 'border-border-strong bg-surface-card text-text-tertiary' },
  // Stop glyph, not a mic: while recording the only thing a press does is end
  // it. Dark ink on green, never white — same contrast rule as Button/primary.
  listening: { icon: 'square', className: 'border-transparent bg-accent text-[#12321f]' },
  error: { icon: 'mic-off', className: 'border-danger bg-danger-soft text-danger-text' },
};

/**
 * What the live region says on each transition. `error` names the fallback
 * because dictation is only ever an enhancement — every field stays typeable.
 */
const ANNOUNCEMENTS: Record<MicButtonStatus, string> = {
  idle: 'Recording stopped.',
  loading: 'Starting the microphone.',
  listening: 'Recording. Speak your answer.',
  error: 'Dictation unavailable — type your answer instead.',
};

/**
 * Mic toggle for dictation. Presentational only: the caller owns the speech
 * engine and drives `status`, so the same control serves both per-field
 * dictation and whole-form Smart Fill.
 */
export const MicButton = forwardRef<HTMLButtonElement, MicButtonProps>(function MicButton(
  {
    status,
    onStart,
    onStop,
    label = 'Dictate answer',
    size = 'md',
    disabled,
    className,
    ...props
  },
  ref,
) {
  const s = SIZES[size];
  const state = STATES[status];
  const listening = status === 'listening';

  // `idle` only means "stopped" once something has actually been recorded;
  // without this the live region sits on the page saying a recording ended
  // that never began, which a screen-reader user can browse into.
  const [hasListened, setHasListened] = useState(false);
  useEffect(() => {
    if (listening) setHasListened(true);
  }, [listening]);

  return (
    // The wrapper exists so the live region is a sibling of the button: ARIA
    // treats a button's descendants as presentational, so a status node inside
    // it would never be announced.
    <span className="relative inline-flex">
      {listening && (
        // Continuous "still recording" cue. It rests as a plain visible ring
        // outside the button, so when the token layer's prefers-reduced-motion
        // rule collapses the animation to one near-instant iteration the ring
        // stays on screen rather than vanishing mid-pulse.
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -inset-1 animate-ping rounded-full border-2 border-accent"
        />
      )}
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-pressed={listening}
        disabled={disabled || status === 'loading'}
        onClick={listening ? onStop : onStart}
        className={cn(
          // `relative` keeps the button painted above the positioned ring.
          'relative inline-grid place-items-center rounded-full border',
          'transition-colors duration-fast ease-standard',
          'focus:outline-none focus-visible:shadow-focus',
          'active:translate-y-[0.5px] disabled:opacity-50 disabled:pointer-events-none',
          s.box,
          state.className,
          className,
        )}
        {...props}
      >
        <Icon
          name={state.icon}
          size={s.icon}
          className={cn(status === 'loading' && 'animate-spin')}
        />
      </button>
      <span role="status" className="sr-only">
        {status === 'idle' && !hasListened ? '' : ANNOUNCEMENTS[status]}
      </span>
    </span>
  );
});
