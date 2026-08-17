import { describe, expect, it, vi } from 'vitest';
import type { AnthropicMessage } from './extract.js';
import {
  EXTRACTION_MAX_TOKENS,
  EXTRACTION_PAGE_BATCH_SIZE,
  extractForm,
  parseExtractionResponse,
} from './extract.js';
import { EXTRACT_TOOL_NAME } from './tool-schema.js';
import {
  makeAcroFormPdf,
  makeAcroFormPdfWithoutPageRef,
  makeFlatPdf,
  makeMultiPageAcroFormPdf,
  makeMultiPageFlatPdf,
} from './test-pdfs.js';

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
    content: [{ type: 'tool_use', name: EXTRACT_TOOL_NAME, input: CHECKLIST_RESULT }],
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
    const message: AnthropicMessage = {
      content: [{ type: 'text', text: 'I could not read this.' }],
    };
    expect(() => parseExtractionResponse(message)).toThrow(/extraction_failed/);
  });
});

describe('extractForm — AI path page batching', () => {
  /** A tool_use response carrying one text field per label. */
  function fieldsResponse(labels: string[]): AnthropicMessage {
    return {
      content: [
        {
          type: 'tool_use',
          name: EXTRACT_TOOL_NAME,
          input: {
            fields: labels.map((label) => ({ label, type: 'text', confidence: 0.9 })),
            designNotes: [],
          },
        },
      ],
    };
  }

  it('leaves a document no longer than one group as a single call', async () => {
    const pdf = await makeMultiPageFlatPdf(EXTRACTION_PAGE_BATCH_SIZE);
    const create = vi.fn().mockResolvedValue(fieldsResponse(['Only field']));

    const result = await extractForm(pdf, {
      fileName: 'short.pdf',
      anthropic: { messages: { create } },
    });

    expect(create).toHaveBeenCalledTimes(1);
    // No batching note when the whole document fits in one group.
    expect(result.designNotes.some((n) => /page-groups/.test(n))).toBe(false);
    expect(result.fields.map((f) => f.label)).toEqual(['Only field']);
  });

  it('splits a longer document into groups and merges the fields in page order', async () => {
    const pdf = await makeMultiPageFlatPdf(5); // batchSize 2 → 3 groups
    const create = vi
      .fn()
      .mockResolvedValueOnce(fieldsResponse(['A1', 'A2']))
      .mockResolvedValueOnce(fieldsResponse(['B1']))
      .mockResolvedValueOnce(fieldsResponse(['C1', 'C2']));

    const result = await extractForm(pdf, {
      fileName: 'long.pdf',
      anthropic: { messages: { create } },
      pageBatchSize: 2,
    });

    expect(create).toHaveBeenCalledTimes(3);
    expect(result.pageCount).toBe(5);
    expect(result.fields.map((f) => f.label)).toEqual(['A1', 'A2', 'B1', 'C1', 'C2']);
    // Ids are re-sequenced globally so nothing collides across groups.
    expect(result.fields.map((f) => f.id)).toEqual(['ai_1', 'ai_2', 'ai_3', 'ai_4', 'ai_5']);
    expect(result.designNotes.some((n) => /read in 3 page-groups/.test(n))).toBe(true);
  });

  it('skips a failed group with a note naming the page range, keeping the rest', async () => {
    const pdf = await makeMultiPageFlatPdf(4); // batchSize 2 → 2 groups
    const create = vi
      .fn()
      .mockResolvedValueOnce(fieldsResponse(['A1', 'A2']))
      .mockRejectedValueOnce(new Error('boom'));

    const result = await extractForm(pdf, {
      fileName: 'partial.pdf',
      anthropic: { messages: { create } },
      pageBatchSize: 2,
    });

    expect(result.fields.map((f) => f.label)).toEqual(['A1', 'A2']);
    expect(result.designNotes.some((n) => /Pages 3–4 could not be extracted/.test(n))).toBe(true);
  });

  it('errors when every group fails, rather than returning an empty form', async () => {
    const pdf = await makeMultiPageFlatPdf(4); // batchSize 2 → 2 groups
    const create = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(
      extractForm(pdf, {
        fileName: 'all-fail.pdf',
        anthropic: { messages: { create } },
        pageBatchSize: 2,
      }),
    ).rejects.toThrow(/extraction_failed/);
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

    const result = await extractForm(pdf, {
      fileName: 'flat.pdf',
      anthropic: { messages: { create } },
    });

    expect(result.fields[0]?.fixedRows).toEqual(FIXED_ROWS);
  });

  it('normalizes an absent fixedRows to undefined', async () => {
    const pdf = await makeFlatPdf();
    const create = vi.fn().mockResolvedValue(toolUseResponse());

    const result = await extractForm(pdf, {
      fileName: 'flat.pdf',
      anthropic: { messages: { create } },
    });

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

    const result = await extractForm(pdf, {
      fileName: 'flat.pdf',
      anthropic: { messages: { create } },
    });

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

    const result = await extractForm(pdf, {
      fileName: 'flat.pdf',
      anthropic: { messages: { create } },
    });

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

    const result = await extractForm(pdf, {
      fileName: 'flat.pdf',
      anthropic: { messages: { create } },
    });

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

    const result = await extractForm(pdf, {
      fileName: 'flat.pdf',
      anthropic: { messages: { create } },
    });

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

    const result = await extractForm(pdf, {
      fileName: 'flat.pdf',
      anthropic: { messages: { create } },
    });

    expect(result.fields[0]?.columns?.[0]).toEqual({ key: 'item', label: 'Item', type: 'text' });
    expect(result.fields[0]?.fixedRows).toEqual(FIXED_ROWS);
  });
});

describe('extractForm — columnGroups (side-by-side checklist hint, U1)', () => {
  const SIX = ['a', 'b', 'c', 'd', 'e', 'f'];

  function fieldResponse(field: Record<string, unknown>): AnthropicMessage {
    return {
      content: [
        { type: 'tool_use', name: EXTRACT_TOOL_NAME, input: { fields: [field], designNotes: [] } },
      ],
    };
  }

  function checklist(extra: Record<string, unknown>) {
    return {
      label: 'Category A checks',
      type: 'repeating_group',
      confidence: 0.9,
      fixedRows: SIX,
      columns: [
        { key: 'item', label: 'Item', type: 'text' },
        { key: 'ok', label: 'OK', type: 'boolean_yes_no' },
        { key: 'na', label: 'NA', type: 'boolean_yes_no' },
      ],
      ...extra,
    };
  }

  async function extract(field: Record<string, unknown>) {
    const pdf = await makeFlatPdf();
    const create = vi.fn().mockResolvedValue(fieldResponse(field));
    return extractForm(pdf, { fileName: 'flat.pdf', anthropic: { messages: { create } } });
  }

  it('passes a valid columnGroups hint through', async () => {
    const result = await extract(checklist({ columnGroups: 3 }));
    expect(result.fields[0]?.columnGroups).toBe(3);
  });

  it('normalizes an absent, sub-2, or non-integer columnGroups to undefined', async () => {
    for (const value of [undefined, 0, 1, 2.5, 'three']) {
      const result = await extract(checklist(value === undefined ? {} : { columnGroups: value }));
      expect(result.fields[0]?.columnGroups).toBeUndefined();
    }
  });

  it('drops a hint that cannot hold — more groups than items would split into empty groups', async () => {
    const result = await extract(checklist({ fixedRows: ['a', 'b'], columnGroups: 3 }));
    expect(result.fields[0]?.columnGroups).toBeUndefined();
  });

  it('synthesises a designNote pointing the reviewer at the split control', async () => {
    const result = await extract(checklist({ columnGroups: 3 }));
    expect(result.designNotes.some((n) => /side-by-side groups/.test(n) && /split/.test(n))).toBe(
      true,
    );
  });

  it('adds no split note for a single-column checklist', async () => {
    const result = await extract(checklist({}));
    expect(result.designNotes.some((n) => /side-by-side/.test(n))).toBe(false);
  });

  it("preserves the model-emitted fixedRows order verbatim (column-major is the model's job)", async () => {
    const result = await extract(checklist({ columnGroups: 3 }));
    expect(result.fields[0]?.fixedRows).toEqual(SIX);
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

    const result = await extractForm(pdf, {
      fileName: 'flat.pdf',
      anthropic: { messages: { create } },
    });

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

  it('resolves the page from /Annots when the widget carries no /P', async () => {
    // /P is optional per the spec. Requiring it would silently drop the
    // position of every field in a producer that omits it — the answers simply
    // stop being drawn on export, with no error anywhere to notice.
    const pdf = await makeAcroFormPdfWithoutPageRef();

    const result = await extractForm(pdf, { fileName: 'no-page-ref.pdf' });

    const supplier = result.fields.find((f) => f.label === 'supplier_name');
    expect(supplier?.sourcePosition?.page).toBe(0);
    expect(supplier?.sourcePosition?.pageWidth).toBe(600);
  });
});

/**
 * `questionRef`, `coverSection` and the two matching sides all reach the model
 * as schema properties and all have to survive `normalizeField` to mean
 * anything. `questionRef` did not: it was asked for, documented at length in
 * the assessment profile, rendered by the review UI and resolved by
 * `linkOutcomeTargets` — and dropped at the one point every AI-extracted field
 * passes through, so no field could ever carry one. These pin all four, because
 * the failure is invisible from either end: the model returns the value and the
 * consumer finds nothing, with no error in between.
 */
describe('extractForm — assessment field properties survive normalization', () => {
  function fieldsResponse(fields: Record<string, unknown>[]): AnthropicMessage {
    return {
      content: [
        { type: 'tool_use', name: EXTRACT_TOOL_NAME, input: { fields, designNotes: [] } },
      ],
    };
  }

  async function extractOne(field: Record<string, unknown>) {
    const pdf = await makeFlatPdf();
    const create = vi.fn().mockResolvedValue(fieldsResponse([field]));
    const result = await extractForm(pdf, {
      fileName: 'flat.pdf',
      documentType: 'assessment',
      anthropic: { messages: { create } },
    });
    return result.fields[0];
  }

  it('carries questionRef through, so a question can be paired with its outcome box', async () => {
    const field = await extractOne({
      label: 'Q1. Three points of contact must be maintained?',
      type: 'radio',
      confidence: 0.95,
      options: ['True', 'False'],
      questionRef: 'Q1',
    });

    expect(field?.questionRef).toBe('Q1');
  });

  it('trims a padded questionRef, because the pairing matches character for character', async () => {
    const field = await extractOne({
      label: 'Outcome',
      type: 'check_cross',
      confidence: 0.9,
      questionRef: '  BBM Q3  ',
    });

    expect(field?.questionRef).toBe('BBM Q3');
  });

  it('drops a blank questionRef rather than carrying an empty pairing key', async () => {
    // An empty string would pair with every other empty string.
    const field = await extractOne({
      label: 'Outcome',
      type: 'check_cross',
      confidence: 0.9,
      questionRef: '   ',
    });

    expect(field?.questionRef).toBeUndefined();
  });

  it('carries a declared coverSection through', async () => {
    const field = await extractOne({
      label: 'Q50001782 Driver’s Licence C or higher class',
      type: 'check_cross',
      confidence: 0.9,
      coverSection: 'pathway_prerequisites',
    });

    expect(field?.coverSection).toBe('pathway_prerequisites');
  });

  it('drops an undeclared coverSection rather than inventing a fourth section', async () => {
    const field = await extractOne({
      label: 'Something',
      type: 'text',
      confidence: 0.9,
      coverSection: 'front_matter',
    });

    expect(field?.coverSection).toBeUndefined();
  });

  it('carries both matching sides through, in printed order', async () => {
    const field = await extractOne({
      label: 'Match the statement with the appropriate signage.',
      type: 'checkbox_group',
      selectionType: 'multiple',
      confidence: 0.8,
      matchLeft: ['Access is restricted', 'Contact the person on the sign', 'Hazard ahead'],
      matchRight: ['Sign photo — red pyramid', 'Sign photo — yellow cone', 'Sign photo — blue pyramid'],
    });

    expect(field?.matchLeft).toEqual([
      'Access is restricted',
      'Contact the person on the sign',
      'Hazard ahead',
    ]);
    expect(field?.matchRight).toHaveLength(3);
  });

  it('keeps a one-sided matching question one-sided, so the gap stays visible', async () => {
    // Seeding the missing side would make an unauthorable question look
    // authorable — the pair builder needs to know which case it is in.
    const field = await extractOne({
      label: 'Match the correct response with the horn signals.',
      type: 'checkbox_group',
      confidence: 0.7,
      matchLeft: ['3 horn blasts', '2 horn blasts', '1 horn blast'],
    });

    expect(field?.matchLeft).toHaveLength(3);
    expect(field?.matchRight).toBeUndefined();
  });

  it('drops blank entries and empty sides rather than carrying holes', async () => {
    const field = await extractOne({
      label: 'Match',
      type: 'checkbox_group',
      confidence: 0.7,
      matchLeft: ['One', '   ', 'Two'],
      matchRight: [],
    });

    expect(field?.matchLeft).toEqual(['One', 'Two']);
    expect(field?.matchRight).toBeUndefined();
  });

  it('leaves an ordinary field carrying none of them', async () => {
    const field = await extractOne({ label: 'Site name', type: 'text', confidence: 0.98 });

    expect(field?.questionRef).toBeUndefined();
    expect(field?.coverSection).toBeUndefined();
    expect(field?.matchLeft).toBeUndefined();
    expect(field?.matchRight).toBeUndefined();
  });

  /*
    Rule 18 — a short-answer question is a single free-text field with no
    options. The normalizer must carry a textarea question through as-is: never
    forcing options onto it, and still carrying its outcome-pairing ref. This is
    the code half of "NEVER invent options for an open question".
  */
  it('carries a short-answer textarea question through without inventing options', async () => {
    const field = await extractOne({
      label: 'What action would you take if you found a Category A fault?',
      type: 'textarea',
      confidence: 0.9,
      questionRef: 'Functional Tests Q3',
    });

    expect(field?.type).toBe('textarea');
    expect(field?.options).toBeUndefined();
    expect(field?.questionRef).toBe('Functional Tests Q3');
  });

  /*
    Failure mode (c) — a stem containing the word "match" over ordinary lettered
    choices is a `radio`, NOT a matching question. Rule 10 forbids emptying the
    options of a question that printed them; the code half is that the normalizer
    never strips options and never fabricates match sides, so a printed choice
    list always survives into an answerable question.
  */
  it('keeps a lettered choice question answerable even when its stem says "match"', async () => {
    const field = await extractOne({
      label: 'Match the description that best fits a Category A fault.',
      type: 'radio',
      confidence: 0.85,
      options: ['Immediate stop', 'Report at end of shift', 'Continue as normal'],
    });

    expect(field?.type).toBe('radio');
    expect(field?.options).toEqual(['Immediate stop', 'Report at end of shift', 'Continue as normal']);
    expect(field?.matchLeft).toBeUndefined();
    expect(field?.matchRight).toBeUndefined();
  });
});

/**
 * The page range every field came from.
 *
 * STAMPED, NOT ASKED FOR. A long paper is extracted a few pages at a time and
 * the splitter knows exactly which pages went into each call — so this is a
 * fact the pipeline already holds. Asking the model for it would put a
 * hallucinable number on the one thing that tells three character-identical
 * practical parts apart.
 *
 * The prompt says the range too, because the profile's rules lean on "guess
 * nothing you cannot see" and that instruction needs a reference point.
 */
describe('extractForm — page range stamping', () => {
  function toolResponseFor(labels: string[]): AnthropicMessage {
    return {
      content: [
        {
          type: 'tool_use',
          name: EXTRACT_TOOL_NAME,
          input: {
            fields: labels.map((label) => ({ label, type: 'text', confidence: 0.9 })),
            designNotes: [],
          },
        },
      ],
    };
  }

  it('stamps each field with the pages its own batch was given', async () => {
    // Six pages at two per batch: three calls, and each call's fields carry
    // that call's range rather than the document's.
    const pdf = await makeMultiPageFlatPdf(6);
    const create = vi
      .fn()
      .mockResolvedValueOnce(toolResponseFor(['a']))
      .mockResolvedValueOnce(toolResponseFor(['b']))
      .mockResolvedValueOnce(toolResponseFor(['c']));

    const result = await extractForm(pdf, {
      fileName: 'long.pdf',
      documentType: 'assessment',
      pageBatchSize: 2,
      anthropic: { messages: { create } },
    });

    expect(result.fields.map((f) => f.sourcePages)).toEqual([
      { from: 1, to: 2 },
      { from: 3, to: 4 },
      { from: 5, to: 6 },
    ]);
  });

  it('stamps the final short batch with the real last page, not the batch width', async () => {
    // Five pages at two per batch ends on a batch of one; a range of 5-6 on a
    // five-page document is a page that does not exist.
    const pdf = await makeMultiPageFlatPdf(5);
    const create = vi
      .fn()
      .mockResolvedValueOnce(toolResponseFor(['a']))
      .mockResolvedValueOnce(toolResponseFor(['b']))
      .mockResolvedValueOnce(toolResponseFor(['c']));

    const result = await extractForm(pdf, {
      fileName: 'long.pdf',
      pageBatchSize: 2,
      anthropic: { messages: { create } },
    });

    expect(result.fields.at(-1)?.sourcePages).toEqual({ from: 5, to: 5 });
  });

  it('tells the model which pages it is holding', async () => {
    // "Guess nothing you cannot see" needs a reference point, and the running
    // footer is the only in-document clue.
    const pdf = await makeMultiPageFlatPdf(6);
    const create = vi.fn().mockResolvedValue(toolResponseFor(['a']));

    await extractForm(pdf, {
      fileName: 'long.pdf',
      documentType: 'assessment',
      pageBatchSize: 2,
      anthropic: { messages: { create } },
    });

    const texts = create.mock.calls.map((c) => {
      const params = c[0] as { messages: { content: { type: string; text?: string }[] }[] };
      return params.messages[0]!.content.find((b) => b.type === 'text')?.text ?? '';
    });
    expect(texts[0]).toContain('pages 1-2 of a 6-page document');
    expect(texts[2]).toContain('pages 5-6 of a 6-page document');
  });

  it('leaves an unbatched document unstamped rather than claiming a range', async () => {
    // A short document goes through in one call with no split, so there is no
    // batch range to report — and a stamp of 1-N would be a fact nothing
    // established.
    const pdf = await makeFlatPdf();
    const create = vi.fn().mockResolvedValue(toolResponseFor(['a']));

    const result = await extractForm(pdf, {
      fileName: 'short.pdf',
      anthropic: { messages: { create } },
    });

    expect(result.fields[0]?.sourcePages).toBeUndefined();
  });
});
