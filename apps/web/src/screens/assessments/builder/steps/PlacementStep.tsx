import { useEffect, useRef } from 'react';
import { useCreateDraftForm } from '../../../../lib/data/hooks.js';
import { GeometryEditorScreen } from '../../../import/GeometryEditorScreen.js';
import type { BuilderDraftState } from '../use-builder-draft.js';

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

export function PlacementStep({ draft }: PlacementStepProps) {
  const { formId, versionId, setVersionIds, setPlacedFields, fields, excluded, assetId, title } =
    draft;
  const createDraftForm = useCreateDraftForm();
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

  if (fields.length === 0) {
    return (
      <p className="rounded-[14px] border border-border bg-surface-card p-4 text-[12.5px] text-text-secondary">
        Upload a document first — there is nothing to place yet.
      </p>
    );
  }

  if (!formId || !versionId) {
    return (
      <div className="rounded-[14px] border border-border bg-surface-card p-4">
        <span className="block text-[14.5px] font-semibold">
          {createDraftForm.isPending ? 'Preparing the document…' : 'Could not prepare the document'}
        </span>
        <p className="mt-1 text-[12.5px] leading-relaxed text-text-secondary">
          {createDraftForm.isPending
            ? 'Creating the draft version this step places geometry onto. It stays a draft until you publish, so nobody can fill it in the meantime.'
            : 'The draft version could not be created, so there is nowhere to save a placement — a box drawn now would have nothing to be saved onto. Move away from this step and back to try again.'}
        </p>
      </div>
    );
  }

  return (
    <div className="-mx-[22px] -my-3">
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
      <GeometryEditorScreen
        formId={formId}
        versionId={versionId}
        embedded
        onSaved={setPlacedFields}
      />
    </div>
  );
}
