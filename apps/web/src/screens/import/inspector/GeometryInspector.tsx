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
import { useMemo } from 'react';
import { Button, Icon } from '@formai/ui';
import type { GeometryBand, PageBox } from '@formai/shared';
import type { TextPage } from '../../../lib/pdf-geometry.js';
import {
  adjustGeometryBand,
  confirmGeometry,
  geometryConfirmed,
  geometryProposal,
  proposeGeometry,
  rejectGeometry,
  type ReviewField,
} from '../../../lib/data/import-session.js';
import { NUDGE_POINTS, deriveAcrossPages, panelState } from './geometry-actions.js';

export interface GeometryInspectorProps {
  field: ReviewField;
  /** Page text from the viewer; empty until the PDF has been read. */
  textPages: readonly TextPage[];
}

export function GeometryInspector({ field, textPages }: GeometryInspectorProps) {
  const proposal = geometryProposal(field.id);
  const confirmed = geometryConfirmed(field.id);

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

  if (state.kind === 'unsupported') return null;

  return (
    <div className="flex flex-col gap-2 border-t border-border-subtle pt-3">
      <div className="flex items-center gap-1.5">
        <Icon name="grid-2x2" size={14} className="text-text-tertiary" />
        <span className="text-[12.5px] font-semibold">Grid on the original PDF</span>
        {state.kind === 'proposed' && state.confirmed && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-pill bg-success-soft px-2 py-0.5 text-[10.5px] font-semibold text-success-text">
            <Icon name="check" size={11} />
            Confirmed
          </span>
        )}
      </div>

      {state.kind === 'no-proposal' ? (
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
        </>
      ) : (
        <>
          <p className="text-[11.5px] leading-snug text-text-tertiary">
            {state.confirmed
              ? 'This grid will place answers on the exported PDF.'
              : 'Check the overlay against the printed table, then confirm. Until you do, this form exports its answers as data.'}
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

          <div className="flex items-center gap-1.5">
            {!state.confirmed && (
              <Button leadingIcon="check" onClick={() => confirmGeometry(field.id)} className="flex-1 justify-center">
                Confirm grid
              </Button>
            )}
            <Button
              variant="ghost"
              leadingIcon="x"
              onClick={() => rejectGeometry(field.id)}
              className="flex-1 justify-center text-danger-text"
            >
              Discard grid
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

  return (
    <div className="rounded-sm border border-border-subtle bg-surface-sunken p-[8px_9px]">
      <div className="mb-1.5 text-[11px] font-semibold text-text-secondary">
        Row edges ({NUDGE_POINTS}pt per step)
      </div>
      <div className="flex flex-col gap-1">
        {rows.map((band) => (
          <RowBandRow key={band.key} fieldId={fieldId} band={band} />
        ))}
      </div>
    </div>
  );
}

function RowBandRow({ fieldId, band }: { fieldId: string; band: GeometryBand }) {
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
    </div>
  );
}
