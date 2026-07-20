import { cn } from '../utils/cn.js';
import { Icon } from './Icon.js';

/**
 * A column in a repeating group. Kept local to @formai/ui (structurally
 * compatible with @formai/shared's `RepeatingColumn`) so the UI package stays
 * dependency-free.
 */
export interface RepeatingGroupColumn {
  key: string;
  label: string;
  /** Input affordance for the cell. */
  type: string;
  options?: string[];
  required?: boolean;
}

export type RepeatingRow = Record<string, string | number | boolean | null>;

export interface RepeatingGroupProps {
  columns: RepeatingGroupColumn[];
  rows: RepeatingRow[];
  onChange: (rows: RepeatingRow[]) => void;
  addLabel?: string;
  /** Read-only render (submission detail) — hides add/remove + disables inputs. */
  readOnly?: boolean;
  minRows?: number;
  /**
   * Fixed-item checklist mode: ordered pre-printed item labels. Row identity
   * is positional — row i is the fixed row for fixedRows[i]; ad-hoc rows
   * follow after. Fixed rows render a locked, read-only label cell (the FIRST
   * column) and have no remove control. "Add row" appends removable ad-hoc
   * rows below the fixed set. In this mode `boolean_yes_no` cells render an
   * explicit Yes/No control (null = unanswered) so an honest "No" is
   * recordable.
   */
  fixedRows?: string[];
  /**
   * Row indexes to highlight as incomplete/errored (e.g. required fixed rows
   * with no answer). Positional, matching `rows`.
   */
  errorRowIndexes?: number[];
  className?: string;
}

function emptyRow(columns: RepeatingGroupColumn[], fixedMode: boolean): RepeatingRow {
  const row: RepeatingRow = {};
  for (const c of columns) {
    row[c.key] =
      c.type === 'boolean_yes_no'
        ? fixedMode
          ? null
          : false
        : c.type === 'checkbox'
          ? false
          : '';
  }
  return row;
}

/**
 * Add/remove-row group — the default shape of real compliance paperwork
 * (Item / Pass / Fail / Comments). Each cell renders the input affordance for
 * its column type; rows are added/removed with keyboard-reachable controls.
 */
export function RepeatingGroup({
  columns,
  rows,
  onChange,
  addLabel = 'Add row',
  readOnly,
  minRows = 0,
  fixedRows,
  errorRowIndexes,
  className,
}: RepeatingGroupProps) {
  const fixedCount = fixedRows?.length ?? 0;
  const fixedMode = fixedCount > 0;
  const labelKey = columns[0]?.key;

  function setCell(rowIndex: number, key: string, value: RepeatingRow[string]) {
    onChange(rows.map((r, i) => (i === rowIndex ? { ...r, [key]: value } : r)));
  }

  function addRow() {
    onChange([...rows, emptyRow(columns, fixedMode)]);
  }

  function removeRow(index: number) {
    if (index < fixedCount) return;
    if (rows.length <= minRows) return;
    onChange(rows.filter((_, i) => i !== index));
  }

  return (
    <div className={cn('overflow-hidden rounded-lg border border-border', className)}>
      <div className="fai-scroll overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-surface-sunken">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  className="border-b border-border px-3 py-2 text-left font-ui text-[11.5px] font-semibold uppercase tracking-wide text-text-tertiary"
                >
                  {c.label}
                  {c.required && <span className="ml-0.5 text-danger">*</span>}
                </th>
              ))}
              {!readOnly && <th className="w-10 border-b border-border" aria-label="Row actions" />}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length + (readOnly ? 0 : 1)}
                  className="px-3 py-6 text-center text-[13px] text-text-tertiary"
                >
                  No rows yet.
                </td>
              </tr>
            ) : (
              rows.map((row, ri) => {
                const isFixed = ri < fixedCount;
                const hasError = errorRowIndexes?.includes(ri) ?? false;
                return (
                  <tr
                    key={ri}
                    className={cn(
                      'border-b border-border-subtle last:border-b-0',
                      hasError && 'bg-danger-soft',
                    )}
                  >
                    {columns.map((c) =>
                      isFixed && c.key === labelKey ? (
                        <td
                          key={c.key}
                          className={cn('px-3 py-1.5 align-middle', !hasError && 'bg-surface-sunken')}
                        >
                          <span className="flex items-center gap-1.5 text-[13px] text-text-primary">
                            <Icon
                              name="lock"
                              size={12}
                              className="shrink-0 text-text-tertiary"
                              aria-label="Fixed item"
                            />
                            {fixedRows?.[ri] ?? String(row[c.key] ?? '')}
                          </span>
                        </td>
                      ) : (
                        <td key={c.key} className="px-2 py-1.5 align-middle">
                          <RepeatingCell
                            column={c}
                            value={row[c.key] ?? null}
                            readOnly={readOnly}
                            explicitYesNo={fixedMode && c.type === 'boolean_yes_no'}
                            onChange={(v) => setCell(ri, c.key, v)}
                          />
                        </td>
                      ),
                    )}
                    {!readOnly && (
                      <td className="px-2 py-1.5 text-center align-middle">
                        {!isFixed && (
                          <button
                            type="button"
                            onClick={() => removeRow(ri)}
                            disabled={rows.length <= minRows}
                            aria-label={`Remove row ${ri + 1}`}
                            className="grid h-7 w-7 place-items-center rounded-md text-text-tertiary hover:bg-surface-hover disabled:opacity-40"
                          >
                            <Icon name="trash-2" size={15} />
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {!readOnly && (
        <div className="border-t border-border-subtle bg-surface-card p-2">
          <button
            type="button"
            onClick={addRow}
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-semibold text-text-accent hover:bg-surface-accent-soft"
          >
            <Icon name="plus" size={15} />
            {addLabel}
          </button>
        </div>
      )}
    </div>
  );
}

function RepeatingCell({
  column,
  value,
  readOnly,
  explicitYesNo,
  onChange,
}: {
  column: RepeatingGroupColumn;
  value: RepeatingRow[string];
  readOnly?: boolean;
  /** Render boolean_yes_no as an explicit Yes/No pair (null = unanswered). */
  explicitYesNo?: boolean;
  onChange: (v: RepeatingRow[string]) => void;
}) {
  const cellClass =
    'h-9 w-full min-w-[120px] rounded-md border border-border-strong bg-surface-card px-2.5 text-[13px] text-text-primary focus:outline-none focus-visible:border-border-accent focus-visible:shadow-focus disabled:bg-surface-sunken';

  if (readOnly) {
    const display =
      column.type === 'boolean_yes_no' || column.type === 'checkbox'
        ? explicitYesNo && (value === null || value === undefined || value === '')
          ? '—'
          : value
            ? 'Yes'
            : 'No'
        : (value ?? '') === ''
          ? '—'
          : String(value);
    return <span className="block px-1 text-[13px] text-text-primary">{display}</span>;
  }

  if (column.type === 'boolean_yes_no' && explicitYesNo) {
    return (
      <div
        role="group"
        aria-label={column.label}
        className="flex items-center justify-center gap-1"
      >
        {(
          [
            { label: 'Yes', v: true },
            { label: 'No', v: false },
          ] as const
        ).map(({ label, v }) => (
          <button
            key={label}
            type="button"
            aria-pressed={value === v}
            onClick={() => onChange(value === v ? null : v)}
            className={cn(
              'rounded-md border px-2.5 py-1 text-[12px] font-semibold focus:outline-none focus-visible:shadow-focus',
              value === v
                ? 'border-border-accent bg-surface-accent-soft text-text-accent'
                : 'border-border-strong bg-surface-card text-text-tertiary hover:bg-surface-hover',
            )}
          >
            {label}
          </button>
        ))}
      </div>
    );
  }

  if (column.type === 'boolean_yes_no' || column.type === 'checkbox') {
    return (
      <label className="flex items-center justify-center">
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => onChange(e.target.checked)}
          aria-label={column.label}
          className="h-4 w-4 cursor-pointer appearance-none rounded-[4px] border border-border-strong bg-surface-card checked:border-accent checked:bg-accent focus-visible:shadow-focus"
        />
      </label>
    );
  }

  if ((column.type === 'dropdown' || column.type === 'radio') && column.options) {
    return (
      <select
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
        aria-label={column.label}
        className={cellClass}
      >
        <option value="">—</option>
        {column.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      type={column.type === 'number' ? 'number' : column.type === 'date' ? 'date' : 'text'}
      value={String(value ?? '')}
      onChange={(e) => onChange(e.target.value)}
      aria-label={column.label}
      className={cellClass}
    />
  );
}
