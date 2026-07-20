/**
 * Submission-detail display model (pure, React-free) — turns a stored
 * row-array value into the rows the read-only table renders, and resolves
 * which submitter identity to show.
 *
 * KTD1: for fixed-item checklist tables the pinned version's `fixedRows` is
 * authoritative — stored label cells are denormalized display data only, so a
 * tampered or short value array can never misrepresent the checklist. R15:
 * the server-stamped user takes precedence over free-text claims.
 */
import { answerColumns, labelColumnKey } from '@formai/shared';
import type { FormField, RepeatingRowValue, SubmissionValue } from '@formai/shared';

function isRowRecord(row: unknown): row is RepeatingRowValue {
  return typeof row === 'object' && row !== null && !Array.isArray(row);
}

/**
 * Rows for the read-only submission-detail table.
 *
 * - Without `fixedRows`: the stored rows verbatim (legacy open tables, AE4).
 * - With `fixedRows`: row i (i < fixedRows.length) gets its label cell
 *   (`columns[0]`, per KTD1) overwritten from `fixedRows[i]`; a value shorter
 *   than `fixedRows` pads the missing tail as unanswered rows carrying their
 *   labels; stored rows past the fixed set are ad-hoc and pass verbatim.
 */
export function toDisplayRows(field: FormField, value: SubmissionValue | undefined): RepeatingRowValue[] {
  const stored: RepeatingRowValue[] = Array.isArray(value) ? value.filter(isRowRecord) : [];

  const fixedRows = field.fixedRows;
  const labelKey = labelColumnKey(field);
  if (!fixedRows || fixedRows.length === 0 || labelKey === undefined) return stored;

  const answerable = answerColumns(field);
  const fixed = fixedRows.map((label, i) => {
    const row = stored[i];
    if (row) return { ...row, [labelKey]: label };
    // Missing fixed row — render it as unanswered, but with its label.
    const padded: RepeatingRowValue = { [labelKey]: label };
    for (const c of answerable) padded[c.key] = null;
    return padded;
  });
  return [...fixed, ...stored.slice(fixedRows.length)];
}

/** What the "Submitted by" line shows, and whether it earns the Verified pill. */
export interface SubmitterIdentity {
  name: string;
  /** True only for server-stamped session identities (never free-text claims). */
  verified: boolean;
}

/**
 * Identity precedence (R15/KTD5): a server-stamped user is shown as verified,
 * whatever the body claimed; a free-text-only (public fill-link) claim shows
 * unverified; neither → em-dash placeholder.
 */
export function resolveSubmitterIdentity(
  submittedBy: { userId: string; name: string } | null | undefined,
  claimedName: string | null | undefined,
): SubmitterIdentity {
  if (submittedBy) {
    const name = submittedBy.name.trim();
    return { name: name === '' ? '—' : name, verified: true };
  }
  const claimed = claimedName?.trim() ?? '';
  return { name: claimed === '' ? '—' : claimed, verified: false };
}
