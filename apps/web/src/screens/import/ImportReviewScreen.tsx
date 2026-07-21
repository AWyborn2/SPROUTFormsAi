import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Icon, Select, Switch, type BadgeVariant } from '@formai/ui';
import type { ExtractedField, ExtractionStatus } from '@formai/shared';
import { FORM_FIELD_TYPES } from '@formai/shared';
import {
  addFixedRowItem,
  canRedoFieldEdit,
  canUndoFieldEdit,
  isChecklistTable,
  lowestUnresolvedField,
  removeFixedRowItem,
  renameFixedRowItem,
  retryExtraction,
  redoFieldEdit,
  reviewStatus,
  setFieldRequired,
  undoFieldEdit,
  useImportSession,
  type ReviewField,
} from '../../lib/data/import-session.js';
import { FIELD_META } from '../../lib/field-editor/reducer.js';
import { FieldInspector } from './inspector/FieldInspector.js';
import { stripFileExtension } from './upload-validation.js';
import { ImportStepper } from './ImportStepper.js';
import { PdfViewer } from './PdfViewer.js';

const CONF = {
  ok: { color: 'var(--success)', text: 'var(--success-text)', bg: 'var(--success-soft)', label: 'High' },
  review: { color: 'var(--warning)', text: 'var(--warning-text)', bg: 'var(--warning-soft)', label: 'Review' },
  low: { color: 'var(--danger)', text: 'var(--danger-text)', bg: 'var(--danger-soft)', label: 'Low' },
} as const;

function statusBadge(status: ExtractionStatus) {
  const map: Record<ExtractionStatus, { variant: BadgeVariant; label: string }> = {
    ok: { variant: 'success', label: 'Confirmed' },
    review: { variant: 'warning', label: 'Review' },
    low: { variant: 'danger', label: 'Low conf.' },
  };
  const b = map[status];
  return <Badge variant={b.variant}>{b.label}</Badge>;
}

const TYPE_OPTIONS = FORM_FIELD_TYPES.map((t) => ({ label: FIELD_META[t]?.label ?? t, value: t }));

/** Document title for the source-preview header — the file name minus its extension. */
export function displayTitleFromFileName(fileName: string): string {
  return stripFileExtension(fileName) || 'Imported document';
}

/** Import step 2 — review the extracted fields, correct low-confidence ones. */
export function ImportReviewScreen() {
  const navigate = useNavigate();
  const session = useImportSession();
  const scanning = session.status === 'uploading' || session.status === 'extracting';
  const ready = session.status === 'ready';
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const fieldListRef = useRef<HTMLDivElement>(null);

  // Guard direct navigation — with no import in flight there is nothing to review.
  useEffect(() => {
    if (session.status === 'idle') navigate('/app/import', { replace: true });
  }, [session.status, navigate]);

  if (session.status === 'idle') return null;

  // Weakest still-unconfirmed extraction (hidden once everything is resolved).
  const lowest = lowestUnresolvedField(session.fields);

  // Build highlight data for the PDF viewer
  const highlights = session.fields
    .filter((f) => f.sourcePosition != null)
    .map((f) => ({
      id: f.id,
      position: f.sourcePosition!,
      status: reviewStatus(f),
    }));

  // When a field is selected from either pane, sync both:
  //   → scroll its row into view in the field list
  //   → scroll the PDF pane to its page so the overlay is visible
  const handleSelectField = (id: string) => {
    setSelectedFieldId(id);
    // 1. Scroll field row into view
    const rowEl = document.getElementById(`review-row-${id}`);
    if (rowEl) {
      rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    // 2. Scroll PDF to the page containing this field
    const field = session.fields.find((f) => f.id === id);
    if (field?.sourcePosition) {
      const pageEl = document.getElementById(`pdf-page-${field.sourcePosition.page}`);
      if (pageEl) {
        pageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  };

  // The inspector binds to the SAME selection the PDF pane uses. A deleted (or
  // never-chosen) selection simply yields `undefined` here, which is what puts
  // the panel into its persistent prompt state rather than collapsing it.
  const selectedIndex = session.fields.findIndex((f) => f.id === selectedFieldId);
  const selectedField = selectedIndex < 0 ? undefined : session.fields[selectedIndex];

  const handleInspectorSelect = (id: string | null) => {
    if (id === null) setSelectedFieldId(null);
    else handleSelectField(id);
  };

  if (session.status === 'error') {
    return (
      <div className="fai-rise p-[30px_28px_60px]">
        <ImportStepper currentStep={1} />
        <div className="mx-auto max-w-[520px] rounded-md border border-border bg-surface-card p-[26px_24px] text-center shadow-xs">
          <span className="mx-auto mb-3.5 grid h-11 w-11 place-items-center rounded-full bg-danger-soft">
            <Icon name="alert-triangle" size={22} className="text-danger-text" />
          </span>
          <div className="mb-1.5 font-heading text-[17px] font-bold">Import failed</div>
          <p className="mb-5 text-[13.5px] text-text-secondary">
            {session.error ?? 'Something went wrong importing this PDF. Please try again.'}
          </p>
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={() => navigate('/app/import')}
              className="inline-flex items-center gap-1 text-[13.5px] text-text-tertiary"
            >
              <Icon name="arrow-left" size={14} />
              Back to upload
            </button>
            <Button leadingIcon="rotate-ccw" onClick={() => void retryExtraction()}>
              Retry
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fai-rise p-[30px_28px_60px]">
      <ImportStepper currentStep={1} />

      <div className="mx-auto grid max-w-[1160px] grid-cols-1 items-start gap-5 lg:grid-cols-2">
        {/* PDF preview with confidence overlays */}
        <div className="lg:flex lg:h-[calc(100vh-220px)] lg:min-h-0 lg:flex-col lg:pr-1">
          <div className="mb-2 flex-none border-b border-border pb-2 pt-1">
            <div className="font-heading text-[15px] font-bold text-text-primary">
              {displayTitleFromFileName(session.fileName)}
            </div>
            <div className="text-[12px] text-text-tertiary">
              {session.pageCount > 0 ? `${session.pageCount} page${session.pageCount > 1 ? 's' : ''}` : ''}
            </div>
          </div>

          <div className="relative flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-white shadow-md lg:flex-1">
            <div className="h-[5px] flex-none bg-brand-slate" />
            <div className="flex min-h-0 flex-1 flex-col p-[14px_14px_16px]">
              <PdfViewer
                pdfBase64={session.pdfBase64 ?? undefined}
                assetId={session.assetId}
                highlights={highlights}
                selectedFieldId={selectedFieldId}
                onSelectField={handleSelectField}
                className="max-h-[70vh] lg:max-h-none lg:flex-1"
              />
            </div>
            {scanning && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3.5 bg-[rgba(37,52,57,0.82)]">
                <span
                  className="h-[34px] w-[34px] rounded-full border-[3px] border-white/25 border-r-[#8fd6ad]"
                  style={{ animation: 'faiSpin .7s linear infinite' }}
                />
                <div className="font-ui text-[13px] font-semibold text-white">
                  {session.status === 'uploading'
                    ? 'Reading your PDF…'
                    : 'Detecting fields, types & structure'}
                </div>
                <div className="text-[11.5px] text-white/60">This usually takes a few seconds</div>
              </div>
            )}
          </div>
        </div>

        {/* Extracted field list */}
        <div className="lg:h-[calc(100vh-220px)] lg:overflow-y-auto lg:pr-1">
          {session.designNotes.length > 0 && (
            <div className="mb-3.5 rounded-md border border-border bg-info-soft p-[12px_14px]">
              <div className="mb-1.5 flex items-center gap-2 text-[12.5px] font-semibold text-info-text">
                <Icon name="sparkles" size={15} className="flex-none" />
                Notes from extraction
              </div>
              <ul className="flex flex-col gap-1 pl-[22px]">
                {session.designNotes.map((note, i) => (
                  <li key={i} className="list-disc text-[12.5px] leading-snug text-text-secondary">
                    {note}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {ready ? (
            <>
              <div className="mb-3.5 flex items-center gap-3.5 rounded-md border border-border bg-surface-card p-[14px_16px]">
                <div className="min-w-0 flex-1">
                  <div className="font-heading text-[15px] font-bold">{session.total} fields extracted</div>
                  <div className="text-[12.5px] text-text-tertiary">
                    Average confidence {Math.round(session.avgConfidence * 100)}%
                  </div>
                  {lowest && (
                    <button
                      onClick={() => handleSelectField(lowest.id)}
                      title="Jump to the weakest unconfirmed extraction"
                      className="mt-0.5 flex max-w-full items-center gap-1 text-[12.5px] text-text-tertiary hover:text-text-secondary"
                    >
                      <Icon name="arrow-down-right" size={13} className="flex-none" />
                      <span className="truncate">
                        Lowest: {lowest.label} · {Math.round(lowest.confidence * 100)}%
                      </span>
                    </button>
                  )}
                </div>
                <div
                  className="flex items-center gap-[7px] rounded-pill px-[11px] py-1.5"
                  style={{ background: session.needReview ? 'var(--warning-soft)' : 'var(--success-soft)' }}
                >
                  <Icon
                    name={session.needReview ? 'alert-triangle' : 'check-circle-2'}
                    size={15}
                    className={session.needReview ? 'text-warning-text' : 'text-success-text'}
                  />
                  <span
                    className="text-[12.5px] font-semibold"
                    style={{ color: session.needReview ? 'var(--warning-text)' : 'var(--success-text)' }}
                  >
                    {session.needReview ? `${session.needReview} need review` : 'All confirmed'}
                  </span>
                </div>
              </div>

              {/* Editing surface — sits beside the triage rows, never replaces
                  them. Sticky so it stays reachable while the list scrolls. */}
              <div className="sticky top-0 z-10 mb-3.5">
                <div className="mb-1.5 flex items-center justify-end gap-1.5">
                  <button
                    onClick={() => undoFieldEdit()}
                    disabled={!canUndoFieldEdit()}
                    aria-label="Undo"
                    className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface-card px-2 py-1 text-[11.5px] font-semibold text-text-secondary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Icon name="undo-2" size={13} />
                    Undo
                  </button>
                  <button
                    onClick={() => redoFieldEdit()}
                    disabled={!canRedoFieldEdit()}
                    aria-label="Redo"
                    className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface-card px-2 py-1 text-[11.5px] font-semibold text-text-secondary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Icon name="redo-2" size={13} />
                    Redo
                  </button>
                </div>
                <FieldInspector
                  field={selectedField}
                  index={selectedIndex}
                  count={session.fields.length}
                  onSelect={handleInspectorSelect}
                />
              </div>

              <div ref={fieldListRef} className="flex flex-col gap-2.5">
                {session.fields.map((f) => (
                  <ReviewRow
                    key={f.id}
                    id={`review-row-${f.id}`}
                    field={f}
                    selected={f.id === selectedFieldId}
                    onSelect={() => handleSelectField(f.id)}
                    onRemapSignature={() => session.remapSignature(f.id)}
                    onSetType={(type) => session.setType(f.id, type)}
                    onConfirmTable={() => session.confirmTable(f.id)}
                  />
                ))}
              </div>
            </>
          ) : (
            <div className="mb-3.5 rounded-md border border-border bg-surface-card p-[14px_16px]">
              <div className="font-heading text-[15px] font-bold">Extracting fields…</div>
              <div className="text-[12.5px] text-text-tertiary">
                Detected fields will appear here once your PDF has been read.
              </div>
            </div>
          )}

          <div className="mt-[18px] flex items-center justify-between">
            <button
              onClick={() => navigate('/app/import')}
              className="inline-flex items-center gap-1 text-[13.5px] text-text-tertiary"
            >
              <Icon name="arrow-left" size={14} />
              Upload
            </button>
            <Button
              trailingIcon="arrow-right"
              disabled={!ready}
              onClick={() => navigate('/app/import/publish')}
            >
              Continue
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReviewRow({
  id,
  field,
  selected,
  onSelect,
  onRemapSignature,
  onSetType,
  onConfirmTable,
}: {
  id: string;
  field: ReviewField;
  selected: boolean;
  onSelect: () => void;
  onRemapSignature: () => void;
  onSetType: (type: ExtractedField['type']) => void;
  onConfirmTable: () => void;
}) {
  const st = reviewStatus(field);
  const c = CONF[st];
  const meta = FIELD_META[field.type] ?? { icon: 'help-circle', label: field.type };
  const isLow = st === 'low';
  const isReview = st === 'review' && field.type === 'repeating_group';
  const hasPosition = field.sourcePosition != null;
  const fixedRows = field.type === 'repeating_group' ? (field.fixedRows ?? []) : [];
  const isChecklist = isChecklistTable(field);
  const [newItem, setNewItem] = useState('');

  const submitNewItem = () => {
    const label = newItem.trim();
    if (!label) return;
    addFixedRowItem(field.id, label);
    setNewItem('');
  };

  return (
    <div
      id={id}
      className={`cursor-pointer rounded-md border bg-surface-card p-[13px_15px] shadow-xs transition-all ${
        selected ? 'ring-2 ring-offset-1' : ''
      }`}
      style={{
        borderColor: c.color,
        ...(selected ? { ringColor: c.color, boxShadow: `0 0 0 2px ${c.color}33` } : {}),
      }}
      onClick={onSelect}
    >
      <div className="flex items-center gap-[11px]">
        <span className="grid h-8 w-8 flex-none place-items-center rounded-lg bg-surface-sunken">
          <Icon name={meta.icon} size={16} className="text-text-secondary" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold">{field.label}</div>
          <div className="text-[11.5px] text-text-tertiary">{meta.label}</div>
        </div>
        <div className="w-[112px] flex-none">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-mono text-[11px] font-semibold" style={{ color: c.text }}>
              {Math.round(field.confidence * 100)}%
            </span>
            <span
              className="rounded-[3px] px-[5px] py-px font-mono text-[9.5px]"
              style={{ color: c.text, background: c.bg }}
            >
              {c.label}
            </span>
          </div>
          <div className="h-[5px] overflow-hidden rounded-pill bg-surface-sunken">
            <div
              className="h-full rounded-pill"
              style={{ width: `${Math.round(field.confidence * 100)}%`, background: c.color }}
            />
          </div>
        </div>
        <span className="flex w-[88px] flex-none justify-end">{statusBadge(st)}</span>
        {hasPosition && (
          <span className="flex-none text-[10px] text-text-tertiary" title="Located on PDF">
            <Icon name="map-pin" size={12} />
          </span>
        )}
      </div>

      {isLow && (
        <div className="mt-[11px] rounded-md bg-danger-soft p-[11px_12px]">
          <div className="mb-2.5 flex gap-2 text-[12.5px] text-danger-text">
            <Icon name="alert-triangle" size={15} className="mt-px flex-none" />
            <span>{field.note}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              onClick={(e) => { e.stopPropagation(); onRemapSignature(); }}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-[#12321f]"
            >
              <Icon name="pen-tool" size={14} />
              Remap to Signature
            </button>
            <span className="text-xs text-text-tertiary">or</span>
            <div className="w-[160px]">
              <Select
                options={TYPE_OPTIONS}
                value={field.type}
                onChange={(e) => onSetType(e.target.value as ExtractedField['type'])}
                aria-label="Correct field type"
              />
            </div>
          </div>
        </div>
      )}

      {isReview && (
        <div className="mt-[11px] rounded-md bg-warning-soft p-[11px_12px]">
          <div className="mb-2.5 flex gap-2 text-[12.5px] text-warning-text">
            <Icon name="table" size={15} className="mt-px flex-none" />
            <span>{field.note}</span>
          </div>
          <div className="mb-[11px] flex flex-wrap gap-1.5">
            {(field.columns ?? []).map((col) => (
              <span
                key={col.key}
                className="rounded-sm border border-border bg-surface-card px-[9px] py-[3px] font-mono text-[11px]"
              >
                {col.label}
              </span>
            ))}
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); onConfirmTable(); }}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-slate px-3 py-1.5 text-[12.5px] font-semibold text-white"
          >
            <Icon name="check" size={14} />
            Keep as repeating table
          </button>
        </div>
      )}

      {isChecklist && (
        /* Captured checklist items — the only correction valve before publish
           (builder-side fixedRows editing is deferred). */
        <div
          className="mt-[11px] rounded-md border border-border-subtle bg-surface-sunken p-[11px_12px]"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-2 flex items-center gap-2">
            <span className="rounded-pill border border-border bg-surface-card px-2 py-0.5 font-mono text-[11px] font-semibold text-text-secondary">
              {fixedRows.length} item{fixedRows.length === 1 ? '' : 's'}
            </span>
            <span className="text-[11.5px] text-text-tertiary">
              Fixed checklist items — fillers answer each one
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            {fixedRows.map((label, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <input
                  value={label}
                  onChange={(e) => renameFixedRowItem(field.id, i, e.target.value)}
                  aria-label={`Checklist item ${i + 1}`}
                  className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-surface-card px-2 text-[12.5px] text-text-primary focus-visible:shadow-focus"
                />
                <button
                  onClick={() => removeFixedRowItem(field.id, i)}
                  aria-label={`Remove checklist item ${i + 1}`}
                  className="grid h-7 w-7 flex-none place-items-center rounded-sm border border-border text-text-tertiary hover:bg-surface-hover hover:text-danger-text"
                >
                  <Icon name="x" size={13} />
                </button>
              </div>
            ))}
            <div className="mt-0.5 flex items-center gap-1.5">
              <input
                value={newItem}
                onChange={(e) => setNewItem(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitNewItem();
                }}
                placeholder="Add a missed item…"
                aria-label={`Add checklist item to ${field.label}`}
                className="h-7 min-w-0 flex-1 rounded-sm border border-dashed border-border-strong bg-transparent px-2 text-[12.5px] text-text-primary focus-visible:shadow-focus"
              />
              <button
                onClick={submitNewItem}
                disabled={!newItem.trim()}
                className="inline-flex h-7 flex-none items-center gap-1 rounded-sm border border-border px-2 text-[12px] font-semibold text-text-secondary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Icon name="plus" size={13} />
                Add
              </button>
            </div>
          </div>
        </div>
      )}

      {field.type !== 'section_header' && (
        /* Local mirror of the builder's Required switch pattern (R4). */
        <div
          className="mt-[11px] flex items-center justify-between gap-2.5 rounded-md border border-border-subtle bg-surface-sunken p-[9px_12px]"
          onClick={(e) => e.stopPropagation()}
        >
          <div>
            <div className="text-[12.5px] font-semibold">Required</div>
            <div className="text-[11px] text-text-tertiary">
              {isChecklist ? 'Checklists default to required' : 'Must be answered to submit'}
            </div>
          </div>
          <Switch
            checked={field.required ?? isChecklist}
            onChange={(e) => setFieldRequired(field.id, e.target.checked)}
            aria-label={`Required: ${field.label}`}
          />
        </div>
      )}
    </div>
  );
}
