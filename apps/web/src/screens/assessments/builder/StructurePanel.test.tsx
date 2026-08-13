// @vitest-environment jsdom
/**
 * The structure editor.
 *
 * The arrangement logic is tested without a DOM in `builder-structure.test.ts`;
 * what is left for this file is the things only the component decides — which
 * controls exist, what they are called, and which of them are reachable.
 *
 * The load-bearing one is the type palette. `typeOptionsFor` exists because two
 * editors once disagreed about what a field may become, and a reviewer could
 * turn a Date into an optionless checkbox group that blocked every submit. This
 * is the third editor; the test pins that it asks the shared guard rather than
 * listing types itself.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { BuilderStructure, FormField } from '@formai/shared';
import { StructurePanel, type StructurePanelProps } from './StructurePanel.js';

vi.mock('@formai/ui', () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
  // The shared ColumnInspector mounts inside this panel now; these two are
  // the only controls it needs beyond Icon.
  Select: ({ options, value, onChange, ...rest }: Record<string, unknown>) => (
    <select value={value as string} onChange={onChange as never} aria-label={rest['aria-label'] as string}>
      {(options as Array<{ label: string; value: string }>).map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
  Switch: ({ checked, onChange, ...rest }: Record<string, unknown>) => (
    <input type="checkbox" checked={checked as boolean} onChange={onChange as never} aria-label={rest['aria-label'] as string} />
  ),
}));

function field(over: Partial<FormField> & { id: string }): FormField {
  return { label: over.id, type: 'text', required: false, source: 'imported', ...over };
}

const FIELDS: FormField[] = [
  field({ id: 'a', label: 'Candidate name' }),
  field({ id: 'b', label: 'Employee ID' }),
  field({ id: 'c', label: 'Assessor signature', type: 'signature' }),
  field({ id: 'tbl', label: 'Pre-start checks', type: 'repeating_group', fixedRows: ['Oil'] }),
];

const STRUCTURE: BuilderStructure = [
  { key: 's1', label: 'Candidate declaration', cols: 1, cover: true, fields: [{ id: 'a' }, { id: 'b' }] },
  { key: 's2', label: 'Part 2 — Practical', cols: 1, fields: [{ id: 'c' }, { id: 'tbl' }] },
];

function setup(over: Partial<StructurePanelProps> = {}) {
  const props: StructurePanelProps = {
    structure: STRUCTURE,
    fields: FIELDS,
    collapsed: false,
    onToggleCollapsed: vi.fn(),
    onReset: vi.fn(),
    onMoveSection: vi.fn(),
    onRenameSection: vi.fn(),
    onSetColumns: vi.fn(),
    onToggleOwnPage: vi.fn(),
    onDissolve: vi.fn(),
    onDuplicate: vi.fn(),
    onMoveField: vi.fn(),
    onCycleSpan: vi.fn(),
    onSetFieldType: vi.fn(),
    onGroup: vi.fn(),
    onAddField: vi.fn(),
    onRenameField: vi.fn(),
    onDeleteField: vi.fn(),
    onFoldField: vi.fn(),
    onPatchField: vi.fn(),
    ...over,
  };
  return { props, ...render(<StructurePanel {...props} />) };
}

/** Open a section's disclosure so its fields and controls render. */
function expand(label: string) {
  fireEvent.click(screen.getByText(label));
}

describe('StructurePanel', () => {
  it('lists every section with its field count', () => {
    setup();

    expect(screen.getByText('Candidate declaration')).toBeTruthy();
    expect(screen.getByText('Part 2 — Practical')).toBeTruthy();
    expect(screen.getAllByText(/2 fields/)).toHaveLength(2);
  });

  it('collapses to a rail that reopens it', () => {
    const onToggleCollapsed = vi.fn();
    setup({ collapsed: true, onToggleCollapsed });

    // Nothing but the rail — the arrangement is not rendered at all.
    expect(screen.queryByText('Candidate declaration')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show structure' }));
    expect(onToggleCollapsed).toHaveBeenCalled();
  });

  it('shows a section’s fields only once it is expanded', () => {
    setup();
    expect(screen.queryByText('Candidate name')).toBeNull();

    expand('Candidate declaration');
    expect(screen.getByText('Candidate name')).toBeTruthy();
  });

  it('disables the reorder arrows at the ends rather than wrapping', () => {
    setup();

    expect(
      screen.getByRole('button', { name: 'Move Candidate declaration earlier' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(
      screen.getByRole('button', { name: 'Move Candidate declaration later' }).hasAttribute('disabled'),
    ).toBe(false);
    expect(
      screen.getByRole('button', { name: 'Move Part 2 — Practical later' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  it('moves a section', () => {
    const onMoveSection = vi.fn();
    setup({ onMoveSection });

    fireEvent.click(screen.getByRole('button', { name: 'Move Candidate declaration later' }));

    expect(onMoveSection).toHaveBeenCalledWith('s1', 1);
  });

  it('offers 1, 2 and 3 columns, and reports the choice', () => {
    const onSetColumns = vi.fn();
    setup({ onSetColumns });
    expand('Candidate declaration');

    fireEvent.click(screen.getByRole('button', { name: '3 col' }));

    expect(onSetColumns).toHaveBeenCalledWith('s1', 3);
  });

  it('hides the span control in a single-column section, where it has one value', () => {
    setup();
    expand('Candidate declaration');

    expect(screen.queryByRole('button', { name: /Column span/ })).toBeNull();
  });

  it('shows the span control once a section has more than one column', () => {
    const onCycleSpan = vi.fn();
    setup({
      structure: [{ ...STRUCTURE[0]!, cols: 2 }],
      onCycleSpan,
    });
    expand('Candidate declaration');

    const span = screen.getByRole('button', { name: 'Column span for Candidate name' });
    expect(span.textContent).toBe('1/2');

    fireEvent.click(span);
    expect(onCycleSpan).toHaveBeenCalledWith('s1', 'a');
  });

  it('groups the ticked fields and clears the selection', () => {
    const onGroup = vi.fn();
    setup({ onGroup });
    expand('Candidate declaration');

    fireEvent.click(screen.getByRole('button', { name: 'Select Candidate name' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select Employee ID' }));
    expect(screen.getByText('2 fields selected')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Group into section/ }));

    expect(onGroup).toHaveBeenCalledWith(['a', 'b']);
    expect(screen.queryByText('2 fields selected')).toBeNull();
  });

  it('shows no selection bar until something is ticked', () => {
    setup();
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it('bulk-deletes the ticked fields and clears the selection', () => {
    const onDeleteField = vi.fn();
    setup({ onDeleteField });
    expand('Candidate declaration');

    fireEvent.click(screen.getByRole('button', { name: 'Select Candidate name' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select Employee ID' }));
    fireEvent.click(screen.getByRole('button', { name: /Delete fields/ }));

    expect(onDeleteField).toHaveBeenCalledTimes(2);
    expect(onDeleteField).toHaveBeenCalledWith('a');
    expect(onDeleteField).toHaveBeenCalledWith('b');
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it('bulk-moves the ticked fields to the chosen section, in arrangement order', () => {
    const onMoveField = vi.fn();
    setup({ onMoveField });
    expand('Candidate declaration');

    // Ticked in REVERSE order — the move must still follow the arrangement.
    fireEvent.click(screen.getByRole('button', { name: 'Select Employee ID' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select Candidate name' }));
    fireEvent.change(screen.getByLabelText('Move selected fields to section'), {
      target: { value: 's2' },
    });

    expect(onMoveField.mock.calls).toEqual([
      ['a', 's2', null, false],
      ['b', 's2', null, false],
    ]);
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it('bulk-deletes the ticked sections', () => {
    const onDissolve = vi.fn();
    setup({ onDissolve });

    fireEvent.click(screen.getByRole('button', { name: 'Select section Candidate declaration' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select section Part 2 — Practical' }));
    expect(screen.getByText('2 sections selected')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Delete sections/ }));

    expect(onDissolve.mock.calls).toEqual([['s1'], ['s2']]);
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it('reports fields and sections together when both are ticked', () => {
    setup();
    expand('Candidate declaration');

    fireEvent.click(screen.getByRole('button', { name: 'Select Candidate name' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select section Part 2 — Practical' }));

    expect(screen.getByText('1 field · 1 section selected')).toBeTruthy();
  });

  describe('the type palette', () => {
    it('offers what the shared guard allows, not a list of its own', () => {
      // `typeOptionsFor` on a scalar returns the authorable types only — no
      // repeating_group, checkbox_group or boolean_yes_no, each of which needs
      // payload only extraction can supply.
      setup();
      expand('Candidate declaration');
      fireEvent.click(screen.getByRole('button', { name: 'Change type of Candidate name' }));

      expect(screen.getByRole('button', { name: /Date/ })).toBeTruthy();
      expect(screen.getByRole('button', { name: /Paragraph/ })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Repeating table/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /Checkbox group/ })).toBeNull();
    });

    it('OFFERS CHECK / CROSS, WHICH IS WHAT AN OUTCOME BOX IS', () => {
      /*
        This assertion inverts a rule this list used to carry. `check_cross`
        was excluded as "a table CELL affordance" — true of a repeating-group
        column, false of the field type, which is what a printed outcome box is
        extracted as.

        The cost was concrete: extraction misses outcome boxes on a dense paper,
        and the field an author added to fix that could never BE one, because
        the only type that draws a verdict was the one type the palette refused
        to offer.
      */
      setup();
      expand('Candidate declaration');
      fireEvent.click(screen.getByRole('button', { name: 'Change type of Candidate name' }));

      expect(screen.getByRole('button', { name: /Check \/ Cross/ })).toBeTruthy();
    });

    it('keeps a structural field’s own type in its list, so it can be seen', () => {
      // An imported table must be recognisable as one without a scalar being
      // convertible into one.
      setup();
      expand('Part 2 — Practical');
      fireEvent.click(screen.getByRole('button', { name: 'Change type of Pre-start checks' }));

      expect(screen.getByRole('button', { name: /Repeating table/ })).toBeTruthy();
    });

    it('reports the chosen type and closes', () => {
      const onSetFieldType = vi.fn();
      setup({ onSetFieldType });
      expand('Candidate declaration');
      fireEvent.click(screen.getByRole('button', { name: 'Change type of Candidate name' }));
      fireEvent.click(screen.getByRole('button', { name: /Date/ }));

      expect(onSetFieldType).toHaveBeenCalledWith('a', 'date');
      expect(screen.queryByRole('button', { name: /Paragraph/ })).toBeNull();
    });
  });

  describe('dragging', () => {
    it('reports the dragged field, its target section and the row it is over', () => {
      /*
        The ABOVE-OR-BELOW half of this is not asserted here, deliberately.
        jsdom gives every element a zero rect and does not forward `clientY`
        through a synthetic drag event, so a test that pinned it here would be
        measuring the harness rather than the component. The midpoint rule is a
        property of `moveField`, and `builder-structure.test.ts` covers both
        directions against real numbers.
      */
      const onMoveField = vi.fn();
      setup({ onMoveField });
      expand('Candidate declaration');

      const row = screen.getByText('Candidate name').closest('[draggable]')!;
      const target = screen.getByText('Employee ID').closest('[draggable]')!;
      fireEvent.dragStart(row, { dataTransfer: { setData: vi.fn(), effectAllowed: '' } });
      fireEvent.dragOver(target, { dataTransfer: { dropEffect: '' } });

      expect(onMoveField).toHaveBeenCalledWith('a', 's1', 'b', expect.any(Boolean));
    });

    it('does not report a move before a drag has started', () => {
      // Without a held drag source there is nothing to move, and acting on a
      // dragover from elsewhere on the page would move a random field.
      const onMoveField = vi.fn();
      setup({ onMoveField });
      expand('Candidate declaration');

      const target = screen.getByText('Employee ID').closest('[draggable]')!;
      fireEvent.dragOver(target, { clientY: 10, dataTransfer: { dropEffect: '' } });

      expect(onMoveField).not.toHaveBeenCalled();
    });

    it('stops reporting once the drag ends', () => {
      const onMoveField = vi.fn();
      setup({ onMoveField });
      expand('Candidate declaration');

      const row = screen.getByText('Candidate name').closest('[draggable]')!;
      const target = screen.getByText('Employee ID').closest('[draggable]')!;
      fireEvent.dragStart(row, { dataTransfer: { setData: vi.fn(), effectAllowed: '' } });
      fireEvent.dragEnd(row);
      onMoveField.mockClear();

      fireEvent.dragOver(target, { clientY: 10, dataTransfer: { dropEffect: '' } });

      expect(onMoveField).not.toHaveBeenCalled();
    });
  });

  it('says so when a section is empty, rather than showing nothing', () => {
    setup({ structure: [{ key: 's1', label: 'Empty', cols: 1, fields: [] }] });
    expand('Empty');

    expect(screen.getByText('Empty — drag a field here')).toBeTruthy();
  });

  it('marks an own-page section', () => {
    setup({ structure: [{ ...STRUCTURE[0]!, ownPage: true }] });

    expect(screen.getByText('Own page')).toBeTruthy();
  });

  it('deletes a section', () => {
    const onDissolve = vi.fn();
    setup({ onDissolve });
    expand('Candidate declaration');

    fireEvent.click(screen.getByLabelText('Delete section Candidate declaration'));

    expect(onDissolve).toHaveBeenCalledWith('s1');
  });

  it('disables delete on the last remaining section', () => {
    // `dissolveSection` would no-op anyway; the disabled button says so.
    setup({ structure: [STRUCTURE[0]!] });
    expand('Candidate declaration');

    expect(
      (screen.getByLabelText('Delete section Candidate declaration') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('renames a section', () => {
    const onRenameSection = vi.fn();
    setup({ onRenameSection });
    expand('Candidate declaration');

    fireEvent.change(screen.getByLabelText('Rename Candidate declaration'), {
      target: { value: 'Identity' },
    });

    expect(onRenameSection).toHaveBeenCalledWith('s1', 'Identity');
  });

  it('offers a reset back to the extracted order', () => {
    const onReset = vi.fn();
    setup({ onReset });

    fireEvent.click(screen.getByRole('button', { name: 'Reset to the extracted order' }));

    expect(onReset).toHaveBeenCalled();
  });

  it('falls back to the field id when a field is missing from the list', () => {
    // The arrangement can outlive a field; showing the id beats showing blank.
    setup({ structure: [{ key: 's1', label: 'S', cols: 1, fields: [{ id: 'ghost' }] }] });
    expand('S');

    const row = screen.getByText('ghost');
    expect(within(row.closest('[draggable]')!).getByText('ghost')).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * Correcting the extraction: add, delete, fold
 * ------------------------------------------------------------------ */

describe('StructurePanel — correcting what the extraction got wrong', () => {
  it('adds a field AFTER the one it was invoked from', () => {
    // A missed box is missed from somewhere. Appending and making the author
    // drag it into place is half a feature.
    const { props } = setup();
    expand('Candidate declaration');

    fireEvent.click(screen.getByRole('button', { name: 'Add a field after Employee ID' }));

    expect(props.onAddField).toHaveBeenCalledWith('s1', 'b', 'text', 'New field');
  });

  it('deletes a field', () => {
    const { props } = setup();
    expand('Candidate declaration');

    fireEvent.click(screen.getByRole('button', { name: 'Delete Candidate name' }));

    expect(props.onDeleteField).toHaveBeenCalledWith('a');
  });

  it('folds a field into the one ABOVE it', () => {
    // A printed instruction read as a text box qualifies the field it follows.
    const { props } = setup();
    expand('Candidate declaration');

    fireEvent.click(screen.getByRole('button', { name: 'Fold Employee ID into the field above' }));

    expect(props.onFoldField).toHaveBeenCalledWith('b', 'a');
  });

  it('offers no fold on the FIRST field of a section', () => {
    /*
      There is nothing above it to fold into. An instruction printed first is a
      heading, which the type palette already handles — offering a control that
      cannot work is worse than not offering it.
    */
    setup();
    expand('Candidate declaration');

    expect(screen.queryByRole('button', { name: /Fold Candidate name/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Fold Employee ID/ })).toBeTruthy();
  });

  describe('renaming a field', () => {
    it('reports every keystroke, so the draft holds what was typed', () => {
      /*
        The gap this closes sits directly beside "add a field". `addField`
        creates "New field" because there is no printed label to copy — the box
        was MISSED — and with no rename that string was permanent. The published
        form said "New field" where the paper says "Assessment Result", on the
        cell an auditor reads first.
      */
      const { props } = setup();
      expand('Candidate declaration');

      fireEvent.click(screen.getByRole('button', { name: 'Rename Candidate name' }));
      fireEvent.change(screen.getByLabelText('Field name'), {
        target: { value: 'Assessment Result' },
      });

      expect(props.onRenameField).toHaveBeenCalledWith('a', 'Assessment Result');
    });

    it('DROPS `draggable` WHILE RENAMING', () => {
      /*
        Every row is draggable, and a draggable ancestor swallows the pointer
        gestures that place a caret and select text — an input inside one is
        typable but not editable. That is a worse affordance than no rename at
        all, because it looks like it works.
      */
      setup();
      expand('Candidate declaration');
      const row = screen.getByText('Candidate name').closest('[draggable]')!;
      expect(row.getAttribute('draggable')).toBe('true');

      fireEvent.click(screen.getByRole('button', { name: 'Rename Candidate name' }));

      const editing = screen.getByLabelText('Field name').closest('div')!;
      expect(editing.getAttribute('draggable')).toBe('false');
    });

    it('renames ONE field at a time', () => {
      // The input's accessible name is fixed rather than tracking the label it
      // edits — which only stays unique because a second row cannot open one.
      setup();
      expand('Candidate declaration');

      fireEvent.click(screen.getByRole('button', { name: 'Rename Candidate name' }));
      fireEvent.click(screen.getByRole('button', { name: 'Rename Employee ID' }));

      expect(screen.getAllByLabelText('Field name')).toHaveLength(1);
    });

    it('closes on Enter and puts the label back', () => {
      setup();
      expand('Candidate declaration');
      fireEvent.click(screen.getByRole('button', { name: 'Rename Candidate name' }));

      fireEvent.keyDown(screen.getByLabelText('Field name'), { key: 'Enter' });

      expect(screen.queryByLabelText('Field name')).toBeNull();
      expect(screen.getByText('Candidate name')).toBeTruthy();
    });

    it('closes on Escape without reverting what was already reported', () => {
      /*
        Escape closes the editor; it does not undo. Every keystroke has already
        gone to the draft, and an Escape that silently rolled back would be the
        only place in this panel where a visible edit is not the stored one.
      */
      const { props } = setup();
      expand('Candidate declaration');
      fireEvent.click(screen.getByRole('button', { name: 'Rename Candidate name' }));
      fireEvent.change(screen.getByLabelText('Field name'), { target: { value: 'Typed' } });

      fireEvent.keyDown(screen.getByLabelText('Field name'), { key: 'Escape' });

      expect(screen.queryByLabelText('Field name')).toBeNull();
      expect(props.onRenameField).toHaveBeenCalledWith('a', 'Typed');
    });
  });

/**
 * The column editor — the shared ColumnInspector mounted per repeating row.
 * Extraction gets a table's columns wrong the same ways it gets fields wrong
 * (a missed column, a Date read as text); this is where an author corrects it.
 */
describe('column editing', () => {
  it('offers the columns button only on repeating tables', () => {
    setup();
    expand('Part 2 — Practical');

    expect(screen.getByRole('button', { name: 'Edit columns of Pre-start checks' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit columns of Assessor signature' })).toBeNull();
  });

  it('opens the shared inspector and patches a column type through it', () => {
    const { props } = setup({
      fields: FIELDS.map((f) =>
        f.id === 'tbl'
          ? {
              ...f,
              fixedRows: undefined,
              columns: [
                { key: 'date', label: 'Date', type: 'text' },
                { key: 'task', label: 'Task', type: 'text' },
              ],
            }
          : f,
      ),
    });
    expand('Part 2 — Practical');
    fireEvent.click(screen.getByRole('button', { name: 'Edit columns of Pre-start checks' }));

    expect(screen.getByText('Table columns')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Column type: Date'), { target: { value: 'date' } });

    expect(props.onPatchField).toHaveBeenCalledWith(
      'tbl',
      expect.objectContaining({
        columns: [
          { key: 'date', label: 'Date', type: 'date' },
          { key: 'task', label: 'Task', type: 'text' },
        ],
      }),
    );
  });
});

});
