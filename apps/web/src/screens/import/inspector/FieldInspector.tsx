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
 * It is bound to `ImportReviewScreen`'s existing selection (the one that also
 * drives the PDF pane), so there is exactly one notion of "current field".
 */
import { useEffect, useState } from 'react';
import { Button, Icon, Input, Select, Switch } from '@formai/ui';
import type { FormFieldType } from '@formai/shared';
import { FORM_FIELD_TYPES } from '@formai/shared';
import {
  addField,
  addFieldOption,
  changeFieldType,
  deleteField,
  isChecklistTable,
  moveField,
  removeFieldOption,
  renameField,
  setFieldOption,
  setFieldRequired,
  type ReviewField,
} from '../../../lib/data/import-session.js';
import { FIELD_META, PALETTE } from '../../../lib/field-editor/reducer.js';
import { ColumnInspector } from './ColumnInspector.js';

const TYPE_OPTIONS = FORM_FIELD_TYPES.map((t) => ({ label: FIELD_META[t]?.label ?? t, value: t }));

/**
 * Which of the three panel states renders. Exported (and unit-tested) because
 * the non-happy paths are the part that silently diverges: nothing selected
 * and selection-deleted must both land on the SAME persistent prompt (never a
 * collapsed panel that shifts the layout), and a section header has no type,
 * options or required flag to show.
 */
export function inspectorMode(field: ReviewField | null | undefined): 'prompt' | 'section' | 'full' {
  if (!field) return 'prompt';
  return field.type === 'section_header' ? 'section' : 'full';
}

export interface FieldInspectorProps {
  /** The currently selected review row, or undefined when none/deleted. */
  field: ReviewField | undefined;
  /** Total field count — bounds the move-up/down affordances. */
  index: number;
  count: number;
  /** Re-point the shared selection (e.g. onto a newly inserted field). */
  onSelect: (id: string | null) => void;
}

export function FieldInspector({ field, index, count, onSelect }: FieldInspectorProps) {
  const mode = inspectorMode(field);

  if (mode === 'prompt' || !field) {
    return (
      <div className="rounded-md border border-border bg-surface-card p-[26px_16px] text-center shadow-xs">
        <Icon name="mouse-pointer-click" size={18} className="mx-auto mb-2 text-text-tertiary" />
        <div className="text-[13px] font-semibold text-text-primary">No field selected</div>
        <p className="mt-1 text-[12px] text-text-tertiary">
          Pick a field on the left (or in the PDF) to rename it, change its type or remove it.
        </p>
      </div>
    );
  }

  const meta = FIELD_META[field.type] ?? { icon: 'help-circle', label: field.type };
  const isSection = mode === 'section';
  const isChoice = field.type === 'dropdown' || field.type === 'radio';
  const checklist = isChecklistTable(field);
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
              options={TYPE_OPTIONS}
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

            <div className="flex items-center justify-between gap-2.5 rounded-md border border-border-subtle bg-surface-sunken p-[9px_12px]">
              <div>
                <div className="text-[12.5px] font-semibold">Required</div>
                <div className="text-[11px] text-text-tertiary">
                  {checklist ? 'Checklists default to required' : 'Must be answered to submit'}
                </div>
              </div>
              <Switch
                checked={field.required ?? checklist}
                onChange={(e) => setFieldRequired(field.id, e.target.checked)}
                aria-label={`Required (inspector): ${field.label}`}
              />
            </div>
          </>
        )}

        {isTable && <ColumnInspector field={field} />}

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
