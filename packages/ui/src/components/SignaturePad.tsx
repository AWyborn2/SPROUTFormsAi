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
  /** Show the "Upload image" action beside Draw/Type. Off by default so fill
   * surfaces keep their exact current affordances; the profile's My-signature
   * card turns it on. */
  allowUpload?: boolean;
  'aria-label'?: string;
}

/**
 * Signature capture. Pointer/touch drawing on a canvas, a keyboard-accessible
 * "type your signature" fallback (rendered to the same canvas), and an opt-in
 * image upload that transcodes to the same PNG shape — so every path emits
 * exactly what the exporter can embed: `canvas.toDataURL('image/png')`.
 */
export function SignaturePad({
  value,
  onChange,
  width = 440,
  height = 150,
  className,
  allowUpload = false,
  'aria-label': ariaLabel = 'Signature',
}: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [typed, setTyped] = useState(false);
  const [typedName, setTypedName] = useState('');
  const [hasInk, setHasInk] = useState(!!value);
  const [uploadError, setUploadError] = useState<string | null>(null);
  /*
    Whether the canvas holds ink, tracked in a REF so `endStroke` reads it
    synchronously. `hasInk` is React state set inside the pointer-move handler,
    and a guard reading it back can see the pre-update value — a stroke ended in
    the same tick it began would emit nothing and the signature would look drawn
    but never reach the form. The ref is written the instant a line is drawn.
  */
  const ink = useRef(!!value);
  /*
    The last value THIS pad emitted, so the repaint effect below can tell its
    own echo (parent state flowing straight back down) from a genuinely
    external value — a saved signature arriving from an async session fetch, or
    an "apply saved signature" action writing into the field. Repainting on the
    echo would redraw mid-interaction for no reason; ignoring external values
    was the old bug (a value arriving after mount never appeared).
  */
  const lastEmitted = useRef<string | null>(null);

  const ctx = useCallback(() => canvasRef.current?.getContext('2d') ?? null, []);

  const emit = useCallback(
    (dataUrl: string) => {
      lastEmitted.current = dataUrl;
      onChange(dataUrl);
    },
    [onChange],
  );

  /** Draw an image into the canvas, contain-fit and centred, replacing all ink. */
  const paintImage = useCallback(
    (img: CanvasImageSource & { width?: number; height?: number }, flattenWhite: boolean) => {
      const c = canvasRef.current;
      const context = ctx();
      if (!c || !context) return;
      context.clearRect(0, 0, c.width, c.height);
      if (flattenWhite) {
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, c.width, c.height);
      }
      const iw = Number(img.width) || c.width;
      const ih = Number(img.height) || c.height;
      const scale = Math.min(c.width / iw, c.height / ih, 1);
      const w = iw * scale;
      const h = ih * scale;
      context.drawImage(img, (c.width - w) / 2, (c.height - h) / 2, w, h);
      ink.current = true;
      setHasInk(true);
    },
    [ctx],
  );

  /*
    Paint the incoming value whenever it changes from OUTSIDE — restored
    drafts, the saved-signature prefill landing after an async session fetch,
    or an apply action. Skips the pad's own echo, and never repaints under the
    pen mid-stroke.
  */
  useEffect(() => {
    const c = canvasRef.current;
    const context = ctx();
    if (!c || !context) return;
    context.lineWidth = 2.2;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = '#181b19';
    const v = value ?? '';
    if (v === lastEmitted.current) return;
    if (drawing.current) return;
    if (v) {
      const img = new Image();
      img.onload = () => paintImage(img, false);
      img.src = v;
      ink.current = true;
      setHasInk(true);
    } else {
      context.clearRect(0, 0, c.width, c.height);
      ink.current = false;
      setHasInk(false);
    }
    lastEmitted.current = v;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

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
    ink.current = true;
    if (!hasInk) setHasInk(true);
  }

  function endStroke() {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    const c = canvasRef.current;
    if (c && ink.current) emit(c.toDataURL('image/png'));
  }

  function clear() {
    const context = ctx();
    const c = canvasRef.current;
    if (context && c) context.clearRect(0, 0, c.width, c.height);
    ink.current = false;
    setHasInk(false);
    setTypedName('');
    setUploadError(null);
    emit('');
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
      ink.current = true;
      setHasInk(true);
      emit(c.toDataURL('image/png'));
    } else {
      ink.current = false;
      setHasInk(false);
      emit('');
    }
  }

  /*
    Upload path: the picked image is drawn contain-fit onto THIS canvas over a
    flattened white background, then emitted as the canvas's own PNG — so an
    uploaded 3MB photo leaves here as the same small `toDataURL('image/png')`
    string a drawn signature does, and the exporter's PNG-only contract holds
    without the server ever seeing the original file.
  */
  function onFilePicked(file: File | undefined) {
    setUploadError(null);
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setUploadError('That file is not an image. Choose a photo or scan of your signature.');
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const c = canvasRef.current;
      if (!c) return;
      setTyped(false);
      setTypedName('');
      paintImage(img, true);
      emit(c.toDataURL('image/png'));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setUploadError('That image could not be read. Try a PNG or JPEG.');
    };
    img.src = url;
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

      {uploadError && (
        <p role="alert" className="text-[13px] text-text-danger">
          {uploadError}
        </p>
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
        {allowUpload && (
          <>
            <span className="text-text-disabled">·</span>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="inline-flex items-center gap-1.5 font-semibold text-text-accent hover:underline"
            >
              <Icon name="image-up" size={14} />
              Upload image
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              aria-label="Upload signature image"
              className="hidden"
              onChange={(e) => {
                onFilePicked(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </>
        )}
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
