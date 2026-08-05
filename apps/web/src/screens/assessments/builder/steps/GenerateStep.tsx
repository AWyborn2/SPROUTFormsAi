import { useState } from 'react';
import { Icon } from '@formai/ui';
import { StructurePanel } from '../StructurePanel.js';
import { ArtifactPager } from '../ArtifactPager.js';
import { resolveStructure } from '../builder-structure.js';
import type { BuilderDraftState } from '../use-builder-draft.js';

/**
 * Step 2 — arrange the form, and look at what you have arranged.
 *
 * THE TWO HALVES ARE THE POINT. Extraction returns a document's fields in
 * printed order; a screen is not a sheet of paper, and this is the only place
 * in the product where somebody sees the whole shape of the form at once and
 * can move it. The preview is not decoration beside the editor — it is the
 * thing being edited, shown through the renderer a candidate will actually meet
 * (`FieldInput`), so what an author approves here is what gets filled in.
 *
 * The layout runs full-bleed: the panel is flush against the app sidebar and
 * full height, because an author scrolls the preview for minutes at a time and
 * a panel that scrolls away with it loses their place in a 185-field document.
 */
export function GenerateStep({ draft }: { draft: BuilderDraftState }) {
  const [collapsed, setCollapsed] = useState(false);

  /*
    Resolved on every render, and cheap: the only thing read from it here is
    whether anything was left unplaced. A field the arrangement never placed
    would vanish at publish, so it is raised HERE — while the author is looking
    at the arrangement that lost it — rather than discovered on the exported
    document months later.
  */
  const { orphanIds } = resolveStructure(draft.structure, draft.fields);
  const byId = new Map(draft.fields.map((f) => [f.id, f]));

  return (
    <div className="-mx-7 -mt-1 flex items-start gap-0">
      <StructurePanel
        structure={draft.structure}
        fields={draft.fields}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((c) => !c)}
        onReset={draft.structureOps.reset}
        onMoveSection={draft.structureOps.moveSection}
        onRenameSection={draft.structureOps.renameSection}
        onSetColumns={draft.structureOps.setColumns}
        onAddField={draft.fieldOps.add}
        onDeleteField={draft.fieldOps.remove}
        onFoldField={draft.fieldOps.foldInto}
        onToggleOwnPage={draft.structureOps.toggleOwnPage}
        onMoveField={draft.structureOps.moveField}
        onCycleSpan={draft.structureOps.cycleSpan}
        onSetFieldType={draft.structureOps.setFieldType}
        onGroup={draft.structureOps.group}
      />

      <div className="min-w-0 flex-1 px-7 pb-10">
        <div className="mb-3 flex items-start gap-2.5 text-[12px] leading-relaxed text-text-tertiary">
          <Icon name="sparkles" size={14} className="mt-0.5 flex-none text-accent" />
          <span>
            Built from the document’s own structure. Rearrange it on the left —{' '}
            <strong className="text-text-primary">nothing here is final</strong>, and the preview is
            the form a candidate will actually fill in.
          </span>
        </div>

        {orphanIds.length > 0 && (
          <div
            role="alert"
            className="mb-3 flex items-start gap-2.5 rounded-lg border border-warning-border bg-warning-soft p-[10px_14px] text-[12.5px] leading-relaxed text-warning-text"
          >
            <Icon name="alert-triangle" size={15} className="mt-0.5 flex-none" />
            <span>
              {orphanIds.length} field{orphanIds.length === 1 ? '' : 's'} sit
              {orphanIds.length === 1 ? 's' : ''} in no section and would not be published:{' '}
              <strong>
                {orphanIds
                  .slice(0, 3)
                  .map((id) => byId.get(id)?.label ?? id)
                  .join(', ')}
                {orphanIds.length > 3 ? ` and ${orphanIds.length - 3} more` : ''}
              </strong>
              . Drag them into a section.
            </span>
          </div>
        )}

        <ArtifactPager
          structure={draft.structure}
          fields={draft.fields}
          excluded={draft.excluded}
        />
      </div>
    </div>
  );
}
