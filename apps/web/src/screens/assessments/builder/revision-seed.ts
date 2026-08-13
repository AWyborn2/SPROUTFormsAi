/**
 * Seeding a builder draft from a PUBLISHED tool — the start of a revision.
 *
 * The published version is canonical for fields, geometry and answer keys:
 * they are copied VERBATIM, ids included, because the manifest, the keys and
 * every outcome target are keyed to those ids and a re-assignment silently
 * invalidates the lot (the import wizard's re-extract does exactly that,
 * which is why a revision never goes near it).
 *
 * Builder working state the version cannot reconstruct — structure grouping,
 * part edits, exclusions, setup answers, and above all WHO VERIFIED EACH
 * ANSWER KEY — seeds from the surviving build draft when one exists for the
 * same form. Without one, the seed reconstructs conservatively: structure is
 * rebuilt from the tool's own manifest parts (part keys are load-bearing —
 * attempts and Location rules reference them, so the derived parts must key
 * exactly as the published manifest does), and keys come back unverified.
 *
 * Verification carries ONLY where the answer is unchanged: the attestation is
 * "the training authority confirmed THESE answers", so an answer that differs
 * between the version and the draft record is nobody's attestation.
 */
import type {
  AssessmentToolManifest,
  DraftAnswerKey,
  FormField,
  StructureSection,
} from '@formai/shared';
import {
  emptySnapshot,
  fromDraftState,
  type BuilderSnapshot,
} from './builder-draft-state.js';

export interface RevisionSeedTool {
  id: string;
  templateId: string;
  name: string;
  manifest: AssessmentToolManifest;
}

export interface RevisionSeedVersion {
  id: string;
  label: string;
  fields: FormField[];
  sourcePdfAssetId: string | null;
}

export interface RevisionSeedInput {
  tool: RevisionSeedTool;
  version: RevisionSeedVersion;
  /**
   * The surviving build draft's stored `state`, when one exists. Used only
   * when its `formId` matches the tool's template — a draft for some other
   * document must not donate its structure or attestations.
   */
  priorDraftState?: unknown;
}

/** The deterministic revision-draft name — distinct from the build draft's. */
export function revisionDraftName(tool: RevisionSeedTool, version: RevisionSeedVersion): string {
  return `${tool.name} — revision of ${version.label}`;
}

/** Keys as the published fields carry them, unverified. */
function keysFromFields(fields: readonly FormField[]): DraftAnswerKey[] {
  return fields
    .filter((f) => Array.isArray(f.answerKey) && f.answerKey.length > 0)
    .map((f) => ({ fieldId: f.id, answerKey: [...f.answerKey!], source: 'manual' as const }));
}

/** Whether two keys name the same option set (order-free, exact-set). */
function sameKey(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((o) => b.includes(o));
}

/**
 * Structure reconstructed from the tool's OWN manifest parts.
 *
 * Each part becomes one section whose key IS the part key, so
 * `derivePartsFromStructure` (which keys parts by section key) reproduces the
 * published part keys exactly — attempts and Location rules reference them,
 * and a reconstruction that minted fresh keys would orphan both. Fields
 * before the first part's anchor are the cover, which emits no part.
 */
function structureFromManifest(
  manifest: AssessmentToolManifest,
  fields: readonly FormField[],
): StructureSection[] {
  const anchorAt = new Map<string, number>();
  for (const part of manifest.parts) {
    const at = fields.findIndex((f) => f.id === part.startFieldId);
    if (at >= 0) anchorAt.set(part.key, at);
  }
  const anchored = [...manifest.parts]
    .filter((p) => anchorAt.has(p.key))
    .sort((a, b) => anchorAt.get(a.key)! - anchorAt.get(b.key)!);

  const sections: StructureSection[] = [];
  const firstAnchor = anchored.length > 0 ? anchorAt.get(anchored[0]!.key)! : fields.length;
  if (firstAnchor > 0) {
    sections.push({
      key: 'cover_lead',
      label: 'Cover',
      cols: 2,
      cover: true,
      fields: fields.slice(0, firstAnchor).map((f) => ({ id: f.id })),
    });
  }
  for (let i = 0; i < anchored.length; i++) {
    const part = anchored[i]!;
    const from = anchorAt.get(part.key)!;
    const to = i + 1 < anchored.length ? anchorAt.get(anchored[i + 1]!.key)! : fields.length;
    sections.push({
      key: part.key,
      label: part.label,
      cols: 1,
      // The anchor header itself stays in the section — it is the part's
      // printed heading and the id the manifest's startFieldId names.
      fields: fields.slice(from, to).map((f) => ({ id: f.id })),
    });
  }
  return sections;
}

/**
 * Part edits that pin the derived manifest to the tool's stored one.
 *
 * Derivation guesses kind, pathways and the mandatory set from the fields;
 * the published manifest states them. Seeding each stored part as an override
 * means the units step opens showing exactly what is live, and a republish
 * that touches nothing re-publishes the same parts.
 */
function overridesFromManifest(
  manifest: AssessmentToolManifest,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const part of manifest.parts) {
    const { key: _key, ordinal: _ordinal, ...rest } = part;
    out[part.key] = rest as Record<string, unknown>;
  }
  return out;
}

/**
 * Compose the snapshot a "start revision" saves and opens the builder on.
 *
 * The result lands on the UPLOAD step — the keep-or-replace PDF choice is
 * explicit, never defaulted.
 */
export function seedRevisionSnapshot({
  tool,
  version,
  priorDraftState,
}: RevisionSeedInput): BuilderSnapshot {
  const base = emptySnapshot();
  const prior = priorDraftState ? fromDraftState(priorDraftState) : undefined;
  // A prior draft speaks only for THIS form. `formId` is set when the
  // placement step materialises the version, which every published tool's
  // build reached — a draft without it never published anything.
  const priorMatches = prior?.formId === tool.templateId;

  const fields = version.fields.map((f) => ({ ...f }));

  const seededKeys = keysFromFields(fields);
  const priorKeyByField = new Map(
    (priorMatches ? (prior?.keys ?? []) : []).map((k) => [k.fieldId, k]),
  );
  const keys = seededKeys.map((k) => {
    const recorded = priorKeyByField.get(k.fieldId);
    // R15: verification carries only for an unchanged answer.
    if (recorded && sameKey(recorded.answerKey, k.answerKey) && recorded.verifiedBy) {
      return {
        ...k,
        source: recorded.source,
        verifiedBy: recorded.verifiedBy,
        ...(recorded.verifiedAt ? { verifiedAt: recorded.verifiedAt } : {}),
      };
    }
    return k;
  });

  return {
    ...base,
    fileName: revisionDraftName(tool, version),
    extraction: null,
    fields,
    structure: priorMatches && prior ? prior.structure : structureFromManifest(tool.manifest, fields),
    groupCount: priorMatches && prior ? prior.groupCount : base.groupCount,
    setup: priorMatches && prior ? prior.setup : base.setup,
    excluded: priorMatches && prior ? prior.excluded : base.excluded,
    keys,
    partOverrides:
      priorMatches && prior ? prior.partOverrides : overridesFromManifest(tool.manifest),
    partOrder: priorMatches && prior ? prior.partOrder : tool.manifest.parts.map((p) => p.key),
    ...(version.sourcePdfAssetId
      ? { assetId: version.sourcePdfAssetId, seedAssetId: version.sourcePdfAssetId }
      : {}),
    formId: tool.templateId,
    // No versionId: the placement step forks a fresh draft version of the
    // SAME form when it is first opened.
    revisionOfToolId: tool.id,
    seededFromVersionId: version.id,
    revisionToolManifest: tool.manifest,
    carriedGeometry: {},
  };
}
