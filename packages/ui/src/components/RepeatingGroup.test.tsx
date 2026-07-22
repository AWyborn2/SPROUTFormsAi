import { useState } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  RepeatingGroup,
  type RepeatingGroupAnswerSet,
  type RepeatingGroupColumn,
  type RepeatingRow,
} from './RepeatingGroup.js';

/**
 * The harness mirrors `FieldRenderer`'s wiring exactly: @formai/ui never
 * imports @formai/shared, so the caller owns answer-set resolution and hands
 * the component a resolved selection plus a writer. These two helpers are
 * deliberate duplicates of `selectedOption` / `applySelection` in
 * `@formai/shared/answer-set` — the component contract is what's under test.
 */
function chosenKey(set: RepeatingGroupAnswerSet, row: RepeatingRow | undefined): string | null {
  if (!row) return null;
  const truthy = set.columnKeys.filter((k) => {
    const v = row[k];
    return v === true || v === 'true' || v === 1;
  });
  return truthy[0] ?? null;
}

function applySelection(
  set: RepeatingGroupAnswerSet,
  row: RepeatingRow,
  columnKey: string | null,
): RepeatingRow {
  const next: RepeatingRow = { ...row };
  for (const k of set.columnKeys) next[k] = k === columnKey ? true : null;
  return next;
}

interface HarnessProps {
  columns: RepeatingGroupColumn[];
  initialRows: RepeatingRow[];
  answerSets?: RepeatingGroupAnswerSet[];
  fixedRows?: string[];
  errorRowIndexes?: number[];
  readOnly?: boolean;
}

function Harness({
  columns,
  initialRows,
  answerSets,
  fixedRows,
  errorRowIndexes,
  readOnly,
}: HarnessProps) {
  const [rows, setRows] = useState<RepeatingRow[]>(initialRows);
  return (
    <RepeatingGroup
      columns={columns}
      rows={rows}
      onChange={setRows}
      answerSets={answerSets}
      answerSelection={(ri, set) => chosenKey(set, rows[ri])}
      onAnswerSelect={(ri, set, key) =>
        setRows((prev) => prev.map((r, i) => (i === ri ? applySelection(set, r, key) : r)))
      }
      fixedRows={fixedRows}
      errorRowIndexes={errorRowIndexes}
      readOnly={readOnly}
    />
  );
}

const CHECKLIST_COLUMNS: RepeatingGroupColumn[] = [
  { key: 'item', label: 'Item', type: 'text' },
  { key: 'ok', label: 'OK', type: 'checkbox' },
  { key: 'na', label: 'N/A', type: 'checkbox' },
];

const SET: RepeatingGroupAnswerSet = {
  key: 'status',
  label: 'Status',
  columnKeys: ['ok', 'na'],
};

const FIXED = ['Engine oil level', 'Tyre pressure'];

function seed(): RepeatingRow[] {
  return FIXED.map((label) => ({ item: label, ok: null, na: null }));
}

function checkedOf(name: RegExp): string | null {
  return screen.getByRole('radio', { name }).getAttribute('aria-checked');
}

function rowOf(name: string) {
  return screen.getByRole('row', { name: new RegExp(name) });
}

describe('RepeatingGroup answer sets', () => {
  it('clears the previously chosen option when a second option in the set is selected', () => {
    render(<Harness columns={CHECKLIST_COLUMNS} initialRows={seed()} answerSets={[SET]} fixedRows={FIXED} />);

    fireEvent.click(screen.getByRole('radio', { name: /Engine oil level.*OK/ }));
    expect(checkedOf(/Engine oil level.*OK/)).toBe('true');

    fireEvent.click(screen.getByRole('radio', { name: /Engine oil level.*N\/A/ }));
    expect(checkedOf(/Engine oil level.*N\/A/)).toBe('true');
    expect(checkedOf(/Engine oil level.*OK/)).toBe('false');
  });

  it('returns the row to unanswered when the currently chosen option is reselected', () => {
    render(<Harness columns={CHECKLIST_COLUMNS} initialRows={seed()} answerSets={[SET]} fixedRows={FIXED} />);

    const ok = () => screen.getByRole('radio', { name: /Engine oil level.*OK/ });
    fireEvent.click(ok());
    expect(checkedOf(/Engine oil level.*OK/)).toBe('true');
    fireEvent.click(ok());
    expect(checkedOf(/Engine oil level.*OK/)).toBe('false');
    expect(checkedOf(/Engine oil level.*N\/A/)).toBe('false');
  });

  it('leaves an ungrouped column rendering its own independent control, unaffected by set writes', () => {
    const columns: RepeatingGroupColumn[] = [
      ...CHECKLIST_COLUMNS,
      { key: 'flag', label: 'Flagged', type: 'checkbox' },
    ];
    render(
      <Harness
        columns={columns}
        initialRows={FIXED.map((label) => ({ item: label, ok: null, na: null, flag: false }))}
        answerSets={[SET]}
        fixedRows={FIXED}
      />,
    );

    const flag = screen.getAllByRole('checkbox', { name: /Flagged/ })[0] as HTMLInputElement;
    fireEvent.click(flag);
    expect(flag.checked).toBe(true);

    fireEvent.click(screen.getByRole('radio', { name: /Engine oil level.*OK/ }));
    expect((screen.getAllByRole('checkbox', { name: /Flagged/ })[0] as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it('renders the first truthy option when legacy data marks two members of a set', () => {
    const rows: RepeatingRow[] = [
      { item: FIXED[0]!, ok: true, na: true },
      { item: FIXED[1]!, ok: null, na: null },
    ];
    render(<Harness columns={CHECKLIST_COLUMNS} initialRows={rows} answerSets={[SET]} fixedRows={FIXED} />);

    expect(checkedOf(/Engine oil level.*OK/)).toBe('true');
    expect(checkedOf(/Engine oil level.*N\/A/)).toBe('false');
  });

  it('keeps the fixed-row label column locked and unanswerable when the rest form a set', () => {
    render(<Harness columns={CHECKLIST_COLUMNS} initialRows={seed()} answerSets={[SET]} fixedRows={FIXED} />);

    const row = rowOf('Engine oil level');
    expect(within(row).queryByRole('textbox')).toBeNull();
    expect(within(row).getAllByRole('radio')).toHaveLength(2);
  });

  it('renders the chosen option label in readOnly mode, and an em dash when unanswered', () => {
    const rows: RepeatingRow[] = [
      { item: FIXED[0]!, ok: null, na: true },
      { item: FIXED[1]!, ok: null, na: null },
    ];
    render(
      <Harness
        columns={CHECKLIST_COLUMNS}
        initialRows={rows}
        answerSets={[SET]}
        fixedRows={FIXED}
        readOnly
      />,
    );

    expect(within(rowOf('Engine oil level')).getByText('N/A')).toBeTruthy();
    expect(within(rowOf('Tyre pressure')).getByText('—')).toBeTruthy();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });

  it('renders a set alongside a trailing free-text comments column', () => {
    const columns: RepeatingGroupColumn[] = [
      ...CHECKLIST_COLUMNS,
      { key: 'comments', label: 'Comments', type: 'text' },
    ];
    render(
      <Harness
        columns={columns}
        initialRows={FIXED.map((label) => ({ item: label, ok: null, na: null, comments: '' }))}
        answerSets={[SET]}
        fixedRows={FIXED}
      />,
    );

    const row = rowOf('Engine oil level');
    expect(within(row).getAllByRole('radio')).toHaveLength(2);
    const comments = within(row).getByRole('textbox', { name: /Comments/ }) as HTMLInputElement;
    fireEvent.change(comments, { target: { value: 'topped up' } });
    expect((within(rowOf('Engine oil level')).getByRole('textbox', { name: /Comments/ }) as HTMLInputElement).value).toBe(
      'topped up',
    );
  });

  it('marks only the rows listed in errorRowIndexes as errored', () => {
    render(
      <Harness
        columns={CHECKLIST_COLUMNS}
        initialRows={seed()}
        answerSets={[SET]}
        fixedRows={FIXED}
        errorRowIndexes={[1]}
      />,
    );

    expect(
      within(rowOf('Tyre pressure')).getByRole('radiogroup').getAttribute('aria-invalid'),
    ).toBe('true');
    expect(
      within(rowOf('Engine oil level')).getByRole('radiogroup').getAttribute('aria-invalid'),
    ).not.toBe('true');
  });

  it("composes the row's label text with the option in each control's accessible name", () => {
    render(<Harness columns={CHECKLIST_COLUMNS} initialRows={seed()} answerSets={[SET]} fixedRows={FIXED} />);

    const radio = screen.getByRole('radio', { name: /Tyre pressure.*OK/ });
    expect(radio.getAttribute('aria-label')).toContain('Tyre pressure');
    expect(radio.getAttribute('aria-label')).toContain('OK');
  });

  it('exposes a single tab stop per desktop row', () => {
    render(<Harness columns={CHECKLIST_COLUMNS} initialRows={seed()} answerSets={[SET]} fixedRows={FIXED} />);

    for (const label of FIXED) {
      const group = within(rowOf(label)).getByRole('radiogroup');
      const stops = within(group)
        .getAllByRole('radio')
        .filter((el) => el.getAttribute('tabindex') === '0');
      expect(stops).toHaveLength(1);
    }
  });
});

describe('required markers on grouped columns', () => {
  /**
   * `requiredColumnsFilled` in @formai/shared deliberately EXEMPTS a column
   * that belongs to an answer set — the set requires one answer across its
   * members, so per-member required flags cannot all be satisfied at once.
   * Rendering an asterisk on each promised a rule validation never applies and
   * the filler could never meet.
   */
  const columns: RepeatingGroupColumn[] = [
    { key: 'item', label: 'Item', type: 'text' },
    { key: 'ok', label: 'OK', type: 'checkbox', required: true },
    { key: 'na', label: 'N/A', type: 'checkbox', required: true },
    { key: 'comment', label: 'Comment', type: 'text', required: true },
  ];
  const sets: RepeatingGroupAnswerSet[] = [{ key: 'status', columnKeys: ['ok', 'na'] }];

  it('shows no asterisk on a set member, but keeps it on an ungrouped column', () => {
    render(<Harness columns={columns} answerSets={sets} initialRows={[{}]} />);
    const headers = screen.getAllByRole('columnheader');
    const text = (label: string) =>
      headers.find((h) => h.textContent?.startsWith(label))?.textContent ?? '';

    expect(text('OK')).not.toContain('*');
    expect(text('N/A')).not.toContain('*');
    // The ungrouped required column is unaffected — this is a targeted
    // exemption, not the removal of required markers.
    expect(text('Comment')).toContain('*');
  });

  it('still marks a required column when the table has no answer set', () => {
    render(<Harness columns={columns} initialRows={[{}]} />);
    const headers = screen.getAllByRole('columnheader');
    expect(headers.find((h) => h.textContent?.startsWith('OK'))?.textContent).toContain('*');
  });
});
