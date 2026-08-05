import { useCallback, useMemo, useState } from 'react';
import {
  DEFAULT_SETUP_ANSWERS,
  hasAnyMatchSide,
  hasBothMatchSides,
  isChoiceField,
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
  ingest: (file: File) => Promise<void>;
  setSetup: (patch: Partial<SetupAnswers>) => void;
  toggleExcluded: (fieldId: string) => void;
  reset: () => void;
  /** Structure edits. Each delegates to a pure operation in builder-structure.ts. */
  structureOps: StructureOps;
  /** Answer-key edits. */
  keyOps: KeyOps;
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

  const ingest = useCallback(async (file: File) => {
    setError(null);
    setFileName(file.name);
    setPhase('uploading');
    try {
      const base64 = await fileToBase64(file);
      const { assetId } = await apiClient.post<{ assetId: string }>(
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
        { assetId, fileName: file.name, documentType: 'assessment' },
        { timeoutMs: IMPORT_REQUEST_TIMEOUT_MS },
      );

      setPhase('building');
      const usable = result.fields.filter((f) => f.type !== 'section_header');
      if (usable.length === 0) throw new Error('empty_extraction');

      setExtraction(result);
      setFields(seedFields(result));
      setStructure(structureFromExtraction(result));
      setExcluded(new Set());
      setKeys([]);
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
    toggleExcluded,
    reset,
    structureOps,
    keyOps,
  };
}
