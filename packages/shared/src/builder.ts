/**
 * The assessment builder's authoring vocabulary — the shapes that exist while a
 * tool is being BUILT, before anything is published.
 *
 * Three ideas carry this module.
 *
 * 1. NOTHING HERE IS PUBLISHED. A builder draft is working state: a structure
 *    an author is still rearranging, keys they are still deciding, boxes they
 *    have placed but not confirmed. At publish it RESOLVES into the shapes the
 *    rest of the product already understands — `FormField` order and `colSpan`,
 *    `FieldGeometry`, `answerKey` + `outcomeTarget`, `AssessmentToolManifest`,
 *    `AssessmentWorkflow`. Nothing new reaches a published version, and nothing
 *    downstream has to learn a second model.
 *
 * 2. THE DRAFT LIVES ON THE SERVER. An assessment tool is authored over days by
 *    somebody who may change machines, and its answer key is the complete key
 *    to a safety-critical assessment. Browser storage answers neither: it
 *    cannot be shared with a colleague, it does not survive a reinstall, and a
 *    key in `localStorage` is a key on a laptop. The draft is a row.
 *
 * 3. EVERY ADDITION IS OPTIONAL, AND ABSENT MEANS TODAY'S BEHAVIOUR. `markStyle`
 *    and `matchPresentation` hang off shapes that are already stored in
 *    thousands of rows. An absent one resolves to exactly what the code does
 *    now, so no existing record changes meaning and no migration writes a guess
 *    into anybody's data.
 */

import type {
  AssessmentPathway,
  AssessmentToolManifest,
  TheoryRendering,
  TheoryRetryMode,
} from './assessment.js';
import type { ExtractionResult } from './extraction.js';
import { GLYPH_KINDS, type FieldGeometry, type FormField, type GlyphKind } from './form-field.js';
import type { AssessmentWorkflow } from './workflow.js';

/* ------------------------------------------------------------------ *
 * Steps
 * ------------------------------------------------------------------ */

/**
 * The builder's seven steps, in order.
 *
 * Declared as data rather than as numbers scattered through the UI, because the
 * stepper, the mini-step rail, the draft's resume point and the Next button's
 * label all have to agree on what step 4 is.
 */
export const BUILDER_STEPS = [
  'upload',
  'generate',
  'units',
  'answer_key',
  'placement',
  'workflow',
] as const;
export type BuilderStep = (typeof BUILDER_STEPS)[number];

export const BUILDER_STEP_LABELS: Record<BuilderStep, string> = {
  upload: 'Upload',
  generate: 'Generate',
  units: 'Units & gating',
  answer_key: 'Answer key',
  placement: 'PDF mapping',
  workflow: 'Workflow',
};

/** What the primary action says on each step. */
export const BUILDER_NEXT_LABELS: Record<BuilderStep, string> = {
  upload: 'Generate form artifact',
  generate: 'Wrap into units',
  units: 'Set the answer key',
  answer_key: 'Map to the PDF',
  placement: 'Configure workflow',
  workflow: 'Publish assessment tool',
};

export function stepIndex(step: BuilderStep): number {
  return BUILDER_STEPS.indexOf(step);
}

/**
 * Steps that once existed and no longer do, and where a draft parked on one
 * should resume.
 *
 * `design` was a conversational pass over the generated artifact. Its two jobs
 * both landed elsewhere and it never had a screen: correcting what extraction
 * got wrong — adding a field, deleting one, folding an instruction into a
 * description — is GENERATE's work now, and colours, styles and the logo are
 * authored per client brand in settings, where they are shared by every form
 * that client owns rather than re-chosen per document.
 *
 * KEPT AS A MAPPING RATHER THAN DELETED. `step` is validated against
 * `BUILDER_STEPS` on the way into the database, so a saved draft sitting on a
 * retired step would fail that enum and take its whole save with it — the
 * author's afternoon of work rejected at the boundary because a step was
 * renamed. This resolves it to the step that absorbed it instead.
 */
export const RETIRED_BUILDER_STEPS: Record<string, BuilderStep> = {
  design: 'generate',
};

/** The step a stored value should open, or `upload` when it names nothing. */
export function resolveBuilderStep(step: string | null | undefined): BuilderStep {
  if (!step) return 'upload';
  if ((BUILDER_STEPS as readonly string[]).includes(step)) return step as BuilderStep;
  return RETIRED_BUILDER_STEPS[step] ?? 'upload';
}

/* ------------------------------------------------------------------ *
 * Setup answers
 * ------------------------------------------------------------------ */

/**
 * How the theory part decides a satisfactory outcome.
 *
 * `mandatory_all_correct` is the rule `markTheory` already applies: the
 * must-pass section must be entirely correct and the rest is evidence.
 * `overall_percentage` is offered because some tools mark that way — but it is
 * NOT implemented by marking yet, so choosing it records an intent the author
 * can see rather than silently behaving like the other one.
 */
export const PASS_RULES = ['mandatory_all_correct', 'overall_percentage'] as const;
export type PassRule = (typeof PASS_RULES)[number];

/*
  THEORY_RENDERINGS lives in `assessment.ts`, with the tool it ends up on.

  It was declared here first, which meant the builder could ask the question and
  had nowhere to put the answer: `SetupAnswers` is draft state, and a draft is
  gone by the time a candidate opens the assessment. Re-exported so nothing that
  imported it from here breaks.
*/
export { THEORY_RENDERINGS, type TheoryRendering } from './assessment.js';

/**
 * What a logbook's minimum hours DO when they are reached.
 *
 * `notify` is the shipped behaviour and the right default: the threshold tells
 * an assessor a demonstration can be booked, it does not stop work. `block`
 * exists because some authorities require it, and it is recorded here rather
 * than assumed either way.
 */
export const THRESHOLD_BEHAVIOURS = ['notify', 'block'] as const;
export type ThresholdBehaviour = (typeof THRESHOLD_BEHAVIOURS)[number];

/**
 * The answers to the setup questions asked after extraction.
 *
 * These are not preferences — each one seeds a decision a later step has to
 * make anyway: which pathways the manifest declares, which question sets are
 * stream-specific, what gates the theory outcome, how the fill surface renders,
 * and what a logbook threshold does. Asking at the point the document has just
 * been read is what makes steps 4 and 7 mostly confirmation.
 *
 * Stored on the draft AND carried onto the published tool, so re-opening a tool
 * months later explains why it is shaped the way it is.
 */
export interface SetupAnswers {
  /** Pathways this tool offers. Never empty — a tool nobody can take is not one. */
  pathways: AssessmentPathway[];
  /**
   * Question-set headings that are candidate-specific streams rather than
   * sections everybody answers, by their `section_header` field id.
   */
  streamSectionIds: string[];
  passRule: PassRule;
  /** Only meaningful when `passRule` is `overall_percentage`. */
  passPercentage?: number;
  theoryRendering: TheoryRendering;
  thresholdBehaviour: ThresholdBehaviour;
  /**
   * @deprecated Superseded by `theoryRetry`; kept so a draft saved before the
   * mode existed still loads. The UI migrates it to `theoryRetry` on edit.
   */
  theoryAllowRetry?: boolean;
  /**
   * When a candidate may retry a theory part they got wrong: `off`, on the spot
   * (`immediate`, one-per-screen only), or a whole-quiz re-attempt at the end
   * (`end`). Defaults to `end`, which is what a tool did before this existed.
   */
  theoryRetry?: TheoryRetryMode;
}

export const DEFAULT_SETUP_ANSWERS: SetupAnswers = {
  pathways: ['new', 'experienced', 'rpl'],
  streamSectionIds: [],
  passRule: 'mandatory_all_correct',
  theoryRendering: 'one_per_screen',
  thresholdBehaviour: 'notify',
  theoryRetry: 'end',
};

/* ------------------------------------------------------------------ *
 * Structure
 * ------------------------------------------------------------------ */

/** Columns a section may lay its fields out over. Three is the printed maximum. */
export const SECTION_COLUMN_COUNTS = [1, 2, 3] as const;
export type SectionColumns = (typeof SECTION_COLUMN_COUNTS)[number];

/** One field's placement within its section's grid. */
export interface StructureField {
  /** The extracted field's id. Never rewritten — ids are what everything keys on. */
  id: string;
  /**
   * How many of the section's columns this field spans, 1..cols.
   *
   * Clamped on read rather than on write (`resolveSpan`): a section dropped
   * from three columns to two must not silently truncate the spans an author
   * set, because they are restored intact when the section goes back to three.
   */
  span?: SectionColumns;
}

/**
 * One section of the form being built.
 *
 * A section is an AUTHORING grouping, not a printed one. It becomes field
 * order, a `section_header`, and `colSpan` on its fields — see
 * `resolveStructure` in the web app. The document's own printed order never
 * moves; this decides what the digital form looks like.
 */
export interface StructureSection {
  /** Stable within the draft. Survives renaming and reordering. */
  key: string;
  label: string;
  cols: SectionColumns;
  /**
   * The extracted `section_header` field this section came from, where it came
   * from one.
   *
   * Kept so publishing REUSES that field rather than minting a replacement:
   * a header is a real field with a real id, and `AssessmentPart.startFieldId`
   * may already anchor to it. A section an author created by grouping has none,
   * and gets a synthesised header at publish.
   */
  headerFieldId?: string;
  /**
   * Render this section as a page of its own in the preview and the fill
   * surface, rather than continuing the one before it.
   */
  ownPage?: boolean;
  /**
   * This section is part of the COVER page.
   *
   * Consecutive cover sections that are not flagged `ownPage` share one page,
   * which is how the paper prints them. Derived from the extraction's
   * `coverSection` and then owned by the author.
   */
  cover?: boolean;
  fields: StructureField[];
}

export type BuilderStructure = StructureSection[];

/** A field's span, clamped to what its section can actually offer. */
export function resolveSpan(field: StructureField, cols: SectionColumns): SectionColumns {
  const span = field.span ?? 1;
  return (span > cols ? cols : span) as SectionColumns;
}

/* ------------------------------------------------------------------ *
 * Answer keys
 * ------------------------------------------------------------------ */

/**
 * Where a keyed answer came from, which is not the same question as whether it
 * is right.
 *
 * An answer read out of an uploaded guide is a proposal a machine made; one an
 * author typed is a decision a person made. Both still need `verifiedAt` before
 * anybody relies on them, and keeping the provenance is what lets a reviewer
 * see which ones deserve a closer look.
 */
export const KEY_SOURCES = ['manual', 'guide_json', 'guide_document'] as const;
export type KeySource = (typeof KEY_SOURCES)[number];

/** One question's key, as the builder holds it before publish. */
export interface DraftAnswerKey {
  /** The question field's id. */
  fieldId: string;
  /** Option values that TOGETHER make a correct answer — exact-set, as marking. */
  answerKey: string[];
  source: KeySource;
  /**
   * Who attested to this answer, and when.
   *
   * A key nobody has verified still marks — refusing to mark would leave the
   * assessment unusable — but the distinction is recorded, because on a
   * safety-critical assessment "an AI read it off a guide" and "the training
   * authority confirmed it against the source manuals" are different claims.
   */
  verifiedBy?: string;
  verifiedAt?: string;
}

/* ------------------------------------------------------------------ *
 * Mark styles
 *
 * The vocabulary itself (`GlyphKind`, `MarkInk`, `MarkSize`, `MarkStyle`) lives
 * in `form-field.ts` beside the geometry it hangs off. What lives here is the
 * authoring layer over it: what each glyph is called, and which of them the
 * exporter actually draws today.
 * ------------------------------------------------------------------ */

export const GLYPH_LABELS: Record<GlyphKind, string> = {
  tick_hand: 'Hand ✓',
  tick_block: 'Block ✓',
  cross_hand: 'Hand ✗',
  ring: 'Ring',
  typed: 'Typed',
  signature: 'Signature',
  stamp_pass: 'PASS',
  stamp_na: 'N/A',
  stamp_date: 'Date',
  initials: 'Initials',
  highlight: 'Highlight',
  match_line: 'Match line',
};

/**
 * The styles the exporter actually draws today — now ALL of them.
 *
 * Everything here maps onto a mark `round-trip.ts` produces: vector ticks and
 * crosses, the verdict ring, scalar text, an embedded signature image, the
 * fixed-word stamps, initials reduced from the recorded value, a translucent
 * highlight and a drawn connector. There is no longer an
 * authorable-but-ignored tier — a style the exporter silently dropped was a
 * mark an author believed was on a competency record and was not.
 *
 * KEPT AS A LIST RATHER THAN DELETED now that it equals `GLYPH_KINDS`. It is
 * what the picker reads and what the round-trip test walks, so a glyph added
 * without a renderer lands here as a failing test rather than as a silent
 * omission — which is the state this list was written to catch.
 */
export const MARK_STYLES_DRAWN: readonly GlyphKind[] = [...GLYPH_KINDS];

export function isGlyphDrawn(glyph: GlyphKind): boolean {
  return MARK_STYLES_DRAWN.includes(glyph);
}

/* ------------------------------------------------------------------ *
 * The draft
 * ------------------------------------------------------------------ */

/**
 * A theory question's two printed locations.
 *
 * The paper gives a marked question two places: where the candidate's ANSWER
 * appears (the option they ringed, or the letter they wrote) and where the
 * VERDICT appears (the tick or cross in the margin). Both are geometry — the
 * response on the question field, the outcome on the field its `outcomeTarget`
 * names — but they are one unit of authoring work, and a builder that showed
 * them as two unrelated rows in a list of three hundred is how one of them ends
 * up unplaced.
 *
 * Derived, never stored: it is a view over the fields and their outcome
 * targets, so it cannot disagree with them.
 */
export interface QuestionPlacementPair {
  questionFieldId: string;
  /** The `check_cross` field the question's `outcomeTarget` names, if resolved. */
  outcomeFieldId: string | null;
  /** The printed reference, where extraction captured one. */
  questionRef?: string;
  responsePlaced: boolean;
  outcomePlaced: boolean;
}

/**
 * The paper document's own revision identity, recorded on the version that
 * digitised it — "Rev 3, reviewed 08/2026 — annual review". All three fields
 * are the document's words, not the system's: the internal version label
 * (v1, v2) stays the system identity, this is what auditors recognise.
 *
 * Written onto a form template version only by the assessment-tool republish
 * path; plain forms never carry one.
 */
export interface RevisionIdentity {
  /** The revision code as printed on the document — "Rev 3", "v6.1". */
  code?: string;
  /** When the document was reviewed, verbatim ("08/2026") — free text, not a date. */
  reviewedOn?: string;
  /** What changed and why — the human severity signal assessors read. */
  note?: string;
}

/**
 * Field length ceilings for a `RevisionIdentity`, enforced at the API boundary.
 * The note prints on evidence exports; an unbounded one would bloat every
 * version row and overflow the identity line into mapped boxes.
 */
export const REVISION_IDENTITY_LIMITS = { code: 64, reviewedOn: 32, note: 2000 } as const;

/**
 * Everything an in-progress assessment tool consists of.
 *
 * One row, one shape — deliberately mirroring `import_drafts` rather than
 * inventing a session concept, so listing, resuming and discarding a builder
 * draft behave exactly as an import draft already does.
 */
export interface BuilderDraft {
  id: string;
  /** What to call it before the document has told us its real title. */
  name: string;
  /** The uploaded PDF in storage. The document is the one thing never re-derived. */
  assetId: string;
  fileName: string;
  /** Where the author left off. */
  step: BuilderStep;
  /** The extraction, as returned. Kept whole so a later step can re-read it. */
  extraction: ExtractionResult | null;
  /**
   * The fields as edited — types corrected, labels tidied, matching sides
   * authored. Seeded from the extraction and then owned here.
   */
  fields: FormField[];
  setup: SetupAnswers;
  structure: BuilderStructure;
  /** Questions the author excluded from the digital form, by field id. */
  excludedFieldIds: string[];
  keys: DraftAnswerKey[];
  /** Part structure as authored so far. Validated by `validateManifest` at publish. */
  manifest: AssessmentToolManifest | null;
  workflow: AssessmentWorkflow | null;
  /** The form this draft publishes into, once one exists. */
  formId?: string;
  versionId?: string;
  /*
    THE UNITS STEP'S EDITS, which nothing else here can reconstruct.

    Parts are derived from structure on every render and these hold only what
    the author changed on top — a renamed part, a reordered one, a hand-picked
    mandatory set. Saving the derived parts instead would freeze the manifest;
    saving neither, which is what happened before, loses every unit edit while
    the structure they sit on comes back intact, so a resumed draft looks
    complete and quietly is not.

    Optional because drafts written before this existed have neither, and a
    missing override is exactly "the author changed nothing".
  */
  partOverrides?: Record<string, unknown>;
  partOrder?: string[];
  /**
   * The counter behind grouped section keys.
   *
   * Monotonic so a grouped section's key cannot collide with an earlier one.
   * Restoring it matters: resuming at 1 lets the next group reuse a key the
   * structure is already using, and two sections with one key is a structure
   * whose fields belong to whichever the map read last.
   */
  groupCount?: number;
  /**
   * Set when this draft REVISES a published tool rather than building a new
   * one. The seed copies the published version's fields verbatim — field ids
   * are the spine the manifest, keys and outcome targets hang off — and the
   * publish step calls republish on this tool instead of creating one.
   */
  revisionOfToolId?: string;
  /**
   * The version the revision was seeded from. Republish compares it to the
   * template's current version and refuses `stale_revision` when somebody
   * else published in between — a revision of v1 must not silently discard v2.
   */
  seededFromVersionId?: string;
  /** The paper revision identity captured for the version this draft publishes. */
  revisionIdentity?: RevisionIdentity;
  /**
   * The tool's manifest as it stood at seed time. Republish starts from this
   * and overlays what the builder derives, so workflow-editor extras the
   * builder does not model survive a revision untouched.
   */
  revisionToolManifest?: AssessmentToolManifest;
  /** The seeded source PDF's handle, so "revert to original" can restore it. */
  seedAssetId?: string;
  /**
   * Geometry carried from the seeded version after the PDF was REPLACED,
   * keyed by field id. These are pre-placed PROPOSALS, never confirmed
   * geometry: a box confirmed against the old document's layout was not
   * confirmed against the new one, and `FormField.geometry` means confirmed
   * everywhere it is read. The placement step seeds these as needs-review
   * proposals; confirming writes them onto the version's fields. Empty when
   * the PDF was kept — geometry then stays on the fields, still confirmed.
   */
  carriedGeometry?: Record<string, FieldGeometry>;
  createdAt: string;
  updatedAt: string;
}

/** A brand-new draft, before a document has been read. */
export function emptyDraftState(): Pick<
  BuilderDraft,
  'step' | 'extraction' | 'fields' | 'setup' | 'structure' | 'excludedFieldIds' | 'keys' | 'manifest' | 'workflow'
> {
  return {
    step: 'upload',
    extraction: null,
    fields: [],
    setup: { ...DEFAULT_SETUP_ANSWERS, pathways: [...DEFAULT_SETUP_ANSWERS.pathways] },
    structure: [],
    excludedFieldIds: [],
    keys: [],
    manifest: null,
    workflow: null,
  };
}
