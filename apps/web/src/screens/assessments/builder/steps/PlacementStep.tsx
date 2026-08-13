import { useEffect, useMemo, useRef } from 'react';
import { Button, Icon } from '@formai/ui';
import {
  useCreateDraftForm,
  useForkDraftVersion,
  useFormVersion,
  useSaveVersionFields,
} from '../../../../lib/data/hooks.js';
import { GeometryEditorScreen } from '../../../import/GeometryEditorScreen.js';
import type { BuilderDraftState } from '../use-builder-draft.js';
import type { FieldGeometry, FormField } from '@formai/shared';

/**
 * Step 6 — map each field onto the printed page.
 *
 * ONE COMPONENT, TWO MOUNTS (KTD7). This does not reimplement placement; it
 * mounts the standalone `GeometryEditorScreen` against the builder's own draft
 * version. That screen already carries the PDF viewer, the proposal tiering,
 * the band editing, the whole-box drag and nudge, the grouped field list with
 * its response/outcome pair rows, the glyph picker — and the confirm gate that
 * keeps unreviewed proposals out of published geometry. A second placement UI
 * would be a second place for that gate to be got wrong, on the artifact that
 * decides where marks print on a competency record.
 *
 * THE DRAFT VERSION IS CREATED ON ARRIVAL, not at publish. Geometry lives on a
 * version's fields — that is where the exporter reads it from — so there is
 * nowhere to put a box until one exists, and this step sits before publish in
 * the author's order. From that moment the VERSION owns the fields; the builder
 * draft owns the structure, the keys and the manifest that sit on top of them,
 * all of which reference field ids, and ids survive every version write.
 *
 * The template stays a DRAFT until publish, so an unfinished assessment is
 * never in front of a filler.
 */
export interface PlacementStepProps {
  draft: BuilderDraftState;
}

/**
 * The field list a draft version should carry, given what the author has since
 * included — or null when it already carries it and nothing need be written.
 *
 * ADD ONLY, NEVER REMOVE, and the order of the spread is the reason: the
 * version's own copy of a field is the one holding the geometry drawn onto it,
 * so it always wins over the builder's copy. A field the author excluded AFTER
 * placing a box keeps that box rather than having it silently destroyed —
 * publish decides what ships, and an un-drawn box is recoverable where a
 * deleted one is not.
 *
 * Returning null rather than an unchanged list is what stops the reconcile
 * effect from writing on every render: the caller saves only when there is a
 * difference, and after one save there is none.
 */
export function reconciledVersionFields(
  onVersion: readonly FormField[],
  included: readonly FormField[],
): FormField[] | null {
  const have = new Set(onVersion.map((f) => f.id));
  const missing = included.filter((f) => !have.has(f.id));
  return missing.length > 0 ? [...onVersion, ...missing] : null;
}

export function PlacementStep({ draft }: PlacementStepProps) {
  const { formId, versionId, setVersionIds, setPlacedFields, fields, excluded, assetId, title } =
    draft;
  const createDraftForm = useCreateDraftForm();
  const forkDraftVersion = useForkDraftVersion();
  const isRevision = Boolean(draft.revisionOfToolId);
  /*
    ONE CREATION, EVER. `useEffect` re-runs on every dependency change and
    React 18 mounts effects twice in development, so the guard cannot be the
    mutation's own pending flag — it has to be a ref that flips before the
    await. Two forms would leave an orphan in the library carrying half a
    tool's geometry, with nothing to say which was real.
  */
  const started = useRef(false);

  /*
    Created on arrival rather than behind a button. An author who reaches this
    step has already decided to place boxes, and a "prepare this step" control
    is a question with one sensible answer.
  */
  useEffect(() => {
    if (formId || started.current || fields.length === 0) return;
    started.current = true;
    void createDraftForm
      .mutateAsync({
        name: title || 'Assessment',
        // The fields as the author edited them, minus the questions they turned
        // off. After this the VERSION owns them.
        fields: fields.filter((f) => !excluded.has(f.id)),
        ...(assetId ? { sourcePdfAssetId: assetId } : {}),
      })
      .then((result) => {
        if (result.versionId) setVersionIds(result.formId, result.versionId);
      })
      .catch(() => {
        // Let the author retry by leaving and returning to the step.
        started.current = false;
      });
  }, [formId, fields, excluded, assetId, title, createDraftForm, setVersionIds]);

  /*
    A REVISION FORKS, IT NEVER CREATES. The form already exists — it is the
    published tool's own template, and the seed set `formId` to it — so this
    step forks a fresh draft version of THAT form, field ids preserved (which
    is the entire point: the manifest, the keys and every stored attempt are
    keyed to them). When the paper was replaced, the fork carries the new
    `sourcePdfAssetId`; kept, it inherits the current one.
  */
  const forkStarted = useRef(false);
  useEffect(() => {
    if (!isRevision || !formId || versionId || forkStarted.current || fields.length === 0) return;
    forkStarted.current = true;
    void forkDraftVersion
      .mutateAsync({
        formId,
        fields: fields.filter((f) => !excluded.has(f.id)),
        ...(draft.pdfReplaced && assetId ? { sourcePdfAssetId: assetId } : {}),
      })
      .then((result) => {
        if (result.versionId) setVersionIds(formId, result.versionId);
      })
      .catch(() => {
        forkStarted.current = false;
      });
  }, [
    isRevision,
    formId,
    versionId,
    fields,
    excluded,
    assetId,
    draft.pdfReplaced,
    forkDraftVersion,
    setVersionIds,
  ]);

  /*
    RE-TICKING A FIELD USED TO BE A DEAD END.

    The version is created ONCE, from the fields minus the excluded ones. Go
    back to the upload step afterwards, re-include a question, and nothing
    reaches the version — so the field never appears in the placement list and
    can never be given a box. There was no error and no way back short of
    starting the whole build again.

    That is how an author loses the two boxes this paper's whole workflow turns
    on. "More coaching and/or training required?" and "Candidate Competent /
    not yet Competent" read as marking furniture at the upload step, get
    unticked, and only become unreachable four steps later — at which point the
    answer keys, the matching pairs and every box already placed are the cost of
    going back.

    So the step RECONCILES rather than assuming. Whatever the author has since
    included that the version does not carry is appended to it.

    What that costs and what it keeps is `reconciledVersionFields`.
  */
  const version = useFormVersion(formId, versionId);
  const saveVersionFields = useSaveVersionFields(formId ?? '', versionId ?? '');
  const reconciling = useRef(false);

  const included = useMemo(() => fields.filter((f) => !excluded.has(f.id)), [fields, excluded]);

  useEffect(() => {
    const onVersion = version.data?.fields;
    if (!formId || !versionId || !onVersion || reconciling.current) return;

    const next = reconciledVersionFields(onVersion, included);
    if (!next) return;

    reconciling.current = true;
    void saveVersionFields.mutateAsync(next).finally(() => {
      // Cleared either way: a failed write should be retried when the author
      // returns, not latched off for the life of the screen.
      reconciling.current = false;
    });
  }, [formId, versionId, version.data, included, saveVersionFields]);

  if (fields.length === 0) {
    return (
      <p className="rounded-[14px] border border-border bg-surface-card p-4 text-[12.5px] text-text-secondary">
        Upload a document first — there is nothing to place yet.
      </p>
    );
  }

  if (!formId || !versionId) {
    const preparing = createDraftForm.isPending || forkDraftVersion.isPending;
    return (
      <div className="rounded-[14px] border border-border bg-surface-card p-4">
        <span className="block text-[14.5px] font-semibold">
          {preparing ? 'Preparing the document…' : 'Could not prepare the document'}
        </span>
        <p className="mt-1 text-[12.5px] leading-relaxed text-text-secondary">
          {preparing
            ? isRevision
              ? 'Forking a draft version of the published form — same fields, same ids — so this revision has somewhere to save placements without touching what is live.'
              : 'Creating the draft version this step places geometry onto. It stays a draft until you publish, so nobody can fill it in the meantime.'
            : 'The draft version could not be created, so there is nowhere to save a placement — a box drawn now would have nothing to be saved onto. Move away from this step and back to try again.'}
        </p>
      </div>
    );
  }

  return (
    // A flex column filling the frozen-chrome slot: the carried-boxes panel
    // (when there is one) keeps its height, the editor takes the rest and
    // manages its own internal scrolling.
    <div className="-mx-7 -mt-1 flex h-full min-h-0 flex-col">
      {isRevision && Object.keys(draft.carriedGeometry).length > 0 && (
        <CarriedBoxesPanel
          carried={draft.carriedGeometry}
          fields={fields}
          onConfirm={(ids) => {
            /*
              Confirming writes the carried boxes onto BOTH copies of the
              fields in the same act — the draft's (what publishes) and the
              version's (what the editor and exporter read) — because a stash
              applied to one and not the other is exactly the two-copies drift
              this builder refuses everywhere else.
            */
            const stash = draft.carriedGeometry;
            draft.confirmCarried(ids);
            const onVersion = version.data?.fields ?? [];
            const next = onVersion.map((f) =>
              ids.includes(f.id) && stash[f.id] ? { ...f, geometry: stash[f.id]! } : f,
            );
            void saveVersionFields.mutateAsync(next).then(() => setPlacedFields(next));
          }}
        />
      )}
      {/*
        Embedded: the builder's own stepper is the chrome, and the screen's
        header would read as a second page title stacked on the first.
      */}
      {/*
        `onSaved` takes the geometry BACK INTO THE DRAFT. The publish step
        validates and writes the draft's own field list, so geometry saved only
        onto the version is overwritten there — the boxes are on screen the
        whole time, which is what makes that failure invisible.
      */}
      <div className="min-h-0 flex-1">
        <GeometryEditorScreen
          formId={formId}
          versionId={versionId}
          embedded
          onSaved={setPlacedFields}
        />
      </div>
    </div>
  );
}

/**
 * Boxes carried across a PDF replacement, grouped by the page they sat on.
 *
 * Carried geometry is a PROPOSAL — it lives in the draft's stash, never on a
 * field, because stored geometry means confirmed everywhere it is read (the
 * exporter above all). Confirming a page moves that page's boxes onto the
 * fields at their old positions, where the editor below renders them for
 * fine-tuning; anything left unconfirmed is named at publish rather than
 * silently printed against a layout nobody checked (R7, R8).
 *
 * Per PAGE, deliberately never one whole-document button: the honest review
 * unit is a page held next to its printed counterpart.
 */
function CarriedBoxesPanel({
  carried,
  fields,
  onConfirm,
}: {
  carried: Record<string, FieldGeometry>;
  fields: readonly FormField[];
  onConfirm: (fieldIds: string[]) => void;
}) {
  const labelById = useMemo(() => new Map(fields.map((f) => [f.id, f.label])), [fields]);
  const byPage = useMemo(() => {
    const pages = new Map<number, string[]>();
    for (const [fieldId, geometry] of Object.entries(carried)) {
      const page = geometry.segments[0]?.page ?? 0;
      const bucket = pages.get(page);
      if (bucket) bucket.push(fieldId);
      else pages.set(page, [fieldId]);
    }
    return [...pages.entries()].sort(([a], [b]) => a - b);
  }, [carried]);
  const total = Object.keys(carried).length;

  return (
    <div className="m-[22px_22px_12px] rounded-[14px] border border-warning bg-warning-soft p-[14px_16px]">
      <div className="mb-1 flex items-center gap-2 text-[13.5px] font-semibold text-warning-text">
        <Icon name="map-pin" size={15} />
        {total} carried box{total === 1 ? '' : 'es'} awaiting re-confirmation
      </div>
      <p className="mb-3 max-w-[70ch] text-[12px] leading-relaxed text-warning-text">
        These were confirmed against the previous document. Confirm a page to place its boxes at
        their old positions — then check them on the page below and adjust any the new layout
        moved. Anything left here is named before publish and prints nowhere until placed.
      </p>
      <div className="flex flex-col gap-1.5">
        {byPage.map(([page, ids]) => (
          <div
            key={page}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-border-subtle bg-surface-card p-[8px_10px]"
          >
            <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-text-tertiary">
              Page {page + 1}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-text-secondary">
              {ids
                .slice(0, 4)
                .map((id) => labelById.get(id) ?? id)
                .join(' · ')}
              {ids.length > 4 ? ` · +${ids.length - 4} more` : ''}
            </span>
            <Button size="sm" variant="outline" leadingIcon="check" onClick={() => onConfirm(ids)}>
              Confirm page {page + 1} ({ids.length})
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
