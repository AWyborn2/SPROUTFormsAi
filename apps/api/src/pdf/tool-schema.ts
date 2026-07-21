/**
 * The `extract_form_fields` tool the model is forced to call on flat PDFs. Its
 * input schema mirrors @formai/shared's `ExtractionResult` / `ExtractedField`
 * so the tool result maps straight onto our domain types. Kept as a plain JSON
 * Schema object (Anthropic tool `input_schema`).
 */
import { FORM_FIELD_TYPES } from '@formai/shared';

export const EXTRACT_TOOL_NAME = 'extract_form_fields';

export const extractFormFieldsTool = {
  name: EXTRACT_TOOL_NAME,
  description:
    'Return every input field found in the form. Extract repeating tables ONCE as a repeating_group with its columns — never enumerate blank paper rows. But when a table has PRE-PRINTED item labels in its rows (a fixed-item checklist, e.g. "Engine oil level", "Park brake"), also emit those labels in order as fixedRows; the item/label column must still be the FIRST columns entry (type text). Distinguish boolean_yes_no from checkbox, and give checkbox_group a selectionType. Include a confidence score in [0,1] for every field, and add designNotes for anything a human reviewer should double-check.',
  input_schema: {
    type: 'object',
    properties: {
      fields: {
        type: 'array',
        description: 'Every distinct input field on the form, in reading order.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'The visible field label.' },
            type: {
              type: 'string',
              enum: [...FORM_FIELD_TYPES],
              description: 'The field type. Use repeating_group for tables, boolean_yes_no for single yes/no.',
            },
            confidence: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              description: 'How confident you are in this field mapping.',
            },
            required: { type: 'boolean' },
            description: {
              type: 'string',
              description: 'Disambiguation for terse or ambiguous labels (e.g. "BAC", "VOC").',
            },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: 'Choices for dropdown / radio / checkbox_group.',
            },
            selectionType: {
              type: 'string',
              enum: ['single', 'multiple'],
              description: 'For checkbox_group only.',
            },
            columns: {
              type: 'array',
              description: 'For repeating_group only — the column definitions, extracted once.',
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string' },
                  label: { type: 'string' },
                  type: { type: 'string', enum: [...FORM_FIELD_TYPES] },
                  options: { type: 'array', items: { type: 'string' } },
                  required: { type: 'boolean' },
                },
                required: ['key', 'label', 'type'],
              },
            },
            answerSets: {
              type: 'array',
              description:
                'For repeating_group only — groups of columns that are ALTERNATIVES sharing ONE answer per row (exactly one may be ticked), as opposed to independent checkboxes each ticked on its own. The house shapes are OK / NA, ✓ / × / N-A, and Pass / Fail / NA. Each set must name at least two keys from columns, must not include the first (item/label) column, and no column may appear in two sets. Omit entirely when every column is independent.',
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string', description: 'Stable identifier for this group within the field.' },
                  label: { type: 'string', description: 'Optional heading for the group, e.g. "Status".' },
                  columnKeys: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'The member column keys, in printed order. At least two.',
                  },
                  required: {
                    type: 'boolean',
                    description: 'True when every row must carry an answer within this group.',
                  },
                },
                required: ['key', 'columnKeys'],
              },
            },
            fixedRows: {
              type: 'array',
              items: { type: 'string' },
              description:
                'For repeating_group only — the pre-printed item labels of a fixed-item checklist table, in row order. Omit for tables with genuinely blank entry rows. When present, the item/label column must still appear as the FIRST columns entry (type text).',
            },
            note: {
              type: 'string',
              description: 'Reviewer-facing caveat, e.g. "detected as text — most likely a signature field".',
            },
          },
          required: ['label', 'type', 'confidence'],
        },
      },
      designNotes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Free-text observations that do not belong to any single field.',
      },
    },
    required: ['fields'],
  },
} as const;
