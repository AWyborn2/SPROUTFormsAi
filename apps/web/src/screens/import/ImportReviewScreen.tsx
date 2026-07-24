import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Icon, Select, Switch, type BadgeVariant } from '@formai/ui';
import type { ExtractedField, ExtractionStatus } from '@formai/shared';
import {
  addFixedRowItem,
  canRedoFieldEdit,
  canUndoFieldEdit,
  confirmField,
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
import { FIELD_META, typeOptionsFor } from '../../lib/field-editor/reducer.js';
import type { TextPage } from '../../lib/pdf-geometry.js';
import {
  adjustGeometryBand,
  adjustGeometryBoundary,
  geometryProposal,
  proposeGeometry,
} from '../../lib/data/import-session.js';
import { snapTargets, snapTargetsY } from './inspector/geometry-actions.js';
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

/** Document title for the source-preview header — the file name minus its extension. */
export function displayTitleFromFileName(fileName: string): string {
  return stripFileExtension(fileName) || 'Imported document';
}

/**
 * Whether the flagged-field card offers the "Remap to Signature" shortcut (R2).
 * It is the correction for a text field the model should have typed as a
 * signature, so it is meaningful only for a `text` field; on a repeating table
 * or any other type it is nonsensical and the card hides it, leaving the type
 * dropdown for genuine corrections.
 */
export function offersSignatureRemap(field: Pick<ReviewField, 'type'>): boolean {
  return field.type === 'text';
}

/** Import step 2 — review the extracted fields, correct low-confidence ones. */
export function ImportReviewScreen() {
  const navigate = useNavigate();
  const session = useImportSession();
  const scanning = session.status === 'uploading' || session.status === 'extracting';
  const ready = session.status === 'ready';
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  // The PDF text layer, read once by the viewer and reused by every row that
  // needs to derive a grid. Held here rather than in the session because it is
  // a cache of the source document, not review state.
  const [textPages, setTextPages] = useState<readonly TextPage[]>([]);
  // Draw mode is armed per selected field (KTD5). Held here — the one owner of
  // "current field" — and threaded to the PDF overlay (which rubber-bands) and
  // the geometry panel (which toggles it). A drawn box lands as an UNCONFIRMED
  // proposal via the existing `proposeGeometry` path; the reviewer then confirms.
  const [drawArmed, setDrawArmed] = useState(false);

  const bandOverlay = selectedFieldId ? (geometryProposal(selectedFieldId) ?? null) : null;
  /**
   * Where a dragged band edge may land, from the overlay page's own text (U10).
   * Derived here rather than in the viewer because the screen already holds the
   * text layer, and the viewer stays a presentational surface that reports a
   * coordinate rather than deciding what a legal one is.
   */
  const bandSnapTargets = useMemo(
    () => (bandOverlay ? snapTargets(textPages[bandOverlay.page]?.items ?? []) : []),
    [bandOverlay?.page, textPages],
  );
  // The vertical counterpart, for a dragged ROW edge (U3): the printed baselines
  // on the overlay page. Same reasoning as `bandSnapTargets` — the screen holds
  // the text layer, the viewer only reports a coordinate.
  const bandSnapTargetsY = useMemo(
    () => (bandOverlay ? snapTargetsY(textPages[bandOverlay.page]?.items ?? []) : []),
    [bandOverlay?.page, textPages],
  );
  const fieldListRef = useRef<HTMLDivElement>(null);

  // Guard direct navigation — with no import in flight there is nothing to review.
  useEffect(() => {
    if (session.status === 'idle') navigate('/app/import', { replace: true });
  }, [session.status, navigate]);

  /*
    Both scrolls run AFTER the accordion commits, not inline in the click
    handler. Expanding a row changes its height, so scrolling against the
    collapsed geometry lands short — the row grows out from under the scroll
    that was meant to reveal it.

    Selection identity is the only trigger. Re-running on every session
    mutation would yank the list back while the reviewer is typing a label in
    the expanded editor.
  */
  useEffect(() => {
    if (!selectedFieldId) return;
    document
      .getElementById(`review-row-${selectedFieldId}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    const field = session.fields.find((f) => f.id === selectedFieldId);
    if (field?.sourcePosition) {
      document
        .getElementById(`pdf-page-${field.sourcePosition.page}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFieldId]);

  // Disarm draw mode whenever the selected field changes — an armed gesture
  // belongs to the field it was armed on, never the next one opened.
  useEffect(() => {
    setDrawArmed(false);
  }, [selectedFieldId]);

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

  /*
    Selected IS expanded. The screen already had exactly one notion of "current
    field", shared with the PDF pane, so the accordion rides on it rather than
    adding a second piece of state: clicking a highlight expands its row, and
    collapsing deselects. Re-picking the open row closes it, which is the
    implicit "I'm finished" that the old floating panel had no way to express.
  */
  const handleSelectField = (id: string) => {
    setSelectedFieldId((cur) => (cur === id ? null : id));
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
                onTextLayer={setTextPages}
                bandOverlay={bandOverlay}
                bandSnapTargets={bandSnapTargets}
                drawArmed={drawArmed && selectedFieldId != null}
                onDrawBox={
                  selectedFieldId
                    ? (box) => {
                        // The drawn box is an UNCONFIRMED proposal — the same
                        // pipeline a derived grid uses (KTD2). Disarm after one
                        // box so the reviewer moves straight to confirming it.
                        proposeGeometry(selectedFieldId, box);
                        setDrawArmed(false);
                      }
                    : undefined
                }
                bandSnapTargetsY={bandSnapTargetsY}
                onBandEdge={
                  selectedFieldId
                    ? (handle, value) => {
                        // An interior boundary belongs to two bands and moves
                        // as one; an outer edge belongs to one. `handle.axis`
                        // routes the identical rule to the column or row axis.
                        if (handle.left && handle.right) {
                          adjustGeometryBoundary(selectedFieldId, handle.axis, handle.left, handle.right, value);
                        } else if (handle.right) {
                          adjustGeometryBand(selectedFieldId, handle.axis, handle.right, 'start', value);
                        } else if (handle.left) {
                          adjustGeometryBand(selectedFieldId, handle.axis, handle.left, 'end', value);
                        }
                      }
                    : undefined
                }
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
              {/* Summary + edit history. Sticky, because undo is global and
                  must stay reachable while the list scrolls — but this card is
                  short, which is the point: the editing panel that used to sit
                  here was ~350px tall and covered most of the list it edited. */}
              <div className="sticky top-0 z-10 mb-3.5 rounded-md border border-border bg-surface-card p-[14px_16px] shadow-xs">
                <div className="flex items-center gap-3.5">
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
                <div className="mt-2.5 flex items-center justify-end gap-1.5 border-t border-border-subtle pt-2.5">
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
              </div>

              <div ref={fieldListRef} className="flex flex-col gap-2.5">
                {session.fields.map((f, i) => (
                  <ReviewRow
                    key={f.id}
                    id={`review-row-${f.id}`}
                    field={f}
                    index={i}
                    count={session.fields.length}
                    expanded={f.id === selectedFieldId}
                    onToggle={() => handleSelectField(f.id)}
                    onSelect={setSelectedFieldId}
                    textPages={textPages}
                    drawArmed={drawArmed}
                    onToggleDraw={() => setDrawArmed((a) => !a)}
                    onRemapSignature={() => session.remapSignature(f.id)}
                    onSetType={(type) => session.setType(f.id, type)}
                    onConfirm={() => confirmField(f.id)}
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

/**
 * One extracted field: triage summary always, full editor when expanded.
 *
 * The editor used to float above this list in a sticky panel. Detached from
 * the row it edited, it had no way to say "this change is applied" — its only
 * button was Delete, so it read as a dead end, and at ~350px it covered the
 * list it was editing. Inside the row the connection is structural: the row you
 * opened is the row you are editing, and closing it IS the completion.
 *
 * The editor is mounted only while expanded. That is not just tidiness —
 * `FieldInspector` pulls in `ColumnInspector` and `ConditionEditor`, and the
 * latter reads the whole session to derive its source list. One mounted instead
 * of ten is real work avoided on a large import.
 */
function ReviewRow({
  id,
  field,
  index,
  count,
  expanded,
  onToggle,
  onSelect,
  textPages,
  drawArmed,
  onToggleDraw,
  onRemapSignature,
  onSetType,
  onConfirm,
  onConfirmTable,
}: {
  id: string;
  field: ReviewField;
  index: number;
  count: number;
  expanded: boolean;
  /** Open this row, or close it when it is already open. */
  onToggle: () => void;
  /** Re-point the accordion, e.g. onto a field the inspector just inserted. */
  onSelect: (id: string | null) => void;
  /** PDF text layer, forwarded to the geometry panel. */
  textPages: readonly TextPage[];
  /** Whether draw mode is armed (only meaningful for the expanded field). */
  drawArmed: boolean;
  /** Arm/disarm the draw gesture, forwarded to the geometry panel. */
  onToggleDraw: () => void;
  onRemapSignature: () => void;
  onSetType: (type: ExtractedField['type']) => void;
  /** Affirm a flagged field as-is (metadata-only resolve, type unchanged). */
  onConfirm: () => void;
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

  const panelId = `${id}-editor`;

  return (
    <div
      id={id}
      className={`rounded-md border bg-surface-card p-[13px_15px] shadow-xs transition-all ${
        expanded ? 'ring-2 ring-offset-1' : ''
      }`}
      style={{
        borderColor: c.color,
        ...(expanded ? { ringColor: c.color, boxShadow: `0 0 0 2px ${c.color}33` } : {}),
      }}
    >
      {/*
        A real button, not a div with onClick. The row was neither focusable
        nor keyboard-operable before, and the accordion makes that worse — with
        the editor hidden behind a disclosure, a keyboard user had no way to
        reach it at all. It wraps only the summary; the controls below cannot
        be nested inside a button.
      */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={expanded ? panelId : undefined}
        className="flex w-full items-center gap-[11px] text-left focus-visible:shadow-focus"
      >
        <Icon
          name="chevron-right"
          size={15}
          className={`flex-none text-text-tertiary transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="grid h-8 w-8 flex-none place-items-center rounded-lg bg-surface-sunken">
          <Icon name={meta.icon} size={16} className="text-text-secondary" />
        </span>
        {/* Spans, not divs — a button may only contain phrasing content. */}
        <span className="block min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-semibold">{field.label}</span>
          <span className="block text-[11.5px] text-text-tertiary">{meta.label}</span>
        </span>
        <span className="block w-[112px] flex-none">
          <span className="mb-1 flex items-center justify-between">
            <span className="font-mono text-[11px] font-semibold" style={{ color: c.text }}>
              {Math.round(field.confidence * 100)}%
            </span>
            <span
              className="rounded-[3px] px-[5px] py-px font-mono text-[9.5px]"
              style={{ color: c.text, background: c.bg }}
            >
              {c.label}
            </span>
          </span>
          <span className="block h-[5px] overflow-hidden rounded-pill bg-surface-sunken">
            <span
              className="block h-full rounded-pill"
              style={{ width: `${Math.round(field.confidence * 100)}%`, background: c.color }}
            />
          </span>
        </span>
        <span className="flex w-[88px] flex-none justify-end">{statusBadge(st)}</span>
        {hasPosition && (
          <span className="flex-none text-[10px] text-text-tertiary" title="Located on PDF">
            <Icon name="map-pin" size={12} />
          </span>
        )}
      </button>

      {isLow && (
        <div className="mt-[11px] rounded-md bg-danger-soft p-[11px_12px]">
          <div className="mb-2.5 flex gap-2 text-[12.5px] text-danger-text">
            <Icon name="alert-triangle" size={15} className="mt-px flex-none" />
            <span>{field.note}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            {/* A plain "this is correct" affirm — resolves the field without
                changing its type, so a reviewer who has judged a flagged field
                right can clear it from the review count instead of being forced
                to pick a correction. */}
            <button
              onClick={onConfirm}
              className="inline-flex items-center gap-1.5 rounded-md bg-brand-slate px-3 py-1.5 text-[12.5px] font-semibold text-white"
            >
              <Icon name="check" size={14} />
              Looks right
            </button>
            <span className="text-xs text-text-tertiary">or fix:</span>
            {/* "Remap to Signature" is the correction for a text field the model
                should have typed as a signature — nonsensical on a repeating
                table or any other type, so it is gated to text. The type
                dropdown stays for every genuine type correction. */}
            {offersSignatureRemap(field) && (
              <button
                onClick={onRemapSignature}
                className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-[#12321f]"
              >
                <Icon name="pen-tool" size={14} />
                Remap to Signature
              </button>
            )}
            <div className="w-[160px]">
              <Select
                options={typeOptionsFor(field.type)}
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
            onClick={onConfirmTable}
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
        /* The ONLY Required control on this screen — the inspector no longer
           carries a second one. It stays on the collapsed row because required
           is triage: worth reading across every field at a glance, without
           opening any of them. */
        <div
          className="mt-[11px] flex items-center justify-between gap-2.5 rounded-md border border-border-subtle bg-surface-sunken p-[9px_12px]"
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

      {expanded && (
        <div
          id={panelId}
          role="region"
          aria-label={`Edit ${field.label}`}
          className="mt-[11px] border-t border-border-subtle pt-[11px]"
        >
          <FieldInspector
            field={field}
            index={index}
            count={count}
            onSelect={onSelect}
            textPages={textPages}
            drawArmed={drawArmed}
            onToggleDraw={onToggleDraw}
          />
        </div>
      )}
    </div>
  );
}
