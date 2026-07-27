/**
 * Which fields a Smart Fill result is allowed to write.
 *
 * Separate from `applyMappings` because the question is about the form's SHAPE
 * rather than about its answers, and because it is the one part of the merge
 * that has to be reasoned about against a state that does not exist yet: the
 * form as it will stand once the whole result has landed.
 */
import { visibleFields } from '@formai/shared';
import type { FormField, SmartFillMapping, SubmissionValue } from '@formai/shared';
import { applyMappings } from './smart-fill.js';

/**
 * The fields `applyMappings` should be given, judged against the merged result
 * rather than against the form as it looks now.
 *
 * The pre-patch visible list is the wrong basis. The canonical Smart Fill
 * utterance answers a gating question and the section it reveals in one breath
 * — "we're at BBM Mining, the gate was left open" — and at the moment the reply
 * is judged that section is still hidden, so its answer is dropped. Nothing
 * surfaces it either: the model DID place it, so it is not in `unmapped`, and
 * it never became a change, so it is not in the count. The respondent is told
 * "Filled in 1 answer" and the question they just answered is sitting there
 * empty. The server cannot pre-empt this — it holds no answers, so it offers
 * every field of the right TYPE as a target and expects the client to decide.
 *
 * `writable` is injected rather than imported so this stays a pure module: the
 * renderer owns which types it can actually draw a control for, and a mapping
 * onto a field with no control would make speaking the only way to answer it.
 *
 * Iterated because a revealed field can gate another, and bounded because a
 * form may condition a field on its own answer — which has no fixed point at
 * all. One pass per field is past anything a form without a cycle can reach.
 */
export function smartFillTargets(
  fields: readonly FormField[],
  values: Record<string, SubmissionValue>,
  mappings: readonly SmartFillMapping[],
  writable: (field: FormField) => boolean,
): FormField[] {
  let admitted = visibleFields(fields, values).filter(writable);

  for (let pass = 0; pass < fields.length; pass++) {
    const merged = applyMappings(values, mappings, admitted).values;
    const next = visibleFields(fields, merged).filter(writable);
    if (sameFields(next, admitted)) break;
    admitted = next;
  }

  return admitted;
}

/** Order matters as well as membership — `visibleFields` preserves form order. */
function sameFields(a: readonly FormField[], b: readonly FormField[]): boolean {
  return a.length === b.length && a.every((field, i) => field.id === b[i]?.id);
}
