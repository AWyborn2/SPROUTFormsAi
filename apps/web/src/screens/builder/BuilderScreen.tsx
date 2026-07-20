import { useEffect, useMemo, useReducer, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Badge,
  Button,
  Icon,
  Input,
  Select,
  Switch,
  useToast,
} from '@formai/ui';
import type { FormField, FormFieldType } from '@formai/shared';
import { FORM_FIELD_TYPES } from '@formai/shared';
import { useForm, usePublishBuilder, usePublishVersion } from '../../lib/data/hooks.js';
import { isModChord, isTypingTarget, MOD_LABEL, ALT_LABEL } from '../../lib/keyboard/platform.js';
import { FieldInput } from '../fields/FieldRenderer.js';
import {
  builderReducer,
  initialBuilderState,
  CONTAINER_ID,
  FIELD_META,
  PALETTE,
  type BuilderInit,
  type BuilderState,
} from './reducer.js';

const COL_OPTIONS: Array<{ span: number; icon: string; label: string }> = [
  { span: 12, icon: 'rectangle-horizontal', label: 'Full' },
  { span: 6, icon: 'columns-2', label: 'Half' },
  { span: 4, icon: 'columns-3', label: 'Third' },
  { span: 3, icon: 'grid-2x2', label: 'Quarter' },
];

const VALIDATION_OPTIONS = [
  { label: 'None', value: 'none' },
  { label: 'Email', value: 'email' },
  { label: 'Number', value: 'number' },
  { label: 'Min length', value: 'minLength' },
  { label: 'Max length', value: 'maxLength' },
];

const TYPE_OPTIONS = FORM_FIELD_TYPES.filter(
  (t) => !['repeating_group', 'checkbox_group', 'boolean_yes_no'].includes(t),
).map((t) => ({ label: FIELD_META[t]?.label ?? t, value: t }));

/**
 * Builder entry point. With no `?form` param it starts a blank new-form
 * session; with `?form=<id>` it loads that template's current version and
 * seeds the editor from it (publishing then creates a new version of that
 * form). The reducer's lazy init runs once per mount, so the editor is keyed
 * by form id and only rendered after the detail loads — the async-loaded edit
 * path re-seeds by remount, not by a reset action.
 */
export function BuilderScreen() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [searchParams] = useSearchParams();
  const formId = searchParams.get('form') ?? undefined;
  const { data: detail, isLoading, isError } = useForm(formId);

  const notFound = !!formId && !isLoading && (isError || !detail);
  const bounced = useRef(false);
  useEffect(() => {
    if (notFound && !bounced.current) {
      bounced.current = true;
      toast({ message: 'That form could not be found.', variant: 'danger' });
      navigate('/app/forms');
    }
  }, [notFound, navigate, toast]);

  if (formId && !detail) {
    return (
      <div className="fai-rise mx-auto max-w-[1180px] p-[24px_28px_60px]">
        <div className="rounded-lg border border-border bg-surface-card p-8 text-center text-[13px] text-text-tertiary shadow-sm">
          {notFound ? 'Form not found.' : 'Loading form…'}
        </div>
      </div>
    );
  }

  const init: BuilderInit =
    formId && detail
      ? { formId, name: detail.name, fields: detail.fields, container: detail.container }
      : { formId: null, name: 'Untitled form', fields: [] };

  return <BuilderEditor key={formId ?? 'new'} init={init} />;
}

/** The drag-and-drop form builder (canvas + palette + config + live preview). */
function BuilderEditor({ init }: { init: BuilderInit }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const publish = usePublishBuilder();
  const publishVersion = usePublishVersion();
  const [state, dispatch] = useReducer(builderReducer, init, initialBuilderState);

  // Keep a ref to the latest state so the global key handler reads fresh values.
  const stateRef = useRef<BuilderState>(state);
  stateRef.current = state;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const s = stateRef.current;
      if (s.mode !== 'edit') return;
      const mod = isModChord(e);
      const typing = isTypingTarget(e.target);
      const sel = s.selectedId;

      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        dispatch({ t: e.shiftKey ? 'redo' : 'undo' });
        return;
      }
      if (mod && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        if (sel && sel !== CONTAINER_ID) dispatch({ t: 'duplicate', id: sel });
        return;
      }
      if (mod && e.key === 'Enter') {
        e.preventDefault();
        dispatch({ t: 'add', fieldType: 'text' });
        return;
      }
      if (mod && (e.key === 'c' || e.key === 'C') && !typing) {
        e.preventDefault();
        dispatch({ t: 'copy' });
        return;
      }
      if (mod && (e.key === 'v' || e.key === 'V') && !typing) {
        e.preventDefault();
        dispatch({ t: 'paste' });
        return;
      }
      if (!typing) {
        if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault();
          if (sel && sel !== CONTAINER_ID) dispatch({ t: 'delete', id: sel });
          return;
        }
        if (e.altKey && e.key === 'ArrowUp') {
          e.preventDefault();
          if (sel && sel !== CONTAINER_ID) dispatch({ t: 'move', id: sel, dir: -1 });
          return;
        }
        if (e.altKey && e.key === 'ArrowDown') {
          e.preventDefault();
          if (sel && sel !== CONTAINER_ID) dispatch({ t: 'move', id: sel, dir: 1 });
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          dispatch({ t: 'selectRel', dir: -1 });
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          dispatch({ t: 'selectRel', dir: 1 });
          return;
        }
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  const selectedField = useMemo(
    () => state.fields.find((f) => f.id === state.selectedId) ?? null,
    [state.fields, state.selectedId],
  );
  const containerSelected = state.selectedId === CONTAINER_ID;

  const publishPending = publish.isPending || publishVersion.isPending;

  function doPublish() {
    const onError = () =>
      toast({ message: 'Could not publish — try again.', variant: 'danger' });
    if (state.formId) {
      // Editing an existing form: publish the edits as a NEW version of it.
      publishVersion.mutate(
        { formId: state.formId, fields: state.fields, container: state.container },
        {
          onSuccess: (summary) => {
            toast({ message: `"${summary.name}" published as ${summary.version}.`, variant: 'success' });
            navigate('/app/forms');
          },
          onError,
        },
      );
    } else {
      publish.mutate(
        { name: state.name, fields: state.fields, container: state.container },
        {
          onSuccess: () => {
            toast({ message: `"${state.name}" is live.`, variant: 'success' });
            navigate('/app/forms');
          },
          onError,
        },
      );
    }
  }

  return (
    <div className="fai-rise mx-auto max-w-[1180px] p-[24px_28px_60px]">
      {/* Header */}
      <div className="mb-4 flex items-center gap-3">
        <span className="grid h-9 w-9 flex-none place-items-center rounded-[9px] bg-surface-accent-soft">
          <Icon name="layout-template" size={19} className="text-accent" />
        </span>
        <input
          value={state.name}
          onChange={(e) => dispatch({ t: 'setName', name: e.target.value })}
          aria-label="Form name"
          className="min-w-0 flex-1 rounded-sm border border-transparent bg-transparent px-2 py-1.5 font-heading text-[19px] font-bold tracking-tight text-text-primary hover:border-border focus:border-border-accent focus:outline-none"
        />
        <div className="flex flex-none">
          <button
            onClick={() => dispatch({ t: 'undo' })}
            aria-label="Undo"
            disabled={!state.undo.length}
            className="grid h-[34px] w-[34px] place-items-center rounded-l-md border border-border bg-surface-card text-text-secondary hover:bg-surface-hover disabled:opacity-40"
          >
            <Icon name="undo-2" size={16} />
          </button>
          <button
            onClick={() => dispatch({ t: 'redo' })}
            aria-label="Redo"
            disabled={!state.redo.length}
            className="grid h-[34px] w-[34px] place-items-center rounded-r-md border border-l-0 border-border bg-surface-card text-text-secondary hover:bg-surface-hover disabled:opacity-40"
          >
            <Icon name="redo-2" size={16} />
          </button>
        </div>
        <div className="inline-flex flex-none gap-[3px] rounded-md border border-border-subtle bg-surface-sunken p-[3px]">
          {(['edit', 'preview'] as const).map((m) => {
            const active = state.mode === m;
            return (
              <button
                key={m}
                onClick={() => dispatch({ t: 'setMode', mode: m })}
                className="rounded-sm px-[13px] py-1.5 text-[12.5px] font-semibold capitalize"
                style={{
                  background: active ? 'var(--surface-card)' : 'transparent',
                  boxShadow: active ? 'var(--shadow-xs)' : 'none',
                  color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                }}
              >
                {m}
              </button>
            );
          })}
        </div>
        <Button size="sm" leadingIcon="rocket" onClick={doPublish} loading={publishPending}>
          Publish
        </Button>
      </div>

      {state.mode === 'preview' ? (
        <PreviewMode state={state} />
      ) : (
        <>
          {/* Palette */}
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-border-subtle bg-surface-sunken p-[11px_14px]">
            <span className="mr-0.5 font-mono text-[10.5px] uppercase tracking-wider text-text-tertiary">
              Add field
            </span>
            {PALETTE.map((p) => (
              <button
                key={p.type}
                onClick={() => dispatch({ t: 'add', fieldType: p.type })}
                className="inline-flex items-center gap-1.5 rounded-pill border border-border bg-surface-card px-[11px] py-1.5 text-[12.5px] font-medium hover:bg-surface-hover"
              >
                <Icon name={p.icon} size={14} className="text-text-tertiary" />
                {p.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 items-start gap-[18px] lg:grid-cols-[minmax(0,1.7fr)_minmax(238px,1fr)]">
            {/* Canvas */}
            <div className="flex flex-col gap-2.5">
              <button
                onClick={() => dispatch({ t: 'select', id: CONTAINER_ID })}
                className="flex items-center gap-2.5 rounded-md border-[1.5px] border-dashed bg-surface-sunken p-[11px_15px] text-left"
                style={{ borderColor: containerSelected ? 'var(--border-accent)' : 'var(--border-strong)' }}
              >
                <Icon name="layout-panel-top" size={15} className="text-text-tertiary" />
                <span className="font-ui text-[12.5px] font-semibold text-text-secondary">Form container</span>
                <span className="flex-1" />
                <span className="text-[11.5px] text-text-tertiary">Size, border &amp; shading</span>
              </button>

              <div className="grid grid-cols-12 items-start gap-2.5">
                {state.fields.map((f) => (
                  <FieldCard
                    key={f.id}
                    field={f}
                    selected={f.id === state.selectedId}
                    onSelect={() => dispatch({ t: 'select', id: f.id })}
                    onUp={() => dispatch({ t: 'move', id: f.id, dir: -1 })}
                    onDown={() => dispatch({ t: 'move', id: f.id, dir: 1 })}
                    onDup={() => dispatch({ t: 'duplicate', id: f.id })}
                    onDel={() => dispatch({ t: 'delete', id: f.id })}
                  />
                ))}
                <div className="col-span-12 flex items-center justify-center gap-2 rounded-md border-[1.5px] border-dashed border-border p-3.5 text-[12.5px] text-text-tertiary">
                  {state.fields.length === 0 ? (
                    <>Blank form — add your first field from the palette above.</>
                  ) : (
                    <>
                      Press <span className="kbd">{MOD_LABEL}</span>
                      <span className="kbd">Enter</span> to add · <span className="kbd">↑</span>
                      <span className="kbd">↓</span> select · <span className="kbd">{ALT_LABEL}</span>
                      <span className="kbd">↑↓</span> reorder
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Config panel */}
            <div className="sticky top-4">
              <ConfigPanel
                state={state}
                field={selectedField}
                containerSelected={containerSelected}
                dispatch={dispatch}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function FieldCard({
  field,
  selected,
  onSelect,
  onUp,
  onDown,
  onDup,
  onDel,
}: {
  field: FormField;
  selected: boolean;
  onSelect: () => void;
  onUp: () => void;
  onDown: () => void;
  onDup: () => void;
  onDel: () => void;
}) {
  const meta = FIELD_META[field.type] ?? { icon: 'help-circle', label: field.type };
  const span = field.type === 'section_header' ? 12 : (field.colSpan ?? 12);
  const widthTag =
    span === 12 ? null : span === 6 ? 'Half' : span === 4 ? 'Third' : span === 3 ? 'Quarter' : `${span}/12`;

  return (
    <div
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      role="button"
      tabIndex={0}
      className="min-w-0 overflow-hidden rounded-md border bg-surface-card p-[13px_15px]"
      style={{
        gridColumn: `span ${span} / span ${span}`,
        borderColor: selected ? 'var(--border-accent)' : 'var(--border-default)',
        boxShadow: selected ? 'var(--shadow-sm)' : 'none',
      }}
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <Icon name="grip-vertical" size={15} className="flex-none text-text-disabled" />
          <Icon name={meta.icon} size={15} className="flex-none text-text-tertiary" />
          <span className="min-w-0 flex-1 truncate font-ui text-[13.5px] font-semibold text-text-primary">
            {field.label}
            {field.required && <span className="ml-px text-danger">*</span>}
          </span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {widthTag && (
            <span className="flex-none rounded-pill border border-border-subtle bg-surface-sunken px-2 py-[3px] font-mono text-[10.5px] text-text-tertiary">
              {widthTag}
            </span>
          )}
          <Badge variant={field.source === 'imported' ? 'info' : 'accent'}>
            {field.source === 'imported' ? 'Imported' : 'Built'}
          </Badge>
          <span className="min-w-1 flex-1" />
          {selected && (
            <span className="flex flex-none">
              {[
                { icon: 'arrow-up', label: 'Move up', on: onUp, cls: 'text-text-secondary' },
                { icon: 'arrow-down', label: 'Move down', on: onDown, cls: 'text-text-secondary' },
                { icon: 'copy', label: 'Duplicate', on: onDup, cls: 'text-text-secondary' },
                { icon: 'trash-2', label: 'Delete', on: onDel, cls: 'text-danger' },
              ].map((b) => (
                <button
                  key={b.label}
                  aria-label={b.label}
                  onClick={(e) => {
                    e.stopPropagation();
                    b.on();
                  }}
                  className={`grid h-[26px] w-[26px] place-items-center rounded-sm hover:bg-surface-hover ${b.cls}`}
                >
                  <Icon name={b.icon} size={13} />
                </button>
              ))}
            </span>
          )}
        </div>
      </div>
      <CardPreview field={field} />
      {field.help && <div className="mt-2 text-xs text-text-tertiary">{field.help}</div>}
    </div>
  );
}

/** Compact, non-interactive per-type affordance shown inside a canvas card. */
function CardPreview({ field }: { field: FormField }) {
  const box = 'mt-2.5 flex h-9 items-center gap-2 rounded-sm border border-border bg-surface-sunken px-3 text-[13px] text-text-tertiary';
  switch (field.type) {
    case 'section_header':
      return null;
    case 'dropdown':
      return (
        <div className={box}>
          <span className="flex-1">Select an option…</span>
          <Icon name="chevron-down" size={15} />
        </div>
      );
    case 'radio':
    case 'checkbox':
      return (
        <div className="mt-2.5 flex flex-col gap-2">
          {(field.options ?? ['Option 1', 'Option 2']).map((o) => (
            <div key={o} className="flex items-center gap-2 text-[13px] text-text-secondary">
              <span
                className="h-[15px] w-[15px] flex-none border-[1.5px] border-border-strong"
                style={{ borderRadius: field.type === 'radio' ? '50%' : '4px' }}
              />
              {o}
            </div>
          ))}
        </div>
      );
    case 'signature':
      return (
        <div className="mt-2.5 flex h-[52px] items-center justify-center gap-1.5 rounded-sm border-[1.5px] border-dashed border-border-strong bg-surface-sunken text-[12.5px] text-text-tertiary">
          <Icon name="pen-tool" size={15} />
          Sign here
        </div>
      );
    case 'file_upload':
      return (
        <div className={box}>
          <Icon name="paperclip" size={15} />
          <span className="flex-1">Attach a file…</span>
        </div>
      );
    case 'date':
      return (
        <div className={box}>
          <Icon name="calendar" size={15} />
          <span className="flex-1">dd / mm / yyyy</span>
        </div>
      );
    default:
      return <div className={box} />;
  }
}

function ConfigPanel({
  state,
  field,
  containerSelected,
  dispatch,
}: {
  state: BuilderState;
  field: FormField | null;
  containerSelected: boolean;
  dispatch: React.Dispatch<Parameters<typeof builderReducer>[1]>;
}) {
  if (containerSelected) {
    return (
      <div className="overflow-hidden rounded-lg border border-border bg-surface-card shadow-sm">
        <div className="flex items-center gap-2.5 border-b border-border-subtle bg-surface-sunken p-[14px_16px]">
          <Icon name="layout-panel-top" size={16} className="text-accent" />
          <span className="font-heading text-[13.5px] font-bold">Form container</span>
        </div>
        <div className="flex flex-col gap-4 p-4">
          <Slider
            label="Max width"
            value={state.container.maxWidth}
            min={420}
            max={960}
            step={10}
            unit="px"
            onChange={(v) => dispatch({ t: 'setContainer', patch: { maxWidth: v } })}
          />
          <Slider
            label="Padding"
            value={state.container.padding}
            min={0}
            max={48}
            step={2}
            unit="px"
            onChange={(v) => dispatch({ t: 'setContainer', patch: { padding: v } })}
          />
          <Slider
            label="Corner radius"
            value={state.container.radius}
            min={0}
            max={28}
            step={1}
            unit="px"
            onChange={(v) => dispatch({ t: 'setContainer', patch: { radius: v } })}
          />
        </div>
      </div>
    );
  }

  if (!field) {
    return (
      <div className="rounded-lg border border-border bg-surface-card p-6 text-center text-[13px] text-text-tertiary shadow-sm">
        Select a field to configure it, or add one from the palette.
      </div>
    );
  }

  const meta = FIELD_META[field.type] ?? { icon: 'help-circle', label: field.type };
  const isSection = field.type === 'section_header';
  const isChoice = field.type === 'dropdown' || field.type === 'radio';
  const hasPlaceholder = field.type === 'text' || field.type === 'number' || field.type === 'textarea';

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface-card shadow-sm">
      <div className="flex items-center gap-2.5 border-b border-border-subtle bg-surface-sunken p-[14px_16px]">
        <Icon name={meta.icon} size={16} className="text-accent" />
        <span className="font-heading text-[13.5px] font-bold">{meta.label}</span>
      </div>
      {/* Tabs */}
      <div className="flex gap-[3px] p-[10px_16px_0]">
        {(['field', 'layout'] as const).map((t) => {
          const active = state.panelTab === t;
          return (
            <button
              key={t}
              onClick={() => dispatch({ t: 'setPanelTab', tab: t })}
              className="rounded-sm px-3 py-1.5 text-xs font-semibold capitalize"
              style={{
                background: active ? 'var(--surface-sunken)' : 'transparent',
                color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
              }}
            >
              {t}
            </button>
          );
        })}
      </div>

      {state.panelTab === 'field' ? (
        <div className="flex flex-col gap-3.5 p-4">
          <Input
            label="Label"
            value={field.label}
            onChange={(e) => dispatch({ t: 'update', id: field.id, patch: { label: e.target.value } })}
          />
          {!isSection && (
            <Input
              label="Help text"
              placeholder="Optional guidance"
              value={field.help ?? ''}
              onChange={(e) => dispatch({ t: 'update', id: field.id, patch: { help: e.target.value } })}
            />
          )}
          {hasPlaceholder && (
            <Input
              label="Placeholder"
              value={field.placeholder ?? ''}
              onChange={(e) => dispatch({ t: 'update', id: field.id, patch: { placeholder: e.target.value } })}
            />
          )}
          {isChoice && (
            <div>
              <div className="mb-2 text-[13px] font-semibold">Options</div>
              <div className="flex flex-col gap-1.5">
                {(field.options ?? []).map((o, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <input
                      value={o}
                      onChange={(e) => dispatch({ t: 'setOption', id: field.id, index: i, value: e.target.value })}
                      className="h-8 min-w-0 flex-1 rounded-sm border border-border px-2.5 font-ui text-[12.5px] text-text-primary focus:outline-none focus-visible:border-border-accent focus-visible:shadow-focus"
                    />
                    <button
                      onClick={() => dispatch({ t: 'removeOption', id: field.id, index: i })}
                      aria-label="Remove option"
                      className="grid h-[30px] w-[30px] flex-none place-items-center rounded-sm border border-border text-text-tertiary hover:bg-surface-hover"
                    >
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <button
                onClick={() => dispatch({ t: 'addOption', id: field.id })}
                className="mt-2 inline-flex items-center gap-1.5 rounded-sm border border-dashed border-border-strong px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-hover"
              >
                <Icon name="plus" size={13} />
                Add option
              </button>
            </div>
          )}
          {!isSection && (
            <>
              <Select
                label="Validation"
                options={VALIDATION_OPTIONS}
                value={field.validation?.kind ?? 'none'}
                onChange={(e) =>
                  dispatch({
                    t: 'update',
                    id: field.id,
                    patch: { validation: { kind: e.target.value as 'none' } },
                  })
                }
              />
              <div className="flex items-center justify-between gap-2.5 rounded-md border border-border-subtle bg-surface-sunken p-[11px_12px]">
                <div>
                  <div className="text-[13px] font-semibold">Required</div>
                  <div className="text-[11.5px] text-text-tertiary">Must be answered to submit</div>
                </div>
                <Switch
                  checked={field.required}
                  onChange={(e) => dispatch({ t: 'update', id: field.id, patch: { required: e.target.checked } })}
                />
              </div>
            </>
          )}
          <Select
            label="Field type"
            options={TYPE_OPTIONS}
            value={field.type}
            onChange={(e) => dispatch({ t: 'changeType', id: field.id, fieldType: e.target.value as FormFieldType })}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-4 p-4">
          {isSection ? (
            <div className="text-[12.5px] text-text-tertiary">Sections always span the full row.</div>
          ) : (
            <div>
              <div className="mb-2 text-[13px] font-semibold">Column width</div>
              <div className="grid grid-cols-2 gap-2">
                {COL_OPTIONS.map((c) => {
                  const active = (field.colSpan ?? 12) === c.span;
                  return (
                    <button
                      key={c.span}
                      onClick={() => dispatch({ t: 'update', id: field.id, patch: { colSpan: c.span } })}
                      className="flex items-center gap-1.5 rounded-md border-[1.5px] px-2.5 py-2.5 text-[12.5px] font-semibold"
                      style={{
                        borderColor: active ? 'var(--border-accent)' : 'var(--border-default)',
                        background: active ? 'var(--surface-accent-soft)' : 'var(--surface-card)',
                        color: active ? 'var(--text-accent)' : 'var(--text-primary)',
                      }}
                    >
                      <Icon name={c.icon} size={15} />
                      {c.label}
                    </button>
                  );
                })}
              </div>
              <div className="mt-2 text-[11.5px] text-text-tertiary">
                Place fields side by side by giving each a partial width.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="mb-1.5 flex justify-between">
        <span className="text-[13px] font-semibold">{label}</span>
        <span className="font-mono text-[11.5px] text-text-tertiary">
          {value}
          {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[var(--accent)]"
      />
    </div>
  );
}

function PreviewMode({ state }: { state: BuilderState }) {
  return (
    <div className="flex justify-center">
      <div
        className="w-full rounded-xl border border-border bg-surface-card shadow-lg"
        style={{
          maxWidth: state.container.maxWidth,
          padding: state.container.padding,
          borderRadius: state.container.radius,
        }}
      >
        <h3 className="mb-1 text-xl font-bold">{state.name}</h3>
        <p className="mb-6 text-[13px] text-text-tertiary">Fields marked * are required.</p>
        <div className="flex flex-col gap-[18px]">
          {state.fields.map((f) => (
            <FieldInput key={f.id} field={f} value={null} onChange={() => {}} />
          ))}
        </div>
        <div className="mt-7 flex justify-end">
          <Button>Submit</Button>
        </div>
      </div>
    </div>
  );
}
