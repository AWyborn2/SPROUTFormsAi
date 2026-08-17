import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_SETUP_ANSWERS,
  hasAnyMatchSide,
  hasBothMatchSides,
  isChoiceField,
  validateManifest,
  type AssessmentPathway,
  type AssessmentToolManifest,
  type BuilderStep,
  type BuiltMatchingQuestion,
  type BuilderStructure,
  type DraftAnswerKey,
  type AssessmentToolManifest as ToolManifest,
  type ExtractionResult,
  type FieldGeometry,
  type FormField,
  type FormFieldType,
  type KeySource,
  type RevisionIdentity,
  type MatchPresentation,
  type SectionColumns,
  type SetupAnswers,
} from '@formai/shared';
import { apiClient, ApiError } from '../../../lib/data/api-client.js';
import { fileToBase64, IMPORT_REQUEST_TIMEOUT_MS } from '../../../lib/data/import-session.js';
import { retypeField } from '../../../lib/field-editor/reducer.js';
import * as Structure from './builder-structure.js';
import {
  addField,
  deleteField,
  duplicateSection,
  mergeIntoDescription,
  mergeRepeatingTable,
  renameField,
  setOutcomeTarget,
} from './builder-fields.js';
import {
  buildManifest,
  derivePartsFromStructure,
  movePart,
  setPathways as setPartPathways,
  updatePart,
  type DerivedPart,
} from './builder-manifest.js';
import { structureFromExtraction } from './builder-structure.js';
import { resolvePublishFields } from './builder-publish.js';
import type { BuilderSnapshot } from './builder-draft-state.js';

/**
 * The builder's working state for one tool.
 *
 * EXTRACTION RUNS ON THE SERVER, always. The design prototype called the model
 * from the page, which puts a key in the browser and the whole document on the
 * wire from an untrusted origin. This posts to `/pdf/extract`, which is
 * tenant-scoped, carries the tuned assessment profile, and is the same call the
 * import wizard makes — one extraction path, not two.
 *
 * THE PHASES ARE REAL. Each one corresponds to a request or a step of work that
 * actually happens, so a stall shows where. A timed animation would say
 * "extracting questions" while a request that failed thirty seconds ago sat
 * unhandled.
 */

export type BuilderPhase = 'idle' | 'uploading' | 'extracting' | 'building' | 'ready' | 'error';

/** What the phase list shows, in order, with the phase each row completes at. */
export const BUILDER_PHASES: { key: BuilderPhase; label: string }[] = [
  { key: 'uploading', label: 'Uploading the document' },
  { key: 'extracting', label: 'Reading its parts, questions and fields' },
  { key: 'building', label: 'Building the field manifest' },
  { key: 'ready', label: 'Drafting the setup questions' },
];

/**
 * What the extraction found, in the terms the first step reports.
 *
 * `parts` counts the PART headings the assessment profile asks for, not
 * sections generally — a heading is what a part can be anchored to, and a count
 * that included every sub-heading would promise structure the manifest step
 * cannot use.
 */
export interface ExtractionStats {
  pages: number;
  parts: number;
  fields: number;
  questions: number;
  /** Matching questions the extraction read both sides of. */
  matchesComplete: number;
  /** Matching questions missing a side — these need the pair builder. */
  matchesIncomplete: number;
  /** Cover fields that read as prerequisites. */
  prerequisites: number;
}

const PART_HEADING = /^\s*part\s+\d+/i;

export function statsFor(extraction: ExtractionResult): ExtractionStats {
  const fields = extraction.fields;
  const questions = fields.filter((f) => isChoiceField(f.type) && (f.options?.length ?? 0) > 0);
  const matching = fields.filter((f) => hasAnyMatchSide(f));
  return {
    pages: extraction.pageCount,
    parts: fields.filter((f) => f.type === 'section_header' && PART_HEADING.test(f.label)).length,
    // Section headers are structure, not fields somebody fills in — counting
    // them would inflate the number the placement step is measured against.
    fields: fields.filter((f) => f.type !== 'section_header').length,
    questions: questions.length + matching.length,
    matchesComplete: matching.filter((f) => hasBothMatchSides(f)).length,
    matchesIncomplete: matching.filter((f) => !hasBothMatchSides(f)).length,
    prerequisites: fields.filter((f) => f.coverSection === 'pathway_prerequisites').length,
  };
}

/**
 * Undo and redo over the author's edits.
 *
 * The history covers what the AUTHOR changes — fields, structure, keys,
 * exclusions, setup answers, part edits — and deliberately not the document
 * itself, the extraction, or the draft's storage ids: undoing past the upload
 * would strand a builder whose form version still exists, and "undo" on a
 * server-side fact is a lie the next autosave would expose.
 */
export interface BuilderHistory {
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

/** The slices undo/redo travels over — exactly what the author edits. */
interface EditableState {
  fields: FormField[];
  structure: BuilderStructure;
  keys: DraftAnswerKey[];
  excluded: Set<string>;
  setup: SetupAnswers;
  partOverrides: Record<string, Partial<Omit<DerivedPart, 'key' | 'ordinal' | 'sectionKey'>>>;
  partOrder: string[];
  groupCount: number;
}

/** Edits closer together than this undo as one step — a word, not a keystroke. */
const HISTORY_COALESCE_MS = 800;
/** Steps kept. Beyond this the oldest fall away rather than growing without bound. */
const HISTORY_LIMIT = 100;

export interface BuilderDraftState {
  phase: BuilderPhase;
  error: string | null;
  fileName: string | null;
  extraction: ExtractionResult | null;
  fields: FormField[];
  stats: ExtractionStats | null;
  setup: SetupAnswers;
  excluded: Set<string>;
  structure: BuilderStructure;
  hasDocument: boolean;
  title: string | null;
  pageCount: number;
  keys: DraftAnswerKey[];
  /**
   * The form version this draft places against, once one exists.
   *
   * Geometry is stored on a VERSION's fields — that is where the exporter reads
   * it — so the placement step needs one before a box can be saved anywhere.
   * Absent until the builder materialises it; `BuilderDraft` has carried these
   * two ids since Phase A for exactly this.
   */
  formId?: string;
  versionId?: string;
  /** The uploaded PDF's storage handle, for the version to carry. */
  assetId?: string;
  /** Set when this draft REVISES a published tool. Gates every revision branch. */
  revisionOfToolId?: string;
  /** The version the revision was seeded from — republish refuses if the tool moved on. */
  seededFromVersionId?: string;
  /** The tool's manifest at seed time; republish overlays the builder's onto it. */
  revisionToolManifest?: ToolManifest;
  /** The paper revision identity the publish step captures. */
  revisionIdentity?: RevisionIdentity;
  /** Geometry carried off the fields when the PDF was replaced — proposals only. */
  carriedGeometry: Record<string, FieldGeometry>;
  /** Whether a replacement PDF is in force (revert is offered). */
  pdfReplaced: boolean;
  /**
   * Replace the source PDF in a revision: swap the asset handle and move every
   * field's geometry into the carried stash — a box confirmed against the old
   * layout is a PROPOSAL against the new one, never confirmed geometry.
   */
  replacePdf: (assetId: string, fileName: string) => void;
  /** Undo a mis-upload: original PDF back, carried geometry back on as confirmed. */
  revertPdf: () => void;
  /** Record the rev code / review date / change note the publish step captures. */
  setRevisionIdentity: (patch: Partial<RevisionIdentity>) => void;
  /** Confirm carried boxes onto the fields (placement's apply path). */
  confirmCarried: (fieldIds: readonly string[]) => void;
  /** Record the draft version the placement step created. */
  setVersionIds: (formId: string, versionId: string) => void;
  /**
   * Forget a version that no longer exists — the placement step's recovery
   * path when the form the snapshot remembered was deleted server-side.
   * Clearing the ids hands control back to that step's create-on-arrival
   * effect, which re-materialises a version from the draft's OWN fields.
   */
  clearVersionIds: () => void;
  /**
   * Take the geometry back from the placement step.
   *
   * THE DRAFT'S FIELD LIST IS WHAT PUBLISHES. `WorkflowStep` validates
   * `checkPublish(fields, …)` and writes the result to the version, so anything
   * the placement editor saved onto the version but not back into here is
   * OVERWRITTEN at publish — silently, because the boxes were on screen the
   * whole time. That is what this closes.
   *
   * Merged by id rather than replacing the list: the placement editor is given
   * the fields minus the ones the author excluded, so its list is a subset, and
   * taking it wholesale would delete every excluded question from the draft.
   */
  setPlacedFields: (placed: FormField[]) => void;
  /** Parts as the units step shows them: derived from structure, then edited. */
  parts: DerivedPart[];
  /** The manifest those parts assemble into, ready for validateManifest. */
  manifest: AssessmentToolManifest;
  /** Live problems from the SHARED validator. Never a second rule set. */
  manifestProblems: string[];
  ingest: (file: File) => Promise<void>;
  setSetup: (patch: Partial<SetupAnswers>) => void;
  toggleExcluded: (fieldId: string) => void;
  reset: () => void;
  /** Structure edits. Each delegates to a pure operation in builder-structure.ts. */
  structureOps: StructureOps;
  /** Answer-key edits. */
  keyOps: KeyOps;
  /** Adding, deleting and folding away fields the extraction got wrong. */
  fieldOps: FieldOps;
  /** Unit / part edits. */
  partOps: PartOps;
  /** Undo/redo over every author edit, on every step. */
  history: BuilderHistory;
  /**
   * Everything worth persisting, recomputed as the author works.
   *
   * Exposed rather than saved from in here: this hook stays state and pure
   * reducers, and `use-builder-persistence.ts` does the writing. A consumer
   * that only wants builder state — every test of one — needs no provider and
   * makes no request.
   */
  snapshot: BuilderSnapshot;
}

export interface FieldOps {
  /** Add a field the extraction missed, after `afterFieldId` (null = first). */
  add: (sectionKey: string, afterFieldId: string | null, type: FormFieldType, label: string) => void;
  /** Rename a field — including one `add` created as "New field". */
  rename: (fieldId: string, label: string) => void;
  /** Delete a field the extraction invented, and every reference to it. */
  remove: (fieldId: string) => void;
  /** Fold a field into another's description — a printed instruction, not a box. */
  foldInto: (fieldId: string, targetFieldId: string) => void;
  /**
   * Point a question's derived ✓/✗ at the box that records it. `null` goes back
   * to resolving the link from the printed reference.
   *
   * Needed because a box the extraction MISSED carries no `questionRef` — so
   * the automatic route cannot see it, and without this the field an author
   * created to fix a gap could never receive a mark.
   */
  setOutcomeTarget: (questionId: string, outcomeFieldId: string | null) => void;
  /**
   * Patch one field's own properties — the column editor's write path.
   *
   * The shared `ColumnInspector` drives every host through a
   * `(patch: Partial<FormField>) => void` adapter (`builderColumnActions`),
   * and columns, answer sets and fixed rows all live ON the field — so one
   * patch op is the whole integration, and the history layer sees it as one
   * step like any other field edit.
   */
  patch: (fieldId: string, patch: Partial<FormField>) => void;
  /**
   * Merge one checklist table's rows into another, removing the source.
   *
   * Extraction splits ONE printed checklist across a page or batch boundary
   * into two `repeating_group` tables; this puts the stray table's rows back
   * where they belong AS FIXED ROWS — pre-printed and locked, like the rows
   * already there — rather than the ad-hoc, candidate-editable rows that
   * re-adding them by hand on a fill surface would create.
   */
  mergeTable: (sourceFieldId: string, targetFieldId: string) => void;
}

export interface PartOps {
  /** Change PROCESS order. Never touches `ordinal` — see R14. */
  move: (key: string, delta: number) => void;
  setPathways: (key: string, pathways: readonly AssessmentPathway[]) => void;
  update: (key: string, patch: Partial<Omit<DerivedPart, 'key' | 'ordinal' | 'sectionKey'>>) => void;
  /** Drop every override and go back to what the structure derives. */
  reset: () => void;
}

export interface KeyOps {
  /**
   * Set one question's key outright.
   *
   * Setting an EMPTY key removes the entry rather than storing a key of zero
   * options. `markTheory` skips a field whose `answerKey` is absent or empty
   * and treats it as not-auto-marked — so an empty entry and no entry mean the
   * same thing to marking, and keeping both would let the UI report a question
   * as keyed that contributes no mark.
   */
  setKey: (fieldId: string, answerKey: string[], source?: KeySource) => void;
  /** Toggle one option in a key, for a question that takes a set. */
  toggleOption: (fieldId: string, option: string, multiple: boolean) => void;
  /** Record or withdraw the attestation, with who made it. */
  setVerified: (fieldId: string, verified: boolean, actor: string) => void;
  /**
   * Mark a question as the ASSESSOR'S VERDICT rather than a keyable question.
   *
   * Clears any key it already had, in the same operation. A verdict with an
   * answer key is a contradiction the rest of the system would have to keep
   * choosing between — and `markTheory` reads the key, so leaving one would
   * quietly grade a judgement.
   */
  setAssessorVerdict: (fieldId: string, verdict: boolean) => void;
  /** Save a matching question: options onto the field, key into the draft. */
  saveMatching: (
    fieldId: string,
    built: BuiltMatchingQuestion,
    presentation: MatchPresentation,
  ) => void;
  /**
   * Apply a batch of keys read from a guide.
   *
   * REPLACES the key for each field it names and leaves every other key alone,
   * so seeding a guide that covers one stream does not wipe the stream an
   * author has already typed. Nothing seeded carries an attestation — a person
   * still has to say they checked it.
   */
  seedKeys: (keys: readonly DraftAnswerKey[]) => void;
}

export interface StructureOps {
  moveSection: (key: string, delta: number) => void;
  renameSection: (key: string, label: string) => void;
  setColumns: (key: string, cols: SectionColumns) => void;
  toggleOwnPage: (key: string) => void;
  /**
   * Remove a section from the arrangement. Its fields move to the section
   * before it (never deleted — a field that vanishes is one nobody notices is
   * missing), so on an EMPTY section this is a plain delete. The section's
   * header field simply stops publishing: `resolveStructure` emits headers
   * from sections, and its orphan report deliberately ignores headers.
   */
  dissolve: (key: string) => void;
  /** Clone a section — fields, geometry and all — for multi-stage papers. */
  duplicate: (key: string) => void;
  moveField: (
    fieldId: string,
    toSectionKey: string,
    beforeFieldId: string | null,
    after: boolean,
  ) => void;
  cycleSpan: (sectionKey: string, fieldId: string) => void;
  group: (fieldIds: string[]) => void;
  setFieldType: (fieldId: string, type: FormFieldType) => void;
  reset: () => void;
}

const ERRORS = {
  aiUnavailable: "This PDF needs AI extraction, which isn't configured on the server yet.",
  storageUnavailable: "File storage isn't available right now — try again shortly.",
  tooLarge: 'This PDF is too large to import — the limit is 25 MB.',
  sessionExpired: 'Your session has expired — sign in again, then retry.',
  timeout: 'Reading the document timed out. A long assessment can take a few minutes — try again.',
  empty: 'No questions or fillable fields were found in this document.',
  generic: 'Something went wrong reading this PDF. Please try again.',
} as const;

function messageForError(err: unknown): string {
  if (err instanceof ApiError) {
    const bodyError =
      typeof err.body === 'object' && err.body !== null && 'error' in err.body
        ? String((err.body as { error: unknown }).error)
        : '';
    if (err.status === 401) return ERRORS.sessionExpired;
    if (err.status === 422 && bodyError.startsWith('extraction_unavailable')) {
      return ERRORS.aiUnavailable;
    }
    if (err.status === 503) return ERRORS.storageUnavailable;
    if (err.status === 413) return ERRORS.tooLarge;
    if (err.status === 0 && bodyError === 'request_timeout') return ERRORS.timeout;
  }
  if (err instanceof Error && err.message === 'empty_extraction') return ERRORS.empty;
  return ERRORS.generic;
}

/**
 * Extracted fields as the builder's editable copy.
 *
 * The extraction is kept whole and separate: a later step re-reads it to answer
 * "what did the document actually say", which an edited copy can no longer
 * answer.
 */
function seedFields(extraction: ExtractionResult): FormField[] {
  return extraction.fields.map((f) => ({
    id: f.id,
    type: f.type,
    label: f.label,
    required: f.required ?? false,
    source: 'imported' as const,
    ...(f.description ? { description: f.description } : {}),
    ...(f.options ? { options: [...f.options] } : {}),
    ...(f.selectionType ? { selectionType: f.selectionType } : {}),
    ...(f.columns ? { columns: f.columns } : {}),
    ...(f.answerSets ? { answerSets: f.answerSets } : {}),
    ...(f.fixedRows ? { fixedRows: f.fixedRows } : {}),
    ...(f.sourcePosition ? { sourcePosition: f.sourcePosition } : {}),
    confidence: f.confidence,
  }));
}

/** What a resumed draft hands the builder to start from. */
export interface BuilderDraftStateOptions {
  /**
   * A saved snapshot to restore, once it has been read.
   *
   * Plain data, applied exactly once. Reading it is `use-builder-persistence`'s
   * job — keeping the request out of here is what lets a test of builder state
   * render without a `QueryClientProvider`.
   */
  hydrateFrom?: BuilderSnapshot | null;
}

export function useBuilderDraftState({
  hydrateFrom,
}: BuilderDraftStateOptions = {}): BuilderDraftState {
  const [phase, setPhase] = useState<BuilderPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [extraction, setExtraction] = useState<ExtractionResult | null>(null);
  const [fields, setFields] = useState<FormField[]>([]);
  const [structure, setStructure] = useState<BuilderStructure>([]);
  /** Monotonic, so a grouped section's key cannot collide with an earlier one. */
  const [groupCount, setGroupCount] = useState(1);
  const [setup, setSetupState] = useState<SetupAnswers>(() => ({
    ...DEFAULT_SETUP_ANSWERS,
    pathways: [...DEFAULT_SETUP_ANSWERS.pathways],
  }));
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [keys, setKeys] = useState<DraftAnswerKey[]>([]);
  /*
    The uploaded PDF's storage handle, kept so the draft version can carry it.

    Without it the version has no `sourcePdfAssetId`, the placement screen has
    no page to draw on, and the round-trip export has no original to overlay —
    the document is the one thing in this pipeline that is never re-derived.
  */
  const [assetId, setAssetId] = useState<string | undefined>(undefined);
  /*
    THE DRAFT VERSION THE BUILDER PLACES AGAINST.

    Created UP FRONT rather than at publish, because geometry lives on a
    version's fields — that is where the exporter reads it — so there is nowhere
    to put a box until one exists, and the placement step sits before publish in
    the author's order.

    THE DRAFT OWNS THE FIELDS; the version is where they are written. Every
    consumer in the builder already assumed this — `checkPublish`,
    `publishSummary` and the manifest validator all read `fields` from here —
    and the placement step now hands its geometry back through
    `setPlacedFields` so the one list carries it.

    This comment used to say the version owned them. It never did: nothing in
    the builder read a version back, so geometry saved onto the version and not
    into this list was silently overwritten by the publish step. Two copies that
    can disagree is the failure refused everywhere else in this work, and it was
    live here.
  */
  const [formId, setFormId] = useState<string | undefined>(undefined);
  const [versionId, setVersionId] = useState<string | undefined>(undefined);
  /*
    ── Revision mode ───────────────────────────────────────────────────────

    Set only by hydrating a seeded revision draft (`revision-seed.ts`); a
    fresh build never touches these. `carriedGeometry` is the KTD2 stash:
    stored geometry means CONFIRMED everywhere it is read — the exporter above
    all — so boxes carried across a PDF replacement live here as proposals
    until a reviewer confirms them back onto the fields.
  */
  const [revisionOfToolId, setRevisionOfToolId] = useState<string | undefined>(undefined);
  const [seededFromVersionId, setSeededFromVersionId] = useState<string | undefined>(undefined);
  const [revisionToolManifest, setRevisionToolManifest] = useState<ToolManifest | undefined>(
    undefined,
  );
  const [seedAssetId, setSeedAssetId] = useState<string | undefined>(undefined);
  const [revisionIdentity, setRevisionIdentityState] = useState<RevisionIdentity | undefined>(
    undefined,
  );
  const [carriedGeometry, setCarriedGeometry] = useState<Record<string, FieldGeometry>>({});
  /*
    PARTS ARE DERIVED, WITH THE AUTHOR'S EDITS LAYERED ON TOP.

    Holding a resolved list would freeze the manifest at the moment the units
    step first opened: rename a section or key another question afterwards and
    the part would still carry the old label and the old mandatory set, with
    nothing saying they had diverged. Instead the base is re-derived from
    structure on every render and these two hold only what the author changed —
    so a structure edit flows straight through, and an edit survives it.
  */
  const [partOverrides, setPartOverrides] = useState<
    Record<string, Partial<Omit<DerivedPart, 'key' | 'ordinal' | 'sectionKey'>>>
  >({});
  const [partOrder, setPartOrder] = useState<string[]>([]);

  /*
    ── Undo / redo ─────────────────────────────────────────────────────────

    Snapshots of the EDITABLE state, recorded as it changes rather than by
    instrumenting forty operations. The recording effect below watches the
    assembled object; three flags tell it what a change meant:

    - `historyBaseline`: hydrate, ingest and reset REPLACE the world. They
      clear both stacks — undo must never carry an author back to the empty
      builder that preceded their document.
    - `historyRestoring`: an undo/redo landing. Recorded by the undo/redo
      functions themselves; the effect only re-syncs its reference.
    - Coalescing: edits within a short window collapse into one step, so a
      rename typed letter by letter undoes as a word, not a keystroke.
  */
  const historyPast = useRef<EditableState[]>([]);
  const historyFuture = useRef<EditableState[]>([]);
  const historyPrev = useRef<EditableState | null>(null);
  const historyBaseline = useRef(false);
  const historyRestoring = useRef(false);
  const historyLastEditAt = useRef(0);
  /** Bumped whenever the stacks change, so canUndo/canRedo re-render. */
  const [historyVersion, setHistoryVersion] = useState(0);

  /*
    ── Resuming ────────────────────────────────────────────────────────────

    Everything above used to live and die with the browser tab: the hook took a
    `draftId` and ignored it, and nothing ever saved. A refresh discarded the
    extraction, the corrected types, the structure, every answer key and every
    unit edit, with no warning and no way back.

    THE I/O IS NOT HERE, and that is deliberate — this hook's contract is state
    and pure reducers. Pulling react-query into it made every consumer need a
    `QueryClientProvider` to hold a field list, which is exactly what the note
    on `setVersionIds` says not to do; three test files went red the moment it
    was tried. `use-builder-persistence.ts` owns the reading and writing, and
    hands the result in as plain data.
  */

  /*
    HYDRATE ONCE. A re-render that re-ran this would overwrite the author's
    live edits with the snapshot they started from — worse than not persisting
    at all.
  */
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current || !hydrateFrom) return;
    hydrated.current = true;

    historyBaseline.current = true;
    setFileName(hydrateFrom.fileName);
    setExtraction(hydrateFrom.extraction);
    setFields(hydrateFrom.fields);
    setStructure(hydrateFrom.structure);
    setGroupCount(hydrateFrom.groupCount);
    setSetupState(hydrateFrom.setup);
    setExcluded(hydrateFrom.excluded);
    setKeys(hydrateFrom.keys);
    setPartOverrides(
      hydrateFrom.partOverrides as Record<
        string,
        Partial<Omit<DerivedPart, 'key' | 'ordinal' | 'sectionKey'>>
      >,
    );
    setPartOrder(hydrateFrom.partOrder);
    setAssetId(hydrateFrom.assetId);
    setFormId(hydrateFrom.formId);
    setVersionId(hydrateFrom.versionId);
    setRevisionOfToolId(hydrateFrom.revisionOfToolId);
    setSeededFromVersionId(hydrateFrom.seededFromVersionId);
    setRevisionToolManifest(hydrateFrom.revisionToolManifest);
    setSeedAssetId(hydrateFrom.seedAssetId);
    setRevisionIdentityState(hydrateFrom.revisionIdentity);
    setCarriedGeometry(hydrateFrom.carriedGeometry ?? {});
    /*
      `ready` SPECIFICALLY, because `hasDocument` is
      `phase === 'ready' && extraction !== null` and every step past upload is
      blocked on it. Any other phase resumes a complete draft into a builder
      where the whole stepper is disabled — the document is there, the fields
      are there, and nothing can be opened.

      A draft with no extraction never got past upload, so it stays idle and
      the author lands on the dropzone, which is correct — EXCEPT a revision
      draft, which never has an extraction: it was seeded from a published
      version, its fields ARE the document, and it must open ready (KTD7).
    */
    setPhase(
      hydrateFrom.extraction || (hydrateFrom.revisionOfToolId && hydrateFrom.fields.length > 0)
        ? 'ready'
        : 'idle',
    );
  }, [hydrateFrom]);

  /** Everything worth saving, for the persistence hook to write. */
  const snapshot: BuilderSnapshot = useMemo(
    () => ({
      fileName,
      extraction,
      fields,
      structure,
      groupCount,
      setup,
      excluded,
      keys,
      partOverrides,
      partOrder,
      ...(assetId ? { assetId } : {}),
      ...(formId ? { formId } : {}),
      ...(versionId ? { versionId } : {}),
      ...(revisionOfToolId ? { revisionOfToolId } : {}),
      ...(seededFromVersionId ? { seededFromVersionId } : {}),
      ...(revisionToolManifest ? { revisionToolManifest } : {}),
      ...(seedAssetId ? { seedAssetId } : {}),
      ...(revisionIdentity ? { revisionIdentity } : {}),
      ...(Object.keys(carriedGeometry).length > 0 ? { carriedGeometry } : {}),
    }),
    [
      fileName,
      extraction,
      fields,
      structure,
      groupCount,
      setup,
      excluded,
      keys,
      partOverrides,
      partOrder,
      assetId,
      formId,
      versionId,
      revisionOfToolId,
      seededFromVersionId,
      revisionToolManifest,
      seedAssetId,
      revisionIdentity,
      carriedGeometry,
    ],
  );

  const ingest = useCallback(async (file: File) => {
    setError(null);
    setFileName(file.name);
    setPhase('uploading');
    try {
      const base64 = await fileToBase64(file);
      const { assetId: uploadedAssetId } = await apiClient.post<{ assetId: string }>(
        '/pdf/upload',
        { pdfBase64: base64 },
        { timeoutMs: IMPORT_REQUEST_TIMEOUT_MS },
      );

      setPhase('extracting');
      const result = await apiClient.post<ExtractionResult>(
        '/pdf/extract',
        // Always `assessment`: this surface exists for one document class, and
        // leaving the type generic collapses a paper's questions back into
        // table rows — the failure the profile exists to prevent.
        { assetId: uploadedAssetId, fileName: file.name, documentType: 'assessment' },
        { timeoutMs: IMPORT_REQUEST_TIMEOUT_MS },
      );

      setPhase('building');
      const usable = result.fields.filter((f) => f.type !== 'section_header');
      if (usable.length === 0) throw new Error('empty_extraction');

      historyBaseline.current = true;
      setExtraction(result);
      setFields(seedFields(result));
      setStructure(structureFromExtraction(result));
      setAssetId(uploadedAssetId);
      setExcluded(new Set());
      setKeys([]);
      setPartOverrides({});
      setPartOrder([]);
      setGroupCount(1);
      setPhase('ready');
    } catch (err) {
      setError(messageForError(err));
      setPhase('error');
    }
  }, []);

  const setSetup = useCallback((patch: Partial<SetupAnswers>) => {
    setSetupState((prev) => ({ ...prev, ...patch }));
  }, []);

  const toggleExcluded = useCallback((fieldId: string) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(fieldId)) next.delete(fieldId);
      else next.add(fieldId);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    historyBaseline.current = true;
    setPhase('idle');
    setError(null);
    setFileName(null);
    setExtraction(null);
    setFields([]);
    setStructure([]);
    setExcluded(new Set());
    setKeys([]);
    setAssetId(undefined);
    setPartOverrides({});
    setPartOrder([]);
  }, []);

  /*
    ── History recording ───────────────────────────────────────────────────

    One assembled object so ONE effect sees every author edit, whichever of the
    eight slices it landed in — an op that writes fields AND keys (delete,
    matching) records as one step, because it committed as one render.
  */
  const editable = useMemo<EditableState>(
    () => ({ fields, structure, keys, excluded, setup, partOverrides, partOrder, groupCount }),
    [fields, structure, keys, excluded, setup, partOverrides, partOrder, groupCount],
  );

  useEffect(() => {
    if (historyBaseline.current) {
      historyBaseline.current = false;
      historyPast.current = [];
      historyFuture.current = [];
      historyPrev.current = editable;
      setHistoryVersion((v) => v + 1);
      return;
    }
    if (historyRestoring.current) {
      historyRestoring.current = false;
      historyPrev.current = editable;
      return;
    }
    if (historyPrev.current === null) {
      historyPrev.current = editable;
      return;
    }
    if (historyPrev.current === editable) return;

    const now = Date.now();
    // Within the window the stack already holds the pre-burst state; only the
    // reference moves. A NEW edit always invalidates redo either way.
    if (now - historyLastEditAt.current > HISTORY_COALESCE_MS) {
      historyPast.current.push(historyPrev.current);
      if (historyPast.current.length > HISTORY_LIMIT) historyPast.current.shift();
    }
    historyLastEditAt.current = now;
    historyFuture.current = [];
    historyPrev.current = editable;
    setHistoryVersion((v) => v + 1);
  }, [editable]);

  const applyEditable = useCallback((s: EditableState) => {
    setFields(s.fields);
    setStructure(s.structure);
    setKeys(s.keys);
    setExcluded(s.excluded);
    setSetupState(s.setup);
    setPartOverrides(s.partOverrides);
    setPartOrder(s.partOrder);
    setGroupCount(s.groupCount);
  }, []);

  const undo = useCallback(() => {
    const previous = historyPast.current.pop();
    if (!previous || !historyPrev.current) return;
    historyFuture.current.push(historyPrev.current);
    historyRestoring.current = true;
    // A fresh edit after this must not coalesce with the step just undone.
    historyLastEditAt.current = 0;
    applyEditable(previous);
    setHistoryVersion((v) => v + 1);
  }, [applyEditable]);

  const redo = useCallback(() => {
    const next = historyFuture.current.pop();
    if (!next || !historyPrev.current) return;
    historyPast.current.push(historyPrev.current);
    historyRestoring.current = true;
    historyLastEditAt.current = 0;
    applyEditable(next);
    setHistoryVersion((v) => v + 1);
  }, [applyEditable]);

  const history = useMemo<BuilderHistory>(
    () => ({
      undo,
      redo,
      canUndo: historyPast.current.length > 0,
      canRedo: historyFuture.current.length > 0,
    }),
    /*
      The stacks live in refs, pushed by the effect AFTER the render that
      changed `editable` — so the memo keys on the version counter the effect
      bumps, never on `editable` itself, which would recompute one commit too
      early and read the stacks stale.
    */
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [undo, redo, historyVersion],
  );

  /*
    Retyping a question CLEARS its key.

    An answer key is a list of OPTION VALUES, and `retypeField` reseeds or
    strips options when a field's type changes. A key kept across that change
    names options the question no longer offers, which marks every candidate
    wrong on a question they answered correctly — and does it silently, because
    a stale key looks exactly like a current one.
  */
  const setFieldTypeAndClearKey = useCallback((fieldId: string, type: FormFieldType) => {
    setFields((fs) => fs.map((f) => (f.id !== fieldId || f.type === type ? f : retypeField(f, type))));
    setKeys((prev) => prev.filter((k) => k.fieldId !== fieldId));
  }, []);

  /*
    ONE ATOMIC APPLY, because a field id is referenced from four pieces of state.

    Each operation is computed once from the CURRENT values and then written to
    all four. Four independent functional updates would each see the others
    stale — and a delete that removed the field but not its answer key produces a
    manifest that fails at publish, naming a field the author can no longer see.
    `builder-fields.ts` makes the half-done version unexpressible; this keeps it
    that way through React state.

    ITS IDENTITY CHANGES WITH THE DRAFT, deliberately — it reads the slices
    from closure — so every memo that calls it MUST list it as a dependency.
    `structureOps.duplicate` shipped without that and ran against the draft as
    it stood at mount: the second duplicate minted the same added-N ids and
    section key as the first and silently reverted every edit in between.
  */
  const applyFieldEdit = useCallback(
    (edit: (state: {
      fields: FormField[];
      structure: BuilderStructure;
      keys: DraftAnswerKey[];
      excluded: Set<string>;
    }) => ReturnType<typeof deleteField>) => {
      const next = edit({ fields, structure, keys, excluded });
      setFields(next.fields);
      setStructure(next.structure);
      setKeys(next.keys);
      setExcluded(next.excluded);
    },
    [fields, structure, keys, excluded],
  );

  /*
    Every structure edit is a pure function applied to current state.

    Each operation returns the SAME array when it changes nothing, so a
    `dragOver` firing continuously over one row produces one re-render rather
    than dozens — the guard lives in the operation, not in a piece of state
    this component would have to keep in sync.
  */
  const structureOps = useMemo<StructureOps>(
    () => ({
      moveSection: (key, delta) => setStructure((s) => Structure.moveSection(s, key, delta)),
      renameSection: (key, label) => setStructure((s) => Structure.renameSection(s, key, label)),
      setColumns: (key, cols) => setStructure((s) => Structure.setSectionColumns(s, key, cols)),
      toggleOwnPage: (key) =>
        setStructure((s) => {
          const section = s.find((x) => x.key === key);
          return section ? Structure.setOwnPage(s, key, !section.ownPage) : s;
        }),
      dissolve: (key) => setStructure((s) => Structure.dissolveSection(s, key)),
      duplicate: (key) => applyFieldEdit((st) => duplicateSection(st, key)),
      moveField: (fieldId, toSectionKey, beforeFieldId, after) =>
        setStructure((s) => Structure.moveField(s, fieldId, toSectionKey, beforeFieldId, after)),
      cycleSpan: (sectionKey, fieldId) =>
        setStructure((s) => Structure.cycleFieldSpan(s, sectionKey, fieldId)),
      group: (fieldIds) =>
        setStructure((s) => {
          const n = groupCount;
          const next = Structure.groupIntoSection(s, fieldIds, `New section ${n}`, `secnew${n}`);
          if (next !== s) setGroupCount(n + 1);
          return next;
        }),
      /*
        Retyping goes through the SHARED reconciliation, not a local copy.

        `retypeField` seeds options for a type that answers from them and strips
        the payload only the old type could own. Doing it here by hand is how
        the import review screen once let a reviewer turn a Date into an
        optionless checkbox group that blocked every submit — the failure
        `typeOptionsFor`'s own comment records. A third editor with a third
        implementation would drift the same way.
      */
      setFieldType: setFieldTypeAndClearKey,
      reset: () => setStructure(extraction ? structureFromExtraction(extraction) : []),
    }),
    // applyFieldEdit is a real dependency: `duplicate` reads the whole draft
    // through it. Omitting it froze `duplicate` on the state at mount.
    [extraction, groupCount, setFieldTypeAndClearKey, applyFieldEdit],
  );

  const setAssessorVerdict = useCallback((fieldId: string, verdict: boolean) => {
    setFields((prev) =>
      prev.map((f) => {
        if (f.id !== fieldId) return f;
        if (!verdict) {
          const { assessorVerdict: _drop, ...rest } = f;
          return rest;
        }
        // The key goes with the flag. A verdict field that kept one would be
        // graded by `markTheory`, which reads the key and nothing else.
        const { answerKey: _key, ...rest } = f;
        return { ...rest, assessorVerdict: true };
      }),
    );
    if (verdict) setKeys((prev) => prev.filter((k) => k.fieldId !== fieldId));
  }, []);

  const keyOps = useMemo<KeyOps>(
    () => ({
      setAssessorVerdict,
      setKey: (fieldId, answerKey, source = 'manual') =>
        setKeys((prev) => {
          const rest = prev.filter((k) => k.fieldId !== fieldId);
          if (answerKey.length === 0) return rest;
          const existing = prev.find((k) => k.fieldId === fieldId);
          /*
            A CHANGED KEY LOSES ITS VERIFICATION.

            The attestation is "the training authority confirmed THESE answers";
            carrying it onto a different set would let a key nobody has checked
            report itself as verified on a safety-critical assessment.
          */
          const same =
            existing !== undefined &&
            existing.answerKey.length === answerKey.length &&
            existing.answerKey.every((o) => answerKey.includes(o));
          return [
            ...rest,
            {
              fieldId,
              answerKey,
              source,
              ...(same && existing.verifiedBy ? { verifiedBy: existing.verifiedBy } : {}),
              ...(same && existing.verifiedAt ? { verifiedAt: existing.verifiedAt } : {}),
            },
          ];
        }),

      toggleOption: (fieldId, option, multiple) =>
        setKeys((prev) => {
          const existing = prev.find((k) => k.fieldId === fieldId);
          const current = existing?.answerKey ?? [];
          // A single-answer question REPLACES; a set question accumulates.
          // Exact-set marking makes the difference decisive rather than
          // cosmetic: an extra option on a single-answer question fails
          // everyone who answers it correctly.
          const next = multiple
            ? current.includes(option)
              ? current.filter((o) => o !== option)
              : [...current, option]
            : current.length === 1 && current[0] === option
              ? []
              : [option];
          const rest = prev.filter((k) => k.fieldId !== fieldId);
          if (next.length === 0) return rest;
          return [...rest, { fieldId, answerKey: next, source: 'manual' as const }];
        }),

      setVerified: (fieldId, verified, actor) =>
        setKeys((prev) =>
          prev.map((k) =>
            k.fieldId !== fieldId
              ? k
              : verified
                ? { ...k, verifiedBy: actor, verifiedAt: new Date().toISOString() }
                : // Withdrawing drops both halves: a `verifiedAt` with nobody
                  // attached is a timestamp nobody stands behind.
                  { fieldId: k.fieldId, answerKey: k.answerKey, source: k.source },
          ),
        ),

      seedKeys: (seeded) =>
        setKeys((prev) => {
          const replacing = new Set(seeded.map((k) => k.fieldId));
          return [...prev.filter((k) => !replacing.has(k.fieldId)), ...seeded];
        }),

      saveMatching: (fieldId, built, presentation) => {
        /*
          The OPTIONS go on the field and the KEY goes in the draft.

          A matching question's options ARE its two sides, so they are part of
          the question rather than part of the marking — they have to reach the
          published field either way. The key travels with every other key so
          there is one place a reviewer looks to see what has been decided.
        */
        setFields((fs) =>
          fs.map((f) =>
            f.id !== fieldId
              ? f
              : {
                  ...f,
                  type: 'checkbox_group' as const,
                  selectionType: 'multiple' as const,
                  options: [...built.options],
                  matchPresentation: presentation,
                },
          ),
        );
        setKeys((prev) => [
          ...prev.filter((k) => k.fieldId !== fieldId),
          { fieldId, answerKey: [...built.answerKey], source: 'manual' as const },
        ]);
      },
    }),
    [setAssessorVerdict],
  );

  const fieldOps = useMemo<FieldOps>(
    () => ({
      add: (sectionKey, afterFieldId, type, label) =>
        applyFieldEdit((st) => addField(st, sectionKey, afterFieldId, type, label)),
      rename: (fieldId, label) => applyFieldEdit((st) => renameField(st, fieldId, label)),
      remove: (fieldId) => applyFieldEdit((st) => deleteField(st, fieldId)),
      foldInto: (fieldId, targetFieldId) =>
        applyFieldEdit((st) => mergeIntoDescription(st, fieldId, targetFieldId)),
      setOutcomeTarget: (questionId, outcomeFieldId) =>
        applyFieldEdit((st) => setOutcomeTarget(st, questionId, outcomeFieldId)),
      patch: (fieldId, patchValue) =>
        setFields((fs) => fs.map((f) => (f.id === fieldId ? { ...f, ...patchValue } : f))),
      mergeTable: (sourceId, targetId) =>
        applyFieldEdit((st) => mergeRepeatingTable(st, sourceId, targetId)),
    }),
    [applyFieldEdit],
  );

  const parts = useMemo(() => {
    const base = derivePartsFromStructure({ structure, fields, setup, keys, excluded });
    const withEdits = base.map((p) => ({ ...p, ...(partOverrides[p.key] ?? {}) }));
    if (partOrder.length === 0) return withEdits;
    /*
      The saved order is applied by KEY, and anything it does not name keeps its
      derived position at the end. A section added after the author reordered
      must still appear — dropping it would silently remove a part from the
      assessment.
    */
    const byKey = new Map(withEdits.map((p) => [p.key, p]));
    const ordered = partOrder.map((k) => byKey.get(k)).filter((p): p is DerivedPart => !!p);
    const seen = new Set(ordered.map((p) => p.key));
    return [...ordered, ...withEdits.filter((p) => !seen.has(p.key))];
  }, [structure, fields, setup, keys, excluded, partOverrides, partOrder]);

  const manifest = useMemo(
    () => buildManifest(parts, extraction?.fields ?? [], setup),
    [parts, extraction, setup],
  );

  /*
    The problems come from the SHARED validator, live — and they are computed
    against the PUBLISH-TIME fields, not the raw draft list.

    `validateManifest` owns every rule and its messages are written for a
    person. Re-implementing any of them here would give the builder a second
    rule set that agrees with publish right up until it matters.

    The keys live BESIDE the fields until `resolvePublishFields` merges them
    on at publish. Validating the bare list reported every keyed mandatory
    question as unkeyed — thirty-one problems that appeared BECAUSE the author
    keyed the paper: keying is what proposes a question as mandatory, and the
    validator could not see the very keys that did it.
  */
  const manifestProblems = useMemo(
    () =>
      parts.length > 0
        ? validateManifest(manifest, resolvePublishFields(fields, keys).fields)
        : [],
    [manifest, fields, keys, parts.length],
  );

  const partOps = useMemo<PartOps>(
    () => ({
      move: (key, delta) =>
        setPartOrder((prev) => {
          const current = prev.length > 0 ? prev : parts.map((p) => p.key);
          const asParts = current
            .map((k) => parts.find((p) => p.key === k))
            .filter((p): p is DerivedPart => !!p);
          const moved = movePart(asParts, key, delta);
          return moved === asParts ? prev : moved.map((p) => p.key);
        }),
      setPathways: (key, pathways) =>
        setPartOverrides((prev) => {
          const next = setPartPathways(parts, key, pathways).find((p) => p.key === key);
          return next ? { ...prev, [key]: { ...prev[key], pathways: next.pathways } } : prev;
        }),
      update: (key, patch) =>
        setPartOverrides((prev) => {
          // Routed through the same pure operation the tests cover, so the hook
          // cannot drift from it.
          const next = updatePart(parts, key, patch).find((p) => p.key === key);
          return next ? { ...prev, [key]: { ...prev[key], ...patch } } : prev;
        }),
      reset: () => {
        setPartOverrides({});
        setPartOrder([]);
      },
    }),
    [parts],
  );

  /**
   * Record the draft version this builder places against.
   *
   * The CREATION lives in the step that needs it, not here. This hook is
   * state and pure reducers — pulling a react-query mutation into it would
   * make every consumer need a QueryClientProvider to hold a field list, and
   * a network call in a state hook is a network call every test has to mock.
   */
  const setVersionIds = useCallback((nextFormId: string, nextVersionId: string) => {
    setFormId(nextFormId);
    setVersionId(nextVersionId);
  }, []);

  const clearVersionIds = useCallback(() => {
    setFormId(undefined);
    setVersionId(undefined);
  }, []);

  /*
    Geometry comes back from the placement step by ID, not by replacing the
    list. The editor is handed the fields minus the excluded ones, so what it
    returns is a SUBSET — assigning it wholesale would delete every question the
    author turned off, and the manifest still references those ids.
  */
  const setPlacedFields = useCallback((placed: FormField[]) => {
    const byId = new Map(placed.map((f) => [f.id, f]));
    setFields((prev) => prev.map((f) => byId.get(f.id) ?? f));
  }, []);

  /*
    ── Revision PDF swap (KTD2) ────────────────────────────────────────────

    Replacing the document moves every field's geometry into the carried
    stash and strips it from the fields: stored geometry means CONFIRMED, and
    a box confirmed against the old layout was not confirmed against the new
    one. The draft's NAME is deliberately untouched — it is the autosave
    upsert key, and renaming mid-session would strand the revision row.
  */
  const replacePdf = useCallback(
    (nextAssetId: string, _nextFileName: string) => {
      setCarriedGeometry((prev) => {
        // On a double swap the ORIGINAL carried set wins — the fields are
        // already bare, and re-stashing from them would lose every box.
        const next = { ...prev };
        for (const f of fields) {
          if (next[f.id]) continue;
          if (f.geometry) next[f.id] = f.geometry;
          else if (f.sourcePosition) next[f.id] = { segments: [{ ...f.sourcePosition }] };
        }
        return next;
      });
      setFields((prev) =>
        prev.map((f) => {
          if (!f.geometry && !f.sourcePosition) return f;
          const { geometry: _g, sourcePosition: _s, ...rest } = f;
          return rest;
        }),
      );
      setAssetId(nextAssetId);
    },
    [fields],
  );

  /** A mis-upload never costs re-confirmation: original PDF and geometry back. */
  const revertPdf = useCallback(() => {
    if (!seedAssetId) return;
    setFields((prev) =>
      prev.map((f) => {
        const carried = carriedGeometry[f.id];
        return carried ? { ...f, geometry: carried } : f;
      }),
    );
    setCarriedGeometry({});
    setAssetId(seedAssetId);
  }, [seedAssetId, carriedGeometry]);

  /** Confirm carried boxes back onto the fields — placement's apply path. */
  const confirmCarried = useCallback(
    (fieldIds: readonly string[]) => {
      const confirmable = fieldIds.filter((id) => carriedGeometry[id]);
      if (confirmable.length === 0) return;
      setFields((prev) =>
        prev.map((f) => (confirmable.includes(f.id) ? { ...f, geometry: carriedGeometry[f.id]! } : f)),
      );
      setCarriedGeometry((prev) => {
        const next = { ...prev };
        for (const id of confirmable) delete next[id];
        return next;
      });
    },
    [carriedGeometry],
  );

  const setRevisionIdentity = useCallback((patch: Partial<RevisionIdentity>) => {
    setRevisionIdentityState((prev) => ({ ...prev, ...patch }));
  }, []);

  const stats = useMemo(() => (extraction ? statsFor(extraction) : null), [extraction]);

  return {
    phase,
    error,
    fileName,
    extraction,
    fields,
    stats,
    setup,
    excluded,
    structure,
    // A revision draft has no extraction — its seeded fields ARE the document
    // (KTD7), so the stepper opens on their strength alone.
    hasDocument:
      phase === 'ready' &&
      (extraction !== null || (revisionOfToolId !== undefined && fields.length > 0)),
    title: extraction
      ? extraction.fileName.replace(/\.pdf$/i, '')
      : revisionOfToolId
        ? fileName
        : null,
    pageCount: extraction?.pageCount ?? 0,
    ingest,
    setSetup,
    keys,
    ...(formId ? { formId } : {}),
    ...(versionId ? { versionId } : {}),
    ...(assetId ? { assetId } : {}),
    ...(revisionOfToolId ? { revisionOfToolId } : {}),
    ...(seededFromVersionId ? { seededFromVersionId } : {}),
    ...(revisionToolManifest ? { revisionToolManifest } : {}),
    ...(revisionIdentity ? { revisionIdentity } : {}),
    carriedGeometry,
    pdfReplaced: Boolean(revisionOfToolId && seedAssetId && assetId !== seedAssetId),
    replacePdf,
    revertPdf,
    setRevisionIdentity,
    confirmCarried,
    setVersionIds,
    clearVersionIds,
    setPlacedFields,
    parts,
    manifest,
    manifestProblems,
    toggleExcluded,
    reset,
    structureOps,
    keyOps,
    fieldOps,
    partOps,
    history,
    snapshot,
  };
}
