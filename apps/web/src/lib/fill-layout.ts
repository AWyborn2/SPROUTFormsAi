/**
 * Span resolution for fill-surface layout (KTD7): the 12-column grid built in
 * the builder (Full=12 / Half=6 / Third=4 / Quarter=3 via `FormField.colSpan`)
 * is the grid fillers see. Pure module — no React, no DOM (the @formai/shared
 * import happens to be type-only, but value imports work fine too).
 *
 * All three fill surfaces route through `resolveFillSpan`, but they collapse
 * to a single column differently because two of them are CONTAINERS where
 * viewport breakpoints would lie:
 * - Public fill (real viewport): `fillSpanClass` — always `col-span-12`, with
 *   the resolved span applied from `sm:` up.
 * - Mobile frame (390px container): pass `narrow: true`; everything resolves
 *   to 12.
 * - Builder preview (container-width slider): pass
 *   `narrow: state.container.maxWidth < 640` and use `previewSpanClass`.
 */
import type { FormField } from '@formai/shared';

/**
 * Resolve the grid span (out of 12) a field occupies on a fill surface.
 * Repeating tables and signatures are always full width (RepeatingGroup cells
 * have `min-w-[120px]` and overflow partial columns), as are section headers.
 * Narrow containers collapse everything to 12. Otherwise `colSpan` is honored
 * when it is an integer in [1..12]; anything else — absent, zero, negative,
 * too large, fractional — degrades to the safe full-width default of 12.
 */
export function resolveFillSpan(field: FormField, narrow: boolean): number {
  if (
    field.type === 'repeating_group' ||
    field.type === 'signature' ||
    field.type === 'section_header'
  ) {
    return 12;
  }
  if (narrow) return 12;
  const span = field.colSpan;
  if (span === undefined || !Number.isInteger(span) || span < 1 || span > 12) return 12;
  return span;
}

/**
 * Static class lookups — Tailwind's scanner needs literal class names in
 * source (mirroring how COL_OPTIONS drives the builder canvas), so every
 * resolvable span is written out rather than interpolated.
 */
const FILL_SPAN_CLASS: Record<number, string> = {
  1: 'col-span-12 sm:col-span-1',
  2: 'col-span-12 sm:col-span-2',
  3: 'col-span-12 sm:col-span-3',
  4: 'col-span-12 sm:col-span-4',
  5: 'col-span-12 sm:col-span-5',
  6: 'col-span-12 sm:col-span-6',
  7: 'col-span-12 sm:col-span-7',
  8: 'col-span-12 sm:col-span-8',
  9: 'col-span-12 sm:col-span-9',
  10: 'col-span-12 sm:col-span-10',
  11: 'col-span-12 sm:col-span-11',
  12: 'col-span-12 sm:col-span-12',
};

const PREVIEW_SPAN_CLASS: Record<number, string> = {
  1: 'col-span-1',
  2: 'col-span-2',
  3: 'col-span-3',
  4: 'col-span-4',
  5: 'col-span-5',
  6: 'col-span-6',
  7: 'col-span-7',
  8: 'col-span-8',
  9: 'col-span-9',
  10: 'col-span-10',
  11: 'col-span-11',
  12: 'col-span-12',
};

/**
 * Viewport-responsive span class for the public fill page: single column
 * below `sm`, resolved span from `sm` up. Unknown spans fall back to 12.
 */
export function fillSpanClass(span: number): string {
  return FILL_SPAN_CLASS[span] ?? FILL_SPAN_CLASS[12]!;
}

/**
 * Bare span class for container-framed surfaces (mobile frame, builder
 * preview) where the `narrow` argument to `resolveFillSpan` — not a viewport
 * breakpoint — does the collapsing. Unknown spans fall back to 12.
 */
export function previewSpanClass(span: number): string {
  return PREVIEW_SPAN_CLASS[span] ?? PREVIEW_SPAN_CLASS[12]!;
}
