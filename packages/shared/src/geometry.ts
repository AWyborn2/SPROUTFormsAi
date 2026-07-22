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
  | 'overlapping-bands';

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

/** A band is usable only if it spans a positive distance. */
function bandsValid(bands: GeometryBand[] | undefined): GeometryDropReason | null {
  if (!bands || bands.length === 0) return null;
  if (bands.some((b) => !(b.end > b.start))) return 'empty-band';

  // Overlap is checked on a sorted copy so declaration order cannot hide it —
  // a reviewer dragging bands around produces them in whatever order they
  // touched them.
  const sorted = [...bands].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.start < sorted[i - 1]!.end) return 'overlapping-bands';
  }
  return null;
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

  for (const seg of field.geometry?.segments ?? []) {
    const drop = (reason: GeometryDropReason) => dropped.push({ page: seg.page, reason });

    if (!Number.isInteger(seg.page) || seg.page < 0 || (pageCount !== undefined && seg.page >= pageCount)) {
      drop('page-out-of-range');
      continue;
    }
    if (!(seg.width > 0) || !(seg.height > 0)) {
      drop('invalid-box');
      continue;
    }

    const bandProblem = bandsValid(seg.columnBands) ?? bandsValid(seg.rowBands);
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
 * is a single box with no internal structure to describe. Falling back to the
 * legacy position when explicit geometry is wholly invalid keeps a form that
 * round-tripped before this feature round-tripping after it.
 */
export function geometrySegments(
  field: Pick<FormField, 'geometry' | 'sourcePosition'>,
  pageCount?: number,
): PageBox[] {
  const resolved = resolveGeometry(field, pageCount).segments;
  if (resolved.length > 0) return resolved;

  const pos = field.sourcePosition;
  if (!pos) return [];
  if (!Number.isInteger(pos.page) || pos.page < 0) return [];
  if (pageCount !== undefined && pos.page >= pageCount) return [];
  if (!(pos.width > 0) || !(pos.height > 0)) return [];

  return [legacySegment(pos)];
}

/** The band owning `key` on this segment, or undefined when it has none. */
export function bandFor(segment: PageBox, key: string): GeometryBand | undefined {
  return segment.columnBands?.find((b) => b.key === key) ?? segment.rowBands?.find((b) => b.key === key);
}
