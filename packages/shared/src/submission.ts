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

/** Per-field captured value. Shape depends on the field type. */
export type SubmissionValue =
  | string
  | number
  | boolean
  | string[]
  | RepeatingRowValue[]
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
