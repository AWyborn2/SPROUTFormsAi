/**
 * Zoom math for the PDF import preview. Pure functions so the viewer's
 * sizing behaviour is unit-testable without pdfjs or a DOM.
 */

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;
/** Multiplicative step applied per zoom-in/out action. */
export const ZOOM_STEP = 1.2;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

export function stepZoom(current: number, direction: 1 | -1): number {
  const next = direction === 1 ? current * ZOOM_STEP : current / ZOOM_STEP;
  return clampZoom(next);
}

/**
 * Zoom that makes a page of `pageWidth` natural units exactly fill
 * `containerWidth` CSS pixels. Falls back to 1 when either measurement
 * is missing (e.g. before the first layout pass).
 */
export function fitWidthZoom(containerWidth: number, pageWidth: number): number {
  if (!Number.isFinite(containerWidth) || !Number.isFinite(pageWidth)) return 1;
  if (containerWidth <= 0 || pageWidth <= 0) return 1;
  return clampZoom(containerWidth / pageWidth);
}

/**
 * New scroll offset that keeps the content point currently under
 * `anchorOffset` (distance from the viewport's scroll origin, in CSS px)
 * stationary when content scales by `zoomRatio` (new / old zoom).
 */
export function anchoredScrollOffset(
  scrollOffset: number,
  anchorOffset: number,
  zoomRatio: number,
): number {
  return Math.max(0, (scrollOffset + anchorOffset) * zoomRatio - anchorOffset);
}

export function formatZoomPercent(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}
