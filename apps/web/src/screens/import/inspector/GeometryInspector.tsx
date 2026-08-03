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
import { Button, Icon, Switch } from '@formai/ui';
import { isChoiceField, linkOutcomeTargets } from '@formai/shared';
import type { GeometryBand, PageBox } from '@formai/shared';
import type { TextPage } from '../../../lib/pdf-geometry.js';
import { proposeFromExemplar, proposeScalarCell } from '../../../lib/pdf-geometry.js';
import { markSentence } from '../../../lib/mark-description.js';
import {
  adjustGeometryBand,
  confirmGeometry,
  copyPlacementToField,
  geometryConfirmed,
  geometryProposal,
  getImportSession,
  optionSlotId,
  placementSourcesFor,
  proposeGeometry,
  rejectGeometry,
  setFieldPrintSelectedValue,
  type ReviewField,
} from '../../../lib/data/import-session.js';
import {
  NUDGE_POINTS,
  appendRowBelow,
  deleteRowBand,
  deriveAcrossPages,
  deriveOptionCellsAcrossPages,
  evenGrid,
  panelState,
  splitRowBand,
  subdivideBox,
} from './geometry-actions.js';

export interface GeometryInspectorProps {
  field: ReviewField;
  /** Page text from the viewer; empty until the PDF has been read. */
  textPages: readonly TextPage[];
  /**
   * Every field in the session. Used only to find an outcome cell's parent
   * question and a sibling exemplar; absent simply disables that offer.
   */
  fields?: readonly ReviewField[];
  /** The draw-armed slot (this field's id, or a checkbox option's `optionSlotId`). */
  activeDrawSlot?: string | null;
  /** Arm/disarm the draw gesture for one slot on the PDF overlay (KTD5). */
  onToggleDrawSlot?: (slot: string) => void;
}

/**
 * Reuse a placement already made on a part that prints the same thing.
 *
 * Parts 2, 4 and 6 of an assessment are ONE checklist printed three times, and
 * placing each by hand means measuring the same rows and columns three times
 * for no more accuracy than the first.
 *
 * The copy brings the shape — columns, rows, width, horizontal position — onto
 * the page named here, and lands it UNCONFIRMED. The vertical position is the
 * part that genuinely differs between pages, so the reviewer drags it into
 * place and confirms: the same two steps they would end on anyway, without the
 * measuring.
 *
 * Sources that CANNOT be used are listed with the reason rather than hidden. On
 * a page of visibly similar tables an empty list reads as a broken feature,
 * where "'Part 2 checklist' has 22 rows, this one has 24" is usually the thing
 * the reviewer most wanted to know about their document.
 */
function PlacementCopy({ field }: { field: ReviewField }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const candidates = placementSourcesFor(field.id);
  if (candidates.length === 0) return null;

  const usable = candidates.filter((c) => c.refusal === null);
  const blocked = candidates.filter((c) => c.refusal !== null);
  const pageCount = getImportSession().pageCount;
  // Pages are one-based for a person reading a printed document.
  const chosenPage = page ?? 1;

  function copyFrom(sourceId: string) {
    const result = copyPlacementToField(sourceId, field.id, chosenPage - 1);
    if (result.ok) {
      setOpen(false);
      setProblem(null);
    } else {
      setProblem(result.reason);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fai-chip-btn flex items-center gap-1.5 self-start rounded-sm text-[11.5px] text-text-accent hover:bg-surface-hover"
      >
        <Icon name="copy" size={12} />
        Copy a placement from another part
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border-accent bg-surface-accent-soft p-[10px_12px]">
      <div className="text-[12px] font-semibold">Copy a placement onto this field</div>

      <label className="flex items-center gap-2 text-[11.5px] text-text-secondary">
        Onto page
        <select
          value={chosenPage}
          onChange={(e) => setPage(Number(e.target.value))}
          className="rounded-sm border border-border bg-surface-card px-1.5 py-0.5 text-[11.5px]"
        >
          {Array.from({ length: Math.max(1, pageCount) }, (_, i) => (
            <option key={i + 1} value={i + 1}>
              {i + 1}
            </option>
          ))}
        </select>
      </label>

      {usable.length === 0 && (
        <div className="text-[11.5px] text-text-tertiary">
          Nothing placed so far has the same shape as this field.
        </div>
      )}

      {usable.map(({ field: source }) => (
        <button
          key={source.id}
          onClick={() => copyFrom(source.id)}
          className="fai-chip-btn truncate rounded-sm border border-border bg-surface-card px-2 py-1 text-left text-[11.5px] hover:bg-surface-hover"
        >
          {source.label || source.id}
        </button>
      ))}

      {blocked.map(({ field: source, refusal }) => (
        <div key={source.id} className="text-[11px] text-text-tertiary">
          <span className="font-medium">{source.label || source.id}</span> — {refusal}
        </div>
      ))}

      {problem && <div className="text-[11.5px] text-danger-text">{problem}</div>}

      <div className="text-[10.5px] text-text-tertiary">
        The copy arrives unconfirmed — drag it into position on that page, then confirm it.
      </div>

      <button
        onClick={() => setOpen(false)}
        className="fai-chip-btn self-start rounded-sm text-[11px] text-text-tertiary hover:bg-surface-hover"
      >
        Cancel
      </button>
    </div>
  );
}

export function GeometryInspector({ field, textPages, fields, activeDrawSlot = null, onToggleDrawSlot }: GeometryInspectorProps) {
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


  /*
    An outcome cell's box, copied from one the reviewer already placed.

    Outcome cells cannot be located from the page: their labels are names the
    extractor invented and appear nowhere in the document. But they are all the
    same box in the same column, one per question row — so once a human has
    placed ONE, every other can reuse its column and size, with only the row
    derived from the question's own printed label.

    `proposeFromExemplar` has existed and been tested since the outcome-cell
    work; it simply had no caller, so all 31 stayed hand-drawn. This is the
    caller.

    The parent question is resolved the same way publish resolves it — by
    printed reference through `linkOutcomeTargets` — rather than by adjacency,
    because the whole point of the reference is that adjacency shifts.
  */
  const exemplarCell = useMemo(() => {
    if (proposal || field.type !== 'check_cross' || !fields) return null;

    const { links } = linkOutcomeTargets(fields);
    const link = links.find((l) => l.outcomeId === field.id);
    if (!link) return null;
    const question = fields.find((f) => f.id === link.questionId);
    if (!question?.label) return null;

    // A sibling the reviewer has already CONFIRMED. Confirmation is the signal
    // that a human checked it against the page; copying an unconfirmed box
    // would propagate a guess thirty times over.
    const exemplar = fields.find(
      (f) => f.type === 'check_cross' && f.id !== field.id && geometryConfirmed(f.id) && geometryProposal(f.id),
    );
    const box = exemplar ? geometryProposal(exemplar.id) : undefined;
    if (!box) return null;

    return proposeFromExemplar({ pages: textPages, exemplar: box, questionLabel: question.label });
  }, [proposal, field.type, field.id, fields, textPages]);

  /*
    A scalar's box, measured off the printed CELL beneath its caption. Same
    guard as : only when nothing is stored, so a reviewer's own box is
    never recomputed away.

    An OFFER, never applied automatically. It reports 0.75 because every edge
    was measured off a printed stroke but WHICH cell belongs to which caption is
    still an inference from layout — and that inference is the part the reviewer
    is being asked to confirm.
  */
  const scalarCell = useMemo(
    () => (proposal ? null : proposeScalarCell({ pages: textPages, type: field.type, label: field.label })),
    [proposal, textPages, field.type, field.label],
  );

  const state = panelState(field, proposal, confirmed, derived);

  // A transient note shown when bounded subdivision found no grid inside the
  // drawn box, so the reviewer knows the seed path is the way forward (AE6).
  const [seedNote, setSeedNote] = useState<string | null>(null);

  // A choice field — checkbox_group, radio ("multiple choice") or dropdown —
  // draws one box PER OPTION, each rendered as a checkmark on export (not the
  // option's text), so it gets a per-option panel rather than the single-box
  // scalar treatment. All hooks above have already run, so this early return is
  // safe. A single-select choice (dropdown / radio) may instead print its
  // selected VALUE as text — `printSelectedValue` — in which case it falls
  // through to the scalar single-box body below, carrying the mode toggle.
  const isChoice = isChoiceField(field.type) && (field.options?.length ?? 0) > 0;
  const singleSelectChoice = isChoice && (field.type === 'dropdown' || field.type === 'radio');
  if (isChoice && !field.printSelectedValue) {
    return (
      <OptionBoxesGeometry
        field={field}
        textPages={textPages}
        activeDrawSlot={activeDrawSlot}
        onToggleDrawSlot={onToggleDrawSlot}
        showValueToggle={singleSelectChoice}
      />
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
  //
  // A CHECKLIST reserves its pre-printed first column (label text we don't
  // place); an OPEN table has no such column, so ALL columns are banded — the
  // first one ("Work Order #") included, or its cells would never export.
  const seedGrid = (box: PageBox) => {
    const isChecklist = (field.fixedRows?.length ?? 0) > 0;
    const bandColumns = isChecklist ? (field.columns ?? []).slice(1) : (field.columns ?? []);
    const optionKeys = bandColumns.map((c) => c.key);
    const rowCount = field.fixedRows?.length && field.fixedRows.length > 0 ? field.fixedRows.length : 3;
    const rowKeys = Array.from({ length: rowCount }, (_, i) => `r${i}`);
    proposeGeometry(field.id, evenGrid(box, optionKeys, rowKeys, isChecklist));
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
      {/*
        Offered only while this field is UNPLACED. Once a box exists, redrawing
        or adjusting it is the right tool, and a copy control still sitting
        there invites replacing hand-corrected geometry with a bulk paste.
      */}
      {!proposal && <PlacementCopy field={field} />}

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

      {/* A single-select choice printing its value as text reaches this scalar
          body; the toggle lets the reviewer switch back to per-option marks. */}
      {singleSelectChoice && <ChoiceRenderToggle field={field} />}

      {/* What the box will actually draw. Stated per field type because the
          exporter branches on the type, and the panel previously promised a tick
          for everything — including the fields that get a ring or a cross. */}
      <p className="text-[11.5px] leading-snug text-text-tertiary">{markSentence(field)}</p>

      {state.kind === 'draw-only' ? (
        <>
          <p className="text-[11.5px] leading-snug text-text-tertiary">{state.reason}</p>
          {/*
            An outcome cell's box, copied from one already confirmed. Offered
            only from the SECOND cell onward: the first is drawn by hand, and
            every later one reuses that column with the row derived from its own
            question's printed label.
          */}
          {exemplarCell?.segments[0] && (
            <div className="rounded-md border border-border-accent bg-surface-2 p-[10px_11px]">
              {exemplarCell.notes.map((n: string) => (
                <p key={n} className="text-[11.5px] leading-snug text-text-secondary">
                  {n}
                </p>
              ))}
              <p className="mt-1 text-[11px] leading-snug text-text-tertiary">
                Check it sits on this question’s row before confirming.
              </p>
              <Button
                variant="ghost"
                leadingIcon="wand-2"
                onClick={() => proposeGeometry(field.id, exemplarCell.segments[0]!)}
                className="mt-1.5 justify-center"
              >
                Use this box
              </Button>
            </div>
          )}
          {/*
            A box measured off the printed cell, or the reason there is none.
            Stating the refusal matters as much as making the offer: without it
            a reviewer cannot tell "this looked and declined" from "nothing ever
            ran", so they do not know the field still needs drawing by hand.
          */}
          {scalarCell?.placed ? (
            <div className="rounded-md border border-border-accent bg-surface-2 p-[10px_11px]">
              {scalarCell.proposal.notes.map((n: string) => (
                <p key={n} className="text-[11.5px] leading-snug text-text-secondary">
                  {n}
                </p>
              ))}
              <Button
                variant="ghost"
                leadingIcon="wand-2"
                onClick={() => proposeGeometry(field.id, scalarCell.proposal.box)}
                className="mt-1.5 justify-center"
              >
                Use this box
              </Button>
            </div>
          ) : (
            scalarCell && (
              <p className="text-[11.5px] leading-snug text-text-tertiary">
                No box was measured: {scalarCell.reason}
              </p>
            )
          )}
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

  // "Add row" extends the table DOWN the page: it measures the current rows'
  // uniform spacing and lays one more of the same height directly below the
  // bottom row (`appendRowBelow`), so a long grid is finished a row at a time
  // rather than by halving a band. Routed through the same proposal path so it
  // un-confirms and is re-validated (U4, R4).
  const addRow = () => proposeGeometry(fieldId, appendRowBelow(segment));

  // "Split bottom row" keeps the other gesture — one printed row the grid read
  // as a single band that is really two — dividing the bottom band in half.
  const splitBottom = () => {
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
      <div className="mt-1.5 flex items-center gap-1.5">
        <button
          onClick={addRow}
          aria-label="Add a row below with the same spacing"
          className="flex flex-1 items-center justify-center gap-1 rounded-sm border border-dashed border-border py-1 text-[11px] text-text-tertiary hover:bg-surface-hover"
        >
          <Icon name="plus" size={11} />
          Add row
        </button>
        <button
          onClick={splitBottom}
          aria-label="Split the bottom row into two"
          className="flex flex-none items-center justify-center gap-1 rounded-sm border border-border px-2 py-1 text-[11px] text-text-tertiary hover:bg-surface-hover"
        >
          <Icon name="separator-horizontal" size={11} />
          Split bottom
        </button>
      </div>
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
  textPages,
  activeDrawSlot,
  onToggleDrawSlot,
  showValueToggle = false,
}: {
  field: ReviewField;
  textPages: readonly TextPage[];
  activeDrawSlot: string | null;
  onToggleDrawSlot?: (slot: string) => void;
  /** Offer the "print value as text" switch (single-select dropdown / radio). */
  showValueToggle?: boolean;
}) {
  const options = field.options ?? [];

  // Derived only while EVERY option is still empty. A reviewer who has drawn or
  // adjusted even one box is mid-placement, and replacing their work with a
  // fresh derivation on the next render is the one thing this must never do.
  const anyPlaced = options.some((o) => geometryProposal(optionSlotId(field.id, o)) !== undefined);
  // Joined on a NUL because no option value can contain one, so the signature
  // cannot collide across different option lists. Written as an ESCAPE: a literal
  // NUL in the source makes the whole file binary to grep and ripgrep, and every
  // content search across the repo then skips it silently.
  const optionSig = options.join('\u0000');
  const derived = useMemo(
    () => (anyPlaced ? null : deriveOptionCellsAcrossPages(field, textPages)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [field.id, field.label, optionSig, textPages, anyPlaced],
  );

  /**
   * Fill every option's slot from the derivation, UNCONFIRMED.
   *
   * Confirmation stays per option and stays manual: a proposal is a starting
   * point a reviewer checks against the page, and auto-confirming would publish
   * marks onto a competency record against boxes no human ever looked at.
   */
  const applyDerived = () => {
    if (!derived) return;
    for (const segment of derived.segments) {
      if (segment.optionKey === undefined) continue;
      proposeGeometry(optionSlotId(field.id, segment.optionKey), segment);
    }
  };

  return (
    <div className="flex flex-col gap-2 border-t border-border-subtle pt-3">
      <div className="flex items-center gap-1.5">
        <Icon name="square-dashed" size={14} className="text-text-tertiary" />
        <span className="text-[12.5px] font-semibold">Checkmark placement on the original PDF</span>
      </div>
      {showValueToggle && <ChoiceRenderToggle field={field} />}
      <p className="text-[11.5px] leading-snug text-text-tertiary">
        Draw a box over each option on the PDF. {markSentence(field)} Until an option is confirmed,
        this form still publishes and exports the answer as data.
      </p>

      {derived && (
        <div className="rounded-sm border border-border-subtle bg-surface-sunken p-[8px_9px]">
          <p className="text-[11.5px] leading-snug text-text-secondary">
            Found this question's row on page {(derived.segments[0]?.page ?? 0) + 1}, with{' '}
            {derived.segments.length} option cells.
            {derived.confidence < 1 && ' Check it against the page before confirming.'}
          </p>
          {derived.notes.length > 0 && (
            <ul className="mt-1 list-disc pl-4 text-[11px] leading-snug text-text-tertiary">
              {derived.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
          <Button
            leadingIcon="wand-sparkles"
            variant="outline"
            onClick={applyDerived}
            className="mt-1.5 w-full justify-center"
          >
            Place all {derived.segments.length} boxes
          </Button>
        </div>
      )}
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

/**
 * Switch a single-select choice field between drawing a checkmark per option
 * and printing its selected value as TEXT in one box (`printSelectedValue`).
 *
 * The two modes read different geometry (per-option boxes vs a single box), so
 * flipping this re-points the whole panel — the routing in `GeometryInspector`
 * chooses `OptionBoxesGeometry` or the scalar single-box body off this flag.
 */
function ChoiceRenderToggle({ field }: { field: ReviewField }) {
  const on = field.printSelectedValue === true;
  return (
    <label className="flex items-center gap-2 rounded-sm border border-border-subtle bg-surface-sunken p-[7px_9px]">
      <Switch checked={on} onChange={(e) => setFieldPrintSelectedValue(field.id, e.currentTarget.checked)} />
      <span className="flex-1 text-[11.5px] leading-snug text-text-secondary">
        Print the selected value as text (instead of marking each option’s own box)
      </span>
    </label>
  );
}
