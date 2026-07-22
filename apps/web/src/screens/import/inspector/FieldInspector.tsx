/**
 * Field inspector for import review (step 2).
 *
 * Review's triage surface (confidence, remap-to-signature, checklist items)
 * answers "did extraction get this right?". This panel answers the other half
 * — "is this the field I actually want to publish?" — by exposing the same
 * edits the builder offers, through the same reducer, BEFORE publish. Without
 * it an imported field's label, type, options and order were frozen until the
 * form existed, and imported tables were never editable at all.
 *
 * It is mounted INSIDE the expanded review row, by the accordion that rides on
 * `ImportReviewScreen`'s existing selection (the one that also drives the PDF
 * pane) — so there is exactly one notion of "current field", and the panel is
 * always adjacent to the row it edits. It previously floated above the list in
 * a sticky panel, which left every edit visually detached from its target.
 */
import { useEffect, useState } from 'react';
import { Button, Icon, Input, Select } from '@formai/ui';
import type { FormFieldType } from '@formai/shared';
import {
  addField,
  addFieldOption,
  changeFieldType,
  deleteField,
  moveField,
  removeFieldOption,
  renameField,
  setFieldOption,
  splitTableGroups,
  useImportSession,
  type ReviewField,
} from '../../../lib/data/import-session.js';
import { FIELD_META, PALETTE, isChoiceType, typeOptionsFor } from '../../../lib/field-editor/reducer.js';
import type { TextPage } from '../../../lib/pdf-geometry.js';
import { ColumnInspector } from './ColumnInspector.js';
import { ConditionEditor } from './ConditionEditor.js';
import { GeometryInspector } from './GeometryInspector.js';
import { importSessionColumnActions, importSessionConditionActions } from './column-actions.js';

/**
 * Which panel body renders. A section header has no type, options or required
 * flag to show, so it gets label + delete only.
 *
 * There is no longer a "nothing selected" state: the panel is mounted by the
 * expanded row and unmounted with it, so "no field" is not reachable. It used
 * to exist because the panel floated above the list and had to hold its own
 * layout when the selection was empty or deleted.
 */
export function inspectorMode(field: ReviewField): 'section' | 'full' {
  return field.type === 'section_header' ? 'section' : 'full';
}

export interface FieldInspectorProps {
  /** The expanded review row. Never absent — the row owns the mount. */
  field: ReviewField;
  /** Position in the form; bounds the move-up/down affordances. */
  index: number;
  count: number;
  /** Re-point the accordion (onto a newly inserted field, or null to close). */
  onSelect: (id: string | null) => void;
  /**
   * Page text from the viewer, for deriving this field's grid. Threaded as a
   * prop rather than stashed in the session because it is a view-derived cache
   * of the PDF, not review state — nothing that publishes depends on it.
   */
  textPages: readonly TextPage[];
}

export function FieldInspector({ field, index, count, onSelect, textPages }: FieldInspectorProps) {
  const mode = inspectorMode(field);
  // The condition panel needs the whole form to derive its source list (only
  // fields EARLIER than this one may be a source), so it reads the session
  // rather than taking the list through every caller.
  const { fields } = useImportSession();

  const meta = FIELD_META[field.type] ?? { icon: 'help-circle', label: field.type };
  const isSection = mode === 'section';
  // Shared with the reducer's option seeding, so the panel cannot show an
  // editor for a type the reducer never seeds (or hide one it does). That gap
  // is why an imported `checkbox_group` — the fixture's `Shift` field, with its
  // D / N options — was uneditable until after publish.
  const isChoice = isChoiceType(field.type);
  // Columns and answer sets only exist on a repeating table, and only once
  // extraction actually captured a column shape.
  const isTable = field.type === 'repeating_group' && (field.columns?.length ?? 0) > 0;

  return (
    <div className="overflow-hidden rounded-md border border-border bg-surface-card shadow-xs">
      <div className="flex items-center gap-2.5 border-b border-border-subtle bg-surface-sunken p-[12px_14px]">
        <Icon name={meta.icon} size={16} className="text-accent" />
        <span className="min-w-0 flex-1 truncate font-heading text-[13.5px] font-bold">{meta.label}</span>
        <span className="flex flex-none items-center gap-1">
          <button
            onClick={() => moveField(field.id, -1)}
            disabled={index <= 0}
            aria-label="Move field up"
            className="grid h-7 w-7 place-items-center rounded-sm border border-border text-text-tertiary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Icon name="arrow-up" size={13} />
          </button>
          <button
            onClick={() => moveField(field.id, 1)}
            disabled={index < 0 || index >= count - 1}
            aria-label="Move field down"
            className="grid h-7 w-7 place-items-center rounded-sm border border-border text-text-tertiary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Icon name="arrow-down" size={13} />
          </button>
        </span>
      </div>

      <div className="flex flex-col gap-3 p-[14px]">
        <LabelInput id={field.id} label={field.label} />

        {!isSection && (
          <>
            <Select
              label="Field type"
              options={typeOptionsFor(field.type)}
              value={field.type}
              onChange={(e) => changeFieldType(field.id, e.target.value as FormFieldType)}
              aria-label={`Field type: ${field.label}`}
            />

            {isChoice && (
              <div>
                <div className="mb-2 text-[12.5px] font-semibold">Options</div>
                <div className="flex flex-col gap-1.5">
                  {(field.options ?? []).map((o, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <input
                        value={o}
                        onChange={(e) => setFieldOption(field.id, i, e.target.value)}
                        aria-label={`Option ${i + 1}`}
                        className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-surface-card px-2 text-[12.5px] text-text-primary focus-visible:shadow-focus"
                      />
                      <button
                        onClick={() => removeFieldOption(field.id, i)}
                        aria-label={`Remove option ${i + 1}`}
                        className="grid h-7 w-7 flex-none place-items-center rounded-sm border border-border text-text-tertiary hover:bg-surface-hover hover:text-danger-text"
                      >
                        <Icon name="x" size={13} />
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  onClick={() => addFieldOption(field.id)}
                  className="mt-2 inline-flex items-center gap-1.5 rounded-sm border border-dashed border-border-strong px-2.5 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-surface-hover"
                >
                  <Icon name="plus" size={13} />
                  Add option
                </button>
              </div>
            )}

            {/*
              No Required toggle here. The row above already carries one, and
              rendering both meant two switches for the same property a few
              pixels apart — they needed distinct aria-labels ("Required" and
              "Required (inspector)") just to be told apart in tests, which is
              the tell. Required stays on the row: it is triage worth seeing
              across every field at a glance, without opening any of them.
            */}
          </>
        )}

        {isTable && <ColumnInspector field={field} actions={importSessionColumnActions} />}

        {isTable && (field.fixedRows?.length ?? 0) > 1 && (
          <SplitGroups id={field.id} items={field.fixedRows!.length} onSelect={onSelect} />
        )}

        {isTable && <GeometryInspector field={field} textPages={textPages} />}

        <ConditionEditor field={field} fields={fields} actions={importSessionConditionActions} />

        <div className="flex flex-col gap-2 border-t border-border-subtle pt-3">
          <div className="text-[12.5px] font-semibold">Insert below</div>
          <div className="flex flex-wrap gap-1.5">
            {PALETTE.map((p) => (
              <button
                key={p.type}
                onClick={() => onSelect(addField(p.type, field.id))}
                className="inline-flex items-center gap-1 rounded-sm border border-border px-2 py-1 text-[11.5px] font-medium text-text-secondary hover:bg-surface-hover"
              >
                <Icon name={p.icon} size={12} />
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <Button
          variant="ghost"
          leadingIcon="trash-2"
          onClick={() => {
            deleteField(field.id);
            onSelect(null);
          }}
          className="justify-center text-danger-text"
        >
          Delete field
        </Button>
      </div>
    </div>
  );
}

/**
 * Declare that one extracted table is really N side-by-side printed groups.
 *
 * Offered only where it can do something: a table with captured items. The
 * reviewer, not extraction, makes this call (KTD11) — they are looking at the
 * page, and extraction has already been seen to merge on one run what it split
 * on another for the same document.
 */
function SplitGroups({
  id,
  items,
  onSelect,
}: {
  id: string;
  items: number;
  onSelect: (id: string | null) => void;
}) {
  const [groups, setGroups] = useState(2);
  const max = Math.min(6, items);

  return (
    <div className="flex flex-col gap-2 border-t border-border-subtle pt-3">
      <div className="text-[12.5px] font-semibold">Side-by-side groups</div>
      <p className="text-[11.5px] leading-snug text-text-tertiary">
        If this one table is really several columns printed next to each other, split it. Items are
        dealt out in reading order, so each group ends up top-to-bottom as printed.
      </p>
      <div className="flex items-center gap-1.5">
        <Select
          options={Array.from({ length: max - 1 }, (_, i) => ({
            value: String(i + 2),
            label: `${i + 2} groups`,
          }))}
          value={String(groups)}
          onChange={(e) => setGroups(Number(e.target.value))}
          aria-label="Number of printed groups"
        />
        <Button
          variant="ghost"
          leadingIcon="columns-3"
          onClick={() => {
            // The split replaced this field; re-point the accordion at the
            // first group so the panel does not sit on an id that is gone.
            onSelect(splitTableGroups(id, groups)[0] ?? null);
          }}
        >
          Split
        </Button>
      </div>
    </div>
  );
}

/**
 * Label editor with local draft state. The store is updated on every
 * keystroke (the review row must track live), but the input keeps its own
 * value so a re-render mid-word can't fight the caret.
 */
function LabelInput({ id, label }: { id: string; label: string }) {
  const [draft, setDraft] = useState(label);
  useEffect(() => {
    setDraft(label);
  }, [id, label]);

  return (
    <Input
      label="Label"
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        renameField(id, e.target.value);
      }}
      aria-label="Field label"
    />
  );
}
