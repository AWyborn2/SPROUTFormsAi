/**
 * Import wizard session — shared, mutable state across the three import routes
 * (upload → review → publish), which are sibling routes rather than a nested
 * tree. A tiny external store (useSyncExternalStore) holds the extraction being
 * reviewed and the reviewer's corrections; step 1 resets it.
 *
 * `startExtraction(file)` drives the real API pipeline:
 * `POST /pdf/upload` (base64 bytes → assetId) then `POST /pdf/extract`
 * (assetId → ExtractionResult), with status transitions
 * idle → uploading → extracting → ready | error.
 */
import { useSyncExternalStore } from 'react';
import type { ExtractedField, ExtractionResult, ExtractionStatus, FormField } from '@formai/shared';
import { statusForConfidence } from '@formai/shared';
import { ApiError, apiClient } from './api-client.js';

/** An extracted field plus the reviewer's resolution state. */
export interface ReviewField extends ExtractedField {
  /** Set once the reviewer has explicitly confirmed/corrected this field. */
  resolved?: boolean;
}

export type ImportSessionStatus = 'idle' | 'uploading' | 'extracting' | 'ready' | 'error';

interface ImportSession {
  status: ImportSessionStatus;
  fileName: string;
  pageCount: number;
  designNotes: string[];
  fields: ReviewField[];
  /** Storage handle from `POST /pdf/upload` — reused for the round-trip export. */
  assetId: string | null;
  /** The untouched extraction as returned by the API (fields above are the working copy). */
  extraction: ExtractionResult | null;
  /** User-facing failure message when status is 'error'. */
  error: string | null;
}

const EMPTY_SESSION: Omit<ImportSession, 'designNotes' | 'fields'> = {
  status: 'idle',
  fileName: '',
  pageCount: 0,
  assetId: null,
  extraction: null,
  error: null,
};

function emptySession(): ImportSession {
  return { ...EMPTY_SESSION, designNotes: [], fields: [] };
}

let session: ImportSession = emptySession();
/** Base64 of the last file handed to startExtraction — kept so retry works. */
let heldBase64: string | null = null;
/** Monotonic run token — a reset/new start invalidates in-flight async work. */
let runId = 0;

const listeners = new Set<() => void>();

function emit() {
  session = { ...session, fields: session.fields.slice() };
  listeners.forEach((l) => l());
}

function update(patch: Partial<ImportSession>) {
  session = { ...session, ...patch };
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Current session snapshot (also the useSyncExternalStore getSnapshot). */
export function getImportSession(): ImportSession {
  return session;
}

/** Reset to an empty idle session (called when entering step 1). */
export function resetImportSession() {
  runId += 1; // orphan any in-flight upload/extract
  heldBase64 = null;
  session = emptySession();
  listeners.forEach((l) => l());
}

export const MAX_UPLOAD_MB = 25;

const ERROR_MESSAGES = {
  aiUnavailable: "This PDF needs AI extraction, which isn't configured on the server yet.",
  storageUnavailable: "File storage isn't available right now — try again shortly.",
  tooLarge: `This PDF is too large to import — the limit is ${MAX_UPLOAD_MB} MB.`,
  generic: 'Something went wrong importing this PDF. Please try again.',
} as const;

function messageForError(err: unknown): string {
  if (err instanceof ApiError) {
    const bodyError =
      typeof err.body === 'object' && err.body !== null && 'error' in err.body
        ? String((err.body as { error: unknown }).error)
        : '';
    if (err.status === 422 && bodyError.startsWith('extraction_unavailable')) {
      return ERROR_MESSAGES.aiUnavailable;
    }
    if (err.status === 503) return ERROR_MESSAGES.storageUnavailable;
    if (err.status === 413) return ERROR_MESSAGES.tooLarge;
  }
  return ERROR_MESSAGES.generic;
}

/** File bytes → base64 (kept separate so the encoding seam is testable). */
export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000; // keep String.fromCharCode arg counts bounded
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Upload the file and run extraction against the API. Resolves once the
 * session has landed in 'ready' or 'error' — state is read via the store,
 * not the return value.
 */
export async function startExtraction(file: File): Promise<void> {
  const run = ++runId;
  heldBase64 = null;
  update({ ...emptySession(), status: 'uploading', fileName: file.name });

  let base64: string;
  try {
    base64 = await fileToBase64(file);
  } catch (err) {
    if (run !== runId) return;
    update({ status: 'error', error: messageForError(err) });
    return;
  }
  if (run !== runId) return;
  heldBase64 = base64;
  await runPipeline(run, file.name, base64);
}

/** Re-run upload + extraction with the bytes held from the last attempt. */
export async function retryExtraction(): Promise<void> {
  if (heldBase64 === null || !session.fileName) return;
  const run = ++runId;
  update({ status: 'uploading', assetId: null, error: null });
  await runPipeline(run, session.fileName, heldBase64);
}

async function runPipeline(run: number, fileName: string, base64: string): Promise<void> {
  try {
    const { assetId } = await apiClient.post<{ assetId: string }>('/pdf/upload', {
      pdfBase64: base64,
    });
    if (run !== runId) return;
    update({ status: 'extracting', assetId });

    const result = await apiClient.post<ExtractionResult>('/pdf/extract', { assetId, fileName });
    if (run !== runId) return;
    update({
      status: 'ready',
      extraction: result,
      fileName: result.fileName,
      pageCount: result.pageCount,
      designNotes: result.designNotes,
      fields: result.fields.map((f) => ({ ...f })),
      error: null,
    });
  } catch (err) {
    if (run !== runId) return;
    update({ status: 'error', error: messageForError(err) });
  }
}

/** Effective review status for a field (resolved fields read as ok). */
export function reviewStatus(field: ReviewField): ExtractionStatus {
  if (field.resolved) return 'ok';
  return statusForConfidence(field.confidence);
}

export function useImportSession() {
  const snap = useSyncExternalStore(subscribe, getImportSession, getImportSession);

  return {
    ...snap,
    /** Base64 of the source PDF — used for instant review rendering (falls back to asset fetch if absent). */
    pdfBase64: heldBase64,
    total: snap.fields.length,
    needReview: snap.fields.filter((f) => reviewStatus(f) !== 'ok').length,
    avgConfidence:
      snap.fields.reduce((sum, f) => sum + f.confidence, 0) / Math.max(1, snap.fields.length),

    /** Remap the low-confidence "text" field to a signature (the known case). */
    remapSignature(id: string) {
      session.fields = session.fields.map((f) =>
        f.id === id
          ? { ...f, type: 'signature', confidence: 1, resolved: true, note: 'Corrected — remapped to a signature field' }
          : f,
      );
      emit();
    },

    /** Inline type correction for a flagged field. */
    setType(id: string, type: ExtractedField['type']) {
      session.fields = session.fields.map((f) =>
        f.id === id ? { ...f, type, confidence: reviewStatus(f) === 'low' ? 1 : f.confidence, resolved: true } : f,
      );
      emit();
    },

    /** Confirm a detected repeating table should stay a repeating group. */
    confirmTable(id: string) {
      session.fields = session.fields.map((f) =>
        f.id === id ? { ...f, resolved: true, note: 'Confirmed as a repeating table' } : f,
      );
      emit();
    },
  };
}

/** Map the reviewed extraction to publishable FormFields. */
export function reviewedToFields(fields: ReviewField[]): FormField[] {
  return fields.map((f) => ({
    id: f.id,
    type: f.type,
    label: f.label,
    required: f.required ?? false,
    source: 'imported',
    confidence: f.confidence,
    ...(f.description ? { description: f.description } : {}),
    ...(f.options ? { options: f.options } : {}),
    ...(f.selectionType ? { selectionType: f.selectionType } : {}),
    ...(f.columns ? { columns: f.columns } : {}),
    ...(f.sourcePosition ? { sourcePosition: f.sourcePosition } : {}),
  }));
}
