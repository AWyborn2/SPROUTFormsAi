import { PROFILE_FIELDS, sensitiveProfileFieldKeys } from './profile.js';

/**
 * A member's record as an export carries it (U39, R8, R29, R54).
 *
 * PURE: no database, no clock, no permission lookup. The gate is the route's —
 * and it is the ADMIN ACCESS LEVEL rather than a matrix action, because export
 * is the one act no configuration opens up (R54). This module says what an
 * export CONTAINS and what redaction withholds; it says nothing about who may
 * ask for one.
 *
 * WHERE THE REDACTION ACTUALLY FIRES needs saying, because on the export route
 * it never does. R54 admits only Admin and an Owner, and both hold every field,
 * so every caller who reaches the export is released to sensitive detail by
 * definition. R8's mark is not a matrix grant either — KTD26 keeps it off the
 * category deliberately — so there is no predicate on that route for "a caller
 * the organisation has not released sensitive detail to", and inventing one
 * would be specifying an access-control rule nobody asked for on the most
 * sensitive act in the product.
 *
 * So `redactProfile` lives here as a pure function over the inventory, proved by
 * unit tests, and the export's own use of it is the identity case. The other
 * consumer R8 names — an agent-facing read — is built by no unit in this plan.
 */

/** One document travelling with the record. */
export interface ExportedDocument {
  id: string;
  fileName: string;
  contentType: string;
  /** What the file evidences — the competency the document is held against. */
  competencyName: string;
  /** The storage handle. Present whatever the redaction did (R29). */
  storageKey: string;
}

export interface ProfileExport {
  membershipId: string;
  /** Every inventory value the record carries, keyed by the inventory's own keys. */
  fields: Record<string, string | null>;
  documents: ExportedDocument[];
  exportedAt: string;
}

/**
 * Withhold the fields the inventory marks sensitive (R8).
 *
 * DRIVEN BY THE INVENTORY rather than a second list, so a field marked
 * sensitive later is withheld without anyone remembering to update this — the
 * same posture the induction pattern takes, and the reason that pattern is
 * written as a destructure rather than a pick.
 *
 * Withheld keys are DROPPED rather than nulled, so a consumer cannot mistake
 * "we are not telling you" for "there is no value" — the second would read as a
 * record with no date of birth on it, which is a different and wrong fact.
 */
export function redactProfile(fields: Record<string, string | null>): Record<string, string | null> {
  const sensitive = new Set(sensitiveProfileFieldKeys());
  const out: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (sensitive.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Assemble the export.
 *
 * `redact` defaults to false because the route's own callers all hold every
 * field. Documents are EXEMPT from redaction whatever it is set to (R29): the
 * point of an export is that the licence can be produced as evidence, and a
 * redacted image is not evidence.
 */
export function buildProfileExport(input: {
  membershipId: string;
  fields: Record<string, string | null>;
  documents: readonly ExportedDocument[];
  exportedAt: Date;
  redact?: boolean;
}): ProfileExport {
  return {
    membershipId: input.membershipId,
    fields: input.redact ? redactProfile(input.fields) : { ...input.fields },
    documents: [...input.documents],
    exportedAt: input.exportedAt.toISOString(),
  };
}

/**
 * The inventory keys an export carries, in the inventory's own order.
 *
 * Derived rather than listed, so a field added to the record appears in the
 * export without a second edit — and one removed stops being exported without
 * leaving a dangling key behind.
 */
export function exportedProfileFieldKeys(): string[] {
  return PROFILE_FIELDS.filter((f) => f.presence !== 'generated').map((f) => f.key);
}
