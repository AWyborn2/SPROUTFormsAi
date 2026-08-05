/**
 * Reading an answer key off a printed guide.
 *
 * Every test here defends the same property from a different angle: NOTHING
 * REACHES A KEY THAT THE QUESTION DOES NOT OFFER. The model is reading a
 * scanned document under instruction to omit what it cannot see, and this
 * module is the layer that holds it to that — because a wrong key marks every
 * candidate wrong on a question they answered correctly, on a record that says
 * whether somebody may operate heavy machinery.
 */
import { describe, expect, it, vi } from 'vitest';
import { matchAnswerGuide, resolveOption, MATCH_TOOL_NAME } from './answer-guide.js';
import type { AnthropicMessage } from './extract.js';

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

const QUESTIONS = [
  { fieldId: 'q1', label: 'Before entering the footprint you must:', options: ['Isolate', 'Sound the horn', 'Wait'] },
  { fieldId: 'q2', label: 'An Out of Service tag may be removed by:', options: ['Anyone', 'The tag owner'] },
];

function toolResponse(input: unknown): AnthropicMessage {
  return { content: [{ type: 'tool_use', name: MATCH_TOOL_NAME, input }] };
}

function clientReturning(input: unknown) {
  const create = vi.fn().mockResolvedValue(toolResponse(input));
  return { create, anthropic: { messages: { create } } };
}

describe('resolveOption', () => {
  it('resolves an option quoted verbatim', () => {
    expect(resolveOption('Sound the horn', ['Isolate', 'Sound the horn'])).toBe('Sound the horn');
  });

  it('resolves a bare letter positionally', () => {
    // A guide prints "b)" far more often than it reprints the option text.
    expect(resolveOption('b', ['Isolate', 'Sound the horn'])).toBe('Sound the horn');
  });

  it('resolves text that drifted in case or punctuation', () => {
    expect(resolveOption('sound the horn.', ['Isolate', 'Sound the horn'])).toBe('Sound the horn');
  });

  it('prefers an exact option over a positional reading of it', () => {
    // A question whose options ARE single letters must not have "b" read as
    // "the second option" when "b" is itself an option.
    expect(resolveOption('b', ['a', 'b', 'c'])).toBe('b');
  });

  it('returns null rather than the nearest option', () => {
    expect(resolveOption('Purple', ['Isolate', 'Wait'])).toBeNull();
    expect(resolveOption('z', ['Isolate', 'Wait'])).toBeNull();
    expect(resolveOption('   ', ['Isolate'])).toBeNull();
  });
});

describe('matchAnswerGuide', () => {
  it('returns the resolved options per field', async () => {
    const { anthropic } = clientReturning({
      answers: [
        { fieldId: 'q1', correct: ['Isolate'] },
        { fieldId: 'q2', correct: ['The tag owner'] },
      ],
    });

    const result = await matchAnswerGuide(PDF, QUESTIONS, { anthropic });

    expect(result.answers).toEqual({ q1: ['Isolate'], q2: ['The tag owner'] });
    expect(result.notes).toEqual([]);
  });

  it('carries a multi-answer entry through as a set', async () => {
    const { anthropic } = clientReturning({
      answers: [{ fieldId: 'q1', correct: ['Isolate', 'Wait'] }],
    });

    const result = await matchAnswerGuide(PDF, QUESTIONS, { anthropic });
    expect(result.answers.q1).toEqual(['Isolate', 'Wait']);
  });

  it('LEAVES THE WHOLE QUESTION UNKEYED when one of its answers does not resolve', async () => {
    /*
      A partially-resolved key is an exact-set key missing an option, which
      fails every candidate who answers correctly just as surely as a wrong one
      does. Dropping the question costs one manual key instead.
    */
    const { anthropic } = clientReturning({
      answers: [{ fieldId: 'q1', correct: ['Isolate', 'Call the supervisor'] }],
    });

    const result = await matchAnswerGuide(PDF, QUESTIONS, { anthropic });

    expect(result.answers.q1).toBeUndefined();
    expect(result.notes[0]).toContain('"Call the supervisor"');
    expect(result.notes[0]).toContain('left unkeyed');
  });

  it('reports an answer for a question nobody asked about', async () => {
    // Silently discarding it would hide a guide read against the wrong tool.
    const { anthropic } = clientReturning({
      answers: [{ fieldId: 'q99', correct: ['Isolate'] }],
    });

    const result = await matchAnswerGuide(PDF, QUESTIONS, { anthropic });

    expect(result.answers).toEqual({});
    expect(result.notes[0]).toContain('"q99"');
  });

  it('omits a question the guide did not answer, rather than inventing one', async () => {
    const { anthropic } = clientReturning({ answers: [{ fieldId: 'q1', correct: ['Isolate'] }] });

    const result = await matchAnswerGuide(PDF, QUESTIONS, { anthropic });

    expect(Object.keys(result.answers)).toEqual(['q1']);
  });

  it('ignores an entry with no options at all', async () => {
    const { anthropic } = clientReturning({
      answers: [{ fieldId: 'q1', correct: [] }],
    });

    const result = await matchAnswerGuide(PDF, QUESTIONS, { anthropic });
    expect(result.answers).toEqual({});
  });

  it('deduplicates an option the guide listed twice', async () => {
    // The same correspondence twice is one correct answer; a repeated entry
    // would not change the set but would mislead anyone reading it.
    const { anthropic } = clientReturning({
      answers: [{ fieldId: 'q1', correct: ['Isolate', 'Isolate'] }],
    });

    const result = await matchAnswerGuide(PDF, QUESTIONS, { anthropic });
    expect(result.answers.q1).toEqual(['Isolate']);
  });

  it('passes the model’s own notes through', async () => {
    const { anthropic } = clientReturning({
      answers: [],
      notes: ['The guide does not cover the Raw Materials stream.'],
    });

    const result = await matchAnswerGuide(PDF, QUESTIONS, { anthropic });
    expect(result.notes).toContain('The guide does not cover the Raw Materials stream.');
  });

  it('survives a response carrying no tool call', async () => {
    const create = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'I could not read it.' }] });
    const result = await matchAnswerGuide(PDF, QUESTIONS, { anthropic: { messages: { create } } });

    expect(result.answers).toEqual({});
  });

  it('sends every question with its own options, and forces the tool call', async () => {
    // The whole design rests on the model matching by question TEXT rather than
    // by position, which it can only do if it is given the text.
    const { create, anthropic } = clientReturning({ answers: [] });

    await matchAnswerGuide(PDF, QUESTIONS, { anthropic });

    const params = create.mock.calls[0]![0] as {
      tool_choice: { type: string; name: string };
      messages: { content: { type: string; text?: string }[] }[];
    };
    expect(params.tool_choice).toEqual({ type: 'tool', name: MATCH_TOOL_NAME });
    const text = params.messages[0]!.content.find((b) => b.type === 'text')?.text ?? '';
    expect(text).toContain('Before entering the footprint you must:');
    expect(text).toContain('Sound the horn');
    expect(text).toContain('q2');
    expect(text).toContain('MATCH BY WHAT THE QUESTION SAYS, NOT BY ITS POSITION');
  });

  it('refuses without a client, distinguishably from a failure', async () => {
    // The route maps this to a 422 rather than a 500: a missing key is a
    // configuration state, not a fault.
    await expect(matchAnswerGuide(PDF, QUESTIONS, {})).rejects.toThrow('guide_match_unavailable');
  });

  it('does not call the model when there is nothing to match', async () => {
    const { create, anthropic } = clientReturning({ answers: [] });

    const result = await matchAnswerGuide(PDF, [], { anthropic });

    expect(result).toEqual({ answers: {}, notes: [] });
    expect(create).not.toHaveBeenCalled();
  });
});
