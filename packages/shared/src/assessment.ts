/**
 * Multi-part assessment vocabulary — the shape of an assessment tool, the
 * pathways a candidate can take through it, and the outcomes each part can
 * reach.
 *
 * Two ideas carry this module.
 *
 * 1. PARTS ARE DECLARED, NOT INFERRED. A printed assessment paper is one
 *    template holding every part as a run of sections. Rather than tagging each
 *    field with a part, the tool declares where each part BEGINS — a
 *    `section_header` field id — and a part runs from there to the next part's
 *    start. That reuses the header-to-next-header convention `visibility.ts`
 *    already implements, so importing an 18-page paper needs one authoring pass
 *    instead of a field-level migration.
 *
 * 2. PATHWAY MEMBERSHIP LIVES ON THE PART. Which parts a pathway requires is
 *    declared per part rather than computed from part numbers. Hardcoding
 *    "experienced means parts 1 and 2" would be true of one document and wrong
 *    of the next; declaring it keeps the model general across every assessment
 *    tool of this shape.
 *
 * Nothing here decides which part is currently OPEN — that is case state, and
 * it is deliberately not field visibility. See the plan's layered-gating
 * decision.
 */

import type { FormField } from './form-field.js';

/**
 * The routes through an assessment tool.
 *
 * `rpl` (Recognition of Prior Learning) is a real third pathway, not a variant
 * of `experienced`: both may require the same parts, but an RPL case records a
 * justification for waiving the logged-hours parts and an experienced case does
 * not, so collapsing them would lose the reason the hours were skipped.
 */
export const ASSESSMENT_PATHWAYS = ['experienced', 'new', 'rpl'] as const;
export type AssessmentPathway = (typeof ASSESSMENT_PATHWAYS)[number];

/**
 * What kind of evidence a part gathers. Drives which surface fills it and how
 * it completes — a logbook accumulates over weeks against an hours minimum, a
 * practical is marked in one sitting, theory is auto-marked.
 */
export const PART_KINDS = ['theory', 'practical', 'logbook'] as const;
export type PartKind = (typeof PART_KINDS)[number];

/** The two outcomes the printed paper offers. There is no third. */
export const PART_OUTCOMES = ['satisfactory', 'not_satisfactory'] as const;
export type PartOutcome = (typeof PART_OUTCOMES)[number];

/**
 * What an assessor decides after a not-satisfactory outcome. The system records
 * the decision and its reason; it never makes the decision.
 */
export const NS_DISPOSITIONS = [
  'retry',
  'coaching_then_retry',
  'change_pathway',
  'not_yet_competent',
] as const;
export type NotSatisfactoryDisposition = (typeof NS_DISPOSITIONS)[number];

/**
 * Case-level state. `competent` and `closed` are both terminal; they are
 * distinct because a closed case reached no competence and an auditor must be
 * able to tell those apart at a glance.
 */
export const CASE_STATES = ['open', 'competent', 'closed'] as const;
export type AssessmentCaseState = (typeof CASE_STATES)[number];

/** One part of an assessment tool. */
export interface AssessmentPart {
  /** Stable key, referenced by attempts. Survives relabelling. */
  key: string;
  /** 1-based printed part number; defines document order. */
  ordinal: number;
  label: string;
  kind: PartKind;
  /** Pathways that require this part. */
  pathways: AssessmentPathway[];
  /** Field id of the `section_header` where this part begins. */
  startFieldId: string;
  /** Logbook parts only — hours before the next demonstration is prompted. */
  minimumHours?: number;
  /** Field id of the page-one method checklist entry this part ticks. */
  checklistFieldId?: string;
  /**
   * Theory parts only — the `section_header` whose questions must ALL be
   * correct for the part to reach satisfactory. Named rather than hardcoded to
   * "General" so the rule travels to any assessment tool with a
   * must-pass-entirely section; questions outside it are still marked, they
   * just don't gate the outcome.
   */
  mandatorySectionFieldId?: string;
}

/** The part structure of one assessment tool, against one template. */
export interface AssessmentToolManifest {
  parts: AssessmentPart[];
}

/**
 * Parts in document order. Authoring order is not guaranteed — a manifest built
 * by hand or edited later can list parts in any sequence, and every consumer
 * (fill, export, progress) needs the printed order rather than the stored one.
 */
export function orderedParts(manifest: AssessmentToolManifest): AssessmentPart[] {
  return [...manifest.parts].sort((a, b) => a.ordinal - b.ordinal);
}

/** The parts a pathway requires, in document order. */
export function requiredParts(
  manifest: AssessmentToolManifest,
  pathway: AssessmentPathway,
): AssessmentPart[] {
  return orderedParts(manifest).filter((p) => p.pathways.includes(pathway));
}

/**
 * The fields belonging to the section opened by `headerFieldId` — everything
 * after that header up to the next `section_header`, header excluded.
 *
 * This is the same header-to-next-header rule `visibility.ts` applies to
 * section scope. It lives here too because part membership and mandatory-section
 * membership are structural questions asked outside visibility evaluation, and
 * an unknown header returns nothing rather than the whole form: a manifest
 * pointing at a field that no longer exists must yield an empty section, never
 * silently claim every field in the document.
 */
export function fieldsInSection(
  fields: readonly FormField[],
  headerFieldId: string,
): FormField[] {
  const start = fields.findIndex((f) => f.id === headerFieldId);
  if (start < 0) return [];

  const out: FormField[] = [];
  for (let i = start + 1; i < fields.length; i++) {
    const field = fields[i]!;
    if (field.type === 'section_header') break;
    out.push(field);
  }
  return out;
}

/**
 * Problems that make a manifest unusable, as human-readable strings. Empty
 * means valid.
 *
 * Returning a LIST rather than throwing on the first problem is deliberate:
 * authoring a manifest for an 18-page paper is error-prone, and surfacing every
 * problem at once beats a fix-one-rerun loop.
 */
export function validateManifest(
  manifest: AssessmentToolManifest,
  fields: readonly FormField[],
): string[] {
  const problems: string[] = [];
  const parts = manifest.parts;

  if (parts.length === 0) {
    problems.push('Manifest declares no parts.');
    return problems;
  }

  const seenKeys = new Set<string>();
  const seenOrdinals = new Set<number>();
  const headerIds = new Set(
    fields.filter((f) => f.type === 'section_header').map((f) => f.id),
  );

  for (const part of parts) {
    if (seenKeys.has(part.key)) problems.push(`Duplicate part key "${part.key}".`);
    seenKeys.add(part.key);

    if (seenOrdinals.has(part.ordinal)) {
      problems.push(`Duplicate ordinal ${part.ordinal} (part "${part.key}").`);
    }
    seenOrdinals.add(part.ordinal);

    if (part.pathways.length === 0) {
      problems.push(`Part "${part.key}" belongs to no pathway.`);
    }

    // A start field that isn't in the version means the manifest was authored
    // against a different template version. Exporting that would silently drop
    // the part's values, so it is a hard problem rather than a warning.
    if (!headerIds.has(part.startFieldId)) {
      problems.push(
        `Part "${part.key}" starts at field "${part.startFieldId}", which is not a section header in this version.`,
      );
    }

    if (part.kind === 'logbook' && !(part.minimumHours && part.minimumHours > 0)) {
      problems.push(`Logbook part "${part.key}" has no positive minimumHours.`);
    }
  }

  return problems;
}

/**
 * Where a part stands. Derived from its attempts — never stored, because a
 * stored copy is a second source of truth that can disagree with the rows it
 * summarises.
 */
export type PartState = 'locked' | 'open' | 'satisfactory' | 'not_satisfactory';

/** The attempt facts progress is computed from. */
export interface AttemptFact {
  partKey: string;
  attemptNumber: number;
  /** Null while the attempt is still open. */
  outcome: PartOutcome | null;
}

export interface PartProgress {
  part: AssessmentPart;
  state: PartState;
  /** How many attempts have been made at this part. */
  attempts: number;
  /** Outcome of the highest-numbered attempt, or null if none is resolved. */
  latestOutcome: PartOutcome | null;
}

/** Attempts for one part, highest attempt number first. */
function attemptsForPart(attempts: readonly AttemptFact[], partKey: string): AttemptFact[] {
  return attempts
    .filter((a) => a.partKey === partKey)
    .sort((a, b) => b.attemptNumber - a.attemptNumber);
}

/**
 * Every part the pathway requires, with its derived state, in document order.
 *
 * Parts unlock in sequence: a part is `open` only once every EARLIER required
 * part has a satisfactory attempt. That is what stops a candidate sitting the
 * final demonstration before logging the hours it depends on. A part that has
 * ever passed stays `satisfactory` regardless of later attempts, because the
 * evidence document renders the passing attempt and the audit trail keeps the
 * rest.
 */
export function caseProgress(
  manifest: AssessmentToolManifest,
  pathway: AssessmentPathway,
  attempts: readonly AttemptFact[],
): PartProgress[] {
  const required = requiredParts(manifest, pathway);
  const out: PartProgress[] = [];
  let earlierAllSatisfied = true;

  for (const part of required) {
    const mine = attemptsForPart(attempts, part.key);
    const passed = mine.some((a) => a.outcome === 'satisfactory');
    const latestOutcome = mine.find((a) => a.outcome !== null)?.outcome ?? null;

    let state: PartState;
    if (passed) {
      state = 'satisfactory';
    } else if (!earlierAllSatisfied) {
      state = 'locked';
    } else {
      state = latestOutcome === 'not_satisfactory' ? 'not_satisfactory' : 'open';
    }

    out.push({ part, state, attempts: mine.length, latestOutcome });
    if (!passed) earlierAllSatisfied = false;
  }

  return out;
}

/** A case is competent only when every required part has passed. */
export function isCaseCompetent(progress: readonly PartProgress[]): boolean {
  return progress.length > 0 && progress.every((p) => p.state === 'satisfactory');
}

/**
 * Hours logged in a logbook part, summed from a duration column.
 *
 * Non-numeric cells contribute nothing rather than throwing: a logbook is
 * filled over weeks by someone in a cab, and one malformed row must not make
 * the whole total unreadable.
 */
export function totalLoggedHours(
  rows: readonly Record<string, unknown>[],
  durationKey: string,
): number {
  let total = 0;
  for (const row of rows) {
    const raw = row?.[durationKey];
    const value = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? ''));
    if (Number.isFinite(value) && value > 0) total += value;
  }
  return Math.round(total * 100) / 100;
}

/**
 * Problems with auto-marking configuration on a field set. Empty means valid.
 *
 * A field with neither an answer key nor an outcome target is ordinary and
 * always valid — most fields on an assessment paper are not auto-marked.
 */
export function validateAnswerKeys(fields: readonly FormField[]): string[] {
  const problems: string[] = [];
  const byId = new Map(fields.map((f) => [f.id, f]));

  for (const field of fields) {
    if (!field.answerKey) continue;

    if (field.answerKey.length === 0) {
      problems.push(`Field "${field.id}" has an empty answer key.`);
    }

    if (!field.outcomeTarget) {
      problems.push(`Field "${field.id}" has an answer key but no outcome target.`);
      continue;
    }

    if (!byId.has(field.outcomeTarget.fieldId)) {
      problems.push(
        `Field "${field.id}" targets outcome field "${field.outcomeTarget.fieldId}", which is not in this version.`,
      );
    }

    // Every keyed option must be selectable, or the question can never be
    // answered correctly — a typo in the key would otherwise fail every
    // candidate silently.
    const options = field.options ?? [];
    if (options.length > 0) {
      for (const correct of field.answerKey) {
        if (!options.includes(correct)) {
          problems.push(
            `Field "${field.id}" keys option "${correct}", which is not one of its options.`,
          );
        }
      }
    }
  }

  return problems;
}
