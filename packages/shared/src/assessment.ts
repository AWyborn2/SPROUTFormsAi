/**
 * Multi-part assessment vocabulary — the shape of an assessment tool, the
 * pathways a candidate can take through it, and the outcomes each part can
 * reach.
 *
 * Two ideas carry this module.
 *
 * 1. PARTS ARE DECLARED, NOT INFERRED. A printed assessment paper is one
 *    template holding every part in sequence. Rather than tagging each field
 *    with a part, the tool declares the field each part BEGINS AT, and a part
 *    runs from there to the next part's start. Importing an 18-page paper
 *    needs one authoring pass instead of a field-level migration.
 *
 *    The anchor is any field, not a `section_header`. Extraction emits the
 *    fields a person fills in; a printed heading is not one, so a
 *    header-anchored model could not describe a real import at all.
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
import type { RepeatingRowValue, SubmissionValue } from './submission.js';

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
  /**
   * The field this part BEGINS AT, inclusive. Any field type.
   *
   * Deliberately not restricted to `section_header`. Extraction emits the
   * fields a person fills in, and a printed heading is not one — requiring a
   * header anchor made a real 18-page import unanchorable, with none of its
   * nine part boundaries resolvable. A part now runs from this field to the
   * next part's start field, which needs no furniture in the document.
   */
  startFieldId: string;
  /** Logbook parts only — hours before the next demonstration is prompted. */
  minimumHours?: number;
  /**
   * Logbook parts only — the column of the part's table that carries each
   * entry's hours. Declared rather than assumed: an imported PDF may extract
   * that column under any key, and totalling a column that does not exist
   * silently reports zero hours against a safety threshold. Validation
   * verifies the column really exists in the part's table at authoring time.
   *
   * When the template gives this column a `machine_hours` calc, the cell is
   * derived from start/finish meter readings and the filler cannot type an
   * arbitrary total; a tool without meter readings simply omits the calc and
   * the column is entered directly. That is the declared-per-tool flexibility.
   */
  durationColumnKey?: string;
  /** Field id of the page-one method checklist entry this part ticks. */
  checklistFieldId?: string;
  /**
   * Theory parts only — the questions that must ALL be answered correctly for
   * the part to reach satisfactory.
   *
   * Listed explicitly rather than derived from a section, for the same reason
   * `startFieldId` was relaxed: a document may carry no section boundary to
   * derive them from. Questions outside this list are still marked and
   * reported; they simply do not gate the outcome. Absent or empty means the
   * part has no must-pass-entirely set.
   */
  mandatoryFieldIds?: string[];
}

/** The part structure of one assessment tool, against one template. */
export interface AssessmentToolManifest {
  parts: AssessmentPart[];
  /**
   * Field whose answer selects the location stream, e.g. Mining vs Raw
   * Materials. Named here so the export can seed it from the case rather than
   * trusting whatever a filler typed: the stream decided which sections
   * applied during the assessment, so it must decide which sections render on
   * the evidence document too. Absent on a tool with no location-specific
   * content.
   */
  locationStreamFieldId?: string;
}

/**
 * The fields belonging to one part — from its start field, inclusive, up to
 * the next part's start field.
 *
 * Ranges are computed from the manifest's own ordering rather than from
 * document furniture, so a part is well defined even in a template with no
 * section headers at all. A part whose start field is missing from the version
 * yields nothing rather than the remainder of the document: a stale anchor
 * must produce an empty part, never silently swallow every field after it.
 */
export function fieldsInPart(
  fields: readonly FormField[],
  manifest: AssessmentToolManifest,
  partKey: string,
): FormField[] {
  const ordered = orderedParts(manifest);
  const index = ordered.findIndex((p) => p.key === partKey);
  if (index < 0) return [];

  const start = fields.findIndex((f) => f.id === ordered[index]!.startFieldId);
  if (start < 0) return [];

  // The next part whose anchor actually resolves bounds this one. Skipping
  // unresolvable anchors stops one broken part from truncating its neighbour.
  let end = fields.length;
  for (let i = index + 1; i < ordered.length; i++) {
    const at = fields.findIndex((f) => f.id === ordered[i]!.startFieldId);
    if (at > start) {
      end = at;
      break;
    }
  }

  return fields.slice(start, end);
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
  const fieldIds = new Set(fields.map((f) => f.id));

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
    // the part's values, so it is a hard problem rather than a warning. The
    // field may be of ANY type — see `startFieldId`.
    if (!fieldIds.has(part.startFieldId)) {
      problems.push(
        `Part "${part.key}" starts at field "${part.startFieldId}", which is not in this version.`,
      );
    }

    for (const id of part.mandatoryFieldIds ?? []) {
      if (!fieldIds.has(id)) {
        problems.push(`Part "${part.key}" names mandatory field "${id}", which is not in this version.`);
      }
    }

    if (part.kind === 'logbook') {
      if (!(part.minimumHours && part.minimumHours > 0)) {
        problems.push(`Logbook part "${part.key}" has no positive minimumHours.`);
      }
      if (!part.durationColumnKey) {
        problems.push(`Logbook part "${part.key}" declares no durationColumnKey.`);
      } else {
        // The declared column must exist in the part's own table. Totalling a
        // column that is not there silently reports zero hours against a
        // safety threshold, so the mismatch is an authoring error — caught
        // here, where an author can fix it.
        const table = fieldsInSection(fields, part.startFieldId).find(
          (f) => f.type === 'repeating_group',
        );
        if (!table) {
          problems.push(`Logbook part "${part.key}" has no repeating table in its section.`);
        } else if (
          table.columns &&
          !table.columns.some((c) => c.key === part.durationColumnKey)
        ) {
          problems.push(
            `Logbook part "${part.key}" names duration column "${part.durationColumnKey}", which is not a column of its table.`,
          );
        }
      }
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
 * WHICH rows a logbook part's hours are counted from — the one rule, shared.
 *
 * There were three, and they disagreed. The threshold notification counted the
 * rows under the part's declared table; the progress dashboard counted every
 * array on the attempt; the retry carry-forward had its own copy of the lookup.
 * Two readers of the same attempt could therefore report different totals with
 * no retry involved at all — and an auditor comparing the dashboard against the
 * audit trail would find a contradiction with nothing to explain it.
 *
 * The rule is the part's DECLARED table: the repeating group inside the part's
 * own section. That is what the manifest says the hours come from, so it is what
 * counts.
 *
 * The fallback exists because saved values are not validated against the part —
 * the save route stores whatever keys the client sends, and real data already
 * carries logbook rows under keys the manifest never named. Ignoring those would
 * silently zero a candidate's hours, which is worse than reading them from an
 * unexpected key. It is narrowed to arrays OF OBJECTS: a checkbox group's
 * answers are an array of strings, and the threshold's old fallback would have
 * happily counted one as a logbook.
 */
export function logbookRows(
  fields: readonly FormField[],
  part: Pick<AssessmentPart, 'startFieldId' | 'durationColumnKey'>,
  values: Record<string, SubmissionValue> | null | undefined,
): RepeatingRowValue[] {
  const all = values ?? {};
  const isRowList = (v: unknown): v is RepeatingRowValue[] =>
    Array.isArray(v) && v.length > 0 && v.every((r) => typeof r === 'object' && r !== null);

  const table = fieldsInSection(fields, part.startFieldId).find((f) => f.type === 'repeating_group');
  const declared = table ? all[table.id] : undefined;
  if (isRowList(declared)) return declared;

  // The fallback also requires the DURATION COLUMN. A row list that does not
  // carry the column this part totals is not this part's log — most obviously
  // another part's table, which an attempt should never hold but nothing
  // enforces. Without this the fallback would count someone else's hours.
  const key = part.durationColumnKey;
  if (!key) return [];
  return Object.values(all).find((v) => isRowList(v) && key in (v[0] ?? {})) as
    | RepeatingRowValue[]
    | undefined ?? [];
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
