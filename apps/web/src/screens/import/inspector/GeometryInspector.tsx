/**
 * Confirm or adjust the derived grid for an imported table (U4).
 *
 * The rules live in `geometry-actions.ts` — this is the rendering half, and
 * deliberately thin. What it must not do is decide anything: R8 says nothing is
 * trusted by default, and the guard between an AI-derived grid and marks drawn
 * onto a competency record has to be readable in one place.
 *
 * Mounted inside the expanded review row, beside the column and condition
 * panels, so the grid is confirmed against the same PDF page the overlay is
 * drawing on.
 */
import { useMemo, useState } from 'react';
import { Button, Icon } from '@formai/ui';
import { isChoiceField } from '@formai/shared';
import type { GeometryBand, PageBox } from '@formai/shared';
import type { TextPage } from '../../../lib/pdf-geometry.js';
import {
  adjustGeometryBand,
  confirmGeometry,
  geometryConfirmed,
  geometryProposal,
  optionSlotId,
  proposeGeometry,
  rejectGeometry,
  type ReviewField,
} from '../../../lib/data/import-session.js';
import {
  NUDGE_POINTS,
  deleteRowBand,
  deriveAcrossPages,
  evenGrid,
  panelState,
  splitRowBand,
  subdivideBox,
} from './geometry-actions.js';

export interface GeometryInspectorProps {
  field: ReviewField;
  /** Page text from the viewer; empty until the PDF has been read. */
  textPages: readonly TextPage[];
  /** The draw-armed slot (this field's id, or a checkbox option's `optionSlotId`). */
  activeDrawSlot?: string | null;
  /** Arm/disarm the draw gesture for one slot on the PDF overlay (KTD5). */
  onToggleDrawSlot?: (slot: string) => void;
}

export function GeometryInspector({ field, textPages, activeDrawSlot = null, onToggleDrawSlot }: GeometryInspectorProps) {
  const proposal = geometryProposal(field.id);
  const confirmed = geometryConfirmed(field.id);
  // This field's own box is armed when the active slot IS the field id; a
  // checkbox option uses its own slot, handled in the per-option panel below.
  const drawArmed = activeDrawSlot === field.id;
  const onToggleDraw = onToggleDrawSlot ? () => onToggleDrawSlot(field.id) : undefined;

  /*
    Derivation is memoized because the panel re-renders far more often than its
    inputs change: `useImportSession` is a `useSyncExternalStore` subscription,
    so every keystroke in the label field above re-renders this component, and
    `deriveAcrossPages` scans the text of EVERY page each time. On an
    eighteen-page assessment that is a full re-scan per character typed.

    The key is a value signature, not the field object — the session hands out a
    fresh field object on every store update, so identity would never hit.
    Only the properties derivation actually reads take part.
  */
  const columnSig = (field.columns ?? []).map((c) => `${c.key}:${c.type}`).join('|');
  const rowCount = field.fixedRows?.length ?? -1;
  const derived = useMemo(
    // Derive only when nothing is stored — a reviewer's adjustments must never
    // be overwritten by a fresh derivation on the next render.
    () => (proposal ? null : deriveAcrossPages(field, textPages)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [field.id, field.type, columnSig, rowCount, textPages, Boolean(proposal)],
  );

  const state = panelState(field, proposal, confirmed, derived);

  // A transient note shown when bounded subdivision found no grid inside the
  // drawn box, so the reviewer knows the seed path is the way forward (AE6).
  const [seedNote, setSeedNote] = useState<string | null>(null);

  // A choice field — checkbox_group, radio ("multiple choice") or dropdown —
  // draws one box PER OPTION, each rendered as a checkmark on export (not the
  // option's text), so it gets a per-option panel rather than the single-box
  // scalar treatment. All hooks above have already run, so this early return is
  // safe.
  if (isChoiceField(field.type) && (field.options?.length ?? 0) > 0) {
    return (
      <OptionBoxesGeometry field={field} activeDrawSlot={activeDrawSlot} onToggleDrawSlot={onToggleDrawSlot} />
    );
  }

  if (state.kind === 'unsupported') return null;

  // Detect the grid INSIDE the drawn outer box (U4). Scoped to that box's page
  // text; a hit becomes an unconfirmed grid proposal, a miss routes to seeding.
  const detectGrid = (box: PageBox) => {
    const items = textPages[box.page]?.items ?? [];
    const result = subdivideBox({ box, items, columns: field.columns ?? [], wantRows: field.fixedRows?.length });
    if (result) {
      proposeGeometry(field.id, result.segment);
      setSeedNote(null);
    } else {
      setSeedNote(
        'No grid could be detected inside that box. Seed it below, then drag each divider onto the printed line.',
      );
    }
  };

  // Seed an even grid the reviewer then corrects — the manual fallback (AE6).
  // Rows default to the extracted row count, or three to start when unknown.
  const seedGrid = (box: PageBox) => {
    const optionKeys = (field.columns ?? []).slice(1).map((c) => c.key);
    const rowCount = field.fixedRows?.length && field.fixedRows.length > 0 ? field.fixedRows.length : 3;
    const rowKeys = Array.from({ length: rowCount }, (_, i) => `r${i}`);
    proposeGeometry(field.id, evenGrid(box, optionKeys, rowKeys));
    setSeedNote(null);
  };

  // A scalar carries a single placement box; a table carries a grid. The panel
  // names whichever it actually is, so the copy never promises the wrong tool.
  const isTable = field.type === 'repeating_group';
  const noun = isTable ? 'grid' : 'box';

  // The arm/disarm control (KTD5). Present in every drawable state — before the
  // first box, and afterwards to redraw. `onToggleDraw` is only wired for the
  // expanded field, so its absence hides the button rather than arming nothing.
  const drawButton = onToggleDraw && (
    <Button
      variant={drawArmed ? 'primary' : 'ghost'}
      leadingIcon={drawArmed ? 'x' : 'pencil'}
      onClick={onToggleDraw}
      className="justify-center"
    >
      {drawArmed
        ? 'Cancel — drag on the PDF to draw'
        : proposal
          ? `Redraw the ${noun}`
          : `Draw the ${noun} on the PDF`}
    </Button>
  );

  return (
    <div className="flex flex-col gap-2 border-t border-border-subtle pt-3">
      <div className="flex items-center gap-1.5">
        <Icon name={isTable ? 'grid-2x2' : 'square-dashed'} size={14} className="text-text-tertiary" />
        <span className="text-[12.5px] font-semibold">
          {isTable ? 'Grid on the original PDF' : 'Placement on the original PDF'}
        </span>
        {state.kind === 'proposed' && state.confirmed && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-pill bg-success-soft px-2 py-0.5 text-[10.5px] font-semibold text-success-text">
            <Icon name="check" size={11} />
            Confirmed
          </span>
        )}
      </div>

      {state.kind === 'draw-only' ? (
        <>
          <p className="text-[11.5px] leading-snug text-text-tertiary">{state.reason}</p>
          {drawButton}
        </>
      ) : state.kind === 'needs-subdivision' ? (
        <>
          <p className="text-[11.5px] leading-snug text-text-tertiary">{state.reason}</p>
          <div className="flex items-center gap-1.5">
            <Button
              leadingIcon="grid-2x2"
              onClick={() => detectGrid(state.box)}
              className="flex-1 justify-center"
            >
              Detect the grid
            </Button>
            <Button
              variant="ghost"
              leadingIcon="plus"
              onClick={() => seedGrid(state.box)}
              className="flex-1 justify-center"
            >
              Seed by hand
            </Button>
          </div>
          {seedNote && <p className="text-[11px] leading-snug text-warning-text">{seedNote}</p>}
          {drawButton}
          <Button
            variant="ghost"
            leadingIcon="x"
            onClick={() => rejectGeometry(field.id)}
            className="justify-center text-danger-text"
          >
            Discard box
          </Button>
        </>
      ) : state.kind === 'no-proposal' ? (
        <>
          <p className="text-[11.5px] leading-snug text-text-tertiary">{state.reason}</p>
          {derived && (
            <Button
              variant="ghost"
              leadingIcon="wand-2"
              onClick={() => proposeGeometry(field.id, derived.segment)}
              className="justify-center"
            >
              Use the derived grid
            </Button>
          )}
          {drawButton}
        </>
      ) : (
        <>
          <p className="text-[11.5px] leading-snug text-text-tertiary">
            {state.confirmed
              ? `This ${noun} will place ${isTable ? 'answers' : 'this value'} on the exported PDF.`
              : `Check the overlay against the printed ${isTable ? 'table' : 'field'}, then confirm. Until you do, this form exports ${isTable ? 'its answers' : 'this answer'} as data.`}
          </p>

          {state.notes.length > 0 && (
            <ul className="flex flex-col gap-0.5 pl-4">
              {state.notes.map((n, i) => (
                <li key={i} className="list-disc text-[11px] leading-snug text-text-tertiary">
                  {n}
                </li>
              ))}
            </ul>
          )}

          <BandNudger fieldId={field.id} segment={state.segment} />
          <RowNudger fieldId={field.id} segment={state.segment} />

          {drawButton}

          <div className="flex items-center gap-1.5">
            {!state.confirmed && (
              <Button leadingIcon="check" onClick={() => confirmGeometry(field.id)} className="flex-1 justify-center">
                Confirm {noun}
              </Button>
            )}
            <Button
              variant="ghost"
              leadingIcon="x"
              onClick={() => rejectGeometry(field.id)}
              className="flex-1 justify-center text-danger-text"
            >
              Discard {noun}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Nudge one band edge at a time.
 *
 * Buttons rather than drag handles: the columns being aligned to are 7-13pt
 * wide, and a 1pt step is the finest correction that is still visible on the
 * page. A drag over a scaled preview cannot reliably resolve that, and an
 * overshoot here silently moves where a competency mark lands.
 */
function BandNudger({ fieldId, segment }: { fieldId: string; segment: PageBox }) {
  const columns = segment.columnBands ?? [];
  if (columns.length === 0) return null;

  return (
    <div className="rounded-sm border border-border-subtle bg-surface-sunken p-[8px_9px]">
      <div className="mb-1.5 text-[11px] font-semibold text-text-secondary">
        Column edges ({NUDGE_POINTS}pt per step)
      </div>
      <div className="flex flex-col gap-1">
        {columns.map((band) => (
          <BandRow key={band.key} fieldId={fieldId} band={band} />
        ))}
      </div>
    </div>
  );
}

function BandRow({ fieldId, band }: { fieldId: string; band: GeometryBand }) {
  const nudge = (edge: 'start' | 'end', dir: -1 | 1) =>
    adjustGeometryBand(fieldId, 'column', band.key, edge, band[edge] + dir * NUDGE_POINTS);

  return (
    <div className="flex items-center gap-1.5">
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-secondary">{band.key}</span>
      {(['start', 'end'] as const).map((edge) => (
        <span key={edge} className="flex flex-none items-center gap-0.5">
          <span className="w-[34px] text-right font-mono text-[10.5px] text-text-tertiary">
            {edge === 'start' ? 'L' : 'R'} {Math.round(band[edge])}
          </span>
          <button
            onClick={() => nudge(edge, -1)}
            aria-label={`Move ${band.key} ${edge} edge left`}
            className="grid h-6 w-6 place-items-center rounded-sm border border-border text-text-tertiary hover:bg-surface-hover"
          >
            <Icon name="chevron-left" size={11} />
          </button>
          <button
            onClick={() => nudge(edge, 1)}
            aria-label={`Move ${band.key} ${edge} edge right`}
            className="grid h-6 w-6 place-items-center rounded-sm border border-border text-text-tertiary hover:bg-surface-hover"
          >
            <Icon name="chevron-right" size={11} />
          </button>
        </span>
      ))}
    </div>
  );
}

/**
 * Nudge one ROW band edge at a time — the vertical mirror of `BandNudger`.
 *
 * Same argument as the columns: a drag over a scaled preview cannot reliably
 * resolve a printed row, so a 1pt stepper is the finest visible correction. The
 * edit routes through `adjustGeometryBand(..., 'row', ...)`, so an inverting or
 * overlapping move is refused and the field un-confirms exactly as the column
 * path does — the same validator, the other axis.
 */
function RowNudger({ fieldId, segment }: { fieldId: string; segment: PageBox }) {
  const rows = segment.rowBands ?? [];
  if (rows.length === 0) return null;

  // "Add a row" splits the bottom band (lowest y = smallest `start`) in two — a
  // printed row read as two — routed through the same proposal path so it
  // un-confirms and is re-validated (U4, R4).
  const addRow = () => {
    const bottom = [...rows].sort((a, b) => a.start - b.start)[0];
    if (bottom) proposeGeometry(fieldId, splitRowBand(segment, bottom.key));
  };

  return (
    <div className="rounded-sm border border-border-subtle bg-surface-sunken p-[8px_9px]">
      <div className="mb-1.5 text-[11px] font-semibold text-text-secondary">
        Row edges ({NUDGE_POINTS}pt per step)
      </div>
      <div className="flex flex-col gap-1">
        {rows.map((band) => (
          <RowBandRow key={band.key} fieldId={fieldId} segment={segment} band={band} canDelete={rows.length > 1} />
        ))}
      </div>
      <button
        onClick={addRow}
        aria-label="Add a row divider"
        className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-sm border border-dashed border-border py-1 text-[11px] text-text-tertiary hover:bg-surface-hover"
      >
        <Icon name="plus" size={11} />
        Add row
      </button>
    </div>
  );
}

function RowBandRow({
  fieldId,
  segment,
  band,
  canDelete,
}: {
  fieldId: string;
  segment: PageBox;
  band: GeometryBand;
  canDelete: boolean;
}) {
  // PDF space is bottom-up: `start` is the band's bottom edge, `end` its top.
  const nudge = (edge: 'start' | 'end', dir: -1 | 1) =>
    adjustGeometryBand(fieldId, 'row', band.key, edge, band[edge] + dir * NUDGE_POINTS);

  return (
    <div className="flex items-center gap-1.5">
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-secondary">{band.key}</span>
      {(['start', 'end'] as const).map((edge) => (
        <span key={edge} className="flex flex-none items-center gap-0.5">
          <span className="w-[34px] text-right font-mono text-[10.5px] text-text-tertiary">
            {edge === 'start' ? 'B' : 'T'} {Math.round(band[edge])}
          </span>
          <button
            onClick={() => nudge(edge, -1)}
            aria-label={`Move ${band.key} ${edge} edge down`}
            className="grid h-6 w-6 place-items-center rounded-sm border border-border text-text-tertiary hover:bg-surface-hover"
          >
            <Icon name="chevron-down" size={11} />
          </button>
          <button
            onClick={() => nudge(edge, 1)}
            aria-label={`Move ${band.key} ${edge} edge up`}
            className="grid h-6 w-6 place-items-center rounded-sm border border-border text-text-tertiary hover:bg-surface-hover"
          >
            <Icon name="chevron-up" size={11} />
          </button>
        </span>
      ))}
      {canDelete && (
        <button
          onClick={() => proposeGeometry(fieldId, deleteRowBand(segment, band.key))}
          aria-label={`Delete row ${band.key}`}
          className="grid h-6 w-6 flex-none place-items-center rounded-sm border border-border text-text-tertiary hover:bg-surface-hover hover:text-danger-text"
        >
          <Icon name="trash-2" size={11} />
        </button>
      )}
    </div>
  );
}

/**
 * Per-option placement for a choice field — checkbox_group, radio or dropdown.
 *
 * These print a set of options to tick; the reviewer draws one box per option,
 * and each SELECTED option exports as a checkmark in its own box, never the
 * option's text. Each option's box lives under its own draw slot
 * (`optionSlotId`), reusing the whole propose/confirm pipeline, so an option is
 * published only once its own box is confirmed (R8, held per box).
 */
function OptionBoxesGeometry({
  field,
  activeDrawSlot,
  onToggleDrawSlot,
}: {
  field: ReviewField;
  activeDrawSlot: string | null;
  onToggleDrawSlot?: (slot: string) => void;
}) {
  const options = field.options ?? [];

  return (
    <div className="flex flex-col gap-2 border-t border-border-subtle pt-3">
      <div className="flex items-center gap-1.5">
        <Icon name="square-dashed" size={14} className="text-text-tertiary" />
        <span className="text-[12.5px] font-semibold">Checkmark placement on the original PDF</span>
      </div>
      <p className="text-[11.5px] leading-snug text-text-tertiary">
        Draw a box over each option on the PDF. Every option the filler selects then prints a ✓ in its box.
        Until an option is confirmed, this form still publishes and exports the answer as data.
      </p>
      <div className="flex flex-col gap-1.5">
        {options.map((option) => (
          <OptionBoxRow
            key={option}
            fieldId={field.id}
            option={option}
            armed={activeDrawSlot === optionSlotId(field.id, option)}
            onToggleDraw={onToggleDrawSlot ? () => onToggleDrawSlot(optionSlotId(field.id, option)) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

function OptionBoxRow({
  fieldId,
  option,
  armed,
  onToggleDraw,
}: {
  fieldId: string;
  option: string;
  armed: boolean;
  onToggleDraw?: () => void;
}) {
  const slot = optionSlotId(fieldId, option);
  const box = geometryProposal(slot);
  const confirmed = geometryConfirmed(slot);

  return (
    <div className="rounded-sm border border-border-subtle bg-surface-sunken p-[8px_9px]">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">{option}</span>
        {box && confirmed && (
          <span className="inline-flex items-center gap-1 rounded-pill bg-success-soft px-2 py-0.5 text-[10.5px] font-semibold text-success-text">
            <Icon name="check" size={11} />
            Confirmed
          </span>
        )}
        {box && !confirmed && <span className="text-[10.5px] font-semibold text-warning-text">Drawn — confirm it</span>}
        {!box && <span className="text-[10.5px] text-text-tertiary">No box yet</span>}
      </div>
      <div className="flex items-center gap-1.5">
        {onToggleDraw && (
          <Button
            variant={armed ? 'primary' : 'ghost'}
            leadingIcon={armed ? 'x' : 'pencil'}
            onClick={onToggleDraw}
            className="flex-1 justify-center"
          >
            {armed ? 'Cancel — drag on the PDF' : box ? 'Redraw' : 'Draw the box'}
          </Button>
        )}
        {box && !confirmed && (
          <Button leadingIcon="check" onClick={() => confirmGeometry(slot)} className="flex-1 justify-center">
            Confirm
          </Button>
        )}
        {box && (
          <Button
            variant="ghost"
            leadingIcon="x"
            onClick={() => rejectGeometry(slot)}
            className="flex-none justify-center text-danger-text"
          >
            Discard
          </Button>
        )}
      </div>
    </div>
  );
}
