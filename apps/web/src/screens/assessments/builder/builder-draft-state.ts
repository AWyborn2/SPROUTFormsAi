/**
 * Turning the builder's live state into a row, and back.
 *
 * THE BUG THIS EXISTS FOR. `useBuilderDraftState` held everything in
 * `useState` and took a `draftId` it ignored — the underscore on the parameter
 * was the whole story. A refresh, a crash, a closed tab or a Replit redeploy
 * discarded the extraction, the corrected field types, the arranged structure,
 * every answer key, every matching pair and every unit edit. Hours of work, no
 * warning, no way back: the Form library's draft row led to the FORM builder
 * and the placement screen, neither of which knows what an answer key is.
 *
 * Everything under it was already built — the `assessment_tool_drafts` table,
 * its migration, the four routes, the resume list on the upload step. What was
 * missing was this: the conversion between the two shapes, and something to
 * call it. The resume list even rendered `null` unconditionally, because the
 * store fetched `/builder-drafts` while the router is mounted at
 * `/assessment-tool-drafts`, so the list was always empty.
 *
 * KEPT PURE AND SEPARATE from the hook because a round-trip is exactly the kind
 * of thing that silently drops one field, and a dropped field here is an
 * author's afternoon. A test can assert the round-trip; a `useEffect` cannot.
 */
import {
  DEFAULT_SETUP_ANSWERS,
  type AssessmentToolManifest,
  type BuilderDraft,
  type BuilderStructure,
  type DraftAnswerKey,
  type ExtractionResult,
  type FieldGeometry,
  type FormField,
  type RevisionIdentity,
  type SetupAnswers,
} from '@formai/shared';

/**
 * The builder state worth persisting — everything a resumed session needs and
 * nothing it can re-derive.
 *
 * `phase`, `stats`, `parts`, `manifest` and `manifestProblems` are all absent
 * deliberately: each is computed from what IS here, and a stored copy is a
 * second answer that can disagree with the first.
 */
export interface BuilderSnapshot {
  fileName: string | null;
  extraction: ExtractionResult | null;
  fields: FormField[];
  structure: BuilderStructure;
  groupCount: number;
  setup: SetupAnswers;
  excluded: Set<string>;
  keys: DraftAnswerKey[];
  assetId?: string;
  formId?: string;
  versionId?: string;
  partOverrides: Record<string, unknown>;
  partOrder: string[];
  /** Set when this draft REVISES a published tool rather than building one. */
  revisionOfToolId?: string;
  /** The version the revision was seeded from — republish refuses if the tool moved on. */
  seededFromVersionId?: string;
  /**
   * The tool's manifest as it stood at seed time. Republish starts from this
   * and overlays what the builder derives, so workflow-editor extras the
   * builder does not model (profile prefill, prerequisite checks, field
   * defaults) survive a revision untouched.
   */
  revisionToolManifest?: AssessmentToolManifest;
  /** The seeded source PDF's handle, kept so "revert to original" can restore it. */
  seedAssetId?: string;
  /** The paper revision identity captured for the version this draft publishes. */
  revisionIdentity?: RevisionIdentity;
  /**
   * Geometry carried off the fields when the PDF was REPLACED — proposals,
   * never confirmed geometry (a box confirmed against the old layout was not
   * confirmed against the new one). Keyed by field id.
   */
  carriedGeometry?: Record<string, FieldGeometry>;
}

/** The state a builder that has read nothing starts from. */
export function emptySnapshot(): BuilderSnapshot {
  return {
    fileName: null,
    extraction: null,
    fields: [],
    structure: [],
    groupCount: 1,
    setup: { ...DEFAULT_SETUP_ANSWERS, pathways: [...DEFAULT_SETUP_ANSWERS.pathways] },
    excluded: new Set(),
    keys: [],
    partOverrides: {},
    partOrder: [],
  };
}

/**
 * The snapshot as the row's `state` column.
 *
 * `excluded` is a `Set`, which `JSON.stringify` renders as `{}` — silently, and
 * the draft comes back with every excluded question re-included. It is written
 * out as `excludedFieldIds` for that reason, which is also the name
 * `BuilderDraft` already used.
 */
export function toDraftState(snapshot: BuilderSnapshot): Partial<BuilderDraft> {
  return {
    ...(snapshot.fileName !== null ? { fileName: snapshot.fileName } : {}),
    extraction: snapshot.extraction,
    fields: snapshot.fields,
    structure: snapshot.structure,
    groupCount: snapshot.groupCount,
    setup: snapshot.setup,
    excludedFieldIds: [...snapshot.excluded],
    keys: snapshot.keys,
    partOverrides: snapshot.partOverrides,
    partOrder: snapshot.partOrder,
    ...(snapshot.assetId ? { assetId: snapshot.assetId } : {}),
    ...(snapshot.formId ? { formId: snapshot.formId } : {}),
    ...(snapshot.versionId ? { versionId: snapshot.versionId } : {}),
    ...(snapshot.revisionOfToolId ? { revisionOfToolId: snapshot.revisionOfToolId } : {}),
    ...(snapshot.seededFromVersionId ? { seededFromVersionId: snapshot.seededFromVersionId } : {}),
    ...(snapshot.revisionToolManifest
      ? { revisionToolManifest: snapshot.revisionToolManifest }
      : {}),
    ...(snapshot.seedAssetId ? { seedAssetId: snapshot.seedAssetId } : {}),
    ...(snapshot.revisionIdentity ? { revisionIdentity: snapshot.revisionIdentity } : {}),
    ...(snapshot.carriedGeometry ? { carriedGeometry: snapshot.carriedGeometry } : {}),
  };
}

/**
 * A stored `state` back into live builder state.
 *
 * EVERY FIELD IS OPTIONAL ON THE WAY IN, and that is not defensive
 * over-engineering. The column is `jsonb` written by whichever build of the
 * client last saved it, and the route stores it opaque on purpose so the
 * builder can add state without a migration. A draft saved by yesterday's build
 * must still open in today's — falling back per field is what makes that true,
 * where destructuring with no defaults would throw on the first absent key and
 * lose the draft to a blank screen.
 */
export function fromDraftState(state: unknown): BuilderSnapshot {
  const base = emptySnapshot();
  if (!state || typeof state !== 'object') return base;
  const s = state as Partial<BuilderDraft> & Record<string, unknown>;

  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const arr = <T,>(v: unknown): T[] | undefined => (Array.isArray(v) ? (v as T[]) : undefined);

  return {
    fileName: str(s.fileName) ?? null,
    // An extraction is an object or it is nothing. A truthy non-object here
    // would reach `statsFor` and throw on a screen with no error state.
    extraction:
      s.extraction && typeof s.extraction === 'object' ? (s.extraction as ExtractionResult) : null,
    fields: arr<FormField>(s.fields) ?? base.fields,
    structure: (arr(s.structure) as BuilderStructure | undefined) ?? base.structure,
    groupCount: typeof s.groupCount === 'number' && s.groupCount >= 1 ? s.groupCount : 1,
    setup:
      s.setup && typeof s.setup === 'object' ? { ...base.setup, ...s.setup } : base.setup,
    excluded: new Set(arr<string>(s.excludedFieldIds) ?? []),
    keys: arr<DraftAnswerKey>(s.keys) ?? base.keys,
    partOverrides:
      s.partOverrides && typeof s.partOverrides === 'object'
        ? (s.partOverrides as Record<string, unknown>)
        : {},
    partOrder: arr<string>(s.partOrder) ?? [],
    ...(str(s.assetId) ? { assetId: str(s.assetId)! } : {}),
    ...(str(s.formId) ? { formId: str(s.formId)! } : {}),
    ...(str(s.versionId) ? { versionId: str(s.versionId)! } : {}),
    ...(str(s.revisionOfToolId) ? { revisionOfToolId: str(s.revisionOfToolId)! } : {}),
    ...(str(s.seededFromVersionId) ? { seededFromVersionId: str(s.seededFromVersionId)! } : {}),
    ...(s.revisionToolManifest && typeof s.revisionToolManifest === 'object'
      ? { revisionToolManifest: s.revisionToolManifest as AssessmentToolManifest }
      : {}),
    ...(str(s.seedAssetId) ? { seedAssetId: str(s.seedAssetId)! } : {}),
    ...(s.revisionIdentity && typeof s.revisionIdentity === 'object'
      ? { revisionIdentity: s.revisionIdentity as RevisionIdentity }
      : {}),
    ...(s.carriedGeometry && typeof s.carriedGeometry === 'object'
      ? { carriedGeometry: s.carriedGeometry as Record<string, FieldGeometry> }
      : {}),
  };
}

/**
 * Whether there is anything worth saving.
 *
 * The asset is the test rather than the extraction: the PDF is uploaded first
 * and is the one thing never re-derived, so a draft that has it can always be
 * resumed into something. Saving before that writes a named row with an empty
 * state, which then appears in "Pick up where you left off" offering to resume
 * nothing.
 */
export function isSaveable(snapshot: BuilderSnapshot): boolean {
  return Boolean(snapshot.assetId);
}

/**
 * What to call the draft.
 *
 * The document's own title, because the upsert key is (org, name) and that is
 * what makes autosaving one document overwrite its own row instead of laying
 * down a new one every couple of seconds. Two different papers with the same
 * title do collide — the same rule import drafts have always followed, and the
 * alternative is a resume list nobody can read.
 */
export function draftName(snapshot: BuilderSnapshot): string {
  const fromFile = snapshot.fileName?.replace(/\.pdf$/i, '').trim();
  return fromFile || 'Untitled assessment';
}
