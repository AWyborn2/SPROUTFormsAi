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
import { visibleFields } from '@formai/shared';
import type { FormContainer, FormField, SubmissionValue } from '@formai/shared';

/**
 * The fields a fill surface should lay out, given the answers so far.
 *
 * Filtering happens BEFORE the grid is built, not inside each cell: a hidden
 * field must consume no layout space at all, and an empty `col-span-*` wrapper
 * would leave a visible hole in the row. Section-header scope is expanded by
 * `visibleFields` in @formai/shared — the same call the validator, both submit
 * routes, and the PDF exporter make, so no surface can disagree about whether
 * a field is showing.
 *
 * This is presentation only. The server strips hidden values and skips hidden
 * required fields on its own; nothing here is load-bearing for the guarantee.
 */
export function visibleFillFields(
  fields: FormField[],
  values: Record<string, SubmissionValue>,
): FormField[] {
  return visibleFields(fields, values);
}

/** Layouts the fill surface can actually render. */
export const RENDERABLE_LAYOUTS = ['card', 'hero', 'split', 'conversational'] as const;
export type RenderableLayout = (typeof RENDERABLE_LAYOUTS)[number];

/**
 * Which arrangement the fill surface should draw for a resolved theme.
 *
 * Anything unrecognised degrades to `card` rather than rendering nothing —
 * this value arrives from the network and may predate or postdate this build,
 * and a respondent cannot fix a form that refuses to render.
 *
 * `conversational` reuses the card framing for its chrome; what differs is the
 * body, which paces questions one screen at a time.
 */
export function resolveLayout(layout?: string | null): RenderableLayout {
  return (RENDERABLE_LAYOUTS as readonly string[]).includes(layout ?? '')
    ? (layout as RenderableLayout)
    : 'card';
}

/** Shadow levels map onto the product's existing tokens, not new values. */
const CONTAINER_SHADOW: Record<string, string> = {
  none: 'none',
  sm: 'var(--shadow-sm)',
  md: 'var(--shadow-md)',
  lg: 'var(--shadow-lg)',
};

/**
 * The form card's surface styling, derived from the container the builder
 * saved. This object has been persisted and shipped to the fill page since the
 * builder gained container controls, but the fill page drew its own hardcoded
 * card and ignored it — so width, padding, radius, border and shadow were all
 * editable settings that changed nothing for respondents.
 *
 * Empty-string colour fields mean "keep the product token", matching how
 * `FormContainer` has always been authored, so they are omitted rather than
 * emitted blank.
 */
export function containerSurfaceStyle(
  container?: FormContainer | null,
): Record<string, string | number> {
  const style: Record<string, string | number> = {};
  if (!container) return style;

  if (typeof container.radius === 'number') style.borderRadius = `${container.radius}px`;
  if (typeof container.borderWidth === 'number') {
    style.borderWidth = `${container.borderWidth}px`;
    style.borderStyle = 'solid';
  }
  if (container.borderColor) style.borderColor = container.borderColor;
  if (container.background) style.background = container.background;
  if (container.shadow) style.boxShadow = CONTAINER_SHADOW[container.shadow] ?? '';
  if (style.boxShadow === '') delete style.boxShadow;

  return style;
}

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
