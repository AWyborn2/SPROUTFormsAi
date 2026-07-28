/**
 * Submissions — a filled instance of a specific template version.
 */

/**
 * Core lifecycle status (per the data model) plus the prototype's richer review
 * states. `draft`/`submitted`/`reviewed` are the canonical lifecycle; the rest
 * are review outcomes surfaced in the submissions table.
 */
export type SubmissionStatus =
  | 'draft'
  | 'submitted'
  | 'reviewed'
  | 'complete'
  | 'approved'
  | 'review'
  | 'rejected'
  | 'pending';

/**
 * A stored file answer — what a `file_upload` field records once the bytes are
 * actually in object storage.
 *
 * This is a REFERENCE, never the bytes: submissions are jsonb, and inlining a
 * 2 MB licence photo into every row would bloat every read of the record for
 * the one consumer that wants to look at it.
 *
 * `key` is the storage object key, org-prefixed exactly like a PDF asset id, so
 * the same tenant check that guards `download` guards this. `fileName` is the
 * respondent's original name, kept for display and export only — it is
 * untrusted input and is never used to build a path.
 *
 * Deliberately a distinct variant rather than a bare key string. A string would
 * be indistinguishable from a text answer, so nothing downstream could tell an
 * uploaded file from someone typing a filename — which is precisely the bug
 * this replaces, where the fill screen recorded `files[0].name` and no bytes
 * were stored at all.
 */
export interface SubmissionFileRef {
  /** Discriminant — present on every stored file answer. */
  kind: 'file';
  /** Org-prefixed storage object key, e.g. `${orgId}/upload-${uuid}.jpg`. */
  key: string;
  /** Original client-supplied name. Display only; never a path component. */
  fileName: string;
  /** Server-verified content type (matched against the bytes' magic number). */
  contentType: string;
  /** Size in bytes, as stored. */
  size: number;
}

/**
 * Decoded-bytes ceiling for one submission attachment. Larger than a logo
 * (`MAX_LOGO_BYTES`) because this is photography, not a mark: a licence or ID
 * photo straight off a phone camera routinely lands between 3 and 8 MB, and a
 * respondent standing in a site office cannot resize one.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Content types a `file_upload` field accepts. Images plus PDF covers the
 * real intake payloads — a licence photo, a scanned ticket, a certificate.
 * Everything else is refused at the route: an allow-list is the only way the
 * server can promise what it stores, since the client's declared MIME is
 * attacker-controlled and only selects which magic number gets verified.
 */
export const ALLOWED_ATTACHMENT_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/** Type guard for the file variant of `SubmissionValue`. */
export function isFileRef(value: unknown): value is SubmissionFileRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === 'file' &&
    typeof (value as { key?: unknown }).key === 'string'
  );
}

/** Per-field captured value. Shape depends on the field type. */
export type SubmissionValue =
  | string
  | number
  | boolean
  | string[]
  | RepeatingRowValue[]
  | SubmissionFileRef
  | null;

/** A single row of a repeating group: column key -> value. */
export type RepeatingRowValue = Record<string, string | number | boolean | null>;

export interface Submission {
  id: string;
  orgId: string;
  templateId: string;
  /** Pins the exact immutable version filled against. */
  templateVersionId: string;
  submitterName: string;
  submitterEmail: string;
  values: Record<string, SubmissionValue>;
  status: SubmissionStatus;
  /** Free-text flag, e.g. "2 fails logged", "ABN mismatch". */
  flag: string;
  createdAt: string;
}
