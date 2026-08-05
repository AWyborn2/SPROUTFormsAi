/**
 * Adding, deleting and folding away fields the extraction got wrong.
 *
 * WHY THIS EXISTS. The plan's own risk table claims every step is correctable —
 * "types, sides, structure, keys and placements are all editable". Two things
 * were not: a field the extraction INVENTED could not be removed, and a box it
 * MISSED could not be added. On a product whose premise is "upload a document
 * nobody has seen", that is the gap that matters most: the model will always
 * miss something on some paper, and until now the answer was to re-import and
 * hope, or to hand-edit the published version afterwards.
 *
 * EVERY EDIT IS ONE ATOMIC OPERATION OVER THE WHOLE DRAFT, and that is the
 * point of this module's shape. A field id is referenced from five places — the
 * structure arrangement, the field list, the answer keys, another field's
 * `outcomeTarget`, and the excluded set — and a delete that cleaned up four of
 * them leaves a manifest that fails `validateAnswerKeys` at publish, naming a
 * field the author cannot see because they already deleted it. Taking the whole
 * state and returning the whole state makes the incomplete version
 * unexpressible.
 */

import { retypeField } from '../../../lib/field-editor/reducer.js';
import type { BuilderStructure, DraftAnswerKey, FormField, FormFieldType } from '@formai/shared';

/** Everything a field edit touches. */
export interface FieldEditState {
  fields: readonly FormField[];
  structure: BuilderStructure;
  keys: readonly DraftAnswerKey[];
  excluded: ReadonlySet<string>;
}

export interface FieldEditResult {
  fields: FormField[];
  structure: BuilderStructure;
  keys: DraftAnswerKey[];
  excluded: Set<string>;
}

/**
 * An id for a field the author added.
 *
 * PREFIXED SO ITS ORIGIN SURVIVES. Extraction ids come from the model; this one
 * did not, and anything reading the published version later — a reviewer, an
 * export, a person debugging why a box has no geometry — can tell which is
 * which without a second record. Numbered from the highest already present so
 * re-adding after a delete cannot collide with a live field.
 */
export function nextAddedId(fields: readonly FormField[]): string {
  let highest = 0;
  for (const field of fields) {
    const match = /^added-(\d+)$/.exec(field.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `added-${highest + 1}`;
}

/**
 * Add a field the extraction missed, directly after another.
 *
 * Placed relative to a NEIGHBOUR rather than appended, because a missed box is
 * missed from somewhere — "the second signature line on page 4" — and an author
 * who has to drag it into position afterwards has been given half a feature.
 * `afterFieldId` of null puts it first in the section.
 *
 * The new field is `source: 'built'`, not `'imported'`. Nothing in the product
 * currently branches on that, and it is exactly the kind of provenance that is
 * impossible to reconstruct later: an imported field can be checked against the
 * paper, and a built one cannot, because the paper never had it.
 */
export function addField(
  state: FieldEditState,
  sectionKey: string,
  afterFieldId: string | null,
  type: FormFieldType,
  label: string,
): FieldEditResult {
  const section = state.structure.find((s) => s.key === sectionKey);
  if (!section) return unchanged(state);

  const id = nextAddedId(state.fields);
  // Built through `retypeField` so a choice type arrives with seeded options,
  // exactly as a retype does. A radio with no options is a question nobody can
  // answer, and a second seeding rule here would drift from that one.
  const field = retypeField(
    { id, type: 'text', label, required: false, source: 'built' },
    type,
  );

  const at = afterFieldId ? section.fields.findIndex((f) => f.id === afterFieldId) : -1;
  const nextFields = [...section.fields];
  nextFields.splice(at + 1, 0, { id });

  return {
    fields: [...state.fields, field],
    structure: state.structure.map((s) => (s.key === sectionKey ? { ...s, fields: nextFields } : s)),
    keys: [...state.keys],
    excluded: new Set(state.excluded),
  };
}

/**
 * Delete a field, and every reference to it.
 *
 * THE REFERENCES ARE THE WHOLE JOB. Removing the field and leaving its answer
 * key behind produces a key naming a field that does not exist; leaving another
 * question's `outcomeTarget` pointed at it produces a question whose mark has
 * nowhere to land, which `validateAnswerKeys` rejects at publish — naming a
 * field the author deleted and can no longer see. Both are found only at the
 * end, by which point the cause is hours old.
 *
 * A question that LOSES its outcome box also loses its key: a key with no
 * outcome target is exactly what the validator refuses, and silently keeping it
 * would move the failure rather than fix it.
 */
export function deleteField(state: FieldEditState, fieldId: string): FieldEditResult {
  if (!state.fields.some((f) => f.id === fieldId)) return unchanged(state);

  // Questions whose verdict was written into the field being deleted.
  const orphaned = new Set(
    state.fields.filter((f) => f.outcomeTarget?.fieldId === fieldId).map((f) => f.id),
  );

  const fields = state.fields
    .filter((f) => f.id !== fieldId)
    .map((f) => {
      if (!orphaned.has(f.id)) return f;
      const { outcomeTarget: _drop, answerKey: _key, ...rest } = f;
      return rest;
    });

  const excluded = new Set(state.excluded);
  excluded.delete(fieldId);

  return {
    fields,
    structure: state.structure.map((s) => ({
      ...s,
      fields: s.fields.filter((f) => f.id !== fieldId),
    })),
    keys: state.keys.filter((k) => k.fieldId !== fieldId && !orphaned.has(k.fieldId)),
    excluded,
  };
}

/**
 * Fold a field into the one above it, as its description.
 *
 * The shape this exists for: extraction reads a printed instruction — "Tick one
 * box only", "Refer to the SME manual" — as a fillable text box, because it
 * sits where a box would. It is not a field and it is not a heading; it is
 * something the field below or above it says about itself.
 *
 * The text is APPENDED rather than replacing, so a field that already had a
 * description keeps it. Deleting the folded field goes through `deleteField`,
 * so its references are cleaned up by the one implementation that knows them
 * all.
 */
export function mergeIntoDescription(
  state: FieldEditState,
  fieldId: string,
  targetFieldId: string,
): FieldEditResult {
  const source = state.fields.find((f) => f.id === fieldId);
  const target = state.fields.find((f) => f.id === targetFieldId);
  if (!source || !target || fieldId === targetFieldId) return unchanged(state);

  const text = source.label.trim();
  if (!text) return deleteField(state, fieldId);

  const withDescription = state.fields.map((f) =>
    f.id === targetFieldId
      ? { ...f, description: [f.description?.trim(), text].filter(Boolean).join(' ') }
      : f,
  );

  return deleteField({ ...state, fields: withDescription }, fieldId);
}

function unchanged(state: FieldEditState): FieldEditResult {
  return {
    fields: [...state.fields],
    structure: state.structure,
    keys: [...state.keys],
    excluded: new Set(state.excluded),
  };
}
