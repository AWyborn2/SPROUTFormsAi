/**
 * The decisions the geometry panel offers, as pure functions.
 *
 * Kept out of the component for the usual reason — the rules are testable and
 * the rendering is not — but also because these decide what a reviewer is
 * ALLOWED to confirm, and that is the guard standing between an AI-derived
 * grid and marks drawn onto a competency record. It belongs somewhere it can
 * be read and tested directly.
 */
import type { DerivationMethod, FormField, GeometryBand, GroupOrdinal, PageBox, RepeatingColumn } from '@formai/shared';
import { isChoiceField, isMatchingQuestion, markPlacement, resolveGeometry } from '@formai/shared';
import type {
  FieldProposal,
  MatchAnchorSpec,
  PositionedText,
  TableProposal,
  TextPage,
} from '../../../lib/pdf-geometry.js';
import {
  proposeFieldOptionCells,
  proposeInlineOptionCells,
  proposeMatchAnchorCells,
  proposeTableSegments,
} from '../../../lib/pdf-geometry.js';

/**
 * The part of a field grid derivation reads: its shape, its row count, and —
 * when the reviewer split a side-by-side block — which printed group it is.
 * `groupOrdinal` is not a `FormField` property (it is review-only, carried in
 * `reviewMeta`), so it is spelled out here rather than picked from `FormField`.
 */
export type DerivableField = Pick<FormField, 'type' | 'columns' | 'fixedRows'> & {
  groupOrdinal?: GroupOrdinal;
};

/**
 * How much more confident the best row-count match must be than an equally
 * close rival before derivation trusts it over refusing (KTD2/R1).
 *
 * Measured across the library. Derivation confidence is built from discrete
 * penalties in `proposeTableSegments`: a corroborated, fully-located header
 * scores 1.0; losing corroboration costs 0.2; each inferred or merged column
 * costs 0.3. So the separations that actually occur between two same-row-count
 * candidates are: 0.0 (two structurally-identical corroborated tables — the
 * `ADMN-FRM-111` category blocks and the dozer's repeated per-page tables both
 * land here), 0.2 (a corroborated winner over an uncorroborated rival), and
 * 0.3+ (a clean locate over an inferred/merged one). A band of 0.15 sits in the
 * empty gap between the 0.0 ties it must refuse and the ≥0.2 genuine winners it
 * must keep — so no real single-region derivation is lost (R5) while a true
 * coin-flip between indistinguishable tables refuses.
 *
 * One newer separation sits INSIDE the band, deliberately: a rect-anchored
 * headerless proposal ships at 0.95, so against a confidence-1 text rival on
 * the same row count the 0.05 gap refuses. That is the intended failure
 * direction — the rect-anchored tier is a brand-new heuristic and must not
 * win a coin-flip against corroborated header evidence — and the ordinal and
 * drawn-box recourses remain. Anyone re-tuning this constant must keep 0.05
 * inside the band or that tie starts resolving by guess.
 */
export const NEAR_EQUAL_CONFIDENCE = 0.15;

/** A proposal's leftmost option-column x — the key the ordinal orders on. */
function optionLeftX(proposal: TableProposal): number {
  const cols = proposal.segment.columnBands ?? [];
  return cols.length > 0 ? Math.min(...cols.map((c) => c.start)) : proposal.segment.x;
}

/**
 * Order side-by-side proposals left-to-right by their option columns, taking the
 * higher one first on an x tie. Only reached after `selectByOrdinal` has
 * established the proposals really are side-by-side (x-spread over y-spread), so
 * the x key carries the ordering and the y tie-break is just a stable fallback.
 */
function orderedByColumn(proposals: readonly TableProposal[]): TableProposal[] {
  return [...proposals].sort((a, b) => {
    const dx = optionLeftX(a) - optionLeftX(b);
    return dx !== 0 ? dx : b.segment.y - a.segment.y;
  });
}

/**
 * Select the proposal a group ordinal points at, or refuse.
 *
 * The count matching is necessary but NOT sufficient, and getting that wrong
 * mis-placed grids on the real form. A split records N side-by-side groups, so
 * the ordinal only means something when the page surfaces N proposals that are
 * genuinely side-by-side: on ONE baseline, spread across the page in x. The
 * failure it must refuse is N proposals that merely happen to number N while
 * being VERTICALLY STACKED — e.g. `ADMN-FRM-111`, whose three category blocks
 * (A, B, C) each collapse to one proposal, giving three proposals that share an
 * x column and differ only in y. Counting alone, `3 === 3` matched and the
 * ordinal mapped Category A's groups onto Categories B and C. Side-by-side
 * groups share a header row (same y, different x); stacked categories are the
 * opposite. So the proposals must be arranged more horizontally than
 * vertically, or there is no honest group→proposal mapping and it refuses.
 */
function selectByOrdinal(proposals: readonly TableProposal[], ordinal: GroupOrdinal): TableProposal | null {
  if (proposals.length !== ordinal.count) return null;
  if (ordinal.index < 0 || ordinal.index >= proposals.length) return null;

  const xs = proposals.map(optionLeftX);
  const ys = proposals.map((p) => p.segment.y);
  const xSpread = Math.max(...xs) - Math.min(...xs);
  const ySpread = Math.max(...ys) - Math.min(...ys);
  // Side-by-side ⇒ x varies far more than y. Stacked (different tables that
  // merely count the same as the groups) ⇒ refuse rather than mis-place.
  if (xSpread <= ySpread) return null;

  return orderedByColumn(proposals)[ordinal.index]!;
}

/**
 * Pick the proposal whose row count is closest to the field's, refusing when the
 * winner is not clearly better than an equally-close rival (R1/KTD2).
 */
function selectByRowCount(proposals: readonly TableProposal[], wantRows: number): TableProposal | null {
  const delta = (p: TableProposal) => Math.abs((p.segment.rowBands?.length ?? 0) - wantRows);
  const best = proposals.reduce((b, p) => {
    const d = delta(p);
    const bd = delta(b);
    if (d !== bd) return d < bd ? p : b;
    return p.confidence > b.confidence ? p : b;
  });

  // A rival matches the row count exactly as well. If it is within the near-equal
  // band, the two are indistinguishable on every signal derivation has and
  // picking one would be a coin-flip on table identity — so refuse.
  const bestDelta = delta(best);
  const rivalConfidence = proposals
    .filter((p) => p !== best && delta(p) === bestDelta)
    .reduce((max, p) => Math.max(max, p.confidence), -Infinity);
  if (best.confidence - rivalConfidence < NEAR_EQUAL_CONFIDENCE) return null;

  return best;
}

/** What the panel should show for the selected field. */
export type GeometryPanelState =
  | { kind: 'unsupported'; reason: string }
  | { kind: 'draw-only'; reason: string }
  | { kind: 'no-proposal'; reason: string }
  | { kind: 'needs-subdivision'; box: PageBox; reason: string }
  | {
      kind: 'proposed';
      segment: PageBox;
      confidence: number;
      notes: string[];
      confirmed: boolean;
      /**
       * How the derivation placed the COLUMN bands, when a table derivation is
       * behind this proposal — provenance for the panel's caption, carried
       * separately from `notes` because notes are warnings and several tests
       * assert `notes: []` on a clean derivation. Absent for anything that is
       * not a derived table grid (scalars, hand-drawn boxes).
       */
      columnEvidence?: TableProposal['columnEvidence'];
    };

/**
 * The one-line provenance caption the geometry panel shows for a derived table
 * grid — the reviewer-facing half of `columnEvidence` (R7).
 *
 * Composed here rather than in the components because two panels render it
 * (the import review inspector and the placement screen), and two copies of
 * the wording would drift. It is also the visible tell for the historic
 * silent-zero rect-extractor regression: if that returns, the measured wording
 * simply stops appearing.
 */
export function columnEvidenceCaption(
  evidence: TableProposal['columnEvidence'] | undefined,
): string | null {
  if (evidence === undefined) return null;
  return evidence === 'printed-boxes'
    ? 'Columns measured from printed boxes.'
    : 'Columns inferred from header text.';
}

/**
 * Derive a proposal for one field from a page's text.
 *
 * A page carries several tables and derivation cannot see which printed table a
 * field belongs to, so selection is table-aware or it refuses (parent R16
 * extended to table identity):
 *
 *   1. A split-group field carries its printed-group ordinal — order the page's
 *      proposals left-to-right and take the ordinal-th (`selectByOrdinal`).
 *   2. Otherwise match on row count, but refuse when the winner is not clearly
 *      better than an equally-close rival (`selectByRowCount`).
 *   3. A field with no row count AND no ordinal has nothing to tie it to any one
 *      table, so it refuses rather than grabbing the best-confidence proposal
 *      from an unrelated table (R3/KTD3 — the `FAULTS` sliver bug).
 *
 * A refusal returns null and surfaces through the `no-proposal` panel state: the
 * field exports as data and can be hand-placed. A confidently-wrong grid on a
 * competency record is worse than none.
 */
export function deriveForField(
  field: DerivableField,
  pageIndex: number,
  pageText: PositionedText[],
  pageWidth: number,
  pageHeight: number,
  /**
   * The page's printed rectangles (`TextPage.rects`), for snapping the answer
   * columns onto the printed squares and for anchoring headerless checklists.
   * Optional and trailing so every existing caller compiles unchanged —
   * `undefined` is NOT MEASURED, and derivation degrades to text-only exactly.
   */
  rects?: readonly PrintedRect[],
): TableProposal | null {
  if (field.type !== 'repeating_group' || !field.columns || field.columns.length < 2) return null;

  const proposals = proposeTableSegments({
    page: pageIndex,
    pageWidth,
    pageHeight,
    items: pageText,
    columns: field.columns,
    rects,
  });
  if (proposals.length === 0) return null;

  if (field.groupOrdinal) return selectByOrdinal(proposals, field.groupOrdinal);

  const wantRows = field.fixedRows?.length;
  if (wantRows === undefined) return null;

  return selectByRowCount(proposals, wantRows);
}

/* ------------------------------------------------------------------ *
 * The extraction window as a soft prior
 *
 * Every AI-extracted field is stamped with `sourcePages` — the 1-based
 * inclusive page range of the extraction BATCH that produced it, known to the
 * splitter in code and never asked of the model. The document-wide derivers
 * below refuse the moment two pages both claim a field, even when the batch
 * already says which copy is whose. The helpers here turn that stamp into a
 * usable window and one shared verdict, so a document-wide ambiguity with
 * exactly ONE hit inside the field's window becomes a needs-review placement
 * naming the excluded pages, instead of a refusal — while ambiguity INSIDE a
 * window keeps refusing, and a field with no window keeps today's exact path.
 * ------------------------------------------------------------------ */

/**
 * The ceiling on any window-influenced proposal's confidence (KTD2).
 *
 * Strictly below `classifyProposalTier`'s auto-confirm boundary (`=== 1`), so
 * a placement the window disambiguated always parks as needs-review and flows
 * through the existing "Confirm all proposed" bulk action. The window is a
 * batch artifact, not a human judgement, and the one thing it must never do
 * is push a mark onto a competency record without a reviewer's eyes passing
 * over the page it chose.
 */
export const WINDOW_CONFIDENCE_CAP = 0.95;

/**
 * How many pages the stamped window is widened on each side before use (KTD3).
 *
 * The batch boundary is an artifact of the splitter, not of the printed
 * document: a batch-start orphan merge or a continuation table can put a
 * field's printed start one page outside the range it was stamped with.
 * Dilation trades a little disambiguating power at boundaries — two parts
 * whose dilated windows overlap on a shared page refuse, the honest answer —
 * for never excluding the true page.
 */
export const WINDOW_MARGIN_PAGES = 1;

/**
 * A validated extraction window, ready to test pages against.
 *
 * `first`/`last` are 0-based inclusive and ALREADY dilated and clamped — the
 * only bounds scoping ever tests, built in one place so every deriver agrees.
 * `from`/`to` keep the stamped 1-based range for the reviewer-facing notes:
 * a note names what the extraction stamped, not the tolerance around it.
 */
export interface PageWindow {
  first: number;
  last: number;
  from: number;
  to: number;
}

/**
 * Resolve a field's stamped `sourcePages` into a usable window, or null.
 *
 * Null on every malformed shape — absent, non-integer, non-positive,
 * inverted — and on a window lying wholly past the end of the document,
 * which is the "PDF replaced with a shorter one" defense: a window that
 * cannot name any real page says nothing about THIS document, and treating
 * it as absent routes the field onto the untouched no-window path (R6)
 * rather than steering every hit into the "outside the window" cap.
 */
export function pageWindowOf(
  sourcePages: { from: number; to: number } | undefined,
  pageCount: number,
): PageWindow | null {
  if (!sourcePages || pageCount <= 0) return null;
  const { from, to } = sourcePages;
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
  if (from < 1 || to < from) return null;
  if (from > pageCount) return null; // wholly past the document's end
  return {
    first: Math.max(from - 1 - WINDOW_MARGIN_PAGES, 0),
    last: Math.min(to - 1 + WINDOW_MARGIN_PAGES, pageCount - 1),
    from,
    to,
  };
}

/** Is a 0-based page inside the dilated window? */
function inPageWindow(page: number, window: PageWindow): boolean {
  return page >= window.first && page <= window.last;
}

/** 0-based pages as a reader counts them: "page 7", "pages 12 and 17". */
function pageListText(pages: readonly number[]): string {
  const printed = [...pages].sort((a, b) => a - b).map((p) => p + 1);
  if (printed.length === 1) return `page ${printed[0]}`;
  const last = printed.pop()!;
  return `pages ${printed.join(', ')} and ${last}`;
}

/** The STAMPED range, 1-based and undilated: "pages 5–8", or "page 5". */
function windowRangeText(window: PageWindow): string {
  return window.from === window.to ? `page ${window.from}` : `pages ${window.from}–${window.to}`;
}

/**
 * The note on a placement the window disambiguated (R5). Built here — with
 * its "outside" counterpart below — so every deriver says it in the same
 * words: the reviewer must be able to see WHY the other copies lost.
 */
function windowExclusionNote(
  page: number,
  excludedPages: readonly number[],
  window: PageWindow,
): string {
  return `Matched on page ${page + 1}; ${pageListText(excludedPages)} excluded by the extraction window (${windowRangeText(window)}).`;
}

/**
 * The note on a placement OUTSIDE its own window (R4/AE5). The soft prior
 * never vetoes the only candidate, but either the stamp or the match is
 * wrong here and a human has to say which.
 */
function windowOutsideNote(page: number, window: PageWindow): string {
  return `Matched on page ${page + 1}, outside the extraction window (${windowRangeText(window)}) — check the page.`;
}

/** What the window says about a set of per-page hits. */
export type WindowVerdict =
  | { kind: 'refuse' }
  | { kind: 'place'; page: number; windowed: false }
  | { kind: 'place'; page: number; windowed: true; note: string };

/**
 * The R2–R5 truth table, over the pages a document-wide scan matched.
 *
 * One hit inside the window and none outside: place it untouched — the
 * window was not needed, and a prior that changed nothing must leave no
 * fingerprints (R4/AE4). One inside, others outside: place the inside one,
 * flagged with the pages the window excluded. Two or more inside: refuse —
 * that is a question the document does not place, and the window has no more
 * to say (R3/AE2). None inside: a UNIQUE hit elsewhere still places, capped
 * and flagged, because a soft prior never vetoes the only candidate (AE5);
 * two or more elsewhere refuse exactly as today.
 */
export function windowVerdict(
  hits: readonly { page: number }[],
  window: PageWindow,
): WindowVerdict {
  const inside = hits.filter((h) => inPageWindow(h.page, window));
  const outside = hits.filter((h) => !inPageWindow(h.page, window));

  if (inside.length >= 2) return { kind: 'refuse' };

  if (inside.length === 1) {
    const page = inside[0]!.page;
    if (outside.length === 0) return { kind: 'place', page, windowed: false };
    return {
      kind: 'place',
      page,
      windowed: true,
      note: windowExclusionNote(page, outside.map((h) => h.page), window),
    };
  }

  if (outside.length === 1) {
    const page = outside[0]!.page;
    return { kind: 'place', page, windowed: true, note: windowOutsideNote(page, window) };
  }

  return { kind: 'refuse' };
}

/**
 * Apply a window verdict to per-page hits: the chosen page's proposal —
 * untouched when the window was not needed, capped below auto-confirm and
 * carrying the verdict's note when it was (R5/KTD2) — or null on refusal.
 * Shared by the option-cell and match-anchor scans so a window-influenced
 * proposal is shaped identically wherever it came from.
 */
function proposalThroughWindow<P extends { confidence: number; notes: string[] }>(
  hits: readonly { page: number; proposal: P }[],
  window: PageWindow,
): P | null {
  const verdict = windowVerdict(hits, window);
  if (verdict.kind === 'refuse') return null;
  const hit = hits.find((h) => h.page === verdict.page)!;
  if (!verdict.windowed) return hit.proposal;
  return {
    ...hit.proposal,
    confidence: Math.min(hit.proposal.confidence, WINDOW_CONFIDENCE_CAP),
    notes: [...hit.proposal.notes, verdict.note],
  };
}

/**
 * Window scoping for the TABLE picker (R9) — deliberately not `windowVerdict`.
 *
 * The table path never refused on ambiguity (identical repeated parts are why
 * the window exists at all), and it does not start to: candidates outside the
 * window are dropped when anything is inside it, and the caller's EXISTING
 * tiebreak runs over whatever survives. The cap and note apply only when the
 * window actually changed the field — out-of-window candidates excluded, or
 * nothing in-window at all (the R4 "outside" case, flagged never vetoed). All
 * candidates in-window means the window changed nothing and the pick is
 * returned untouched, fingerprint-free (R4/AE4).
 */
function tableThroughWindow(
  picks: readonly TableProposal[],
  window: PageWindow,
  choose: (pool: readonly TableProposal[]) => TableProposal,
): TableProposal | null {
  if (picks.length === 0) return null;
  const inside = picks.filter((p) => inPageWindow(p.segment.page, window));
  const outside = picks.filter((p) => !inPageWindow(p.segment.page, window));

  const chosen = choose(inside.length > 0 ? inside : picks);
  if (inside.length > 0 && outside.length === 0) return chosen;

  const note =
    inside.length > 0
      ? windowExclusionNote(chosen.segment.page, outside.map((p) => p.segment.page), window)
      : windowOutsideNote(chosen.segment.page, window);
  return {
    ...chosen,
    confidence: Math.min(chosen.confidence, WINDOW_CONFIDENCE_CAP),
    notes: [...chosen.notes, note],
  };
}

/**
 * Derive a proposal for one field across EVERY page.
 *
 * A table extracted by the model carries no `sourcePosition` — only AcroForm
 * fields get one — so there is no page to start from, and deriving against
 * page 0 would silently place an eighteen-page assessment's table on its cover
 * sheet. Every page is tried; the table-awareness lives in `deriveForField`,
 * which already refuses within a page it cannot resolve, so this only combines
 * the per-page picks.
 *
 * An ordinal field resolves entirely inside one page (the ordinal orders THAT
 * page's proposals), so the first page that yields a pick wins — the same
 * "anchor where it starts" rule the row-count path uses on a tie.
 *
 * With a `window`, in-window candidates outrank the rest (R9): the identical
 * checklist Parts 2, 4 and 6 print on three pages stops landing three times
 * on the first page that fits. The tiebreakers WITHIN the surviving pool are
 * unchanged, and no window means the original loop, verbatim (R6/KTD4).
 */
export function deriveAcrossPages(
  field: DerivableField,
  pages: readonly TextPage[],
  window?: PageWindow | null,
): TableProposal | null {
  if (field.groupOrdinal) {
    if (!window) {
      for (const [i, page] of pages.entries()) {
        const p = deriveForField(field, i, page.items, page.width, page.height, page.rects);
        if (p) return p;
      }
      return null;
    }
    // Windowed: the scan must run FULL — the note has to name what it
    // excluded — and "first page that yields" becomes "first IN-WINDOW page
    // that yields", the same anchor rule applied to the surviving pool.
    const picks: TableProposal[] = [];
    for (const [i, page] of pages.entries()) {
      const p = deriveForField(field, i, page.items, page.width, page.height, page.rects);
      if (p) picks.push(p);
    }
    return tableThroughWindow(picks, window, (pool) => pool[0]!);
  }

  const wantRows = field.fixedRows?.length;

  if (!window) {
    let best: TableProposal | null = null;

    for (const [i, page] of pages.entries()) {
      const p = deriveForField(field, i, page.items, page.width, page.height, page.rects);
      if (!p) continue;
      if (!best) {
        best = p;
        continue;
      }
      if (wantRows !== undefined) {
        const d = Math.abs((p.segment.rowBands?.length ?? 0) - wantRows);
        const bestD = Math.abs((best.segment.rowBands?.length ?? 0) - wantRows);
        if (d !== bestD) {
          if (d < bestD) best = p;
          continue;
        }
      }
      if (p.confidence > best.confidence) best = p;
    }

    return best;
  }

  // The existing best-pick — row-count distance, then confidence, earlier
  // page on a full tie — as a reduction over a pool, so the windowed path
  // applies the IDENTICAL tiebreak to whichever candidates survive scoping.
  const pickBest = (pool: readonly TableProposal[]): TableProposal => {
    let best = pool[0]!;
    for (const p of pool.slice(1)) {
      if (wantRows !== undefined) {
        const d = Math.abs((p.segment.rowBands?.length ?? 0) - wantRows);
        const bestD = Math.abs((best.segment.rowBands?.length ?? 0) - wantRows);
        if (d !== bestD) {
          if (d < bestD) best = p;
          continue;
        }
      }
      if (p.confidence > best.confidence) best = p;
    }
    return best;
  };

  const picks: TableProposal[] = [];
  for (const [i, page] of pages.entries()) {
    const p = deriveForField(field, i, page.items, page.width, page.height, page.rects);
    if (p) picks.push(p);
  }
  return tableThroughWindow(picks, window, pickBest);
}

/**
 * Why a field has NO geometry path at all — neither a derived grid nor a
 * hand-drawn box.
 *
 * A non-table field is deliberately NOT unsupported any more (U2/R9): it cannot
 * carry a derived GRID, but it can carry a single-box placement — drawn by hand,
 * or measured off the printed cell beneath its caption by `proposeScalarCell`.
 * Both are surfaced through the `draw-only` panel state and confirmed exactly
 * like a grid. (This used to read "there is nothing to derive for a scalar",
 * which the cell rule made false; a stale comment asserting the opposite of the
 * code is how the next reader gets it wrong.)
 *
 * The only true dead-end left is a repeating table whose extraction captured no
 * option columns: there is no grid to confirm and no per-cell placement to draw.
 */
export function unsupportedReason(
  field: Pick<FormField, 'type' | 'columns'>,
): string | null {
  if (field.type === 'repeating_group' && (!field.columns || field.columns.length < 2)) {
    return 'This table has no option columns to place, so there is no grid to confirm.';
  }
  return null;
}

/**
 * How far a band edge moves per nudge, in PDF points.
 *
 * A point is roughly a third of a millimetre on the printed page, and the
 * option columns being aligned to are 7-13pt wide — so a 1pt step is the
 * finest correction that is still visible, and anything coarser cannot land
 * inside a narrow column.
 */
export const NUDGE_POINTS = 1;

/**
 * How far from a printed glyph a dragged edge still counts as meaning it.
 *
 * The objection to dragging is real and documented on `BandNudger`: a pointer
 * over a scaled preview cannot resolve a 7-13pt column. Snapping answers it by
 * changing what the pointer has to do — it picks WHICH printed thing the edge
 * belongs to, and the text layer supplies the coordinate, so precision stops
 * depending on the pointer at all (KTD12).
 *
 * 12pt is one option glyph wide: `ADMN-FRM-111` prints OK at 12.2 and NA at
 * 12.6, and the dozer family's N/A is 13.3. Inside a glyph's own width the
 * reviewer meant that glyph; beyond it they meant a bare coordinate, and
 * pulling them to a distant column would be the overshoot the buttons exist to
 * avoid. Ambiguity between two nearby targets is not settled by this number —
 * `snapEdge` takes the NEAREST target, so the closest edge always wins.
 */
export const SNAP_RANGE = 12;

/**
 * How far a hand-DRAWN box edge snaps to a printed TEXT edge.
 *
 * Deliberately far tighter than `SNAP_RANGE`. A band-edge drag is choosing WHICH
 * option column it means, so a wide catch is right. A drawn placement box is
 * being traced onto the page, and pulling its edge onto a label 12pt away — the
 * "Date" caption beside the cell being boxed — is the visible JUMP that made a
 * careful trace land somewhere else. At 4pt the box stays where it was drawn and
 * only settles onto a printed edge the reviewer was already touching; the
 * steppers do the fine alignment.
 */
export const DRAW_SNAP_RANGE = 4;

/**
 * How far a drawn box edge snaps to a printed RULE-LINE.
 *
 * Rule-lines are the table's actual grid, which is what a reviewer traces a box
 * against, so a more generous catch than text is right — a rough trace should
 * lock onto the cell border it was aiming for. Still well under a cell's height,
 * so it never crosses to the next rule.
 */
export const RULE_SNAP_RANGE = 8;

/**
 * The largest share of a drawn edge-to-edge span that a single snap may move
 * one of its edges.
 *
 * A fixed catch is the wrong shape of rule because it means something different
 * at different sizes. 8pt off a 200pt table box is a rounding correction; 8pt
 * off a 10pt checkbox is most of the shape. The bug this fixes is exactly that:
 * a traced checkbox in a 28pt row sits ~9pt from each row border, so a wobble
 * of a point brings an edge inside the catch and the box inflates to the full
 * row — a rectangle where a square was drawn.
 *
 * At 0.35 a trace can be tidied by about a third of its size and no more, which
 * is generous for the alignment snapping exists to do and far short of reaching
 * the surrounding cell.
 */
export const SNAP_MAX_DRAG_FRACTION = 0.35;

/**
 * The snap catch for one axis, given how long the drag was on that axis.
 *
 * Never above the caller's range — this only ever tightens — and never below
 * `DRAW_SNAP_RANGE`, so a deliberately thin box (a write-on line, a signature
 * strip) keeps the modest catch that has always aligned it. Between those two
 * it scales with the drag, which is the part that protects small shapes.
 */
export function axisSnapRange(extent: number, range: number): number {
  if (!Number.isFinite(extent) || extent <= 0) return range;
  return Math.min(range, Math.max(DRAW_SNAP_RANGE, extent * SNAP_MAX_DRAG_FRACTION));
}

/** A 2-D affine transform, as pdf.js reports it: [a, b, c, d, e, f]. */
export type Matrix = readonly [number, number, number, number, number, number];

/** Map a point through an affine matrix (pdf.js `Util.applyTransform`). */
export function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/**
 * Compose two affine transforms (pdf.js `Util.transform(m1, m2)`).
 *
 * Used to fold a content-stream `transform` op into the running CTM, in the same
 * order pdf.js does, so the rule-line coordinates we extract land in the page's
 * own point space — the space geometry is stored in.
 */
export function matrixMultiply(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/** One straight edge of a drawn path, in whatever space its points are given. */
export interface DrawSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** pdf.js `DrawOPS` — the path-segment opcodes packed into a `constructPath`. */
const DRAW_OP = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 } as const;

/**
 * Turn one pdf.js `constructPath` operand — a flat `[op, x, y, …]` array — into
 * its straight line segments.
 *
 * pdf.js packs a whole path as `moveTo x y`, `lineTo x y`, `curveTo …` (6
 * coords), `quadraticCurveTo …` (4 coords) and `closePath` (0 coords). Table
 * rules and cell rectangles are all `lineTo`/`closePath`, so every grid edge is
 * a straight segment here; curves advance the cursor to their end point but emit
 * no segment (a grid is never a curve). A `closePath` re-emits the segment back
 * to the subpath's start, which is how a stroked cell rectangle yields its
 * fourth side.
 */
export function segmentsFromDrawOps(ops: ArrayLike<number>): DrawSegment[] {
  return subpathsFromDrawOps(ops).flat();
}

/**
 * The same walk as `segmentsFromDrawOps`, but keeping each SUBPATH separate.
 *
 * A `constructPath` operand holds a whole path, which is often several closed
 * shapes — a `moveTo` starts a new one. Flattening loses the only signal that
 * says which four segments belong to the same printed shape, and that grouping
 * is what lets a checkbox be recognised as a checkbox rather than as four
 * unrelated strokes too short to be rules (see `rectFromSubpath`).
 *
 * `segmentsFromDrawOps` is this function flattened, so the two can never drift.
 */
export function subpathsFromDrawOps(ops: ArrayLike<number>): DrawSegment[][] {
  const subpaths: DrawSegment[][] = [];
  let current: DrawSegment[] = [];
  let startX = 0;
  let startY = 0;
  let curX = 0;
  let curY = 0;
  let i = 0;

  const flush = () => {
    if (current.length > 0) subpaths.push(current);
    current = [];
  };

  while (i < ops.length) {
    const op = ops[i++];
    if (op === DRAW_OP.moveTo) {
      flush();
      curX = startX = ops[i++]!;
      curY = startY = ops[i++]!;
    } else if (op === DRAW_OP.lineTo) {
      const x = ops[i++]!;
      const y = ops[i++]!;
      current.push({ x1: curX, y1: curY, x2: x, y2: y });
      curX = x;
      curY = y;
    } else if (op === DRAW_OP.curveTo) {
      i += 4; // two control points…
      curX = ops[i++]!; // …then the end point the cursor moves to
      curY = ops[i++]!;
    } else if (op === DRAW_OP.quadraticCurveTo) {
      i += 2; // one control point…
      curX = ops[i++]!;
      curY = ops[i++]!;
    } else if (op === DRAW_OP.closePath) {
      if (curX !== startX || curY !== startY) {
        current.push({ x1: curX, y1: curY, x2: startX, y2: startY });
      }
      curX = startX;
      curY = startY;
    } else {
      break; // an opcode we do not model — stop rather than mis-read coords
    }
  }
  flush();
  return subpaths;
}

/** One closed axis-aligned rectangle printed on the page, in PDF points. */
export interface PrintedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The rectangle a closed subpath draws, or null if it draws something else.
 *
 * WHY THIS EXISTS AT ALL. Rule-line extraction keeps only segments at least
 * 18pt long, on the reasoning that "nothing a glyph stroke or a checkbox tick
 * could reach". That reasoning is about the ✓ someone writes IN the box. It
 * also, silently, discards the BOX — a printed checkbox is 8–10pt a side, so
 * all four of its edges fail the length test and the one thing an author is
 * trying to trace is invisible to the snapper.
 *
 * The visible consequence: trace a checkbox inside a 28pt table row and both
 * horizontal edges snap out to the row's borders, because those are the only
 * surviving targets within range. A perfect square goes in and a full-height
 * rectangle comes out.
 *
 * LENGTH IS THE WRONG TEST; CLOSURE IS THE RIGHT ONE. A letter stroke is part
 * of a curve-heavy subpath that closes on nothing; a checkbox is four straight
 * axis-aligned segments that close on themselves. Asking "does this subpath
 * form a rectangle" admits the 9pt checkbox and still refuses the 9pt cap of a
 * T, which no length threshold can do.
 *
 * Size is deliberately NOT judged here. A traced table cell is as valid a
 * target as a traced checkbox, and the caller decides by overlap with what the
 * author actually drew — which is a better question than any size cutoff.
 */
export function rectFromSubpath(
  segments: readonly DrawSegment[],
  { tolerance = 0.5 }: { tolerance?: number } = {},
): PrintedRect | null {
  // A rectangle is four sides. A producer that emits an explicit closing
  // `lineTo` and then a `closePath` leaves a fifth, zero-length one — real, and
  // not a reason to refuse — so degenerate segments are dropped before counting
  // rather than counted and rejected.
  const sides = segments.filter(
    (s) =>
      [s.x1, s.y1, s.x2, s.y2].every(Number.isFinite) &&
      (Math.abs(s.x2 - s.x1) > tolerance || Math.abs(s.y2 - s.y1) > tolerance),
  );
  if (sides.length !== 4) return null;

  let horizontals = 0;
  let verticals = 0;
  for (const s of sides) {
    const dx = Math.abs(s.x2 - s.x1);
    const dy = Math.abs(s.y2 - s.y1);
    if (dy <= tolerance && dx > tolerance) horizontals++;
    else if (dx <= tolerance && dy > tolerance) verticals++;
    else return null; // a diagonal — this subpath is not axis-aligned
  }
  if (horizontals !== 2 || verticals !== 2) return null;

  const xs = sides.flatMap((s) => [s.x1, s.x2]);
  const ys = sides.flatMap((s) => [s.y1, s.y2]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  if (maxX - minX <= tolerance || maxY - minY <= tolerance) return null;

  /*
    EVERY CORNER MUST BE ON THE BOUNDING BOX. Four axis-aligned sides, two of
    each orientation, still describe an open U or a Z — shapes whose bounding
    box is nothing anyone drew. Requiring each endpoint to sit on an edge of the
    bbox is what makes this a rectangle rather than a bounding box around a
    scribble.
  */
  const onEdge = (v: number, lo: number, hi: number) =>
    Math.abs(v - lo) <= tolerance || Math.abs(v - hi) <= tolerance;
  for (const s of sides) {
    if (!onEdge(s.x1, minX, maxX) || !onEdge(s.x2, minX, maxX)) return null;
    if (!onEdge(s.y1, minY, maxY) || !onEdge(s.y2, minY, maxY)) return null;
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * How much of the author's drag a printed rectangle must account for before the
 * drag is treated as tracing THAT rectangle.
 *
 * Intersection over union, so it penalises both a rect that misses part of the
 * drag and one that extends well past it. Measured against the shapes actually
 * in play: a hand trace of a 10pt checkbox scores ~0.7–0.9 against the checkbox
 * and ~0.15 against the table cell containing it, because the cell is several
 * times the area. 0.35 sits in the gap with room on both sides — comfortably
 * above every containing-cell score, comfortably below every real trace.
 */
export const RECT_TRACE_MIN_OVERLAP = 0.35;

/**
 * The share of the DRAG's extent, ON EACH AXIS, a printed rectangle must cover
 * before it can claim the trace.
 *
 * IoU alone could not tell "traced this box" from "drew across this box and
 * its neighbour": a drag spanning two stacked one-line cells scores IoU 0.5
 * against EACH cell — above the trace threshold — so a deliberate two-line box
 * collapsed to whichever single cell scored a hair higher, and near-ties made
 * every redraw land on a different line. A rect covering barely half the
 * drag's height is something the author drew PAST, not the thing they meant,
 * however well it scores on IoU.
 *
 * Per axis rather than by area, deliberately: a sloppy hand trace is loose on
 * BOTH axes at once, and the product of two honest 0.75s is an area score of
 * 0.56 — an area gate strict enough to catch the two-line case would refuse
 * real traces. Each axis alone stays comfortably above 0.65 on every trace
 * measured, and a stacked-cell match sits at 0.5.
 */
export const RECT_TRACE_MIN_DRAG_COVERED = 0.65;

/**
 * The share of the printed RECTANGLE's extent, on each axis, the drag must
 * cover — the mirror of `RECT_TRACE_MIN_DRAG_COVERED`, and the gate that refuses
 * an ENCLOSING border.
 *
 * Drag-coverage alone asks only "does the rect contain most of my drag", which a
 * page frame or a whole-table outline answers yes to for ANY large box drawn
 * inside it — so a box drawn around a few answer cells snapped straight out to
 * the full page. Requiring the drag to cover most of the rect too means the two
 * must be nearly the SAME rectangle: a checkbox trace (drag ≈ box) clears it, a
 * border several times the drag's size on an axis does not. IoU was meant to
 * catch this, but 0.35 admits a rect up to ~2.9x the drag's area and a page
 * border is only ~2x — inside the gap.
 */
export const RECT_TRACE_MIN_RECT_COVERED = 0.65;

/**
 * The printed rectangle an author was tracing, if they were tracing one.
 *
 * Snapping four edges INDEPENDENTLY is what deforms a traced checkbox: each
 * edge asks "what is nearest me" with no knowledge that the other three exist,
 * so two of them can settle on a different shape's borders and the result is a
 * rectangle nobody drew. Matching the drag against whole printed rectangles
 * asks the question the author was answering — *which box did you mean* — and
 * returns that box exactly, at its printed size, with no accumulated error.
 *
 * THREE gates, because they refuse different mistakes. Drag-coverage refuses a
 * rect far SMALLER than the drag (one line of a deliberate two-line box).
 * Rect-coverage refuses a rect far LARGER than the drag (the enclosing cell, the
 * page border a big box was drawn inside). IoU is the tie-break between rects
 * that clear both. A real trace covers its box snugly BOTH ways and clears all
 * three with room.
 *
 * Returns null when nothing clears them, which is the common case on an unruled
 * page and leaves per-edge snapping to handle it.
 */
export function rectTraced(
  drawn: { x: number; y: number; width: number; height: number },
  rects: readonly PrintedRect[],
  minOverlap: number = RECT_TRACE_MIN_OVERLAP,
): PrintedRect | null {
  const area = drawn.width * drawn.height;
  if (!(area > 0)) return null;

  let best: PrintedRect | null = null;
  let bestScore = 0;
  for (const r of rects) {
    const ix = Math.min(drawn.x + drawn.width, r.x + r.width) - Math.max(drawn.x, r.x);
    const iy = Math.min(drawn.y + drawn.height, r.y + r.height) - Math.max(drawn.y, r.y);
    if (ix <= 0 || iy <= 0) continue;
    if (
      ix < RECT_TRACE_MIN_DRAG_COVERED * drawn.width ||
      iy < RECT_TRACE_MIN_DRAG_COVERED * drawn.height ||
      ix < RECT_TRACE_MIN_RECT_COVERED * r.width ||
      iy < RECT_TRACE_MIN_RECT_COVERED * r.height
    ) {
      continue;
    }
    const intersection = ix * iy;
    const union = area + r.width * r.height - intersection;
    const score = union > 0 ? intersection / union : 0;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return bestScore >= minOverlap ? best : null;
}

/** Axis-aligned rule-lines pulled out of a set of path segments. */
export interface RuleLines {
  /** x of every vertical rule. */
  xs: number[];
  /** y of every horizontal rule. */
  ys: number[];
}

/**
 * Collect the axis-aligned rule-lines from a set of segments (U-draw).
 *
 * A segment counts as a vertical rule when its endpoints share an x (within a
 * hair) and it is at least `minLength` tall, and a horizontal rule by the mirror
 * test. Short segments — a checkbox tick, a glyph stroke, the cap on a letter —
 * are ignored so only real grid lines become snap targets. Coordinates are
 * deduped within `tolerance` so a doubled or overdrawn rule contributes one
 * target, exactly as `snapTargets` dedupes text edges.
 */
export function rulesFromSegments(
  segments: readonly DrawSegment[],
  { minLength = 12, tolerance = 0.5 }: { minLength?: number; tolerance?: number } = {},
): RuleLines {
  const xs: number[] = [];
  const ys: number[] = [];

  for (const s of segments) {
    if (![s.x1, s.y1, s.x2, s.y2].every(Number.isFinite)) continue;
    const dx = Math.abs(s.x2 - s.x1);
    const dy = Math.abs(s.y2 - s.y1);
    if (dx <= tolerance && dy >= minLength) xs.push((s.x1 + s.x2) / 2);
    else if (dy <= tolerance && dx >= minLength) ys.push((s.y1 + s.y2) / 2);
  }

  const dedupe = (values: number[]): number[] => {
    values.sort((a, b) => a - b);
    const out: number[] = [];
    for (const v of values) {
      if (out.length === 0 || v - out[out.length - 1]! > tolerance) out.push(v);
    }
    return out;
  };

  return { xs: dedupe(xs), ys: dedupe(ys) };
}

/** A printed horizontal rule-line, keeping the extent `RuleLines` discards. */
export interface RuleSpan {
  y: number;
  x1: number;
  x2: number;
}

/**
 * Horizontal rule-lines WITH their endpoints.
 *
 * `rulesFromSegments` collapses every rule to a bare y, which is all a drag-snap
 * target needs. Placing a box on a printed write-on line needs the opposite: the
 * line's own start and end ARE the box's x and width, measured rather than
 * guessed. That distinction is why a scalar placement rule can exist at all —
 * `PositionedText` carries no height and no strokes, so a text-only rule has no
 * vertical signal whatever and would have to invent one.
 *
 * Two near-coincident spans merge: a write-on line drawn as a thin filled
 * rectangle reaches us as its two long edges, and an overdrawn rule as two lines
 * a hair apart. Both are one printed line. `mergeY` defaults to the same
 * tolerance used to decide whether two text runs share a baseline, because it
 * answers the same question about the same page.
 */
export function horizontalRuleSpans(
  segments: readonly DrawSegment[],
  {
    minLength = 18,
    tolerance = 0.5,
    mergeY = 1.5,
  }: { minLength?: number; tolerance?: number; mergeY?: number } = {},
): RuleSpan[] {
  const spans: RuleSpan[] = [];
  for (const s of segments) {
    if (![s.x1, s.y1, s.x2, s.y2].every(Number.isFinite)) continue;
    if (Math.abs(s.y2 - s.y1) > tolerance) continue;
    if (Math.abs(s.x2 - s.x1) < minLength) continue;
    spans.push({ y: (s.y1 + s.y2) / 2, x1: Math.min(s.x1, s.x2), x2: Math.max(s.x1, s.x2) });
  }

  spans.sort((a, b) => a.y - b.y || a.x1 - b.x1);

  const merged: RuleSpan[] = [];
  for (const s of spans) {
    const prev = merged[merged.length - 1];
    if (prev && Math.abs(s.y - prev.y) <= mergeY) {
      /*
        THE SAME LINE TWICE — both endpoints, not merely overlapping.

        Merging exists for ONE line reaching us as two: a rule printed as a thin
        filled rectangle arrives as its two long edges, and an overdrawn rule as
        two near-coincident lines. In both cases the extents are the same.

        Anything looser destroys the per-cell extents a table is made of, and a
        cell's extent is the whole point of reading these. Measured on the real
        document, on one cover-page row at y≈701:

          31.4 → 221.8   cell border
          222.3 → 384.8  cell border
          385.3 → 563.5  cell border
          31.4 → 563.5   the table's OUTER border, same baseline

        A "touching" test merges the cells end-to-end into one full-width rule.
        An "overlaps by half" test merges each cell into the outer border, which
        contains it entirely. Either way every caption on the row measures the
        table instead of its own cell, and two fields end up proposing the same
        box — which is how a value lands in another field's cell.
      */
      if (Math.abs(s.x1 - prev.x1) <= 2 && Math.abs(s.x2 - prev.x2) <= 2) {
        prev.x1 = Math.min(prev.x1, s.x1);
        prev.x2 = Math.max(prev.x2, s.x2);
        prev.y = (prev.y + s.y) / 2;
        continue;
      }
    }
    merged.push({ ...s });
  }
  return merged;
}

/**
 * Where a dragged edge may land: both edges of every printed run on the page.
 *
 * Deliberately the raw text layer rather than the derivation's own output.
 * `proposeTableSegments` isolates the RIGHTMOST cluster on a row by design, so
 * its bands know 512.6/540.7 on `ADMN-FRM-111` and nothing about the two
 * groups printed to the left — which are exactly the places a reviewer needs
 * to drag to. Extra targets cost nothing here: the pointer has already
 * narrowed the choice to within a glyph's width before any of them apply.
 */
export function snapTargets(items: readonly PositionedText[]): number[] {
  const edges: number[] = [];
  for (const item of items) {
    // pdfjs can report a degenerate measurement, and `toRows` already drops
    // those for the same reason. A single NaN here would sort in place, swallow
    // the dedupe loop's comparison and leave `[NaN]` as the whole target list —
    // every snap would then return NaN, the validator would refuse every move,
    // and dragging would be silently dead on that page.
    if (!Number.isFinite(item.x) || !Number.isFinite(item.width)) continue;
    edges.push(item.x, item.x + item.width);
  }
  edges.sort((a, b) => a - b);

  // Collapse duplicates — a column of items printed at one x contributes that
  // x once, not once per row.
  const unique: number[] = [];
  for (const e of edges) {
    if (unique.length === 0 || e - unique[unique.length - 1]! > 0.5) unique.push(e);
  }
  return unique;
}

/**
 * One draggable vertical edge of a column grid.
 *
 * `left`/`right` name the bands the edge belongs to — an interior edge belongs
 * to BOTH, an outer edge to one.
 */
export interface BandHandle {
  key: string;
  label: string;
  /** Where the edge sits, in PDF points. */
  at: number;
  /** Which grid axis the edge belongs to — routes the validated adjustment. */
  axis: 'column' | 'row';
  left?: string;
  right?: string;
}

/**
 * The draggable edges of a column grid — one per BOUNDARY, not two per band.
 *
 * `centresToBands` makes bands contiguous, so `bands[i].end` and
 * `bands[i+1].start` are the same coordinate. Drawing a handle for each would
 * stack two identical hit targets: the later one always wins, so half of them
 * would be unreachable, and moving one band's edge alone would tear a gap in
 * the grid that a tick can land in and resolve to no column at all. An interior
 * boundary is therefore ONE handle that moves both bands together.
 */
export function columnHandles(bands: readonly GeometryBand[]): BandHandle[] {
  const sorted = [...bands].sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return [];

  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;

  const handles: BandHandle[] = [
    { key: `left-${first.key}`, label: `Drag the left edge of ${first.key}`, at: first.start, axis: 'column', right: first.key },
  ];
  for (let i = 0; i < sorted.length - 1; i++) {
    const l = sorted[i]!;
    const r = sorted[i + 1]!;
    handles.push({
      key: `between-${l.key}-${r.key}`,
      label: `Drag the boundary between ${l.key} and ${r.key}`,
      // Contiguous by construction; if a reviewer's earlier edit left a gap,
      // the handle sits on the left band's edge rather than in mid-air.
      at: l.end,
      axis: 'column',
      left: l.key,
      right: r.key,
    });
  }
  handles.push({
    key: `right-${last.key}`,
    label: `Drag the right edge of ${last.key}`,
    at: last.end,
    axis: 'column',
    left: last.key,
  });

  return handles;
}

/**
 * The draggable edges of a ROW grid — one per BOUNDARY, mirroring `columnHandles`.
 *
 * Row bands are contiguous in y exactly as column bands are in x
 * (`centresToBands` again), so the same "one handle per boundary, interior
 * boundary owns both bands" rule holds — drawing a handle per band edge would
 * stack two identical hit targets and let a reviewer tear a gap a tick can fall
 * into. `start`/`end` are the band's bottom/top y in PDF points (bottom-up), so
 * sorting by `start` runs the handles bottom-to-top and the outer handles are
 * the bottommost band's bottom edge and the topmost band's top edge.
 */
export function rowHandles(bands: readonly GeometryBand[]): BandHandle[] {
  const sorted = [...bands].sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return [];

  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;

  const handles: BandHandle[] = [
    { key: `bottom-${first.key}`, label: `Drag the bottom edge of ${first.key}`, at: first.start, axis: 'row', right: first.key },
  ];
  for (let i = 0; i < sorted.length - 1; i++) {
    const l = sorted[i]!;
    const r = sorted[i + 1]!;
    handles.push({
      key: `between-${l.key}-${r.key}`,
      label: `Drag the boundary between ${l.key} and ${r.key}`,
      // Contiguous by construction; if a reviewer's earlier edit left a gap,
      // the handle sits on the lower band's edge rather than in mid-air.
      at: l.end,
      axis: 'row',
      left: l.key,
      right: r.key,
    });
  }
  handles.push({
    key: `top-${last.key}`,
    label: `Drag the top edge of ${last.key}`,
    at: last.end,
    axis: 'row',
    left: last.key,
  });

  return handles;
}

/**
 * Which validated adjustment a handle maps to (KTD4).
 *
 * The routing mirrors the drag path in `ImportReviewScreen`'s `onBandEdge` and
 * the button path in `GeometryInspector` exactly: an interior boundary owns
 * BOTH adjacent bands and moves as one (`adjustGeometryBoundary`), while an
 * outer edge owns a single band's `start` or `end` (`adjustGeometryBand`).
 * Extracting it as a pure value is what lets a keyboard nudge and a pointer drag
 * be proven to resolve to the identical call, with no DOM.
 */
export type HandleAdjustment =
  | { kind: 'boundary'; leftKey: string; rightKey: string }
  | { kind: 'edge'; key: string; edge: 'start' | 'end' };

export function handleAdjustment(handle: BandHandle): HandleAdjustment | null {
  if (handle.left && handle.right) return { kind: 'boundary', leftKey: handle.left, rightKey: handle.right };
  if (handle.right) return { kind: 'edge', key: handle.right, edge: 'start' };
  if (handle.left) return { kind: 'edge', key: handle.left, edge: 'end' };
  return null;
}

/**
 * The coordinate a keyboard nudge moves a focused handle to (R1/AE1).
 *
 * The same `NUDGE_POINTS` step the stepper buttons use, so an arrow key and a
 * button click land the edge in the same place. The result is fed through the
 * SAME `onBandEdge` path the drag uses, so the shipped validator refuses an
 * inverting or overlapping nudge exactly as it refuses a drag or a step — no new
 * movement or validation path is introduced.
 */
export function nudgedEdge(handle: BandHandle, direction: -1 | 1, step = NUDGE_POINTS): number {
  return handle.at + direction * step;
}

/**
 * A representative mark per target cell of a grid, in PDF point space (R2/R3).
 *
 * Every row band × every column band, each placed by the shared `markPlacement`
 * — the exact function the exporter draws with — so the preview and the exported
 * PDF agree cell-for-cell and cannot drift (AE2/AE3). Empty when the segment
 * carries no rows or no columns, so a field with no grid renders nothing
 * (KTD5).
 */
export interface PreviewMark {
  /** Stable React key: `${rowKey}::${columnKey}`. */
  key: string;
  rowKey: string;
  columnKey: string;
  /** Mark origin/size in PDF points — identical to `markPlacement`. */
  x: number;
  y: number;
  size: number;
}

export function previewMarks(segment: PageBox): PreviewMark[] {
  const rows = segment.rowBands ?? [];
  const cols = segment.columnBands ?? [];
  const marks: PreviewMark[] = [];
  for (const row of rows) {
    for (const col of cols) {
      const { x, y, size } = markPlacement(row, col);
      marks.push({ key: `${row.key}::${col.key}`, rowKey: row.key, columnKey: col.key, x, y, size });
    }
  }
  return marks;
}

/** Pull a dragged coordinate onto the nearest printed edge, or leave it alone. */
export function snapEdge(value: number, targets: readonly number[], range = SNAP_RANGE): number {
  let best: number | null = null;
  for (const t of targets) {
    if (Math.abs(t - value) > range) continue;
    if (best === null || Math.abs(t - value) < Math.abs(best - value)) best = t;
  }
  return best ?? value;
}

/**
 * Widen a segment box so it contains every one of its bands, clamped to the
 * page. Bands outside the box are rejected by the shared validator, so an
 * adjustment that pushes past the current edge has to carry the box with it.
 *
 * Mirrors `import-session.ts`'s private helper of the same name exactly — both
 * `moveBand`/`moveBoundary` here and `adjustGeometryBand`/`adjustGeometryBoundary`
 * there need it, and this module is the pure-function home, so the definition
 * lives here and `import-session.ts` no longer needs its own copy.
 */
function growToFit(segment: PageBox): PageBox {
  const cols = segment.columnBands ?? [];
  const rows = segment.rowBands ?? [];

  const left = Math.max(Math.min(segment.x, ...cols.map((b) => b.start)), 0);
  const right = Math.min(
    Math.max(segment.x + segment.width, ...cols.map((b) => b.end)),
    segment.pageWidth,
  );
  const bottom = Math.max(Math.min(segment.y, ...rows.map((b) => b.start)), 0);
  const top = Math.min(
    Math.max(segment.y + segment.height, ...rows.map((b) => b.end)),
    segment.pageHeight,
  );

  return { ...segment, x: left, y: bottom, width: right - left, height: top - bottom };
}

/**
 * Move one band edge, the pure core of `import-session.ts`'s `adjustGeometryBand`
 * (R8/U6/KTD5).
 *
 * Extracted so the Placement screen (`GeometryEditorScreen`) can drive the same
 * validated band-drag/nudge the import review screen uses, writing the result
 * into its own `edited` field array instead of the import session's
 * `geometryProposals` map. Returns `null` for an inverted band, a grow-past-page
 * edit, or an edit the shipped validator (`resolveGeometry`) would refuse —
 * exactly the refusals `adjustGeometryBand` encodes as "do nothing".
 */
export function moveBand(
  segment: PageBox,
  axis: 'column' | 'row',
  key: string,
  edge: 'start' | 'end',
  value: number,
): PageBox | null {
  const bands = axis === 'column' ? segment.columnBands : segment.rowBands;
  const band = bands?.find((b) => b.key === key);
  if (!band) return null;

  const moved = { ...band, [edge]: value };
  if (!(moved.end > moved.start)) return null; // an inverted band is not an edit

  const withMove: PageBox = {
    ...segment,
    ...(axis === 'column'
      ? { columnBands: segment.columnBands!.map((b) => (b.key === key ? moved : b)) }
      : { rowBands: segment.rowBands!.map((b) => (b.key === key ? moved : b)) }),
  };

  // Grow the box to contain the moved band. Bands must lie inside the segment,
  // so without this a reviewer dragging the outermost edge outward would see
  // the control simply do nothing — the edit is legitimate, it is the box that
  // was too small.
  const next = growToFit(withMove);

  // Reject an edit the shipped validator would refuse, rather than storing a
  // grid that silently vanishes at publish. Overlapping a neighbour is the
  // common case when dragging an edge past it.
  if (resolveGeometry({ geometry: { segments: [next] } }).segments.length !== 1) return null;

  return next;
}

/**
 * Move the shared boundary between two adjacent bands, the pure core of
 * `import-session.ts`'s `adjustGeometryBoundary` (R8/U6/KTD5).
 *
 * `centresToBands` makes bands contiguous — `bands[i].end === bands[i+1].start`
 * — so an interior edge belongs to two bands at once. Moving only one of them
 * opens a gap the exporter cannot resolve: a tick printed in it falls in no
 * column at all. The two edges are therefore one control, moved together or
 * not at all, validated the same way `moveBand` is.
 */
export function moveBoundary(
  segment: PageBox,
  axis: 'column' | 'row',
  leftKey: string,
  rightKey: string,
  value: number,
): PageBox | null {
  const bands = (axis === 'column' ? segment.columnBands : segment.rowBands) ?? [];
  const left = bands.find((b) => b.key === leftKey);
  const right = bands.find((b) => b.key === rightKey);
  if (!left || !right) return null;
  if (!(value > left.start) || !(value < right.end)) return null;

  const moved = bands.map((b) =>
    b.key === leftKey ? { ...b, end: value } : b.key === rightKey ? { ...b, start: value } : b,
  );
  const next = growToFit({
    ...segment,
    ...(axis === 'column' ? { columnBands: moved } : { rowBands: moved }),
  });
  if (resolveGeometry({ geometry: { segments: [next] } }).segments.length !== 1) return null;

  return next;
}

/**
 * Vertical snap targets: the printed text baselines on a page (U1).
 *
 * The horizontal `snapTargets` gives the left/right edges a column-band drag
 * lands on; a hand-drawn box also needs to snap its TOP and BOTTOM, so this is
 * the y counterpart. `PositionedText` carries only a baseline y (no glyph
 * height), so a baseline is the one honest vertical anchor — a scalar value
 * prints on the same baseline as its printed label. Same NaN guard and
 * dedupe as `snapTargets`, for the same reason.
 */
export function snapTargetsY(items: readonly PositionedText[]): number[] {
  const ys: number[] = [];
  for (const item of items) {
    if (!Number.isFinite(item.y)) continue;
    ys.push(item.y);
  }
  ys.sort((a, b) => a - b);
  const unique: number[] = [];
  for (const y of ys) {
    if (unique.length === 0 || y - unique[unique.length - 1]! > 0.5) unique.push(y);
  }
  return unique;
}

/**
 * Turn two dragged corners into a snapped, page-clamped box (U1).
 *
 * The pure core of draw-a-box: the component converts the pointer's two corners
 * from screen pixels into PDF points (flipping y, which is bottom-up in PDF
 * space) and hands them here. Precision is the U10 lesson — a free drag over a
 * scaled preview cannot resolve a 7-13pt column, so each edge snaps to the
 * text layer (`snapEdge`) and the pointer only has to get within range. The box
 * is normalised (an inverted drag is fine), clamped to the page, and returned
 * with NO bands: it is a scalar placement box, or the outer box a table's
 * subdivision (U4) will fill in.
 *
 * A snap is applied per axis only when it keeps the box non-degenerate —
 * snapping both edges of an axis onto one target would collapse it, so that
 * axis keeps the raw drag instead.
 *
 * The catch is also scaled to the drag (`axisSnapRange`), so a small trace can
 * never be stretched into a shape the author did not draw.
 */
export function snapDrawnBox(
  a: { x: number; y: number },
  b: { x: number; y: number },
  page: { page: number; pageWidth: number; pageHeight: number },
  xTargets: readonly number[],
  yTargets: readonly number[],
  range: number = DRAW_SNAP_RANGE,
): PageBox {
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
  let left = clamp(Math.min(a.x, b.x), page.pageWidth);
  let right = clamp(Math.max(a.x, b.x), page.pageWidth);
  let bottom = clamp(Math.min(a.y, b.y), page.pageHeight);
  let top = clamp(Math.max(a.y, b.y), page.pageHeight);

  const xRange = axisSnapRange(right - left, range);
  const yRange = axisSnapRange(top - bottom, range);

  const sLeft = snapEdge(left, xTargets, xRange);
  const sRight = snapEdge(right, xTargets, xRange);
  if (sRight - sLeft >= 1) {
    left = sLeft;
    right = sRight;
  }
  const sBottom = snapEdge(bottom, yTargets, yRange);
  const sTop = snapEdge(top, yTargets, yRange);
  if (sTop - sBottom >= 1) {
    bottom = sBottom;
    top = sTop;
  }

  return {
    page: page.page,
    x: left,
    y: bottom,
    width: right - left,
    height: top - bottom,
    pageWidth: page.pageWidth,
    pageHeight: page.pageHeight,
  };
}

/**
 * The text runs that fall inside a drawn box (U4).
 *
 * Bounded subdivision's whole safety property is that detection runs over ONLY
 * the glyphs the reviewer's box encloses (KTD4/R7): the drawn box is the
 * corroboration that scopes detection to one table, so two structurally
 * identical tables on a page cannot bleed into each other where page-wide
 * derivation would have chosen the wrong one. An item counts as inside when its
 * baseline sits within the box's y-range and its horizontal MIDPOINT sits within
 * its x-range — the midpoint rather than either edge so a run straddling the
 * drawn edge is assigned to the box it mostly lies in, and a neighbouring
 * table's runs, which lie wholly outside, are excluded with margin. Same
 * non-finite guard `toRows`/`snapTargets` use, for the same reason.
 */
export function itemsInBox(items: readonly PositionedText[], box: PageBox): PositionedText[] {
  const right = box.x + box.width;
  const top = box.y + box.height;
  return items.filter((i) => {
    if (!Number.isFinite(i.x) || !Number.isFinite(i.y) || !Number.isFinite(i.width)) return false;
    const midX = i.x + i.width / 2;
    return midX >= box.x && midX <= right && i.y >= box.y && i.y <= top;
  });
}

export interface SubdivideInput {
  box: PageBox;
  items: readonly PositionedText[];
  columns: readonly RepeatingColumn[];
  /** The field's printed row count, when known, to break a multi-header tie. */
  wantRows?: number;
  /**
   * The PAGE's printed rectangles — filtered to the drawn box here, by the
   * same centre test `proposeRectGrid` scopes with, so a square belonging to
   * the table below the drag can never snap this table's bands. `undefined`
   * keeps the NOT MEASURED convention and derives text-only.
   */
  rects?: readonly PrintedRect[];
}

/**
 * Detect a table's grid INSIDE a drawn box (U4, R4/R7).
 *
 * The reviewer draws the outer box first, so this filters the page's text to
 * that box and runs the shipped `proposeTableSegments` over only those runs.
 * The box is the region-scoping the page-wide derivation lacked — the collision
 * bug was derivation scanning the whole page and choosing the wrong table
 * (`2026-07-23-007`), and here the human has already said which table this is —
 * so detection-within-box is safe where page-wide derivation was not (KTD4).
 * Returns null when nothing usable is inside the box, which routes the panel to
 * the manual `evenGrid` fallback (AE6) rather than a guess.
 *
 * A well-drawn box holds one table, so there is normally one proposal; when a
 * box happens to catch a repeated header, the row-count match breaks the tie,
 * then confidence.
 */
export function subdivideBox({ box, items, columns, wantRows, rects }: SubdivideInput): TableProposal | null {
  const inside = itemsInBox(items, box);
  if (inside.length === 0) return null;

  // A rectangle belongs to the drag when its CENTRE does — the same test
  // `proposeRectGrid` uses, for the same reason: a checkbox is 9pt, and full
  // enclosure punishes a trace for being a few tenths of a point tight, while
  // the centre test still keeps the next table's squares out.
  const right = box.x + box.width;
  const top = box.y + box.height;
  const rectsInside = rects?.filter((r) => {
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    return cx >= box.x && cx <= right && cy >= box.y && cy <= top;
  });

  const proposals = proposeTableSegments({
    page: box.page,
    pageWidth: box.pageWidth,
    pageHeight: box.pageHeight,
    items: inside,
    columns: [...columns],
    rects: rectsInside,
  });
  if (proposals.length === 0) return null;

  return proposals.reduce((best, p) => {
    if (wantRows !== undefined) {
      const d = Math.abs((p.segment.rowBands?.length ?? 0) - wantRows);
      const bd = Math.abs((best.segment.rowBands?.length ?? 0) - wantRows);
      if (d !== bd) return d < bd ? p : best;
    }
    return p.confidence > best.confidence ? p : best;
  });
}

/**
 * An evenly-divided grid inside a drawn box — the manual fallback (U4, R4/AE6).
 *
 * When bounded subdivision detects nothing usable inside the box, the reviewer
 * seeds the grid by count and then snaps/nudges each divider onto the printed
 * line (the same drag-snap and steppers a derived grid gets). It is scaffolding
 * the human immediately corrects, so it is deliberately blunt: the box is split
 * into `optionKeys.length + 1` equal columns and the LEFTMOST is reserved for
 * the label column (which carries no band, exactly as a derived grid's does),
 * because a box drawn around a whole table includes its row labels — the same
 * runs `subdivideBox` needs to see to detect rows at all. Rows split the full
 * height evenly, top-to-bottom so `r0` is the top row, matching both
 * `centresToBands` and the exporter's positional row order.
 *
 * Contiguous and inside the box by construction, so it survives `resolveGeometry`
 * (R6); no glyphs are consulted, because the whole point of this path is that
 * there were none to consult.
 *
 * `reserveLabel` controls the leftmost part. A fixed-item CHECKLIST prints its
 * item text down the first column and that text is not something we place, so
 * the leftmost part is reserved (no band) and the option columns start one part
 * in. An OPEN row-entry table (a timesheet) has no pre-printed label column —
 * every column is a fillable cell whose value must export — so nothing is
 * reserved and `optionKeys` should be ALL the columns, banded left-to-right
 * across the full box. Reserving a phantom label there is what left the first
 * column ("Work Order #") with no band, so its cells never placed on export.
 */
export function evenGrid(
  box: PageBox,
  optionKeys: readonly string[],
  rowKeys: readonly string[],
  reserveLabel = true,
): PageBox {
  const left = box.x;
  const right = box.x + box.width;
  const bottom = box.y;
  const top = box.y + box.height;

  const reserved = reserveLabel ? 1 : 0;
  const parts = optionKeys.length + reserved;
  const colWidth = parts > 0 ? (right - left) / parts : 0;
  const columnBands: GeometryBand[] = optionKeys.map((key, i) => ({
    key,
    start: left + colWidth * (i + reserved),
    end: left + colWidth * (i + reserved + 1),
  }));

  const rowHeight = rowKeys.length > 0 ? (top - bottom) / rowKeys.length : 0;
  const rowBands: GeometryBand[] = rowKeys.map((key, i) => ({
    key,
    // i = 0 is the TOP row (highest y): its slice runs from just below the top
    // edge to the top edge.
    start: top - rowHeight * (i + 1),
    end: top - rowHeight * i,
  }));

  return { ...box, columnBands, rowBands };
}

/**
 * Re-key row bands `r0..r{n-1}` top-to-bottom (U4).
 *
 * The exporter matches a row band to an answered row by ARRAY ORDER, not by key
 * (`round-trip.ts` — `rowCursor` walks `segment.rowBands`), so after adding or
 * deleting a divider the bands must be returned top-to-bottom (highest y first)
 * with sequential positional keys, or a later edit would draw answers on the
 * wrong rows.
 */
function resequenceRows(bands: readonly GeometryBand[]): GeometryBand[] {
  return [...bands]
    .sort((a, b) => b.end - a.end)
    .map((b, i) => ({ ...b, key: `r${i}` }));
}

/**
 * Add a row divider by splitting one row band in two at its midpoint (U4, R4).
 *
 * "Add a divider" is one printed row read as two — the escape hatch for a
 * detected or seeded grid that merged two rows, or a hand grid that needs one
 * more. The two halves stay contiguous with each other and with their
 * neighbours, so the grid is never torn, and the whole list is re-keyed
 * top-to-bottom for the exporter.
 */
export function splitRowBand(box: PageBox, key: string): PageBox {
  const rows = box.rowBands ?? [];
  const target = rows.find((b) => b.key === key);
  if (!target) return box;

  const mid = (target.start + target.end) / 2;
  if (!(mid > target.start) || !(mid < target.end)) return box; // too thin to split

  const halves: GeometryBand[] = [
    { key: `${target.key}-top`, start: mid, end: target.end },
    { key: `${target.key}-bottom`, start: target.start, end: mid },
  ];
  const next = rows.flatMap((b) => (b.key === key ? halves : [b]));
  return { ...box, rowBands: resequenceRows(next) };
}

/**
 * Append a new row of the SAME height directly below the bottom row (U4, R4).
 *
 * The "extend this table down the page" gesture, distinct from `splitRowBand`'s
 * "one printed row read as two": drawing the outer box seeds a few rows, and
 * this replicates their spacing so a long grid is finished one uniform row at a
 * time instead of splitting a band into ever-smaller halves. The pitch is the
 * current rows' AVERAGE height, so it matches an even seed exactly and stays
 * sensible after manual nudges.
 *
 * The new band drops straight below the bottom row and the segment box grows
 * down to contain it, clamped to the page bottom (PDF y=0). If less than a
 * point of room remains the box is returned unchanged — a row cannot spill off
 * the page. Re-keyed top-to-bottom for the exporter, like the other row edits.
 */
export function appendRowBelow(box: PageBox): PageBox {
  const rows = box.rowBands ?? [];
  if (rows.length === 0) return box;

  // `start` is a band's bottom edge (PDF is bottom-up), so the smallest `start`
  // is the visually lowest row. Bands are contiguous, so the average height is
  // the uniform pitch when the grid is even and a fair pitch when it is not.
  const bottom = rows.reduce((lo, b) => (b.start < lo.start ? b : lo), rows[0]!);
  const avgHeight = rows.reduce((sum, b) => sum + (b.end - b.start), 0) / rows.length;

  const newStart = Math.max(bottom.start - avgHeight, 0);
  if (bottom.start - newStart < 1) return box; // no room left below on the page

  const appended: GeometryBand = { key: 'r-appended', start: newStart, end: bottom.start };
  const rowBands = resequenceRows([...rows, appended]);

  // Grow the box downward to hold the new band; never shrink it, clamp to page.
  const top = box.y + box.height;
  const y = Math.max(Math.min(box.y, newStart), 0);
  return { ...box, y, height: top - y, rowBands };
}

/**
 * Delete a row divider by removing one band and closing the gap (U4, R4).
 *
 * The removed band's span is absorbed by a neighbour so the grid stays
 * contiguous — the band below extends up over it, or, for the bottom row, the
 * band above extends down. Refuses to delete the only row (a table needs at
 * least one). Re-keyed top-to-bottom, as `splitRowBand`.
 */
export function deleteRowBand(box: PageBox, key: string): PageBox {
  const sorted = [...(box.rowBands ?? [])].sort((a, b) => b.end - a.end); // top-to-bottom
  if (sorted.length <= 1) return box;

  const idx = sorted.findIndex((b) => b.key === key);
  if (idx < 0) return box;

  const target = sorted[idx]!;
  const next = sorted.filter((b) => b.key !== key);
  if (idx < sorted.length - 1) {
    // Extend the band below upward to cover the vacated span.
    const below = sorted[idx + 1]!;
    const j = next.findIndex((b) => b.key === below.key);
    next[j] = { ...below, end: target.end };
  } else {
    // The bottom row: the band above extends down instead.
    const above = sorted[idx - 1]!;
    const j = next.findIndex((b) => b.key === above.key);
    next[j] = { ...above, start: target.start };
  }
  return { ...box, rowBands: resequenceRows(next) };
}

/** The panel state for a field, given what has been proposed and confirmed. */
export function panelState(
  field: Pick<FormField, 'type' | 'columns'>,
  proposal: PageBox | undefined,
  confirmed: boolean,
  derived: TableProposal | null,
): GeometryPanelState {
  const unsupported = unsupportedReason(field);
  if (unsupported) return { kind: 'unsupported', reason: unsupported };

  if (proposal) {
    // A table whose proposal carries no columns is a drawn OUTER box awaiting
    // its grid (U4) — offer subdivision, not confirm. A scalar's band-less box
    // is its final placement and stays `proposed`, so this only diverts tables.
    const hasGrid = (proposal.columnBands?.length ?? 0) > 0;
    if (field.type === 'repeating_group' && !hasGrid) {
      return {
        kind: 'needs-subdivision',
        box: proposal,
        reason:
          'You’ve drawn this table’s box. Detect the grid inside it, or seed the rows and columns and adjust them by hand. Nothing is placed on the export until you confirm.',
      };
    }
    return {
      kind: 'proposed',
      segment: proposal,
      confidence: derived?.confidence ?? 1,
      notes: derived?.notes ?? [],
      confirmed,
      // Provenance travels only where a table derivation stands behind the
      // proposal — a scalar's box or a hand-drawn grid carries no claim about
      // how columns were found, so it gets no caption (R7).
      ...(derived ? { columnEvidence: derived.columnEvidence } : {}),
    };
  }

  /*
    A non-table field has no GRID to derive — its value prints in one place. It
    may still have a box, measured off the printed write-on line beside its
    caption; the panel offers that separately, because it is one box rather than
    a grid and a reviewer confirms it differently.

    This still returns `draw-only` so the copy names the action always
    available. Do not read it as "nothing can be proposed for a scalar" — that
    was true until the ruled-cell rule, and a stale comment asserting the
    opposite of the code is how the next reader gets it wrong (R5).
  */
  if (field.type !== 'repeating_group') {
    return {
      kind: 'draw-only',
      reason:
        'Draw a box on the PDF where this field’s value should print, then confirm it. Until you do, the form still publishes and exports this answer as data.',
    };
  }

  return {
    kind: 'no-proposal',
    reason:
      'The page did not give enough signal to place this table confidently, so nothing could be placed automatically. That is fine to leave — the form still publishes and exports its answers as data. To place it yourself, draw the table’s box on the PDF and lay out its grid inside it.',
  };
}

/**
 * Which derivation family `deriveProposal` would dispatch a field to, or null
 * for a field the engine has no derivation for (a scalar, a section header).
 *
 * THE PLACEMENT RECORDER'S METHOD SOURCE, kept beside the dispatch predicates
 * it mirrors so the recorder and the screen cannot disagree with the
 * dispatcher: `GeometryEditorScreen`'s `isMatchAnchorField` / `isPerOptionField`
 * delegate to this, and `deriveProposal` branches on those. The order matters
 * for the same reason it does there — a matching question IS a choice field,
 * so it must be claimed before the option-cell test. A new derivation family
 * (or a new placement action) must extend this AND feed the recorder, or the
 * hit-rate metric silently undercounts it.
 */
export function derivationMethodOf(
  field: Pick<FormField, 'type' | 'options' | 'printSelectedValue'>,
): DerivationMethod | null {
  if (isChoiceField(field.type) && !field.printSelectedValue && (field.options?.length ?? 0) > 0) {
    return isMatchingQuestion(field.options) ? 'match-anchor' : 'option-cells';
  }
  if (field.type === 'repeating_group') return 'table';
  return null;
}

/**
 * Which confidence tier a proposal falls into, for the auto-detect flow (U1,
 * R1/R2).
 *
 * Reuses the exact boundary `panelState` already treats as clean:
 * `confidence === 1` is a full match with nothing inferred, versus
 * `confidence < 1` — which `panelState` already surfaces as a caution note —
 * needing a reviewer's eyes. `null` means detection found nothing to propose
 * at all, which is its own tier rather than a low-confidence `needs-review`:
 * there is no box to review, only a field to hand-place.
 */
export type ProposalTier = 'auto-confirm' | 'needs-review' | 'no-match';

export function classifyProposalTier(
  proposal: FieldProposal | TableProposal | null,
): ProposalTier {
  if (!proposal) return 'no-match';
  return proposal.confidence === 1 ? 'auto-confirm' : 'needs-review';
}

/** One field-level edit to fold into a batch (U2/KTD3). */
export interface FieldChange {
  fieldId: string;
  change: (field: FormField) => FormField;
}

/**
 * Apply every change in one pass over a single snapshot (U2/KTD3).
 *
 * `GeometryEditorScreen`'s `mutate()` used to recompute `fields.map(...)` fresh
 * off the SAME pre-click `fields` snapshot for every call, so N synchronous
 * `mutate()` calls inside one handler — the "Place all N" button already loops
 * once per segment, and a later bulk auto-confirm will loop once per field —
 * left only the LAST call's `setEdited(...)` result in state: every earlier
 * change in the batch was silently discarded. Folding every change over one
 * accumulating snapshot here, in a pure function `GeometryEditorScreen` calls
 * from a single functional `setState` updater, is what makes calling this once
 * with the whole batch correct regardless of how many changes land on the same
 * field or how many fields are touched.
 *
 * Changes targeting the same `fieldId` apply in ARRAY ORDER against the
 * accumulating result, not all against the original snapshot — so two changes
 * to one field (place one option, then another) compose instead of the second
 * clobbering the first.
 */
export function applyFieldChanges(
  fields: readonly FormField[],
  changes: readonly FieldChange[],
): FormField[] {
  let next: FormField[] = [...fields];
  for (const { fieldId, change } of changes) {
    next = next.map((f) => (f.id === fieldId ? change(f) : f));
  }
  return next;
}

/**
 * Move fields' boxes to another page, SAME position.
 *
 * The duplicated-checklist paper: Parts 2, 4 and 6 print the identical
 * practical checklist on three different pages, and detection — matching by
 * the text layer — lands all three parts' boxes on the first page that
 * matches. The x/y/w/h it found are RIGHT (the layouts are identical); only
 * the page is wrong, and redrawing thirty well-positioned boxes to fix a
 * page number is the tedium this removes: every segment (bands and option
 * keys intact) is re-stamped onto the target page verbatim.
 *
 * Fields with no boxes are skipped rather than given empty geometry, so a
 * section-level move can be handed headers and unplaced fields freely.
 */
export function retargetPageChanges(
  fields: readonly FormField[],
  fieldIds: readonly string[],
  page: number,
): FieldChange[] {
  const wanted = new Set(fieldIds);
  const changes: FieldChange[] = [];
  for (const field of fields) {
    if (!wanted.has(field.id)) continue;
    const segments = field.geometry?.segments ?? [];
    if (segments.length === 0) continue;
    if (segments.every((s) => s.page === page)) continue;
    changes.push({
      fieldId: field.id,
      change: (f) => ({
        ...f,
        geometry: {
          ...f.geometry!,
          segments: (f.geometry?.segments ?? []).map((s) => ({ ...s, page })),
        },
      }),
    });
  }
  return changes;
}

/**
 * Propose one checkmark box per option for a NON-TABLE choice field, across the
 * whole document.
 *
 * The counterpart to `deriveAcrossPages`, for the shape the assessment tools
 * actually take: the extraction profile emits one field per printed question,
 * so a page of theory questions is geometrically a table that no table
 * derivation ever sees. Each field is matched to its own printed row by label.
 *
 * Scans every page and refuses on AMBIGUITY across the document, not merely
 * within a page — the dozer repeats "Wearing correct PPE" under several parts,
 * and placing the mark under the wrong one records an assessment against a
 * criterion nobody checked. One confident hit, or nothing.
 *
 * A `window` softens exactly one of those refusals: ambiguous document-wide
 * but unique INSIDE the field's extraction window places, capped below
 * auto-confirm and naming the excluded pages (R2/R5). Ambiguity inside the
 * window still refuses, and no window means the original loop, verbatim.
 */
export function deriveOptionCellsAcrossPages(
  field: { label: string; options?: string[] },
  pages: readonly TextPage[],
  window?: PageWindow | null,
): FieldProposal | null {
  if (!field.options || field.options.length < 2) return null;

  const proposeOnPage = (i: number, page: TextPage): FieldProposal | null => {
    const input = {
      page: i,
      pageWidth: page.width,
      pageHeight: page.height,
      items: page.items,
      label: field.label,
      options: field.options!,
    };

    // Two shapes, tried in order and mutually exclusive by construction. The
    // column rule refuses a field whose options are printed in its row; the
    // inline rule refuses one whose options are column glyphs, because those
    // are not printed beside the question at all. Neither can claim the other's
    // field, so the order is for clarity rather than precedence.
    return proposeFieldOptionCells(input) ?? proposeInlineOptionCells(input);
  };

  if (!window) {
    const hits: FieldProposal[] = [];
    for (const [i, page] of pages.entries()) {
      const p = proposeOnPage(i, page);
      if (p) hits.push(p);
      // Two pages both claiming this question is the ambiguous case that matters;
      // stop as soon as it is established rather than scanning on.
      if (hits.length > 1) return null;
    }

    return hits[0] ?? null;
  }

  // Windowed: the scan runs FULL, because the note has to name every excluded
  // page — but a second IN-WINDOW hit is a refusal nothing later in the
  // document can undo, so it exits just as early as the loop above (KTD4).
  const hits: { page: number; proposal: FieldProposal }[] = [];
  let insideHits = 0;
  for (const [i, page] of pages.entries()) {
    const p = proposeOnPage(i, page);
    if (!p) continue;
    hits.push({ page: i, proposal: p });
    if (i >= window.first && i <= window.last && ++insideHits > 1) return null;
  }

  return proposalThroughWindow(hits, window);
}

/**
 * Propose every anchor of a matching question, across the whole document.
 *
 * The counterpart to `deriveOptionCellsAcrossPages`, for the one field shape
 * that derivation cannot read: a matching question's options are PAIRINGS, and a
 * pairing is a thing the candidate might do rather than a thing the page prints,
 * so matching a field's options against the text layer could only ever hit by
 * coincidence. Its printed ENTRIES are what exist, and anchors are keyed to
 * those.
 *
 * Same refusal on document-wide ambiguity, and for the same reason: a question
 * claimed by two pages is a question the document does not place, and anchoring
 * the wrong page's copy draws every one of the candidate's lines onto text they
 * never read.
 *
 * Same window semantics as `deriveOptionCellsAcrossPages`, too: unique inside
 * the window places capped-and-noted, ambiguous inside it refuses, and no
 * window is the original loop, verbatim (R2–R6).
 */
export function deriveMatchAnchorsAcrossPages(
  anchors: readonly MatchAnchorSpec[],
  pages: readonly TextPage[],
  window?: PageWindow | null,
): FieldProposal | null {
  if (anchors.length < 2) return null;

  const proposeOnPage = (i: number, page: TextPage): FieldProposal | null =>
    proposeMatchAnchorCells({
      page: i,
      pageWidth: page.width,
      pageHeight: page.height,
      items: page.items,
      anchors,
    });

  if (!window) {
    const hits: FieldProposal[] = [];
    for (const [i, page] of pages.entries()) {
      const p = proposeOnPage(i, page);
      if (p) hits.push(p);
      if (hits.length > 1) return null;
    }

    return hits[0] ?? null;
  }

  // Full scan for the note's excluded pages; early refusal at the second
  // in-window hit, exactly as the option-cell scan (KTD4).
  const hits: { page: number; proposal: FieldProposal }[] = [];
  let insideHits = 0;
  for (const [i, page] of pages.entries()) {
    const p = proposeOnPage(i, page);
    if (!p) continue;
    hits.push({ page: i, proposal: p });
    if (i >= window.first && i <= window.last && ++insideHits > 1) return null;
  }

  return proposalThroughWindow(hits, window);
}

/* ------------------------------------------------------------------ *
 * Whole-box movement
 *
 * Everything above moves a band EDGE — which is the right tool for saying which
 * option column a mark belongs in, and the wrong one for "this whole box is two
 * points too high". Placing a box was one-shot until now: it snapped where it
 * landed and the only correction was to delete it and draw it again, on a
 * screen where a real paper carries three hundred of them.
 * ------------------------------------------------------------------ */

/**
 * How far a whole box moves per coarse nudge, in PDF points.
 *
 * Ten steps of `NUDGE_POINTS`, so Shift+arrow and ten arrows land in exactly the
 * same place — a coarse step that is not a multiple of the fine one makes the
 * two disagree about where a box ends up, and an author who used both cannot
 * predict either.
 */
export const NUDGE_POINTS_COARSE = NUDGE_POINTS * 10;

/** The step one arrow-key press moves a selected box. */
export function nudgeStep(coarse: boolean): number {
  return coarse ? NUDGE_POINTS_COARSE : NUDGE_POINTS;
}

/**
 * A delta clamped so the box stays wholly on its page.
 *
 * A box dragged off the edge is not a placement — the exporter would draw its
 * mark outside the media box, where it does not appear on the printed page at
 * all. That reads on a competency record as a mark nobody made, which is the
 * same silence a missing outcome box produces.
 *
 * Clamps the DELTA rather than the resulting box, so a drag that would overshoot
 * slides along the edge instead of stopping dead: the axis that still has room
 * keeps moving.
 */
export function clampDelta(
  segment: Pick<PageBox, 'x' | 'y' | 'width' | 'height' | 'pageWidth' | 'pageHeight'>,
  dx: number,
  dy: number,
): { dx: number; dy: number } {
  return {
    dx: Math.max(-segment.x, Math.min(dx, segment.pageWidth - segment.width - segment.x)),
    dy: Math.max(-segment.y, Math.min(dy, segment.pageHeight - segment.height - segment.y)),
  };
}

/**
 * Move a whole placement box, bands and all.
 *
 * THE BANDS MOVE WITH IT, AND THAT IS THE WHOLE POINT. `GeometryBand.start` /
 * `end` are absolute PDF-point coordinates in the same space as `PageBox.x` /
 * `y` — `markPlacement` reads `columnBand.start` directly as the mark's x. Move
 * the outline without moving the bands and the box lands where the author put
 * it while every mark it draws stays where it was, so the preview agrees with
 * nothing and the export puts ticks in the wrong cells. Column bands follow the
 * x delta, row bands the y delta.
 *
 * Returns the SAME segment when the clamped delta is zero, so a drag held
 * against the page edge produces no re-render and a nudge at the boundary is a
 * no-op rather than a churn of identical states.
 */
export function moveSegment(segment: PageBox, dx: number, dy: number): PageBox {
  const clamped = clampDelta(segment, dx, dy);
  if (clamped.dx === 0 && clamped.dy === 0) return segment;

  const shift = (bands: GeometryBand[] | undefined, by: number) =>
    bands?.map((b) => ({ ...b, start: b.start + by, end: b.end + by }));

  const columnBands = shift(segment.columnBands, clamped.dx);
  const rowBands = shift(segment.rowBands, clamped.dy);

  return {
    ...segment,
    x: segment.x + clamped.dx,
    y: segment.y + clamped.dy,
    ...(columnBands ? { columnBands } : {}),
    ...(rowBands ? { rowBands } : {}),
  };
}

/** Which way an arrow key moves a box, in PDF points. */
export const ARROW_DELTAS: Record<string, { dx: number; dy: number }> = {
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
  // PDF y grows UPWARD, and the screen's y grows downward. ArrowUp has to mean
  // "up the printed page", so it is a POSITIVE y here. Getting this backwards
  // sends every box the wrong way and reads as the control being broken.
  ArrowUp: { dx: 0, dy: 1 },
  ArrowDown: { dx: 0, dy: -1 },
};

/**
 * The move one key press means, or null if the key is not a movement key.
 *
 * Null rather than a zero delta, so a caller can tell "this key is not mine"
 * from "this key moved nothing" and leave the event unhandled — swallowing every
 * keystroke on a screen with a filter box would stop an author typing in it.
 */
export function keyMove(key: string, coarse: boolean): { dx: number; dy: number } | null {
  const direction = ARROW_DELTAS[key];
  if (!direction) return null;
  const step = nudgeStep(coarse);
  return { dx: direction.dx * step, dy: direction.dy * step };
}

/** Whether a key press should remove the selected box. */
export function isDeleteKey(key: string): boolean {
  return key === 'Delete' || key === 'Backspace';
}

/**
 * Drop one page's box from a field's geometry.
 *
 * Returns undefined when the last segment goes, rather than an empty geometry:
 * `geometry.ts` treats an absent footprint as "not placed", and a geometry
 * carrying zero segments is a third state nothing downstream reads — it would
 * pass a "has geometry" check and then draw nothing.
 */
export function removeSegment(
  segments: readonly PageBox[],
  page: number,
  optionKey?: string,
): PageBox[] | undefined {
  const next = segments.filter(
    (s) => !(s.page === page && (s.optionKey ?? undefined) === (optionKey ?? undefined)),
  );
  if (next.length === segments.length) return segments as PageBox[];
  return next.length > 0 ? next : undefined;
}

/**
 * Replace the box on ONE page carrying a given option key with `next` — the
 * page-scoped write a band-edge drag and a whole-box move both route through.
 *
 * A repeating table that spans a page break has several whole-field boxes, ALL
 * with a null option key; matching on the key alone rewrites every page's box to
 * the one being edited, collapsing the continuation onto the edited page.
 * Scoping the match to `page` as well keeps each page's box independent. Returns
 * the input array reference unchanged when nothing matches, so a caller can skip
 * a no-op write.
 */
export function replaceSegmentOnPage(
  segments: readonly PageBox[],
  optionKey: string | null,
  page: number,
  next: PageBox,
): PageBox[] {
  const matches = (s: PageBox) => (s.optionKey ?? null) === optionKey && s.page === page;
  if (!segments.some(matches)) return segments as PageBox[];
  return segments.map((s) => (matches(s) ? next : s));
}
