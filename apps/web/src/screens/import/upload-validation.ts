/**
 * Pure helpers for the import upload screen — kept out of the component so
 * they can be unit-tested in the node vitest environment (no jsdom/RTL in
 * this workspace; the component wiring is covered by typecheck + browser
 * smoke passes).
 */

import { MAX_UPLOAD_MB } from '../../lib/data/import-session.js';

export { MAX_UPLOAD_MB };
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

/** The subset of `File` the validator needs (structural, so tests can use plain objects). */
export interface UploadCandidate {
  name: string;
  type: string;
  size: number;
}

/**
 * Validate a candidate upload. Returns a user-facing error string, or null
 * when the file is acceptable. PDFs are recognised by MIME type or, when the
 * OS supplies no type (common for drag-and-drop), by extension.
 */
export function validateUploadFile(file: UploadCandidate): string | null {
  const isPdf = file.type === 'application/pdf' || (!file.type && /\.pdf$/i.test(file.name));
  if (!isPdf) return 'That file isn’t a PDF — choose a .pdf file to import.';
  if (file.size > MAX_UPLOAD_BYTES) {
    return `That PDF is ${formatFileSize(file.size)} — the limit is ${MAX_UPLOAD_MB} MB.`;
  }
  return null;
}

/** Human-readable file size, e.g. "824 KB", "1.2 MB". */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

/** "site-audit.pdf" -> "site-audit". Shared by the import review + publish screens. */
export function stripFileExtension(fileName: string): string {
  return fileName.trim().replace(/\.[^.]+$/, '').trim();
}
