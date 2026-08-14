/**
 * The secondary-extraction pass — a SECOND look for printed input areas the
 * primary extraction produced no field for.
 *
 * WHY IT IS SEPARATE, AND OPT-IN. The primary path reads a form once and can
 * miss a box: a signature line off to the side, a date cell, a stray tick. That
 * is the quiet failure on a compliance record — nothing errors, the field just
 * is not there. This pass hands the model the PDF plus the labels the first
 * pass ALREADY captured and asks only for what it missed, so an author can
 * catch the gap without re-reading the paper cell by cell. It runs on request
 * rather than on every import: a second AI call per upload would double cost and
 * latency for the common case where nothing was missed.
 *
 * ONE CALL, NOT BATCHED. Unlike extraction — whose 50+ field list overran the
 * token cap on a long paper and forced page-range batching — the audit returns
 * only the FEW boxes that were missed, so a single call over the whole document
 * stays well under the cap and lets the model place a box on its real page.
 */
import { PDFDocument } from 'pdf-lib';
import type { AuditResult, DocumentType, FormFieldType, MissedInput } from '@formai/shared';
import { FORM_FIELD_TYPES, filterUncapturedInputs } from '@formai/shared';
import { AUDIT_TOOL_NAME, reportMissedFieldsTool } from './tool-schema.js';
import {
  parseJsonFence,
  type AnthropicLike,
  type AnthropicMessage,
} from './extract.js';

/**
 * The audit's response is a short list, so a small cap is plenty — and keeping
 * it small makes a runaway (the model re-listing the whole form) fail loudly
 * rather than bill for it.
 */
export const AUDIT_MAX_TOKENS = 4000;

export interface AuditOptions {
  fileName: string;
  /**
   * The labels ALREADY captured — every field currently in the draft. The
   * model is told these so it does not re-report them, and they are the filter
   * the result is passed through afterwards.
   */
  knownLabels: string[];
  anthropic?: AnthropicLike;
  model?: string;
  /** Override for the max_tokens sent on the audit call. */
  maxTokens?: number;
  /** Carried for parity with extraction; unused today, reserved for tuning. */
  documentType?: DocumentType;
}

const FIELD_TYPES = new Set<string>(FORM_FIELD_TYPES);

/** Coerce one raw audit entry, or null when it carries no usable label. */
function normalizeMissedInput(raw: unknown): MissedInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const label = typeof r.label === 'string' ? r.label.trim() : '';
  if (!label) return null;
  const type: FormFieldType =
    typeof r.type === 'string' && FIELD_TYPES.has(r.type) ? (r.type as FormFieldType) : 'text';
  const page =
    typeof r.page === 'number' && Number.isInteger(r.page) && r.page >= 1 ? r.page : undefined;
  const note = typeof r.note === 'string' && r.note.trim() ? r.note.trim() : undefined;
  return { label, type, ...(page ? { page } : {}), ...(note ? { note } : {}) };
}

/** Pull the missed-input list off a model response: tool_use first, then a fence. */
export function parseAuditResponse(message: AnthropicMessage): MissedInput[] {
  const toolBlock = message.content.find(
    (b) => b.type === 'tool_use' && b.name === AUDIT_TOOL_NAME,
  );
  let payload: unknown = null;
  if (toolBlock?.input && typeof toolBlock.input === 'object') {
    payload = toolBlock.input;
  } else {
    const textBlock = message.content.find((b) => b.type === 'text' && typeof b.text === 'string');
    if (textBlock?.text) payload = parseJsonFence(textBlock.text);
  }
  const list =
    payload && typeof payload === 'object' && Array.isArray((payload as { missedInputs?: unknown }).missedInputs)
      ? ((payload as { missedInputs: unknown[] }).missedInputs)
      : [];
  return list.map(normalizeMissedInput).filter((m): m is MissedInput => m !== null);
}

const AUDIT_PROMPT_HEAD =
  'This PDF is a form that has already been read once. Below are the input fields that were ' +
  'captured. Call report_missed_fields with any OTHER printed area a person is meant to fill in ' +
  'that is NOT in this list — a blank line, a tick box, a signature or date box, a table cell ' +
  'awaiting entry. Compare by meaning, not exact wording, and never re-report an individual row ' +
  'of a table already captured as a repeating group. If nothing was missed, return an empty list.';

/** Render the known-label list for the prompt; a compact bullet block. */
function knownLabelsBlock(labels: string[]): string {
  if (labels.length === 0) return 'Captured fields: (none were captured).';
  return `Captured fields (${labels.length}):\n${labels.map((l) => `- ${l}`).join('\n')}`;
}

/**
 * Run the secondary pass over a PDF.
 *
 * An AcroForm PDF returns nothing without an AI call: every widget was already
 * read deterministically by `extractAcroForm`, so by construction there is no
 * box left uncaptured. A flat PDF with no configured key throws
 * `extraction_unavailable`, the same 422 the primary path uses.
 */
export async function auditForm(pdfBytes: Uint8Array, opts: AuditOptions): Promise<AuditResult> {
  const doc = await PDFDocument.load(pdfBytes);
  if (doc.getForm().getFields().length > 0) return { missedInputs: [] };

  if (!opts.anthropic) {
    throw new Error('extraction_unavailable: flat PDF requires an Anthropic client / API key');
  }

  const base64 = Buffer.from(pdfBytes).toString('base64');
  const message = await opts.anthropic.messages.create({
    model: opts.model ?? 'claude-sonnet-5',
    max_tokens: opts.maxTokens ?? AUDIT_MAX_TOKENS,
    tools: [reportMissedFieldsTool],
    tool_choice: { type: 'tool', name: AUDIT_TOOL_NAME },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: base64 },
          },
          { type: 'text', text: `${AUDIT_PROMPT_HEAD}\n\n${knownLabelsBlock(opts.knownLabels)}` },
        ],
      },
    ],
  });

  // Belt and braces: the model is told the known labels, but a second look still
  // re-describes a captured box often enough to filter the result too.
  const missedInputs = filterUncapturedInputs(parseAuditResponse(message), opts.knownLabels);
  return { missedInputs };
}
