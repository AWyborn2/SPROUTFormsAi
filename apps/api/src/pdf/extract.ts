/**
 * PDF field extraction — two paths chosen by inspection:
 *
 *  1. AcroForm PDFs (fillable fields already defined) are read deterministically
 *     with pdf-lib. **No AI call.**
 *  2. Flat PDFs (scanned / Word-exported — the dominant compliance case) are
 *     sent to Claude as a `document` block, forcing the `extract_form_fields`
 *     tool. Parsing is robust: check for a `tool_use` block first, then fall
 *     back to a ```json fence in text — forced `tool_choice` is not 100%
 *     reliable. `max_tokens` is deliberately large; dense forms carry 50+ defs.
 */
import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
} from 'pdf-lib';
import type {
  AnswerSet,
  ExtractedField,
  ExtractionResult,
  FormFieldType,
  RepeatingColumn,
  SourcePosition,
} from '@formai/shared';
import { resolveAnswerSets } from '@formai/shared';
import { EXTRACT_TOOL_NAME, extractFormFieldsTool } from './tool-schema.js';

/** Minimum tokens for the forced tool call — undersizing makes it fail outright. */
export const EXTRACTION_MAX_TOKENS = 16000;

/** The subset of the Anthropic client we depend on (keeps the service testable). */
export interface AnthropicLike {
  messages: {
    create(params: unknown): Promise<AnthropicMessage>;
  };
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}

export interface AnthropicMessage {
  content: AnthropicContentBlock[];
}

export interface ExtractOptions {
  fileName: string;
  anthropic?: AnthropicLike;
  model?: string;
  /** Override for the max_tokens sent on the flat path (defaults to 16000). */
  maxTokens?: number;
}

const EXTRACTION_PROMPT =
  'This PDF is a form. Extract every input field a person would fill in, in reading order, ' +
  'by calling the extract_form_fields tool. Extract any repeating table once as a repeating_group ' +
  'with its columns — do not list blank rows. However, if a table’s rows carry PRE-PRINTED item ' +
  'labels (a fixed-item checklist such as "Engine oil level", "Park brake"), those are not blank ' +
  'rows: emit the item labels as fixedRows, and still list the item/label column as the ' +
  'FIRST columns entry (type text). When such a checklist is printed as several SIDE-BY-SIDE ' +
  'column groups under one shared header (e.g. three OK/NA column-pairs across the page), read it ' +
  'COLUMN-MAJOR — emit the whole leftmost printed column top-to-bottom, then the next column, and ' +
  'so on, not across each row — and set columnGroups to the number of side-by-side groups (omit ' +
  'columnGroups for a single column of items). If a line looks like plain text but is really a ' +
  'signature, still classify it and add a note. In a table, distinguish columns that are ' +
  'INDEPENDENT checkboxes (each can be ticked on its own, e.g. "Cleaned" and "Inspected") from ' +
  'columns that are ALTERNATIVES sharing ONE answer per row — exactly one may be ticked. The ' +
  'house shapes are OK / NA, ✓ / × / N-A, and Pass / Fail / NA. Group alternatives into an ' +
  'answerSets entry naming those column keys; leave independent checkboxes ungrouped. ' +
  'Give every field a confidence score.';

/**
 * Which page a widget sits on, or -1 when it cannot be established.
 *
 * `/P` is consulted first because it is direct, but it is only a back-pointer
 * and the spec makes it OPTIONAL — pdf-lib's accessor additionally yields
 * nothing unless the value is a direct ref. Trusting it alone would drop the
 * position of every field in a producer that omits it, and one of the real
 * fixture documents (a 73-field fillable checklist) is exactly the kind of
 * single-page form where that would be a silent regression from previously
 * working output.
 *
 * The page's own `/Annots` array is the authoritative statement of what is on
 * that page, so it is the fallback. It also settles the disagreement case: a
 * `/P` left stale by a merge or re-paginate resolves to a real, in-range,
 * plausible-looking page, which is the one failure this module must not
 * produce. When `/P` names a page whose `/Annots` does not contain the widget,
 * `/Annots` wins.
 */
function resolveWidgetPage(
  widget: { P(): unknown; dict: unknown },
  pages: ReturnType<PDFDocument['getPages']>,
): number {
  const byAnnots = pages.findIndex((p) => {
    try {
      const annots = p.node.Annots();
      if (!annots) return false;
      for (let i = 0; i < annots.size(); i++) {
        if (p.doc.context.lookup(annots.get(i)) === widget.dict) return true;
      }
    } catch {
      return false;
    }
    return false;
  });
  if (byAnnots >= 0) return byAnnots;

  const pageRef = widget.P();
  if (!pageRef) return -1;
  return pages.findIndex((p) => p.ref === pageRef);
}

/**
 * Read the widget rectangle of an AcroForm field into PDF point space.
 *
 * The page index is resolved (see `resolveWidgetPage`) — never a default. An
 * earlier version stamped `page: 0` on every position, which no single-page
 * fixture could catch and which silently mislocates every field in a
 * multi-page document; the compliance library is full of them (the dozer
 * assessment runs to eighteen pages and mixes portrait with landscape).
 * Dimensions are read from that same resolved page, because a landscape page
 * overlaid against a portrait extent puts nothing where the printed form
 * expects it.
 *
 * A widget whose page cannot be resolved returns undefined rather than falling
 * back to page 0: no position degrades to a data-only export, whereas a wrong
 * position draws a confident mark on the wrong page of a compliance record.
 *
 * Only the FIRST widget is positioned. That predates this change and is left
 * alone deliberately: a radio group's options and a field repeated across pages
 * are each one field with several widgets, and representing them properly means
 * emitting one segment per widget into `FieldGeometry` — which belongs to the
 * unit that populates geometry, not to this one.
 */
function widgetPosition(
  field: {
    acroField: {
      getWidgets(): Array<{
        getRectangle(): { x: number; y: number; width: number; height: number };
        P(): unknown;
        dict: unknown;
      }>;
    };
  },
  doc: PDFDocument,
): SourcePosition | undefined {
  try {
    const widget = field.acroField.getWidgets()[0];
    if (!widget) return undefined;

    const pages = doc.getPages();
    const page = resolveWidgetPage(widget, pages);
    if (page < 0) return undefined;

    const rect = widget.getRectangle();
    const { width: pageWidth, height: pageHeight } = pages[page]!.getSize();
    return {
      page,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      pageWidth,
      pageHeight,
    };
  } catch {
    return undefined;
  }
}

/** Deterministic AcroForm read — no AI. */
function extractAcroForm(doc: PDFDocument, fileName: string): ExtractionResult {
  const form = doc.getForm();
  const acroFields = form.getFields();

  const fields: ExtractedField[] = [];
  for (const field of acroFields) {
    const label = field.getName();
    let type: FormFieldType = 'text';
    let options: string[] | undefined;

    if (field instanceof PDFTextField) type = 'text';
    else if (field instanceof PDFCheckBox) type = 'checkbox';
    else if (field instanceof PDFDropdown) {
      type = 'dropdown';
      options = field.getOptions();
    } else if (field instanceof PDFOptionList) {
      type = 'dropdown';
      options = field.getOptions();
    } else if (field instanceof PDFRadioGroup) {
      type = 'radio';
      options = field.getOptions();
    } else {
      // Buttons / signatures / unknown → treat as text input surface.
      type = 'text';
    }

    const sourcePosition = widgetPosition(field as never, doc);
    fields.push({
      id: `acro_${fields.length + 1}`,
      label,
      type,
      confidence: 1,
      ...(options ? { options } : {}),
      ...(sourcePosition ? { sourcePosition } : {}),
    });
  }

  return {
    sourceType: 'pdf_import',
    path: 'acroform',
    fileName,
    pageCount: doc.getPageCount(),
    fields,
    designNotes: [],
  };
}

interface ParsedToolResult {
  fields?: Array<Record<string, unknown>>;
  designNotes?: unknown;
}

/** Strip a ```json … ``` fence (or any fenced block) and parse JSON within. */
export function parseJsonFence(text: string): ParsedToolResult | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence?.[1] ?? text;
  try {
    return JSON.parse(raw.trim()) as ParsedToolResult;
  } catch {
    return null;
  }
}

/**
 * Extract structured fields from a model response. `tool_use` first; then a
 * ```json fence in text; only error if neither yields data.
 */
export function parseExtractionResponse(message: AnthropicMessage): ParsedToolResult {
  const toolBlock = message.content.find(
    (b) => b.type === 'tool_use' && b.name === EXTRACT_TOOL_NAME,
  );
  if (toolBlock?.input && typeof toolBlock.input === 'object') {
    return toolBlock.input as ParsedToolResult;
  }
  const textBlock = message.content.find((b) => b.type === 'text' && typeof b.text === 'string');
  if (textBlock?.text) {
    const parsed = parseJsonFence(textBlock.text);
    if (parsed) return parsed;
  }
  throw new Error('extraction_failed: response contained neither a tool_use block nor parseable JSON');
}

function toColumns(raw: unknown): RepeatingColumn[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map((c) => ({
      key: String(c.key ?? ''),
      label: String(c.label ?? ''),
      type: (c.type as FormFieldType) ?? 'text',
      ...(Array.isArray(c.options) ? { options: c.options.map(String) } : {}),
      ...(typeof c.required === 'boolean' ? { required: c.required } : {}),
    }));
}

/** Ordered fixed checklist item labels; empty / non-array → absent. */
function toFixedRows(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.map(String);
}

/**
 * The side-by-side group count of a multi-column checklist. A whole number ≥ 2
 * or nothing: a single column of items (or a bad value) carries no hint, the
 * same tolerance `toFixedRows` shows an empty array. It is only ever a
 * reviewer-facing pre-fill, so a wrong value costs a dropdown correction.
 */
function toColumnGroups(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 2) return undefined;
  return raw;
}

/**
 * Coerce the model's answerSets proposal. Malformed entries collapse to
 * `undefined` rather than throwing — the same tolerance as `toColumns`.
 */
function toAnswerSets(raw: unknown): AnswerSet[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const sets = raw
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s, i) => ({
      key: String(s.key ?? `set_${i + 1}`),
      columnKeys: Array.isArray(s.columnKeys) ? s.columnKeys.map(String) : [],
      ...(typeof s.label === 'string' ? { label: s.label } : {}),
      ...(typeof s.required === 'boolean' ? { required: s.required } : {}),
    }));
  return sets.length > 0 ? sets : undefined;
}

function normalizeField(raw: Record<string, unknown>, index: number): ExtractedField {
  const fixedRows = toFixedRows(raw.fixedRows);
  // Only a checklist with more items than groups can actually split into that
  // many non-empty groups; a hint that cannot hold is dropped rather than
  // pre-filling the reviewer a count that would be refused.
  const rawColumnGroups = toColumnGroups(raw.columnGroups);
  const columnGroups =
    rawColumnGroups && fixedRows && fixedRows.length >= rawColumnGroups ? rawColumnGroups : undefined;
  let columns = toColumns(raw.columns);
  // KTD1 invariant: a fixed-row checklist's labels live in the FIRST column,
  // which must be text. Guard against the model omitting it. The synthetic
  // key is uniquified against the model's column keys — a duplicate (e.g. a
  // later column keyed 'item') would make the seeded label readable as an
  // answer.
  if (fixedRows && columns?.[0]?.type !== 'text') {
    const existingKeys = new Set((columns ?? []).map((c) => c.key));
    let key = 'item';
    if (existingKeys.has(key)) {
      key = 'item_label';
      for (let n = 2; existingKeys.has(key); n += 1) key = `item_label_${n}`;
    }
    columns = [{ key, label: 'Item', type: 'text' }, ...(columns ?? [])];
  }
  // Answer sets are a PROPOSAL, validated against the final column list (after
  // any synthetic label column is seeded, so the label-column rule sees the
  // real first column). Invalid proposals are dropped, never fatal: the table
  // simply publishes ungrouped and the reviewer can regroup it. Validation is
  // delegated to `resolveAnswerSets` so extraction, the fill view, and the
  // validator all agree on exactly which sets are legal.
  const proposedSets = toAnswerSets(raw.answerSets);
  const resolved = proposedSets
    ? resolveAnswerSets({ columns, answerSets: proposedSets }).sets
    : [];
  const answerSets = resolved.length > 0 ? resolved : undefined;
  return {
    id: `ai_${index + 1}`,
    label: String(raw.label ?? `Field ${index + 1}`),
    type: (raw.type as FormFieldType) ?? 'text',
    confidence: typeof raw.confidence === 'number' ? raw.confidence : 0.5,
    // AE5: on a fixedRows checklist the model's `required` is dropped — the
    // client-side checklist default (required unless the reviewer untoggles)
    // owns that decision.
    ...(typeof raw.required === 'boolean' && !fixedRows ? { required: raw.required } : {}),
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    ...(Array.isArray(raw.options) ? { options: raw.options.map(String) } : {}),
    ...(raw.selectionType === 'single' || raw.selectionType === 'multiple'
      ? { selectionType: raw.selectionType }
      : {}),
    ...(columns ? { columns } : {}),
    ...(answerSets ? { answerSets } : {}),
    ...(fixedRows ? { fixedRows } : {}),
    ...(columnGroups ? { columnGroups } : {}),
    ...(typeof raw.note === 'string' ? { note: raw.note } : {}),
  };
}

/** Flat-PDF path — one forced tool call, robust parsing. */
async function extractWithAI(
  pdfBytes: Uint8Array,
  doc: PDFDocument,
  opts: ExtractOptions,
): Promise<ExtractionResult> {
  if (!opts.anthropic) {
    throw new Error('extraction_unavailable: flat PDF requires an Anthropic client / API key');
  }
  const base64 = Buffer.from(pdfBytes).toString('base64');
  const message = await opts.anthropic.messages.create({
    model: opts.model ?? 'claude-sonnet-5',
    max_tokens: opts.maxTokens ?? EXTRACTION_MAX_TOKENS,
    tools: [extractFormFieldsTool],
    tool_choice: { type: 'tool', name: EXTRACT_TOOL_NAME },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: EXTRACTION_PROMPT },
        ],
      },
    ],
  });

  const parsed = parseExtractionResponse(message);
  const rawFields = Array.isArray(parsed.fields) ? parsed.fields : [];
  const fields = rawFields.map(normalizeField);
  const modelNotes = Array.isArray(parsed.designNotes) ? parsed.designNotes.map(String) : [];

  // Point the reviewer at the split control for any checklist the model read as
  // several side-by-side groups. Synthesised here rather than left to the model
  // so the prompt for the split is deterministic — the fix that motivates
  // column-major reading is worthless if the reviewer never notices the field
  // should be split.
  const splitNotes = fields
    .filter((f) => f.columnGroups)
    .map((f) => `"${f.label}" appears to print as ${f.columnGroups} side-by-side groups — split it in review.`);

  return {
    sourceType: 'pdf_import',
    path: 'ai',
    fileName: opts.fileName,
    pageCount: doc.getPageCount(),
    fields,
    designNotes: [...modelNotes, ...splitNotes],
  };
}

/**
 * Extract form fields from a PDF. Inspects for AcroForm fields first (zero-AI
 * deterministic read); falls back to the AI path for flat documents.
 */
export async function extractForm(
  pdfBytes: Uint8Array,
  opts: ExtractOptions,
): Promise<ExtractionResult> {
  const doc = await PDFDocument.load(pdfBytes);
  const hasAcroFields = doc.getForm().getFields().length > 0;
  if (hasAcroFields) return extractAcroForm(doc, opts.fileName);
  return extractWithAI(pdfBytes, doc, opts);
}
