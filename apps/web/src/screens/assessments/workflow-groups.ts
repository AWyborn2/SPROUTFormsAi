import type { FormField } from '@formai/shared';

/**
 * A section's fields, grouped under the printed headings they sit beneath.
 *
 * The Track Dozer carries 185 fields. A flat list of them under one part is
 * unusable — an author looking for "the assessor's comments box" scrolls past
 * sixty checklist criteria to find it. The document already groups them, with
 * printed headings the extractor kept as `section_header` fields, so the
 * grouping is read off the paper rather than invented.
 *
 * Fields before the first heading go into a leading group with no title. That
 * happens on a part whose anchor IS its heading (the heading is consumed as the
 * part's start) and on the cover page, which has no headings at all.
 */
export interface FieldGroup {
  /** The printed heading, or null for fields that precede the first one. */
  heading: string | null;
  /** The heading's own field id, for a stable React key and an anchor. */
  headingId: string | null;
  fields: FormField[];
}

export function groupFieldsByHeading(fields: readonly FormField[]): FieldGroup[] {
  const groups: FieldGroup[] = [];
  let current: FieldGroup | null = null;

  for (const field of fields) {
    if (field.type === 'section_header') {
      /*
        The heading starts a group and is NOT itself a member of one. It carries
        no answer, so offering an access control for it would ask an author to
        decide who may fill a printed line of text.
      */
      current = { heading: field.label, headingId: field.id, fields: [] };
      groups.push(current);
      continue;
    }
    if (!current) {
      current = { heading: null, headingId: null, fields: [] };
      groups.push(current);
    }
    current.fields.push(field);
  }

  // A heading with nothing under it is a printed divider, not a group of
  // fields. Keeping it would give an author an empty box to expand.
  return groups.filter((g) => g.fields.length > 0);
}

/** How many fields a group list holds, for a collapsed group's count. */
export function totalFields(groups: readonly FieldGroup[]): number {
  return groups.reduce((n, g) => n + g.fields.length, 0);
}
