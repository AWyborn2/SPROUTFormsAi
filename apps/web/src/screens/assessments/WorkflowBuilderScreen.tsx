import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Button, Icon, useToast } from '@formai/ui';
import {
  ACCESS_LEVELS,
  PROFILE_PREFILL_KEYS,
  PROFILE_PREFILL_LABELS,
  VALUE_SOURCES,
  effectiveAccess,
  fieldsInPart,
  orderedParts,
  orderedSections,
  valueSource,
  workflowFromFields,
  type AccessLevel,
  type AssessmentWorkflow,
  type FieldAccess,
  type FormField,
  type PrerequisiteCheck,
  type ProfilePrefillKey,
  type SubmissionValue,
  type ValueSource,
  type WorkflowRole,
  type WorkflowSection,
} from '@formai/shared';
import {
  useAssessmentTool,
  useCompetencies,
  useSaveWorkflow,
  useSetLocationParts,
  useSession,
} from '../../lib/data/hooks.js';
import type { AssessmentToolDetail } from '../../lib/data/assessments.js';
import { groupFieldsByHeading, totalFields } from './workflow-groups.js';

/**
 * Who fills each section of an assessment, and in what order.
 *
 * TWO ORDERS, AND ONLY ONE OF THEM MOVES HERE. `part.ordinal` is where a part
 * PRINTS and drives the exported evidence document; `section.ordinal` is when
 * the work HAPPENS. Reordering on this screen changes the second and never the
 * first, which is what lets a declaration print on the cover page and be signed
 * last. The card list is therefore process order, and the part label on each
 * card is the only thing that says where it sits on the paper.
 *
 * EVERYTHING STARTS COLLAPSED. The Track Dozer carries 185 fields across six
 * parts. Expanded by default, the screen opens on a wall nobody can navigate;
 * collapsed, it opens on ten decisions an author can actually make. Field-level
 * detail is there for the exceptions, which is what it is for.
 */

const ROLE_LABELS: Record<WorkflowRole, string> = {
  candidate: 'Candidate',
  assessor: 'Assessor',
  supervisor: 'Supervisor',
};

const ACCESS_LABELS: Record<AccessLevel, string> = {
  hidden: 'Hidden',
  view: 'View',
  fill: 'Fill',
};

const SOURCE_LABELS: Record<ValueSource, string> = {
  entry: 'Entry',
  prefill: 'Prefill',
  auto: 'Auto',
};

/** Colour carries meaning here: green writes, blue reads, grey sees nothing. */
const ACCESS_TONE: Record<AccessLevel, string> = {
  hidden: 'bg-surface-sunken text-text-tertiary',
  view: 'bg-info-soft text-info-text',
  fill: 'bg-success-soft text-success-text',
};

/**
 * When a section's part opens, as three spellable choices over one stored
 * field. `requires` ABSENT keeps the engine's default — each part waits for
 * everything printed before it — an EMPTY list opens it straight away, and a
 * non-empty list waits for exactly the named steps. The distinction between
 * absent and empty is the whole control, so the mode is derived rather than
 * stored twice.
 */
const OPEN_MODES = ['printed order', 'straight away', 'after steps'] as const;
type OpenMode = (typeof OPEN_MODES)[number];

function openModeOf(section: WorkflowSection): OpenMode {
  if (section.requires === undefined) return 'printed order';
  return section.requires.length === 0 ? 'straight away' : 'after steps';
}

const OPEN_MODE_HINT: Record<OpenMode, string> = {
  'printed order': 'Waits for every part printed before it to pass — the default sequence.',
  'straight away': 'Available from the moment the case opens.',
  'after steps': 'Waits for the ticked steps to pass, and nothing else.',
};

/** A segmented control. One row of options, one selected. */
function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  tone,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  tone?: (v: T) => string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex gap-0.5 rounded-md bg-surface-sunken p-0.5">
      {options.map((option) => {
        const selected = option === value;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option)}
            className={`rounded-sm px-2 py-1 text-[11px] font-semibold transition-colors ${
              selected ? tone?.(option) ?? 'bg-surface-card text-text-primary' : 'text-text-tertiary hover:text-text-secondary'
            }`}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

export function WorkflowBuilderScreen() {
  const { toolId = '' } = useParams();
  const { toast } = useToast();
  const { data: tool, isLoading, isError } = useAssessmentTool(toolId);
  const { data: session } = useSession();
  const save = useSaveWorkflow(toolId);
  /*
    WHERE EACH PREFILLED VALUE COMES FROM, held apart from the workflow draft.

    The workflow says a field is `prefill`; this says FROM WHAT — the mapping
    lives on the manifest root because the cover's identity boxes belong to no
    part and so to no section. `undefined` means untouched, and an untouched
    map is not sent, so saving a workflow cannot erase a mapping somebody else
    made.
  */
  const [prefillDraft, setPrefillDraft] = useState<
    Record<string, ProfilePrefillKey> | undefined
  >(undefined);
  /**
   * Printed prerequisites mapped to the competency register — `undefined`
   * until touched, same tri-state as the prefill map and for the same reason.
   */
  const [prereqDraft, setPrereqDraft] = useState<PrerequisiteCheck[] | undefined>(undefined);
  /** Tool-declared default answers — the Assessment Methods preset. Tri-state. */
  const [defaultsDraft, setDefaultsDraft] = useState<
    Record<string, SubmissionValue> | undefined
  >(undefined);
  const competencies = useCompetencies();

  // The parts rule is an Admin act (R73). Reads for everyone, edits for admins.
  const canEditParts = session?.role === 'admin' || session?.role === 'owner';

  /**
   * The workflow being edited, or null while it is still the server's.
   *
   * Held separately rather than editing the query cache, so an unsaved change
   * is visibly unsaved and a failed save leaves the author's work on screen
   * instead of snapping back to what the server last agreed to.
   */
  const [draft, setDraft] = useState<AssessmentWorkflow | null>(null);
  const [openSections, setOpenSections] = useState<ReadonlySet<string>>(new Set());
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());

  const workflow = draft ?? tool?.workflow ?? null;
  /*
    Dirty means ANY unsaved edit. The save button used to watch only the
    workflow draft, so a prefill-only or prerequisite-only change could not be
    saved at all — the one button that commits them stayed disabled.
  */
  const dirty =
    draft !== null ||
    prefillDraft !== undefined ||
    prereqDraft !== undefined ||
    defaultsDraft !== undefined;

  /** A part's fields, grouped by printed heading. Computed once per tool load. */
  const groupsForPart = useMemo(() => {
    if (!tool) return () => [];
    const cache = new Map<string, ReturnType<typeof groupFieldsByHeading>>();
    return (partKey: string) => {
      let hit = cache.get(partKey);
      if (!hit) {
        hit = groupFieldsByHeading(fieldsInPart(tool.fields, tool.manifest, partKey));
        cache.set(partKey, hit);
      }
      return hit;
    };
  }, [tool]);

  function edit(mutate: (w: AssessmentWorkflow) => void) {
    setDraft((current) => {
      // structuredClone rather than a shallow copy: sections carry nested
      // per-field maps, and mutating one in place would edit the query cache.
      const next = structuredClone(current ?? workflow!);
      mutate(next);
      return next;
    });
  }

  function move(key: string, by: -1 | 1) {
    edit((w) => {
      const ordered = orderedSections(w);
      const at = ordered.findIndex((s) => s.key === key);
      const swap = ordered[at + by];
      if (!swap) return;
      const mine = ordered[at]!;
      // Swap the ORDINALS, not the array positions — the ordinal is the stored
      // fact and the array is only how it was read.
      const held = mine.ordinal;
      w.sections.find((s) => s.key === mine.key)!.ordinal = swap.ordinal;
      w.sections.find((s) => s.key === swap.key)!.ordinal = held;
    });
  }

  function onSave() {
    if (!workflow) return;
    const touched = prefillDraft !== undefined;
    const map = touched && Object.keys(prefillDraft!).length > 0 ? prefillDraft! : null;
    const prereqTouched = prereqDraft !== undefined;
    const defaultsTouched = defaultsDraft !== undefined;
    const defaults =
      defaultsTouched && Object.keys(defaultsDraft!).length > 0 ? defaultsDraft! : null;
    const checks =
      prereqTouched && prereqDraft!.filter((c) => c.fieldId && c.competencyId).length > 0
        ? prereqDraft!.filter((c) => c.fieldId && c.competencyId)
        : null;
    save.mutate(
      {
        workflow,
        ...(touched ? { profilePrefill: map } : {}),
        ...(prereqTouched ? { prerequisiteChecks: checks } : {}),
        ...(defaultsTouched ? { fieldDefaults: defaults } : {}),
      },
      {
      onSuccess: (result) => {
        setDraft(null);
        setPrefillDraft(undefined);
        setPrereqDraft(undefined);
        setDefaultsDraft(undefined);
        toast({
          variant: result.warnings.length > 0 ? 'warning' : 'success',
          message:
            result.warnings.length > 0
              ? `Saved with ${result.warnings.length} thing${result.warnings.length === 1 ? '' : 's'} to come back to.`
              : 'Workflow saved.',
        });
      },
      onError: (err) => {
        // Without this a rejected workflow looks like a click that did nothing,
        // and the author's unsaved edits are still on screen with no reason.
        toast({
          variant: 'warning',
          message: err instanceof Error ? err.message : 'Could not save the workflow.',
        });
      },
    });
  }

  if (isLoading) {
    return <p className="p-8 text-[13px] text-text-tertiary">Loading assessment…</p>;
  }
  if (isError || !tool || !workflow) {
    return <p className="p-8 text-[13px] text-danger-text">Could not load this assessment.</p>;
  }

  const sections = orderedSections(workflow);
  const labelByKey = new Map(workflow.sections.map((s) => [s.key, s.label]));

  return (
    <div className="fai-rise mx-auto flex max-w-[1000px] flex-col gap-4 p-[30px_28px_60px]">
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[11px] uppercase tracking-wide text-text-tertiary">
            Assessment workflow
          </div>
          <h1 className="font-heading text-[22px] font-bold">{tool.name}</h1>
          <p className="mt-1 max-w-[62ch] text-[12.5px] text-text-tertiary">
            The order below is the order the work HAPPENS. It does not move anything on the printed
            document — that stays as the paper prints it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/*
            THE ESCAPE HATCH FOR TOOLS PUBLISHED BEFORE THE BUILDER EMITTED
            WORKFLOWS. Their editor opens on the synthesised per-part default —
            the author's sections collapsed into part slices, the cover with no
            card at all — and the builder cannot republish over a published
            version to fix them. The published fields still carry the author's
            grouping (the structure editor writes a header per section), so the
            sections can be rebuilt from what this screen already holds.

            It lands in the UNSAVED draft: the author reviews what came back
            and saves it themselves. Access resets to everyone-fills — the same
            default as ever — so rebuilding never quietly changes who may
            write; it changes what the sections ARE.
          */}
          <Button
            variant="outline"
            disabled={save.isPending}
            onClick={() => {
              setDraft(workflowFromFields(tool.fields, tool.manifest));
              setPrefillDraft(undefined);
            }}
          >
            Rebuild sections from the form
          </Button>
          <Button onClick={onSave} disabled={!dirty || save.isPending}>
            {dirty ? 'Save workflow' : 'Saved'}
          </Button>
        </div>
      </header>

      {/*
        PREREQUISITES, ANSWERED FROM THE REGISTER. "Drivers Licence C or
        higher" is a claim about the candidate, not a question for them — a
        licence is a competency with an expiry, so the register already knows.
        Mapping the printed box to the competency makes the box fill itself,
        re-checked on every read; an unsatisfied prerequisite never blocks the
        assessment, and always blocks the sign-off.
      */}
      <div className="rounded-md border border-border bg-surface-card p-[13px_15px]">
        <span className="block text-[13px] font-semibold">Prerequisite checks</span>
        <p className="mt-0.5 mb-2 text-[11.5px] text-text-tertiary">
          Answered from the candidate&rsquo;s competency register — the box ticks itself, the
          candidate sits the assessment either way, and an unsatisfied prerequisite blocks the
          final sign-off.
        </p>
        {(prereqDraft ?? tool.manifest.prerequisiteChecks ?? []).map((check, index) => {
          const update = (patch: Partial<PrerequisiteCheck>) =>
            setPrereqDraft((prev) => {
              const base = [...(prev ?? tool.manifest.prerequisiteChecks ?? [])];
              base[index] = { ...base[index]!, ...patch };
              return base;
            });
          return (
            <div key={index} className="mb-1.5 flex flex-wrap items-center gap-2">
              <select
                aria-label="Printed prerequisite box"
                value={check.fieldId}
                onChange={(e) => update({ fieldId: e.target.value })}
                className="h-[26px] min-w-[220px] rounded-sm border border-border bg-surface-page px-1.5 text-[11.5px]"
              >
                <option value="">— printed box —</option>
                {tool.fields
                  .filter((f) => f.type === 'check_cross' || f.type === 'boolean_yes_no')
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label || f.id}
                    </option>
                  ))}
              </select>
              <span className="text-[11px] text-text-tertiary">answers from</span>
              <select
                aria-label="Competency that answers it"
                value={check.competencyId}
                onChange={(e) => update({ competencyId: e.target.value })}
                className="h-[26px] min-w-[220px] rounded-sm border border-border bg-surface-page px-1.5 text-[11.5px]"
              >
                <option value="">— competency —</option>
                {(competencies.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setPrereqDraft((prev) => {
                    const base = [...(prev ?? tool.manifest.prerequisiteChecks ?? [])];
                    base.splice(index, 1);
                    return base;
                  })
                }
              >
                Remove
              </Button>
            </div>
          );
        })}
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            setPrereqDraft((prev) => [
              ...(prev ?? tool.manifest.prerequisiteChecks ?? []),
              { fieldId: '', competencyId: '' },
            ])
          }
        >
          Add a prerequisite check
        </Button>
      </div>

      {tool.workflowIsDefault && !dirty && (
        <div className="rounded-md border border-border-accent bg-surface-accent-soft p-[11px_13px] text-[12.5px] text-text-secondary">
          {/*
            An author must not be shown a configuration presented as theirs when
            nobody has made one. This is what the server is enforcing today —
            every role fills everything — and saying so is what prompts a first
            pass.
          */}
          <strong className="font-semibold">Nobody has set this up yet.</strong> What you see is the
          default: one section per printed part, and every role able to fill everything. Change what
          you need and save.
        </div>
      )}

      {tool.problems.length > 0 && (
        <div className="rounded-md border border-danger bg-danger-soft p-[11px_13px]">
          <div className="mb-1 text-[12.5px] font-semibold text-danger-text">
            This workflow cannot be saved until these are fixed
          </div>
          <ul className="flex list-disc flex-col gap-1 pl-4 text-[12px] text-danger-text">
            {tool.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      {tool.warnings.length > 0 && (
        <div className="rounded-md border border-border bg-warning-soft p-[11px_13px]">
          <div className="mb-1 text-[12.5px] font-semibold text-warning-text">Worth a look</div>
          <ul className="flex list-disc flex-col gap-1 pl-4 text-[12px] text-warning-text">
            {tool.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <LocationPartsEditor tool={tool} canEdit={canEditParts} />

      <div className="flex flex-col gap-2.5">
        {sections.map((section, index) => {
          const open = openSections.has(section.key);
          /*
            A section covers a part's slice OR lists its fields directly — the
            builder emits `fieldIds` sections for cover fields that belong to
            no part (Candidate Details, Prerequisites…). Before this branch,
            such a section rendered as an empty card: the field lookup only
            knew how to slice by part.
          */
          const groups = section.partKey
            ? groupsForPart(section.partKey)
            : groupFieldsByHeading(
                (section.fieldIds ?? [])
                  .map((id) => tool.fields.find((f) => f.id === id))
                  .filter((f): f is FormField => f !== undefined),
              );
          const fieldCount = totalFields(groups);

          return (
            <div
              key={section.key}
              className="overflow-hidden rounded-lg border border-border bg-surface-card shadow-xs"
            >
              <div className="flex flex-wrap items-center gap-3 px-[18px] py-[13px]">
                <div className="flex flex-none flex-col gap-0.5">
                  <button
                    type="button"
                    onClick={() => move(section.key, -1)}
                    disabled={index === 0}
                    aria-label={`Move ${section.label} earlier`}
                    className="fai-chip-btn grid h-[15px] w-5 place-items-center rounded-sm border border-border text-[7px] text-text-tertiary disabled:opacity-30"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    onClick={() => move(section.key, 1)}
                    disabled={index === sections.length - 1}
                    aria-label={`Move ${section.label} later`}
                    className="fai-chip-btn grid h-[15px] w-5 place-items-center rounded-sm border border-border text-[7px] text-text-tertiary disabled:opacity-30"
                  >
                    ▼
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() =>
                    setOpenSections((s) => {
                      const next = new Set(s);
                      if (!next.delete(section.key)) next.add(section.key);
                      return next;
                    })
                  }
                  aria-expanded={open}
                  className="flex min-w-[180px] flex-1 flex-col items-start gap-0.5 text-left"
                >
                  <span className="text-[14px] font-semibold">{section.label}</span>
                  <span className="text-[11.5px] text-text-tertiary">
                    {section.partKey ? `${fieldCount} fields` : `${section.fieldIds?.length ?? 0} fields`}
                    {section.requires === undefined
                      ? ''
                      : section.requires.length > 0
                        ? ` · after ${section.requires.map((k) => labelByKey.get(k) ?? k).join(', ')}`
                        : ' · opens straight away'}
                  </span>
                </button>

                <div className="flex flex-none flex-col gap-1.5">
                  {workflow.roles.map((role) => (
                    <div key={role} className="flex items-center justify-end gap-2">
                      <span className="w-[68px] text-right font-mono text-[10px] uppercase tracking-wide text-text-tertiary">
                        {ROLE_LABELS[role]}
                      </span>
                      <Segmented
                        label={`${ROLE_LABELS[role]} access to ${section.label}`}
                        options={ACCESS_LEVELS}
                        value={section.access[role] ?? 'hidden'}
                        tone={(v) => ACCESS_TONE[v]}
                        onChange={(level) =>
                          edit((w) => {
                            const target = w.sections.find((s) => s.key === section.key)!;
                            target.access = { ...target.access, [role]: level };
                          })
                        }
                      />
                    </div>
                  ))}
                </div>

                <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} className="text-text-tertiary" />
              </div>

              {open && (
                <div className="border-t border-border-subtle bg-surface-sunken px-[18px] py-3">
                  {/*
                    WHEN THIS STEP OPENS. Only a part-backed section gates
                    anything — cover sections ride along inside part attempts —
                    so only those get the control. Stored on `requires`: absent
                    is the printed sequence, empty is straight away, names are
                    exactly the steps that must pass first.
                  */}
                  {section.partKey && (
                    <div className="mb-2.5 rounded-md border border-border bg-surface-card px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <span className="text-[11.5px] font-semibold text-text-secondary">Opens</span>
                        <Segmented
                          label={`When ${section.label} opens`}
                          options={OPEN_MODES}
                          value={openModeOf(section)}
                          onChange={(mode) =>
                            edit((w) => {
                              const target = w.sections.find((s) => s.key === section.key)!;
                              if (mode === 'printed order') {
                                delete target.requires;
                              } else if (mode === 'straight away') {
                                target.requires = [];
                              } else {
                                // Seed with the step before this one in process
                                // order — the common intent, and an empty pick
                                // would render as "straight away" instead.
                                const prior =
                                  sections[index - 1] ?? sections.find((s) => s.key !== section.key);
                                target.requires = prior ? [prior.key] : [];
                              }
                            })
                          }
                        />
                        <span className="text-[11px] text-text-tertiary">
                          {OPEN_MODE_HINT[openModeOf(section)]}
                        </span>
                      </div>
                      {(section.requires?.length ?? 0) > 0 && (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <span className="text-[11px] text-text-tertiary">After:</span>
                          {sections
                            .filter((s) => s.key !== section.key)
                            .map((other) => {
                              const ticked = section.requires!.includes(other.key);
                              return (
                                <button
                                  key={other.key}
                                  type="button"
                                  aria-pressed={ticked}
                                  onClick={() =>
                                    edit((w) => {
                                      const target = w.sections.find((s) => s.key === section.key)!;
                                      const current = target.requires ?? [];
                                      target.requires = ticked
                                        ? current.filter((k) => k !== other.key)
                                        : [...current, other.key];
                                    })
                                  }
                                  className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                                    ticked
                                      ? 'border-border-accent bg-surface-accent-soft text-text-accent'
                                      : 'border-border text-text-tertiary hover:text-text-secondary'
                                  }`}
                                >
                                  {other.label}
                                </button>
                              );
                            })}
                        </div>
                      )}
                    </div>
                  )}
                  {groups.length === 0 ? (
                    <p className="text-[11.5px] text-text-tertiary">
                      This section covers no fields from the current version.
                    </p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      <p className="text-[11px] text-text-tertiary">
                        Fields follow the section unless you change them here.
                      </p>
                      {groups.map((group, gi) => {
                        const groupKey = `${section.key}:${group.headingId ?? gi}`;
                        const groupOpen = openGroups.has(groupKey);
                        return (
                          <div key={groupKey} className="rounded-md border border-border bg-surface-card">
                            <button
                              type="button"
                              onClick={() =>
                                setOpenGroups((s) => {
                                  const next = new Set(s);
                                  if (!next.delete(groupKey)) next.add(groupKey);
                                  return next;
                                })
                              }
                              aria-expanded={groupOpen}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left"
                            >
                              <Icon
                                name={groupOpen ? 'chevron-down' : 'chevron-right'}
                                size={12}
                                className="flex-none text-text-tertiary"
                              />
                              <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
                                {group.heading ?? 'Before the first heading'}
                              </span>
                              <span className="flex-none font-mono text-[10.5px] text-text-tertiary">
                                {group.fields.length}
                              </span>
                            </button>

                            {groupOpen && (
                              <div className="flex flex-col gap-1.5 border-t border-border-subtle p-2.5">
                                {group.fields.map((field) => (
                                  <FieldRow
                                    key={field.id}
                                    field={field}
                                    section={section}
                                    roles={workflow.roles}
                                    prefillKey={
                                      (prefillDraft ?? tool.manifest.profilePrefill ?? {})[field.id]
                                    }
                                    defaultValue={
                                      (defaultsDraft ?? tool.manifest.fieldDefaults ?? {})[field.id]
                                    }
                                    onDefaultValue={(value) =>
                                      setDefaultsDraft((prev) => {
                                        const base = { ...(prev ?? tool.manifest.fieldDefaults ?? {}) };
                                        if (value === null) delete base[field.id];
                                        else base[field.id] = value;
                                        return base;
                                      })
                                    }
                                    onPrefillKey={(key) =>
                                      setPrefillDraft((prev) => {
                                        const base = { ...(prev ?? tool.manifest.profilePrefill ?? {}) };
                                        if (key) base[field.id] = key;
                                        else delete base[field.id];
                                        return base;
                                      })
                                    }
                                    onAccess={(role, level) =>
                                      edit((w) => {
                                        const target = w.sections.find((s) => s.key === section.key)!;
                                        const per = { ...(target.fieldAccess ?? {}) };
                                        per[field.id] = { ...(per[field.id] ?? {}), [role]: level };
                                        target.fieldAccess = per;
                                      })
                                    }
                                    onSource={(source) =>
                                      edit((w) => {
                                        const target = w.sections.find((s) => s.key === section.key)!;
                                        target.fieldSource = {
                                          ...(target.fieldSource ?? {}),
                                          [field.id]: source,
                                        };
                                      })
                                    }
                                  />
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Which of a tool's parts apply at each Location (U9).
 *
 * The map holds only the EXCEPTIONS: a Location left out requires every part
 * (R75), so a row where every chip is on is stored as no entry at all, and a
 * person at several Locations is assessed once against the union (R80, R81). A
 * rule already declared for a Location since retired is not shown here but rides
 * through a save untouched (R118), because the draft is seeded from the stored
 * map and only the active rows are ever edited.
 *
 * Declaring the rule is an Admin act (R73); for anyone else this reads.
 */
function LocationPartsEditor({ tool, canEdit }: { tool: AssessmentToolDetail; canEdit: boolean }) {
  const { toast } = useToast();
  const save = useSetLocationParts(tool.id);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string[]> | null>(null);

  const allKeys = useMemo(() => orderedParts(tool.manifest).map((p) => p.key), [tool.manifest]);
  const partLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of orderedParts(tool.manifest)) map.set(p.key, p.label);
    return (key: string) => map.get(key) ?? key;
  }, [tool.manifest]);

  const rule = draft ?? tool.locationPartKeys;
  const dirty = draft !== null;

  // Undefined entry means the default — every part applies here (R75).
  const selectionFor = (locationId: string) => rule[locationId] ?? allKeys;
  const isDefault = (locationId: string) => rule[locationId] === undefined;

  const retiredRuleCount = useMemo(() => {
    const active = new Set(tool.locations.map((l) => l.id));
    return Object.keys(tool.locationPartKeys).filter((id) => !active.has(id)).length;
  }, [tool.locations, tool.locationPartKeys]);

  function toggle(locationId: string, key: string) {
    if (!canEdit) return;
    setDraft((prev) => {
      const base: Record<string, string[]> = { ...(prev ?? tool.locationPartKeys) };
      const current = new Set(base[locationId] ?? allKeys);
      if (current.has(key)) current.delete(key);
      else current.add(key);
      const next = allKeys.filter((k) => current.has(k));
      // A full selection is the default — store it as absence, not a copy of
      // every key, so "no rule means every part" stays literally true.
      if (next.length === allKeys.length) delete base[locationId];
      else base[locationId] = next;
      return base;
    });
  }

  function onSave() {
    if (!draft) return;
    save.mutate(draft, {
      onSuccess: () => {
        setDraft(null);
        toast({ variant: 'success', message: 'Saved where each part applies.' });
      },
      onError: (err) => {
        toast({
          variant: 'warning',
          message: err instanceof Error ? err.message : 'Could not save the parts rule.',
        });
      },
    });
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface-card shadow-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-[18px] py-[13px] text-left"
      >
        <div className="min-w-0 flex-1">
          <span className="text-[14px] font-semibold">Where each part applies</span>
          <span className="mt-0.5 block text-[11.5px] text-text-tertiary">
            Pick which parts each Location requires. A Location you leave untouched requires every
            part.
          </span>
        </div>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} className="flex-none text-text-tertiary" />
      </button>

      {open && (
        <div className="border-t border-border-subtle bg-surface-sunken px-[18px] py-3.5">
          {tool.locations.length === 0 ? (
            <p className="text-[12px] text-text-tertiary">
              This organisation has no Locations yet. Add them in settings to vary which parts apply
              by site.
            </p>
          ) : (
            <div className="flex flex-col gap-2.5">
              {!canEdit && (
                <p className="rounded-md border border-border bg-surface-card p-[9px_11px] text-[11.5px] text-text-tertiary">
                  Only an admin can change where parts apply.
                </p>
              )}
              {tool.locations.map((location) => {
                const selected = new Set(selectionFor(location.id));
                return (
                  <div
                    key={location.id}
                    className="rounded-md border border-border bg-surface-card p-[11px_13px]"
                  >
                    <div className="mb-2 flex items-center gap-2">
                      <span className="text-[12.5px] font-medium">{location.name}</span>
                      {isDefault(location.id) && (
                        <span className="rounded-sm bg-surface-sunken px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-text-tertiary">
                          Every part
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {allKeys.map((key) => {
                        const on = selected.has(key);
                        return (
                          <button
                            key={key}
                            type="button"
                            aria-pressed={on}
                            disabled={!canEdit}
                            onClick={() => toggle(location.id, key)}
                            className={`rounded-sm border px-2 py-1 text-[11px] font-medium transition-colors ${
                              on
                                ? 'border-success bg-success-soft text-success-text'
                                : 'border-border bg-surface-card text-text-tertiary'
                            } ${canEdit ? 'cursor-pointer' : 'cursor-default'}`}
                          >
                            {partLabel(key)}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              {retiredRuleCount > 0 && (
                <p className="text-[11px] text-text-tertiary">
                  {retiredRuleCount} rule{retiredRuleCount === 1 ? '' : 's'} for a retired Location
                  {retiredRuleCount === 1 ? ' is' : ' are'} kept and left unchanged.
                </p>
              )}

              {canEdit && (
                <div className="flex justify-end">
                  <Button onClick={onSave} disabled={!dirty || save.isPending}>
                    {dirty ? 'Save parts rule' : 'Saved'}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One field's overrides. `Inherit` is a real choice, not the absence of one. */
function FieldRow({
  field,
  section,
  roles,
  onAccess,
  onSource,
  prefillKey,
  onPrefillKey,
  defaultValue,
  onDefaultValue,
}: {
  field: FormField;
  section: WorkflowSection;
  roles: readonly WorkflowRole[];
  onAccess: (role: WorkflowRole, level: FieldAccess) => void;
  onSource: (source: ValueSource) => void;
  /** Which profile attribute fills this field, when its source is prefill. */
  prefillKey?: ProfilePrefillKey;
  onPrefillKey?: (key: ProfilePrefillKey | null) => void;
  /** The tool's preset answer for this field, when one is declared. */
  defaultValue?: SubmissionValue;
  onDefaultValue?: (value: SubmissionValue | null) => void;
}) {
  const source = valueSource(section, field.id);
  return (
    <div className="flex flex-wrap items-center gap-2.5 rounded-sm border border-border-subtle bg-surface-card px-2.5 py-1.5">
      <div className="flex min-w-[150px] flex-1 items-center gap-2">
        <span className="truncate text-[12px] font-medium">{field.label}</span>
        <span className="flex-none rounded-sm bg-surface-sunken px-1.5 py-px font-mono text-[9px] uppercase text-text-tertiary">
          {field.type}
        </span>
      </div>

      {roles.map((role) => {
        const stored = section.fieldAccess?.[field.id]?.[role] ?? 'inherit';
        return (
          <div key={role} className="flex flex-none items-center gap-1.5">
            <span className="font-mono text-[9px] uppercase text-text-tertiary">
              {ROLE_LABELS[role].slice(0, 1)}
            </span>
            <Segmented
              label={`${ROLE_LABELS[role]} access to ${field.label}`}
              options={['inherit', ...ACCESS_LEVELS] as const}
              value={stored}
              tone={(v) =>
                v === 'inherit'
                  ? 'bg-surface-card text-text-secondary'
                  : ACCESS_TONE[v as AccessLevel]
              }
              onChange={(level) => onAccess(role, level as FieldAccess)}
            />
            <span className="font-mono text-[9px] text-text-tertiary">
              {stored === 'inherit' ? `→ ${ACCESS_LABELS[effectiveAccess(section, field.id, role)]}` : ''}
            </span>
          </div>
        );
      })}

      <div className="flex flex-none items-center gap-1.5">
        {/*
          Where the value comes from. A prefilled or auto field is unwritable by
          everyone whatever its access says — the value comes from the case
          record or from marking, and accepting a typed one would let somebody
          overwrite a derived fact with nothing to show they had.
        */}
        <span className="font-mono text-[9px] uppercase text-text-tertiary">Src</span>
        <Segmented
          label={`Where ${field.label} comes from`}
          options={VALUE_SOURCES}
          value={source}
          onChange={onSource}
        />
      </div>

      {/*
        FROM WHAT. A field marked prefill with no mapping prints blank and
        stays unwritable — locked AND empty, the worst of both — so the mapping
        control sits beside the switch that creates the need for it. Text
        fields only: the values these keys resolve to are strings, and
        `validateProfilePrefill` refuses anything else at save.
      */}
      {/*
        THE METHODS PRESET. A repeating table whose rows are fixed and whose one
        answer column is a tick — "Methods used to assess competence" — can
        carry a tool-level DEFAULT: the rows that come pre-ticked on every
        case. A default, not a derived fact: the section stays writable and an
        assessor's recorded answer always wins. Rows are written by INDEX,
        which is the same alignment the exporter's row cursor uses.
      */}
      {field.type === 'repeating_group' &&
        (field.fixedRows?.length ?? 0) > 0 &&
        (field.columns?.length ?? 0) === 2 &&
        onDefaultValue && (
          <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 pl-1">
            <span className="font-mono text-[9px] uppercase text-text-tertiary">Preset</span>
            {field.fixedRows!.map((row, index) => {
              const columnKey = field.columns![1]!.key;
              const rows = Array.isArray(defaultValue)
                ? (defaultValue as Record<string, boolean>[])
                : [];
              const ticked = rows[index]?.[columnKey] === true;
              return (
                <label key={row} className="flex items-center gap-1 text-[11px] text-text-secondary">
                  <input
                    type="checkbox"
                    checked={ticked}
                    onChange={(e) => {
                      const next = field.fixedRows!.map((_, i) => ({
                        [columnKey]: i === index ? e.target.checked : rows[i]?.[columnKey] === true,
                      }));
                      const any = next.some((r) => r[columnKey]);
                      onDefaultValue(any ? next : null);
                    }}
                  />
                  {row}
                </label>
              );
            })}
          </div>
        )}

      {source === 'prefill' && field.type === 'text' && onPrefillKey && (
        <div className="flex flex-none items-center gap-1.5">
          <span className="font-mono text-[9px] uppercase text-text-tertiary">From</span>
          <select
            aria-label={`Which profile attribute fills ${field.label}`}
            value={prefillKey ?? ''}
            onChange={(e) =>
              onPrefillKey((e.target.value || null) as ProfilePrefillKey | null)
            }
            className="h-[24px] rounded-sm border border-border bg-surface-page px-1.5 text-[11px]"
          >
            <option value="">— not mapped —</option>
            {PROFILE_PREFILL_KEYS.map((key) => (
              <option key={key} value={key}>
                {PROFILE_PREFILL_LABELS[key]}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
