import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../utils/cn.js';
import { Icon } from './Icon.js';

export interface SignaturePadProps {
  /** Current value: a PNG data URL, or '' when empty. */
  value?: string;
  onChange: (dataUrl: string) => void;
  width?: number;
  height?: number;
  className?: string;
  'aria-label'?: string;
}

/**
 * Signature capture. Pointer/touch drawing on a canvas, plus a
 * keyboard-accessible "type your signature" fallback (rendered to the same
 * canvas) so the field is completable without a pointing device. Emits a PNG
 * data URL on change.
 */
export function SignaturePad({
  value,
  onChange,
  width = 440,
  height = 150,
  className,
  'aria-label': ariaLabel = 'Signature',
}: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [typed, setTyped] = useState(false);
  const [typedName, setTypedName] = useState('');
  const [hasInk, setHasInk] = useState(!!value);

  const ctx = useCallback(() => canvasRef.current?.getContext('2d') ?? null, []);

  // Paint an incoming value (e.g. restored draft) onto the canvas once.
  useEffect(() => {
    const c = canvasRef.current;
    const context = ctx();
    if (!c || !context) return;
    context.lineWidth = 2.2;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = '#181b19';
    if (value && !hasInk) {
      const img = new Image();
      img.onload = () => context.drawImage(img, 0, 0);
      img.src = value;
      setHasInk(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pointFromEvent(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * width,
      y: ((e.clientY - rect.top) / rect.height) * height,
    };
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (typed) return;
    e.preventDefault();
    canvasRef.current?.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = pointFromEvent(e);
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || typed) return;
    const context = ctx();
    if (!context || !last.current) return;
    const p = pointFromEvent(e);
    context.beginPath();
    context.moveTo(last.current.x, last.current.y);
    context.lineTo(p.x, p.y);
    context.stroke();
    last.current = p;
    if (!hasInk) setHasInk(true);
  }

  function endStroke() {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    const c = canvasRef.current;
    if (c && hasInk) onChange(c.toDataURL('image/png'));
  }

  function clear() {
    const context = ctx();
    const c = canvasRef.current;
    if (context && c) context.clearRect(0, 0, c.width, c.height);
    setHasInk(false);
    setTypedName('');
    onChange('');
  }

  function renderTyped(name: string) {
    const context = ctx();
    const c = canvasRef.current;
    if (!context || !c) return;
    context.clearRect(0, 0, c.width, c.height);
    if (name.trim()) {
      context.fillStyle = '#181b19';
      context.font = "34px 'Spectral', Georgia, serif";
      context.textBaseline = 'middle';
      context.fillText(name, 16, height / 2);
      setHasInk(true);
      onChange(c.toDataURL('image/png'));
    } else {
      setHasInk(false);
      onChange('');
    }
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="relative overflow-hidden rounded-lg border border-border-strong bg-surface-card">
        <canvas
          ref={canvasRef}
          width={width}
          height={height}
          role="img"
          aria-label={ariaLabel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endStroke}
          onPointerLeave={endStroke}
          className={cn('block h-[150px] w-full touch-none', typed && 'pointer-events-none')}
          style={{ aspectRatio: `${width} / ${height}` }}
        />
        {!hasInk && !typed && (
          <span className="pointer-events-none absolute inset-0 grid place-items-center text-[13px] text-text-tertiary">
            Draw your signature here
          </span>
        )}
      </div>

      {typed && (
        <input
          type="text"
          value={typedName}
          autoFocus
          onChange={(e) => {
            setTypedName(e.target.value);
            renderTyped(e.target.value);
          }}
          placeholder="Type your full name"
          aria-label="Type your signature"
          className="h-[42px] w-full rounded-md border border-border-strong bg-surface-card px-3 font-body text-sm text-text-primary focus:outline-none focus-visible:border-border-accent focus-visible:shadow-focus"
        />
      )}

      <div className="flex items-center gap-3 text-[13px]">
        <button
          type="button"
          onClick={() => {
            setTyped((t) => !t);
            clear();
          }}
          className="inline-flex items-center gap-1.5 font-semibold text-text-accent hover:underline"
        >
          <Icon name={typed ? 'pen-line' : 'keyboard'} size={14} />
          {typed ? 'Draw instead' : 'Type instead'}
        </button>
        <span className="text-text-disabled">·</span>
        <button
          type="button"
          onClick={clear}
          className="inline-flex items-center gap-1.5 text-text-tertiary hover:text-text-secondary"
        >
          <Icon name="eraser" size={14} />
          Clear
        </button>
      </div>
    </div>
  );
}
