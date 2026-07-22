import { describe, expect, it, vi } from 'vitest';
import type { AnthropicMessage } from './extract.js';
import { EXTRACTION_MAX_TOKENS, extractForm, parseExtractionResponse } from './extract.js';
import { EXTRACT_TOOL_NAME } from './tool-schema.js';
import { makeAcroFormPdf, makeFlatPdf, makeMultiPageAcroFormPdf } from './test-pdfs.js';

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

describe('extractForm — answerSets proposals', () => {
  function oneFieldResponse(field: Record<string, unknown>): AnthropicMessage {
    return {
      content: [
        { type: 'tool_use', name: EXTRACT_TOOL_NAME, input: { fields: [field], designNotes: [] } },
      ],
    };
  }

  async function extractOne(field: Record<string, unknown>) {
    const pdf = await makeFlatPdf();
    const create = vi.fn().mockResolvedValue(oneFieldResponse(field));
    const result = await extractForm(pdf, {
      fileName: 'flat.pdf',
      anthropic: { messages: { create } },
    });
    return result.fields[0]!;
  }

  const OK_NA_COLUMNS = [
    { key: 'item', label: 'Item', type: 'text' },
    { key: 'ok', label: 'OK', type: 'boolean_yes_no' },
    { key: 'na', label: 'NA', type: 'boolean_yes_no' },
    { key: 'comments', label: 'Comments', type: 'text' },
  ];

  it('keeps an OK/NA proposal as one two-column answer set', async () => {
    const field = await extractOne({
      label: 'Pre-start checks',
      type: 'repeating_group',
      confidence: 0.9,
      columns: OK_NA_COLUMNS,
      answerSets: [{ key: 'status', label: 'Status', columnKeys: ['ok', 'na'], required: true }],
    });

    expect(field.answerSets).toHaveLength(1);
    expect(field.answerSets?.[0]?.key).toBe('status');
    expect(field.answerSets?.[0]?.label).toBe('Status');
    expect(field.answerSets?.[0]?.columnKeys).toEqual(['ok', 'na']);
    expect(field.answerSets?.[0]?.required).toBe(true);
  });

  it('keeps a ✓ / × / N-A proposal as one three-column answer set', async () => {
    const field = await extractOne({
      label: 'Competency assessment',
      type: 'repeating_group',
      confidence: 0.88,
      columns: [
        { key: 'item', label: 'Task', type: 'text' },
        { key: 'tick', label: '✓', type: 'boolean_yes_no' },
        { key: 'cross', label: '×', type: 'boolean_yes_no' },
        { key: 'na', label: 'N-A', type: 'boolean_yes_no' },
      ],
      answerSets: [{ key: 'outcome', columnKeys: ['tick', 'cross', 'na'] }],
    });

    expect(field.answerSets).toHaveLength(1);
    expect(field.answerSets?.[0]?.columnKeys).toEqual(['tick', 'cross', 'na']);
  });

  it('drops a set naming a column absent from columns, still parsing the field', async () => {
    const field = await extractOne({
      label: 'Pre-start checks',
      type: 'repeating_group',
      confidence: 0.9,
      columns: OK_NA_COLUMNS,
      answerSets: [{ key: 'status', columnKeys: ['ok', 'nope'] }],
    });

    expect(field.answerSets).toBeUndefined();
    expect(field.columns?.map((c) => c.key)).toEqual(['item', 'ok', 'na', 'comments']);
  });

  it('drops a set that names the label column', async () => {
    const field = await extractOne({
      label: 'Pre-start checks',
      type: 'repeating_group',
      confidence: 0.9,
      columns: OK_NA_COLUMNS,
      answerSets: [{ key: 'status', columnKeys: ['item', 'ok'] }],
    });

    expect(field.answerSets).toBeUndefined();
  });

  it('drops a set with a single column key', async () => {
    const field = await extractOne({
      label: 'Pre-start checks',
      type: 'repeating_group',
      confidence: 0.9,
      columns: OK_NA_COLUMNS,
      answerSets: [{ key: 'status', columnKeys: ['ok'] }],
    });

    expect(field.answerSets).toBeUndefined();
  });

  it('keeps at most one of two sets claiming the same column', async () => {
    const field = await extractOne({
      label: 'Pre-start checks',
      type: 'repeating_group',
      confidence: 0.9,
      columns: OK_NA_COLUMNS,
      answerSets: [
        { key: 'a', columnKeys: ['ok', 'na'] },
        { key: 'b', columnKeys: ['na', 'comments'] },
      ],
    });

    expect(field.answerSets).toHaveLength(1);
    expect(field.answerSets?.[0]?.key).toBe('a');
  });

  it('leaves answerSets absent when the model proposes none', async () => {
    const pdf = await makeFlatPdf();
    const create = vi.fn().mockResolvedValue(toolUseResponse());

    const result = await extractForm(pdf, { fileName: 'flat.pdf', anthropic: { messages: { create } } });

    expect(result.fields.every((f) => f.answerSets === undefined)).toBe(true);
  });

  it('leaves the AcroForm path untouched — scalar fields carry no answerSets', async () => {
    const pdf = await makeAcroFormPdf();
    const result = await extractForm(pdf, { fileName: 'acro.pdf' });

    expect(result.fields.every((f) => f.answerSets === undefined)).toBe(true);
  });
});

describe('extractForm — recorded page index', () => {
  it('records the page a widget actually sits on, not page 0', async () => {
    const pdf = await makeMultiPageAcroFormPdf();

    const result = await extractForm(pdf, { fileName: 'multipage.pdf' });

    const assessor = result.fields.find((f) => f.label === 'assessor_name');
    expect(assessor?.sourcePosition?.page).toBe(2);
  });

  it("records that page's dimensions rather than the first page's", async () => {
    const pdf = await makeMultiPageAcroFormPdf();

    const result = await extractForm(pdf, { fileName: 'multipage.pdf' });

    const assessor = result.fields.find((f) => f.label === 'assessor_name');
    // The fixture's page 2 is landscape 900x500 while page 0 is portrait
    // 600x800, so this fails loudly if dimensions are read from the first page.
    // The dozer assessment genuinely mixes both orientations in one file.
    expect(assessor?.sourcePosition?.pageWidth).toBe(900);
    expect(assessor?.sourcePosition?.pageHeight).toBe(500);
  });

  it('still resolves a single-page AcroForm to page 0', async () => {
    const pdf = await makeAcroFormPdf();

    const result = await extractForm(pdf, { fileName: 'acro.pdf' });

    expect(result.fields.every((f) => f.sourcePosition?.page === 0)).toBe(true);
  });
});
