import {
  requiredParts,
  validateManifest,
  type AssessmentPathway,
  type AssessmentToolManifest,
  type FormField,
  type PartOutcome,
  type SubmissionValue,
} from '@formai/shared';
import { roundTripExport } from './round-trip.js';

/**
 * Assembling one evidence document from a case's many part attempts.
 *
 * The source document is ONE template with every part printed in it, and a case
 * holds one attempt row per try at each part. Export therefore has to choose
 * which attempts speak: for each part the pathway requires, the latest attempt
 * that PASSED. A part whose attempts all failed contributes nothing and prints
 * blank, exactly as the paper form would if it were never signed off.
 *
 * That selection is the whole reason this module exists. It is deliberately
 * separate from `round-trip.ts`, which knows how to draw values onto a page and
 * nothing about assessments — it stays a pure renderer, and this stays a pure
 * chooser, so neither has to understand the other.
 *
 * FAILS LOUD, NOT BLANK. A manifest that does not match the version it is
 * exported against would silently produce a document missing whole parts, which
 * on a competency record is worse than no document at all. Every such mismatch
 * raises instead.
 */

/** A mismatch that would make the exported document misrepresent the case. */
export class CaseExportError extends Error {
  readonly problems: string[];

  constructor(message: string, problems: string[] = []) {
    super(message);
    this.name = 'CaseExportError';
    this.problems = problems;
  }
}

export interface CaseAttemptRecord {
  partKey: string;
  attemptNumber: number;
  outcome: PartOutcome | null;
  values: Record<string, SubmissionValue>;
}

export interface AssembleCaseInput {
  manifest: AssessmentToolManifest;
  pathway: AssessmentPathway;
  /** The case's declared stream, seeded so visibility matches the assessment. */
  locationStream?: string | null;
  attempts: readonly CaseAttemptRecord[];
}

export interface AssembledCase {
  /** One merged answer map, ready for the renderer. */
  values: Record<string, SubmissionValue>;
  /** Part keys that contributed values, in document order. */
  rendered: string[];
  /** Required part keys with no passing attempt — these print blank. */
  blank: string[];
}

/**
 * The passing attempt that speaks for a part, or undefined.
 *
 * Highest attempt number among the satisfactory ones. Ordering by attempt
 * number rather than by time is deliberate — it is the number the paper record
 * and the audit trail both cite.
 */
function authoritativeAttempt(
  attempts: readonly CaseAttemptRecord[],
  partKey: string,
): CaseAttemptRecord | undefined {
  return attempts
    .filter((a) => a.partKey === partKey && a.outcome === 'satisfactory')
    .sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
}

/**
 * Merge the attempts that count into a single answer map.
 *
 * Parts outside the pathway are not consulted at all, so they print blank —
 * which mirrors the printed tool, where an experienced candidate's booklet
 * still contains Parts 3 to 6 with nothing written in them.
 */
export function assembleCaseValues({
  manifest,
  pathway,
  locationStream,
  attempts,
}: AssembleCaseInput): AssembledCase {
  const known = new Set(manifest.parts.map((p) => p.key));
  const unknown = [...new Set(attempts.map((a) => a.partKey))].filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new CaseExportError(
      'case_export_unknown_part',
      unknown.map((k) => `Attempt references part "${k}", which this tool's manifest does not declare.`),
    );
  }

  const values: Record<string, SubmissionValue> = {};
  const rendered: string[] = [];
  const blank: string[] = [];

  for (const part of requiredParts(manifest, pathway)) {
    const attempt = authoritativeAttempt(attempts, part.key);
    if (!attempt) {
      blank.push(part.key);
      continue;
    }
    Object.assign(values, attempt.values);
    rendered.push(part.key);
  }

  // Seeded LAST so the case wins. The stream recorded on the case is what
  // decided which sections applied during the assessment; if an attempt happens
  // to carry a different answer, rendering that one would show a reviewer a
  // different set of questions than the candidate was actually assessed on.
  if (manifest.locationStreamFieldId && locationStream) {
    values[manifest.locationStreamFieldId] = locationStream;
  }

  return { values, rendered, blank };
}

export interface ExportCaseInput extends AssembleCaseInput {
  originalPdf: Uint8Array;
  /** The full field set of the version being exported against. */
  fields: FormField[];
}

/**
 * Regenerate the complete source document for a case.
 *
 * The manifest is validated against the version's ACTUAL fields first: a part
 * whose start field is missing from this version contributes nothing, and an
 * export that quietly drops a part is indistinguishable from one where the
 * candidate never did it.
 */
export async function exportCasePdf({
  originalPdf,
  fields,
  manifest,
  pathway,
  locationStream,
  attempts,
}: ExportCaseInput): Promise<Uint8Array> {
  const problems = validateManifest(manifest, fields);
  if (problems.length > 0) {
    throw new CaseExportError('case_export_invalid_manifest', problems);
  }

  const { values } = assembleCaseValues({ manifest, pathway, locationStream, attempts });

  // `roundTripExport` applies the visibility filter itself, so a section the
  // candidate's stream excluded cannot appear carrying an answer.
  return roundTripExport({ originalPdf, fields, values });
}
