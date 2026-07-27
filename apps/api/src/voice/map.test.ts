import { describe, expect, it, vi } from 'vitest';
import type { FormField } from '@formai/shared';
import type { AnthropicMessage } from '../pdf/index.js';
import {
  SMART_FILL_MAX_TOKENS,
  SmartFillError,
  mapTranscriptToFields,
} from './map.js';
import { SMART_FILL_TOOL_NAME } from './tool-schema.js';

/** One of each mappable shape, plus every shape v1 deliberately skips. */
const FIELDS: FormField[] = [
  { id: 'site', type: 'text', label: 'Site name', required: true, source: 'built' },
  { id: 'notes', type: 'textarea', label: 'Notes', required: false, source: 'built' },
  { id: 'crew', type: 'number', label: 'Crew size', required: false, source: 'built' },
  { id: 'day', type: 'date', label: 'Inspection date', required: false, source: 'built' },
  { id: 'ppe', type: 'boolean_yes_no', label: 'PPE worn?', required: true, source: 'built' },
  {
    id: 'shift',
    type: 'dropdown',
    label: 'Shift',
    required: false,
    source: 'built',
    options: ['Day', 'Night'],
  },
  {
    id: 'hazards',
    type: 'checkbox_group',
    label: 'Hazards present',
    required: false,
    source: 'built',
    selectionType: 'multiple',
    options: ['Dust', 'Noise', 'Heat'],
  },
  {
    id: 'weather',
    type: 'checkbox_group',
    label: 'Weather',
    required: false,
    source: 'built',
    selectionType: 'single',
    options: ['Fine', 'Rain'],
  },
  { id: 'sig', type: 'signature', label: 'Supervisor signature', required: true, source: 'built' },
  { id: 'photo', type: 'file_upload', label: 'Site photo', required: false, source: 'built' },
  { id: 'part_b', type: 'section_header', label: 'Part B', required: false, source: 'built' },
  {
    id: 'checks',
    type: 'repeating_group',
    label: 'Daily checks',
    required: false,
    source: 'built',
    columns: [
      { key: 'item', label: 'Item', type: 'text' },
      { key: 'ok', label: 'OK', type: 'boolean_yes_no' },
    ],
  },
];

const TRANSCRIPT = 'Warehouse B, crew of four, day shift, PPE was worn, dust and noise about.';

function toolUse(input: unknown): AnthropicMessage {
  return { content: [{ type: 'tool_use', name: SMART_FILL_TOOL_NAME, input }] };
}

function jsonFence(payload: unknown): AnthropicMessage {
  return {
    content: [
      {
        type: 'text',
        text: `Here is what I heard:\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`,
      },
    ],
  };
}

function clientReturning(message: AnthropicMessage) {
  const create = vi.fn().mockResolvedValue(message);
  return { anthropic: { messages: { create } }, create };
}

/** Map `FIELDS` against one canned model reply. */
function run(message: AnthropicMessage, fields: FormField[] = FIELDS) {
  const { anthropic, create } = clientReturning(message);
  return { result: mapTranscriptToFields({ transcript: TRANSCRIPT, fields, anthropic }), create };
}

describe('mapTranscriptToFields — the happy paths', () => {
  it('reads mappings from a tool_use block', async () => {
    const { result } = run(
      toolUse({
        mappings: [
          { fieldId: 'site', value: 'Warehouse B', confidence: 0.95 },
          { fieldId: 'crew', value: 4, confidence: 0.9 },
          { fieldId: 'shift', value: 'Day', confidence: 0.88 },
          { fieldId: 'ppe', value: true, confidence: 0.99 },
          { fieldId: 'hazards', value: ['Dust', 'Noise'], confidence: 0.7 },
        ],
        unmapped: ['about'],
      }),
    );
    expect(await result).toEqual({
      mappings: [
        { fieldId: 'site', value: 'Warehouse B', confidence: 0.95 },
        { fieldId: 'crew', value: 4, confidence: 0.9 },
        { fieldId: 'shift', value: 'Day', confidence: 0.88 },
        { fieldId: 'ppe', value: true, confidence: 0.99 },
        { fieldId: 'hazards', value: ['Dust', 'Noise'], confidence: 0.7 },
      ],
      unmapped: ['about'],
    });
  });

  it('falls back to a ```json fence when the forced tool call did not happen', async () => {
    const { result } = run(
      jsonFence({ mappings: [{ fieldId: 'site', value: 'Warehouse B', confidence: 0.8 }] }),
    );
    expect((await result).mappings).toEqual([
      { fieldId: 'site', value: 'Warehouse B', confidence: 0.8 },
    ]);
  });

  it('omits `unmapped` entirely when nothing was left over', async () => {
    const { result } = run(toolUse({ mappings: [], unmapped: ['   ', 42] }));
    expect(await result).toEqual({ mappings: [] });
  });

  it('forces the tool call and constrains the schema to the mappable fields', async () => {
    const { result, create } = run(toolUse({ mappings: [] }));
    await result;

    const params = create.mock.calls[0]![0] as {
      max_tokens: number;
      tool_choice: { type: string; name: string };
      tools: Array<{ name: string; input_schema: Record<string, unknown> }>;
      messages: Array<{ content: Array<{ text: string }> }>;
    };
    expect(params.tool_choice).toEqual({ type: 'tool', name: SMART_FILL_TOOL_NAME });
    expect(params.max_tokens).toBe(SMART_FILL_MAX_TOKENS);
    expect(params.tools).toHaveLength(1);
    expect(params.tools[0]!.name).toBe(SMART_FILL_TOOL_NAME);
    // The transcript is passed as text, delimited — never as audio.
    expect(params.messages[0]!.content[0]!.text).toContain(`<transcript>\n${TRANSCRIPT}`);

    const schema = params.tools[0]!.input_schema as {
      properties: { mappings: { items: { anyOf: Array<Record<string, never>> } } };
    };
    const variants = schema.properties.mappings.items.anyOf as unknown as Array<{
      properties: { fieldId: { enum: string[] }; value: Record<string, unknown> };
    }>;
    const targeted = variants.map((v) => v.properties.fieldId.enum[0]);
    // signature / file_upload / section_header / repeating_group are out of
    // scope for v1 and must not even be offered as targets.
    expect(targeted).toEqual(['site', 'notes', 'crew', 'day', 'ppe', 'shift', 'hazards', 'weather']);

    const byId = new Map(targeted.map((id, i) => [id, variants[i]!.properties.value]));
    expect(byId.get('shift')).toMatchObject({ type: 'string', enum: ['Day', 'Night'] });
    expect(byId.get('crew')).toMatchObject({ type: 'number' });
    expect(byId.get('ppe')).toMatchObject({ type: 'boolean' });
    expect(byId.get('hazards')).toMatchObject({
      type: 'array',
      items: { type: 'string', enum: ['Dust', 'Noise', 'Heat'] },
    });
    // A single-select group cannot be handed two answers.
    expect(byId.get('weather')).toMatchObject({ maxItems: 1 });
  });
});

describe('mapTranscriptToFields — no AI call is made', () => {
  it('returns an empty result when the form has nothing a sentence can answer', async () => {
    const unanswerable = FIELDS.filter((f) =>
      ['signature', 'file_upload', 'section_header', 'repeating_group'].includes(f.type),
    );
    const { anthropic, create } = clientReturning(toolUse({ mappings: [] }));
    const result = await mapTranscriptToFields({
      transcript: TRANSCRIPT,
      fields: unanswerable,
      anthropic,
    });
    expect(result).toEqual({ mappings: [] });
    expect(create).not.toHaveBeenCalled();
  });

  it('returns an empty result for a whitespace-only transcript', async () => {
    const { anthropic, create } = clientReturning(toolUse({ mappings: [] }));
    const result = await mapTranscriptToFields({ transcript: '   \n ', fields: FIELDS, anthropic });
    expect(result).toEqual({ mappings: [] });
    expect(create).not.toHaveBeenCalled();
  });

  it('throws smart_fill_unavailable when no client is configured', async () => {
    await expect(
      mapTranscriptToFields({ transcript: TRANSCRIPT, fields: FIELDS }),
    ).rejects.toMatchObject({ code: 'smart_fill_unavailable' });
    await expect(
      mapTranscriptToFields({ transcript: TRANSCRIPT, fields: FIELDS, anthropic: null }),
    ).rejects.toBeInstanceOf(SmartFillError);
  });
});

/**
 * The model's output is untrusted input. Every case below is something a real
 * model does occasionally and an attacker could aim for deliberately by
 * speaking into the transcript — none of it may reach a form.
 */
describe('mapTranscriptToFields — adversarial model output', () => {
  async function mappings(payload: unknown) {
    const { result } = run(toolUse(payload));
    return (await result).mappings;
  }

  it('drops a mapping onto a field id this form does not have', async () => {
    expect(
      await mappings({
        mappings: [
          { fieldId: 'admin_override', value: 'yes', confidence: 1 },
          { fieldId: 'site', value: 'Warehouse B', confidence: 0.9 },
        ],
      }),
    ).toEqual([{ fieldId: 'site', value: 'Warehouse B', confidence: 0.9 }]);
  });

  it('drops a mapping onto a field that was never offered as a target', async () => {
    expect(
      await mappings({
        mappings: [
          { fieldId: 'sig', value: 'Jane Doe', confidence: 1 },
          { fieldId: 'checks', value: [{ item: 'Oil', ok: true }], confidence: 1 },
          { fieldId: 'part_b', value: 'x', confidence: 1 },
        ],
      }),
    ).toEqual([]);
  });

  it('drops values whose type does not match the field', async () => {
    expect(
      await mappings({
        mappings: [
          { fieldId: 'crew', value: '4', confidence: 0.9 },
          { fieldId: 'ppe', value: 'yes', confidence: 0.9 },
          { fieldId: 'site', value: 12, confidence: 0.9 },
          { fieldId: 'hazards', value: 'Dust', confidence: 0.9 },
          { fieldId: 'day', value: null, confidence: 0.9 },
        ],
      }),
    ).toEqual([]);
  });

  /**
   * A date is the one string type where "not blank" is not enough. `2025-13-01`
   * is what a transposed day and month looks like, and the picker that renders
   * the field indexes a twelve-entry month table — it throws on the way past
   * twelve, taking the whole fill page and every unsaved answer with it.
   */
  it('drops a date that is not a real calendar day', async () => {
    expect(
      await mappings({
        mappings: [
          { fieldId: 'day', value: '2025-13-01', confidence: 0.9 },
          { fieldId: 'day', value: '2025-00-05', confidence: 0.9 },
          { fieldId: 'day', value: '2025-02-31', confidence: 0.9 },
          { fieldId: 'day', value: '2026-02-29', confidence: 0.9 },
        ],
      }),
    ).toEqual([]);
  });

  it('drops a date the picker cannot parse, however confidently it was offered', async () => {
    expect(
      await mappings({
        mappings: [
          { fieldId: 'day', value: 'middle of next week', confidence: 1 },
          { fieldId: 'day', value: 'March 5, 2025', confidence: 1 },
          { fieldId: 'day', value: '05/03/2025', confidence: 1 },
          { fieldId: 'day', value: '2025-3-5', confidence: 1 },
          { fieldId: 'day', value: ' 2025-03-05 ', confidence: 1 },
        ],
      }),
    ).toEqual([]);
  });

  it('keeps a well-formed date, including a real leap day', async () => {
    expect(
      await mappings({ mappings: [{ fieldId: 'day', value: '2028-02-29', confidence: 0.9 }] }),
    ).toEqual([{ fieldId: 'day', value: '2028-02-29', confidence: 0.9 }]);
  });

  /**
   * The fence path is why the check lives in `coerceValue` rather than in the
   * tool schema: nothing validates what comes out of a ```json block.
   */
  it('drops an out-of-range date arriving through the fenced-JSON fallback', async () => {
    const { result } = run(
      jsonFence({ mappings: [{ fieldId: 'day', value: '2025-13-01', confidence: 0.9 }] }),
    );
    expect((await result).mappings).toEqual([]);
  });

  it('drops a choice value that is not one of the field’s options', async () => {
    expect(
      await mappings({ mappings: [{ fieldId: 'shift', value: 'Swing', confidence: 0.9 }] }),
    ).toEqual([]);
  });

  it('drops the whole selection when one member is off-enum', async () => {
    expect(
      await mappings({
        mappings: [{ fieldId: 'hazards', value: ['Dust', 'Radiation'], confidence: 0.9 }],
      }),
    ).toEqual([]);
  });

  it('drops a multi-option answer to a single-select group, and an empty selection', async () => {
    expect(
      await mappings({
        mappings: [
          { fieldId: 'weather', value: ['Fine', 'Rain'], confidence: 0.9 },
          { fieldId: 'hazards', value: [], confidence: 0.9 },
        ],
      }),
    ).toEqual([]);
  });

  it('drops a blank string answer rather than staging it over what the filler typed', async () => {
    expect(
      await mappings({
        mappings: [
          { fieldId: 'site', value: '   ', confidence: 0.9 },
          { fieldId: 'notes', value: '', confidence: 0.9 },
        ],
      }),
    ).toEqual([]);
  });

  it('clamps confidence into [0,1] and defaults an unusable one', async () => {
    expect(
      await mappings({
        mappings: [
          { fieldId: 'site', value: 'A', confidence: 7 },
          { fieldId: 'notes', value: 'B', confidence: -3 },
          { fieldId: 'day', value: '2026-07-27', confidence: 'high' },
        ],
      }),
    ).toEqual([
      { fieldId: 'site', value: 'A', confidence: 1 },
      { fieldId: 'notes', value: 'B', confidence: 0 },
      { fieldId: 'day', value: '2026-07-27', confidence: 0.5 },
    ]);
  });

  it('keeps the first of two mappings for the same field', async () => {
    expect(
      await mappings({
        mappings: [
          { fieldId: 'site', value: 'Warehouse B', confidence: 0.9 },
          { fieldId: 'site', value: 'Somewhere else', confidence: 1 },
        ],
      }),
    ).toEqual([{ fieldId: 'site', value: 'Warehouse B', confidence: 0.9 }]);
  });

  it('survives structurally junk entries and a junk mappings list', async () => {
    expect(
      await mappings({
        mappings: [null, 'site', 42, [], { value: 'no id', confidence: 1 }, { fieldId: 7 }],
      }),
    ).toEqual([]);
    expect(await mappings({ mappings: 'everything' })).toEqual([]);
    expect(await mappings({})).toEqual([]);
  });

  it('throws smart_fill_failed when the reply carries neither a tool block nor JSON', async () => {
    const { result } = run({ content: [{ type: 'text', text: 'I could not hear that.' }] });
    await expect(result).rejects.toMatchObject({ code: 'smart_fill_failed' });
  });

  it('throws smart_fill_failed on an empty response', async () => {
    const { result } = run({ content: [] });
    await expect(result).rejects.toBeInstanceOf(SmartFillError);
  });
});
