/**
 * Field geometry — where a field's answers belong on the ORIGINAL PDF.
 *
 * `SourcePosition` (form-field.ts) describes one box on one page. That is
 * enough for an AcroForm text input and not enough for anything printed: a
 * compliance table has a wide label column and narrow option columns, and it
 * continues across page breaks. `FieldGeometry` is its successor — a list of
 * page-scoped segments, each optionally carrying the explicit column and row
 * bands that replace dividing a box by equal arithmetic.
 *
 * `SourcePosition` is NOT deprecated and is not migrated. It still describes
 * every AcroForm-extracted field correctly, and `geometrySegments` bridges it
 * into the same shape so consumers read one type (R4).
 *
 * The shapes themselves live in `form-field.ts` alongside `AnswerSet` and
 * `VisibilityCondition` — that file deliberately has no imports, and the
 * sibling modules hold the resolvers. This file is the resolver half.
 *
 * Every resolver here is total. Malformed geometry resolves to NOTHING rather
 * than throwing or guessing, and that asymmetry is deliberate: a field with no
 * geometry exports as data — a visibly incomplete PDF someone will notice. A
 * field with wrong geometry exports a confident mark in the wrong cell of a
 * competency record, which reads as a statement that an operator was assessed
 * as safe on something nobody checked. Silence is the safe failure here.
 */
import type { FormField, GeometryBand, PageBox, SourcePosition } from './form-field.js';

/** Why a segment was rejected. Surfaced for review; never thrown. */
export type GeometryDropReason =
  | 'page-out-of-range'
  | 'invalid-box'
  | 'empty-band'
  | 'overlapping-bands'
  | 'duplicate-band-key'
  | 'band-outside-box';

export interface DroppedSegment {
  page: number;
  reason: GeometryDropReason;
}

export interface GeometryResolution {
  /** Segments that survived validation, in declaration order. */
  segments: PageBox[];
  /** Segments rejected, with the reason. */
  dropped: DroppedSegment[];
}

/**
 * Validate one axis' bands.
 *
 * `min`/`max` bound the segment box on that axis: a band outside it describes a
 * cell that is not in the table, and handing that span to a renderer draws a
 * mark somewhere nobody measured.
 */
function bandsValid(
  bands: GeometryBand[] | undefined,
  min: number,
  max: number,
): GeometryDropReason | null {
  if (!Array.isArray(bands) || bands.length === 0) return null;
  if (bands.some((b) => !b || typeof b !== 'object')) return 'empty-band';

  // Duplicate keys first, mirroring `resolveAnswerSets` and for the same
  // reason: two bands keyed 'tick' both pass every span check, and the lookup
  // silently returns whichever was declared first. On a ✓/×/N-A table those two
  // spans are different columns, so a duplicate key is the cheapest possible
  // way to stamp a competency mark in the wrong one.
  const keys = bands.map((b) => b.key);
  if (new Set(keys).size !== keys.length) return 'duplicate-band-key';

  // Non-finite bounds must die here. `NaN` fails every comparison below, so it
  // would slip through as "no problem found" and reach pdf-lib, which serialises
  // it as the literal token `NaN` into the content stream — a corrupt PDF rather
  // than a blank one.
  if (bands.some((b) => !Number.isFinite(b.start) || !Number.isFinite(b.end))) return 'empty-band';
  if (bands.some((b) => !(b.end > b.start))) return 'empty-band';
  if (bands.some((b) => b.start < min || b.end > max)) return 'band-outside-box';

  // Overlap is checked on a sorted copy so declaration order cannot hide it —
  // a reviewer dragging bands around produces them in whatever order they
  // touched them.
  const sorted = [...bands].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.start < sorted[i - 1]!.end) return 'overlapping-bands';
  }
  return null;
}

/** Every spatial number on a box must be finite, and the page must have extent. */
function boxValid(seg: PageBox): boolean {
  return (
    Number.isFinite(seg.x) &&
    Number.isFinite(seg.y) &&
    Number.isFinite(seg.width) &&
    Number.isFinite(seg.height) &&
    seg.width > 0 &&
    seg.height > 0 &&
    // Consumers divide by these to map points into a rendered raster; a zero or
    // non-finite denominator yields Infinity/NaN coordinates rather than a
    // harmlessly off-page box.
    Number.isFinite(seg.pageWidth) &&
    Number.isFinite(seg.pageHeight) &&
    seg.pageWidth > 0 &&
    seg.pageHeight > 0
  );
}

/**
 * Validate a field's geometry.
 *
 * `pageCount` is optional: pass it wherever the document is open (export,
 * review) so a segment pointing past the end is caught. Without it, page
 * indices are only checked for being non-negative integers.
 *
 * Bands are NOT required to tile the box. Printed tables have gutters, and the
 * label column is routinely wider than every option column combined; demanding
 * full coverage would reject every real table in the library.
 */
export function resolveGeometry(
  field: Pick<FormField, 'geometry'>,
  pageCount?: number,
): GeometryResolution {
  const segments: PageBox[] = [];
  const dropped: DroppedSegment[] = [];

  // `segments` arrives from a JSONB column typed by a cast, and the route that
  // writes it validates fields with a bare `z.custom<FormField>()` — which
  // accepts anything. So this is untyped input at runtime no matter what the
  // signature says, and `for...of` on a non-array would throw out of a function
  // documented as total and therefore not wrapped by its callers.
  const raw = Array.isArray(field.geometry?.segments) ? field.geometry.segments : [];

  for (const seg of raw) {
    if (!seg || typeof seg !== 'object') continue;
    const drop = (reason: GeometryDropReason) => dropped.push({ page: seg.page, reason });

    if (!Number.isInteger(seg.page) || seg.page < 0 || (pageCount !== undefined && seg.page >= pageCount)) {
      drop('page-out-of-range');
      continue;
    }
    if (!boxValid(seg)) {
      drop('invalid-box');
      continue;
    }

    const bandProblem =
      bandsValid(seg.columnBands, seg.x, seg.x + seg.width) ??
      bandsValid(seg.rowBands, seg.y, seg.y + seg.height);
    if (bandProblem) {
      drop(bandProblem);
      continue;
    }

    segments.push(seg);
  }

  return { segments, dropped };
}

/** Widen a legacy single-box position into the segment shape (R4). */
function legacySegment(pos: SourcePosition): PageBox {
  return {
    page: pos.page,
    x: pos.x,
    y: pos.y,
    width: pos.width,
    height: pos.height,
    pageWidth: pos.pageWidth,
    pageHeight: pos.pageHeight,
  };
}

/**
 * The segments a consumer should draw into, from either geometry source.
 *
 * Explicit geometry wins. A field carrying only the legacy `sourcePosition`
 * resolves to one band-less segment, which is exactly right: an AcroForm widget
 * is a single box with no internal structure to describe.
 *
 * The fallback fires only when the field NEVER HAD geometry — not when it had
 * geometry that was rejected. That distinction is the whole safety property.
 * Consider a table whose bands were confirmed against an 18-page document, then
 * the source PDF is replaced by a 16-page revision: every segment drops as
 * out-of-range. Falling back would hand the exporter the legacy single box with
 * no bands, and the exporter divides a band-less box into equal rows and columns
 * — producing a full grid of confident marks in cells nobody measured, on a form
 * whose layout has just changed underneath them. Rejected geometry must resolve
 * to nothing so the field exports as data instead.
 */
export function geometrySegments(
  field: Pick<FormField, 'geometry' | 'sourcePosition'>,
  pageCount?: number,
): PageBox[] {
  const { segments, dropped } = resolveGeometry(field, pageCount);
  if (segments.length > 0) return segments;
  if (dropped.length > 0) return [];

  const pos = field.sourcePosition;
  if (!pos) return [];

  // The legacy position is validated by the SAME resolver rather than by a
  // second copy of the page-range and box-area rules. Two copies would drift
  // the moment one side is tightened, and the drift would be silent — a
  // position rejected on one path and accepted on the other still exports,
  // just inconsistently.
  return resolveGeometry({ geometry: { segments: [legacySegment(pos)] } }, pageCount).segments;
}

/**
 * Band lookup is per-axis, deliberately.
 *
 * A column band is an x-span and a row band is a y-span. On an A4 page both are
 * three-digit numbers, so a single-namespace lookup that fell through from one
 * to the other would answer a "which row?" question with a column's x-span and
 * produce a plausible coordinate on the wrong axis — a mark in the wrong cell,
 * which is the failure this module exists to prevent. Nothing constrains row
 * identities and column keys to disjoint namespaces (a row keyed by item slug
 * can easily collide with a column keyed `comments`), so the caller states the
 * axis rather than relying on keys never colliding.
 */
export function columnBandFor(segment: PageBox, key: string): GeometryBand | undefined {
  return segment.columnBands?.find((b) => b.key === key);
}

/** The row band owning `key` on this segment, or undefined when it has none. */
export function rowBandFor(segment: PageBox, key: string): GeometryBand | undefined {
  return segment.rowBands?.find((b) => b.key === key);
}
