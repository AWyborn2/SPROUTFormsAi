/**
 * The secondary-extraction pass (`auditForm`).
 *
 * The properties that make it a trustworthy review aid rather than noise: an
 * AcroForm PDF is answered without an AI call at all (every widget was already
 * a field), a flat PDF with no key fails the same 422 way extraction does, and
 * a box the first pass already captured is never re-reported as missed — even
 * when the model spells its label differently.
 */
import { describe, expect, it, vi } from 'vitest';
import { auditForm, parseAuditResponse } from './audit.js';
import type { AnthropicMessage } from './extract.js';
import { AUDIT_TOOL_NAME } from './tool-schema.js';
import { makeAcroFormPdf, makeFlatPdf } from './test-pdfs.js';

function toolResponse(missedInputs: unknown): AnthropicMessage {
  return { content: [{ type: 'tool_use', name: AUDIT_TOOL_NAME, input: { missedInputs } }] };
}

describe('parseAuditResponse', () => {
  it('reads the tool_use block', () => {
    expect(parseAuditResponse(toolResponse([{ label: 'Date', type: 'date' }]))).toEqual([
      { label: 'Date', type: 'date' },
    ]);
  });

  it('falls back to a ```json fence in text', () => {
    const msg: AnthropicMessage = {
      content: [{ type: 'text', text: '```json\n{"missedInputs":[{"label":"Sig","type":"text"}]}\n```' }],
    };
    expect(parseAuditResponse(msg)).toEqual([{ label: 'Sig', type: 'text' }]);
  });

  it('is empty when neither a tool_use block nor JSON is present', () => {
    expect(parseAuditResponse({ content: [{ type: 'text', text: 'nothing here' }] })).toEqual([]);
  });

  it('drops a blank label, coerces an unknown type to text, and ignores a bad page', () => {
    const msg = toolResponse([
      { label: '   ', type: 'text' },
      { label: 'Witness', type: 'not_a_type', page: 0 },
    ]);
    expect(parseAuditResponse(msg)).toEqual([{ label: 'Witness', type: 'text' }]);
  });
});

describe('auditForm', () => {
  it('returns nothing for an AcroForm PDF, without calling the model', async () => {
    const create = vi.fn();
    const pdf = await makeAcroFormPdf();
    const result = await auditForm(pdf, {
      fileName: 'a.pdf',
      knownLabels: [],
      anthropic: { messages: { create } },
    });
    expect(result).toEqual({ missedInputs: [] });
    expect(create).not.toHaveBeenCalled();
  });

  it('throws extraction_unavailable for a flat PDF with no client', async () => {
    const pdf = await makeFlatPdf();
    await expect(auditForm(pdf, { fileName: 'a.pdf', knownLabels: [] })).rejects.toThrow(
      /extraction_unavailable/,
    );
  });

  it('returns the missed boxes a flat-PDF audit found', async () => {
    const create = vi
      .fn()
      .mockResolvedValue(
        toolResponse([{ label: 'Inspector signature', type: 'text', page: 1, note: 'blank line' }]),
      );
    const pdf = await makeFlatPdf();
    const result = await auditForm(pdf, {
      fileName: 'a.pdf',
      knownLabels: ['Site name'],
      anthropic: { messages: { create } },
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.missedInputs).toEqual([
      { label: 'Inspector signature', type: 'text', page: 1, note: 'blank line' },
    ]);
  });

  it('drops a box that matches a captured label despite case and punctuation', async () => {
    const create = vi.fn().mockResolvedValue(
      toolResponse([
        { label: 'Site Name:', type: 'text' }, // already captured as "site name"
        { label: 'Inspector signature', type: 'text' },
      ]),
    );
    const pdf = await makeFlatPdf();
    const result = await auditForm(pdf, {
      fileName: 'a.pdf',
      knownLabels: ['site name'],
      anthropic: { messages: { create } },
    });
    expect(result.missedInputs.map((m) => m.label)).toEqual(['Inspector signature']);
  });
});
