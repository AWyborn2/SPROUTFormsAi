/**
 * The `extract_form_fields` tool the model is forced to call on flat PDFs. Its
 * input schema mirrors @formai/shared's `ExtractionResult` / `ExtractedField`
 * so the tool result maps straight onto our domain types. Kept as a plain JSON
 * Schema object (Anthropic tool `input_schema`).
 */
import { COVER_SECTIONS, FORM_FIELD_TYPES } from '@formai/shared';

export const EXTRACT_TOOL_NAME = 'extract_form_fields';

export const extractFormFieldsTool = {
  name: EXTRACT_TOOL_NAME,
  description:
    'Return every input field found in the form. Extract repeating tables ONCE as a repeating_group with its columns — never enumerate blank paper rows. But when a table has PRE-PRINTED item labels in its rows (a fixed-item checklist, e.g. "Engine oil level", "Park brake"), also emit those labels as fixedRows. When such a checklist is printed as several SIDE-BY-SIDE column groups under one shared header (e.g. three OK/NA column-pairs across the page), read it COLUMN-MAJOR: emit every item of the LEFTMOST printed column top-to-bottom, then the next column top-to-bottom, and so on — not across each row — and set columnGroups to the number of side-by-side groups. A checklist that is a single column of items has no columnGroups. The item/label column must still be the FIRST columns entry (type text). Distinguish boolean_yes_no from checkbox, and give checkbox_group a selectionType. Include a confidence score in [0,1] for every field, and add designNotes for anything a human reviewer should double-check.',
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
              description:
                'Disambiguation for terse or ambiguous labels (e.g. "BAC", "VOC"). Also the place to record a logbook table’s printed minimum-hours sentence verbatim. A definitions table may be printed on pages you cannot see: where you cannot resolve an abbreviation this field uses, say so here rather than expanding it from your own knowledge.',
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
                'For repeating_group only — the pre-printed item labels of a fixed-item checklist table. Omit for tables with genuinely blank entry rows. When present, the item/label column must still appear as the FIRST columns entry (type text). For a single-column checklist, list the items top-to-bottom. For a checklist printed as several side-by-side column groups, list them COLUMN-MAJOR: the whole leftmost printed column top-to-bottom, then the next column, and so on. An item that WRAPS onto a second printed line is ONE entry. Indented bullets beneath an item elaborate it and belong to that item’s entry — they are not entries of their own, unless a bullet prints its own tick box.',
            },
            columnGroups: {
              type: 'integer',
              minimum: 2,
              description:
                'For a fixed-item checklist printed as N side-by-side column groups sharing one header — the number of those groups. Omit for a single column of items. When set, fixedRows must be listed column-major (see fixedRows).',
            },
            questionRef: {
              type: 'string',
              description:
                'A reference that identifies exactly ONE question in the pages you were given. Numbering restarts in every question set, so a bare printed number is not a reference on its own: build it from the set heading plus the printed number where that heading is in view ("General Q7", "BBM Q3", "RM Q10"), and prefix with the printed page number where it is not ("p.5 Q7"). Set the SAME string on the question and on its tick/cross outcome box — that string is what links the two, so the pair must match character for character. Omit on anything that is neither.',
            },
            coverSection: {
              type: 'string',
              enum: [...COVER_SECTIONS],
              description:
                'For a field printed on the document’s FIRST page only — which of its three sections it belongs to. "candidate_declaration": the candidate identity boxes and the candidate declaration signature. "pathway_prerequisites": every prerequisite row, the pathway choice and the assessment-method table. "assessor_declaration": coaching yes/no, further-action and mandatory comment boxes, competent / not-yet-competent, and the assessor name, signature and date. Omit on every field NOT printed on the first page: a per-part sign-off later in the document prints the same performance statement, the same not-yet-Competent / Competent pair and the same Name / Signature / Date row, and carries none.',
            },
            matchLeft: {
              type: 'array',
              items: { type: 'string' },
              description:
                'For a MATCHING question only — every prompt, verbatim, in printed order. Where the prompts are pictures, describe each one ("Sign photo — red pyramid"). Always emit together with matchRight, and leave options empty: the pairings are derived from the two sides. Never emit only one side.',
            },
            matchRight: {
              type: 'array',
              items: { type: 'string' },
              description:
                'For a MATCHING question only — everything the prompts may be matched to, verbatim, in printed order. Always emit together with matchLeft.',
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
        description:
          'Free-text observations that do not belong to any single field — including the printed page range you were given, any part or question-set heading you had to resolve from a margin label or page number rather than read, the pathway-to-part mapping with its part numbers verbatim, qualifications the ASSESSOR must hold, abbreviation definitions, and anything deliberately skipped as page furniture, publisher matter or back matter.',
      },
    },
    required: ['fields'],
  },
} as const;

export const AUDIT_TOOL_NAME = 'report_missed_fields';

/**
 * The secondary-pass tool. The model is handed the PDF plus the labels the
 * first pass ALREADY captured, and asked for the printed input areas that pass
 * missed — nothing already in the list. Deliberately narrow: this is a review
 * safety net, not a second extraction, so it returns a flat list of boxes to
 * consider, never the full field structure.
 */
export const reportMissedFieldsTool = {
  name: AUDIT_TOOL_NAME,
  description:
    'Report printed input areas a person is meant to FILL that are NOT already in the provided list of captured fields. A "missed" area is a blank line to write on, a tick or check box, a signature block, a date box, an initials box, or a table cell awaiting entry — anything the printed page leaves for a human to complete. Do NOT report anything that matches a captured field (compare by meaning, not exact wording). Do NOT report static printed text, headings, instructions, logos, or page furniture. Do NOT re-report the individual rows of a table already captured as one repeating group. When nothing was missed, return an empty list — that is the expected result on a clean extraction.',
  input_schema: {
    type: 'object',
    properties: {
      missedInputs: {
        type: 'array',
        description: 'Printed fill-in areas not already captured. Empty when none were missed.',
        items: {
          type: 'object',
          properties: {
            label: {
              type: 'string',
              description:
                'What the box is for, read off the page — the printed label beside it, or a short description of where it sits ("Assessor signature", "Date completed", "Second witness initials").',
            },
            type: {
              type: 'string',
              enum: [...FORM_FIELD_TYPES],
              description: 'Best-guess field type for the box.',
            },
            page: {
              type: 'integer',
              minimum: 1,
              description: 'The 1-based printed page the box is on, when you can tell.',
            },
            note: {
              type: 'string',
              description:
                'Short reviewer context — where on the page it sits and why it looks fillable ("blank line under the declaration, no label").',
            },
          },
          required: ['label', 'type'],
        },
      },
    },
    required: ['missedInputs'],
  },
} as const;
