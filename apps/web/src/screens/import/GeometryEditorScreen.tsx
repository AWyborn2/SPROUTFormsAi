import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Icon, useToast } from '@formai/ui';
import { geometrySegments, isChoiceField, type FormField, type PageBox } from '@formai/shared';
import { useFormVersion, usePublishFormVersion, useSaveVersionFields } from '../../lib/data/hooks.js';
import type { FieldProposal, TableProposal, TextPage } from '../../lib/pdf-geometry.js';
import { markSentence } from '../../lib/mark-description.js';
import { PdfViewer } from './PdfViewer.js';
import {
  applyFieldChanges,
  classifyProposalTier,
  deriveAcrossPages,
  deriveOptionCellsAcrossPages,
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
export function GeometryEditorScreen() {
  const { id: formId, versionId } = useParams<{ id: string; versionId: string }>();
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
    [bandOverlay, textPages],
  );
  const bandSnapTargetsY = useMemo(
    () => (bandOverlay ? snapTargetsY(textPages[bandOverlay.page]?.items ?? []) : []),
    [bandOverlay, textPages],
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
    const next =
      handle.left && handle.right
        ? moveBoundary(overlay.box, handle.axis, handle.left, handle.right, value)
        : handle.right
          ? moveBand(overlay.box, handle.axis, handle.right, 'start', value)
          : handle.left
            ? moveBand(overlay.box, handle.axis, handle.left, 'end', value)
            : null;
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
    setProposalPreviews([]);

    if (geometrySegments(field).length > 0) return;

    const proposal = deriveProposal(field, textPages);
    const tier = classifyProposalTier(proposal);
    if (tier === 'no-match') return;

    if (tier === 'needs-review') {
      // Parked for preview only — `edited` stays untouched until the
      // reviewer applies it themselves.
      setProposalPreviews([{ fieldId: field.id, proposal: proposal! }]);
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
    if (reviews.length > 0) setProposalPreviews(reviews);

    setIsAutoPlacing(false);
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
      const kept = (f.geometry?.segments ?? []).filter((s) => s.optionKey !== optionKey);
      const next = box ? [...kept, { ...box, optionKey }] : kept;
      return next.length > 0 ? { ...f, geometry: { segments: next } } : stripGeometry(f);
    });
  }

  function setScalarBox(fieldId: string, box: PageBox | null) {
    mutate(fieldId, (f) => (box ? { ...f, geometry: { segments: [box] } } : stripGeometry(f)));
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
        <Button variant="outline" className="mt-4" onClick={() => navigate(`/app/forms`)}>
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

  const placedCount = fields.filter((f) => geometrySegments(f).length > 0).length;
  const placeable = fields.filter((f) => f.type !== 'section_header');

  return (
    <div className="fai-rise flex h-[calc(100vh-56px)] flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-[22px] py-3">
        <div className="min-w-0">
          <h1 className="truncate font-heading text-[16px] font-bold">Placement · {version.label}</h1>
          <p className="text-[12.5px] text-text-secondary">
            {placedCount} of {placeable.length} answerable fields placed
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
                  toast({ variant: 'success', message: 'Placement saved to the draft.' });
                },
                onError: () => toast({ variant: 'danger', message: "Couldn't save — try again." }),
              })
            }
          >
            {save.isPending ? 'Saving…' : 'Save draft'}
          </Button>
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
                  onError: () => toast({ variant: 'danger', message: "Couldn't publish — try again." }),
                },
              );
            }}
          >
            Publish version
          </Button>
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
          {placeable.map((f) => (
            <FieldRow key={f.id} field={f} selected={f.id === selectedId} onSelect={() => selectField(f)} />
          ))}
        </aside>

        <div className="min-w-0 flex-1">
          <PdfViewer
            assetId={version.sourcePdfAssetId}
            selectedFieldId={selectedId}
            onSelectField={setSelectedId}
            onTextLayer={onTextLayer}
            placements={placements}
            bandOverlay={bandOverlay}
            bandSnapTargets={bandSnapTargets}
            bandSnapTargetsY={bandSnapTargetsY}
            onBandEdge={onBandEdge}
            drawArmed={drawTarget !== null}
            onDrawBox={(box) => {
              if (!drawTarget) return;
              const { fieldId, optionKey } = drawTarget;
              if (optionKey === null) setScalarBox(fieldId, box);
              else setOptionBox(fieldId, optionKey, box);
              setDrawTarget(null);
            }}
            className="h-full"
          />
        </div>

        <aside className="w-[320px] shrink-0 overflow-y-auto border-l border-border p-[14px_16px]">
          {selected ? (
            <PlacementPanel
              field={selected}
              textPages={textPages}
              drawTarget={drawTarget}
              onToggleDraw={(target) =>
                setDrawTarget((cur) => (sameTarget(cur, target) ? null : target))
              }
              onSetOptionBox={(optionKey, box) => setOptionBox(selected.id, optionKey, box)}
              onSetScalarBox={(box) => setScalarBox(selected.id, box)}
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
}

function sameTarget(a: DrawTarget | null, b: DrawTarget): boolean {
  return a !== null && a.fieldId === b.fieldId && a.optionKey === b.optionKey;
}

/**
 * Whether a field gets one box per option (a ticking checkbox/radio group)
 * rather than a single scalar box — the same test `PlacementPanel` uses to
 * choose `deriveOptionCellsAcrossPages` over the table/scalar paths.
 */
function isPerOptionField(field: FormField): boolean {
  return isChoiceField(field.type) && !field.printSelectedValue && (field.options?.length ?? 0) > 0;
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
    const segment = (field?.geometry?.segments ?? []).find(
      (s) => (s.optionKey ?? null) === drawTarget.optionKey,
    );
    if (!segment) return null;
    return { box: segment, source: { kind: 'segment', fieldId: drawTarget.fieldId, optionKey: drawTarget.optionKey } };
  }

  if (!selectedId) return null;

  const preview = proposalPreviews.find((p) => p.fieldId === selectedId);
  if (preview) {
    if ('segment' in preview.proposal) {
      return { box: preview.proposal.segment, source: { kind: 'preview', fieldId: selectedId } };
    }
    return null; // FieldProposal: per-option scalar boxes, nothing to band-edit
  }

  const field = fields.find((f) => f.id === selectedId);
  if (!field || isPerOptionField(field)) return null;
  const segment = field.geometry?.segments?.[0];
  if (!segment) return null;
  return { box: segment, source: { kind: 'segment', fieldId: selectedId, optionKey: segment.optionKey ?? null } };
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
  if (isPerOptionField(field)) {
    const p = proposal as FieldProposal;
    return p.segments
      .filter((segment) => segment.optionKey !== undefined)
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

/** How many boxes this field needs: one per option for a ticking choice field. */
function expectedBoxes(field: FormField): number {
  return isChoiceField(field.type) && !field.printSelectedValue && (field.options?.length ?? 0) > 0
    ? field.options!.length
    : 1;
}

function PlacementPanel({
  field,
  textPages,
  drawTarget,
  onToggleDraw,
  onSetOptionBox,
  onSetScalarBox,
}: {
  field: FormField;
  textPages: readonly TextPage[];
  drawTarget: DrawTarget | null;
  onToggleDraw: (target: DrawTarget) => void;
  onSetOptionBox: (optionKey: string, box: PageBox | null) => void;
  onSetScalarBox: (box: PageBox | null) => void;
}) {
  const perOption =
    isChoiceField(field.type) && !field.printSelectedValue && (field.options?.length ?? 0) > 0;

  /**
   * The automatic proposal, if the page settles one.
   *
   * Recomputed from the field and the text layer rather than cached across
   * selections — the derivation scans every page, but a reviewer changes field
   * far less often than this component re-renders.
   */
  const proposal = useMemo(() => {
    if (textPages.length === 0) return null;
    if (perOption) return deriveOptionCellsAcrossPages(field as { label: string; options?: string[] }, textPages);
    return null;
  }, [field, textPages, perOption]);

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

      {perOption ? (
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
              />
            );
          })}
        </div>
      ) : (
        <BoxRow
          label="Answer box"
          box={field.geometry?.segments?.[0]}
          armed={sameTarget(drawTarget, { fieldId: field.id, optionKey: null })}
          onToggleDraw={() => onToggleDraw({ fieldId: field.id, optionKey: null })}
          onClear={() => onSetScalarBox(null)}
        />
      )}

      <p className="text-[11px] leading-snug text-text-tertiary">{markSentence(field)}</p>

      <p className="text-[11px] leading-snug text-text-tertiary">
        A field with no box exports as recorded data instead of a mark on the page — visibly
        incomplete, which is the safe way to be wrong.
      </p>
    </div>
  );
}

function BoxRow({
  label,
  box,
  armed,
  onToggleDraw,
  onClear,
}: {
  label: string;
  box: PageBox | undefined;
  armed: boolean;
  onToggleDraw: () => void;
  onClear: () => void;
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
    </div>
  );
}
