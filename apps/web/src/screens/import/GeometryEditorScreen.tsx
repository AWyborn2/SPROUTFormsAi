import { useCallback, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Icon, useToast } from '@formai/ui';
import {
  geometrySegments,
  isChoiceField,
  isMatchingQuestion,
  matchAnchors,
  GLYPH_KINDS,
  GLYPH_LABELS,
  type FormField,
  type GlyphKind,
  type MatchAnchor,
  type PageBox,
} from '@formai/shared';
import { useFormVersion, usePublishFormVersion, useSaveVersionFields } from '../../lib/data/hooks.js';
import type { FieldProposal, TableProposal, TextPage } from '../../lib/pdf-geometry.js';
import {
  proposeManualGrid,
  proposeRectGrid,
  proposeRowCell,
  rowCellIndex,
} from '../../lib/pdf-geometry.js';
import {
  groupFields,
  overallCounts,
  pairsFor,
  type PlacementPair,
} from './placement-list.js';
import { markSentence } from '../../lib/mark-description.js';
import { PdfViewer } from './PdfViewer.js';
import {
  applyFieldChanges,
  classifyProposalTier,
  deriveAcrossPages,
  deriveMatchAnchorsAcrossPages,
  deriveOptionCellsAcrossPages,
  handleAdjustment,
  isDeleteKey,
  keyMove,
  moveSegment,
  removeSegment,
  moveBand,
  moveBoundary,
  snapTargets,
  snapTargetsY,
  type BandHandle,
  type FieldChange,
} from './inspector/geometry-actions.js';

/**
 * Placing field geometry on an EXISTING form, without re-importing it.
 *
 * Why this screen exists at all: geometry could previously only be drawn during
 * import review, and re-importing re-extracts, which re-assigns every field id.
 * An assessment tool's manifest, answer keys and outcome targets are all keyed
 * to those ids, so re-importing a form to fix its placement silently invalidated
 * the tool built on it. Forking the published version into a draft keeps every
 * id; only the placement changes.
 *
 * It edits a DRAFT and never a published version. Submissions pin to a version,
 * so rewriting one rewrites what already-signed records render against — the API
 * refuses it, and this screen does not offer it.
 *
 * Two gates before anything is persisted: an automatic proposal has to be
 * APPLIED, and the draft has to be SAVED. A proposal a reviewer never looked at
 * would otherwise put marks on a competency record against boxes nobody checked.
 */
/**
 * Where this screen gets the version it edits (KTD7).
 *
 * ONE COMPONENT, TWO MOUNTS. The standalone route reads the ids off the URL;
 * the builder's placement step passes them in, because there the version is one
 * artifact of a draft rather than the thing being navigated to. Everything else
 * — the proposals, the confirm gate, the geometry writes — is identical, which
 * is the point: a second placement UI is a second place for "only confirmed
 * geometry is published" to be got wrong.
 */
export interface GeometryEditorScreenProps {
  formId?: string;
  versionId?: string;
  /**
   * Hide the screen's own PAGE CHROME — its title and its Publish button — for
   * a host that supplies both. Deliberately not "hide the toolbar": Auto-place
   * and Save are this screen's work, not the host's, and a host that hides them
   * has a placement step nothing can be saved from.
   */
  embedded?: boolean;
  /** Where Back goes. Defaults to the form's own page. */
  onDone?: () => void;
  /**
   * The saved field list, handed back after every successful save.
   *
   * For a host that keeps its own copy of the fields and publishes THAT — the
   * assessment builder does. Without it the geometry reaches the version and is
   * then overwritten by the host's copy at publish, with nothing on screen to
   * say so.
   */
  onSaved?: (fields: FormField[]) => void;
}

export function GeometryEditorScreen({
  formId: formIdProp,
  versionId: versionIdProp,
  embedded = false,
  onDone,
  onSaved,
}: GeometryEditorScreenProps = {}) {
  const params = useParams<{ id: string; versionId: string }>();
  // Props win where given; the route is the fallback, so the standalone screen
  // is unchanged and needs no call-site edit.
  const formId = formIdProp ?? params.id;
  const versionId = versionIdProp ?? params.versionId;
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data: version, isLoading } = useFormVersion(formId, versionId);
  const save = useSaveVersionFields(formId ?? '', versionId ?? '');
  const publish = usePublishFormVersion();

  /**
   * The working copy. Seeded from the fetched version and then owned here —
   * every draw and every applied proposal lands in this array, and nothing
   * reaches the server until Save.
   */
  const [edited, setEdited] = useState<FormField[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [textPages, setTextPages] = useState<readonly TextPage[]>([]);
  /**
   * Why the last drawn table box could not be subdivided, and for which field.
   *
   * Held rather than derived because it is a fact about ONE GESTURE, not about
   * the field's current state: the box is on the page either way, so nothing
   * in the saved geometry can be inspected afterwards to recover why it has no
   * bands.
   */
  const [gridRefusal, setGridRefusal] = useState<{
    fieldId: string;
    title: string;
    detail: string;
  } | null>(null);
  /** Which box the next drag fills, or null when drawing is not armed. */
  const [drawTarget, setDrawTarget] = useState<DrawTarget | null>(null);
  const [dirty, setDirty] = useState(false);
  /**
   * The proposal(s) currently parked for review — every field that tiered
   * `needs-review` (U3/R2) and hasn't been applied or dismissed yet. An
   * `auto-confirm` tier is applied immediately instead of parked here, and a
   * `no-match` tier has nothing to park.
   *
   * A list rather than a single entry: `selectField` still only ever puts one
   * field in it, but the bulk "Auto-place remaining fields" pass (U4) can
   * surface several needs-review fields from one run, so the shape is
   * generalized to hold all of them. No UI reads this array yet — a
   * bulk-review queue (step through, confirm, reject) is U5's job, not this
   * unit's. Nothing beyond storage is built here.
   */
  const [proposalPreviews, setProposalPreviews] = useState<
    { fieldId: string; proposal: FieldProposal | TableProposal }[]
  >([]);
  /** Busy flag around the bulk auto-place pass (U4), for the button's affordance. */
  const [isAutoPlacing, setIsAutoPlacing] = useState(false);

  const fields = edited ?? version?.fields ?? [];
  const selected = fields.find((f) => f.id === selectedId) ?? null;

  /*
    THE LIST IS GROUPED, COUNTED AND FILTERABLE (U15).

    The Track Dozer paper produces roughly three hundred boxes, and this list
    was a flat run of them — the two-hour manual session the runbook describes
    is mostly navigating it. Grouping by the printed heading turns "where am I"
    into a glance; the per-group counts turn "am I finished" into a number.

    UP HERE WITH EVERY OTHER HOOK, above the conditional early returns further
    down — see `overlay` below for the rule. These six sat under those returns
    and crashed the builder's PDF-mapping step outright: the version is fetched
    fresh there, so the first render always took the `isLoading` return and the
    second ran six hooks the first never did.
  */
  const [filter, setFilter] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  const groups = useMemo(() => groupFields(fields, expectedBoxes, filter), [fields, filter]);
  const counts = useMemo(() => overallCounts(fields, expectedBoxes), [fields]);

  /*
    A question and its outcome box are ONE row, with two chips.

    Both are geometry — the response on the question field, the outcome on the
    field its `outcomeTarget` names — but they are one unit of authoring work.
    Shown as two unrelated rows among three hundred, one of them is how the
    other ends up unplaced, and the export then draws a candidate's answer with
    no verdict beside it.
  */
  const pairByQuestion = useMemo(() => {
    const map = new Map<string, PlacementPair>();
    for (const pair of pairsFor(fields)) map.set(pair.question.id, pair);
    return map;
  }, [fields]);

  /*
    An outcome box does not ALSO get a row of its own — it is reachable through
    its question's chip. A second row for it is exactly the split this unit
    exists to close.

    BUT ONLY WHERE THE QUESTION IS ACTUALLY SHOWN, and that qualifier was
    missing. The justification for hiding the box is that it is reachable
    somewhere else; when the question is behind the search filter, the box was
    reachable through NOTHING and simply vanished from the placement session —
    with the header still counting it, so the list read as having fewer boxes
    left than it had. An author hunting for a cell they could see on the page
    and not in the list had no way to place it.

    Reachability is computed from the RENDERED groups rather than from the
    field list, because the filter is what decides which questions are on
    screen. A box whose question is filtered out gets its own row again.
  */
  const pairedOutcomeIds = useMemo(() => {
    const shownQuestions = new Set(groups.flatMap((g) => g.fields.map((f) => f.id)));
    const reachable = new Set<string>();
    for (const pair of pairsFor(fields)) {
      if (pair.outcome && shownQuestions.has(pair.question.id)) reachable.add(pair.outcome.id);
    }
    return reachable;
  }, [fields, groups]);

  const onTextLayer = useCallback((pages: TextPage[]) => setTextPages(pages), []);

  /**
   * The band grid currently shown in the editor, and where an edit to it
   * lands (R7/R8/U6) — see `bandOverlayFor`. Computed as a hook (not inline
   * below the early returns further down) because those returns are
   * conditional and every hook in this component must run on every render.
   */
  const overlay = useMemo(
    () => bandOverlayFor(drawTarget, selectedId, proposalPreviews, fields),
    [drawTarget, selectedId, proposalPreviews, fields],
  );
  const bandOverlay = overlay?.box ?? null;

  /**
   * Where a dragged band edge may land, from the overlay page's own text —
   * the same `snapTargets`/`snapTargetsY` helpers and reasoning
   * `ImportReviewScreen` uses (U10/U3): this screen already holds the text
   * layer, so the viewer stays a presentational surface that reports a
   * coordinate rather than deciding what a legal one is.
   */
  const bandSnapTargets = useMemo(
    () => (bandOverlay ? snapTargets(textPages[bandOverlay.page]?.items ?? []) : []),
    [bandOverlay?.page, textPages],
  );
  const bandSnapTargetsY = useMemo(
    () => (bandOverlay ? snapTargetsY(textPages[bandOverlay.page]?.items ?? []) : []),
    [bandOverlay?.page, textPages],
  );

  /**
   * A band edge was dragged/nudged to `value` (R7/R8/U6) — routes through the
   * same validated `moveBand`/`moveBoundary` the import review screen's
   * session-map adjustment uses, so a drag, a snap and a keyboard nudge on
   * this screen behave identically to the import review screen (AE5). Writes
   * land wherever `overlay.source` says: a placed segment inside `edited`
   * (via `mutate()`), or — for a parked needs-review proposal — back into
   * `proposalPreviews`, so the proposal stays unconfirmed until the reviewer
   * explicitly applies it (R8's confirm gate).
   */
  function onBandEdge(handle: BandHandle, value: number) {
    if (!overlay) return;
    const adjustment = handleAdjustment(handle);
    if (!adjustment) return;
    const next =
      adjustment.kind === 'boundary'
        ? moveBoundary(overlay.box, handle.axis, adjustment.leftKey, adjustment.rightKey, value)
        : moveBand(overlay.box, handle.axis, adjustment.key, adjustment.edge, value);
    if (!next) return;

    if (overlay.source.kind === 'preview') {
      const { fieldId } = overlay.source;
      setProposalPreviews((prev) =>
        prev.map((p) => (p.fieldId === fieldId && 'segment' in p.proposal ? { ...p, proposal: { ...p.proposal, segment: next } } : p)),
      );
      return;
    }

    const { fieldId, optionKey } = overlay.source;
    mutate(fieldId, (f) => {
      const segments = f.geometry?.segments ?? [];
      if (!segments.some((s) => (s.optionKey ?? null) === optionKey)) return f;
      return {
        ...f,
        geometry: { segments: segments.map((s) => ((s.optionKey ?? null) === optionKey ? next : s)) },
      };
    });
  }

  /**
   * Move the box currently shown in the editor, whole.
   *
   * ROUTED THROUGH THE SAME OVERLAY AND THE SAME `mutate` AS A BAND EDGE, so
   * there is still ONE movement path: `bandOverlay` decides which box is being
   * worked on and where a change to it lands, exactly as `onBandEdge` does. A
   * second path would be a second place for the preview/placed distinction to
   * be got wrong — and getting it wrong writes a parked proposal into the
   * confirmed set, which is the gate `geometry.ts` documents.
   *
   * `moveSegment` moves the bands with the box, because they are absolute
   * coordinates in the same space and `markPlacement` reads them directly.
   */
  function moveOverlayBox(dx: number, dy: number) {
    if (!overlay) return;
    const next = moveSegment(overlay.box, dx, dy);
    // Clamped to nothing — the box is already against the page edge.
    if (next === overlay.box) return;

    if (overlay.source.kind === 'preview') {
      const { fieldId } = overlay.source;
      setProposalPreviews((prev) =>
        prev.map((p) =>
          p.fieldId === fieldId && 'segment' in p.proposal
            ? { ...p, proposal: { ...p.proposal, segment: next } }
            : p,
        ),
      );
      return;
    }

    const { fieldId, optionKey } = overlay.source;
    mutate(fieldId, (f) => {
      const segments = f.geometry?.segments ?? [];
      if (!segments.some((sg) => (sg.optionKey ?? null) === optionKey)) return f;
      return {
        ...f,
        geometry: { segments: segments.map((sg) => ((sg.optionKey ?? null) === optionKey ? next : sg)) },
      };
    });
  }

  /**
   * Delete the box currently shown in the editor.
   *
   * Only a PLACED box. A parked proposal is not a placement — it has never been
   * confirmed — and "deleting" one would silently discard a suggestion the
   * reviewer can simply decline instead, with no way back to it.
   */
  function deleteOverlayBox() {
    if (!overlay || overlay.source.kind !== 'segment') return;
    const { fieldId, optionKey } = overlay.source;
    mutate(fieldId, (f) => {
      const next = removeSegment(f.geometry?.segments ?? [], overlay.box.page, optionKey ?? undefined);
      if (next === f.geometry?.segments) return f;
      return next ? { ...f, geometry: { segments: next } } : stripGeometry(f);
    });
  }

  /**
   * Arrow keys nudge the shown box; Delete removes it.
   *
   * Ignores a key press coming from a text input, so typing in the field filter
   * does not walk a box across the page — and returns without preventing the
   * default for any key it does not own, so every other shortcut on the screen
   * still works.
   */
  function onEditorKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
    if (!overlay) return;

    if (isDeleteKey(e.key)) {
      e.preventDefault();
      deleteOverlayBox();
      return;
    }

    const move = keyMove(e.key, e.shiftKey);
    if (!move) return;
    e.preventDefault();
    moveOverlayBox(move.dx, move.dy);
  }

  /**
   * Apply one field-level edit.
   *
   * Routes through the functional `setState` updater rather than closing over
   * the render's `fields` — `prev` is guaranteed correct even when `mutate` is
   * called more than once synchronously in the same handler (KTD3), because
   * React threads each functional update through the last one's result before
   * anything re-renders. `applyFieldChanges` still does the actual field-array
   * rewrite, so a single edit and a batch of edits (`mutateMany`) share one
   * code path.
   */
  function mutate(fieldId: string, change: (f: FormField) => FormField) {
    setEdited((prev) => applyFieldChanges(prev ?? fields, [{ fieldId, change }]));
    setDirty(true);
  }

  /**
   * Apply several field-level edits as ONE batch (U2).
   *
   * The safe primitive for anything that used to loop `mutate()` — the
   * "Place all N" button today, and the bulk auto-place / bulk-confirm later
   * units build — because every change in `changes` folds over a single
   * snapshot inside `applyFieldChanges` instead of each call recomputing from
   * the same pre-click `fields`. `selectField`'s auto-confirm path (U3) is the
   * first caller; later units route their own loops through it too.
   */
  function mutateMany(changes: FieldChange[]) {
    if (changes.length === 0) return;
    setEdited((prev) => applyFieldChanges(prev ?? fields, changes));
    setDirty(true);
  }

  /**
   * Select a field and, when it isn't placed yet, propose and auto-tier it
   * (U3/R1/R2) — replacing "Draw" as the first step for most fields.
   *
   * `geometrySegments(field).length === 0` is today's eligibility check; the
   * bulk auto-place pass (U4) uses a more permissive one for a partially-placed
   * field, but selection's own eligibility is unchanged by that unit. R4: an
   * already-placed field is left exactly as it behaves today — selecting it
   * neither re-derives nor re-tiers, it just shows its existing box.
   */
  function selectField(field: FormField) {
    setSelectedId(field.id);
    setDrawTarget(null);
    // Scoped to this field only — every OTHER field's parked needs-review
    // proposal must survive selecting something else in the sidebar. A flat
    // `setProposalPreviews([])` here used to wipe the whole queue on any click.
    setProposalPreviews((prev) => prev.filter((p) => p.fieldId !== field.id));

    if (geometrySegments(field).length > 0) return;

    const proposal = deriveProposal(field, textPages);
    const tier = classifyProposalTier(proposal);
    if (tier === 'no-match') return;

    if (tier === 'needs-review') {
      // Parked for preview only — `edited` stays untouched until the
      // reviewer applies it themselves. Replace only this field's entry.
      setProposalPreviews((prev) => [
        ...prev.filter((p) => p.fieldId !== field.id),
        { fieldId: field.id, proposal: proposal! },
      ]);
      return;
    }

    // auto-confirm: every option's change (or the table's one box) lands in
    // a single `mutateMany` batch, not a loop of individual `mutate()` calls
    // — the exact bug U2 fixed for the "Place all N" button (KTD3).
    mutateMany(changesForProposal(field, proposal!));
  }

  /**
   * Run the same propose-and-tier pass `selectField` runs for one field, across
   * EVERY not-yet-fully-placed field in one go (U4/R3).
   *
   * Eligibility is `geometrySegments(f).length < expectedBoxes(f)` — NOT
   * `=== 0` — so a field with some but not all of its options already placed
   * (e.g. 1 of 3) is still evaluated for its missing options, while a fully
   * placed field is excluded and left bit-for-bit untouched (R4): it is never
   * even handed to `deriveProposal`.
   *
   * Every auto-confirm field's changes are collected into ONE running array
   * and applied with a single `mutateMany` call at the end — the crux of the
   * KTD3 batching fix U2 made for "Place all N", now extended to the bulk
   * pass instead of calling `mutateMany` once per field. needs-review fields
   * are parked into `proposalPreviews`; no-match fields are left alone.
   */
  function autoPlaceRemaining() {
    setIsAutoPlacing(true);

    // Yield a frame first: the loop below is synchronous and, for a large
    // form, long enough that setting isAutoPlacing(true) and (false) in the
    // same tick would otherwise batch into one commit and the "Auto-placing…"
    // state would never actually paint.
    requestAnimationFrame(() => {
      const changes: FieldChange[] = [];
      const reviews: { fieldId: string; proposal: FieldProposal | TableProposal }[] = [];

      for (const field of fields) {
        if (geometrySegments(field).length >= expectedBoxes(field)) continue;

        const proposal = deriveProposal(field, textPages);
        const tier = classifyProposalTier(proposal);
        if (tier === 'no-match') continue;
        if (tier === 'needs-review') {
          reviews.push({ fieldId: field.id, proposal: proposal! });
          continue;
        }
        changes.push(...changesForProposal(field, proposal!));
      }

      if (changes.length > 0) mutateMany(changes);
      if (reviews.length > 0) {
        // Merge rather than replace — a field whose parked proposal the
        // reviewer already fine-tuned via onBandEdge (and every field NOT
        // touched by this pass) must survive a second bulk run.
        const freshIds = new Set(reviews.map((r) => r.fieldId));
        setProposalPreviews((prev) => [...prev.filter((p) => !freshIds.has(p.fieldId)), ...reviews]);
      }

      setIsAutoPlacing(false);
    });
  }

  /**
   * Open a needs-review field from the queue (U5/R5 step-through) without
   * re-running `selectField`'s own derive-and-tier pass — the field's parked
   * proposal in `proposalPreviews` is left exactly as it is. Re-selecting
   * through `selectField` would re-derive and risk landing on a different
   * tier than the one already parked (and would also clear the whole
   * `proposalPreviews` list via its own reset). This is just navigation: show
   * the field's existing box/proposal in the main panel via `selectedId`.
   */
  function openReviewField(fieldId: string) {
    setSelectedId(fieldId);
    setDrawTarget(null);
  }

  /**
   * "Confirm all proposed" (U5/R5 bulk action) — every parked needs-review
   * proposal's changes are collected into ONE `FieldChange[]` and applied
   * with a single `mutateMany` call, the same KTD3-shaped batching every
   * other bulk action in this screen already uses, rather than looping
   * `confirmProposed` once per field.
   */
  function confirmAllProposed() {
    if (proposalPreviews.length === 0) return;

    const changes: FieldChange[] = [];
    for (const { fieldId, proposal } of proposalPreviews) {
      const field = fields.find((f) => f.id === fieldId);
      if (!field) continue;
      changes.push(...changesForProposal(field, proposal));
    }

    mutateMany(changes);
    setProposalPreviews([]);
  }

  /**
   * Confirm ONE needs-review field (U5/R5 step-through) — applies just that
   * field's parked proposal via a single-field `mutateMany` call and removes
   * it from the queue, leaving every other pending field untouched.
   */
  function confirmProposed(fieldId: string) {
    const entry = proposalPreviews.find((p) => p.fieldId === fieldId);
    if (!entry) return;
    const field = fields.find((f) => f.id === fieldId);
    if (!field) return;

    mutateMany(changesForProposal(field, entry.proposal));
    setProposalPreviews((prev) => prev.filter((p) => p.fieldId !== fieldId));
  }

  /**
   * Reject ONE needs-review field (U5/R6) — clears its parked proposal
   * without touching `edited` at all. Once it is out of `proposalPreviews`
   * the existing UI already treats an unplaced field with no active proposal
   * as draw-only, exactly like a `no-match` field — nothing else to build.
   */
  function rejectProposed(fieldId: string) {
    setProposalPreviews((prev) => prev.filter((p) => p.fieldId !== fieldId));
  }

  /** Replace one option's box, keyed by `optionKey`, leaving siblings alone. */
  function setOptionBox(fieldId: string, optionKey: string, box: PageBox | null) {
    mutate(fieldId, (f) => {
      const others = (f.geometry?.segments ?? []).filter((s) => s.optionKey !== optionKey);
      // Placing an option box retires any whole-field box: the exporter reads
      // one shape or the other, and a stale scalar segment left underneath is
      // a second answer to "where does the mark go".
      const kept = box ? others.filter((s) => s.optionKey !== undefined) : others;
      const next = box ? [...kept, { ...box, optionKey }] : kept;
      return next.length > 0 ? { ...f, geometry: { segments: next } } : stripGeometry(f);
    });
  }

  function setScalarBox(fieldId: string, box: PageBox | null) {
    mutate(fieldId, (f) => (box ? { ...f, geometry: { segments: [box] } } : stripGeometry(f)));
  }

  /**
   * A box drawn on a repeating table, subdivided from the checkboxes printed
   * inside it (bounded subdivision, U4).
   *
   * A drawn box alone is one undivided rectangle, and the exporter draws a mark
   * "in the answered column of each row" — so with no bands there are no rows
   * and no column, and nothing anywhere says whether a mark will land in a
   * printed square or on the words beside it. That is the reported gap on the
   * methods table: five checkboxes, one tall box, no way to check it.
   *
   * The existing text derivation cannot close it. It finds columns from header
   * glyphs and rows from label baselines, and a checkbox column has neither —
   * every glyph on those rows is in the label. The squares themselves are the
   * only measurement of where the answer column is.
   *
   * Falls back to the plain box whenever the printed evidence is not a column,
   * because a wrong grid is worse than an honest undivided box: bands are what
   * the reviewer reads to confirm placement, and confident-looking bands in the
   * wrong place is the failure this whole screen is built to prevent.
   */
  function setTableBox(field: FormField, box: PageBox) {
    const result = proposeRectGrid({
      page: box.page,
      pageWidth: box.pageWidth,
      pageHeight: box.pageHeight,
      rects: textPages[box.page]?.rects,
      within: box,
      columns: field.columns,
    });

    /*
      THE REFUSAL IS SHOWN, NOT SWALLOWED. Both outcomes leave a box on the
      page — one subdivided, one not — so without this an author cannot tell
      "I drew it wrong" from "this table declares no answer column", and
      redraws the same box until they conclude the feature is broken. The
      plain box still stands either way: a wrong grid is worse than an honest
      undivided one.
    */
    setGridRefusal(
      result.ok
        ? null
        : { fieldId: field.id, title: 'Placed, but its rows were not measured', detail: result.detail },
    );
    setScalarBox(field.id, result.ok ? result.proposal.segment : box);
  }

  /**
   * One printed row's cell, drawn by hand — the measured grid's manual
   * fallback (the recourse a radio group has always had, U-repeater).
   *
   * Entering row mode retires the whole-grid segment in the same write: both
   * shapes consume value rows, and a field carrying both would mark every row
   * twice. The row index is stored ON the band key (`row:<n>`), so rows the
   * author leaves unplaced can never shift the marks below them.
   */
  function setRowBox(field: FormField, rowIndex: number, box: PageBox) {
    const result = proposeRowCell({ box, rowIndex, columns: field.columns });
    setGridRefusal(
      result.ok ? null : { fieldId: field.id, title: 'Not placed', detail: result.detail },
    );
    if (!result.ok) return;
    mutate(field.id, (f) => {
      const kept = (f.geometry?.segments ?? []).filter((s) => {
        const at = rowCellIndex(s);
        return at !== null && at !== rowIndex;
      });
      const next = [...kept, result.segment].sort(
        (a, b) => (rowCellIndex(a) ?? 0) - (rowCellIndex(b) ?? 0),
      );
      return { ...f, geometry: { segments: next } };
    });
  }

  /**
   * Divide the whole-field drawn box into rows by the author's say-so — the
   * recourse for a page whose printed shapes cannot be measured (U-manual).
   * The seeded bands land on the SAME page the author drew, render as
   * draggable edges through the band overlay, and reach the record only when
   * they save.
   */
  function setManualGrid(field: FormField, rows: number) {
    const box = (field.geometry?.segments ?? []).find(
      (s) => rowCellIndex(s) === null && s.optionKey === undefined,
    );
    if (!box) return;
    const result = proposeManualGrid({
      box,
      rows,
      columns: field.columns,
      fixedRows: field.fixedRows,
    });
    setGridRefusal(
      result.ok ? null : { fieldId: field.id, title: 'Not divided', detail: result.detail },
    );
    if (result.ok) setScalarBox(field.id, result.segment);
  }

  function clearRowBox(fieldId: string, rowIndex: number) {
    mutate(fieldId, (f) => {
      const kept = (f.geometry?.segments ?? []).filter((s) => rowCellIndex(s) !== rowIndex);
      return kept.length > 0 ? { ...f, geometry: { segments: kept } } : stripGeometry(f);
    });
  }

  function restyleRowBox(fieldId: string, rowIndex: number, next: PageBox) {
    mutate(fieldId, (f) => ({
      ...f,
      geometry: {
        segments: (f.geometry?.segments ?? []).map((s) => (rowCellIndex(s) === rowIndex ? next : s)),
      },
    }));
  }

  if (isLoading) {
    return <div className="p-[30px_28px] text-sm text-text-tertiary">Loading version…</div>;
  }

  if (!version) {
    return (
      <div className="fai-rise mx-auto max-w-[720px] p-[30px_28px_60px] text-center">
        <Icon name="file-question" size={30} className="text-text-tertiary" />
        <h1 className="mt-3 font-heading text-lg font-semibold">This version isn't available</h1>
        <Button variant="outline" className="mt-3" onClick={() => navigate('/app/forms')}>
          Back to forms
        </Button>
      </div>
    );
  }

  // A published version is frozen. Say so rather than presenting controls whose
  // every save would 409.
  if (version.state === 'published') {
    return (
      <div className="fai-rise mx-auto max-w-[720px] p-[30px_28px_60px]">
        <h1 className="font-heading text-xl font-semibold">{version.label} is published</h1>
        <p className="mt-2 text-[13.5px] text-text-secondary">
          A published version is frozen — submissions pin to it, so changing its fields would change
          what already-recorded results render against. Fork a draft from the form's version list and
          place geometry on that instead; publishing it keeps every field id, so any assessment tool
          built on this form stays valid.
        </p>
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => (onDone ? onDone() : navigate(`/app/forms`))}
        >
          Back to forms
        </Button>
      </div>
    );
  }

  if (!version.sourcePdfAssetId) {
    return (
      <div className="fai-rise mx-auto max-w-[720px] p-[30px_28px_60px]">
        <h1 className="font-heading text-xl font-semibold">No original PDF</h1>
        <p className="mt-2 text-[13.5px] text-text-secondary">
          Geometry describes where an answer sits on the original document, so there is nothing to
          place boxes against on a form that was built rather than imported.
        </p>
      </div>
    );
  }

  /**
   * Every box on every field, so a reviewer can see what they have already
   * placed instead of only the field they happen to have selected — plus
   * every box a parked needs-review proposal is offering, so that mark is
   * visible too rather than invisible until confirmed (R7/AE5).
   *
   * Saved geometry (`edited`/`fields`) is `confirmed: true`: it is already
   * persisted, or staged for the next Save, and either way a human put it
   * there deliberately (drawn, applied, or auto-confirmed). A field's box is
   * `confirmed: false` for as long as it exists ONLY as a parked
   * `proposalPreviews` entry — extraction's proposal, not yet applied — so
   * the reviewer sees at a glance which marks on the page still need a look,
   * exactly as the import review screen distinguishes proposed from
   * confirmed geometry.
   */
  const placements = [
    ...fields.flatMap((f) =>
      geometrySegments(f).map((box, i) => ({
        slot: `${f.id}#${box.optionKey ?? i}`,
        box,
        confirmed: true,
        active: f.id === selectedId,
      })),
    ),
    ...proposalPreviews.flatMap(({ fieldId, proposal }) => {
      const boxes = 'segment' in proposal ? [proposal.segment] : proposal.segments;
      return boxes.map((box, i) => ({
        slot: `${fieldId}#preview#${box.optionKey ?? i}`,
        box,
        confirmed: false,
        active: fieldId === selectedId,
      }));
    }),
  ];

  return (
    <div className="fai-rise flex h-[calc(100vh-56px)] flex-col">
      {/*
        THE HEADER'S TWO HALVES ARE GATED SEPARATELY.

        `embedded` means "the host already has a page title", NOT "the host has
        its own tools" — the builder has neither an auto-place nor a save of its
        own. Hiding the whole header took Auto-place, Save and the placed/total
        counter with it, which left the builder's PDF-mapping step able to draw
        boxes and unable to keep any of them.

        Only the TITLE and Publish are host chrome: the builder's stepper names
        the step, and it publishes at the end of its own flow rather than here.
      */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-[22px] py-3">
        <div className="min-w-0">
          {!embedded && (
            <h1 className="truncate font-heading text-[16px] font-bold">
              Placement · {version.label}
            </h1>
          )}
          <p className="text-[12.5px] text-text-secondary">
            {counts.placed} of {counts.total} answerable fields placed
            {dirty && <span className="ml-2 text-warning-text">· unsaved changes</span>}
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Button
            variant="outline"
            leadingIcon="wand-sparkles"
            disabled={isAutoPlacing}
            onClick={autoPlaceRemaining}
          >
            {isAutoPlacing ? 'Auto-placing…' : 'Auto-place remaining fields'}
          </Button>
          <Button
            variant="outline"
            leadingIcon="save"
            disabled={!dirty || save.isPending}
            onClick={() =>
              save.mutate(fields, {
                onSuccess: () => {
                  setDirty(false);
                  // The host gets the saved fields too. Writing them only to the
                  // version leaves a host that publishes its own copy — the
                  // builder does — overwriting every box at publish.
                  onSaved?.(fields);
                  toast({ variant: 'success', message: 'Placement saved to the draft.' });
                },
                onError: () => toast({ variant: 'danger', message: "Couldn't save — try again." }),
              })
            }
          >
            {save.isPending ? 'Saving…' : 'Save placement'}
          </Button>
          {!embedded && (
            <Button
              leadingIcon="upload"
              disabled={dirty || publish.isPending}
              title={dirty ? 'Save the draft first' : undefined}
              onClick={() => {
                if (!formId || !versionId) return;
                publish.mutate(
                  { formId, versionId },
                  {
                    onSuccess: () => {
                      toast({ variant: 'success', message: `${version.label} published.` });
                      navigate('/app/forms');
                    },
                    onError: () =>
                      toast({ variant: 'danger', message: "Couldn't publish — try again." }),
                  },
                );
              }}
            >
              Publish version
            </Button>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-[340px] shrink-0 overflow-y-auto border-r border-border">
          {proposalPreviews.length > 0 && (
            <div className="border-b border-border bg-[var(--accent-soft)] p-[12px_14px]">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12.5px] font-semibold">
                  {proposalPreviews.length} field{proposalPreviews.length === 1 ? '' : 's'} need review
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  leadingIcon="check-check"
                  onClick={confirmAllProposed}
                >
                  Confirm all proposed
                </Button>
              </div>
              <div className="mt-2 flex flex-col gap-1.5">
                {proposalPreviews.map(({ fieldId }) => {
                  const field = fields.find((f) => f.id === fieldId);
                  const label = field?.label || fieldId;
                  return (
                    <div key={fieldId} className="flex items-center gap-1.5">
                      <button
                        type="button"
                        aria-label={`Review ${label}`}
                        onClick={() => openReviewField(fieldId)}
                        className={`min-w-0 flex-1 truncate rounded-sm px-1.5 py-1 text-left text-[12px] ${
                          fieldId === selectedId ? 'bg-[var(--accent-soft)] font-semibold' : 'hover:bg-surface-hover'
                        }`}
                      >
                        {label}
                      </button>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Confirm ${label}`}
                        onClick={() => confirmProposed(fieldId)}
                      >
                        Confirm
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Reject ${label}`}
                        onClick={() => rejectProposed(fieldId)}
                      >
                        Reject
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <div className="border-b border-border p-[10px_14px]">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by label or question text…"
              aria-label="Filter fields"
              className="h-[30px] w-full rounded-lg border border-border bg-surface-page px-2.5 text-[12px]"
            />
          </div>

          {groups.map((group) => {
            const isCollapsed = !!collapsedGroups[group.key];
            return (
              <div key={group.key}>
                <button
                  type="button"
                  onClick={() =>
                    setCollapsedGroups((prev) => ({ ...prev, [group.key]: !prev[group.key] }))
                  }
                  aria-expanded={!isCollapsed}
                  className="flex w-full items-center gap-2 border-b border-border-subtle bg-surface-sunken px-[14px] py-2 text-left hover:bg-surface-hover"
                >
                  <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={13} className="flex-none text-text-tertiary" />
                  <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">{group.label}</span>
                  {/*
                    The counts describe the WHOLE group, never what the filter
                    left — "2 of 2" beside a filtered list with thirty unplaced
                    fields behind it reads as finished.
                  */}
                  <span className="flex-none text-[11px] text-text-tertiary">
                    {group.placed}/{group.total}
                  </span>
                </button>

                {!isCollapsed &&
                  group.fields
                    .filter((f) => !pairedOutcomeIds.has(f.id))
                    .map((f) => {
                      const pair = pairByQuestion.get(f.id);
                      return pair ? (
                        <PairRow
                          key={f.id}
                          pair={pair}
                          selectedId={selectedId}
                          onSelect={selectField}
                          fields={fields}
                        />
                      ) : (
                        <FieldRow
                          key={f.id}
                          field={f}
                          selected={f.id === selectedId}
                          onSelect={() => selectField(f)}
                        />
                      );
                    })}
              </div>
            );
          })}

          {groups.length === 0 && (
            <p className="px-[14px] py-3 text-[11.5px] text-text-tertiary">
              No fields match “{filter}”.
            </p>
          )}
        </aside>

        {/*
          The keyboard target for whole-box movement.

          `tabIndex={-1}` makes the column focusable programmatically and by
          click without putting it in the tab order — an author tabbing through
          the screen should reach the controls, not a page canvas. The handler
          itself ignores key presses originating in a text input, so the field
          filter still types.
        */}
        <div
          className="min-w-0 flex-1 outline-none"
          tabIndex={-1}
          onKeyDown={onEditorKeyDown}
          aria-label="Placement canvas — arrow keys nudge the selected box, Delete removes it"
        >
          <PdfViewer
            assetId={version.sourcePdfAssetId}
            selectedFieldId={selectedId}
            onSelectField={setSelectedId}
            onTextLayer={onTextLayer}
            placements={placements}
            bandOverlay={bandOverlay}
            onMoveBox={moveOverlayBox}
            bandSnapTargets={bandSnapTargets}
            bandSnapTargetsY={bandSnapTargetsY}
            onBandEdge={onBandEdge}
            drawArmed={drawTarget !== null}
            drawLine={drawTarget?.toOptionKey !== undefined}
            onDrawBox={(box) => {
              if (!drawTarget) return;
              const { fieldId, optionKey, rowIndex } = drawTarget;
              const target = fields.find((f) => f.id === fieldId);
              if (target?.type === 'repeating_group' && rowIndex !== undefined) {
                setRowBox(target, rowIndex, box);
              } else if (optionKey !== null) setOptionBox(fieldId, optionKey, box);
              else if (target?.type === 'repeating_group') setTableBox(target, box);
              else setScalarBox(fieldId, box);
              setDrawTarget(null);
            }}
            /*
              ONE DRAG, TWO ANCHORS. Both `setOptionBox` calls are safe back to
              back: `mutate` writes through React's functional updater, so the
              second folds over the first's result rather than over the same
              pre-click snapshot — which is the KTD3 bug this screen already
              fixed once for "Place all N".
            */
            onDrawConnector={(from, to) => {
              const target = drawTarget;
              if (!target?.optionKey || !target.toOptionKey) return;
              setOptionBox(target.fieldId, target.optionKey, from);
              setOptionBox(target.fieldId, target.toOptionKey, to);
              /*
                THE MODE STAYS ON, advancing to the next unplaced pair.

                `fields` is one state update behind — the two `setOptionBox`
                calls above have not committed — so the keys just placed are
                passed in rather than read back, or the mode would re-offer the
                pair it has this moment finished.
              */
              const field = fields.find((f) => f.id === target.fieldId);
              setDrawTarget(
                field ? nextConnectTarget(field, [target.optionKey, target.toOptionKey]) : null,
              );
            }}
            className="h-full"
          />
        </div>

        <aside className="w-[320px] shrink-0 overflow-y-auto border-l border-border p-[14px_16px]">
          {selected && gridRefusal?.fieldId === selected.id && (
            /*
              Sits ABOVE the panel so it is read before the controls it
              explains. A refusal is not an error state — the box was placed,
              it just has no bands — so it reads as a warning rather than a
              failure, and it clears itself the next time this field is drawn.
            */
            <div className="mb-3 rounded-lg border border-warning bg-warning-soft p-[10px_12px]">
              <span className="block text-[12px] font-semibold text-warning-text">
                {gridRefusal.title}
              </span>
              <p className="mt-1 text-[11.5px] leading-relaxed text-text-secondary">
                {gridRefusal.detail}
              </p>
            </div>
          )}
          {selected ? (
            <PlacementPanel
              /*
                Remount per field: the panel now carries local state (the
                divide-into-rows count), and carrying one field's typed number
                onto the next field's panel would offer a row count nobody
                chose for it.
              */
              key={selected.id}
              field={selected}
              textPages={textPages}
              drawTarget={drawTarget}
              onToggleDraw={(target) =>
                setDrawTarget((cur) => (sameTarget(cur, target) ? null : target))
              }
              onSetOptionBox={(optionKey, box) => setOptionBox(selected.id, optionKey, box)}
              onSetScalarBox={(box) => setScalarBox(selected.id, box)}
              onClearRowBox={(rowIndex) => clearRowBox(selected.id, rowIndex)}
              onRestyleRowBox={(rowIndex, box) => restyleRowBox(selected.id, rowIndex, box)}
              onDivideGrid={(rows) => setManualGrid(selected, rows)}
            />
          ) : (
            <p className="text-[12.5px] text-text-tertiary">
              Pick a field on the left, then draw its box on the page — or let the page propose one.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}

/** Removing geometry entirely rather than leaving an empty segment list. */
function stripGeometry(field: FormField): FormField {
  const { geometry: _drop, ...rest } = field;
  return rest;
}

/**
 * Which box the next drag fills: a field's own, or one option's.
 *
 * A STRUCTURED pair rather than a joined string. The import session encodes
 * the same thing as `fieldId + separator + optionKey`, which only holds while
 * the separator cannot occur in either half — and option values here are prose
 * ("All the above"), so any visible separator risks parsing a multi-word option
 * as a different slot and dropping the box on the wrong option. Two fields
 * cannot be mis-split.
 */
interface DrawTarget {
  fieldId: string;
  /** Null for a scalar field, which has one box for the field as a whole. */
  optionKey: string | null;
  /**
   * The FAR end, for a matching connector — the anchor the drag finishes on.
   *
   * Present only in line mode. One drag places two anchors, which is what makes
   * the gesture the shape of the thing being authored: a matching answer is a
   * line from a statement to a sign, and a person doing the question with a pen
   * draws exactly that. Absent everywhere else, where a drag is one box.
   */
  toOptionKey?: string;
  /**
   * One printed row of a repeating table, for the per-row placement fallback.
   * Absent everywhere else — a table placed as a measured grid is one box.
   */
  rowIndex?: number;
}

function sameTarget(a: DrawTarget | null, b: DrawTarget): boolean {
  return (
    a !== null &&
    a.fieldId === b.fieldId &&
    a.optionKey === b.optionKey &&
    // The far end is part of the identity: arming "statement 1 → sign 2" and
    // then "statement 1 → sign 3" must swap the target, not toggle it off.
    a.toOptionKey === b.toOptionKey &&
    a.rowIndex === b.rowIndex
  );
}

/**
 * Whether a field gets one box per option (a ticking checkbox/radio group)
 * rather than a single scalar box — the same test `PlacementPanel` uses to
 * choose `deriveOptionCellsAcrossPages` over the table/scalar paths.
 *
 * A MATCHING QUESTION IS EXCLUDED, and that exclusion is the fix. It is stored
 * as a choice field whose options are every left × every right, so this
 * returned true and the panel asked for one box per PAIRING — nine for a
 * three-by-three question, twenty-five for a five-by-five. Eight of those nine
 * describe a correspondence the page never printed anywhere, so there was
 * nothing on the paper to place them against. Matching places ANCHORS instead:
 * one per printed entry, n + m rather than n × m.
 */
function isPerOptionField(field: FormField): boolean {
  if (isMatchingQuestion(field.options)) return false;
  return isChoiceField(field.type) && !field.printSelectedValue && (field.options?.length ?? 0) > 0;
}

/** Whether this field is placed as matching anchors — see `isPerOptionField`. */
function isMatchAnchorField(field: FormField): boolean {
  return isChoiceField(field.type) && !field.printSelectedValue && isMatchingQuestion(field.options);
}

/**
 * The next two anchors a connector drag would place — the first entry on each
 * side that has no box yet.
 *
 * THIS IS WHAT KEEPS THE MODE ON. A drag used to disarm the page, so drawing a
 * three-by-three question's connectors meant click, drag, click, drag, click,
 * drag: half the gestures were re-arming a mode that had just been used for
 * exactly what it is for. Advancing to the next pair instead means the mode is
 * turned on once and the rest is drawing, which is the whole point of making
 * the gesture a line.
 *
 * `alsoPlaced` is the pair the caller is placing right now. The field it holds
 * is one React state update behind — `setOptionBox` has been called but not yet
 * committed — so the keys have to be passed in rather than read back, or every
 * drag would re-offer the pair it just finished.
 *
 * NULL WHEN EVERY ANCHOR IS DOWN, which disarms the page. Staying armed on an
 * already-placed pair would let a stray drag silently move an anchor on a
 * finished question; re-drawing one is the row's own Draw button.
 */
function nextConnectTarget(field: FormField, alsoPlaced: readonly string[] = []): DrawTarget | null {
  if (!isMatchAnchorField(field)) return null;
  const placed = new Set([
    ...(field.geometry?.segments ?? []).map((s) => s.optionKey),
    ...alsoPlaced,
  ]);
  const anchors = matchAnchors(field.options ?? []);
  const from = anchors.find((a) => a.side === 'l' && !placed.has(a.key));
  const to = anchors.find((a) => a.side === 'r' && !placed.has(a.key));
  if (!from || !to) return null;
  return { fieldId: field.id, optionKey: from.key, toOptionKey: to.key };
}

/**
 * Where a band-edge adjustment made to the current `bandOverlay` should land
 * (R7/R8/U6).
 *
 * `'segment'` targets a box already living in `edited`/`fields` — a redraw
 * target's existing box, or the selected field's own placed segment — and is
 * written back with `mutate()`. `'preview'` targets a parked needs-review
 * proposal's segment, which is NOT yet in `edited`: it stays parked (R8's
 * confirm gate holds) and the adjustment updates `proposalPreviews` instead,
 * so a reviewer can fine-tune a proposal's grid before confirming it.
 */
type BandOverlaySource =
  | { kind: 'segment'; fieldId: string; optionKey: string | null }
  | { kind: 'preview'; fieldId: string };

interface BandOverlayInfo {
  box: PageBox;
  source: BandOverlaySource;
}

/**
 * The band grid currently shown in the editor, and where an edit to it should
 * be written (R7/R8/U6) — every mark on screen (auto-confirmed, needs-review,
 * or hand-drawn) renders as the real glyph and is drag/snap/keyboard-nudgeable,
 * matching the import review screen (AE5).
 *
 * Precedence: the field currently being drawn (its own existing box, for a
 * redraw fine-tune — nothing while a box has never been placed for that exact
 * slot); else the selected field's parked needs-review proposal (only a
 * `TableProposal` carries a single banded segment — a per-option
 * `FieldProposal` has one scalar box per option and nothing to band-edit
 * here); else the selected field's own existing segment, so a reviewer can
 * fine-tune an already-placed field.
 */
function bandOverlayFor(
  drawTarget: DrawTarget | null,
  selectedId: string | null,
  proposalPreviews: readonly { fieldId: string; proposal: FieldProposal | TableProposal }[],
  fields: readonly FormField[],
): BandOverlayInfo | null {
  if (drawTarget) {
    const field = fields.find((f) => f.id === drawTarget.fieldId);
    const segment =
      drawTarget.rowIndex !== undefined
        ? (field?.geometry?.segments ?? []).find((s) => rowCellIndex(s) === drawTarget.rowIndex)
        : (field?.geometry?.segments ?? []).find(
            (s) => (s.optionKey ?? null) === drawTarget.optionKey,
          );
    if (!segment) return null;
    return { box: segment, source: { kind: 'segment', fieldId: drawTarget.fieldId, optionKey: drawTarget.optionKey } };
  }

  if (!selectedId) return null;

  /*
    THE AUTHOR'S OWN PLACED SEGMENT WINS over a parked proposal. Detection can
    land a grid pages away from where the table prints; once the author has
    drawn (or applied) a box of their own, the grid they fine-tune must be the
    one that exports — not a stale detection sitting on another page, which is
    exactly what made a redrawn table look unplaceable: the box was stored,
    and the band grid kept rendering on the proposal's page.
  */
  const field = fields.find((f) => f.id === selectedId);
  if (field && !isPerOptionField(field)) {
    const segment = field.geometry?.segments?.[0];
    if (segment) {
      return { box: segment, source: { kind: 'segment', fieldId: selectedId, optionKey: segment.optionKey ?? null } };
    }
  }

  const preview = proposalPreviews.find((p) => p.fieldId === selectedId);
  if (preview && 'segment' in preview.proposal) {
    return { box: preview.proposal.segment, source: { kind: 'preview', fieldId: selectedId } };
  }
  return null; // FieldProposal: per-option scalar boxes, nothing to band-edit
}

/**
 * Derive a proposal for one field, the same way for every caller — `selectField`
 * and the bulk "Auto-place remaining fields" pass (U4) both route through this
 * so they classify identically. Empty `textPages` (the text layer hasn't loaded
 * yet) refuses rather than deriving off nothing.
 */
function deriveProposal(
  field: FormField,
  textPages: readonly TextPage[],
): FieldProposal | TableProposal | null {
  if (textPages.length === 0) return null;
  /*
    Matching first, because its field IS a choice field and the option-cell
    derivation would otherwise claim it — matching a field's PAIRINGS against
    the text layer, which can only hit by coincidence, since a pairing is
    something the candidate might do rather than something the page prints.
  */
  if (isMatchAnchorField(field)) {
    return deriveMatchAnchorsAcrossPages(matchAnchors(field.options ?? []), textPages);
  }
  if (isPerOptionField(field)) {
    return deriveOptionCellsAcrossPages(field as { label: string; options?: string[] }, textPages);
  }
  if (field.type === 'repeating_group') {
    return deriveAcrossPages(field, textPages);
  }
  return null;
}

/**
 * Turn an `auto-confirm`-tier proposal into the `FieldChange`(s) that place
 * it — every option's box for a per-option field, or the table's one grid box
 * — shared by `selectField`'s single-field auto-confirm and the bulk pass
 * (U4) so both apply a proposal identically.
 */
function changesForProposal(field: FormField, proposal: FieldProposal | TableProposal): FieldChange[] {
  // Both keyed-segment shapes take the same path: a matching ANCHOR and a
  // choice option are both a `PageBox` carrying an `optionKey`, and both must
  // leave an already-placed sibling alone.
  if (isPerOptionField(field) || isMatchAnchorField(field)) {
    const p = proposal as FieldProposal;
    // `deriveOptionCellsAcrossPages` derives a box for every option from the
    // field's label/options alone — it has no view of which are already
    // placed. Skip any option that already has a box, so a partially-placed
    // field's existing (possibly hand-corrected) segments aren't clobbered.
    const alreadyPlaced = new Set((field.geometry?.segments ?? []).map((s) => s.optionKey));
    return p.segments
      .filter((segment) => segment.optionKey !== undefined && !alreadyPlaced.has(segment.optionKey))
      .map((segment) => ({
        fieldId: field.id,
        change: (f: FormField) => {
          const kept = (f.geometry?.segments ?? []).filter((s) => s.optionKey !== segment.optionKey);
          return { ...f, geometry: { segments: [...kept, segment] } };
        },
      }));
  }
  const t = proposal as TableProposal;
  return [{ fieldId: field.id, change: (f: FormField) => ({ ...f, geometry: { segments: [t.segment] } }) }];
}

function FieldRow({
  field,
  selected,
  onSelect,
}: {
  field: FormField;
  selected: boolean;
  onSelect: () => void;
}) {
  const placed = geometrySegments(field).length;
  const wanted = expectedBoxes(field);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-2 border-b border-border-subtle px-[14px] py-2 text-left ${
        selected ? 'bg-[var(--accent-soft)]' : 'hover:bg-surface-hover'
      }`}
    >
      <Icon
        name={placed >= wanted ? 'circle-check' : 'square-dashed'}
        size={14}
        className={placed >= wanted ? 'flex-none text-success-text' : 'flex-none text-text-tertiary'}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-semibold">{field.label || field.id}</span>
        <span className="block text-[11px] text-text-tertiary">
          {field.type} · {placed}/{wanted} placed
        </span>
      </span>
    </button>
  );
}

/**
 * A marked question and its outcome box, as ONE row with two chips.
 *
 * KD5: the paper gives a marked question two printed places — where the
 * candidate's ANSWER appears, and where the assessor's VERDICT appears. The
 * response is geometry on the question field; the outcome is geometry on the
 * field its `outcomeTarget` names. Both have to be placed, and a list that
 * showed them as two unrelated rows among three hundred is how one of them ends
 * up missing.
 *
 * The question text sits under the row because that is what an author is
 * checking against the page — the label on this document class is routinely
 * "Question 7".
 */
function PairRow({
  pair,
  selectedId,
  onSelect,
  fields,
}: {
  pair: PlacementPair;
  selectedId: string | null;
  onSelect: (field: FormField) => void;
  fields: readonly FormField[];
}) {
  const { question, outcome, responsePlaced, outcomePlaced, unresolvedOutcomeId } = pair;
  const questionText = question.description ?? '';

  return (
    <div
      className={`border-b border-border-subtle px-[14px] py-2 ${
        selectedId === question.id || (outcome && selectedId === outcome.id)
          ? 'bg-[var(--accent-soft)]'
          : ''
      }`}
    >
      <span className="block truncate text-[12.5px] font-semibold">
        {question.label || question.id}
      </span>
      {questionText && (
        <span className="mt-0.5 block text-[11px] leading-snug text-text-tertiary">
          {questionText}
        </span>
      )}

      <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Chip
          label="Response"
          placed={responsePlaced}
          active={selectedId === question.id}
          onClick={() => onSelect(question)}
        />
        {outcome ? (
          <Chip
            label="Outcome"
            placed={outcomePlaced}
            active={selectedId === outcome.id}
            onClick={() => onSelect(outcome)}
          />
        ) : (
          /*
            NOT a chip. An unresolved target places nothing, and offering a
            control that does nothing is worse than saying why it is missing —
            the manifest was authored against a different version, or the
            printed reference never resolved.
          */
          <span className="rounded-lg border border-warning bg-warning-soft px-2 py-1 text-[10.5px] text-warning-text">
            Outcome box “{unresolvedOutcomeId}” is not in this version
          </span>
        )}
      </span>
    </div>
  );
}

function Chip({
  label,
  placed,
  active,
  onClick,
}: {
  label: string;
  placed: boolean;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[10.5px] font-semibold ${
        active
          ? 'border-accent bg-accent text-accent-contrast'
          : placed
            ? 'border-success bg-success-soft text-success-text'
            : 'border-border text-text-secondary hover:bg-surface-hover'
      }`}
    >
      <Icon name={placed ? 'circle-check' : 'square-dashed'} size={11} />
      {label}
    </button>
  );
}

/**
 * How many boxes this field needs: one per option for a ticking choice field,
 * one per printed ENTRY for a matching question, one otherwise.
 *
 * The matching case used to fall through `isPerOptionField` and count the
 * PAIRINGS — nine for a three-by-three question — so the header read "0/9" for
 * a question with six placeable things on it and could never reach complete
 * however carefully the author worked.
 */
function expectedBoxes(field: FormField): number {
  if (isMatchAnchorField(field)) return matchAnchors(field.options ?? []).length;
  return isPerOptionField(field) ? field.options!.length : 1;
}

function PlacementPanel({
  field,
  textPages,
  drawTarget,
  onToggleDraw,
  onSetOptionBox,
  onSetScalarBox,
  onClearRowBox,
  onRestyleRowBox,
  onDivideGrid,
}: {
  field: FormField;
  textPages: readonly TextPage[];
  drawTarget: DrawTarget | null;
  onToggleDraw: (target: DrawTarget) => void;
  onSetOptionBox: (optionKey: string, box: PageBox | null) => void;
  onSetScalarBox: (box: PageBox | null) => void;
  onClearRowBox: (rowIndex: number) => void;
  onRestyleRowBox: (rowIndex: number, box: PageBox) => void;
  onDivideGrid: (rows: number) => void;
}) {
  const perOption = isPerOptionField(field);
  const matchAnchorField = isMatchAnchorField(field);
  /** The whole-field segment — not a per-row cell, not a yes/no half. */
  const wholeFieldBox = (field.geometry?.segments ?? []).find(
    (s) => rowCellIndex(s) === null && s.optionKey === undefined,
  );
  /** Divide-into-rows count; seeded from the printed rows where declared. */
  const [divideRows, setDivideRows] = useState(() =>
    field.fixedRows?.length ? String(field.fixedRows.length) : '',
  );
  /*
   * The per-row fallback is offered where it can mean something: a fixed-row
   * table with exactly ONE answer column. One drawn rectangle per row IS that
   * row's cell; with two answer columns a rectangle cannot say which printed
   * cell it is, and the measured grid stays the only honest tool.
   */
  const rowFallback =
    field.type === 'repeating_group' &&
    (field.fixedRows?.length ?? 0) > 0 &&
    (field.columns ?? []).slice(1).length === 1;

  /**
   * The anchors a matching question needs — one per printed entry.
   *
   * Derived from the options rather than stored: the options ARE both sides,
   * and a second copy is a second thing that can disagree with the first.
   */
  const anchors = useMemo<MatchAnchor[]>(
    () => (matchAnchorField ? matchAnchors(field.options ?? []) : []),
    [field.options, matchAnchorField],
  );

  /**
   * The automatic proposal, if the page settles one.
   *
   * Recomputed from the field and the text layer rather than cached across
   * selections — the derivation scans every page, but a reviewer changes field
   * far less often than this component re-renders.
   */
  const proposal = useMemo(() => {
    if (textPages.length === 0) return null;
    // Matching is checked first for the same reason `deriveProposal` checks it
    // first: its field IS a choice field, and the option-cell derivation would
    // otherwise match its PAIRINGS against text that never prints them.
    if (matchAnchorField) return deriveMatchAnchorsAcrossPages(anchors, textPages);
    if (perOption) return deriveOptionCellsAcrossPages(field as { label: string; options?: string[] }, textPages);
    return null;
  }, [field, textPages, perOption, matchAnchorField, anchors]);

  const tableProposal = useMemo(() => {
    if (textPages.length === 0 || field.type !== 'repeating_group') return null;
    return deriveAcrossPages(field, textPages);
  }, [field, textPages]);

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-[12.5px] font-bold">{field.label || field.id}</div>
        <div className="text-[11px] text-text-tertiary">{field.type}</div>
      </div>

      {proposal && (
        <div className="rounded-sm border border-border-subtle bg-surface-sunken p-[9px_10px]">
          <p className="text-[11.5px] leading-snug text-text-secondary">
            Found this field on page {(proposal.segments[0]?.page ?? 0) + 1} with{' '}
            {proposal.segments.length} box(es).
            {proposal.confidence < 1 && ' Check it against the page before saving.'}
          </p>
          {proposal.notes.map((note) => (
            <p key={note} className="mt-1 text-[11px] leading-snug text-text-tertiary">
              {note}
            </p>
          ))}
          <Button
            variant="outline"
            leadingIcon="wand-sparkles"
            className="mt-1.5 w-full justify-center"
            onClick={() => {
              for (const segment of proposal.segments) {
                if (segment.optionKey === undefined) continue;
                onSetOptionBox(segment.optionKey, segment);
              }
            }}
          >
            Place all {proposal.segments.length}
          </Button>
        </div>
      )}

      {tableProposal && (
        <div className="rounded-sm border border-border-subtle bg-surface-sunken p-[9px_10px]">
          <p className="text-[11.5px] leading-snug text-text-secondary">
            A grid was detected on page {tableProposal.segment.page + 1}.
          </p>
          <Button
            variant="outline"
            leadingIcon="wand-sparkles"
            className="mt-1.5 w-full justify-center"
            onClick={() => onSetScalarBox(tableProposal.segment)}
          >
            Place this grid
          </Button>
        </div>
      )}

      {matchAnchorField ? (
        <MatchAnchorRows
          field={field}
          anchors={anchors}
          drawTarget={drawTarget}
          onToggleDraw={onToggleDraw}
          onSetOptionBox={onSetOptionBox}
        />
      ) : perOption ? (
        <div className="flex flex-col gap-1.5">
          {field.options!.map((option) => {
            const target: DrawTarget = { fieldId: field.id, optionKey: option };
            const box = (field.geometry?.segments ?? []).find((s) => s.optionKey === option);
            return (
              <BoxRow
                key={option}
                label={option}
                box={box}
                armed={sameTarget(drawTarget, target)}
                onToggleDraw={() => onToggleDraw(target)}
                onClear={() => onSetOptionBox(option, null)}
                onRestyle={(next) => onSetOptionBox(option, next)}
              />
            );
          })}
        </div>
      ) : (
        <>
          <BoxRow
            label="Answer box"
            /*
              The WHOLE-FIELD segment only. In per-row or yes/no-pair mode the
              first stored segment is one cell of several, and labelling it
              "Answer box · p1" would report a box nobody placed.
            */
            box={wholeFieldBox}
            armed={sameTarget(drawTarget, { fieldId: field.id, optionKey: null })}
            onToggleDraw={() => onToggleDraw({ fieldId: field.id, optionKey: null })}
            onClear={() => onSetScalarBox(null)}
            onRestyle={onSetScalarBox}
          />
          {/*
            DIVIDE BY SAY-SO. When a page's printed shapes cannot be measured —
            or measured the wrong table — the author still knows where the rows
            are: divide the drawn box evenly, then drag the band edges to fit.
            Offered only while a whole-field box exists to divide, on the page
            THAT box sits on, which is the page the author drew it.
          */}
          {field.type === 'repeating_group' && wholeFieldBox && (
            <div className="rounded-sm border border-border-subtle bg-surface-sunken p-[8px_9px]">
              <p className="text-[11px] leading-snug text-text-tertiary">
                Rows not measured, or measured on the wrong page? Divide the drawn box into equal
                rows, then drag the edges to fit the printed lines.
              </p>
              <div className="mt-1.5 flex items-center gap-1.5">
                <input
                  type="number"
                  min={1}
                  value={divideRows}
                  onChange={(e) => setDivideRows(e.target.value)}
                  aria-label="Number of printed rows"
                  placeholder="rows"
                  className="h-[28px] w-[64px] rounded-sm border border-border bg-surface-page px-1.5 text-[12px]"
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!Number.isInteger(Number(divideRows)) || Number(divideRows) < 1}
                  onClick={() => onDivideGrid(Number(divideRows))}
                >
                  Divide into rows
                </Button>
              </div>
            </div>
          )}
          {field.type === 'boolean_yes_no' && (
            <div className="flex flex-col gap-1.5">
              {/*
                THE PRINTED PAIR. Plenty of papers print a boolean as
                "No ☐  Yes ☐" — two cells, and the mark's meaning is which one
                it sits in. Placing the pair replaces the single box above (and
                drawing that replaces the pair); the export ticks the answered
                cell and leaves its partner blank.
              */}
              <p className="text-[11px] leading-snug text-text-tertiary">
                Or place Yes and No as separate printed cells — the export draws a ✓ in whichever
                one was answered.
              </p>
              {(['yes', 'no'] as const).map((key) => {
                const target: DrawTarget = { fieldId: field.id, optionKey: key };
                const box = (field.geometry?.segments ?? []).find((s) => s.optionKey === key);
                return (
                  <BoxRow
                    key={key}
                    label={key === 'yes' ? 'Yes cell' : 'No cell'}
                    box={box}
                    armed={sameTarget(drawTarget, target)}
                    onToggleDraw={() => onToggleDraw(target)}
                    onClear={() => onSetOptionBox(key, null)}
                    onRestyle={(next) => onSetOptionBox(key, next)}
                  />
                );
              })}
            </div>
          )}
          {rowFallback && (
            <div className="flex flex-col gap-1.5">
              <p className="text-[11px] leading-snug text-text-tertiary">
                Or place each row&rsquo;s box yourself — for when the measured grid is wrong.
                Drawing any row replaces the whole-grid box; a row left blank exports as recorded
                data with no mark on the page.
              </p>
              {field.fixedRows!.map((rowLabel, index) => {
                const target: DrawTarget = { fieldId: field.id, optionKey: null, rowIndex: index };
                const box = (field.geometry?.segments ?? []).find(
                  (s) => rowCellIndex(s) === index,
                );
                return (
                  <BoxRow
                    key={index}
                    label={rowLabel || `Row ${index + 1}`}
                    box={box}
                    armed={sameTarget(drawTarget, target)}
                    onToggleDraw={() => onToggleDraw(target)}
                    onClear={() => onClearRowBox(index)}
                    onRestyle={(next) => onRestyleRowBox(index, next)}
                  />
                );
              })}
            </div>
          )}
        </>
      )}

      <p className="text-[11px] leading-snug text-text-tertiary">{markSentence(field)}</p>

      {/*
        THE NUDGE HAS ALWAYS WORKED AND NOTHING SAID SO.

        Arrow keys move the placed box by 1pt and Shift+arrow by 10pt, carrying
        its bands with it — the one control that turns a roughly-right box into
        an exactly-right one. It was announced only in the canvas's
        `aria-label`, which a sighted author never reads, so the feature was
        invisible and the screen looked as though it offered no fine
        adjustment at all.

        Placed here rather than on the canvas because this panel is where an
        author is already looking when they decide a box is slightly off.
      */}
      <p className="text-[11px] leading-snug text-text-tertiary">
        Click the page, then <strong className="font-semibold">arrow keys</strong> nudge the box
        1pt — <strong className="font-semibold">Shift</strong> for 10pt. Rows and columns move
        with it.
      </p>

      <p className="text-[11px] leading-snug text-text-tertiary">
        A field with no box exports as recorded data instead of a mark on the page — visibly
        incomplete, which is the safe way to be wrong.
      </p>
    </div>
  );
}

/**
 * The two printed sides of a matching question, each entry an anchor to place.
 *
 * WHAT THIS REPLACES. This panel used to list one row per PAIRING, because a
 * matching question is stored as a choice field whose options are every left ×
 * every right — so a three-by-three question asked the author for nine boxes and
 * a five-by-five for twenty-five. Eight of those nine name a correspondence the
 * page never printed anywhere, so there was nothing on the paper to put them on;
 * an author following the panel honestly could not.
 *
 * An ANCHOR is a small box on something that IS printed: the statement, or the
 * sign. Six of them describe the same three-by-three question, and the exporter
 * draws each chosen pairing as a line between the two anchors it names — which
 * is what a person with a pen draws, and therefore what the evidence document
 * has to show.
 *
 * The glyph picker is deliberately absent from these rows. An anchor does not
 * print a mark of its own; it is one end of a connector, and offering a tick or
 * a stamp for it would put a choice on screen that reaches the page as nothing.
 */
function MatchAnchorRows({
  field,
  anchors,
  drawTarget,
  onToggleDraw,
  onSetOptionBox,
}: {
  field: FormField;
  anchors: readonly MatchAnchor[];
  drawTarget: DrawTarget | null;
  onToggleDraw: (target: DrawTarget) => void;
  onSetOptionBox: (optionKey: string, box: PageBox | null) => void;
}) {
  const segments = field.geometry?.segments ?? [];
  const has = (key: string) => segments.some((s) => s.optionKey === key);
  const placed = anchors.filter((a) => has(a.key)).length;

  const prompts = anchors.filter((a) => a.side === 'l');
  const answers = anchors.filter((a) => a.side === 'r');

  /*
    WHICH TWO ENTRIES THE NEXT LINE JOINS — DERIVED, NOT REMEMBERED.

    This block held its own `from`/`to` state once, and that was a second source
    of truth for a thing the armed target already knows. The two could disagree
    the moment the screen advanced the target after a drag: the selects would
    still be showing the pair just drawn while the page was armed for the next
    one, and the labels beside a live gesture would be lying about what it was
    about to do.

    Armed wins; otherwise the suggestion is the first entry on each side with no
    box yet, which is the order a person works down the page in.

    THESE NAME ANCHORS, NOT A PAIRING. Nothing about which statement goes with
    which sign is being said here — that is the answer key's job, and it is set
    in the pair builder. This says only "these two printed things are where the
    line's ends live", which is why joining them in an odd combination costs
    nothing: every anchor is reusable by every pairing that names it.
  */
  const armed =
    drawTarget?.fieldId === field.id && drawTarget.toOptionKey !== undefined ? drawTarget : null;
  const connectTarget = armed ?? nextConnectTarget(field);
  const connecting = armed !== null;

  const textOf = (key: string | null | undefined) =>
    anchors.find((a) => a.key === key)?.text ?? '';

  const side = (which: 'l' | 'r', heading: string) => {
    const rows = anchors.filter((a) => a.side === which);
    if (rows.length === 0) return null;
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-text-tertiary">
          {heading}
        </span>
        {rows.map((anchor) => {
          const target: DrawTarget = { fieldId: field.id, optionKey: anchor.key };
          return (
            <BoxRow
              key={anchor.key}
              label={anchor.text}
              box={segments.find((s) => s.optionKey === anchor.key)}
              armed={sameTarget(drawTarget, target)}
              onToggleDraw={() => onToggleDraw(target)}
              onClear={() => onSetOptionBox(anchor.key, null)}
            />
          );
        })}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="rounded-sm border border-border-subtle bg-surface-sunken p-[9px_10px] text-[11.5px] leading-snug text-text-secondary">
        Put a small box on each printed statement and each printed answer —{' '}
        <strong>{anchors.length} in all</strong>, where one box per pairing would have been{' '}
        {field.options?.length ?? 0}. You don&rsquo;t draw the lines: the export draws one between
        the two boxes for every pairing the candidate joined, green where it is in the key and red
        where it is not.
      </p>
      <p className="text-[11px] text-text-tertiary">
        {placed} of {anchors.length} anchored
        {placed < anchors.length &&
          ' · a pairing with either end unplaced draws nothing rather than guessing an endpoint'}
      </p>

      {connectTarget && (
        <div
          className={`flex flex-col gap-1.5 rounded-sm border p-[8px_9px] ${
            connecting ? 'border-border-accent bg-surface-accent-soft' : 'border-border-subtle bg-surface-sunken'
          }`}
        >
          <span className="text-[10.5px] font-semibold uppercase tracking-wide text-text-tertiary">
            Draw the lines
          </span>

          <Button
            variant={connecting ? 'primary' : 'outline'}
            leadingIcon="spline"
            className="w-full justify-center"
            onClick={() => onToggleDraw(connectTarget)}
          >
            {connecting ? 'Drawing — click to stop' : 'Draw lines on the page'}
          </Button>

          {/*
            WHAT THE NEXT DRAG WILL DO, named while the page is live.

            The gesture places two anchors at once, and which two is the one
            thing a drag cannot show you — the line under the cursor looks
            identical whichever pair it belongs to. Saying it here is what makes
            "just drag" safe to keep doing without stopping to check.
          */}
          <p className="text-[11px] leading-snug text-text-secondary">
            {connecting ? 'Drag from ' : 'Next line: '}
            <strong>{textOf(connectTarget.optionKey)}</strong>
            {connecting ? ' to ' : ' → '}
            <strong>{textOf(connectTarget.toOptionKey)}</strong>
            {connecting && ' on the page.'}
          </p>

          <span className="text-[10.5px] leading-snug text-text-tertiary">
            The mode stays on: each drag places both ends and moves to the next pair, so a
            three-by-three question is three drags. Pick a different pair below to jump to it.
          </span>

          <div className="flex items-center gap-1.5">
            <select
              aria-label="Line starts at"
              value={connectTarget.optionKey ?? ''}
              onChange={(e) =>
                onToggleDraw({
                  fieldId: field.id,
                  optionKey: e.target.value,
                  toOptionKey: connectTarget.toOptionKey,
                })
              }
              className="h-[26px] min-w-0 flex-1 rounded-lg border border-border bg-surface-card px-1.5 text-[11px]"
            >
              {prompts.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.text}
                </option>
              ))}
            </select>
            <Icon name="move-right" size={13} className="flex-none text-text-tertiary" />
            <select
              aria-label="Line ends at"
              value={connectTarget.toOptionKey ?? ''}
              onChange={(e) =>
                onToggleDraw({
                  fieldId: field.id,
                  optionKey: connectTarget.optionKey,
                  toOptionKey: e.target.value,
                })
              }
              className="h-[26px] min-w-0 flex-1 rounded-lg border border-border bg-surface-card px-1.5 text-[11px]"
            >
              {answers.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.text}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {side('l', 'Prompts')}
      {side('r', 'Answers')}
    </div>
  );
}

/**
 * What a placed box PRINTS on the exported document.
 *
 * The same choice `GeometryInspector` offers during import review, on the
 * screen that actually places geometry for an assessment. It was only ever in
 * the import wizard, so an author placing boxes here — the path an assessment
 * tool is built through — could not choose a mark at all.
 *
 * Every style listed draws. That was not always true; the exporter used to
 * ignore five of the twelve and this picker's ancestor labelled them, but
 * `DRAWN_BY_GLYPH` in `round-trip.ts` is now a total map and a glyph without a
 * renderer is a compile error there.
 */
function GlyphRow({ box, onChange }: { box: PageBox; onChange: (next: PageBox) => void }) {
  const current = box.markStyle?.glyph;
  const choose = (glyph: GlyphKind | undefined) => {
    // Clearing writes NO markStyle rather than an empty one: absent is what
    // every placement authored before styles existed carries, and it is the
    // value the exporter treats as "the field's own mark".
    const { markStyle: _drop, ...rest } = box;
    onChange(glyph ? { ...rest, markStyle: { ...box.markStyle, glyph } } : rest);
  };

  return (
    <div className="mt-1.5 border-t border-border-subtle pt-1.5">
      <span className="mb-1 block text-[10.5px] font-semibold text-text-tertiary">
        What this box prints
      </span>
      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          onClick={() => choose(undefined)}
          aria-pressed={!current}
          className={`rounded-sm border px-1.5 py-0.5 text-[10px] ${
            !current
              ? 'border-border-accent bg-surface-card font-semibold text-accent'
              : 'border-border text-text-secondary hover:bg-surface-hover'
          }`}
        >
          Default
        </button>
        {GLYPH_KINDS.map((glyph) => (
          <button
            key={glyph}
            type="button"
            onClick={() => choose(glyph)}
            aria-pressed={current === glyph}
            aria-label={`Print ${GLYPH_LABELS[glyph]}`}
            className={`rounded-sm border px-1.5 py-0.5 text-[10px] ${
              current === glyph
                ? 'border-border-accent bg-surface-card font-semibold text-accent'
                : 'border-border text-text-secondary hover:bg-surface-hover'
            }`}
          >
            {GLYPH_LABELS[glyph]}
          </button>
        ))}
      </div>
      {current === 'match_line' && (
        <p className="mt-1 text-[10px] leading-snug text-text-tertiary">
          Draws a connector across this box, end to end — place it spanning the gap between the two
          printed columns.
        </p>
      )}
    </div>
  );
}

function BoxRow({
  label,
  box,
  armed,
  onToggleDraw,
  onClear,
  onRestyle,
}: {
  label: string;
  box: PageBox | undefined;
  armed: boolean;
  onToggleDraw: () => void;
  onClear: () => void;
  /**
   * Absent where the box prints no mark of its own — a matching ANCHOR is one
   * end of a connector, and a tick or a stamp chosen for it would reach the
   * page as nothing.
   */
  onRestyle?: (next: PageBox) => void;
}) {
  return (
    <div className="rounded-sm border border-border-subtle bg-surface-sunken p-[8px_9px]">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">{label}</span>
        {box && (
          <span className="text-[10.5px] font-semibold text-success-text">p{box.page + 1}</span>
        )}
      </div>
      <div className="flex gap-1.5">
        <Button
          variant={armed ? 'primary' : 'outline'}
          leadingIcon="square-dashed"
          className="flex-1 justify-center"
          onClick={onToggleDraw}
        >
          {armed ? 'Drawing…' : box ? 'Redraw' : 'Draw'}
        </Button>
        {box && (
          <Button variant="outline" leadingIcon="trash-2" onClick={onClear}>
            Clear
          </Button>
        )}
      </div>
      {/* Only once there is a box: a style with nowhere to print is a choice
          about nothing, and it would be lost the moment the box is drawn. */}
      {box && onRestyle && <GlyphRow box={box} onChange={onRestyle} />}
    </div>
  );
}
