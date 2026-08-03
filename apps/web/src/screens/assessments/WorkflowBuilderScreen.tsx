import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Button, Icon, useToast } from '@formai/ui';
import {
  ACCESS_LEVELS,
  VALUE_SOURCES,
  effectiveAccess,
  fieldsInPart,
  orderedSections,
  valueSource,
  type AccessLevel,
  type AssessmentWorkflow,
  type FieldAccess,
  type FormField,
  type ValueSource,
  type WorkflowRole,
  type WorkflowSection,
} from '@formai/shared';
import { useAssessmentTool, useSaveWorkflow } from '../../lib/data/hooks.js';
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
  const save = useSaveWorkflow(toolId);

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
  const dirty = draft !== null;

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
    save.mutate(workflow, {
      onSuccess: (result) => {
        setDraft(null);
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
        <Button onClick={onSave} disabled={!dirty || save.isPending}>
          {dirty ? 'Save workflow' : 'Saved'}
        </Button>
      </header>

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

      <div className="flex flex-col gap-2.5">
        {sections.map((section, index) => {
          const open = openSections.has(section.key);
          const groups = section.partKey ? groupsForPart(section.partKey) : [];
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
                    {section.requires?.length ? ` · after ${section.requires.join(', ')}` : ''}
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

/** One field's overrides. `Inherit` is a real choice, not the absence of one. */
function FieldRow({
  field,
  section,
  roles,
  onAccess,
  onSource,
}: {
  field: FormField;
  section: WorkflowSection;
  roles: readonly WorkflowRole[];
  onAccess: (role: WorkflowRole, level: FieldAccess) => void;
  onSource: (source: ValueSource) => void;
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
    </div>
  );
}
