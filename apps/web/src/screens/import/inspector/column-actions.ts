/**
 * `ColumnActions` bound to the two hosts that mount `ColumnInspector`.
 *
 * The panel itself is host-agnostic (R17: the same inspector before and after
 * publish). Import review drives the import session; the builder drives its own
 * reducer. Keeping both adapters here means the difference between the two is
 * one small file rather than two diverging copies of the panel.
 */
import type { FormField, FormFieldType, VisibilityCondition } from '@formai/shared';
import {
  acceptAnswerSet,
  addColumn,
  answerSetAccepted,
  groupColumns,
  moveColumn,
  removeColumn,
  renameColumn,
  setColumnRequired,
  setColumnOptions,
  setColumnType,
  setFieldCondition,
  setTableLabelColumn,
  ungroupAnswerSet,
} from '../../../lib/data/import-session.js';
import type { ColumnActions } from './ColumnInspector.js';
import type { ConditionActions } from './ConditionEditor.js';

/** Pre-publish: every edit goes through the import session's shared editor. */
export const importSessionColumnActions: ColumnActions = {
  renameColumn,
  setColumnType,
  setColumnRequired,
  setColumnOptions,
  groupColumns,
  ungroupAnswerSet,
  acceptAnswerSet,
  answerSetAccepted,
  setLabelColumn: setTableLabelColumn,
  addColumn,
  removeColumn,
  moveColumn,
};

/** Pre-publish: the condition is written into the reviewed field list. */
export const importSessionConditionActions: ConditionActions = {
  setCondition: setFieldCondition,
};

/**
 * Post-publish: the same panel, writing a reducer patch instead. Clearing sets
 * `visibleWhen` to undefined rather than omitting it, so the spread in the
 * reducer's `update` actually removes the old condition.
 */
export function builderConditionActions(
  update: (patch: Partial<FormField>) => void,
): ConditionActions {
  return {
    setCondition: (_id: string, condition: VisibilityCondition | null) =>
      update({ visibleWhen: condition ?? undefined }),
  };
}

/** Column types answered by picking from `options`. Mirrors `ColumnInspector`. */
const CHOICE_COLUMN_TYPES: ReadonlySet<string> = new Set(['dropdown', 'radio']);
const SEEDED_OPTIONS = ['Option 1', 'Option 2'];

/** Patch one column of a repeating field, preserving column order and key. */
function patchColumn(
  field: FormField,
  columnKey: string,
  patch: Partial<{ label: string; type: FormFieldType; required: boolean; options: string[] }>,
): Partial<FormField> {
  return {
    columns: (field.columns ?? []).map((c) => (c.key === columnKey ? { ...c, ...patch } : c)),
  };
}

/**
 * Post-publish: the builder holds its fields in `builderReducer`, so the same
 * edits become `update` patches. Answer-set acceptance is review-only state —
 * a published set was already accepted by whoever published it, so the builder
 * reports every set as accepted and never renders a proposal affordance.
 */
export function builderColumnActions(
  field: FormField,
  update: (patch: Partial<FormField>) => void,
): ColumnActions {
  const sets = () => field.answerSets ?? [];
  const isChecklist = (field.fixedRows?.length ?? 0) > 0;
  const cols = () => field.columns ?? [];
  // `columns[0]` is the row-identity column: never a set member (matches
  // `resolveAnswerSets`) and never removable, checklist or not.
  const rowIdentityKey = field.columns?.[0]?.key;
  return {
    renameColumn: (_id, columnKey, label) => update(patchColumn(field, columnKey, { label })),
    setColumnType: (_id, columnKey, type) => {
      // Retyping a grouped column out of checkbox drops it from its set, so a
      // one-member remnant the resolver would silently discard never forms.
      const remaining = sets()
        .map((s) => ({ ...s, columnKeys: s.columnKeys.filter((k) => k !== columnKey) }))
        .filter((s) => s.columnKeys.length >= 2);
      // A choice column with no options falls through to a plain text input,
      // so seed it — the same trap `retypeField` closes for scalar fields.
      const existing = field.columns?.find((c) => c.key === columnKey)?.options;
      const options =
        CHOICE_COLUMN_TYPES.has(type) && !existing?.length ? SEEDED_OPTIONS : existing;
      update({
        ...patchColumn(field, columnKey, { type, ...(options ? { options } : {}) }),
        answerSets: remaining,
      });
    },
    setColumnRequired: (_id, columnKey, required) => update(patchColumn(field, columnKey, { required })),
    setColumnOptions: (_id, columnKey, options) => update(patchColumn(field, columnKey, { options })),
    groupColumns: (_id, columnKeys) => {
      const members = columnKeys.filter((k) => k !== rowIdentityKey);
      if (members.length < 2) return null;
      const key = `set-${members.join('-')}`;
      const others = sets()
        .map((s) => ({ ...s, columnKeys: s.columnKeys.filter((k) => !members.includes(k)) }))
        .filter((s) => s.columnKeys.length >= 2);
      update({ answerSets: [...others, { key, columnKeys: members }] });
      return key;
    },
    ungroupAnswerSet: (_id, setKey) => update({ answerSets: sets().filter((s) => s.key !== setKey) }),
    acceptAnswerSet: () => {},
    answerSetAccepted: () => true,
    setLabelColumn: (_id, wantLabel) => {
      if (wantLabel === isChecklist) return;
      if (!wantLabel) {
        update({ fixedRows: undefined });
        return;
      }
      // Open → checklist: the first column becomes pre-printed text (KTD1) and
      // leaves any answer set; a single blank item seeds the checklist.
      const columns = cols();
      if (columns.length === 0) return;
      const firstKey = columns[0]!.key;
      update({
        columns: columns.map((c, i) => (i === 0 ? { key: c.key, label: c.label, type: 'text' } : c)),
        fixedRows: [''],
        answerSets: sets()
          .map((s) => ({ ...s, columnKeys: s.columnKeys.filter((k) => k !== firstKey) }))
          .filter((s) => s.columnKeys.length >= 2),
      });
    },
    addColumn: () => {
      const columns = cols();
      const taken = new Set(columns.map((c) => c.key));
      let n = columns.length + 1;
      while (taken.has(`col${n}`)) n += 1;
      update({ columns: [...columns, { key: `col${n}`, label: `Column ${columns.length + 1}`, type: 'text' }] });
    },
    removeColumn: (_id, columnKey) => {
      const columns = cols();
      if (columns.length <= 1 || columnKey === rowIdentityKey || !columns.some((c) => c.key === columnKey)) return;
      update({
        columns: columns.filter((c) => c.key !== columnKey),
        answerSets: sets()
          .map((s) => ({ ...s, columnKeys: s.columnKeys.filter((k) => k !== columnKey) }))
          .filter((s) => s.columnKeys.length >= 2),
      });
    },
    moveColumn: (_id, columnKey, dir) => {
      // Reorder by array position; the `key` is unchanged, so answer sets and
      // row values are untouched. `columns[0]` is pinned — the checklist label /
      // row-identity column — so nothing crosses index 0 on a checklist.
      const columns = cols();
      const i = columns.findIndex((c) => c.key === columnKey);
      const floor = isChecklist ? 1 : 0;
      const j = i + dir;
      if (i < 0 || i < floor || j < floor || j >= columns.length) return;
      const next = columns.slice();
      [next[i], next[j]] = [next[j]!, next[i]!];
      update({ columns: next });
    },
  };
}
