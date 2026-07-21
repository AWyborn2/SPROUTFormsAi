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
import type { AnswerSet, FormFieldType, RepeatingColumn } from '@formai/shared';
import { resolveAnswerSets } from '@formai/shared';
import {
  acceptAnswerSet,
  answerSetAccepted,
  groupColumns,
  renameColumn,
  setColumnRequired,
  setColumnType,
  ungroupAnswerSet,
  type ReviewField,
} from '../../../lib/data/import-session.js';

/** Types a table cell can sensibly take (a column is never a section header). */
const COLUMN_TYPE_OPTIONS: Array<{ label: string; value: FormFieldType }> = [
  { label: 'Text', value: 'text' },
  { label: 'Checkbox', value: 'checkbox' },
  { label: 'Number', value: 'number' },
  { label: 'Date', value: 'date' },
  { label: 'Signature', value: 'signature' },
];

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
export function columnRows(field: ReviewField): ColumnRow[] {
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
      membership: !set ? 'none' : answerSetAccepted(field.id, set.key) ? 'accepted' : 'proposed',
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
  field: ReviewField;
}

export function ColumnInspector({ field }: ColumnInspectorProps) {
  const [picked, setPicked] = useState<string[]>([]);
  const rows = columnRows(field);
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
                onChange={(e) => renameColumn(field.id, row.column.key, e.target.value)}
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
                    onChange={(e) => setColumnType(field.id, row.column.key, e.target.value as FormFieldType)}
                    aria-label={`Column type: ${row.column.label}`}
                  />
                </div>
                <span className="ml-auto text-[11px] text-text-secondary">Required</span>
                <Switch
                  checked={row.column.required ?? false}
                  onChange={(e) => setColumnRequired(field.id, row.column.key, e.target.checked)}
                  aria-label={`Column required: ${row.column.label}`}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      <button
        onClick={() => {
          groupColumns(field.id, selectable);
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
            const accepted = answerSetAccepted(field.id, set.key);
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
                      onClick={() => acceptAnswerSet(field.id, set.key)}
                      className="inline-flex items-center gap-1 rounded-sm border border-border px-2 py-1 text-[11.5px] font-semibold text-text-secondary hover:bg-surface-hover"
                    >
                      <Icon name="check" size={12} />
                      Accept grouping
                    </button>
                  )}
                  <button
                    onClick={() => ungroupAnswerSet(field.id, set.key)}
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
