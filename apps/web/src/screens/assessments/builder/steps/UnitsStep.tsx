import { Icon } from '@formai/ui';
import {
  ASSESSMENT_PATHWAYS,
  PART_KINDS,
  type AssessmentPathway,
  type PartKind,
} from '@formai/shared';
import {
  logbookChoiceColumnsFor,
  logbookColumnsFor,
  taskMinimumsFromColumn,
  withTaskTargetHours,
} from '../builder-manifest.js';
import type { BuilderDraftState } from '../use-builder-draft.js';

/**
 * Step 4 — units and gating.
 *
 * WHAT THIS REPLACES. `author-track-dozer-tool.mjs` builds the part manifest by
 * matching heading TEXT against a hard-coded list of six, infers each part's
 * kind from that same text, and refuses to write unless all six anchors resolve.
 * Its own comments call it heuristic. Every one of those guesses exists because
 * a script cannot ask — this screen asks.
 *
 * TWO ORDERS, SHOWN AS TWO THINGS. A part's printed number never moves: it ties
 * the part to the paper the candidate signs, and an attempt records a part key,
 * so renumbering would re-point stored attempts at different pages. Reordering
 * here changes only which part an assessor works through first. The printed
 * number is rendered beside every part precisely so the distinction is visible
 * rather than explained.
 *
 * THE PROBLEMS ARE THE VALIDATOR'S OWN. `validateManifest` runs live over the
 * derived manifest and its messages are shown verbatim — all of them at once,
 * not the first. They are written for a person, and a second wording here would
 * be a second thing to keep true, disagreeing with publish exactly when it
 * mattered.
 */

const KIND_LABELS: Record<PartKind, string> = {
  theory: 'Theory',
  practical: 'Practical',
  logbook: 'Logbook',
  declaration: 'Declaration',
};

const PATHWAY_LABELS: Record<AssessmentPathway, string> = {
  new: 'New',
  experienced: 'Experienced',
  rpl: 'RPL',
};

export interface UnitsStepProps {
  draft: BuilderDraftState;
}

export function UnitsStep({ draft }: UnitsStepProps) {
  const { parts, partOps, manifestProblems, fields, extraction } = draft;

  const prerequisites = (extraction?.fields ?? []).filter(
    (f) => f.coverSection === 'pathway_prerequisites',
  );

  if (parts.length === 0) {
    return (
      <p className="rounded-[14px] border border-border bg-surface-card p-4 text-[12.5px] text-text-secondary">
        No parts yet. Every non-cover section with at least one field becomes a part — add or ungroup
        a section in <strong>Generate</strong> and it will appear here.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 rounded-[14px] border border-border bg-surface-card p-4">
        <span className="min-w-0 flex-1">
          <span className="block text-[14.5px] font-semibold">Units &amp; gating</span>
          <span className="mt-0.5 block text-[11.5px] text-text-tertiary">
            {parts.length} part{parts.length === 1 ? '' : 's'} · reordering changes the order an
            assessor works through, never the printed document
          </span>
        </span>
        <button
          type="button"
          onClick={partOps.reset}
          title="Reset to what the structure derives"
          aria-label="Reset units"
          className="grid h-[26px] w-[26px] flex-none place-items-center rounded-lg border border-border text-text-tertiary hover:bg-surface-hover"
        >
          <Icon name="rotate-ccw" size={13} />
        </button>
      </div>

      {manifestProblems.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-[14px] border border-warning bg-warning-soft p-3">
          <span className="text-[11.5px] font-semibold text-warning-text">
            {manifestProblems.length} problem{manifestProblems.length === 1 ? '' : 's'} to fix before
            publishing
          </span>
          {/*
            EVERY problem, not the first. An author who fixes one and is handed
            the next has to re-run the gate once per mistake; the script's own
            all-or-nothing refusal is what that feels like from the outside.
          */}
          {manifestProblems.map((problem, i) => (
            <p key={i} className="text-[11.5px] text-warning-text">
              {problem}
            </p>
          ))}
        </div>
      )}

      {parts.map((part, i) => {
        const columns = logbookColumnsFor(part, fields);
        const choiceColumns = logbookChoiceColumnsFor(part, fields);
        const taskMin = part.taskMinimums ?? null;
        const taskColumn = taskMin ? choiceColumns.find((c) => c.key === taskMin.columnKey) : undefined;
        return (
          <div key={part.key} className="rounded-[14px] border border-border bg-surface-card p-4">
            <div className="flex items-start gap-2">
              <span className="flex flex-none flex-col gap-0.5">
                <button
                  type="button"
                  aria-label={`Move ${part.label} earlier`}
                  disabled={i === 0}
                  onClick={() => partOps.move(part.key, -1)}
                  className="grid h-[18px] w-[22px] place-items-center rounded border border-border text-text-tertiary disabled:opacity-40 hover:bg-surface-hover"
                >
                  <Icon name="chevron-up" size={11} />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${part.label} later`}
                  disabled={i === parts.length - 1}
                  onClick={() => partOps.move(part.key, 1)}
                  className="grid h-[18px] w-[22px] place-items-center rounded border border-border text-text-tertiary disabled:opacity-40 hover:bg-surface-hover"
                >
                  <Icon name="chevron-down" size={11} />
                </button>
              </span>

              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] font-semibold">{part.label}</span>
                <span className="mt-0.5 block text-[11px] text-text-tertiary">
                  {/*
                    The printed number, said plainly. It is the one thing on this
                    screen reordering does not change.
                  */}
                  Printed as part {part.ordinal} · starts at{' '}
                  {fields.find((f) => f.id === part.startFieldId)?.label ?? part.startFieldId}
                  {part.mandatoryFieldIds && part.mandatoryFieldIds.length > 0 && (
                    <> · {part.mandatoryFieldIds.length} must-pass question
                      {part.mandatoryFieldIds.length === 1 ? '' : 's'}</>
                  )}
                </span>
              </span>

              <select
                aria-label={`Kind for ${part.label}`}
                value={part.kind}
                onChange={(e) => partOps.update(part.key, { kind: e.target.value as PartKind })}
                className="h-[28px] flex-none rounded-lg border border-border bg-surface-page px-2 text-[11px]"
              >
                {PART_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </div>

            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-text-tertiary">Required by</span>
              {ASSESSMENT_PATHWAYS.map((pathway) => {
                const on = part.pathways.includes(pathway);
                return (
                  <button
                    key={pathway}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    aria-label={`${PATHWAY_LABELS[pathway]} requires ${part.label}`}
                    onClick={() =>
                      partOps.setPathways(
                        part.key,
                        on ? part.pathways.filter((p) => p !== pathway) : [...part.pathways, pathway],
                      )
                    }
                    className={`rounded-lg border px-2.5 py-1 text-[11px] ${
                      on
                        ? 'border-accent bg-surface-accent-soft font-semibold text-text-accent'
                        : 'border-border text-text-secondary hover:bg-surface-hover'
                    }`}
                  >
                    {PATHWAY_LABELS[pathway]}
                  </button>
                );
              })}
            </div>

            {part.kind === 'logbook' && (
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <label className="inline-flex items-center gap-1.5 text-[11.5px] text-text-secondary">
                  Minimum hours
                  <input
                    type="number"
                    min={0}
                    aria-label={`Minimum hours for ${part.label}`}
                    value={part.minimumHours ?? ''}
                    onChange={(e) =>
                      partOps.update(part.key, {
                        minimumHours: e.target.value === '' ? undefined : Number(e.target.value),
                      })
                    }
                    className="h-[28px] w-20 rounded-lg border border-border bg-surface-page px-2 text-[11.5px]"
                  />
                </label>

                <label className="inline-flex items-center gap-1.5 text-[11.5px] text-text-secondary">
                  Hours column
                  <select
                    aria-label={`Duration column for ${part.label}`}
                    value={part.durationColumnKey ?? ''}
                    onChange={(e) =>
                      partOps.update(part.key, { durationColumnKey: e.target.value || undefined })
                    }
                    className="h-[28px] rounded-lg border border-border bg-surface-page px-2 text-[11.5px]"
                  >
                    {/*
                      The options come from the same slice validateManifest
                      checks the declared column against, so a pick cannot fail
                      the gate it was made in.
                    */}
                    <option value="">— none —</option>
                    {columns.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>

                {columns.length === 0 && (
                  <span className="text-[11px] text-warning-text">
                    This part has no table with columns to total hours from.
                  </span>
                )}
              </div>
            )}

            {part.kind === 'logbook' && (
              <div className="mt-2.5 rounded-lg border border-border-subtle bg-surface-sunken p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11.5px] font-semibold text-text-secondary">
                    Per-task minimums
                  </span>
                  <label className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-text-tertiary">
                    Task type column
                    <select
                      aria-label={`Task type column for ${part.label}`}
                      value={taskMin?.columnKey ?? ''}
                      onChange={(e) => {
                        const key = e.target.value;
                        if (!key) {
                          partOps.update(part.key, { taskMinimums: undefined });
                          return;
                        }
                        const col = choiceColumns.find((c) => c.key === key);
                        // Picking a column seeds a target for every option whose
                        // label already declares "(min N hours)" — the Scraper's
                        // paper writes them in, so the author confirms rather than
                        // re-keys.
                        partOps.update(part.key, {
                          taskMinimums: taskMinimumsFromColumn(key, col?.options ?? []),
                        });
                      }}
                      className="h-[28px] rounded-lg border border-border bg-surface-page px-2 text-[11.5px]"
                    >
                      <option value="">— none —</option>
                      {choiceColumns.map((c) => (
                        <option key={c.key} value={c.key}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {choiceColumns.length === 0 ? (
                  <p className="mt-1.5 text-[11px] text-text-tertiary">
                    Add a dropdown column to the table — the “Task type” the candidate picks per row —
                    to set an hours target per task.
                  </p>
                ) : taskColumn ? (
                  <div className="mt-2 flex flex-col gap-1.5">
                    <p className="text-[11px] text-text-tertiary">
                      A minimum per task, on top of the overall{' '}
                      {part.minimumHours ? `${part.minimumHours} hour` : ''} target. Leave a task
                      blank if it has no hours target. Targets never block hand-in — they guide the
                      candidate and the assessor.
                    </p>
                    {taskColumn.options.map((opt) => (
                      <label
                        key={opt}
                        className="flex items-center gap-2 text-[11.5px] text-text-secondary"
                      >
                        <span className="min-w-0 flex-1 truncate">{opt}</span>
                        <input
                          type="number"
                          min={0}
                          aria-label={`Minimum hours for ${opt}`}
                          value={taskMin?.targets.find((t) => t.value === opt)?.minimumHours ?? ''}
                          onChange={(e) =>
                            partOps.update(part.key, {
                              taskMinimums: withTaskTargetHours(
                                taskMin ?? { columnKey: taskColumn.key, targets: [] },
                                taskColumn.options,
                                opt,
                                e.target.value === '' ? Number.NaN : Number(e.target.value),
                              ),
                            })
                          }
                          className="h-[26px] w-16 flex-none rounded-lg border border-border bg-surface-page px-2 text-[11.5px]"
                        />
                        <span className="w-6 flex-none text-[10.5px] text-text-tertiary">hrs</span>
                      </label>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        );
      })}

      {prerequisites.length > 0 && (
        <div className="rounded-[14px] border border-border bg-surface-card p-4">
          <span className="block text-[12.5px] font-semibold">
            Prerequisites read from the cover page
          </span>
          <span className="mt-0.5 block text-[11px] text-text-tertiary">
            Extraction rule 9 keeps these verbatim. A prerequisite read as a heading disappears from
            the assessment entirely, and nothing downstream can tell it was printed.
          </span>
          <ul className="mt-2 flex flex-col gap-1">
            {prerequisites.map((p) => (
              <li key={p.id} className="text-[11.5px] text-text-secondary">
                · {p.label}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
