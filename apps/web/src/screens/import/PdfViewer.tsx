import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import { Icon } from '@formai/ui';
import type { ExtractedField, ExtractionStatus, PageBox } from '@formai/shared';
import type { PositionedText, TextPage } from '../../lib/pdf-geometry.js';
import {
  columnHandles,
  nudgedEdge,
  previewMarks,
  snapDrawnBox,
  snapEdge,
  snapTargets,
  snapTargetsY,
  type BandHandle,
} from './inspector/geometry-actions.js';
import {
  anchoredScrollOffset,
  clampZoom,
  fitWidthZoom,
  formatZoomPercent,
  stepZoom,
} from '../../lib/pdf-zoom.js';

// Vite resolves the worker asset to a served URL.
import workerSrc from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

/**
 * Pages are rasterised once at this scale and then CSS-scaled to the current
 * zoom, so zooming never re-renders through pdfjs. 2x keeps text crisp up to
 * ~200% zoom; beyond that upscaling softens slightly, which is acceptable for
 * a verification preview.
 */
const RENDER_SCALE = 2;

/** Horizontal breathing room inside the scroll viewport, in CSS px per side. */
const VIEWPORT_PADDING = 12;

/** Pointer travel (px) beyond which a press is a pan, not a click. */
const DRAG_THRESHOLD = 4;

interface PageRender {
  dataUrl: string;
  /** Page size at pdfjs scale 1, i.e. PDF units — the same space as sourcePosition. */
  naturalWidth: number;
  naturalHeight: number;
}

interface FieldHighlight {
  id: string;
  position: NonNullable<ExtractedField['sourcePosition']>;
  status: ExtractionStatus;
}

interface PdfViewerProps {
  pdfBase64?: string;
  assetId?: string | null;
  highlights?: FieldHighlight[];
  selectedFieldId?: string | null;
  onSelectField?: (id: string) => void;
  /** Positioned text per page, once the document has loaded. */
  onTextLayer?: (pages: TextPage[]) => void;
  /** A proposed grid to draw over the page, for the selected field. */
  bandOverlay?: PageBox | null;
  /**
   * Printed edges on the overlay's page that a dragged band edge may snap to
   * (U10). Supplied by the screen, which already holds the text layer.
   */
  bandSnapTargets?: readonly number[];
  /** A band edge was dragged to `value` (PDF points). Omit to draw read-only. */
  onBandEdge?: (handle: BandHandle, value: number) => void;
  /**
   * Whether draw mode is armed (U1/KTD5). While armed, a pointer-down + drag on
   * a page rubber-bands a rectangle instead of panning; on release the two
   * corners are snapped to the text layer and reported via `onDrawBox`.
   */
  drawArmed?: boolean;
  /** A hand-drawn, snapped, page-clamped placement box for the selected field. */
  onDrawBox?: (box: PageBox) => void;
  className?: string;
}

const CONF = {
  ok: { color: 'var(--success)', bg: 'var(--success-soft)' },
  review: { color: 'var(--warning)', bg: 'var(--warning-soft)' },
  low: { color: 'var(--danger)', bg: 'var(--danger-soft)' },
} as const;

/**
 * The proposed grid, drawn over the page so a reviewer can see whether the
 * bands sit on the printed rules before confirming them.
 *
 * Deliberately drawn as lines rather than filled cells: the reviewer is
 * checking alignment against printed rules a millimetre wide, and a translucent
 * fill over the whole cell hides exactly the edge they need to judge.
 */
function BandGrid({
  segment,
  pageWidth,
  pageHeight,
  snapTargets = [],
  onBandEdge,
}: {
  segment: PageBox;
  pageWidth: number;
  pageHeight: number;
  /** Printed edges this page offers a dragged band edge (U10). */
  snapTargets?: readonly number[];
  onBandEdge?: (handle: BandHandle, value: number) => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const scaleX = pageWidth / segment.pageWidth;
  const scaleY = pageHeight / segment.pageHeight;

  /**
   * Drag a column edge, snapped to the printed page.
   *
   * The pointer only has to choose WHICH printed thing the edge belongs to —
   * `snapEdge` supplies the coordinate from the text layer — so a 7-13pt
   * column is reachable despite the preview being scaled (KTD12). Pointer
   * capture keeps the drag alive when the cursor leaves the page image, and
   * every move goes through the session's validated adjustment, so the shipped
   * validator refuses an inverting or overlapping drag exactly as it refuses a
   * step.
   */
  const startDrag = (handle: BandHandle) => (e: React.PointerEvent) => {
    if (!onBandEdge) return;
    e.preventDefault();
    e.stopPropagation();
    const grip = e.currentTarget as HTMLElement;
    grip.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent) => {
      const rect = surface.current?.getBoundingClientRect();
      if (!rect) return;
      onBandEdge(handle, snapEdge((ev.clientX - rect.left) / scaleX, snapTargets));
    };
    const stop = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', stop);
      grip.removeEventListener('pointercancel', stop);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', stop);
    grip.addEventListener('pointercancel', stop);
  };

  /**
   * Nudge a focused edge with the arrow keys (U1, R1).
   *
   * Left/Right move the edge by `NUDGE_POINTS` through the very same
   * `onBandEdge` path a drag or a stepper button uses — so re-snapping,
   * inversion/overlap refusal and un-confirm-on-edit all behave identically to a
   * button nudge, and there is no second movement or validation path to keep in
   * step.
   */
  const nudge = (handle: BandHandle) => (e: React.KeyboardEvent) => {
    if (!onBandEdge) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    onBandEdge(handle, nudgedEdge(handle, e.key === 'ArrowRight' ? 1 : -1));
  };

  const top = pageHeight - (segment.y + segment.height) * scaleY;
  const height = segment.height * scaleY;
  const left = segment.x * scaleX;
  const width = segment.width * scaleX;

  // A representative mark in every target cell, at the SAME placement the
  // exporter draws with (U3). Empty when the grid has no rows or no columns, so
  // this renders nothing rather than guessing. Display-only and never a recorded
  // answer — see the guide styling and caption below (R4/R6).
  const marks = previewMarks(segment);

  return (
    <div ref={surface} aria-hidden className="pointer-events-none absolute inset-0">
      <div
        className="absolute rounded-[2px]"
        style={{
          left,
          top,
          width,
          height,
          border: '1px dashed var(--accent)',
          backgroundColor: 'color-mix(in srgb, var(--accent) 6%, transparent)',
        }}
      />
      {(segment.columnBands ?? []).map((band) => (
        <div
          key={`c-${band.key}`}
          className="absolute"
          style={{
            left: band.start * scaleX,
            top,
            width: Math.max(1, (band.end - band.start) * scaleX),
            height,
            borderLeft: '1px solid var(--accent)',
            borderRight: '1px solid var(--accent)',
          }}
        />
      ))}
      {onBandEdge &&
        columnHandles(segment.columnBands ?? []).map((h) => (
          <div
            key={h.key}
            role="slider"
            // Tab-reachable so the edge can be nudged with the arrow keys, not
            // just dragged (U1). role="slider" makes Left/Right the expected
            // interaction for assistive tech.
            tabIndex={0}
            aria-label={h.label}
            aria-valuenow={Math.round(h.at)}
            onPointerDown={startDrag(h)}
            onKeyDown={nudge(h)}
            className="pointer-events-auto absolute cursor-ew-resize rounded-[1px] outline-none focus-visible:bg-accent/25 focus-visible:ring-2 focus-visible:ring-accent"
            // Wider than the line it moves: a 1px hit target is unusable, and
            // the drag does not need to be precise — the snap is.
            style={{ left: h.at * scaleX - 5, top, width: 10, height }}
          />
        ))}
      {(segment.rowBands ?? []).map((band) => (
        <div
          key={`r-${band.key}`}
          className="absolute"
          style={{
            left,
            top: pageHeight - band.end * scaleY,
            width,
            height: Math.max(1, (band.end - band.start) * scaleY),
            borderTop: '1px solid color-mix(in srgb, var(--accent) 55%, transparent)',
          }}
        />
      ))}

      {/*
        Live glyph preview (U3). One representative tick per target cell, drawn
        at the shared `markPlacement` position/size and scaled like the bands, so
        it tracks zoom and every band move for free. Deliberately a DASHED, muted
        stroke — distinct from the solid accent band RULES and reading as a
        placement guide, not a recorded answer (R4). `pointer-events: none` keeps
        it from ever intercepting a drag.
      */}
      {marks.map((m) => (
        <svg
          key={`p-${m.key}`}
          viewBox="0 0 10 10"
          width={Math.max(2, m.size * scaleX)}
          height={Math.max(2, m.size * scaleY)}
          className="pointer-events-none absolute overflow-visible"
          style={{
            left: m.x * scaleX,
            top: pageHeight - (m.y + m.size) * scaleY,
            color: 'var(--accent)',
            opacity: 0.6,
          }}
          aria-hidden
        >
          {/* Stroke width is in viewBox units, so it scales with the cell. */}
          <polyline
            points="1,5.5 4,8.5 9,1.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="2 1.4"
          />
        </svg>
      ))}

      {marks.length > 0 && (
        <div
          className="absolute whitespace-nowrap rounded-pill bg-surface/90 px-1.5 py-0.5 text-[9px] font-medium text-text-tertiary shadow-sm"
          style={{ left, top: Math.max(0, top - 15) }}
        >
          Preview — representative marks show where ticks will print
        </div>
      )}
    </div>
  );
}

/**
 * The armed draw surface: rubber-band a rectangle over one page and report a
 * snapped, page-clamped `PageBox` on release (U1, R1).
 *
 * It only mounts while draw mode is armed, so when it is absent the viewport's
 * pan/select gesture runs exactly as before (KTD5 — draw never fights pan). Its
 * pointer-down stops propagation, so the pan handler on the scroll viewport
 * never sees the press.
 *
 * Precision is NOT the pointer's job (the U10 lesson): the pointer places the
 * box roughly and `snapDrawnBox` pulls each edge onto the nearest text-layer
 * edge, using this page's own natural (PDF-point) size for the screen→points
 * conversion and the vertical flip. The live rectangle is drawn in screen px
 * straight from the pointer, so it tracks the cursor without any conversion.
 */
function DrawSurface({
  pageIndex,
  pageWidth,
  pageHeight,
  naturalWidth,
  naturalHeight,
  items,
  onDrawBox,
}: {
  pageIndex: number;
  /** Rendered page size in CSS px (tracks zoom). */
  pageWidth: number;
  pageHeight: number;
  /** Page size in PDF points — the space geometry is stored in. */
  naturalWidth: number;
  naturalHeight: number;
  /** This page's positioned text, for edge snapping. */
  items: readonly PositionedText[];
  onDrawBox?: (box: PageBox) => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  // The live rectangle in CSS px, or null when not dragging.
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const scaleX = pageWidth / naturalWidth;
  const scaleY = pageHeight / naturalHeight;
  // Screen px (top-left origin) → PDF points (bottom-left origin, y flipped).
  const toPoints = (sx: number, sy: number) => ({ x: sx / scaleX, y: naturalHeight - sy / scaleY });

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // Keep the scroll-viewport pan gesture from also firing (KTD5).
    e.stopPropagation();
    const el = surface.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    const bounds = el.getBoundingClientRect();
    const start = { x: e.clientX - bounds.left, y: e.clientY - bounds.top };
    setRect({ x: start.x, y: start.y, w: 0, h: 0 });

    const move = (ev: PointerEvent) => {
      const cx = ev.clientX - bounds.left;
      const cy = ev.clientY - bounds.top;
      setRect({ x: Math.min(start.x, cx), y: Math.min(start.y, cy), w: Math.abs(cx - start.x), h: Math.abs(cy - start.y) });
    };
    const finish = (ev: PointerEvent, commit: boolean) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      setRect(null);
      if (!commit || !onDrawBox) return;
      const endX = ev.clientX - bounds.left;
      const endY = ev.clientY - bounds.top;
      // A press that barely moved is a mis-click, not a box — ignore it rather
      // than emit a degenerate rectangle.
      if (Math.hypot(endX - start.x, endY - start.y) < DRAG_THRESHOLD) return;
      const box = snapDrawnBox(
        toPoints(start.x, start.y),
        toPoints(endX, endY),
        { page: pageIndex, pageWidth: naturalWidth, pageHeight: naturalHeight },
        snapTargets(items),
        snapTargetsY(items),
      );
      onDrawBox(box);
    };
    const up = (ev: PointerEvent) => finish(ev, true);
    const cancel = (ev: PointerEvent) => finish(ev, false);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
  };

  return (
    <div
      ref={surface}
      onPointerDown={onPointerDown}
      className="absolute inset-0 z-10 cursor-crosshair"
      // A faint tint marks the page as armed, so it is obvious a drag will draw
      // rather than pan.
      style={{ backgroundColor: 'color-mix(in srgb, var(--accent) 4%, transparent)' }}
    >
      {rect && (
        <div
          className="absolute rounded-[2px]"
          style={{
            left: rect.x,
            top: rect.y,
            width: rect.w,
            height: rect.h,
            border: '1.5px dashed var(--accent)',
            backgroundColor: 'color-mix(in srgb, var(--accent) 12%, transparent)',
          }}
        />
      )}
    </div>
  );
}

export function PdfViewer({
  pdfBase64,
  assetId,
  highlights = [],
  selectedFieldId,
  onSelectField,
  onTextLayer,
  bandOverlay,
  bandSnapTargets,
  onBandEdge,
  drawArmed = false,
  onDrawBox,
  className = '',
}: PdfViewerProps) {
  const [pages, setPages] = useState<PageRender[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 'fit' tracks the container width; a number is an explicit user zoom.
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [containerWidth, setContainerWidth] = useState(0);

  const viewportRef = useRef<HTMLDivElement>(null);
  // Cursor anchor for the next zoom change, applied in a layout effect so the
  // point under the cursor (or viewport centre) stays put while scaling.
  const anchorRef = useRef<{ x: number; y: number; prevZoom: number } | null>(null);
  const didDragRef = useRef(false);
  // The loaded text layer, kept so the draw gesture can snap a released
  // rectangle to the printed edges of whichever page it was drawn on (U1).
  const textPagesRef = useRef<TextPage[]>([]);

  const widestPage = pages.reduce((w, p) => Math.max(w, p.naturalWidth), 0);
  const fit = fitWidthZoom(containerWidth - VIEWPORT_PADDING * 2, widestPage);
  const effectiveZoom = zoom === 'fit' ? fit : zoom;

  const loadPdf = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let source: Uint8Array;
      if (pdfBase64) {
        const binary = atob(pdfBase64);
        source = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) source[i] = binary.charCodeAt(i);
      } else if (assetId && assetId.trim().length > 0) {
        const res = await fetch(`/api/pdf/asset/${assetId}`, { credentials: 'include' });
        if (!res.ok) throw new Error(`Failed to load PDF (${res.status})`);
        source = new Uint8Array(await res.arrayBuffer());
      } else {
        throw new Error('No PDF source provided');
      }

      const pdf = await pdfjs.getDocument({ data: source }).promise;
      const rendered: PageRender[] = [];
      const textPages: TextPage[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const natural = page.getViewport({ scale: 1 });

        // The text layer, adapted here into the band-derivation module's own
        // input shape. Doing the adapting in the viewer is what keeps pdfjs out
        // of that module, so it stays a pure function over positioned text —
        // testable against measured fixtures with no PDF, no worker and no DOM.
        // `transform[4]`/`[5]` are the run's x and BASELINE y in PDF points,
        // which is already the space geometry is stored in.
        const content = await page.getTextContent();
        textPages.push({
          items: content.items
            .map((item) => ('str' in item ? item : null))
            .filter((item): item is Exclude<typeof item, null> => item !== null && Boolean(item.str.trim()))
            .map((item) => ({
              text: item.str.trim(),
              x: item.transform[4] as number,
              y: item.transform[5] as number,
              width: item.width,
            })),
          // This page's own size, not the document's first — derivation places
          // bands inside a segment box measured against THIS page.
          width: natural.width,
          height: natural.height,
        });

        const viewport = page.getViewport({ scale: RENDER_SCALE });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d')!;
        await page.render({ canvas, viewport }).promise;
        rendered.push({
          dataUrl: canvas.toDataURL('image/png'),
          naturalWidth: natural.width,
          naturalHeight: natural.height,
        });
      }
      setPages(rendered);
      textPagesRef.current = textPages;
      onTextLayer?.(textPages);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to render PDF');
    } finally {
      setLoading(false);
    }
  }, [pdfBase64, assetId]);

  useEffect(() => {
    loadPdf();
  }, [loadPdf]);

  // Track viewport width so fit-to-width follows the layout.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [pages.length]);

  const applyZoom = useCallback(
    (next: number | 'fit', anchor?: { x: number; y: number }) => {
      const el = viewportRef.current;
      if (el) {
        anchorRef.current = {
          x: anchor?.x ?? el.clientWidth / 2,
          y: anchor?.y ?? el.clientHeight / 2,
          prevZoom: effectiveZoom,
        };
      }
      setZoom(next);
    },
    [effectiveZoom],
  );

  // Keep the anchored point stationary once the new zoom has laid out.
  useLayoutEffect(() => {
    const el = viewportRef.current;
    const anchor = anchorRef.current;
    if (!el || !anchor || anchor.prevZoom <= 0) return;
    anchorRef.current = null;
    const ratio = effectiveZoom / anchor.prevZoom;
    if (ratio === 1) return;
    el.scrollLeft = anchoredScrollOffset(el.scrollLeft, anchor.x, ratio);
    el.scrollTop = anchoredScrollOffset(el.scrollTop, anchor.y, ratio);
  }, [effectiveZoom]);

  // Ctrl/Cmd + wheel zooms about the cursor. Native listener because React's
  // wheel handler can't reliably preventDefault (passive on some roots).
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el!.getBoundingClientRect();
      applyZoom(stepZoom(effectiveZoom, e.deltaY < 0 ? 1 : -1), {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [applyZoom, effectiveZoom]);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!e.ctrlKey && !e.metaKey) return; // plain arrows keep native scroll
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      applyZoom(stepZoom(effectiveZoom, 1));
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      applyZoom(stepZoom(effectiveZoom, -1));
    } else if (e.key === '0') {
      e.preventDefault();
      applyZoom('fit');
    }
  }

  // Drag-to-pan. Highlight clicks still work: a press that travels less than
  // DRAG_THRESHOLD is treated as a click and never suppressed.
  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const el = viewportRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    didDragRef.current = false;
    const start = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };

    function onMove(ev: PointerEvent) {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!didDragRef.current && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      didDragRef.current = true;
      el!.scrollLeft = start.left - dx;
      el!.scrollTop = start.top - dy;
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      // Let the click that follows this pointerup see the drag flag, then reset.
      setTimeout(() => {
        didDragRef.current = false;
      }, 0);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  if (loading) {
    return (
      <div className={`flex flex-col items-center justify-center gap-3 py-12 ${className}`}>
        <span
          className="h-8 w-8 rounded-full border-[3px] border-border border-r-accent"
          style={{ animation: 'faiSpin .7s linear infinite' }}
        />
        <span className="text-[13px] text-text-secondary">Loading PDF…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`rounded-md border border-danger/30 bg-danger-soft p-4 text-[13px] text-danger-text ${className}`}>
        {error}
      </div>
    );
  }

  if (pages.length === 0) return null;

  const displayedWidth = Math.max(1, Math.round(widestPage * effectiveZoom));

  return (
    <div className={`flex min-h-0 flex-col ${className}`}>
      {/* Zoom toolbar */}
      <div className="mb-2 flex flex-none items-center justify-end gap-1">
        <button
          type="button"
          aria-label="Zoom out"
          title="Zoom out (Ctrl -)"
          onClick={() => applyZoom(stepZoom(effectiveZoom, -1))}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
        >
          <Icon name="zoom-out" size={15} />
        </button>
        <button
          type="button"
          aria-label="Reset zoom to 100%"
          title="Actual size (100%)"
          onClick={() => applyZoom(clampZoom(1))}
          className="inline-flex h-7 min-w-[52px] items-center justify-center rounded-md border border-border px-1.5 font-ui text-[12px] tabular-nums text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
        >
          {formatZoomPercent(effectiveZoom)}
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          title="Zoom in (Ctrl +)"
          onClick={() => applyZoom(stepZoom(effectiveZoom, 1))}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
        >
          <Icon name="zoom-in" size={15} />
        </button>
        <button
          type="button"
          aria-label="Fit page to width"
          title="Fit to width (Ctrl 0)"
          onClick={() => applyZoom('fit')}
          className={`inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors ${
            zoom === 'fit'
              ? 'border-accent bg-surface-accent-soft text-accent'
              : 'border-border text-text-secondary hover:bg-surface-hover hover:text-text-primary'
          }`}
        >
          <Icon name="maximize" size={15} />
        </button>
      </div>

      {/* Scrollable page viewport. Focusable so arrow keys nudge-scroll. */}
      <div
        ref={viewportRef}
        tabIndex={0}
        role="region"
        aria-label="PDF preview. Arrow keys scroll, Ctrl plus and minus zoom, Ctrl 0 fits to width."
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        className="min-h-0 flex-1 cursor-grab overflow-auto rounded-md bg-surface-sunken outline-none focus-visible:ring-2 focus-visible:ring-accent/50 active:cursor-grabbing"
        style={{ padding: VIEWPORT_PADDING }}
      >
        <div className="mx-auto flex flex-col gap-4" style={{ width: displayedWidth }}>
          {pages.map((page, pageIndex) => {
            const pageWidth = Math.round(page.naturalWidth * effectiveZoom);
            const pageHeight = Math.round(page.naturalHeight * effectiveZoom);
            return (
              <div
                key={pageIndex}
                id={`pdf-page-${pageIndex}`}
                className="relative mx-auto"
                style={{ width: pageWidth, height: pageHeight }}
              >
                <img
                  src={page.dataUrl}
                  alt={`Page ${pageIndex + 1}`}
                  draggable={false}
                  className="select-none rounded-md border border-border shadow-sm"
                  style={{ width: pageWidth, height: pageHeight, display: 'block' }}
                />
                {highlights
                  .filter((h) => h.position.page === pageIndex)
                  .map((h) => {
                    const scaleX = pageWidth / h.position.pageWidth;
                    const scaleY = pageHeight / h.position.pageHeight;
                    const isSelected = h.id === selectedFieldId;
                    const left = h.position.x * scaleX;
                    const top = pageHeight - (h.position.y + h.position.height) * scaleY;
                    const width = h.position.width * scaleX;
                    const height = h.position.height * scaleY;
                    return (
                      <div
                        key={h.id}
                        className="absolute cursor-pointer rounded-[3px] transition-all"
                        style={{
                          left,
                          top: Math.max(0, top),
                          width: Math.max(2, width),
                          height: Math.max(2, height),
                          border: `2px solid ${CONF[h.status].color}`,
                          backgroundColor: CONF[h.status].bg,
                          opacity: isSelected ? 0.6 : 0.25,
                          boxShadow: isSelected
                            ? `0 0 0 3px ${CONF[h.status].color}`
                            : undefined,
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (didDragRef.current) return;
                          onSelectField?.(h.id);
                        }}
                        title={`${h.id}`}
                      />
                    );
                  })}
                {bandOverlay && bandOverlay.page === pageIndex && (
                  <BandGrid
                    segment={bandOverlay}
                    snapTargets={bandSnapTargets}
                    onBandEdge={onBandEdge}
                    pageWidth={pageWidth}
                    pageHeight={pageHeight}
                  />
                )}
                {/*
                  Draw surface last so, while armed, it sits above the band
                  overlay and captures the rubber-band gesture. Absent when
                  disarmed, leaving pan/select untouched (KTD5).
                */}
                {drawArmed && (
                  <DrawSurface
                    pageIndex={pageIndex}
                    pageWidth={pageWidth}
                    pageHeight={pageHeight}
                    naturalWidth={page.naturalWidth}
                    naturalHeight={page.naturalHeight}
                    items={textPagesRef.current[pageIndex]?.items ?? []}
                    onDrawBox={onDrawBox}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
