/**
 * Who does what, and when — configured per assessment tool.
 *
 * The printed document decides what gets MARKED and where marks PRINT. This
 * decides who may see and write each field, in what order the work happens, and
 * what has to finish before the next thing opens. The two are deliberately not
 * the same ordering: a candidate declaration is printed on the cover page and
 * signed last, and no single number can express both facts.
 *
 * `AssessmentPart.ordinal` keeps its documented meaning — "1-based printed part
 * number; defines document order" — and keeps driving `fieldsInPart`, the
 * export merge and every printed coordinate. `WorkflowSection.ordinal` is
 * process order and is the only thing that decides what opens next.
 *
 * ROLES ARE A LIST, NOT TWO COLUMNS. A candidate and an assessor cover the
 * Track Dozer, but a logbook may be countersigned by a supervisor who is
 * neither — so nothing here hardcodes a pair. Adding a role is a value in an
 * array, not a schema change and not a new column in every access map.
 */

import { fieldsInPart, partMarkFieldIds, signOffMarkFieldIds } from './assessment.js';
import type { AssessmentToolManifest } from './assessment.js';
import type { FormField } from './form-field.js';

/** Roles that can be assigned work. Ordered — the builder renders them in turn. */
export const WORKFLOW_ROLES = ['candidate', 'assessor', 'supervisor'] as const;
export type WorkflowRole = (typeof WORKFLOW_ROLES)[number];

/**
 * What one role may do with a section or field.
 *
 * `view` is not a courtesy. A candidate is meant to SEE the practical criteria
 * they will be marked against — that is the standard being applied to them —
 * while never being able to mark themselves against it. Hidden and read-only
 * are different answers to different questions and both are needed.
 */
export const ACCESS_LEVELS = ['hidden', 'view', 'fill'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

/**
 * A field's access, which may defer to its section.
 *
 * `inherit` is stored explicitly rather than represented by absence. An author
 * who sets a section to `fill` expects the fields to follow, and later changes
 * the section — every inheriting field must move with it. A field that had been
 * silently defaulted would have to be guessed at.
 */
export type FieldAccess = AccessLevel | 'inherit';

/**
 * Where a field's value comes from.
 *
 * Not new behaviour — a name for behaviour that already exists and was never
 * configurable. `prefill` is what `candidateNameFieldId` already does, seeding
 * the printed name from the case record. `auto` is what `markTheory` already
 * does, computing a verdict nobody types. Naming them lets an author see why a
 * field they cannot fill is nonetheless going to be populated.
 */
export const VALUE_SOURCES = ['entry', 'prefill', 'auto'] as const;
export type ValueSource = (typeof VALUE_SOURCES)[number];

/** One step of the process. */
export interface WorkflowSection {
  key: string;
  /** PROCESS order. Unrelated to `part.ordinal`, which is document order. */
  ordinal: number;
  label: string;
  /**
   * The printed part this section covers, when it covers one.
   *
   * Absent for a section over fields that belong to no part — the cover page
   * and its declaration, which `fieldsInPart` excludes because it slices from
   * the first part's anchor onward.
   */
  partKey?: string;
  /** Fields covered directly. Used when `partKey` is absent, or to extend it. */
  fieldIds?: string[];
  /** Section-level access. A role not named here is `hidden`. */
  access: Partial<Record<WorkflowRole, AccessLevel>>;
  /** Per-field overrides. A field or role not named inherits from the section. */
  fieldAccess?: Record<string, Partial<Record<WorkflowRole, FieldAccess>>>;
  /** Per-field value source. Absent means `entry`. */
  fieldSource?: Record<string, ValueSource>;
  /**
   * Sections that must be COMPLETE before this one opens.
   *
   * Named rather than implied by ordinal, because reordering the process must
   * not silently break a dependency. "Fifty logged hours before the final
   * practical" is a safety rule, not a consequence of which card sits higher in
   * a list — and an author dragging cards should not be able to dissolve it
   * without deleting it.
   */
  requires?: string[];
}

export interface AssessmentWorkflow {
  /** Roles this assessment uses, in the order the builder shows them. */
  roles: WorkflowRole[];
  sections: WorkflowSection[];
}

/**
 * What a role may do with one field, after the section/field cascade.
 *
 * The whole cascade in one place, because a caller that resolved it itself
 * would be a second implementation of the rule that decides whether somebody
 * can write to a competency record.
 */
export function effectiveAccess(
  section: WorkflowSection,
  fieldId: string,
  role: WorkflowRole,
): AccessLevel {
  const sectionLevel = section.access[role] ?? 'hidden';
  const override = section.fieldAccess?.[fieldId]?.[role];
  if (override === undefined || override === 'inherit') return sectionLevel;
  return override;
}

/** Where one field's value comes from. */
export function valueSource(section: WorkflowSection, fieldId: string): ValueSource {
  return section.fieldSource?.[fieldId] ?? 'entry';
}

/**
 * Whether a role may WRITE a field.
 *
 * A `prefill` or `auto` field is never writable by anyone, whatever its access
 * says. The value comes from the case record or from marking, so accepting a
 * typed one would let a person overwrite a derived fact and leave no trace that
 * they had — and on the printed name of the person being certified, that is
 * exactly the edit nobody should be able to make.
 */
export function canWrite(
  section: WorkflowSection,
  fieldId: string,
  role: WorkflowRole,
): boolean {
  if (valueSource(section, fieldId) !== 'entry') return false;
  return effectiveAccess(section, fieldId, role) === 'fill';
}

/** The fields of a section, resolved against a version's field list. */
export function fieldIdsInSection(
  section: WorkflowSection,
  partFieldIds: (partKey: string) => readonly string[],
): string[] {
  const out = new Set<string>();
  if (section.partKey) for (const id of partFieldIds(section.partKey)) out.add(id);
  for (const id of section.fieldIds ?? []) out.add(id);
  return [...out];
}

/** Sections in PROCESS order. Authoring order is not guaranteed. */
export function orderedSections(workflow: AssessmentWorkflow): WorkflowSection[] {
  return [...workflow.sections].sort((a, b) => a.ordinal - b.ordinal);
}

/**
 * The section covering one printed part, or null.
 *
 * Null when an authored workflow leaves the part uncovered — `validateWorkflow`
 * warns about that rather than refusing it, so each caller has to decide what
 * an uncovered part means. On the fill surface it means the pre-workflow
 * behaviour stands, because the alternative is a part nobody can open.
 */
export function sectionForPart(
  workflow: AssessmentWorkflow,
  partKey: string,
): WorkflowSection | null {
  return workflow.sections.find((s) => s.partKey === partKey) ?? null;
}

/**
 * Which of these fields a role may WRITE.
 *
 * Deliberately not a filter over what they may SEE. A candidate is meant to
 * read the practical criteria they will be marked against — that is the
 * standard being applied to them — while never being able to mark themselves
 * against it. Visibility and writability are separate questions and this
 * answers only the second.
 */
export function writableFieldIds(
  section: WorkflowSection | null,
  fields: readonly FormField[],
  role: WorkflowRole,
): string[] {
  // Nothing configured for this part: the behaviour that predates workflows
  // stands, and every field of the part is writable.
  if (!section) return fields.map((f) => f.id);
  return fields.filter((f) => canWrite(section, f.id, role)).map((f) => f.id);
}

/** Which of these fields a role may not even see. */
export function hiddenFieldIds(
  section: WorkflowSection | null,
  fields: readonly FormField[],
  role: WorkflowRole,
): string[] {
  if (!section) return [];
  return fields.filter((f) => effectiveAccess(section, f.id, role) === 'hidden').map((f) => f.id);
}

/**
 * The section that COVERS one field, for a given part's attempt.
 *
 * A section listing the field in `fieldIds` wins over the section covering the
 * part's slice. That is what makes an authored cover-section real: the
 * builder's "Prerequisites" and "More Coaching Required" print INSIDE the
 * declaration part's contiguous slice, and without this rule their own
 * sections would be display furniture while the slice's section quietly
 * governed their fields.
 */
export function sectionCoveringField(
  workflow: AssessmentWorkflow,
  fieldId: string,
  partKey: string,
): WorkflowSection | null {
  const direct = workflow.sections.find((s) => s.fieldIds?.includes(fieldId));
  return direct ?? sectionForPart(workflow, partKey);
}

/**
 * Hidden and writable ids for one part's fields, resolved PER FIELD.
 *
 * The single-section `writableFieldIds`/`hiddenFieldIds` pair stays for
 * callers that already resolved a section; this is the coverage-aware form the
 * attempt routes use, so a field claimed by a `fieldIds` section obeys that
 * section rather than the slice it happens to print inside.
 */
export function partFieldAccess(
  workflow: AssessmentWorkflow,
  partKey: string,
  fields: readonly FormField[],
  role: WorkflowRole,
): { hidden: string[]; writable: string[] } {
  const hidden: string[] = [];
  const writable: string[] = [];
  for (const field of fields) {
    const section = sectionCoveringField(workflow, field.id, partKey);
    if (!section) {
      // Nothing configured anywhere: pre-workflow behaviour stands.
      writable.push(field.id);
      continue;
    }
    if (effectiveAccess(section, field.id, role) === 'hidden') hidden.push(field.id);
    if (canWrite(section, field.id, role)) writable.push(field.id);
  }
  return { hidden, writable };
}

/**
 * Reconstruct the author's sections FROM THE PUBLISHED FIELDS.
 *
 * The builder's structure editor writes a `section_header` for every section
 * and orders the fields beneath it, so a published version carries the
 * author's grouping even when no workflow was ever stored. This walks that
 * order: each header starts a section, fields until the next header belong to
 * it, and a section whose span contains a part's anchor carries that
 * `partKey`.
 *
 * WHY IT EXISTS. Tools published before the builder emitted workflows show the
 * synthesised per-part default — the author's seven sections collapsed to
 * four cards, the cover with no card at all — and the builder cannot republish
 * over a published version to fix them. The editor's "rebuild" action calls
 * this against the fields it already holds, so every existing tool can adopt
 * its own structure without touching the version.
 *
 * Same guarantees as the builder's emission: everyone-fills access (changing
 * who may write is the author's act, not a rebuild's), outcome cells locked
 * `auto` through `autoSourcesFor`, profile-mapped fields locked `prefill`.
 */
export function workflowFromFields(
  fields: readonly FormField[],
  manifest: AssessmentToolManifest,
): AssessmentWorkflow {
  interface Draft {
    key: string;
    label: string;
    ids: string[];
  }
  const drafts: Draft[] = [];
  let current: Draft | null = null;
  for (const field of fields) {
    if (field.type === 'section_header') {
      current = { key: field.id, label: field.label, ids: [] };
      drafts.push(current);
      continue;
    }
    if (!current) {
      // Fields before any header — a version not written by the structure
      // editor. They still need a card, or the rebuild would hide them.
      current = { key: 'front', label: 'Front page', ids: [] };
      drafts.push(current);
    }
    current.ids.push(field.id);
  }

  const sections: WorkflowSection[] = drafts.map((draft, index) => {
    const span = new Set(draft.ids);
    const part = manifest.parts.find((p) => span.has(p.startFieldId));
    const base: WorkflowSection = {
      key: draft.key,
      ordinal: index + 1,
      label: draft.label,
      access: { candidate: 'fill', assessor: 'fill' },
    };
    if (part) {
      return { ...base, partKey: part.key, fieldSource: autoSourcesFor(manifest, part, fields) };
    }
    const fieldSource: Record<string, ValueSource> = {};
    for (const id of draft.ids) {
      if (manifest.profilePrefill?.[id]) fieldSource[id] = 'prefill';
    }
    return {
      ...base,
      fieldIds: draft.ids,
      ...(Object.keys(fieldSource).length > 0 ? { fieldSource } : {}),
    };
  });

  return { roles: ['candidate', 'assessor'], sections };
}

/**
 * The workflow a tool has when nobody has configured one.
 *
 * Synthesised on read and never stored, so an unconfigured tool keeps behaving
 * exactly as it does today and no migration writes a guess into anyone's data.
 * One section per part, in document order, with candidate and assessor both
 * able to fill everything — which is precisely the current behaviour, including
 * the hole it leaves open.
 *
 * DELIBERATELY NOT INFERRED FROM `part.kind`. Defaulting practicals to
 * assessor-only would be a better guess, and it would still be a guess: this
 * module's neighbouring doctrine is that parts are declared, not inferred, and
 * quietly changing who may write a safety assessment is not something to do on
 * a default. The builder's "no role set" warning is what moves an author to
 * decide, and increment 1's part-scoping is what closes the hole meanwhile.
 */
export function derivedWorkflow(
  manifest: AssessmentToolManifest,
  /**
   * The version's fields, so each question's own outcome cell can be found.
   *
   * OPTIONAL, and its absence is why the cells stayed writable. A manifest does
   * not list them — `outcomeTarget` lives on the QUESTION — so a signature
   * taking the manifest alone cannot see them at all. Callers that have the
   * fields should pass them; one that does not gets the old behaviour for those
   * cells rather than a wrong guess.
   */
  fields: readonly FormField[] = [],
): AssessmentWorkflow {
  const sections = [...manifest.parts]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((part) => ({
      key: part.key,
      ordinal: part.ordinal,
      label: part.label,
      partKey: part.key,
      access: { candidate: 'fill' as AccessLevel, assessor: 'fill' as AccessLevel },
      /*
        A DERIVED CELL IS NOBODY'S TO FILL, and until now it was everybody's.

        This default gave candidate and assessor `fill` on every field of the
        part — which includes the ✓/✗ OUTCOME CELLS. So a published assessment
        showed the candidate "Outcome for Q5: [Satisfactory] [Not satisfactory]"
        as two live buttons and let them press one. A person could mark their
        own competency assessment, on the surface built to stop exactly that.

        `auto` is the mechanism that was already here for it: `canWrite` refuses
        a non-`entry` field for EVERY role, so the value can only come from
        marking. The comment above this function conceded the hole ("including
        the hole it leaves open") and this closes it without guessing at
        anything — every id comes from a declaration the tool already made,
        never from a part's kind.

        Marking overwrites these at resolve time regardless, so nothing is lost
        by refusing the keystroke: a typed outcome was never going to survive.
      */
      fieldSource: autoSourcesFor(manifest, part, fields),
    }));
  return { roles: ['candidate', 'assessor'], sections };
}

/**
 * Every field of one part whose value the SYSTEM writes, as a `fieldSource`
 * map.
 *
 * DECLARATIONS ONLY. Each id here is one the tool itself names — a question's
 * `outcomeTarget`, the part's verdict pair, its checklist tick. Nothing is
 * inferred from a field's type or a part's kind, which is the same line
 * `derivedWorkflow` draws about access: quietly changing who may write a safety
 * assessment on a guess is not something to do on a default.
 *
 * The per-question outcome cells are found from the FIELDS of the part, which
 * the manifest does not carry — so they are read off `outcomeTarget`, which is
 * the same declaration `markTheory` writes through. A tool declaring none of
 * this produces an empty map and behaves exactly as it did.
 */
export function autoSourcesFor(
  manifest: AssessmentToolManifest,
  part: AssessmentToolManifest['parts'][number],
  fields: readonly FormField[],
): Record<string, ValueSource> {
  const out: Record<string, ValueSource> = {};
  const auto = (id: string | undefined) => {
    if (id) out[id] = 'auto';
  };

  /*
    Shared with `isSelfMarking`, which must IGNORE exactly the fields this must
    LOCK. One list — "what marking writes" — and two copies of it drifting
    apart is how a box ends up both hand-fillable and machine-written.
  */
  for (const id of partMarkFieldIds(part)) auto(id);

  /*
    EVERY QUESTION'S OWN ✓/✗ CELL — the ones the candidate could press.

    Scoped to this part's fields, so a section covers only the cells printed
    inside it. Read off `outcomeTarget`, which is the same declaration
    `markTheory` writes through: if marking will write it, nobody types it.
  */
  for (const field of fieldsInPart(fields, manifest, part.key)) {
    auto(field.outcomeTarget?.fieldId);
    /*
      A PROFILE-MAPPED FIELD IS PREFILLED, NOT TYPED — same doctrine, different
      source. The id comes from `manifest.profilePrefill`, a declaration the
      tool makes, never from a guess about the field; `canWrite` refuses every
      non-`entry` field, so mapping a field is what locks it.
    */
    if (manifest.profilePrefill?.[field.id]) out[field.id] = 'prefill';
  }

  /*
    The front page belongs to no part, so it is attached to the FIRST — the
    only section that reliably exists. Its boxes are written by the export from
    the case's own state, and a candidate pressing "Candidate Competent" on the
    fill surface would be certifying themselves.
  */
  if (part.ordinal === Math.min(...manifest.parts.map((p) => p.ordinal))) {
    for (const id of signOffMarkFieldIds(manifest)) auto(id);
  }

  return out;
}

/** The tool's workflow, configured or synthesised. */
export function workflowOf(
  manifest: AssessmentToolManifest,
  fields: readonly FormField[] = [],
): AssessmentWorkflow {
  return manifest.workflow ?? derivedWorkflow(manifest, fields);
}

export interface WorkflowValidation {
  /** Structurally wrong. The API refuses to save these. */
  problems: string[];
  /** Worth an author's attention, never blocking. */
  warnings: string[];
}

/**
 * Check a workflow against the manifest and the version's fields.
 *
 * Split into problems and warnings rather than one list, because the two need
 * different treatment: a section naming a part that does not exist cannot be
 * saved, while a section nobody has assigned a role to is an unfinished
 * configuration an author is entitled to save and come back to.
 */
export function validateWorkflow(
  workflow: AssessmentWorkflow,
  manifest: AssessmentToolManifest,
  fields: readonly FormField[],
): WorkflowValidation {
  const problems: string[] = [];
  const warnings: string[] = [];

  if (workflow.roles.length === 0) {
    problems.push('A workflow needs at least one role.');
  }
  const roleSet = new Set(workflow.roles);

  const partKeys = new Set(manifest.parts.map((p) => p.key));
  const fieldIds = new Set(fields.map((f) => f.id));
  const sectionKeys = new Set<string>();
  const seenOrdinals = new Set<number>();
  /** Which section claims each field — a field owned twice has no answer. */
  const claimedBy = new Map<string, string>();

  for (const section of workflow.sections) {
    if (sectionKeys.has(section.key)) problems.push(`Duplicate section key "${section.key}".`);
    sectionKeys.add(section.key);

    if (seenOrdinals.has(section.ordinal)) {
      problems.push(`Duplicate process position ${section.ordinal} (section "${section.key}").`);
    }
    seenOrdinals.add(section.ordinal);

    if (section.partKey && !partKeys.has(section.partKey)) {
      problems.push(`Section "${section.key}" covers part "${section.partKey}", which this tool has no part for.`);
    }
    if (!section.partKey && (section.fieldIds ?? []).length === 0) {
      problems.push(`Section "${section.key}" covers no part and names no fields, so it contains nothing.`);
    }

    for (const id of section.fieldIds ?? []) {
      if (!fieldIds.has(id)) {
        problems.push(`Section "${section.key}" names field "${id}", which is not in this version.`);
        continue;
      }
      const already = claimedBy.get(id);
      if (already && already !== section.key) {
        // Two sections owning one field cannot both be right about who writes
        // it, and the answer would depend on iteration order.
        problems.push(`Field "${id}" is claimed by both "${already}" and "${section.key}".`);
      } else {
        claimedBy.set(id, section.key);
      }
    }

    for (const role of Object.keys(section.access) as WorkflowRole[]) {
      if (!roleSet.has(role)) {
        problems.push(`Section "${section.key}" sets access for role "${role}", which this workflow does not use.`);
      }
    }

    for (const [id, perRole] of Object.entries(section.fieldAccess ?? {})) {
      if (!fieldIds.has(id)) {
        problems.push(`Section "${section.key}" overrides field "${id}", which is not in this version.`);
      }
      for (const role of Object.keys(perRole) as WorkflowRole[]) {
        if (!roleSet.has(role)) {
          problems.push(`Section "${section.key}" overrides field "${id}" for role "${role}", which this workflow does not use.`);
        }
      }
    }

    for (const required of section.requires ?? []) {
      if (required === section.key) {
        problems.push(`Section "${section.key}" requires itself.`);
      } else if (!workflow.sections.some((s) => s.key === required)) {
        problems.push(`Section "${section.key}" requires "${required}", which is not a section of this workflow.`);
      }
    }

    const fillers = workflow.roles.filter((r) => section.access[r] === 'fill');
    if (fillers.length === 0) {
      const sectionFieldIds = fieldIdsInSection(section, (pk) =>
        fieldsInPart(fields, manifest, pk).map((f) => f.id),
      );
      const allSystemSourced =
        sectionFieldIds.length > 0 &&
        sectionFieldIds.every((id) => valueSource(section, id) !== 'entry');
      if (!allSystemSourced) {
        warnings.push(`Nobody fills "${section.label}" — no role is set to Fill, so it can never be completed.`);
      }
    }
  }

  /*
    A DEPENDENCY THAT POINTS BACKWARDS IS A DEADLOCK.

    Checked as a plain cycle search rather than by comparing ordinals, because
    process order and dependency are separate facts on purpose: a section may
    legitimately sit later than something it does not depend on. What must never
    happen is a loop, which would leave both sections permanently blocked with
    nothing on screen to say why.
  */
  const byKey = new Map(workflow.sections.map((s) => [s.key, s]));
  const state = new Map<string, 'visiting' | 'done'>();
  const walk = (key: string, trail: string[]): void => {
    const mark = state.get(key);
    if (mark === 'done') return;
    if (mark === 'visiting') {
      problems.push(`Sections depend on each other in a loop: ${[...trail, key].join(' → ')}.`);
      return;
    }
    state.set(key, 'visiting');
    for (const next of byKey.get(key)?.requires ?? []) {
      if (byKey.has(next)) walk(next, [...trail, key]);
    }
    state.set(key, 'done');
  };
  for (const section of workflow.sections) walk(section.key, []);

  // Every part the tool declares should be reachable. A part no section covers
  // is content nobody will ever be shown — the cover page's problem, made
  // visible instead of discovered at export.
  const covered = new Set(workflow.sections.map((s) => s.partKey).filter(Boolean));
  for (const part of manifest.parts) {
    if (!covered.has(part.key)) {
      warnings.push(`No section covers "${part.label}", so nobody is asked to complete it.`);
    }
  }

  return { problems, warnings };
}
