/**
 * The structure model — pure operations on the sections an author arranges in
 * Step 2, and the resolution back into a publishable field list.
 *
 * NOTHING HERE TOUCHES REACT, and that is the point. The design prototype's
 * equivalent lived inside a render closure, and all three of its worst bugs
 * came from that: a drag that oscillated because `dragOver` fires continuously
 * and each fire re-ran the whole move; a drag that reverted because the drag
 * source was read from a stale closure; and a drop that vanished because the
 * section it came from had been deleted the instant its last field left.
 *
 * Two properties replace all three fixes, and both are testable here:
 *
 *  1. EVERY OPERATION IS IDEMPOTENT BY REFERENCE. When an operation would not
 *     change the order, it returns the SAME array it was given. A `dragOver`
 *     that fires forty times over one row therefore produces one state update
 *     and thirty-nine no-ops, with no external guard to keep in sync.
 *
 *  2. AN EMPTIED SECTION IS KEPT. Dragging the last field out of a section
 *     leaves an empty section, because the author's next move is usually to
 *     drag something back into it — and a section that vanishes mid-drag has
 *     no drop target.
 *
 * `resolveStructure` is the other half: it turns the arrangement into the
 * `FormField[]` a version publishes, and it REPORTS anything it could not
 * place rather than dropping it. A field silently lost between the extraction
 * and the published version is a box nobody will ever fill in and nobody will
 * ever notice is missing.
 */

import {
  COVER_SECTIONS,
  COVER_SECTION_LABELS,
  resolveSpan,
  type BuilderStructure,
  type CoverSection,
  type ExtractedField,
  type ExtractionResult,
  type FormField,
  type SectionColumns,
  type StructureSection,
} from '@formai/shared';

/* ------------------------------------------------------------------ *
 * Seeding
 * ------------------------------------------------------------------ */

/** Fields that are structure rather than something somebody fills in. */
function isHeader(field: Pick<ExtractedField, 'type'>): boolean {
  return field.type === 'section_header';
}

/**
 * A section key from the header that opened it.
 *
 * Derived from the header's field id rather than from its label: two parts of
 * an assessment routinely print the same sub-heading ("Plan and prepare"
 * appears once per practical part), and a label-derived key would collide and
 * merge them.
 */
function sectionKeyFor(headerId: string): string {
  return `sec_${headerId}`;
}

/**
 * The cover page's fields, as up to three sections in their printed order.
 *
 * Grouped by the extraction's `coverSection` rather than by position, because
 * the three sections are a property of the document class (identity,
 * eligibility, verdict) and the model is asked for them by name. A cover field
 * the model left unmarked falls through to the ordinary header-run rule, where
 * it is visible and movable rather than silently filed under a guess.
 */
function coverSections(fields: readonly ExtractedField[]): StructureSection[] {
  const byCover = new Map<CoverSection, ExtractedField[]>();
  for (const field of fields) {
    if (isHeader(field) || !field.coverSection) continue;
    const bucket = byCover.get(field.coverSection);
    if (bucket) bucket.push(field);
    else byCover.set(field.coverSection, [field]);
  }

  return COVER_SECTIONS.filter((key) => byCover.has(key)).map((key) => ({
    key: `cover_${key}`,
    label: COVER_SECTION_LABELS[key],
    cols: 2 as SectionColumns,
    cover: true,
    fields: (byCover.get(key) ?? []).map((f) => ({ id: f.id })),
  }));
}

/** Fields that no cover section claimed, in document order. */
function nonCoverFields(fields: readonly ExtractedField[]): ExtractedField[] {
  return fields.filter((f) => !f.coverSection);
}

/**
 * Seed the arrangement from a fresh extraction.
 *
 * The cover's three sections come first, because page one prints first. After
 * them, a `section_header` opens a section and everything up to the next header
 * belongs to it — the same header-to-next-header rule `fieldsInSection` applies
 * in `@formai/shared`, so the builder and the manifest agree on what a section
 * contains.
 *
 * A header with nothing under it still becomes a section. It is a real heading
 * on a real page, and an empty one is information: either the extraction missed
 * the fields beneath it, or the author has somewhere to drag fields into.
 */
export function structureFromExtraction(extraction: ExtractionResult): BuilderStructure {
  const sections: StructureSection[] = coverSections(extraction.fields);
  const rest = nonCoverFields(extraction.fields);

  let current: StructureSection | null = null;
  for (const field of rest) {
    if (isHeader(field)) {
      current = {
        key: sectionKeyFor(field.id),
        label: field.label,
        cols: 1,
        headerFieldId: field.id,
        fields: [],
      };
      sections.push(current);
      continue;
    }

    if (!current) {
      // Fields printed before any heading. Named for what they are rather than
      // filed under an invented title, so an author renames it deliberately.
      current = { key: 'sec_lead', label: 'Fields before the first heading', cols: 1, fields: [] };
      sections.push(current);
    }
    current.fields.push({ id: field.id });
  }

  return sections;
}

/* ------------------------------------------------------------------ *
 * Section operations
 * ------------------------------------------------------------------ */

/** Replace one section, returning the same array when nothing changed. */
function patchSection(
  structure: BuilderStructure,
  key: string,
  patch: (section: StructureSection) => StructureSection,
): BuilderStructure {
  const at = structure.findIndex((s) => s.key === key);
  if (at < 0) return structure;
  const next = patch(structure[at]!);
  if (next === structure[at]) return structure;
  const out = [...structure];
  out[at] = next;
  return out;
}

/** Move a section earlier (`delta < 0`) or later. Clamped, never wrapped. */
export function moveSection(
  structure: BuilderStructure,
  key: string,
  delta: number,
): BuilderStructure {
  const at = structure.findIndex((s) => s.key === key);
  if (at < 0) return structure;
  const to = at + delta;
  if (to < 0 || to >= structure.length || delta === 0) return structure;
  const out = [...structure];
  const [moved] = out.splice(at, 1);
  out.splice(to, 0, moved!);
  return out;
}

export function renameSection(
  structure: BuilderStructure,
  key: string,
  label: string,
): BuilderStructure {
  return patchSection(structure, key, (s) => (s.label === label ? s : { ...s, label }));
}

export function setSectionColumns(
  structure: BuilderStructure,
  key: string,
  cols: SectionColumns,
): BuilderStructure {
  /*
    The fields' spans are NOT rewritten to fit.

    A section narrowed from three columns to two renders its 3-wide field at 2
    (`resolveSpan` clamps on read), and widening it back restores the author's
    3. Rewriting here would make the narrow view destroy work the author can
    see they did.
  */
  return patchSection(structure, key, (s) => (s.cols === cols ? s : { ...s, cols }));
}

export function setOwnPage(
  structure: BuilderStructure,
  key: string,
  ownPage: boolean,
): BuilderStructure {
  return patchSection(structure, key, (s) =>
    !!s.ownPage === ownPage ? s : { ...s, ownPage },
  );
}

/**
 * Cycle a field's span: 1 → 2 → 3 → 1, bounded by its section's column count.
 *
 * A single-column section has one reachable value, so cycling there is a no-op
 * rather than a change that renders identically — which is why the control is
 * hidden at one column.
 */
export function cycleFieldSpan(
  structure: BuilderStructure,
  sectionKey: string,
  fieldId: string,
): BuilderStructure {
  return patchSection(structure, sectionKey, (s) => {
    if (s.cols === 1) return s;
    const at = s.fields.findIndex((f) => f.id === fieldId);
    if (at < 0) return s;
    const current = resolveSpan(s.fields[at]!, s.cols);
    const next = ((current % s.cols) + 1) as SectionColumns;
    const fields = [...s.fields];
    fields[at] = { ...fields[at]!, span: next };
    return { ...s, fields };
  });
}

/* ------------------------------------------------------------------ *
 * Field movement
 * ------------------------------------------------------------------ */

/**
 * Where a drag would drop, as a comparable key.
 *
 * The caller does not need this to prevent oscillation — `moveField` is
 * reference-idempotent, which handles that — but a UI that wants to skip work
 * entirely on an unchanged hover can compare successive slots cheaply.
 */
export function dropSlotKey(
  sectionKey: string,
  beforeFieldId: string | null,
  after: boolean,
): string {
  return `${sectionKey}|${beforeFieldId ?? '#end'}|${after ? 'a' : 'b'}`;
}

/** Every field id in the arrangement, in order. */
function orderOf(structure: BuilderStructure): string {
  return structure.map((s) => `${s.key}:${s.fields.map((f) => f.id).join(',')}`).join('|');
}

/**
 * Move one field to a position in a section.
 *
 * `beforeFieldId` names the row the pointer is over and `after` says which half
 * of it — the midpoint rule, which is what stops a field flip-flopping between
 * two rows as the pointer wobbles over their shared edge. A null
 * `beforeFieldId` appends to the end, which is what dropping on a section's
 * empty space means.
 *
 * RETURNS THE SAME ARRAY WHEN THE ORDER WOULD NOT CHANGE. `dragOver` fires
 * continuously — dozens of times over one row — and each fire calls this. The
 * design prototype re-ran the whole move every time and the row oscillated;
 * comparing the resulting order and returning the input unchanged makes the
 * repeats free and needs no state to remember what the last one did.
 *
 * An emptied section is KEPT, deliberately: the field's old section is where
 * the author is most likely to drop it back, and a section that disappears
 * mid-drag has no drop target.
 */
export function moveField(
  structure: BuilderStructure,
  fieldId: string,
  toSectionKey: string,
  beforeFieldId: string | null,
  after = false,
): BuilderStructure {
  if (fieldId === beforeFieldId) return structure;
  if (!structure.some((s) => s.key === toSectionKey)) return structure;

  let moved: { id: string; span?: SectionColumns } | null = null;
  const stripped = structure.map((section) => {
    const at = section.fields.findIndex((f) => f.id === fieldId);
    if (at < 0) return section;
    moved = section.fields[at]!;
    return { ...section, fields: section.fields.filter((f) => f.id !== fieldId) };
  });
  if (!moved) return structure;

  const next = stripped.map((section) => {
    if (section.key !== toSectionKey) return section;
    const fields = [...section.fields];
    const at = beforeFieldId ? fields.findIndex((f) => f.id === beforeFieldId) : -1;
    if (at < 0) fields.push(moved!);
    else fields.splice(after ? at + 1 : at, 0, moved!);
    return { ...section, fields };
  });

  // Reference-idempotent: an operation that changes nothing returns the input,
  // so a repeated `dragOver` costs one comparison instead of a re-render.
  return orderOf(next) === orderOf(structure) ? structure : next;
}

/**
 * Pull the ticked fields out of wherever they are into a new section.
 *
 * The new section is appended and flagged `ownPage`, because grouping is how an
 * author says "these belong together and apart from the rest" — and the thing
 * they most often mean by it is a page. Order within the new section follows
 * the arrangement's own order, not the order the author happened to tick them
 * in, so the result matches what they were looking at.
 */
export function groupIntoSection(
  structure: BuilderStructure,
  fieldIds: readonly string[],
  label: string,
  key: string,
): BuilderStructure {
  const wanted = new Set(fieldIds);
  if (wanted.size === 0) return structure;

  const picked: { id: string; span?: SectionColumns }[] = [];
  const stripped = structure.map((section) => {
    const keep = section.fields.filter((f) => {
      if (!wanted.has(f.id)) return true;
      picked.push(f);
      return false;
    });
    return keep.length === section.fields.length ? section : { ...section, fields: keep };
  });
  if (picked.length === 0) return structure;

  return [
    ...stripped,
    // Spans are dropped: a field that was 2-of-3 in its old section means
    // nothing in a new single-column one, and carrying the number over would
    // render it full-width while the control claims it is two thirds.
    { key, label, cols: 1 as SectionColumns, ownPage: true, fields: picked.map((f) => ({ id: f.id })) },
  ];
}

/** Drop a section, returning its fields to the section before it. */
export function dissolveSection(structure: BuilderStructure, key: string): BuilderStructure {
  const at = structure.findIndex((s) => s.key === key);
  if (at < 0) return structure;
  const section = structure[at]!;
  const intoIndex = at === 0 ? (structure.length > 1 ? 1 : -1) : at - 1;
  if (intoIndex < 0) return structure;

  const out = structure.filter((s) => s.key !== key);
  const target = at === 0 ? out[0]! : out[intoIndex]!;
  const merged = { ...target, fields: [...target.fields, ...section.fields] };
  return out.map((s) => (s.key === merged.key ? merged : s));
}

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

/**
 * A section's span (1..3) as a span of the twelve-column grid the fill surfaces
 * already lay out on.
 *
 * Not a new grid: `FormField.colSpan` has always been out of twelve, and
 * `resolveFillSpan` reads it on every fill surface. Three columns is 4/8/12,
 * two is 6/12, one is 12 — so a section laid out here renders identically
 * wherever the form is filled, with nothing new to teach the renderer.
 */
export function colSpanFor(span: SectionColumns, cols: SectionColumns): number {
  return Math.round((12 / cols) * span);
}

export interface ResolvedStructure {
  /** The publishable field list, in the author's order. */
  fields: FormField[];
  /**
   * Fields the arrangement never placed.
   *
   * Reported rather than appended silently. A field that reaches a published
   * version through a path nobody chose is a box on a competency record that
   * nobody decided should be there; a field that vanishes is one nobody will
   * ever fill in and nobody will notice is missing. Both need somebody told.
   */
  orphanIds: string[];
}

/**
 * Turn the arrangement into the field list a version publishes.
 *
 * Each section contributes its `section_header` — the extracted one where it
 * came from a heading, a synthesised one where the author created it by
 * grouping — followed by its fields carrying their resolved `colSpan`.
 *
 * The header is emitted even for an author-made section because
 * `visibility.ts` scopes a condition to "this header up to the next", and
 * `fieldsInSection` slices the same way. A section with no header is invisible
 * to both, so an author's grouping would not survive as a grouping.
 */
export function resolveStructure(
  structure: BuilderStructure,
  fields: readonly FormField[],
): ResolvedStructure {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const placed = new Set<string>();
  const out: FormField[] = [];

  for (const section of structure) {
    const header = section.headerFieldId ? byId.get(section.headerFieldId) : undefined;
    if (header) {
      out.push({ ...header, label: section.label });
      placed.add(header.id);
    } else {
      out.push({
        id: `${section.key}_header`,
        type: 'section_header',
        label: section.label,
        required: false,
        source: 'built',
      });
    }

    for (const entry of section.fields) {
      const field = byId.get(entry.id);
      if (!field) continue;
      placed.add(field.id);
      out.push({ ...field, colSpan: colSpanFor(resolveSpan(entry, section.cols), section.cols) });
    }
  }

  const orphanIds = fields
    .filter((f) => !placed.has(f.id) && f.type !== 'section_header')
    .map((f) => f.id);

  return { fields: out, orphanIds };
}
