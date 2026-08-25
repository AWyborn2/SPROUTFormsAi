/**
 * The workflow the builder publishes, derived from the author's own structure.
 *
 * WHAT THIS REPLACES. Nothing wrote `manifest.workflow`, so every published
 * tool opened the editor on the SYNTHESISED default — one section per printed
 * part, where a part is a contiguous slice from its anchor to the next. The
 * author's seven structure sections collapsed to four cards: everything
 * printed between the declaration part's anchor and the next anchor
 * (signature, Prerequisites, More Coaching Required) was swallowed into
 * "Candidate declaration", and Candidate Details — before the first anchor,
 * inside no part at all — had no card anywhere.
 *
 * One section per STRUCTURE section instead, in the author's order. A section
 * whose fields became a part carries that `partKey`, which is what ties it to
 * the attempt flow; every other section lists its `fieldIds` directly — the
 * model's own mechanism for fields that belong to no part. Enforcement honours
 * the same shape: `partFieldAccess` lets a `fieldIds` section override the
 * slice its fields print inside.
 *
 * FIELD SOURCES ARE NOT OPTIONAL. `workflowOf` returns a stored workflow
 * VERBATIM — the synthesised default's auto-locking never runs — so an emitted
 * workflow that forgot `fieldSource` would reopen the hole the default closes:
 * every ✓/✗ outcome cell writable, a candidate able to mark their own
 * assessment. `autoSourcesFor` is therefore applied to every part section
 * here, and profile-mapped fields are marked `prefill` wherever they appear.
 */
import {
  assessorMarkAccess,
  autoSourcesFor,
  type AccessLevel,
  type AssessmentToolManifest,
  type AssessmentWorkflow,
  type BuilderStructure,
  type FormField,
  type ValueSource,
  type WorkflowSection,
} from '@formai/shared';
import type { DerivedPart } from './builder-manifest.js';

const EVERYONE_FILLS: Partial<Record<'candidate' | 'assessor', AccessLevel>> = {
  candidate: 'fill',
  assessor: 'fill',
};

/**
 * @param structure the builder's sections, in the author's order
 * @param parts the derived parts, each carrying the `sectionKey` it came from
 * @param manifest the manifest being built — read for parts and prefill only
 * @param fields the PUBLISHED field list; structure entries outside it
 *   (excluded questions) are dropped rather than referenced
 */
export function workflowFromStructure(
  structure: BuilderStructure,
  parts: readonly DerivedPart[],
  manifest: AssessmentToolManifest,
  fields: readonly FormField[],
): AssessmentWorkflow {
  const published = new Set(fields.map((f) => f.id));
  const partBySection = new Map(parts.map((p) => [p.sectionKey, p]));

  const sections: WorkflowSection[] = structure.map((section, index) => {
    const part = partBySection.get(section.key);
    const ids = section.fields.map((f) => f.id).filter((id) => published.has(id));

    /*
      Access defaults to everyone-fills — exactly the synthesised default, so
      publishing this workflow CHANGES NOTHING about who may write until the
      author says otherwise. Defaulting cover sections to assessor-only would
      be a better guess and still a guess; this module's doctrine is that
      quietly changing who may write a safety assessment is not a default's
      job.
    */
    const base: WorkflowSection = {
      key: section.key,
      ordinal: index + 1,
      label: section.label,
      access: { ...EVERYONE_FILLS },
    };

    if (part) {
      const manifestPart = manifest.parts.find((p) => p.key === part.key);
      return {
        ...base,
        partKey: part.key,
        ...(manifestPart
          ? {
              fieldSource: autoSourcesFor(manifest, manifestPart, fields),
              /*
                The other half of the lock split: `autoSourcesFor` now locks
                only KEYED questions' ✓/✗ cells (marking writes those), so an
                unkeyed written question's declared cell stays `entry` — and
                must come out candidate-view here, or publishing hands the
                candidate the box that records whether their own answer was
                satisfactory. Spreads to nothing for all-keyed tools, keeping
                their emitted sections byte-identical.
              */
              ...assessorMarkAccess(manifest, manifestPart, fields),
            }
          : {}),
      };
    }

    // No part: the fields ARE the coverage. Prefill-mapped ids are locked
    // here for the same reason autoSourcesFor locks them inside parts.
    const fieldSource: Record<string, ValueSource> = {};
    for (const id of ids) {
      if (manifest.profilePrefill?.[id]) fieldSource[id] = 'prefill';
    }
    return {
      ...base,
      fieldIds: ids,
      ...(Object.keys(fieldSource).length > 0 ? { fieldSource } : {}),
    };
  });

  return { roles: ['candidate', 'assessor'], sections };
}
