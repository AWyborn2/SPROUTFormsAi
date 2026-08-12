import { useState } from 'react';
import { Icon } from '@formai/ui';
import {
  resolveSpan,
  type BuilderStructure,
  type FormField,
  type FormFieldType,
  type SectionColumns,
} from '@formai/shared';
import { FIELD_META, typeOptionsFor } from '../../../lib/field-editor/reducer.js';
import { ColumnInspector } from '../../import/inspector/ColumnInspector.js';
import { builderColumnActions } from '../../import/inspector/column-actions.js';

/**
 * The structure editor — the left column of Step 2.
 *
 * WHAT AN AUTHOR IS ACTUALLY DOING HERE. Extraction returns the document's
 * fields in printed order, which is the right default and is rarely the right
 * digital form: a paper's cover page crams identity, eligibility and verdict
 * onto one sheet because paper is expensive, and a screen has no such reason.
 * This is where that gets rearranged — and it is the only place in the product
 * where somebody sees the whole shape of the form at once.
 *
 * EVERY OPERATION IS A PURE FUNCTION IN `builder-structure.ts`. This component
 * holds no arrangement state of its own; it renders what it is given and calls
 * up. That split is why the drag behaviour is testable without a DOM, and it is
 * what the design prototype could not do — its equivalent lived in a render
 * closure and read its own drag source from a stale one.
 *
 * IT COLLAPSES TO A RAIL. The Track Dozer carries 185 fields; the preview
 * beside it is the thing being judged. An author who wants to look at the form
 * needs the panel out of the way without losing their place in it.
 */

/*
  THE TYPE LIST IS NOT BUILT HERE.

  `typeOptionsFor` exists because import review and the template builder once
  disagreed about what a field may become: review built its dropdown straight
  from `FORM_FIELD_TYPES`, so a reviewer could turn a Date into an optionless
  checkbox group that blocked every submit. This is a third editor, and a third
  hand-written list would drift the same way — including back into that exact
  bug, since a structural type needs payload only extraction can supply.

  It also keeps a field's OWN structural type in its list where it has one, so
  an imported table can be seen for what it is without being convertible into
  one from a scalar.
*/

const GRID_CLASS: Record<SectionColumns, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  3: 'grid-cols-3',
};

const SPAN_CLASS: Record<number, string> = {
  1: 'col-span-1',
  2: 'col-span-2',
  3: 'col-span-3',
};

export interface StructurePanelProps {
  structure: BuilderStructure;
  fields: readonly FormField[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onReset: () => void;
  onMoveSection: (key: string, delta: number) => void;
  onRenameSection: (key: string, label: string) => void;
  onSetColumns: (key: string, cols: SectionColumns) => void;
  onToggleOwnPage: (key: string) => void;
  onMoveField: (
    fieldId: string,
    toSectionKey: string,
    beforeFieldId: string | null,
    after: boolean,
  ) => void;
  onCycleSpan: (sectionKey: string, fieldId: string) => void;
  onSetFieldType: (fieldId: string, type: FormFieldType) => void;
  onGroup: (fieldIds: string[]) => void;
  /**
   * Add a field the extraction MISSED, after this one.
   *
   * The gap this closes: the model will miss a box on some paper, and until now
   * the only answers were to re-import and hope, or to hand-edit the published
   * version afterwards. A product whose premise is "upload a document nobody
   * has seen" cannot leave that uncorrectable.
   */
  onAddField: (sectionKey: string, afterFieldId: string | null, type: FormFieldType, label: string) => void;
  /**
   * Rename a field.
   *
   * The gap this closes sits directly beside `onAddField`'s: a field the
   * extraction missed arrives as "New field", and with no rename that string
   * was permanent — the published form said "New field" where the paper says
   * "Assessment Result", on the cell an auditor reads first.
   */
  onRenameField: (fieldId: string, label: string) => void;
  /** Delete a field the extraction INVENTED, and every reference to it. */
  onDeleteField: (fieldId: string) => void;
  /** Fold a field into the previous one's description — an instruction, not a box. */
  onFoldField: (fieldId: string, targetFieldId: string) => void;
  /**
   * Patch a field's own properties — the column editor's write path.
   *
   * Extraction reads a table's columns off the page and gets them wrong the
   * same ways it gets fields wrong: a merged column, a missed one, a Date
   * read as text. The shared `ColumnInspector` is the correction, and it
   * drives every host through exactly this patch shape.
   */
  onPatchField: (fieldId: string, patch: Partial<FormField>) => void;
}

export function StructurePanel({
  structure,
  fields,
  collapsed,
  onToggleCollapsed,
  onReset,
  onMoveSection,
  onRenameSection,
  onSetColumns,
  onToggleOwnPage,
  onMoveField,
  onCycleSpan,
  onSetFieldType,
  onGroup,
  onAddField,
  onRenameField,
  onDeleteField,
  onFoldField,
  onPatchField,
}: StructurePanelProps) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [typeMenuFor, setTypeMenuFor] = useState<string | null>(null);
  /** The repeating field whose column editor is expanded, if any. */
  const [columnsFor, setColumnsFor] = useState<string | null>(null);
  /**
   * The field being renamed, if any.
   *
   * A MODE rather than an always-live input, because every row is `draggable`
   * and a draggable ancestor swallows the pointer gestures that place a caret
   * and select text — an input inside one is typable but not editable, which is
   * a worse affordance than none. Entering the mode drops `draggable` for that
   * row, so the input behaves like an input.
   */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  /**
   * The field being dragged, held here rather than read from the drag event.
   *
   * `dataTransfer.getData` is unreadable during `dragover` in every browser —
   * only `drop` may read it — so a handler that needs to know WHAT is being
   * dragged while deciding where it would land has to keep it itself.
   */
  const [dragging, setDragging] = useState<string | null>(null);

  const byId = new Map(fields.map((f) => [f.id, f]));
  const selectedIds = Object.keys(selected).filter((id) => selected[id]);
  const fieldCount = structure.reduce((n, s) => n + s.fields.length, 0);

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-label="Show structure"
        className="sticky top-0 flex h-[calc(100vh-56px)] w-11 flex-none flex-col items-center gap-3 border-r border-border bg-surface-card py-4 hover:bg-surface-hover"
      >
        <Icon name="panel-left-open" size={15} className="text-text-tertiary" />
        <span className="text-[11.5px] font-semibold text-text-secondary [writing-mode:vertical-rl]">
          Structure
        </span>
      </button>
    );
  }

  return (
    <div className="sticky top-0 flex h-[calc(100vh-56px)] w-[340px] flex-none flex-col overflow-hidden border-r border-border bg-surface-card">
      <div className="flex items-start gap-2 border-b border-border-subtle p-[14px_12px_10px_16px]">
        <span className="min-w-0 flex-1">
          <span className="block text-[14.5px] font-semibold">Form structure</span>
          <span className="mt-0.5 block text-[11.5px] text-text-tertiary">
            {structure.length} section{structure.length === 1 ? '' : 's'} · {fieldCount} field
            {fieldCount === 1 ? '' : 's'}
          </span>
        </span>
        <button
          type="button"
          onClick={onReset}
          title="Reset to the extracted order"
          aria-label="Reset to the extracted order"
          className="grid h-[26px] w-[26px] flex-none place-items-center rounded-lg border border-border text-text-tertiary hover:bg-surface-hover"
        >
          <Icon name="rotate-ccw" size={13} />
        </button>
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label="Collapse structure"
          className="grid h-[26px] w-[26px] flex-none place-items-center rounded-lg border border-border text-text-tertiary hover:bg-surface-hover"
        >
          <Icon name="panel-left-close" size={13} />
        </button>
      </div>

      {selectedIds.length > 0 && (
        <div className="flex items-center gap-2 border-b border-border-subtle bg-surface-accent-soft p-[8px_12px]">
          <span className="min-w-0 flex-1 text-[11.5px] font-semibold text-text-accent">
            {selectedIds.length} field{selectedIds.length === 1 ? '' : 's'} selected
          </span>
          <button
            type="button"
            onClick={() => {
              onGroup(selectedIds);
              setSelected({});
            }}
            className="inline-flex h-[27px] items-center gap-1.5 rounded-lg bg-accent px-2.5 text-[11px] font-semibold text-accent-contrast"
          >
            <Icon name="group" size={12} />
            Group into section
          </button>
          <button
            type="button"
            onClick={() => setSelected({})}
            className="px-1 py-1 text-[11px] text-text-secondary"
          >
            Clear
          </button>
        </div>
      )}

      <div className="fai-scroll flex min-h-0 flex-1 flex-col gap-1 overflow-auto p-[8px_10px_12px]">
        {structure.map((section, i) => {
          const isOpen = !!open[section.key];
          return (
            <div key={section.key} className="rounded-[10px] border border-border-subtle">
              <div className="flex items-center gap-2 p-[8px_10px]">
                <span className="flex flex-none flex-col gap-0.5">
                  <button
                    type="button"
                    onClick={() => onMoveSection(section.key, -1)}
                    disabled={i === 0}
                    aria-label={`Move ${section.label} earlier`}
                    className="grid h-[15px] w-5 place-items-center rounded border border-border text-[6.5px] text-text-tertiary disabled:opacity-30"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    onClick={() => onMoveSection(section.key, 1)}
                    disabled={i === structure.length - 1}
                    aria-label={`Move ${section.label} later`}
                    className="grid h-[15px] w-5 place-items-center rounded border border-border text-[6.5px] text-text-tertiary disabled:opacity-30"
                  >
                    ▼
                  </button>
                </span>
                <button
                  type="button"
                  onClick={() => setOpen((p) => ({ ...p, [section.key]: !p[section.key] }))}
                  aria-expanded={isOpen}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <Icon
                    name={isOpen ? 'chevron-down' : 'chevron-right'}
                    size={14}
                    className="flex-none text-text-tertiary"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-semibold">
                      {section.label}
                    </span>
                    <span className="block text-[10.5px] text-text-tertiary">
                      {section.fields.length} field{section.fields.length === 1 ? '' : 's'}
                      {section.cols > 1 ? ` · ${section.cols}-column` : ''}
                    </span>
                  </span>
                </button>
                {section.ownPage && (
                  <span className="flex-none rounded-full bg-info-soft px-2 py-0.5 text-[9.5px] font-semibold text-info-text">
                    Own page
                  </span>
                )}
              </div>

              {isOpen && (
                <>
                  <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle p-[8px_10px]">
                    <input
                      value={section.label}
                      onChange={(e) => onRenameSection(section.key, e.target.value)}
                      aria-label={`Rename ${section.label}`}
                      placeholder="Section name"
                      className="h-7 min-w-0 flex-[1_1_140px] rounded-lg border border-border bg-surface-card px-2.5 text-[11.5px]"
                    />
                    <span className="flex flex-none gap-0.5 rounded-lg bg-surface-sunken p-0.5">
                      {([1, 2, 3] as SectionColumns[]).map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => onSetColumns(section.key, c)}
                          aria-pressed={section.cols === c}
                          className={`rounded-md px-2 py-[3px] text-[9.5px] font-semibold ${
                            section.cols === c
                              ? 'bg-surface-card text-text-primary shadow-sm'
                              : 'text-text-tertiary'
                          }`}
                        >
                          {c} col
                        </button>
                      ))}
                    </span>
                    <button
                      type="button"
                      onClick={() => onToggleOwnPage(section.key)}
                      aria-pressed={!!section.ownPage}
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-[3px] text-[9.5px] font-semibold ${
                        section.ownPage
                          ? 'border-border-accent bg-surface-accent-soft text-text-accent'
                          : 'border-border text-text-tertiary'
                      }`}
                    >
                      <Icon name="file" size={10} />
                      Own page
                    </button>
                  </div>

                  <div
                    onDragOver={(e) => {
                      // Only the section's own empty space, not a bubbled row.
                      if (e.target !== e.currentTarget) return;
                      e.preventDefault();
                      if (dragging) onMoveField(dragging, section.key, null, false);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragging(null);
                    }}
                    className={`grid gap-1 p-[4px_8px_8px] ${GRID_CLASS[section.cols]}`}
                  >
                    {section.fields.length === 0 && (
                      <p className="col-span-full py-2 text-center text-[10.5px] text-text-tertiary">
                        Empty — drag a field here
                      </p>
                    )}
                    {section.fields.map((entry, i) => {
                      const field = byId.get(entry.id);
                      const span = resolveSpan(entry, section.cols);
                      const isSelected = !!selected[entry.id];
                      const isDragging = dragging === entry.id;
                      const isRenaming = renamingId === entry.id;
                      return (
                        <div key={entry.id} className={`min-w-0 ${SPAN_CLASS[span]}`}>
                          <div
                            draggable={!isRenaming}
                            onDragStart={(e) => {
                              e.dataTransfer.effectAllowed = 'move';
                              e.dataTransfer.setData('text/plain', entry.id);
                              setDragging(entry.id);
                            }}
                            onDragOver={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              e.dataTransfer.dropEffect = 'move';
                              if (!dragging) return;
                              // The midpoint decides above-or-below, which is
                              // what stops a row flip-flopping as the pointer
                              // wobbles over the edge two rows share.
                              const r = e.currentTarget.getBoundingClientRect();
                              onMoveField(
                                dragging,
                                section.key,
                                entry.id,
                                e.clientY > r.top + r.height / 2,
                              );
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setDragging(null);
                            }}
                            onDragEnd={() => setDragging(null)}
                            className={`flex min-w-0 cursor-grab items-center gap-[7px] rounded-lg border p-[5px_7px] ${
                              isDragging
                                ? 'border-accent opacity-55'
                                : isSelected
                                  ? 'border-border-accent bg-surface-accent-soft'
                                  : 'border-border-subtle bg-surface-card'
                            }`}
                          >
                            <Icon
                              name="grip-vertical"
                              size={11}
                              className="flex-none text-text-tertiary"
                            />
                            <button
                              type="button"
                              onClick={() =>
                                setSelected((p) => ({ ...p, [entry.id]: !p[entry.id] }))
                              }
                              aria-label={`Select ${field?.label ?? entry.id}`}
                              aria-pressed={isSelected}
                              className={`grid h-3.5 w-3.5 flex-none place-items-center rounded ${
                                isSelected
                                  ? 'border border-accent bg-accent text-accent-contrast'
                                  : 'border-[1.5px] border-border text-transparent'
                              }`}
                            >
                              <Icon name="check" size={9} />
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setTypeMenuFor((p) => (p === entry.id ? null : entry.id))
                              }
                              title="Change field type"
                              aria-label={`Change type of ${field?.label ?? entry.id}`}
                              aria-expanded={typeMenuFor === entry.id}
                              className={`grid h-[18px] w-[18px] flex-none place-items-center rounded-md border ${
                                typeMenuFor === entry.id
                                  ? 'border-border-accent bg-surface-accent-soft text-text-accent'
                                  : 'border-transparent text-text-tertiary'
                              }`}
                            >
                              <Icon
                                name={(field && FIELD_META[field.type]?.icon) || 'square'}
                                size={11}
                              />
                            </button>
                            {isRenaming ? (
                              <input
                                // eslint-disable-next-line jsx-a11y/no-autofocus -- the
                                // control exists only because the author just
                                // asked to rename; landing anywhere else costs
                                // a click per field on a 185-field document.
                                autoFocus
                                value={field?.label ?? ''}
                                onChange={(e) => onRenameField(entry.id, e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === 'Escape') setRenamingId(null);
                                }}
                                onBlur={() => setRenamingId(null)}
                                // Stable, unlike the label it edits: only one row
                                // renames at a time, so this stays unique, and a
                                // name that changed with every keystroke is one
                                // nothing can hold on to mid-edit.
                                aria-label="Field name"
                                placeholder="Field name"
                                className="h-[22px] min-w-0 flex-1 rounded border border-border-accent bg-surface-card px-1.5 text-[11px]"
                              />
                            ) : (
                              <span className="min-w-0 flex-1 truncate text-[11px]">
                                {field?.label ?? entry.id}
                              </span>
                            )}
                            {!isRenaming && (
                              <button
                                type="button"
                                onClick={() => setRenamingId(entry.id)}
                                title="Rename this field"
                                aria-label={`Rename ${field?.label ?? entry.id}`}
                                className="flex-none rounded border border-border px-1 py-px text-text-tertiary hover:bg-surface-hover"
                              >
                                <Icon name="pencil" size={10} />
                              </button>
                            )}
                            {field?.type === 'repeating_group' && (
                              <button
                                type="button"
                                onClick={() =>
                                  setColumnsFor((p) => (p === entry.id ? null : entry.id))
                                }
                                title="Edit the table's columns — names, types, add or remove"
                                aria-label={`Edit columns of ${field?.label ?? entry.id}`}
                                aria-expanded={columnsFor === entry.id}
                                className={`flex-none rounded border px-1 py-px ${
                                  columnsFor === entry.id
                                    ? 'border-border-accent bg-surface-accent-soft text-text-accent'
                                    : 'border-border text-text-tertiary hover:bg-surface-hover'
                                }`}
                              >
                                <Icon name="table-2" size={10} />
                              </button>
                            )}
                            {section.cols > 1 && (
                              <button
                                type="button"
                                onClick={() => onCycleSpan(section.key, entry.id)}
                                title="Column span"
                                aria-label={`Column span for ${field?.label ?? entry.id}`}
                                className="flex-none rounded border border-border px-1.5 py-px font-mono text-[8.5px] font-semibold text-text-secondary"
                              >
                                {span}/{section.cols}
                              </button>
                            )}
                            {/*
                              FOLD is offered only where there IS something above
                              to fold into. A printed instruction read as a text
                              box belongs to the field it qualifies, and the
                              field above it is the one it qualifies — an
                              instruction printed first is a heading, which the
                              type palette already handles.
                            */}
                            {i > 0 && (
                              <button
                                type="button"
                                onClick={() => onFoldField(entry.id, section.fields[i - 1]!.id)}
                                title="Make this a description of the field above"
                                aria-label={`Fold ${field?.label ?? entry.id} into the field above`}
                                className="flex-none rounded border border-border px-1 py-px text-text-tertiary hover:bg-surface-hover"
                              >
                                <Icon name="corner-left-up" size={10} />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => onAddField(section.key, entry.id, 'text', 'New field')}
                              title="Add a field the document has that this list does not"
                              aria-label={`Add a field after ${field?.label ?? entry.id}`}
                              className="flex-none rounded border border-border px-1 py-px text-text-tertiary hover:bg-surface-hover"
                            >
                              <Icon name="plus" size={10} />
                            </button>
                            <button
                              type="button"
                              onClick={() => onDeleteField(entry.id)}
                              title="Delete this field and everything that references it"
                              aria-label={`Delete ${field?.label ?? entry.id}`}
                              className="flex-none rounded border border-border px-1 py-px text-text-tertiary hover:bg-surface-hover"
                            >
                              <Icon name="trash-2" size={10} />
                            </button>
                          </div>

                          {columnsFor === entry.id && field && (
                            <div className="mt-1 rounded-lg border border-border bg-surface-card p-2.5">
                              {/*
                                The SHARED column inspector (R17) — the same
                                panel import review and the template builder
                                mount, driving this host through the same
                                patch adapter. A third hand-rolled column
                                editor is exactly the drift it exists to stop.
                              */}
                              <ColumnInspector
                                field={field}
                                actions={builderColumnActions(field, (patch) =>
                                  onPatchField(entry.id, patch),
                                )}
                              />
                            </div>
                          )}

                          {typeMenuFor === entry.id && (
                            <div className="mt-1 flex flex-wrap gap-1 rounded-lg border border-border bg-surface-sunken p-1.5">
                              {typeOptionsFor(field?.type ?? 'text').map((opt) => (
                                <button
                                  key={opt.value}
                                  type="button"
                                  onClick={() => {
                                    onSetFieldType(entry.id, opt.value as FormFieldType);
                                    setTypeMenuFor(null);
                                  }}
                                  className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-[3px] text-[10px] font-semibold ${
                                    field?.type === opt.value
                                      ? 'border-border-accent bg-surface-accent-soft text-text-accent'
                                      : 'border-border bg-surface-card text-text-secondary'
                                  }`}
                                >
                                  <Icon name={FIELD_META[opt.value]?.icon ?? 'square'} size={10} />
                                  {opt.label}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      <div className="border-t border-border-subtle bg-surface-sunken p-[8px_14px] text-[10.5px] text-text-tertiary">
        Drag fields to reorder or move between sections · tick to group into a new page
      </div>
    </div>
  );
}
