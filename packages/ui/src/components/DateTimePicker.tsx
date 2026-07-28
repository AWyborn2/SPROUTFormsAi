import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '../utils/cn.js';
import { Icon } from './Icon.js';

export interface DateTimePickerProps {
  /** ISO date `yyyy-mm-dd`, or `yyyy-mm-ddThh:mm` when `withTime`. */
  value?: string;
  onChange: (value: string) => void;
  withTime?: boolean;
  label?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
}

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Parse the date portion of the value into y/m/d numbers, or null. */
function parseDate(value?: string): { y: number; m: number; d: number } | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]) - 1, d: Number(m[3]) };
}

function daysInMonth(y: number, m: number): number {
  return new Date(y, m + 1, 0).getDate();
}

/** 0=Mon … 6=Sun offset of the first of the month. */
function firstWeekday(y: number, m: number): number {
  return (new Date(y, m, 1).getDay() + 6) % 7;
}

function formatDisplay(value: string | undefined, withTime: boolean): string {
  const d = parseDate(value);
  if (!d) return '';
  const base = `${d.d} ${MONTHS[d.m]!.slice(0, 3)} ${d.y}`;
  if (withTime) {
    const t = value!.match(/T(\d{2}):(\d{2})/);
    if (t) return `${base} · ${t[1]}:${t[2]}`;
  }
  return base;
}

/**
 * Accessible date (and optional time) picker. The trigger opens a popover
 * calendar grid navigable with arrow keys (Left/Right ±1 day, Up/Down ±1 week,
 * Home/End week bounds, PageUp/PageDown ±1 month), Enter selects, Escape closes.
 */
export function DateTimePicker({
  value,
  onChange,
  withTime,
  label,
  required,
  disabled,
  className,
}: DateTimePickerProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  /**
   * Whether the popover renders above the trigger instead of below. Decided
   * once per open from the trigger's viewport position: a picker near the
   * bottom of the screen (the conversational fill card, a short mobile
   * viewport) otherwise draws its calendar past the bottom edge, where it is
   * clipped and half the month cannot be tapped.
   */
  const [openUp, setOpenUp] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  /** Popover height budget: calendar ≈340px (376 with the time row) + margin. */
  const popoverBudget = withTime ? 392 : 356;

  function toggleOpen() {
    setOpen((wasOpen) => {
      if (!wasOpen && wrapRef.current) {
        const rect = wrapRef.current.getBoundingClientRect();
        const below = window.innerHeight - rect.bottom;
        // Flip only when below genuinely lacks room AND above has more of it —
        // when neither side fits, below at least clips the far rows, not the
        // month controls.
        setOpenUp(below < popoverBudget && rect.top > below);
      }
      return !wasOpen;
    });
  }

  const parsed = parseDate(value);
  // The REAL today, captured once per mount so a session crossing midnight
  // keeps a stable anchor. This was a hardcoded 2026-07-15 "deterministic
  // anchor" — which meant the today-highlight (and the month an empty picker
  // opened on) was wrong on every day except that one, drifting further wrong
  // forever after.
  const [today] = useState(() => {
    const now = new Date();
    return { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() };
  });
  const [view, setView] = useState<{ y: number; m: number }>(() =>
    parsed ? { y: parsed.y, m: parsed.m } : { y: today.y, m: today.m },
  );
  const [focusDay, setFocusDay] = useState<number>(parsed?.d ?? today.d);

  // Month/year jump lists. A date of birth is decades back and a licence
  // expiry years forward; the chevrons alone made both a click-per-month
  // slog. The year list absorbs an out-of-range `view.y` (reachable by
  // chevron) so the select never shows a value it has no option for.
  const yearFloor = Math.min(1900, view.y);
  const yearCeil = Math.max(today.y + 30, view.y);
  const years: number[] = [];
  for (let y = yearFloor; y <= yearCeil; y++) years.push(y);

  const time = withTime ? (value?.match(/T(\d{2}:\d{2})/)?.[1] ?? '09:00') : undefined;

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  useEffect(() => {
    if (open) {
      // Focus the active day button once the grid renders.
      requestAnimationFrame(() => {
        gridRef.current
          ?.querySelector<HTMLButtonElement>(`[data-day="${focusDay}"]`)
          ?.focus();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function commit(day: number, t = time) {
    const datePart = `${view.y}-${pad(view.m + 1)}-${pad(day)}`;
    onChange(withTime ? `${datePart}T${t}` : datePart);
  }

  function shiftMonth(delta: number) {
    setView((v) => {
      const total = v.y * 12 + v.m + delta;
      return { y: Math.floor(total / 12), m: ((total % 12) + 12) % 12 };
    });
  }

  /**
   * Jump straight to a month/year from the header selects. Unlike the ±1
   * chevrons, a jump can land in a shorter month, so the focused day clamps —
   * otherwise a focus on the 31st jumping to June leaves the roving tabindex
   * pointing at a day button that does not exist.
   */
  function jumpTo(y: number, m: number) {
    setView({ y, m });
    setFocusDay((d) => Math.min(d, daysInMonth(y, m)));
  }

  function moveFocus(delta: number) {
    const total = daysInMonth(view.y, view.m);
    let next = focusDay + delta;
    if (next < 1) {
      shiftMonth(-1);
      const prevTotal = daysInMonth(view.m === 0 ? view.y - 1 : view.y, (view.m + 11) % 12);
      next = prevTotal + next;
    } else if (next > total) {
      shiftMonth(1);
      next = next - total;
    }
    setFocusDay(next);
    requestAnimationFrame(() => {
      gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${next}"]`)?.focus();
    });
  }

  function onGridKey(e: React.KeyboardEvent) {
    switch (e.key) {
      case 'ArrowLeft': e.preventDefault(); moveFocus(-1); break;
      case 'ArrowRight': e.preventDefault(); moveFocus(1); break;
      case 'ArrowUp': e.preventDefault(); moveFocus(-7); break;
      case 'ArrowDown': e.preventDefault(); moveFocus(7); break;
      case 'Home': e.preventDefault(); moveFocus(-((focusDay - 1) % 7)); break;
      case 'End': e.preventDefault(); moveFocus(6 - ((focusDay - 1) % 7)); break;
      case 'PageUp': e.preventDefault(); shiftMonth(-1); break;
      case 'PageDown': e.preventDefault(); shiftMonth(1); break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        commit(focusDay);
        setOpen(false);
        break;
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        break;
    }
  }

  const lead = firstWeekday(view.y, view.m);
  const total = daysInMonth(view.y, view.m);
  const cells: Array<number | null> = [
    ...Array<null>(lead).fill(null),
    ...Array.from({ length: total }, (_, i) => i + 1),
  ];

  return (
    <div className={cn('flex flex-col gap-1.5', className)} ref={wrapRef}>
      {label && (
        <label htmlFor={id} className="font-ui text-sm font-semibold text-text-primary">
          {label}
          {required && <span className="ml-0.5 text-danger">*</span>}
        </label>
      )}
      <div className="relative">
        <button
          id={id}
          type="button"
          disabled={disabled}
          onClick={toggleOpen}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={cn(
            'flex h-[42px] w-full items-center gap-2.5 rounded-md border border-border-strong bg-surface-card px-3 text-left font-body text-sm',
            'focus:outline-none focus-visible:border-border-accent focus-visible:shadow-focus disabled:opacity-60',
          )}
        >
          <Icon name="calendar" size={16} className="flex-none text-text-tertiary" />
          <span className={cn('flex-1', value ? 'text-text-primary' : 'text-text-tertiary')}>
            {formatDisplay(value, !!withTime) || 'Select a date'}
          </span>
        </button>

        {open && (
          <div
            role="dialog"
            aria-label="Choose date"
            className={cn(
              'absolute left-0 z-40 w-[280px] rounded-lg border border-border bg-surface-card p-3 shadow-lg',
              openUp ? 'bottom-[calc(100%+6px)]' : 'top-[calc(100%+6px)]',
            )}
            style={{ animation: 'faiPop var(--duration-fast) var(--ease-entrance)' }}
          >
            <div className="mb-2 flex items-center justify-between">
              <button
                type="button"
                onClick={() => shiftMonth(-1)}
                aria-label="Previous month"
                className="grid h-7 w-7 place-items-center rounded-md text-text-secondary hover:bg-surface-hover"
              >
                <Icon name="chevron-left" size={16} />
              </button>
              {/* Selects, not a static caption: a DOB is decades back and a
                  licence expiry years forward — month-at-a-time chevrons made
                  those hundreds of clicks. */}
              <div className="flex items-center gap-1">
                <select
                  value={view.m}
                  onChange={(e) => jumpTo(view.y, Number(e.target.value))}
                  aria-label="Month"
                  className="h-7 cursor-pointer rounded-md border border-border-strong bg-surface-card px-1.5 font-ui text-[13px] font-semibold text-text-primary focus:outline-none focus-visible:border-border-accent focus-visible:shadow-focus"
                >
                  {MONTHS.map((mo, i) => (
                    <option key={mo} value={i}>
                      {mo.slice(0, 3)}
                    </option>
                  ))}
                </select>
                <select
                  value={view.y}
                  onChange={(e) => jumpTo(Number(e.target.value), view.m)}
                  aria-label="Year"
                  className="h-7 cursor-pointer rounded-md border border-border-strong bg-surface-card px-1.5 font-ui text-[13px] font-semibold text-text-primary focus:outline-none focus-visible:border-border-accent focus-visible:shadow-focus"
                >
                  {years.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={() => shiftMonth(1)}
                aria-label="Next month"
                className="grid h-7 w-7 place-items-center rounded-md text-text-secondary hover:bg-surface-hover"
              >
                <Icon name="chevron-right" size={16} />
              </button>
            </div>
            <div className="mb-1 grid grid-cols-7 gap-0.5">
              {WEEKDAYS.map((w) => (
                <span
                  key={w}
                  className="grid h-7 place-items-center font-mono text-[11px] text-text-tertiary"
                >
                  {w}
                </span>
              ))}
            </div>
            <div ref={gridRef} className="grid grid-cols-7 gap-0.5" onKeyDown={onGridKey}>
              {cells.map((day, i) => {
                if (day === null) return <span key={`e${i}`} />;
                const selected =
                  parsed && parsed.y === view.y && parsed.m === view.m && parsed.d === day;
                const isToday = view.y === today.y && view.m === today.m && day === today.d;
                return (
                  <button
                    key={day}
                    type="button"
                    data-day={day}
                    tabIndex={day === focusDay ? 0 : -1}
                    onClick={() => {
                      setFocusDay(day);
                      commit(day);
                      if (!withTime) setOpen(false);
                    }}
                    className={cn(
                      'grid h-8 w-full place-items-center rounded-md text-[13px] transition-colors',
                      selected
                        ? 'bg-accent font-semibold text-[#12321f]'
                        : 'text-text-primary hover:bg-surface-hover',
                      !selected && isToday && 'font-semibold text-text-accent',
                    )}
                  >
                    {day}
                  </button>
                );
              })}
            </div>
            {withTime && (
              <div className="mt-2 flex items-center gap-2 border-t border-border-subtle pt-2">
                <Icon name="clock" size={15} className="text-text-tertiary" />
                <input
                  type="time"
                  value={time}
                  onChange={(e) => commit(parsed?.d ?? focusDay, e.target.value)}
                  aria-label="Time"
                  className="h-8 flex-1 rounded-md border border-border-strong bg-surface-card px-2 text-[13px] focus:outline-none focus-visible:border-border-accent focus-visible:shadow-focus"
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
