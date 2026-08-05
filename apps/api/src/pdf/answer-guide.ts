import type { AnthropicLike, AnthropicMessage } from './extract.js';

/**
 * Reading an answer key off a printed guide.
 *
 * A training authority's answer guide is a PDF: the same questions with the
 * correct choices ringed, ticked or listed. This reads one against questions
 * the builder already has, so an author confirms 31 answers instead of typing
 * them.
 *
 * IT MATCHES BY CONTENT, NEVER BY POSITION. The JSON path in the web app can
 * only align a guide by order within a section, and guards that with a count
 * gate. This path has something better available and uses it: the model is
 * given each question's own TEXT and its OPTIONS and is asked which options the
 * guide marks, so a guide that omits a question or prints them out of order
 * simply produces no answer for it rather than shifting every answer after it.
 *
 * NOTHING IS RESOLVED THAT THE QUESTION DOES NOT OFFER. Whatever the model
 * returns is matched back against the supplied options here, in code. An answer
 * that does not resolve is DROPPED and reported — never coerced to the nearest
 * option. A wrong key marks every candidate wrong on a question they answered
 * correctly, and on this document class that is a safety record.
 *
 * AND AN OMISSION IS THE CHEAP FAILURE. The prompt says so explicitly: a
 * question the guide does not clearly answer costs the author one manual key,
 * and a question it answers wrongly costs a candidate their competency. The
 * model is told to leave out anything it is not reading directly off the page.
 */

export const MATCH_TOOL_NAME = 'report_guide_answers';

/** One question, as the guide matcher is told about it. */
export interface GuideQuestion {
  fieldId: string;
  label: string;
  options: string[];
  /** The section heading it sits under, where there is one. Context only. */
  section?: string;
}

export interface GuideMatchResult {
  /** Resolved option values per field id. Only questions the guide answered. */
  answers: Record<string, string[]>;
  /** What was skipped and why. Never empty when something did not resolve. */
  notes: string[];
}

export const matchGuideAnswersTool = {
  name: MATCH_TOOL_NAME,
  description:
    'Report which of each question’s printed options the answer guide marks as correct. Omit any question the guide does not clearly answer.',
  input_schema: {
    type: 'object' as const,
    properties: {
      answers: {
        type: 'array',
        description:
          'One entry per question the guide ANSWERS. Omit a question entirely rather than guessing at it.',
        items: {
          type: 'object',
          properties: {
            fieldId: {
              type: 'string',
              description: 'The question’s id, exactly as given to you.',
            },
            correct: {
              type: 'array',
              items: { type: 'string' },
              description:
                'The correct options, copied VERBATIM from the option list you were given for this question — not paraphrased, and not the letter beside them. Where the guide marks several, list them all: marking is an exact set, so a missing one is as wrong as an extra one.',
            },
          },
          required: ['fieldId', 'correct'],
        },
      },
      notes: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Anything a reviewer should know: questions the guide covers ambiguously, answers that disagree with the printed options, sections the guide does not cover.',
      },
    },
    required: ['answers'],
  },
};

const PROMPT = [
  'The attached PDF is the ANSWER GUIDE for an assessment. Below is the list of questions as they',
  'were read from the assessment paper itself, each with its id and its printed options.',
  '',
  'For each question, decide which of ITS OWN OPTIONS the guide marks as correct, and report them',
  'copied verbatim from the list you were given.',
  '',
  'MATCH BY WHAT THE QUESTION SAYS, NOT BY ITS POSITION. The guide may print the questions in a',
  'different order, may number them differently, and may not cover all of them. Find the question',
  'the guide is answering by its TEXT.',
  '',
  'OMIT ANYTHING YOU ARE NOT READING DIRECTLY OFF THE PAGE. A question you leave out costs a person',
  'one answer to type. A question you answer wrongly is marked against every candidate who answers',
  'it correctly, on a record that says whether somebody may operate heavy machinery. If the guide is',
  'ambiguous, if its wording does not match any printed option, or if you are inferring the answer',
  'from your own knowledge of the subject rather than from the guide, leave the question out and say',
  'so in `notes`.',
  '',
  'Several options may be correct for one question. Report every one the guide marks — marking is an',
  'exact set, so a missing option fails the candidate exactly as an invented one does.',
  '',
  'QUESTIONS:',
].join('\n');

function questionsBlock(questions: readonly GuideQuestion[]): string {
  return questions
    .map((q) => {
      const head = q.section ? `[${q.section}] ${q.label}` : q.label;
      const options = q.options.map((o) => `    - ${o}`).join('\n');
      return `\n${q.fieldId}: ${head}\n${options}`;
    })
    .join('\n');
}

function parseToolCall(message: AnthropicMessage): { answers?: unknown; notes?: unknown } {
  for (const block of message.content) {
    if (block.type === 'tool_use' && block.name === MATCH_TOOL_NAME && block.input) {
      return block.input as { answers?: unknown; notes?: unknown };
    }
  }
  return {};
}

/**
 * Read a guide PDF against a set of questions.
 *
 * Throws `guide_match_unavailable` when there is no client, mirroring the
 * extraction path's `extraction_unavailable` so the route can map it to a 422
 * rather than a 500 — a missing key is a configuration state, not a fault.
 */
export async function matchAnswerGuide(
  pdfBytes: Uint8Array,
  questions: readonly GuideQuestion[],
  opts: { anthropic?: AnthropicLike; model?: string; maxTokens?: number } = {},
): Promise<GuideMatchResult> {
  if (!opts.anthropic) {
    throw new Error('guide_match_unavailable: reading an answer guide requires an Anthropic client / API key');
  }
  if (questions.length === 0) return { answers: {}, notes: [] };

  const base64 = Buffer.from(pdfBytes).toString('base64');
  const message = await opts.anthropic.messages.create({
    model: opts.model ?? 'claude-sonnet-5',
    max_tokens: opts.maxTokens ?? 16000,
    tools: [matchGuideAnswersTool],
    tool_choice: { type: 'tool', name: MATCH_TOOL_NAME },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: base64 },
          },
          { type: 'text', text: `${PROMPT}${questionsBlock(questions)}` },
        ],
      },
    ],
  });

  const parsed = parseToolCall(message);
  const raw = Array.isArray(parsed.answers) ? parsed.answers : [];
  const notes = Array.isArray(parsed.notes) ? parsed.notes.map(String) : [];

  const byId = new Map(questions.map((q) => [q.fieldId, q]));
  const answers: Record<string, string[]> = {};

  for (const entry of raw) {
    const item = entry as { fieldId?: unknown; correct?: unknown };
    const fieldId = typeof item.fieldId === 'string' ? item.fieldId : '';
    const question = byId.get(fieldId);
    if (!question) {
      // A field id nothing was asked about cannot be keyed onto anything, and
      // silently discarding it would hide a guide read against the wrong tool.
      if (fieldId) notes.push(`The guide reported an answer for "${fieldId}", which is not one of the questions.`);
      continue;
    }

    const correct = Array.isArray(item.correct) ? item.correct.map(String) : [];
    if (correct.length === 0) continue;

    /*
      EVERY RETURNED OPTION IS MATCHED BACK, IN CODE.

      Exact first, then a normalized comparison so punctuation or case drift in
      a transcribed option still lands. Anything that resolves to nothing is
      dropped along with the WHOLE question — a partially-resolved key is an
      exact-set key missing an option, which fails every candidate who answers
      correctly just as surely as a wrong one does.
    */
    const resolved = correct.map((c) => resolveOption(c, question.options));
    if (resolved.some((r) => r === null)) {
      const bad = correct.filter((_, i) => resolved[i] === null);
      notes.push(
        `"${question.label}" — the guide gave ${bad.map((b) => `"${b}"`).join(', ')}, which is not one of its printed options. That question was left unkeyed.`,
      );
      continue;
    }

    answers[fieldId] = [...new Set(resolved as string[])];
  }

  return { answers, notes };
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Resolve one reported answer against a question's options.
 *
 * A bare letter is accepted as a positional index, because a guide prints
 * "b)" more often than it reprints the option text and the model is reading
 * what the page shows. Everything else is matched on text.
 */
export function resolveOption(reported: string, options: readonly string[]): string | null {
  const trimmed = reported.trim();
  if (!trimmed) return null;

  const exact = options.find((o) => o === trimmed);
  if (exact) return exact;

  if (/^[a-z]$/i.test(trimmed)) {
    return options[trimmed.toLowerCase().charCodeAt(0) - 97] ?? null;
  }

  const loose = options.find((o) => normalize(o) === normalize(trimmed));
  return loose ?? null;
}
