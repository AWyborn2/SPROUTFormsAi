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
    'Return every input field found in the form. Extract repeating tables ONCE as a repeating_group with its columns — never enumerate blank paper rows. Distinguish boolean_yes_no from checkbox, and give checkbox_group a selectionType. Include a confidence score in [0,1] for every field, and add designNotes for anything a human reviewer should double-check.',
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
