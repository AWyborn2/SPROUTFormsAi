import { useMemo, useRef, useState } from 'react';
import { cn } from '../utils/cn.js';
import { Icon } from './Icon.js';

export interface DataGridColumn<T> {
  key: string;
  header: React.ReactNode;
  /** Cell renderer. */
  render: (row: T) => React.ReactNode;
  /** Value used for sorting; enables the sort affordance when provided. */
  sortValue?: (row: T) => string | number;
  align?: 'left' | 'right' | 'center';
  width?: string;
  className?: string;
}

export interface DataGridProps<T> {
  columns: Array<DataGridColumn<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  onRowActivate?: (row: T) => void;
  /** Enable a leading checkbox column with controlled selection. */
  selectable?: boolean;
  selectedKeys?: Set<string>;
  onSelectionChange?: (keys: Set<string>) => void;
  empty?: React.ReactNode;
  className?: string;
  /** Accessible label for the grid. */
  'aria-label'?: string;
}

type SortState = { key: string; dir: 'asc' | 'desc' } | null;

/**
 * Keyboard-navigable data table. Sticky header, click-to-sort columns (those
 * with `sortValue`), optional row-selection column, and roving arrow-key focus
 * over rows (Up/Down/Home/End; Enter/Space activates or toggles selection).
 */
export function DataGrid<T>({
  columns,
  rows,
  rowKey,
  onRowActivate,
  selectable,
  selectedKeys,
  onSelectionChange,
  empty,
  className,
  'aria-label': ariaLabel,
}: DataGridProps<T>) {
  const [sort, setSort] = useState<SortState>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const getVal = col.sortValue;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = getVal(a);
      const bv = getVal(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [rows, sort, columns]);

  const allSelected =
    selectable && sortedRows.length > 0 && sortedRows.every((r) => selectedKeys?.has(rowKey(r)));
  const someSelected = selectable && sortedRows.some((r) => selectedKeys?.has(rowKey(r)));

  function toggleSort(col: DataGridColumn<T>) {
    if (!col.sortValue) return;
    setSort((s) =>
      s?.key === col.key
        ? { key: col.key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { key: col.key, dir: 'asc' },
    );
  }

  function toggleRow(row: T) {
    if (!selectable || !onSelectionChange) return;
    const key = rowKey(row);
    const next = new Set(selectedKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onSelectionChange(next);
  }

  function toggleAll() {
    if (!onSelectionChange) return;
    if (allSelected) onSelectionChange(new Set());
    else onSelectionChange(new Set(sortedRows.map(rowKey)));
  }

  function focusRow(index: number) {
    const clamped = Math.max(0, Math.min(index, sortedRows.length - 1));
    setActiveIndex(clamped);
    const el = bodyRef.current?.querySelectorAll<HTMLTableRowElement>('tr')[clamped];
    el?.focus();
  }

  function onRowKeyDown(e: React.KeyboardEvent, index: number, row: T) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusRow(index + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusRow(index - 1);
        break;
      case 'Home':
        e.preventDefault();
        focusRow(0);
        break;
      case 'End':
        e.preventDefault();
        focusRow(sortedRows.length - 1);
        break;
      case 'Enter':
        e.preventDefault();
        onRowActivate?.(row);
        break;
      case ' ':
        if (selectable) {
          e.preventDefault();
          toggleRow(row);
        }
        break;
    }
  }

  const colCount = columns.length + (selectable ? 1 : 0);

  return (
    <div
      className={cn(
        'fai-scroll overflow-auto rounded-lg border border-border bg-surface-card',
        className,
      )}
    >
      <table className="w-full border-collapse text-sm" aria-label={ariaLabel}>
        <thead className="sticky top-0 z-10 bg-surface-sunken">
          <tr>
            {selectable && (
              <th className="w-10 border-b border-border px-3 py-2.5 text-left">
                <input
                  type="checkbox"
                  aria-label="Select all rows"
                  checked={!!allSelected}
                  ref={(node) => {
                    if (node) node.indeterminate = !allSelected && !!someSelected;
                  }}
                  onChange={toggleAll}
                  className="h-4 w-4 cursor-pointer appearance-none rounded-[4px] border border-border-strong bg-surface-card checked:border-accent checked:bg-accent focus-visible:shadow-focus"
                />
              </th>
            )}
            {columns.map((col) => {
              const sorted = sort?.key === col.key;
              return (
                <th
                  key={col.key}
                  style={{ width: col.width }}
                  className={cn(
                    'border-b border-border px-3.5 py-2.5 font-ui text-[11.5px] font-semibold uppercase tracking-wide text-text-tertiary',
                    col.align === 'right' && 'text-right',
                    col.align === 'center' && 'text-center',
                    col.sortValue && 'cursor-pointer select-none hover:text-text-secondary',
                  )}
                  aria-sort={sorted ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {col.sortValue ? (
                    <button
                      onClick={() => toggleSort(col)}
                      className="inline-flex items-center gap-1.5 uppercase"
                    >
                      {col.header}
                      <Icon
                        name={sorted ? (sort!.dir === 'asc' ? 'arrow-up' : 'arrow-down') : 'chevrons-up-down'}
                        size={12}
                        className={sorted ? 'text-text-secondary' : 'text-text-disabled'}
                      />
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody ref={bodyRef}>
          {sortedRows.length === 0 ? (
            <tr>
              <td colSpan={colCount} className="px-4 py-12 text-center text-text-tertiary">
                {empty ?? 'No rows to show.'}
              </td>
            </tr>
          ) : (
            sortedRows.map((row, index) => {
              const key = rowKey(row);
              const selected = selectedKeys?.has(key);
              return (
                <tr
                  key={key}
                  tabIndex={index === activeIndex ? 0 : -1}
                  onKeyDown={(e) => onRowKeyDown(e, index, row)}
                  onFocus={() => setActiveIndex(index)}
                  onClick={() => onRowActivate?.(row)}
                  className={cn(
                    'border-b border-border-subtle outline-none transition-colors last:border-b-0',
                    'focus-visible:bg-surface-hover',
                    selected ? 'bg-surface-accent-soft' : 'hover:bg-surface-hover',
                    onRowActivate && 'cursor-pointer',
                  )}
                >
                  {selectable && (
                    <td className="px-3 py-3">
                      <input
                        type="checkbox"
                        aria-label={`Select row`}
                        checked={!!selected}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleRow(row)}
                        className="h-4 w-4 cursor-pointer appearance-none rounded-[4px] border border-border-strong bg-surface-card checked:border-accent checked:bg-accent focus-visible:shadow-focus"
                      />
                    </td>
                  )}
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={cn(
                        'px-3.5 py-3 text-text-primary',
                        col.align === 'right' && 'text-right',
                        col.align === 'center' && 'text-center',
                        col.className,
                      )}
                    >
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
