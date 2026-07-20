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
  ExtractedField,
  ExtractionResult,
  FormFieldType,
  RepeatingColumn,
  SourcePosition,
} from '@formai/shared';
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
  'with its columns — do not list blank rows. If a line looks like plain text but is really a ' +
  'signature, still classify it and add a note. Give every field a confidence score.';

/** Read the widget rectangle of an AcroForm field into PDF point space. */
function widgetPosition(field: {
  acroField: { getWidgets(): Array<{ getRectangle(): { x: number; y: number; width: number; height: number } }> };
}, pageWidth: number, pageHeight: number): SourcePosition | undefined {
  try {
    const widget = field.acroField.getWidgets()[0];
    if (!widget) return undefined;
    const rect = widget.getRectangle();
    return {
      page: 0,
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
  const firstPage = doc.getPage(0);
  const { width: pageWidth, height: pageHeight } = firstPage.getSize();

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

    fields.push({
      id: `acro_${fields.length + 1}`,
      label,
      type,
      confidence: 1,
      ...(options ? { options } : {}),
      ...(widgetPosition(field as never, pageWidth, pageHeight)
        ? { sourcePosition: widgetPosition(field as never, pageWidth, pageHeight) }
        : {}),
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

function normalizeField(raw: Record<string, unknown>, index: number): ExtractedField {
  return {
    id: `ai_${index + 1}`,
    label: String(raw.label ?? `Field ${index + 1}`),
    type: (raw.type as FormFieldType) ?? 'text',
    confidence: typeof raw.confidence === 'number' ? raw.confidence : 0.5,
    ...(typeof raw.required === 'boolean' ? { required: raw.required } : {}),
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    ...(Array.isArray(raw.options) ? { options: raw.options.map(String) } : {}),
    ...(raw.selectionType === 'single' || raw.selectionType === 'multiple'
      ? { selectionType: raw.selectionType }
      : {}),
    ...(toColumns(raw.columns) ? { columns: toColumns(raw.columns) } : {}),
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
  return {
    sourceType: 'pdf_import',
    path: 'ai',
    fileName: opts.fileName,
    pageCount: doc.getPageCount(),
    fields: rawFields.map(normalizeField),
    designNotes: Array.isArray(parsed.designNotes) ? parsed.designNotes.map(String) : [],
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
