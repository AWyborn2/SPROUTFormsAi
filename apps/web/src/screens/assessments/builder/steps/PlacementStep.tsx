import { GeometryEditorScreen } from '../../../import/GeometryEditorScreen.js';
import type { BuilderDraftState } from '../use-builder-draft.js';

/**
 * Step 6 — map each field onto the printed page.
 *
 * ONE COMPONENT, TWO MOUNTS (KTD7). This does not reimplement placement; it
 * mounts the standalone `GeometryEditorScreen` against the builder's own draft
 * version. That screen already carries the PDF viewer, the proposal tiering,
 * the band editing, the whole-box drag and nudge, the glyph picker and — most
 * importantly — the confirm gate that keeps unreviewed proposals out of the
 * published geometry. A second placement UI would be a second place for that
 * gate to be got wrong, on the artifact that decides where marks print on a
 * competency record.
 *
 * IT NEEDS A DRAFT VERSION TO PLACE AGAINST, and says so rather than rendering
 * an empty canvas. Geometry is stored on a version's fields — that is where the
 * exporter reads it from — so there is nothing to place onto until the builder
 * has materialised one. Which step creates it is the open question recorded in
 * the plan; until it is answered this step reports the state honestly instead of
 * pretending to a surface that would silently discard every box drawn on it.
 */
export interface PlacementStepProps {
  draft: BuilderDraftState;
}

export function PlacementStep({ draft }: PlacementStepProps) {
  const { formId, versionId } = draft;

  if (!formId || !versionId) {
    return (
      <div className="rounded-[14px] border border-border bg-surface-card p-4">
        <span className="block text-[14.5px] font-semibold">PDF mapping</span>
        <p className="mt-1 text-[12.5px] leading-relaxed text-text-secondary">
          Placement writes geometry onto a form version&rsquo;s fields — that is where the exporter
          reads it from — so this step needs the builder to have created a draft version first.
          Until it has, boxes drawn here would have nowhere to be saved.
        </p>
        <p className="mt-2 text-[11.5px] text-text-tertiary">
          Every placement tool is already built and working on the standalone screen: drag, nudge
          and delete a box, the grouped and filterable field list, the response/outcome pair rows,
          and the glyph picker. This step mounts that same screen — it is waiting on the version,
          not on the tools.
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
      <GeometryEditorScreen formId={formId} versionId={versionId} embedded />
    </div>
  );
}
