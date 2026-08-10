/**
 * Editing a client's brand by describing the change.
 *
 * "Make it navy and a bit tighter" is a faster and more natural way to reach a
 * look than eight controls, and the author usually knows the change they want
 * before they know which token carries it. So the model's whole job is to turn
 * a sentence into a PATCH over the brand's current kit.
 *
 * NOTHING IS APPLIED AND NOTHING IS STORED. What comes back is a proposal the
 * author sees rendered in the live preview and then saves, or does not. This is
 * the same posture as reading a brand off a PDF, and for the same reason: the
 * model is guessing at intent, and a guess that writes itself is a change
 * somebody has to find and undo.
 *
 * EVERY VALUE IS CHECKED BACK, IN CODE. `sanitizeThemeValues` refuses anything
 * outside a token's real domain, a colour must be six hex digits, and a font
 * must be in the bundled catalog. A theme value ends up in a CSS custom
 * property on a page a client's staff will open, so "the model returned it" is
 * not a reason to emit it. Rejected values are DROPPED rather than clamped and
 * reported to the author, because a silently corrected instruction reads as an
 * understood one.
 *
 * THE CURRENT KIT IS PART OF THE PROMPT. "A bit tighter" and "darker" are
 * relative, and without the starting point the model would answer them from
 * nothing — which is how "slightly rounder" becomes a 40px radius.
 */
import { isValidFormFont, sanitizeThemeValues, type FormBrandKit, type ThemeTokens } from '@formai/shared';
import type { AnthropicLike, AnthropicMessage } from '../pdf/extract.js';

export const BRAND_EDIT_TOOL_NAME = 'propose_brand_edit';

export interface BrandEditResult {
  /** A sparse patch over the brand's current kit. Empty when nothing survived. */
  patch: FormBrandKit;
  /** What changed, in the author's terms. One short sentence. */
  summary: string;
  /** Values refused, instructions not acted on, anything ambiguous. */
  notes: string[];
}

const HEX = /^#[0-9a-fA-F]{6}$/;

export const proposeBrandEditTool = {
  name: BRAND_EDIT_TOOL_NAME,
  description:
    'Propose a change to a form brand’s appearance, as a patch over its current settings. Include ONLY the keys the request actually asks to change.',
  input_schema: {
    type: 'object' as const,
    properties: {
      primaryColor: { type: 'string', description: 'Six-digit hex, e.g. "#0044cc".' },
      secondaryColor: { type: 'string', description: 'Six-digit hex.' },
      accentColor: { type: 'string', description: 'Six-digit hex.' },
      formFont: {
        type: 'string',
        description:
          'A Google Fonts family name, spelled exactly as Google publishes it. Omit unless the request asks about the typeface.',
      },
      theme: {
        type: 'object',
        description: 'Finer styling. Every key optional; include only what changes.',
        properties: {
          pageBackground: { type: 'string', description: 'Six-digit hex, or "" for the default.' },
          formBackground: { type: 'string', description: 'Six-digit hex, or "" for the default.' },
          headingColor: { type: 'string', description: 'Six-digit hex, or "" for the default.' },
          bodyColor: { type: 'string', description: 'Six-digit hex, or "" for the default.' },
          labelColor: { type: 'string', description: 'Six-digit hex, or "" for the default.' },
          borderColor: { type: 'string', description: 'Six-digit hex, or "" for the default.' },
          headingSize: { type: 'number', description: '12 to 48.' },
          bodySize: { type: 'number', description: '10 to 24.' },
          labelSize: { type: 'number', description: '10 to 24.' },
          buttonSize: { type: 'number', description: '10 to 24.' },
          headingWeight: { type: 'number', enum: [400, 500, 600, 700] },
          bodyWeight: { type: 'number', enum: [400, 500, 600, 700] },
          labelWeight: { type: 'number', enum: [400, 500, 600, 700] },
          buttonWeight: { type: 'number', enum: [400, 500, 600, 700] },
          buttonShape: { type: 'string', enum: ['rounded', 'pill', 'square'] },
          buttonStyle: { type: 'string', enum: ['solid', 'outline', 'soft'] },
          radius: { type: 'number', description: '0 to 40.' },
          borderWidth: { type: 'number', description: '0 to 6.' },
          shadow: { type: 'string', enum: ['none', 'sm', 'md', 'lg'] },
          density: { type: 'string', enum: ['compact', 'comfortable', 'spacious'] },
          logoSize: { type: 'string', enum: ['small', 'medium', 'large'] },
          logoPlacement: { type: 'string', enum: ['left', 'center'] },
          layout: { type: 'string', enum: ['card', 'hero', 'split', 'conversational'] },
        },
      },
      summary: {
        type: 'string',
        description:
          'One short sentence naming what you changed, in plain words — "Navy headings and tighter spacing", not a list of token names.',
      },
      notes: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Anything you could NOT do: a logo change, a layout this cannot express, a request you had to interpret.',
      },
    },
    required: ['summary'],
  },
};

const PROMPT = [
  'You are adjusting the appearance of an online form so it looks like a particular company’s',
  'own document. Below are the settings the form uses right now, then the change being asked for.',
  '',
  'Return ONLY the keys that change. This is a patch: anything you leave out keeps its current',
  'value, and including a key at its existing value is noise a person has to read past.',
  '',
  'RELATIVE REQUESTS ARE RELATIVE TO THE SETTINGS BELOW. "A bit tighter", "slightly rounder" and',
  '"darker" mean a step from where it is now, not a jump to an extreme. Move one step unless the',
  'request clearly asks for more.',
  '',
  'STAY INSIDE THE STATED RANGES. A value outside them is dropped entirely rather than corrected,',
  'so the person is told their instruction did nothing instead of quietly getting something else.',
  '',
  'SAY WHAT YOU COULD NOT DO. You cannot change the logo — that is uploaded, not described — and',
  'you cannot add content, fields or wording to the form. If the request asks for one of those, or',
  'for something these settings cannot express, do the part you can and put the rest in `notes`.',
  '',
  'CURRENT SETTINGS:',
].join('\n');

function currentBlock(kit: FormBrandKit): string {
  const lines = [
    `primaryColor: ${kit.primaryColor ?? '(inherited)'}`,
    `secondaryColor: ${kit.secondaryColor ?? '(inherited)'}`,
    `accentColor: ${kit.accentColor ?? '(inherited)'}`,
    `formFont: ${kit.formFont ?? '(inherited)'}`,
  ];
  const theme = kit.theme ?? {};
  for (const [key, value] of Object.entries(theme)) lines.push(`theme.${key}: ${String(value)}`);
  return lines.map((l) => `  ${l}`).join('\n');
}

function parseToolCall(message: AnthropicMessage): Record<string, unknown> {
  for (const block of message.content) {
    if (block.type === 'tool_use' && block.name === BRAND_EDIT_TOOL_NAME && block.input) {
      return block.input as Record<string, unknown>;
    }
  }
  return {};
}

/** A brand colour, or null when what came back is not one. */
function colorOrNull(value: unknown): string | null {
  return typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : null;
}

/**
 * Turn a described change into a patch over the brand's current kit.
 *
 * Throws `brand_edit_unavailable` when there is no client, mirroring the
 * extraction path's `extraction_unavailable` so the route maps it to a 422
 * rather than a 500 — a missing key is a configuration state, not a fault.
 */
export async function proposeBrandEdit(
  current: FormBrandKit,
  instruction: string,
  opts: { anthropic?: AnthropicLike; model?: string; maxTokens?: number } = {},
): Promise<BrandEditResult> {
  if (!opts.anthropic) {
    throw new Error('brand_edit_unavailable: editing a brand by description requires an Anthropic client / API key');
  }

  const message = await opts.anthropic.messages.create({
    model: opts.model ?? 'claude-sonnet-5',
    max_tokens: opts.maxTokens ?? 2000,
    tools: [proposeBrandEditTool],
    tool_choice: { type: 'tool', name: BRAND_EDIT_TOOL_NAME },
    messages: [
      {
        role: 'user',
        content: `${PROMPT}\n${currentBlock(current)}\n\nTHE CHANGE BEING ASKED FOR:\n${instruction}`,
      },
    ],
  });

  const raw = parseToolCall(message);
  const notes = Array.isArray(raw.notes) ? raw.notes.map(String) : [];
  const patch: FormBrandKit = {};

  for (const key of ['primaryColor', 'secondaryColor', 'accentColor'] as const) {
    if (raw[key] === undefined) continue;
    const hex = colorOrNull(raw[key]);
    if (hex) patch[key] = hex;
    else notes.push(`"${String(raw[key])}" is not a colour, so ${key} was left alone.`);
  }

  if (raw.formFont !== undefined) {
    // Checked against the bundled catalog, not accepted on the model's word: an
    // unknown family emits a Google Fonts request that fails, and the form
    // silently renders in a fallback nobody chose.
    const family = String(raw.formFont);
    if (isValidFormFont(family)) patch.formFont = family;
    else notes.push(`“${family}” is not one of the fonts available here, so the font was left alone.`);
  }

  if (raw.theme !== undefined && raw.theme !== null && typeof raw.theme === 'object') {
    const { theme, rejected } = sanitizeThemeValues(raw.theme as ThemeTokens);
    if (Object.keys(theme).length > 0) patch.theme = theme;
    for (const bad of rejected) {
      notes.push(`${bad} is outside what this setting allows, so it was not applied.`);
    }
  }

  /*
    A patch that survived validation empty is reported as one. Returning a
    cheerful summary over no change is the failure mode this exists to prevent:
    the author reads "Navy headings", sees nothing move, and concludes the
    preview is broken rather than that the request did not land.
  */
  const summary = typeof raw.summary === 'string' ? raw.summary : '';
  if (Object.keys(patch).length === 0 && notes.length === 0) {
    notes.push('Nothing in that changed the brand’s appearance.');
  }

  return { patch, summary, notes };
}
