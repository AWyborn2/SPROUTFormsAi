/**
 * The `fill_form_fields` tool the model is forced to call on the Smart Fill
 * path — one spoken utterance mapped onto many fields at once.
 *
 * Unlike the PDF extractor's fixed schema, this one is BUILT FROM THE FORM.
 * Every mapping variant names one concrete field id and constrains `value` to
 * exactly what that field can hold, so an option that is not on the list, a
 * string where a number belongs, or an id that does not exist is unreachable
 * rather than merely discouraged. The server re-validates every value anyway
 * (see map.ts): a schema steers the model, it does not bind it.
 */
import type { FormField, FormFieldType } from '@formai/shared';

export const SMART_FILL_TOOL_NAME = 'fill_form_fields';

/**
 * Field types Smart Fill does not answer in v1.
 *  - `signature` / `file_upload` — the answer is a drawn mark or a file, which
 *    no sentence can produce.
 *  - `section_header` — takes no input at all.
 *  - `repeating_group` — a table needs row semantics of its own (which row is
 *    being spoken about, fixed checklist rows, answer sets), which is a design
 *    in its own right rather than a wider enum here.
 */
export const SMART_FILL_SKIPPED_TYPES: readonly FormFieldType[] = [
  'signature',
  'file_upload',
  'section_header',
  'repeating_group',
];

/** A JSON-Schema fragment, as Anthropic's `input_schema` consumes it. */
type JsonSchema = Record<string, unknown>;

export interface SmartFillTool {
  name: typeof SMART_FILL_TOOL_NAME;
  description: string;
  input_schema: JsonSchema;
}

/**
 * The schema for one field's `value`, or null when the field cannot be spoken
 * into at all. Null is also the answer for any field type added after this was
 * written: an unrecognised type is skipped, never guessed at as free text.
 */
function valueSchemaFor(field: FormField): JsonSchema | null {
  if (SMART_FILL_SKIPPED_TYPES.includes(field.type)) return null;
  // A blank option is not a choosable answer, and an enum containing one would
  // invite the model to "select" nothing.
  const options = (field.options ?? []).filter((o) => o.trim() !== '');

  switch (field.type) {
    case 'number':
      return { type: 'number' };
    case 'checkbox':
    case 'boolean_yes_no':
    case 'check_cross':
      return { type: 'boolean', description: 'true for yes / ticked, false for no / crossed.' };
    case 'dropdown':
    case 'radio':
      // A choice field with no options has no legal answer, so it is not a
      // target — an unconstrained string here would be an invented one.
      return options.length > 0 ? { type: 'string', enum: options } : null;
    case 'checkbox_group':
      return options.length > 0
        ? {
            type: 'array',
            items: { type: 'string', enum: options },
            minItems: 1,
            ...(field.selectionType === 'single' ? { maxItems: 1 } : {}),
            description: 'Every option the speaker chose.',
          }
        : null;
    case 'date':
      return { type: 'string', description: 'ISO calendar date, YYYY-MM-DD.' };
    case 'text':
    case 'textarea':
      return { type: 'string' };
    default:
      return null;
  }
}

/** Can a spoken sentence answer this field? */
export function isMappableField(field: FormField): boolean {
  return valueSchemaFor(field) !== null;
}

/** The subset of a form Smart Fill will target, in form order. */
export function mappableFields(fields: FormField[]): FormField[] {
  return fields.filter(isMappableField);
}

/**
 * Everything the model needs to tell this field apart from its neighbours. A
 * terse label ("Reg", "BAC") is exactly where a mis-mapping happens, so the
 * author's own help/description text is handed over verbatim.
 */
function fieldHint(field: FormField): string {
  const parts = [field.label, field.description, field.help].filter(
    (p): p is string => typeof p === 'string' && p.trim() !== '',
  );
  return parts.length > 0 ? parts.join(' — ') : field.id;
}

/**
 * Build the forced tool for one concrete form. Callers must pass at least one
 * mappable field — `mapTranscriptToFields` short-circuits before it gets here,
 * because a variant-less `anyOf` is not a schema any model can satisfy.
 */
export function buildFillFormFieldsTool(fields: FormField[]): SmartFillTool {
  const variants: JsonSchema[] = [];
  for (const field of fields) {
    const value = valueSchemaFor(field);
    if (!value) continue;
    variants.push({
      type: 'object',
      title: field.label,
      description: fieldHint(field),
      properties: {
        // A single-entry enum rather than `const`: same constraint, and it is
        // the form every JSON-Schema consumer in the chain understands.
        fieldId: { type: 'string', enum: [field.id] },
        value,
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description:
            'How sure you are this is what the speaker meant for THIS field. High when they named the field and its answer plainly; low when you inferred it from context.',
        },
      },
      required: ['fieldId', 'value', 'confidence'],
    });
  }

  return {
    name: SMART_FILL_TOOL_NAME,
    description:
      'Place what the speaker said onto the form. Return one mapping per field the transcript actually answers — omit a field entirely rather than guessing at it, and never invent a value the speaker did not give. Each mapping must match one of the shapes below: its fieldId fixes which field it targets and what its value may be. Put anything the speaker said that belongs to no field in unmapped.',
    input_schema: {
      type: 'object',
      properties: {
        mappings: {
          type: 'array',
          description: 'One entry per field the transcript answers. Empty when it answers none.',
          items: { anyOf: variants },
        },
        unmapped: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Fragments of what was said that map to no field, in the speaker’s own words, so they can be entered by hand instead of silently lost.',
        },
      },
      required: ['mappings'],
    },
  };
}
