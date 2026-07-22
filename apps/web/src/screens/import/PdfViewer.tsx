import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import { Icon } from '@formai/ui';
import type { ExtractedField, ExtractionStatus, PageBox } from '@formai/shared';
import type { PositionedText, TextPage } from '../../lib/pdf-geometry.js';
import { snapEdge } from './inspector/geometry-actions.js';
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
  onBandEdge?: (key: string, edge: 'start' | 'end', value: number) => void;
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
  onBandEdge?: (key: string, edge: 'start' | 'end', value: number) => void;
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
   * every move goes through `adjustGeometryBand`, so the shipped validator
   * refuses an inverting or overlapping drag exactly as it refuses a step.
   */
  const startDrag = (key: string, edge: 'start' | 'end') => (e: React.PointerEvent) => {
    if (!onBandEdge) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent) => {
      const rect = surface.current?.getBoundingClientRect();
      if (!rect) return;
      onBandEdge(key, edge, snapEdge((ev.clientX - rect.left) / scaleX, snapTargets));
    };
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  };

  const top = pageHeight - (segment.y + segment.height) * scaleY;
  const height = segment.height * scaleY;
  const left = segment.x * scaleX;
  const width = segment.width * scaleX;

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
        (segment.columnBands ?? []).flatMap((band) =>
          (['start', 'end'] as const).map((edge) => (
            <div
              key={`h-${band.key}-${edge}`}
              role="slider"
              tabIndex={-1}
              aria-label={`Drag ${band.key} ${edge} edge`}
              aria-valuenow={Math.round(band[edge])}
              onPointerDown={startDrag(band.key, edge)}
              className="pointer-events-auto absolute cursor-ew-resize"
              // Wider than the line it moves: a 1px hit target is unusable, and
              // the drag does not need to be precise — the snap is.
              style={{ left: band[edge] * scaleX - 5, top, width: 10, height }}
            />
          )),
        )}
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
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
