/**
 * Column and answer-set inspector for an imported repeating table.
 *
 * Review's table affordance elsewhere lists the extracted columns as read-only
 * chips — enough to confirm "yes, this is a table", not enough to publish. This
 * panel is the editing half: rename a column, retype it, mark it required, and
 * group columns into an ANSWER SET (the OK / N/A / Fault triple that must carry
 * exactly one answer per row).
 *
 * R6, "never silently applied": extraction PROPOSES a grouping. A proposal that
 * looked identical to an accepted one would get published unreviewed by anyone
 * skimming, which is the whole failure the requirement names. So membership is
 * rendered in three distinct states — none / proposed / accepted — and a
 * proposed set carries an explicit "Accept grouping" action next to "Ungroup".
 * Acceptance itself lives in the import session (an accepted-set key list), not
 * on the `AnswerSet`: it is review state that dies at publish, and the
 * published field must not carry a flag every downstream consumer would then
 * have to interpret.
 *
 * Validity is never re-derived here — `resolveAnswerSets` from the shared
 * package is the single authority on which sets count.
 */
import { useState } from 'react';
import { Icon, Select, Switch } from '@formai/ui';
import type { AnswerSet, FormField, FormFieldType, RepeatingColumn } from '@formai/shared';
import { resolveAnswerSets } from '@formai/shared';
/**
 * The panel needs only these three properties, and taking them structurally is
 * what lets it serve both hosts: a review row carries extraction metadata a
 * published field does not, so requiring `ReviewField` would lock the builder
 * out of the very inspector R17 says it must share.
 */
export type ColumnInspectorField = Pick<FormField, 'id' | 'columns' | 'answerSets'>;

/**
 * The edits this panel performs, supplied by whoever mounts it.
 *
 * R17 asks for the SAME inspector before and after publish, and the two hosts
 * drive different stores: import review dispatches through the session, the
 * builder through its own reducer. Taking the actions as a contract is what
 * makes one component serve both — a copy per host is exactly the drift the
 * shared field editor exists to prevent.
 */
export interface ColumnActions {
  renameColumn(fieldId: string, columnKey: string, label: string): void;
  setColumnType(fieldId: string, columnKey: string, type: FormFieldType): void;
  setColumnRequired(fieldId: string, columnKey: string, required: boolean): void;
  /** Replace a choice column's option list wholesale. */
  setColumnOptions(fieldId: string, columnKey: string, options: string[]): void;
  groupColumns(fieldId: string, columnKeys: string[]): string | null;
  ungroupAnswerSet(fieldId: string, setKey: string): void;
  acceptAnswerSet(fieldId: string, setKey: string): void;
  answerSetAccepted(fieldId: string, setKey: string): boolean;
}

/** Types a table cell can sensibly take (a column is never a section header). */
const COLUMN_TYPE_OPTIONS: Array<{ label: string; value: FormFieldType }> = [
  { label: 'Text', value: 'text' },
  { label: 'Checkbox', value: 'checkbox' },
  /*
    Check / Cross records a real boolean, and — unlike Checkbox — distinguishes
    an explicit fail from an untouched cell. That distinction is the reason it
    exists: on a competency record, "assessed as failing" and "never assessed"
    must not be the same value.
  */
  { label: 'Check / Cross', value: 'check_cross' },
  { label: 'Dropdown', value: 'dropdown' },
  { label: 'Number', value: 'number' },
  { label: 'Date', value: 'date' },
  { label: 'Signature', value: 'signature' },
];

/** Column types answered by picking from `options`. */
const CHOICE_COLUMN_TYPES: ReadonlySet<string> = new Set(['dropdown', 'radio']);

/** How a column relates to the field's answer sets. */
export type ColumnMembership = 'none' | 'proposed' | 'accepted';

export interface ColumnRow {
  column: RepeatingColumn;
  index: number;
  /** `columns[0]` — the pre-printed item text. Displayed, never edited structurally. */
  isLabel: boolean;
  /** Whether this column may join an answer set at all. */
  groupable: boolean;
  membership: ColumnMembership;
  /** The valid set owning this column, when any. */
  set?: AnswerSet;
}

/**
 * The panel's view model. Exported (and unit-tested) because the proposed vs
 * accepted distinction is the load-bearing part: getting it wrong publishes an
 * AI guess as a reviewed decision.
 */
export function columnRows(
  field: ColumnInspectorField,
  isAccepted: (fieldId: string, setKey: string) => boolean,
): ColumnRow[] {
  const columns = field.columns ?? [];
  const { sets } = resolveAnswerSets(field);

  return columns.map((column, index) => {
    const set = sets.find((s) => s.columnKeys.includes(column.key));
    const isLabel = index === 0;
    return {
      column,
      index,
      isLabel,
      groupable: !isLabel,
      membership: !set ? 'none' : isAccepted(field.id, set.key) ? 'accepted' : 'proposed',
      ...(set ? { set } : {}),
    };
  });
}

const MEMBERSHIP_TEXT: Record<ColumnMembership, string> = {
  none: 'Independent cell',
  proposed: 'Proposed group',
  accepted: 'Grouped',
};

export interface ColumnInspectorProps {
  field: ColumnInspectorField;
  actions: ColumnActions;
}

export function ColumnInspector({ field, actions }: ColumnInspectorProps) {
  const [picked, setPicked] = useState<string[]>([]);
  const rows = columnRows(field, actions.answerSetAccepted);
  const { sets } = resolveAnswerSets(field);
  const selectable = picked.filter((k) => rows.some((r) => r.groupable && r.column.key === k));

  const toggle = (key: string) =>
    setPicked((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  return (
    <div className="flex flex-col gap-3 border-t border-border-subtle pt-3">
      <div>
        <div className="text-[12.5px] font-semibold">Table columns</div>
        <p className="mt-0.5 text-[11px] text-text-tertiary">
          The first column is the pre-printed item text — it can&apos;t be retyped or grouped.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {rows.map((row) => (
          <div
            key={row.column.key}
            className="rounded-md border border-border-subtle bg-surface-sunken p-[9px_10px]"
          >
            <div className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={selectable.includes(row.column.key)}
                disabled={!row.groupable}
                onChange={() => toggle(row.column.key)}
                aria-label={`Select column for grouping: ${row.column.label}`}
                className="h-3.5 w-3.5 flex-none disabled:opacity-40"
              />
              <input
                value={row.column.label}
                onChange={(e) => actions.renameColumn(field.id, row.column.key, e.target.value)}
                aria-label={`Column label: ${row.column.key}`}
                className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-surface-card px-2 text-[12.5px] text-text-primary focus-visible:shadow-focus"
              />
              <span
                className={`flex-none rounded-pill border px-2 py-0.5 font-mono text-[10.5px] ${
                  row.membership === 'proposed'
                    ? 'border-dashed border-border-strong text-text-secondary'
                    : 'border-border text-text-tertiary'
                }`}
              >
                {MEMBERSHIP_TEXT[row.membership]}
              </span>
            </div>

            {!row.isLabel && (
              <div className="mt-1.5 flex items-center gap-2">
                <div className="w-[140px]">
                  <Select
                    options={COLUMN_TYPE_OPTIONS}
                    value={row.column.type}
                    onChange={(e) => actions.setColumnType(field.id, row.column.key, e.target.value as FormFieldType)}
                    aria-label={`Column type: ${row.column.label}`}
                  />
                </div>
                <span className="ml-auto text-[11px] text-text-secondary">Required</span>
                <Switch
                  checked={row.column.required ?? false}
                  onChange={(e) => actions.setColumnRequired(field.id, row.column.key, e.target.checked)}
                  aria-label={`Column required: ${row.column.label}`}
                />
              </div>
            )}

            {!row.isLabel && CHOICE_COLUMN_TYPES.has(row.column.type) && (
              <ColumnOptions
                fieldId={field.id}
                column={row.column}
                onChange={actions.setColumnOptions}
              />
            )}
          </div>
        ))}
      </div>

      <button
        onClick={() => {
          actions.groupColumns(field.id, selectable);
          setPicked([]);
        }}
        disabled={selectable.length < 2}
        className="inline-flex items-center justify-center gap-1.5 rounded-sm border border-dashed border-border-strong px-2.5 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Icon name="group" size={13} />
        Group selected into one answer
      </button>

      {sets.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="text-[12.5px] font-semibold">Answer sets</div>
          {sets.map((set) => {
            const accepted = actions.answerSetAccepted(field.id, set.key);
            const labels = set.columnKeys
              .map((k) => field.columns?.find((c) => c.key === k)?.label ?? k)
              .join(' / ');
            return (
              <div
                key={set.key}
                className={`rounded-md border bg-surface-card p-[9px_10px] ${
                  accepted ? 'border-border' : 'border-dashed border-border-strong'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{labels}</span>
                  <span className="flex-none text-[11px] text-text-secondary">
                    {accepted ? 'Accepted' : 'Suggested by extraction'}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] text-text-tertiary">
                  {accepted
                    ? 'Fillers pick exactly one of these per row.'
                    : 'Not applied yet — accept it, or ungroup to keep independent checkboxes.'}
                </p>
                <div className="mt-1.5 flex gap-1.5">
                  {!accepted && (
                    <button
                      onClick={() => actions.acceptAnswerSet(field.id, set.key)}
                      className="inline-flex items-center gap-1 rounded-sm border border-border px-2 py-1 text-[11.5px] font-semibold text-text-secondary hover:bg-surface-hover"
                    >
                      <Icon name="check" size={12} />
                      Accept grouping
                    </button>
                  )}
                  <button
                    onClick={() => actions.ungroupAnswerSet(field.id, set.key)}
                    className="inline-flex items-center gap-1 rounded-sm border border-border px-2 py-1 text-[11.5px] font-semibold text-text-secondary hover:bg-surface-hover"
                  >
                    <Icon name="ungroup" size={12} />
                    Ungroup
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Per-column option list for a dropdown cell.
 *
 * Edits replace the whole array rather than patching one index, because the
 * column is the unit the store already patches — a per-index action would need
 * its own coalescing rules to stay one undo step per edit, for no gain.
 */
function ColumnOptions({
  fieldId,
  column,
  onChange,
}: {
  fieldId: string;
  column: RepeatingColumn;
  onChange: (fieldId: string, columnKey: string, options: string[]) => void;
}) {
  const options = column.options ?? [];
  const write = (next: string[]) => onChange(fieldId, column.key, next);

  return (
    <div className="mt-1.5 rounded-sm border border-border-subtle bg-surface-card p-[8px_9px]">
      <div className="mb-1.5 text-[11px] font-semibold text-text-secondary">
        Options for {column.label}
      </div>
      <div className="flex flex-col gap-1">
        {options.map((o, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input
              value={o}
              onChange={(e) => write(options.map((x, j) => (j === i ? e.target.value : x)))}
              aria-label={`${column.label} option ${i + 1}`}
              className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-surface-card px-2 text-[12px] text-text-primary focus-visible:shadow-focus"
            />
            <button
              onClick={() => write(options.filter((_, j) => j !== i))}
              aria-label={`Remove ${column.label} option ${i + 1}`}
              className="grid h-7 w-7 flex-none place-items-center rounded-sm border border-border text-text-tertiary hover:bg-surface-hover hover:text-danger-text"
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        ))}
      </div>
      <button
        onClick={() => write([...options, `Option ${options.length + 1}`])}
        className="mt-1.5 inline-flex items-center gap-1 rounded-sm border border-dashed border-border-strong px-2 py-1 text-[11.5px] font-semibold text-text-secondary hover:bg-surface-hover"
      >
        <Icon name="plus" size={12} />
        Add option
      </button>
    </div>
  );
}
