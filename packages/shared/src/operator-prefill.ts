/**
 * Which field on a STANDALONE form names the person completing it.
 *
 * A standalone form (a plain template filled through a share link) has no
 * assessment manifest, so the per-tool `profilePrefill` map does not reach it.
 * But a signed-in member should not retype a name the app already knows: the
 * fill screen prefills "Your name" from the session, and this finds the form
 * FIELD that should mirror it (the "Operator" box on a pre-start, the "Driver"
 * box on a checklist) so it can be seeded the same way.
 *
 * Matched by LABEL because an imported form carries no per-field role — the
 * same reason the assessment builder proposes `profilePrefill` from labels. It
 * is deliberately conservative: a name in the wrong box is worse than no
 * prefill, so it (1) only considers plain text fields, (2) excludes fields that
 * name SOMEONE ELSE (supervisor, assessor, witness) or a NON-PERSON (company,
 * site, asset, vehicle), and (3) returns a field only when exactly one clear
 * match exists, never guessing between several. The seeded value stays editable
 * — the operator may differ from whoever is filling the form in.
 */
import type { FormField } from './form-field.js';

const PERSON_LABEL = /\b(operator|driver)\b/i;
const YOUR_NAME_LABEL = /\byour\s+name\b/i;
const NOT_THE_SUBMITTER =
  /\b(supervisor|assessor|manager|witness|company|business|organisation|organization|site|asset|vehicle|plant|contact|next of kin|employee\s*(no|number|#))\b/i;

/**
 * The id of the text field that should be prefilled with the signed-in user's
 * name on a standalone form, or `undefined` when there isn't exactly one clear
 * match. Prefers a unique operator/driver field, then a unique "your name"
 * field.
 */
export function operatorNameFieldId(fields: readonly FormField[]): string | undefined {
  const textFields = fields.filter(
    (f) => f.type === 'text' && typeof f.label === 'string' && !NOT_THE_SUBMITTER.test(f.label),
  );
  const person = textFields.filter((f) => PERSON_LABEL.test(f.label));
  if (person.length === 1) return person[0]!.id;
  const yourName = textFields.filter((f) => YOUR_NAME_LABEL.test(f.label));
  if (yourName.length === 1) return yourName[0]!.id;
  return undefined;
}
