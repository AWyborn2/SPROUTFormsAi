import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
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

/**
 * A group of columns sharing ONE answer per row. Kept local to @formai/ui
 * (structurally compatible with @formai/shared's `AnswerSet`) for the same
 * reason `RepeatingGroupColumn` is: the UI package stays dependency-free.
 *
 * Resolution of which sets are VALID, and of which option a row has chosen,
 * belongs to the caller — this component is handed already-resolved sets plus
 * `answerSelection`/`onAnswerSelect`, so there is exactly one implementation
 * of the semantics (in `@formai/shared/answer-set`) rather than two.
 */
export interface RepeatingGroupAnswerSet {
  key: string;
  /** Heading for the collapsed narrow-viewport presentation. */
  label?: string;
  columnKeys: string[];
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
  /**
   * Column groups sharing one answer per row. Already validated by the caller
   * (`resolveAnswerSets`); a set naming unknown columns, the label column, or
   * fewer than two columns is ignored here too so a bad grouping degrades to
   * independent checkboxes rather than breaking a fill view.
   */
  answerSets?: RepeatingGroupAnswerSet[];
  /** The chosen member column of `set` on row `rowIndex`, or null (unanswered). */
  answerSelection?: (rowIndex: number, set: RepeatingGroupAnswerSet) => string | null;
  /** Record a row's answer within a set; `columnKey` null clears the row. */
  onAnswerSelect?: (
    rowIndex: number,
    set: RepeatingGroupAnswerSet,
    columnKey: string | null,
  ) => void;
  className?: string;
}

function emptyRow(
  columns: RepeatingGroupColumn[],
  fixedMode: boolean,
  groupedKeys: Set<string>,
): RepeatingRow {
  const row: RepeatingRow = {};
  for (const c of columns) {
    // A member of an answer set starts null, never false: false is "not this
    // option", and a whole row of falses is indistinguishable from an answer.
    row[c.key] = groupedKeys.has(c.key)
      ? null
      : c.type === 'boolean_yes_no'
        ? fixedMode
          ? null
          : false
        : c.type === 'checkbox'
          ? false
          : '';
  }
  return row;
}

/** Only structurally usable sets survive; everything else degrades to cells. */
function usableSets(
  sets: RepeatingGroupAnswerSet[] | undefined,
  columns: RepeatingGroupColumn[],
  labelKey: string | undefined,
): RepeatingGroupAnswerSet[] {
  if (!sets?.length) return [];
  const known = new Set(columns.map((c) => c.key));
  const claimed = new Set<string>();
  const out: RepeatingGroupAnswerSet[] = [];
  for (const s of sets) {
    const keys = s.columnKeys ?? [];
    if (keys.length < 2) continue;
    if (keys.some((k) => !known.has(k) || claimed.has(k))) continue;
    if (labelKey !== undefined && keys.includes(labelKey)) continue;
    for (const k of keys) claimed.add(k);
    out.push(s);
  }
  return out;
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
  answerSets,
  answerSelection,
  onAnswerSelect,
  className,
}: RepeatingGroupProps) {
  const fixedCount = fixedRows?.length ?? 0;
  const fixedMode = fixedCount > 0;
  const labelKey = columns[0]?.key;
  const firstErrorRef = useRef<HTMLTableRowElement | null>(null);

  // Without both callbacks the caller cannot resolve or record a selection, so
  // grouping is inert and the table falls back to independent cells.
  const sets =
    answerSelection && onAnswerSelect ? usableSets(answerSets, columns, labelKey) : [];
  const setByColumn = new Map<string, RepeatingGroupAnswerSet>();
  const setAnchor = new Map<string, string>();
  for (const s of sets) {
    for (const c of columns) {
      if (!s.columnKeys.includes(c.key)) continue;
      setByColumn.set(c.key, s);
      if (!setAnchor.has(s.key)) setAnchor.set(s.key, c.key);
    }
  }
  const groupedKeys = new Set(setByColumn.keys());

  function memberColumns(set: RepeatingGroupAnswerSet): RepeatingGroupColumn[] {
    return columns.filter((c) => set.columnKeys.includes(c.key));
  }

  function setLabelOf(set: RepeatingGroupAnswerSet): string {
    return set.label ?? memberColumns(set).map((c) => c.label).join(' / ');
  }

  function rowLabelOf(rowIndex: number, row: RepeatingRow): string {
    if (rowIndex < fixedCount) return fixedRows?.[rowIndex] ?? '';
    return labelKey ? String(row[labelKey] ?? '') : '';
  }

  function setCell(rowIndex: number, key: string, value: RepeatingRow[string]) {
    onChange(rows.map((r, i) => (i === rowIndex ? { ...r, [key]: value } : r)));
  }

  function addRow() {
    onChange([...rows, emptyRow(columns, fixedMode, groupedKeys)]);
  }

  // A failed submit on a forty-row table is useless if the filler has to hunt
  // for the rows they missed — take them to the first one.
  const firstError = errorRowIndexes?.length ? Math.min(...errorRowIndexes) : undefined;
  useEffect(() => {
    if (firstError === undefined) return;
    firstErrorRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [firstError]);

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
              {columns.map((c) => {
                const set = setByColumn.get(c.key);
                const headClass =
                  'border-b border-border px-3 py-2 text-left font-ui text-[11.5px] font-semibold uppercase tracking-wide text-text-tertiary';
                if (set) {
                  const isAnchor = setAnchor.get(set.key) === c.key;
                  const optionHead = (
                    <th key={c.key} className={cn(headClass, 'hidden sm:table-cell')}>
                      {c.label}
                      {c.required && <span className="ml-0.5 text-danger">*</span>}
                    </th>
                  );
                  if (!isAnchor) return optionHead;
                  return [
                    /*
                      Narrow viewports collapse the set's member columns into
                      ONE column headed by the set label. Keeping the per-option
                      headers (and their empty cells) would spend most of a
                      phone's width on blank space and push the item label
                      off-screen.
                    */
                    <th
                      key={`${c.key}-collapsed`}
                      colSpan={memberColumns(set).length}
                      className={cn(headClass, 'sm:hidden')}
                    >
                      {setLabelOf(set)}
                      {set.required && <span className="ml-0.5 text-danger">*</span>}
                    </th>,
                    optionHead,
                  ];
                }
                return (
                  <th key={c.key} className={headClass}>
                    {c.label}
                    {c.required && <span className="ml-0.5 text-danger">*</span>}
                  </th>
                );
              })}
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
                    ref={ri === firstError ? firstErrorRef : undefined}
                    className={cn(
                      'border-b border-border-subtle last:border-b-0',
                      hasError && 'bg-danger-soft',
                    )}
                  >
                    {columns.map((c) => {
                      const set = setByColumn.get(c.key);
                      if (set) {
                        // Only the first member column renders; the rest render
                        // nothing so the printed per-option headers survive on
                        // desktop while the control spans them.
                        if (setAnchor.get(set.key) !== c.key) return null;
                        return (
                          <td
                            key={c.key}
                            colSpan={memberColumns(set).length}
                            className="p-0 align-middle"
                          >
                            <AnswerSetCell
                              options={memberColumns(set)}
                              rowLabel={rowLabelOf(ri, row)}
                              setLabel={setLabelOf(set)}
                              selectedKey={answerSelection!(ri, set)}
                              readOnly={readOnly}
                              hasError={hasError}
                              onSelect={(key) => onAnswerSelect!(ri, set, key)}
                            />
                          </td>
                        );
                      }
                      return isFixed && c.key === labelKey ? (
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
                            invalid={hasError}
                            onChange={(v) => setCell(ri, c.key, v)}
                          />
                        </td>
                      );
                    })}
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

/**
 * One answer set's control for one row.
 *
 * Desktop keeps the printed layout — a radio under each option's column header,
 * wrapped in a single `radiogroup` so the row is ONE tab stop and arrow keys
 * move within it. Narrow viewports collapse to a single cycling control.
 *
 * Every control is at least 44x44 CSS px and fills its cell: a mis-tap here
 * records a wrong answer that validation cannot catch, so the target size is a
 * correctness control rather than polish.
 */
function AnswerSetCell({
  options,
  rowLabel,
  setLabel,
  selectedKey,
  readOnly,
  hasError,
  onSelect,
}: {
  options: RepeatingGroupColumn[];
  rowLabel: string;
  setLabel: string;
  selectedKey: string | null;
  readOnly?: boolean;
  hasError?: boolean;
  onSelect: (columnKey: string | null) => void;
}) {
  const selectedIndex = options.findIndex((o) => o.key === selectedKey);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  // A screen-reader user on a forty-row table needs to know WHICH item they
  // just answered, not merely "N/A".
  const nameFor = (option: string) => (rowLabel ? `${rowLabel} — ${option}` : option);
  const selectedLabel = selectedIndex >= 0 ? options[selectedIndex]!.label : null;

  if (readOnly) {
    return (
      <span className="block px-3 py-1.5 text-[13px] text-text-primary">
        {selectedLabel ?? '—'}
      </span>
    );
  }

  const activeIndex = focusIndex ?? (selectedIndex >= 0 ? selectedIndex : 0);

  function moveFocus(next: number) {
    const i = (next + options.length) % options.length;
    setFocusIndex(i);
    refs.current[i]?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      moveFocus(activeIndex + 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocus(activeIndex - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      moveFocus(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      moveFocus(options.length - 1);
    }
  }

  const cycleTo = selectedIndex < 0 ? 0 : selectedIndex + 1 >= options.length ? null : selectedIndex + 1;

  return (
    <>
      <div
        role="radiogroup"
        aria-label={rowLabel ? `${rowLabel} — ${setLabel}` : setLabel}
        aria-invalid={hasError || undefined}
        onKeyDown={onKeyDown}
        className="hidden sm:grid"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {options.map((o, i) => {
          const checked = i === selectedIndex;
          return (
            <button
              key={o.key}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={nameFor(o.label)}
              aria-invalid={hasError || undefined}
              tabIndex={i === activeIndex ? 0 : -1}
              onFocus={() => setFocusIndex(i)}
              // Reselecting the current option returns the row to unanswered —
              // the only way to undo a mis-tap without a bulk clear.
              onClick={() => onSelect(checked ? null : o.key)}
              className={cn(
                'flex min-h-[44px] w-full items-center justify-center border-r border-border-subtle px-2 text-[12.5px] font-semibold last:border-r-0 focus:outline-none focus-visible:shadow-focus',
                checked
                  ? 'bg-surface-accent-soft text-text-accent'
                  : 'text-text-tertiary hover:bg-surface-hover',
              )}
            >
              <span
                className={cn(
                  'grid h-[18px] w-[18px] place-items-center rounded-full border',
                  checked ? 'border-accent bg-accent' : 'border-border-strong bg-surface-card',
                )}
              >
                {checked && <span className="h-1.5 w-1.5 rounded-full bg-surface-card" />}
              </span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        aria-label={rowLabel ? `${rowLabel} — ${setLabel}` : setLabel}
        aria-invalid={hasError || undefined}
        onClick={() => onSelect(cycleTo === null ? null : options[cycleTo]!.key)}
        className="flex min-h-[44px] w-full min-w-[44px] items-center justify-center px-2 text-[13px] font-semibold text-text-primary focus:outline-none focus-visible:shadow-focus sm:hidden"
      >
        <span
          className={cn(
            'rounded-md border px-2.5 py-1.5',
            selectedLabel
              ? 'border-border-accent bg-surface-accent-soft text-text-accent'
              : 'border-border-strong bg-surface-card text-text-tertiary',
          )}
        >
          {selectedLabel ?? '—'}
        </span>
        {/* Announce the new value without moving focus off the control. */}
        <span aria-live="polite" className="sr-only">
          {selectedLabel ?? 'Not answered'}
        </span>
      </button>
    </>
  );
}

function RepeatingCell({
  column,
  value,
  readOnly,
  explicitYesNo,
  invalid,
  onChange,
}: {
  column: RepeatingGroupColumn;
  value: RepeatingRow[string];
  readOnly?: boolean;
  /** Render boolean_yes_no as an explicit Yes/No pair (null = unanswered). */
  explicitYesNo?: boolean;
  /** Row is flagged incomplete by a failed submit. */
  invalid?: boolean;
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
            aria-invalid={invalid || undefined}
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
          aria-invalid={invalid || undefined}
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
        aria-invalid={invalid || undefined}
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
      aria-invalid={invalid || undefined}
      className={cellClass}
    />
  );
}
