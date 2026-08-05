import { useCallback, useMemo, useState } from 'react';
import {
  DEFAULT_SETUP_ANSWERS,
  hasAnyMatchSide,
  hasBothMatchSides,
  isChoiceField,
  validateManifest,
  type AssessmentPathway,
  type AssessmentToolManifest,
  type BuiltMatchingQuestion,
  type BuilderStructure,
  type DraftAnswerKey,
  type ExtractionResult,
  type FormField,
  type FormFieldType,
  type KeySource,
  type MatchPresentation,
  type SectionColumns,
  type SetupAnswers,
} from '@formai/shared';
import { apiClient, ApiError } from '../../../lib/data/api-client.js';
import { fileToBase64, IMPORT_REQUEST_TIMEOUT_MS } from '../../../lib/data/import-session.js';
import { retypeField } from '../../../lib/field-editor/reducer.js';
import * as Structure from './builder-structure.js';
import { addField, deleteField, mergeIntoDescription } from './builder-fields.js';
import {
  buildManifest,
  derivePartsFromStructure,
  movePart,
  setPathways as setPartPathways,
  updatePart,
  type DerivedPart,
} from './builder-manifest.js';
import { structureFromExtraction } from './builder-structure.js';

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
  /** Record the draft version the placement step created. */
  setVersionIds: (formId: string, versionId: string) => void;
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
}

export interface FieldOps {
  /** Add a field the extraction missed, after `afterFieldId` (null = first). */
  add: (sectionKey: string, afterFieldId: string | null, type: FormFieldType, label: string) => void;
  /** Delete a field the extraction invented, and every reference to it. */
  remove: (fieldId: string) => void;
  /** Fold a field into another's description — a printed instruction, not a box. */
  foldInto: (fieldId: string, targetFieldId: string) => void;
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

export function useBuilderDraftState(_draftId?: string): BuilderDraftState {
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

    From the moment it exists THE VERSION OWNS THE FIELDS. The builder draft owns
    what sits on top of them — the structure arrangement, the answer keys, the
    part manifest — all of which reference field IDS, and ids are preserved
    across every version write. One copy of the field list, and it is the copy
    the exporter reads: two that can disagree is the failure refused everywhere
    else in this work.
  */
  const [formId, setFormId] = useState<string | undefined>(undefined);
  const [versionId, setVersionId] = useState<string | undefined>(undefined);
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
    [extraction, groupCount, setFieldTypeAndClearKey],
  );

  const keyOps = useMemo<KeyOps>(
    () => ({
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
    [],
  );

  /*
    ONE ATOMIC APPLY, because a field id is referenced from four pieces of state.

    Each operation is computed once from the CURRENT values and then written to
    all four. Four independent functional updates would each see the others
    stale — and a delete that removed the field but not its answer key produces a
    manifest that fails at publish, naming a field the author can no longer see.
    `builder-fields.ts` makes the half-done version unexpressible; this keeps it
    that way through React state.
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

  const fieldOps = useMemo<FieldOps>(
    () => ({
      add: (sectionKey, afterFieldId, type, label) =>
        applyFieldEdit((st) => addField(st, sectionKey, afterFieldId, type, label)),
      remove: (fieldId) => applyFieldEdit((st) => deleteField(st, fieldId)),
      foldInto: (fieldId, targetFieldId) =>
        applyFieldEdit((st) => mergeIntoDescription(st, fieldId, targetFieldId)),
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
    The problems come from the SHARED validator, live.

    `validateManifest` owns every rule and its messages are written for a
    person. Re-implementing any of them here would give the builder a second
    rule set that agrees with publish right up until it matters.
  */
  const manifestProblems = useMemo(
    () => (parts.length > 0 ? validateManifest(manifest, fields) : []),
    [manifest, fields, parts.length],
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
    hasDocument: phase === 'ready' && extraction !== null,
    title: extraction ? extraction.fileName.replace(/\.pdf$/i, '') : null,
    pageCount: extraction?.pageCount ?? 0,
    ingest,
    setSetup,
    keys,
    ...(formId ? { formId } : {}),
    ...(versionId ? { versionId } : {}),
    ...(assetId ? { assetId } : {}),
    setVersionIds,
    parts,
    manifest,
    manifestProblems,
    toggleExcluded,
    reset,
    structureOps,
    keyOps,
    fieldOps,
    partOps,
  };
}
