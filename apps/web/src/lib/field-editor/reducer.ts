/**
 * Field-editing state + reducer, shared by the builder and the PDF import
 * review screen. Mirrors the prototype's builder ops
 * (bAdd/bDelete/bMove/bDuplicate/bCopy/bPaste/bUndo/bRedo) with an undo/redo
 * snapshot stack. Fields use the shared FormField shape so publishing feeds the
 * data layer directly.
 *
 * It lives under `lib/` rather than `screens/builder/` because import review
 * needs the same operations (rename, retype, reorder, delete, undo) before
 * publish that the builder offers after it. One reducer means a correction
 * behaves identically on both sides of publishing, instead of two editors
 * drifting apart.
 */
import type { FormContainer, FormField, FormFieldType } from '@formai/shared';
import { DEFAULT_CONTAINER, FORM_FIELD_TYPES } from '@formai/shared';

export const CONTAINER_ID = '__container__';

export type PanelTab = 'field' | 'layout';
export type BuilderMode = 'edit' | 'preview';

interface Snapshot {
  fields: FormField[];
  selectedId: string | null;
}

export interface BuilderState {
  name: string;
  /** Persisted template id when editing an existing form; null for a new (unsaved) form. */
  formId: string | null;
  fields: FormField[];
  selectedId: string | null;
  panelTab: PanelTab;
  container: FormContainer;
  clipboard: FormField | null;
  undo: Snapshot[];
  redo: Snapshot[];
  seq: number;
  mode: BuilderMode;
}

/** Palette entries — display label + icon per creatable field type. */
export const PALETTE: Array<{ type: FormFieldType; icon: string; label: string }> = [
  { type: 'text', icon: 'type', label: 'Text' },
  { type: 'number', icon: 'hash', label: 'Number' },
  { type: 'date', icon: 'calendar', label: 'Date' },
  { type: 'checkbox', icon: 'check-square', label: 'Checkbox' },
  { type: 'radio', icon: 'circle-dot', label: 'Multiple choice' },
  { type: 'dropdown', icon: 'chevron-down', label: 'Dropdown' },
  { type: 'signature', icon: 'pen-tool', label: 'Signature' },
  { type: 'file_upload', icon: 'paperclip', label: 'File upload' },
  { type: 'section_header', icon: 'heading', label: 'Section header' },
];

export const FIELD_META: Record<string, { icon: string; label: string }> = {
  text: { icon: 'type', label: 'Text' },
  number: { icon: 'hash', label: 'Number' },
  date: { icon: 'calendar', label: 'Date' },
  checkbox: { icon: 'check-square', label: 'Checkbox' },
  radio: { icon: 'circle-dot', label: 'Multiple choice' },
  dropdown: { icon: 'chevron-down', label: 'Dropdown' },
  signature: { icon: 'pen-tool', label: 'Signature' },
  file_upload: { icon: 'paperclip', label: 'File upload' },
  section_header: { icon: 'heading', label: 'Section header' },
  boolean_yes_no: { icon: 'toggle-left', label: 'Yes / No' },
  textarea: { icon: 'text', label: 'Paragraph' },
  repeating_group: { icon: 'table', label: 'Repeating table' },
  checkbox_group: { icon: 'list-checks', label: 'Checkbox group' },
  check_cross: { icon: 'check-check', label: 'Check / Cross' },
};

/**
 * Types that are IMPORTED, never authored. Each one carries payload that only
 * extraction can supply — a `repeating_group` needs columns, a `checkbox_group`
 * needs options that mean something — so conjuring one from a scalar field
 * produces a field that renders nothing and, if required, can never be
 * satisfied.
 */
const STRUCTURAL_TYPES: ReadonlySet<FormFieldType> = new Set([
  'repeating_group',
  'checkbox_group',
  'boolean_yes_no',
  // A table CELL affordance, offered by `ColumnInspector`'s own list. It is
  // not a standalone question, so it stays out of the field-type dropdown for
  // the same reason `boolean_yes_no` does.
  'check_cross',
]);

/** Types whose answer is chosen from `options`. */
const CHOICE_TYPES: ReadonlySet<FormFieldType> = new Set(['dropdown', 'radio', 'checkbox_group']);

/**
 * Does this type answer from `options`?
 *
 * Exported so the editors' options panel and `retypeField`'s seeding read the
 * SAME rule. They did not: the reducer seeded options for dropdown and radio
 * while the import inspector rendered its editor for dropdown and radio only,
 * so an imported `checkbox_group` had options that nothing would show. One
 * predicate is what stops the two drifting again.
 */
export function isChoiceType(type: FormFieldType): boolean {
  return CHOICE_TYPES.has(type);
}

const AUTHORABLE_TYPE_OPTIONS = FORM_FIELD_TYPES.filter((t) => !STRUCTURAL_TYPES.has(t)).map(
  (t) => ({ label: FIELD_META[t]?.label ?? t, value: t }),
);

/**
 * Type choices for a field, for BOTH editors.
 *
 * Structural types stay out of the list for a scalar field (see
 * `STRUCTURAL_TYPES`). But an imported structural field must still see its own
 * type, or the dropdown would show something the field is not and one stray
 * change would destroy the table (R17).
 *
 * This lives here rather than in either screen because import review and the
 * builder must not disagree about what a field may become. They did: review
 * built its dropdowns straight from `FORM_FIELD_TYPES`, so a reviewer could
 * turn a Date into an optionless Checkbox group that blocked every submit —
 * the exact case the builder had guarded against since it was written.
 */
export function typeOptionsFor(type: FormFieldType): Array<{ label: string; value: string }> {
  if (!STRUCTURAL_TYPES.has(type)) return AUTHORABLE_TYPE_OPTIONS;
  return [{ label: FIELD_META[type]?.label ?? type, value: type }, ...AUTHORABLE_TYPE_OPTIONS];
}

/**
 * Re-type a field, reconciling the payload only its OLD type could own.
 *
 * Spreading and overwriting `type` leaves `options` on a field that is no
 * longer a choice and `columns`/`answerSets`/`fixedRows` on one that is no
 * longer a table. That is invisible until the type is changed back, at which
 * point the stale payload reappears — including an answer set a reviewer had
 * already accepted, now attached to a table whose columns were cleared from
 * under it. Clearing on the way out makes a retype reversible without being
 * resurrective.
 */
function retypeField(f: FormField, type: FormFieldType): FormField {
  const nf: FormField = { ...f, type };

  if (CHOICE_TYPES.has(type)) {
    // Preserve real options (an imported `checkbox_group`'s D / N); seed only
    // when there is nothing to preserve.
    if (!nf.options?.length) nf.options = ['Option 1', 'Option 2'];
  } else {
    delete nf.options;
  }

  if (type !== 'checkbox_group') delete nf.selectionType;

  // `typeOptionsFor` makes ENTERING repeating_group unreachable from either
  // editor, so in practice this only ever clears.
  if (type !== 'repeating_group') {
    delete nf.columns;
    delete nf.answerSets;
    delete nf.fixedRows;
  }

  return nf;
}

const NEW_LABELS: Partial<Record<FormFieldType, string>> = {
  text: 'Untitled question',
  number: 'Number',
  date: 'Date',
  checkbox: 'Checkbox option',
  radio: 'Multiple choice',
  dropdown: 'Dropdown',
  signature: 'Signature',
  file_upload: 'File upload',
  section_header: 'New section',
};

function newField(type: FormFieldType, id: string): FormField {
  const field: FormField = {
    id,
    type,
    label: NEW_LABELS[type] ?? 'Question',
    required: false,
    help: '',
    placeholder: '',
    validation: { kind: 'none' },
    source: 'built',
    colSpan: 12,
  };
  if (type === 'dropdown' || type === 'radio') field.options = ['Option 1', 'Option 2'];
  return field;
}

/**
 * Clear visibility conditions whose source is no longer strictly earlier in the
 * list.
 *
 * `conditionSources` enforces earlier-only when the condition is AUTHORED, but
 * `move`, `reorder` and drag-and-drop rewrite the order afterwards, and the
 * evaluator performs no order check. Drag a source below the section it gates
 * and `visibleFields` hides the header, which hides the source as section
 * content — so the filler can never answer it and the section can never open.
 * Worse than a dead section: required-ness is scoped to visible fields, so
 * every required question inside it is silently exempted and the submission
 * passes validation with a whole location's checks never asked.
 *
 * Clearing is the conservative repair: the dependent becomes always-visible
 * (over-collect), matching the fail-open direction the evaluator already takes.
 */
function pruneOrphanedConditions(fields: FormField[]): FormField[] {
  const indexById = new Map(fields.map((f, i) => [f.id, i]));
  return fields.map((f, i) => {
    const sourceId = f.visibleWhen?.fieldId;
    if (sourceId === undefined) return f;
    const sourceIndex = indexById.get(sourceId);
    if (sourceIndex !== undefined && sourceIndex < i) return f;
    const { visibleWhen: _dropped, ...rest } = f;
    return rest as FormField;
  });
}

function snapshot(s: BuilderState): Snapshot {
  return { fields: structuredClone(s.fields), selectedId: s.selectedId };
}

/** Wrap a structural mutation with undo bookkeeping (mirrors bMutate). */
function mutate(s: BuilderState, fn: (fields: FormField[]) => { fields: FormField[]; selectedId?: string | null }): BuilderState {
  const before = snapshot(s);
  const { fields, selectedId } = fn(s.fields.slice());
  return {
    ...s,
    fields,
    selectedId: selectedId === undefined ? s.selectedId : selectedId,
    undo: [...s.undo, before].slice(-60),
    redo: [],
  };
}

export type BuilderAction =
  | { t: 'setName'; name: string }
  | { t: 'setMode'; mode: BuilderMode }
  | { t: 'setPanelTab'; tab: PanelTab }
  | { t: 'select'; id: string | null }
  | { t: 'selectRel'; dir: -1 | 1 }
  | { t: 'add'; fieldType: FormFieldType }
  | { t: 'update'; id: string; patch: Partial<FormField> }
  | { t: 'changeType'; id: string; fieldType: FormFieldType }
  | { t: 'duplicate'; id: string }
  | { t: 'delete'; id: string }
  | { t: 'move'; id: string; dir: -1 | 1 }
  | { t: 'reorder'; from: number; to: number }
  | { t: 'copy' }
  | { t: 'paste' }
  | { t: 'undo' }
  | { t: 'redo' }
  | { t: 'setOption'; id: string; index: number; value: string }
  | { t: 'addOption'; id: string }
  | { t: 'removeOption'; id: string; index: number }
  | { t: 'setContainer'; patch: Partial<FormContainer> };

export function builderReducer(s: BuilderState, a: BuilderAction): BuilderState {
  switch (a.t) {
    case 'setName':
      return { ...s, name: a.name };
    case 'setMode':
      return { ...s, mode: a.mode };
    case 'setPanelTab':
      return { ...s, panelTab: a.tab };
    case 'select':
      return {
        ...s,
        selectedId: a.id,
        panelTab: a.id === CONTAINER_ID && s.panelTab === 'field' ? 'layout' : s.panelTab,
      };
    case 'selectRel': {
      const i = s.fields.findIndex((f) => f.id === s.selectedId);
      const j = Math.max(0, Math.min(s.fields.length - 1, (i < 0 ? 0 : i) + a.dir));
      const next = s.fields[j];
      return next ? { ...s, selectedId: next.id } : s;
    }
    case 'add': {
      const next = mutate(s, (fields) => {
        const id = `b${s.seq + 1}`;
        const f = newField(a.fieldType, id);
        const i = fields.findIndex((x) => x.id === s.selectedId);
        const at = i < 0 ? fields.length : i + 1;
        fields.splice(at, 0, f);
        return { fields, selectedId: id };
      });
      return { ...next, seq: s.seq + 1 };
    }
    case 'update':
      return {
        ...s,
        fields: s.fields.map((f) => (f.id === a.id ? { ...f, ...a.patch } : f)),
      };
    case 'changeType':
      return mutate(s, (fields) => ({
        fields: fields.map((f) => (f.id === a.id ? retypeField(f, a.fieldType) : f)),
      }));
    case 'duplicate': {
      const next = mutate(s, (fields) => {
        const i = fields.findIndex((f) => f.id === a.id);
        if (i < 0) return { fields };
        const nid = `b${s.seq + 1}`;
        const copy: FormField = { ...structuredClone(fields[i]!), id: nid, label: `${fields[i]!.label} (copy)`, source: 'built' };
        fields.splice(i + 1, 0, copy);
        return { fields, selectedId: nid };
      });
      return { ...next, seq: s.seq + 1 };
    }
    case 'delete':
      return mutate(s, (fields) => {
        const i = fields.findIndex((f) => f.id === a.id);
        if (i < 0) return { fields };
        fields.splice(i, 1);
        const prev = fields[Math.max(0, i - 1)];
        return { fields, selectedId: prev?.id ?? null };
      });
    case 'move':
      return mutate(s, (fields) => {
        const i = fields.findIndex((f) => f.id === a.id);
        const j = i + a.dir;
        if (i < 0 || j < 0 || j >= fields.length) return { fields };
        [fields[i], fields[j]] = [fields[j]!, fields[i]!];
        return { fields: pruneOrphanedConditions(fields) };
      });
    case 'reorder': {
      // arrayMove semantics for drag-and-drop drops (unlike `move`, which is an
      // adjacent swap). No-op when nothing changes; out-of-bounds is ignored.
      const { from, to } = a;
      if (from === to) return s;
      if (from < 0 || to < 0 || from >= s.fields.length || to >= s.fields.length) return s;
      return mutate(s, (fields) => {
        const [f] = fields.splice(from, 1);
        fields.splice(to, 0, f!);
        return { fields: pruneOrphanedConditions(fields) };
      });
    }
    case 'copy': {
      const f = s.fields.find((x) => x.id === s.selectedId);
      return f ? { ...s, clipboard: structuredClone(f) } : s;
    }
    case 'paste': {
      if (!s.clipboard) return s;
      const next = mutate(s, (fields) => {
        const nid = `b${s.seq + 1}`;
        const copy: FormField = { ...structuredClone(s.clipboard!), id: nid, source: 'built' };
        const i = fields.findIndex((f) => f.id === s.selectedId);
        fields.splice(i < 0 ? fields.length : i + 1, 0, copy);
        return { fields, selectedId: nid };
      });
      return { ...next, seq: s.seq + 1 };
    }
    case 'undo': {
      if (!s.undo.length) return s;
      const prev = s.undo[s.undo.length - 1]!;
      return {
        ...s,
        fields: prev.fields,
        selectedId: prev.selectedId,
        undo: s.undo.slice(0, -1),
        redo: [...s.redo, snapshot(s)],
      };
    }
    case 'redo': {
      if (!s.redo.length) return s;
      const next = s.redo[s.redo.length - 1]!;
      return {
        ...s,
        fields: next.fields,
        selectedId: next.selectedId,
        redo: s.redo.slice(0, -1),
        undo: [...s.undo, snapshot(s)],
      };
    }
    case 'setOption':
      return {
        ...s,
        fields: s.fields.map((f) =>
          f.id === a.id ? { ...f, options: (f.options ?? []).map((o, i) => (i === a.index ? a.value : o)) } : f,
        ),
      };
    case 'addOption':
      return mutate(s, (fields) => ({
        fields: fields.map((f) => (f.id === a.id ? { ...f, options: [...(f.options ?? []), 'New option'] } : f)),
      }));
    case 'removeOption':
      return mutate(s, (fields) => ({
        fields: fields.map((f) =>
          f.id === a.id ? { ...f, options: (f.options ?? []).filter((_, i) => i !== a.index) } : f,
        ),
      }));
    case 'setContainer':
      return { ...s, container: { ...s.container, ...a.patch } };
    default:
      return s;
  }
}

/** Seed for a builder session: blank (`formId: null`) or an existing form's current version. */
export interface BuilderInit {
  formId: string | null;
  name: string;
  fields: FormField[];
  container?: FormContainer;
}

/**
 * Starting value for the generated-field id sequence (`b<n>`). Must clear the
 * highest existing `b<n>` id, not just the field count — a re-loaded form may
 * have gaps from deletions (e.g. `b1, b2, b4`), and `fields.length` alone
 * would mint a colliding `b4`.
 */
export function initialSeq(fields: FormField[]): number {
  let seq = fields.length;
  for (const f of fields) {
    const m = /^b(\d+)$/.exec(f.id);
    if (m) seq = Math.max(seq, Number(m[1]));
  }
  return seq;
}

export function initialBuilderState(init: BuilderInit): BuilderState {
  return {
    name: init.name,
    formId: init.formId,
    fields: structuredClone(init.fields),
    selectedId: init.fields[1]?.id ?? init.fields[0]?.id ?? null,
    panelTab: 'field',
    container: init.container ? { ...init.container } : { ...DEFAULT_CONTAINER },
    clipboard: null,
    undo: [],
    redo: [],
    seq: initialSeq(init.fields),
    mode: 'edit',
  };
}
