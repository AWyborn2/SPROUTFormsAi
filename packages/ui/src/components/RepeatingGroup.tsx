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
  className?: string;
}

function emptyRow(columns: RepeatingGroupColumn[]): RepeatingRow {
  const row: RepeatingRow = {};
  for (const c of columns) row[c.key] = c.type === 'boolean_yes_no' || c.type === 'checkbox' ? false : '';
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
  className,
}: RepeatingGroupProps) {
  function setCell(rowIndex: number, key: string, value: RepeatingRow[string]) {
    onChange(rows.map((r, i) => (i === rowIndex ? { ...r, [key]: value } : r)));
  }

  function addRow() {
    onChange([...rows, emptyRow(columns)]);
  }

  function removeRow(index: number) {
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
              rows.map((row, ri) => (
                <tr key={ri} className="border-b border-border-subtle last:border-b-0">
                  {columns.map((c) => (
                    <td key={c.key} className="px-2 py-1.5 align-middle">
                      <RepeatingCell
                        column={c}
                        value={row[c.key] ?? null}
                        readOnly={readOnly}
                        onChange={(v) => setCell(ri, c.key, v)}
                      />
                    </td>
                  ))}
                  {!readOnly && (
                    <td className="px-2 py-1.5 text-center align-middle">
                      <button
                        type="button"
                        onClick={() => removeRow(ri)}
                        disabled={rows.length <= minRows}
                        aria-label={`Remove row ${ri + 1}`}
                        className="grid h-7 w-7 place-items-center rounded-md text-text-tertiary hover:bg-surface-hover disabled:opacity-40"
                      >
                        <Icon name="trash-2" size={15} />
                      </button>
                    </td>
                  )}
                </tr>
              ))
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
  onChange,
}: {
  column: RepeatingGroupColumn;
  value: RepeatingRow[string];
  readOnly?: boolean;
  onChange: (v: RepeatingRow[string]) => void;
}) {
  const cellClass =
    'h-9 w-full min-w-[120px] rounded-md border border-border-strong bg-surface-card px-2.5 text-[13px] text-text-primary focus:outline-none focus-visible:border-border-accent focus-visible:shadow-focus disabled:bg-surface-sunken';

  if (readOnly) {
    const display =
      column.type === 'boolean_yes_no' || column.type === 'checkbox'
        ? value
          ? 'Yes'
          : 'No'
        : (value ?? '') === ''
          ? '—'
          : String(value);
    return <span className="block px-1 text-[13px] text-text-primary">{display}</span>;
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
