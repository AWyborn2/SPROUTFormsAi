import { describe, expect, it, vi } from 'vitest';
import type { AnthropicMessage } from './extract.js';
import { EXTRACTION_MAX_TOKENS, extractForm, parseExtractionResponse } from './extract.js';
import { EXTRACT_TOOL_NAME } from './tool-schema.js';
import { makeAcroFormPdf, makeFlatPdf } from './test-pdfs.js';

/** The structured extraction a dense checklist should yield. */
const CHECKLIST_RESULT = {
  fields: [
    { label: 'Site name', type: 'text', confidence: 0.98 },
    { label: 'Inspection date', type: 'date', confidence: 0.96 },
    {
      label: 'Inspection items',
      type: 'repeating_group',
      confidence: 0.72,
      note: 'Repeating table detected',
      columns: [
        { key: 'item', label: 'Item', type: 'text' },
        { key: 'pass', label: 'Pass', type: 'boolean_yes_no' },
        { key: 'fail', label: 'Fail', type: 'boolean_yes_no' },
        { key: 'comments', label: 'Comments', type: 'text' },
      ],
    },
    {
      label: 'Inspector signature',
      type: 'text',
      confidence: 0.58,
      note: 'Detected as text — most likely a signature field',
    },
  ],
  designNotes: ['Repeating "Inspection items" table detected — extracted as columns.'],
};

function toolUseResponse(): AnthropicMessage {
  return {
    content: [
      { type: 'tool_use', name: EXTRACT_TOOL_NAME, input: CHECKLIST_RESULT },
    ],
  };
}

function jsonFenceResponse(): AnthropicMessage {
  return {
    content: [
      {
        type: 'text',
        text:
          'Here are the fields I found:\n\n```json\n' +
          JSON.stringify(CHECKLIST_RESULT, null, 2) +
          '\n```\n',
      },
    ],
  };
}

describe('extractForm — AcroForm path', () => {
  it('reads fillable fields deterministically with zero AI calls', async () => {
    const pdf = await makeAcroFormPdf();
    const create = vi.fn();
    const anthropic = { messages: { create } };

    const result = await extractForm(pdf, { fileName: 'acro.pdf', anthropic });

    expect(create).not.toHaveBeenCalled(); // the differentiator: no AI on AcroForms
    expect(result.path).toBe('acroform');
    const labels = result.fields.map((f) => f.label);
    expect(labels).toContain('full_name');
    expect(labels).toContain('agree_terms');
    expect(labels).toContain('category');
    const category = result.fields.find((f) => f.label === 'category');
    expect(category?.type).toBe('dropdown');
    expect(category?.options).toEqual(['Goods supplier', 'Services contractor']);
    expect(result.fields.every((f) => f.confidence === 1)).toBe(true);
  });
});

describe('extractForm — flat PDF AI path', () => {
  it('extracts via the tool_use block, sizing max_tokens for dense forms', async () => {
    const pdf = await makeFlatPdf();
    const create = vi.fn().mockResolvedValue(toolUseResponse());
    const anthropic = { messages: { create } };

    const result = await extractForm(pdf, { fileName: 'flat.pdf', anthropic });

    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0]![0] as { max_tokens: number; tool_choice: unknown };
    expect(params.max_tokens).toBeGreaterThanOrEqual(EXTRACTION_MAX_TOKENS);
    expect(params.tool_choice).toEqual({ type: 'tool', name: EXTRACT_TOOL_NAME });

    expect(result.path).toBe('ai');
    const repeating = result.fields.find((f) => f.type === 'repeating_group');
    expect(repeating?.columns?.map((c) => c.key)).toEqual(['item', 'pass', 'fail', 'comments']);
    const sig = result.fields.find((f) => f.label === 'Inspector signature');
    expect(sig?.confidence).toBeLessThan(0.65); // low-confidence, needs manual review
    expect(result.designNotes.length).toBeGreaterThan(0);
  });

  it('falls back to a ```json fence when tool_choice returns text', async () => {
    const pdf = await makeFlatPdf();
    const create = vi.fn().mockResolvedValue(jsonFenceResponse());
    const anthropic = { messages: { create } };

    const result = await extractForm(pdf, { fileName: 'flat.pdf', anthropic });

    expect(result.path).toBe('ai');
    expect(result.fields).toHaveLength(CHECKLIST_RESULT.fields.length);
    expect(result.fields.find((f) => f.type === 'repeating_group')).toBeTruthy();
  });

  it('errors when neither a tool_use block nor JSON is present', () => {
    const message: AnthropicMessage = { content: [{ type: 'text', text: 'I could not read this.' }] };
    expect(() => parseExtractionResponse(message)).toThrow(/extraction_failed/);
  });
});

describe('extractForm — fixedRows normalization', () => {
  const FIXED_ROWS = ['Engine oil level', 'Coolant level', 'Park brake'];

  function fixedRowsResponse(field: Record<string, unknown>): AnthropicMessage {
    return {
      content: [
        {
          type: 'tool_use',
          name: EXTRACT_TOOL_NAME,
          input: { fields: [field], designNotes: [] },
        },
      ],
    };
  }

  it('maps fixedRows through in order for a checklist table', async () => {
    const pdf = await makeFlatPdf();
    const create = vi.fn().mockResolvedValue(
      fixedRowsResponse({
        label: 'Pre-start checks',
        type: 'repeating_group',
        confidence: 0.9,
        fixedRows: FIXED_ROWS,
        columns: [
          { key: 'item', label: 'Item', type: 'text' },
          { key: 'ok', label: 'OK', type: 'boolean_yes_no' },
        ],
      }),
    );

    const result = await extractForm(pdf, { fileName: 'flat.pdf', anthropic: { messages: { create } } });

    expect(result.fields[0]?.fixedRows).toEqual(FIXED_ROWS);
  });

  it('normalizes an absent fixedRows to undefined', async () => {
    const pdf = await makeFlatPdf();
    const create = vi.fn().mockResolvedValue(toolUseResponse());

    const result = await extractForm(pdf, { fileName: 'flat.pdf', anthropic: { messages: { create } } });

    expect(result.fields.every((f) => f.fixedRows === undefined)).toBe(true);
  });

  it('normalizes an empty fixedRows array to undefined', async () => {
    const pdf = await makeFlatPdf();
    const create = vi.fn().mockResolvedValue(
      fixedRowsResponse({
        label: 'Open entry table',
        type: 'repeating_group',
        confidence: 0.85,
        fixedRows: [],
        columns: [{ key: 'item', label: 'Item', type: 'text' }],
      }),
    );

    const result = await extractForm(pdf, { fileName: 'flat.pdf', anthropic: { messages: { create } } });

    expect(result.fields[0]?.fixedRows).toBeUndefined();
  });

  it('prepends a synthetic text label column when columns[0] is not text', async () => {
    const pdf = await makeFlatPdf();
    const create = vi.fn().mockResolvedValue(
      fixedRowsResponse({
        label: 'Pre-start checks',
        type: 'repeating_group',
        confidence: 0.9,
        fixedRows: FIXED_ROWS,
        columns: [
          { key: 'ok', label: 'OK', type: 'boolean_yes_no' },
          { key: 'comments', label: 'Comments', type: 'text' },
        ],
      }),
    );

    const result = await extractForm(pdf, { fileName: 'flat.pdf', anthropic: { messages: { create } } });

    const columns = result.fields[0]?.columns;
    expect(columns?.[0]).toEqual({ key: 'item', label: 'Item', type: 'text' });
    expect(columns?.map((c) => c.key)).toEqual(['item', 'ok', 'comments']);
    expect(result.fields[0]?.fixedRows).toEqual(FIXED_ROWS);
  });

  it('drops the model-emitted required flag on a fixedRows checklist (AE5 — the client default owns it)', async () => {
    const pdf = await makeFlatPdf();
    const create = vi.fn().mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          name: EXTRACT_TOOL_NAME,
          input: {
            fields: [
              {
                label: 'Pre-start checks',
                type: 'repeating_group',
                confidence: 0.9,
                required: false,
                fixedRows: FIXED_ROWS,
                columns: [
                  { key: 'item', label: 'Item', type: 'text' },
                  { key: 'ok', label: 'OK', type: 'boolean_yes_no' },
                ],
              },
              // A plain field keeps whatever the model said.
              { label: 'Site name', type: 'text', confidence: 0.95, required: false },
            ],
            designNotes: [],
          },
        },
      ],
    } satisfies AnthropicMessage);

    const result = await extractForm(pdf, { fileName: 'flat.pdf', anthropic: { messages: { create } } });

    expect('required' in result.fields[0]!).toBe(false);
    expect(result.fields[1]?.required).toBe(false);
  });

  it('uniquifies the synthetic label column key against a model column keyed "item" at a later index', async () => {
    const pdf = await makeFlatPdf();
    const create = vi.fn().mockResolvedValue(
      fixedRowsResponse({
        label: 'Pre-start checks',
        type: 'repeating_group',
        confidence: 0.9,
        fixedRows: FIXED_ROWS,
        columns: [
          { key: 'ok', label: 'OK', type: 'boolean_yes_no' },
          { key: 'item', label: 'Item description', type: 'text' },
        ],
      }),
    );

    const result = await extractForm(pdf, { fileName: 'flat.pdf', anthropic: { messages: { create } } });

    const columns = result.fields[0]?.columns;
    // A duplicate 'item' key would make the seeded label readable as an answer.
    expect(columns?.[0]).toEqual({ key: 'item_label', label: 'Item', type: 'text' });
    expect(columns?.map((c) => c.key)).toEqual(['item_label', 'ok', 'item']);
  });

  it('prepends a synthetic label column when fixedRows arrives with no columns at all', async () => {
    const pdf = await makeFlatPdf();
    const create = vi.fn().mockResolvedValue(
      fixedRowsResponse({
        label: 'Pre-start checks',
        type: 'repeating_group',
        confidence: 0.9,
        fixedRows: FIXED_ROWS,
      }),
    );

    const result = await extractForm(pdf, { fileName: 'flat.pdf', anthropic: { messages: { create } } });

    expect(result.fields[0]?.columns?.[0]).toEqual({ key: 'item', label: 'Item', type: 'text' });
    expect(result.fields[0]?.fixedRows).toEqual(FIXED_ROWS);
  });
});
