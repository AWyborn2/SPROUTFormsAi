/**
 * Import wizard session — shared, mutable state across the three import routes
 * (upload → review → publish), which are sibling routes rather than a nested
 * tree. A tiny external store (useSyncExternalStore) holds the extraction being
 * reviewed and the reviewer's corrections; step 1 resets it.
 *
 * `startExtraction(file)` drives the real API pipeline:
 * `POST /pdf/upload` (base64 bytes → assetId) then `POST /pdf/extract`
 * (assetId → ExtractionResult), with status transitions
 * idle → uploading → extracting → ready | error.
 */
import { useSyncExternalStore } from 'react';
import type {
  AnswerSet,
  ExtractedField,
  ExtractionResult,
  ExtractionStatus,
  FieldGeometry,
  FormField,
  FormFieldType,
  PageBox,
  RepeatingColumn,
  VisibilityCondition,
} from '@formai/shared';
import { resolveGeometry, statusForConfidence } from '@formai/shared';
import type { BuilderAction, BuilderState } from '../field-editor/reducer.js';
import { builderReducer, initialBuilderState } from '../field-editor/reducer.js';
import { ApiError, apiClient } from './api-client.js';

/**
 * An extracted field plus the reviewer's resolution state. Backed by the shared
 * field editor: everything except `note` and `resolved` is a real `FormField`
 * property, so a review row is the field that will publish plus the metadata of
 * the extraction run that produced it.
 */
export interface ReviewField extends ExtractedField {
  /** Set once the reviewer has explicitly confirmed/corrected this field. */
  resolved?: boolean;
  /** Editor-side properties that publish but have no extraction equivalent. */
  visibleWhen?: VisibilityCondition;
}

export type ImportSessionStatus = 'idle' | 'uploading' | 'extracting' | 'ready' | 'error';

interface ImportSession {
  status: ImportSessionStatus;
  fileName: string;
  pageCount: number;
  designNotes: string[];
  fields: ReviewField[];
  /** Storage handle from `POST /pdf/upload` — reused for the round-trip export. */
  assetId: string | null;
  /** The untouched extraction as returned by the API (fields above are the working copy). */
  extraction: ExtractionResult | null;
  /** User-facing failure message when status is 'error'. */
  error: string | null;
  /**
   * Re-extract mode: the EXISTING form this wizard run updates (a new version
   * of it), instead of creating a new form. Null = normal import. Cleared on
   * reset, so entering the wizard fresh from "Import PDF" never silently
   * retargets an old re-extract.
   */
  targetFormId: string | null;
}

const EMPTY_SESSION: Omit<ImportSession, 'designNotes' | 'fields'> = {
  status: 'idle',
  fileName: '',
  pageCount: 0,
  assetId: null,
  extraction: null,
  error: null,
  targetFormId: null,
};

function emptySession(): ImportSession {
  return { ...EMPTY_SESSION, designNotes: [], fields: [] };
}

let session: ImportSession = emptySession();
/** Base64 of the last file handed to startExtraction — kept so retry works. */
let heldBase64: string | null = null;
/** Monotonic run token — a reset/new start invalidates in-flight async work. */
let runId = 0;

/**
 * The field list under edit, in the SAME reducer the builder uses. Review and
 * the builder therefore share one set of edit operations (rename, retype,
 * reorder, delete, undo) instead of two implementations that drift.
 *
 * `FormField` carries everything `ExtractedField` does except `note`, so the
 * editor holds publishable fields directly and the extraction-only metadata
 * rides alongside in `reviewMeta`. Keeping confidence and notes out of the
 * editor matters because they are properties of the extraction run, not of the
 * published field — `reviewedToFields` already drops them at publish.
 */
let editor: BuilderState | null = null;
/** Extraction metadata by field id — the part of a ReviewField that isn't a FormField. */
const reviewMeta = new Map<string, { note?: string; resolved?: boolean; columnGroups?: number }>();

/** Editor fields + their extraction metadata, as the review UI consumes them. */
function derivedReviewFields(): ReviewField[] {
  if (!editor) return [];
  return editor.fields.map((f) => {
    const meta = reviewMeta.get(f.id);
    return {
      ...f,
      confidence: f.confidence ?? 1,
      ...(meta?.note !== undefined ? { note: meta.note } : {}),
      ...(meta?.resolved !== undefined ? { resolved: meta.resolved } : {}),
      ...(meta?.columnGroups !== undefined ? { columnGroups: meta.columnGroups } : {}),
    } as ReviewField;
  });
}

/** Seed the editor from a fresh extraction. */
function seedEditor(fields: ExtractedField[]): ReviewField[] {
  reviewMeta.clear();
  // Proposals from THIS run start unaccepted (R6) — never inherit approvals.
  acceptedAnswerSets.clear();
  // Same rule for geometry (R8): a re-extraction against a revised PDF must
  // not inherit a confirmation given to the previous document's layout.
  geometryProposals.clear();
  confirmedGeometry.clear();
  const formFields: FormField[] = fields.map((f) => {
    // Extraction-only metadata that must not publish but the review UI needs:
    // the `note`, and the side-by-side `columnGroups` hint the split control
    // pre-fills (U1). Both live here, keyed by id, exactly like `resolved`.
    const meta: { note?: string; columnGroups?: number } = {};
    if (f.note !== undefined) meta.note = f.note;
    if (f.columnGroups !== undefined) meta.columnGroups = f.columnGroups;
    if (Object.keys(meta).length > 0) reviewMeta.set(f.id, meta);
    return {
      id: f.id,
      type: f.type,
      label: f.label,
      // Resolve the checklist default once, here, rather than leaving it to
      // publish — the reviewer sees and can override the same value that ships.
      required: f.required ?? isChecklistTable(f),
      source: 'imported',
      confidence: f.confidence,
      ...(f.description !== undefined ? { description: f.description } : {}),
      ...(f.options ? { options: f.options } : {}),
      ...(f.selectionType ? { selectionType: f.selectionType } : {}),
      ...(f.columns ? { columns: f.columns } : {}),
      ...(f.answerSets ? { answerSets: f.answerSets } : {}),
      ...(f.fixedRows && f.fixedRows.length > 0 ? { fixedRows: f.fixedRows } : {}),
      ...(f.sourcePosition ? { sourcePosition: f.sourcePosition } : {}),
    };
  });
  editor = initialBuilderState({ formId: null, name: '', fields: formFields });
  return derivedReviewFields();
}

/** Run a field-editor action and republish the derived review view. */
function dispatchEdit(action: BuilderAction): void {
  if (!editor) return;
  editor = builderReducer(editor, action);
  session = { ...session, fields: derivedReviewFields() };
  listeners.forEach((l) => l());
}

/** Patch a field's extraction metadata (note / resolved) without touching the editor. */
function setMeta(id: string, patch: { note?: string; resolved?: boolean }): void {
  reviewMeta.set(id, { ...reviewMeta.get(id), ...patch });
  session = { ...session, fields: derivedReviewFields() };
  listeners.forEach((l) => l());
}

const listeners = new Set<() => void>();

function emit() {
  session = { ...session, fields: editor ? derivedReviewFields() : session.fields.slice() };
  listeners.forEach((l) => l());
}

function update(patch: Partial<ImportSession>) {
  session = { ...session, ...patch };
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Current session snapshot (also the useSyncExternalStore getSnapshot). */
export function getImportSession(): ImportSession {
  return session;
}

/** Reset to an empty idle session (called when entering step 1). */
export function resetImportSession() {
  runId += 1; // orphan any in-flight upload/extract
  heldBase64 = null;
  editor = null;
  reviewMeta.clear();
  acceptedAnswerSets.clear();
  geometryProposals.clear();
  confirmedGeometry.clear();
  session = emptySession();
  listeners.forEach((l) => l());
}

/** Enter (or leave, with null) re-extract mode — set by step 1 from its `?form=` param, after reset. */
export function setImportTarget(formId: string | null) {
  update({ targetFormId: formId });
}

export const MAX_UPLOAD_MB = 25;

const ERROR_MESSAGES = {
  aiUnavailable: "This PDF needs AI extraction, which isn't configured on the server yet.",
  storageUnavailable: "File storage isn't available right now — try again shortly.",
  tooLarge: `This PDF is too large to import — the limit is ${MAX_UPLOAD_MB} MB.`,
  generic: 'Something went wrong importing this PDF. Please try again.',
} as const;

function messageForError(err: unknown): string {
  if (err instanceof ApiError) {
    const bodyError =
      typeof err.body === 'object' && err.body !== null && 'error' in err.body
        ? String((err.body as { error: unknown }).error)
        : '';
    if (err.status === 422 && bodyError.startsWith('extraction_unavailable')) {
      return ERROR_MESSAGES.aiUnavailable;
    }
    if (err.status === 503) return ERROR_MESSAGES.storageUnavailable;
    if (err.status === 413) return ERROR_MESSAGES.tooLarge;
  }
  return ERROR_MESSAGES.generic;
}

/** File bytes → base64 (kept separate so the encoding seam is testable). */
export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000; // keep String.fromCharCode arg counts bounded
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Upload the file and run extraction against the API. Resolves once the
 * session has landed in 'ready' or 'error' — state is read via the store,
 * not the return value.
 */
export async function startExtraction(file: File): Promise<void> {
  const run = ++runId;
  heldBase64 = null;
  // Starting over with a new file keeps the re-extract target — the target is
  // wizard-scoped (cleared by reset on step-1 entry), not file-scoped.
  update({ ...emptySession(), targetFormId: session.targetFormId, status: 'uploading', fileName: file.name });

  let base64: string;
  try {
    base64 = await fileToBase64(file);
  } catch (err) {
    if (run !== runId) return;
    update({ status: 'error', error: messageForError(err) });
    return;
  }
  if (run !== runId) return;
  heldBase64 = base64;
  await runPipeline(run, file.name, base64);
}

/** Re-run upload + extraction with the bytes held from the last attempt. */
export async function retryExtraction(): Promise<void> {
  if (heldBase64 === null || !session.fileName) return;
  const run = ++runId;
  update({ status: 'uploading', assetId: null, error: null });
  await runPipeline(run, session.fileName, heldBase64);
}

async function runPipeline(run: number, fileName: string, base64: string): Promise<void> {
  try {
    const { assetId } = await apiClient.post<{ assetId: string }>('/pdf/upload', {
      pdfBase64: base64,
    });
    if (run !== runId) return;
    update({ status: 'extracting', assetId });

    const result = await apiClient.post<ExtractionResult>('/pdf/extract', { assetId, fileName });
    if (run !== runId) return;
    update({
      status: 'ready',
      extraction: result,
      fileName: result.fileName,
      pageCount: result.pageCount,
      designNotes: result.designNotes,
      fields: seedEditor(result.fields),
      error: null,
    });
  } catch (err) {
    if (run !== runId) return;
    update({ status: 'error', error: messageForError(err) });
  }
}

/** Effective review status for a field (resolved fields read as ok). */
export function reviewStatus(field: ReviewField): ExtractionStatus {
  if (field.resolved) return 'ok';
  return statusForConfidence(field.confidence);
}

/** A fixed-item checklist table: repeating group with captured item labels. */
export function isChecklistTable(field: Pick<ReviewField, 'type' | 'fixedRows'>): boolean {
  return field.type === 'repeating_group' && (field.fixedRows?.length ?? 0) > 0;
}

/**
 * The weakest extraction still awaiting review (KTD8/R13): lowest confidence
 * over fields with `resolved !== true` — confirm actions set `resolved`, never
 * confidence, so a confidence-based filter would keep confirmed tables in the
 * stat forever. Null when every field is resolved (stat hidden) or none exist.
 */
export function lowestUnresolvedField(fields: ReviewField[]): ReviewField | null {
  let lowest: ReviewField | null = null;
  for (const f of fields) {
    if (f.resolved === true) continue;
    if (lowest === null || f.confidence < lowest.confidence) lowest = f;
  }
  return lowest;
}

/** The editor field behind a review row, or undefined once it has been deleted. */
function editorField(id: string): FormField | undefined {
  return editor?.fields.find((f) => f.id === id);
}

/** Reviewer toggles a field's required-ness (R4). */
export function setFieldRequired(id: string, required: boolean): void {
  dispatchEdit({ t: 'update', id, patch: { required } });
}

/** Rename one captured checklist item in place; out-of-range indices ignored. */
export function renameFixedRowItem(id: string, index: number, label: string): void {
  const current = editorField(id)?.fixedRows;
  if (!current || index < 0 || index >= current.length) return;
  const fixedRows = current.slice();
  fixedRows[index] = label;
  dispatchEdit({ t: 'update', id, patch: { fixedRows } });
}

/** Append a checklist item after the existing fixed set (extraction missed one). */
export function addFixedRowItem(id: string, label: string): void {
  const current = editorField(id);
  if (!current) return;
  dispatchEdit({ t: 'update', id, patch: { fixedRows: [...(current.fixedRows ?? []), label] } });
}

/**
 * Remove one captured checklist item order-stably. Removing the last item
 * normalizes `fixedRows` to undefined (never an empty array) — the table
 * becomes an open row-entry table.
 */
export function removeFixedRowItem(id: string, index: number): void {
  const current = editorField(id)?.fixedRows;
  if (!current || index < 0 || index >= current.length) return;
  const fixedRows = current.filter((_, i) => i !== index);
  dispatchEdit({ t: 'update', id, patch: { fixedRows: fixedRows.length > 0 ? fixedRows : undefined } });
}

/**
 * Push an undo snapshot without changing anything.
 *
 * The reducer's `update` action is deliberately NOT undoable — in the builder,
 * typing in the label box must not fill the undo stack one keystroke at a
 * time. Review needs label and option edits to be undoable as discrete
 * corrections, so the wrappers below take a snapshot themselves. `mutate`
 * snapshots before running its callback, and `delete` of an id that cannot
 * exist leaves the field list untouched — so this is a pure "checkpoint".
 */
const SNAPSHOT_SENTINEL = '__import_undo_checkpoint__';
function pushUndoCheckpoint(): void {
  dispatchEdit({ t: 'delete', id: SNAPSHOT_SENTINEL });
}

/**
 * Consecutive keystrokes in one input coalesce into a single undo step: a
 * checkpoint is taken only when the edit target changes. Structural edits
 * (which snapshot themselves) clear the key so the next keystroke starts a
 * fresh step.
 */
let coalesceKey: string | null = null;

function dispatchCoalesced(key: string, action: BuilderAction): void {
  if (coalesceKey !== key) {
    pushUndoCheckpoint();
    coalesceKey = key;
  }
  dispatchEdit(action);
}

function dispatchStructural(action: BuilderAction): void {
  coalesceKey = null;
  dispatchEdit(action);
}

/** Rename a field's label (undoable as one step per focused field). */
export function renameField(id: string, label: string): void {
  dispatchCoalesced(`label:${id}`, { t: 'update', id, patch: { label } });
}

/** Change a field's type; choice types seed default options (builder parity). */
export function changeFieldType(id: string, fieldType: FormFieldType): void {
  dispatchStructural({ t: 'changeType', id, fieldType });
}

/** Edit one choice option in place. */
export function setFieldOption(id: string, index: number, value: string): void {
  dispatchCoalesced(`option:${id}:${index}`, { t: 'setOption', id, index, value });
}

/** Append a new choice option. */
export function addFieldOption(id: string): void {
  dispatchStructural({ t: 'addOption', id });
}

/** Remove one choice option. */
export function removeFieldOption(id: string, index: number): void {
  dispatchStructural({ t: 'removeOption', id, index });
}

/**
 * Set (or clear, with null) a field's visibility condition.
 *
 * Structural rather than coalesced: a condition is one deliberate decision, not
 * a stream of keystrokes, and the author must be able to undo it in one step.
 * Clearing writes `undefined` rather than deleting the key — the publish
 * whitelist in `reviewedToFields` treats both identically, and the reducer's
 * `update` is a spread.
 */
export function setFieldCondition(id: string, condition: VisibilityCondition | null): void {
  dispatchStructural({ t: 'update', id, patch: { visibleWhen: condition ?? undefined } });
}

/** Drop a field from the import entirely (it never reaches publish). */
export function deleteField(id: string): void {
  dispatchStructural({ t: 'delete', id });
}

/**
 * Insert a new field directly after `afterId` (end of list when omitted or
 * unknown). Returns the new field's id so the caller can select it.
 */
export function addField(fieldType: FormFieldType, afterId?: string | null): string | null {
  if (!editor) return null;
  coalesceKey = null;
  dispatchEdit({ t: 'select', id: afterId ?? null });
  dispatchEdit({ t: 'add', fieldType });
  return editor.selectedId;
}

/** Nudge a field one place up (-1) or down (1). */
export function moveField(id: string, dir: -1 | 1): void {
  dispatchStructural({ t: 'move', id, dir });
}

/** arrayMove reorder (drag-and-drop drops). */
export function reorderFields(from: number, to: number): void {
  dispatchStructural({ t: 'reorder', from, to });
}

/* ------------------------------------------------------------------ *
 * Repeating-table columns and answer sets (R6)
 * ------------------------------------------------------------------ */

/**
 * Which proposed answer sets the reviewer has explicitly accepted, as
 * `${fieldId}::${setKey}`.
 *
 * Extraction PROPOSES a grouping; publishing one unreviewed is the failure R6
 * exists to prevent. Acceptance is therefore tracked HERE rather than on the
 * field: it is review state, not published field state — `AnswerSet` has no
 * "accepted" flag and must not grow one, or every consumer downstream of
 * publish would have to reason about a proposal that no longer exists. A set
 * the reviewer created themselves is accepted by construction (they just made
 * it), so `groupColumns` marks it immediately; only extractor proposals start
 * unaccepted. Cleared on reset and on every fresh extraction, so a new run can
 * never inherit the previous run's approvals.
 */
const acceptedAnswerSets = new Set<string>();

function acceptanceKey(fieldId: string, setKey: string): string {
  return `${fieldId}::${setKey}`;
}

/** True once the reviewer has explicitly accepted this set (or made it). */
export function answerSetAccepted(fieldId: string, setKey: string): boolean {
  return acceptedAnswerSets.has(acceptanceKey(fieldId, setKey));
}

/**
 * Geometry under review — where a field's answers sit on the original PDF.
 *
 * Two stores, deliberately separate, exactly as answer sets are: what was
 * PROPOSED (derived from the text layer, or drawn by hand) and what the
 * reviewer has CONFIRMED. Only the second crosses the publish boundary.
 *
 * That split is R8. Derivation refuses rather than guess when it cannot see
 * enough, but a proposal it *is* willing to make can still be wrong in ways
 * only a human looking at the page will catch — and an unconfirmed proposal
 * that published would draw marks on a compliance record nobody checked. So
 * unconfirmed geometry does not merely rank lower; it does not exist
 * downstream.
 */
const geometryProposals = new Map<string, PageBox>();
const confirmedGeometry = new Set<string>();

/**
 * Widen a segment box so it contains every one of its bands, clamped to the
 * page. Bands outside the box are rejected by the shared validator, so an
 * adjustment that pushes past the current edge has to carry the box with it.
 */
function growToFit(segment: PageBox): PageBox {
  const cols = segment.columnBands ?? [];
  const rows = segment.rowBands ?? [];

  const left = Math.max(Math.min(segment.x, ...cols.map((b) => b.start)), 0);
  const right = Math.min(Math.max(segment.x + segment.width, ...cols.map((b) => b.end)), segment.pageWidth);
  const bottom = Math.max(Math.min(segment.y, ...rows.map((b) => b.start)), 0);
  const top = Math.min(Math.max(segment.y + segment.height, ...rows.map((b) => b.end)), segment.pageHeight);

  return { ...segment, x: left, y: bottom, width: right - left, height: top - bottom };
}

/** Record a proposed footprint for a field, replacing any earlier proposal. */
export function proposeGeometry(fieldId: string, segment: PageBox): void {
  geometryProposals.set(fieldId, segment);
  // A new proposal is unconfirmed by construction — re-deriving must never
  // inherit the confirmation given to the geometry it replaced.
  confirmedGeometry.delete(fieldId);
  emit();
}

/** The proposal on offer for a field, confirmed or not. */
export function geometryProposal(fieldId: string): PageBox | undefined {
  return geometryProposals.get(fieldId);
}

/** True once the reviewer has explicitly confirmed this field's geometry. */
export function geometryConfirmed(fieldId: string): boolean {
  return confirmedGeometry.has(fieldId);
}

/** Reviewer accepts the proposed grid as drawn. */
export function confirmGeometry(fieldId: string): void {
  if (!geometryProposals.has(fieldId)) return;
  confirmedGeometry.add(fieldId);
  emit();
}

/** Reviewer rejects the grid outright — the field exports as data. */
export function rejectGeometry(fieldId: string): void {
  geometryProposals.delete(fieldId);
  confirmedGeometry.delete(fieldId);
  emit();
}

/**
 * Move one band edge.
 *
 * An adjustment un-confirms the field: the reviewer is mid-correction, and
 * treating a half-moved grid as still-confirmed would publish an intermediate
 * state. They confirm again when the grid looks right.
 */
export function adjustGeometryBand(
  fieldId: string,
  axis: 'column' | 'row',
  key: string,
  edge: 'start' | 'end',
  value: number,
): void {
  const segment = geometryProposals.get(fieldId);
  if (!segment) return;

  const bands = axis === 'column' ? segment.columnBands : segment.rowBands;
  const band = bands?.find((b) => b.key === key);
  if (!band) return;

  const moved = { ...band, [edge]: value };
  if (!(moved.end > moved.start)) return; // an inverted band is not an edit

  const withMove: PageBox = {
    ...segment,
    ...(axis === 'column'
      ? { columnBands: segment.columnBands!.map((b) => (b.key === key ? moved : b)) }
      : { rowBands: segment.rowBands!.map((b) => (b.key === key ? moved : b)) }),
  };

  // Grow the box to contain the moved band. Bands must lie inside the segment,
  // so without this a reviewer dragging the outermost edge outward would see
  // the control simply do nothing — the edit is legitimate, it is the box that
  // was too small.
  const next = growToFit(withMove);

  // Reject an edit the shipped validator would refuse, rather than storing a
  // grid that silently vanishes at publish. Overlapping a neighbour is the
  // common case when dragging an edge past it.
  if (resolveGeometry({ geometry: { segments: [next] } }).segments.length !== 1) return;

  geometryProposals.set(fieldId, next);
  confirmedGeometry.delete(fieldId);
  emit();
}

/**
 * Move the shared boundary between two adjacent bands.
 *
 * `centresToBands` makes bands contiguous — `bands[i].end === bands[i+1].start`
 * — so an interior edge belongs to two bands at once. Moving only one of them
 * opens a gap the exporter cannot resolve: a tick printed in it falls in no
 * column at all. The two edges are therefore one control, written together or
 * not at all, and the same validator decides.
 */
export function adjustGeometryBoundary(
  fieldId: string,
  axis: 'column' | 'row',
  leftKey: string,
  rightKey: string,
  value: number,
): void {
  const segment = geometryProposals.get(fieldId);
  if (!segment) return;

  const bands = (axis === 'column' ? segment.columnBands : segment.rowBands) ?? [];
  const left = bands.find((b) => b.key === leftKey);
  const right = bands.find((b) => b.key === rightKey);
  if (!left || !right) return;
  if (!(value > left.start) || !(value < right.end)) return;

  const moved = bands.map((b) =>
    b.key === leftKey ? { ...b, end: value } : b.key === rightKey ? { ...b, start: value } : b,
  );
  const next = growToFit({
    ...segment,
    ...(axis === 'column' ? { columnBands: moved } : { rowBands: moved }),
  });
  if (resolveGeometry({ geometry: { segments: [next] } }).segments.length !== 1) return;

  geometryProposals.set(fieldId, next);
  confirmedGeometry.delete(fieldId);
  emit();
}

/** Reviewer accepts extraction's proposed grouping as-is. */
export function acceptAnswerSet(fieldId: string, setKey: string): void {
  acceptedAnswerSets.add(acceptanceKey(fieldId, setKey));
  emit();
}

/** The column list of a repeating table under review, or an empty list. */
function columnsOf(id: string): RepeatingColumn[] {
  return editorField(id)?.columns ?? [];
}

/** The label column key — `columns[0]`, never answerable, never groupable. */
function labelKeyOf(id: string): string | undefined {
  return columnsOf(id)[0]?.key;
}

/**
 * Rewrite one column in place. The `key` is never part of the patch: it is the
 * identity a row value and any answer set naming it are stored under, so a
 * rename must move only the display `label`.
 */
function patchColumn(id: string, key: string, patch: Partial<Omit<RepeatingColumn, 'key'>>): RepeatingColumn[] | null {
  const columns = columnsOf(id);
  if (!columns.some((c) => c.key === key)) return null;
  return columns.map((c) => (c.key === key ? { ...c, ...patch } : c));
}

/**
 * Strip `keys` from every set, dropping any set left with fewer than two
 * members — a one-column "group" is just a checkbox, and leaving it would be a
 * set `resolveAnswerSets` reports as dropped rather than a clean table.
 */
function withoutMembers(fieldId: string, sets: AnswerSet[], keys: Set<string>): AnswerSet[] {
  const next: AnswerSet[] = [];
  for (const set of sets) {
    const columnKeys = set.columnKeys.filter((k) => !keys.has(k));
    if (columnKeys.length === set.columnKeys.length) {
      next.push(set);
      continue;
    }
    if (columnKeys.length < 2) {
      acceptedAnswerSets.delete(acceptanceKey(fieldId, set.key));
      continue;
    }
    next.push({ ...set, columnKeys });
  }
  return next;
}

/** Mint a set key unique within the field. */
function nextAnswerSetKey(sets: AnswerSet[]): string {
  const taken = new Set(sets.map((s) => s.key));
  let n = sets.length + 1;
  while (taken.has(`as${n}`)) n += 1;
  return `as${n}`;
}

/** Rename a column's display label; its `key` (and any set naming it) is untouched. */
export function renameColumn(id: string, key: string, label: string): void {
  const columns = patchColumn(id, key, { label });
  if (!columns) return;
  dispatchCoalesced(`column:${id}:${key}`, { t: 'update', id, patch: { columns } });
}

/** Toggle a column's per-cell required flag. */
export function setColumnRequired(id: string, key: string, required: boolean): void {
  const columns = patchColumn(id, key, { required });
  if (!columns) return;
  dispatchStructural({ t: 'update', id, patch: { columns } });
}

/**
 * Retype a column. The label column is fixed text (pre-printed item names) and
 * is left alone. Retyping a grouped column to `text` removes it from its set:
 * a free-text cell cannot be one option of a one-answer-per-row group, and
 * leaving it in would publish a malformed set.
 */
export function setColumnType(id: string, key: string, type: FormFieldType): void {
  if (key === labelKeyOf(id)) return;
  const columns = patchColumn(id, key, { type });
  if (!columns) return;
  const patch: Partial<FormField> = { columns };
  // Any non-tick type leaves the set: a date or number column can never
  // register as a row's answer (isChosen accepts only true/'true'/1) while
  // applySelection would still write boolean `true` into it. The builder host
  // already strips on every retype — the two must agree.
  if (type !== 'checkbox') {
    const sets = editorField(id)?.answerSets ?? [];
    patch.answerSets = withoutMembers(id, sets, new Set([key]));
  }
  // A choice column with no options falls through to a plain text input, so
  // seed it — the same trap `retypeField` closes for scalar fields. The
  // builder host does the same; the two must agree.
  if ((type === 'dropdown' || type === 'radio') && !columnOf(id, key)?.options?.length) {
    patch.columns = columns.map((c) =>
      c.key === key ? { ...c, options: ['Option 1', 'Option 2'] } : c,
    );
  }
  dispatchStructural({ t: 'update', id, patch });
}

/** Replace a choice column's option list wholesale. */
export function setColumnOptions(id: string, key: string, options: string[]): void {
  if (key === labelKeyOf(id)) return;
  const columns = patchColumn(id, key, { options });
  if (!columns) return;
  dispatchStructural({ t: 'update', id, patch: { columns } });
}

/** One column of a reviewed repeating field, by key. */
function columnOf(id: string, key: string) {
  return editorField(id)?.columns?.find((c) => c.key === key);
}

/**
 * Group columns into a new answer set (one answer per row across them).
 *
 * The label column is filtered out rather than rejecting the whole request —
 * a reviewer sweeping a row of columns should get the answerable ones grouped.
 * Members already in another set MOVE here: `resolveAnswerSets` drops sets with
 * overlapping membership outright, so duplicating would silently un-group both.
 * Returns the new set's key, or null when fewer than two groupable columns
 * remain.
 */
export function groupColumns(id: string, columnKeys: string[]): string | null {
  const field = editorField(id);
  if (!field) return null;
  const known = new Set((field.columns ?? []).map((c) => c.key));
  const labelKey = labelKeyOf(id);

  const members: string[] = [];
  for (const k of columnKeys) {
    if (k === labelKey || !known.has(k) || members.includes(k)) continue;
    members.push(k);
  }
  if (members.length < 2) return null;

  const existing = withoutMembers(id, field.answerSets ?? [], new Set(members));
  const key = nextAnswerSetKey(field.answerSets ?? []);
  acceptedAnswerSets.add(acceptanceKey(id, key));
  dispatchStructural({ t: 'update', id, patch: { answerSets: [...existing, { key, columnKeys: members }] } });
  return key;
}

/**
 * How a flattened checklist was read off the page, which decides how its items
 * deal out into printed columns when the table is split:
 *
 * - `down-columns` — the extractor read the whole leftmost column top-to-bottom,
 *   then the next, so a group is a CONTIGUOUS block (`items[g·R … (g+1)·R)`).
 * - `across-rows` — the extractor read each row left-to-right, so every `groups`-th
 *   item shares a column and a group is a STRIDE (`i % groups === g`).
 *
 * Neither is universally right because the AI extraction order is not stable
 * (the defect this exists to fix). `down-columns` is the default because the
 * extraction prompt now pins that order (U1); the reviewer flips to `across-rows`
 * when a run still arrives row-major.
 */
export type SplitReadingMode = 'down-columns' | 'across-rows';

/**
 * Deal `items` into `groups` printed columns under the given reading mode.
 * Pure, so the split control can preview exactly what a commit will create.
 * A remainder that does not divide evenly goes to the EARLIER groups under
 * both modes, so no item is ever lost.
 */
export function distributeGroups<T>(items: readonly T[], groups: number, mode: SplitReadingMode): T[][] {
  if (mode === 'across-rows') {
    return Array.from({ length: groups }, (_, g) => items.filter((_item, i) => i % groups === g));
  }
  // down-columns: contiguous, near-equal slices. The first `remainder` groups
  // take one extra item, matching the stride's remainder-to-earlier-groups rule.
  const base = Math.floor(items.length / groups);
  const remainder = items.length % groups;
  const out: T[][] = [];
  let cursor = 0;
  for (let g = 0; g < groups; g += 1) {
    const size = base + (g < remainder ? 1 : 0);
    out.push(items.slice(cursor, cursor + size));
    cursor += size;
  }
  return out;
}

/**
 * Split one extracted table into the `groups` printed groups it really is.
 *
 * `ADMN-FRM-111`'s Category A block prints as 6 rows × 3 side-by-side groups
 * and extraction flattened it into one 18-item field. `PageBox` is a cross
 * product of column bands × row bands: it can say "column 2, row 5" and cannot
 * say "the 7th answer belongs to the middle group's first row" (R18). No band
 * adjustment reaches that, so the field is split instead — each group becomes a
 * plain N-row grid the derivation and the exporter already handle, and each is
 * confirmable on its own, so a misplaced middle group cannot scatter wrong
 * answers through the whole list.
 *
 * `mode` decides how the flattened items deal into columns (see
 * `distributeGroups`). It defaults to `down-columns` to agree with the pinned
 * extraction order (U1); the reviewer overrides when a run arrives row-major.
 * The earlier assumption that extraction is always row-major was the defect:
 * the AI order is not stable, so a fixed stride scrambled the groups.
 *
 * The REVIEWER declares this; extraction never infers it. Production `v3` of
 * this same form split the block into three fields while this import merged
 * it — extraction is already inconsistent run to run on one document, which is
 * the argument for an explicit decision by someone looking at the page rather
 * than a silent model judgement.
 *
 * Refused rather than approximated when the shape cannot support it: fewer
 * than two groups is nothing to do, more groups than items would mint a table
 * with no rows, and a table with no captured items has nothing to distribute.
 */
export function splitTableGroups(
  id: string,
  groups: number,
  mode: SplitReadingMode = 'down-columns',
): string[] {
  const field = editorField(id);
  const items = field?.fixedRows;
  if (!field || !items?.length) return [];
  if (!Number.isInteger(groups) || groups < 2 || groups > items.length) return [];

  const membership = distributeGroups(items, groups, mode);
  const parts = membership.map((fixedRows, g) => ({
    label: `${field.label} (${g + 1} of ${groups})`,
    fixedRows,
    // Both position records described the merged block and describe none of
    // the groups. `sourcePosition` is dropped for the same reason geometry is
    // below — and it matters more, because `geometrySegments` falls back to it
    // when there is no geometry, so leaving it would stack all three groups'
    // marks on one spot at export.
    sourcePosition: undefined,
  }));

  coalesceKey = null;
  dispatchEdit({ t: 'splitField', id, parts });

  // Answer-set acceptance carries: the groups have the source's columns and the
  // source's sets, making exactly the claim the reviewer already judged, so
  // re-asking three times would be noise rather than safety.
  // The reducer leaves the first new part selected, and the parts replaced the
  // source in place, so they are the `groups` fields from there.
  const all = editor?.fields ?? [];
  const at = all.findIndex((f) => f.id === editor?.selectedId);
  const created = at < 0 ? [] : all.slice(at, at + groups);
  for (const set of field.answerSets ?? []) {
    if (answerSetAccepted(id, set.key)) {
      for (const part of created) acceptedAnswerSets.add(acceptanceKey(part.id, set.key));
    }
  }

  /*
    Nothing the SOURCE held is deleted here, and that is deliberate.

    Geometry, acceptance and extraction metadata all live in id-keyed stores
    the field-editor's undo snapshot does not capture, so deleting them would
    make the split partly un-undoable: undo restores `catA` to the list with
    its answer sets intact while `acceptedAnswerSets` no longer holds
    `catA::as1`, and the table then publishes with no answer set at all — the
    one-answer-per-row rule the reviewer explicitly accepted, silently gone.
    Same for a confirmed grid, and for the `resolved` flag.

    Leaving them costs nothing: every consumer reads these stores THROUGH the
    current field list, so an entry for an id no longer in it is inert, and
    `resetImportSession` clears all of them on the next extraction.

    The groups still start clean, because they have FRESH ids — no geometry
    (positional: a grid confirmed over all 18 items describes none of the three
    groups, per R8) and no `reviewMeta`, so each arrives awaiting its own
    confirmation rather than pre-blessed by a judgement about the merged block.
  */
  emit();
  return created.map((f) => f.id);
}

/** Dissolve one answer set — its columns return to independent cells. */
export function ungroupAnswerSet(id: string, setKey: string): void {
  const field = editorField(id);
  if (!field?.answerSets) return;
  acceptedAnswerSets.delete(acceptanceKey(id, setKey));
  dispatchStructural({
    t: 'update',
    id,
    patch: { answerSets: field.answerSets.filter((s) => s.key !== setKey) },
  });
}

export function undoFieldEdit(): void {
  dispatchStructural({ t: 'undo' });
}

export function redoFieldEdit(): void {
  dispatchStructural({ t: 'redo' });
}

export function canUndoFieldEdit(): boolean {
  return (editor?.undo.length ?? 0) > 0;
}

export function canRedoFieldEdit(): boolean {
  return (editor?.redo.length ?? 0) > 0;
}

export function useImportSession() {
  const snap = useSyncExternalStore(subscribe, getImportSession, getImportSession);

  return {
    ...snap,
    /** Base64 of the source PDF — used for instant review rendering (falls back to asset fetch if absent). */
    pdfBase64: heldBase64,
    total: snap.fields.length,
    needReview: snap.fields.filter((f) => reviewStatus(f) !== 'ok').length,
    avgConfidence:
      snap.fields.reduce((sum, f) => sum + f.confidence, 0) / Math.max(1, snap.fields.length),

    /**
     * Remap the low-confidence "text" field to a signature (the known case).
     * Type lives in the editor; the confirmation note and resolved flag are
     * extraction metadata and never reach the published field.
     */
    remapSignature(id: string) {
      dispatchEdit({ t: 'update', id, patch: { type: 'signature', confidence: 1 } });
      setMeta(id, { resolved: true, note: 'Corrected — remapped to a signature field' });
    },

    /** Inline type correction for a flagged field. */
    setType(id: string, type: ExtractedField['type']) {
      const current = snap.fields.find((f) => f.id === id);
      const confidence = current && reviewStatus(current) === 'low' ? 1 : current?.confidence;
      dispatchEdit({
        t: 'update',
        id,
        patch: { type, ...(confidence !== undefined ? { confidence } : {}) },
      });
      setMeta(id, { resolved: true });
    },

    /** Confirm a detected repeating table should stay a repeating group. */
    confirmTable(id: string) {
      setMeta(id, { resolved: true, note: 'Confirmed as a repeating table' });
    },
  };
}

/**
 * Map the reviewed extraction to publishable FormFields. Fixed-row checklist
 * tables default to `required: true` (R4/AE5) unless the reviewer untoggled;
 * everything else defaults to false.
 */
/**
 * The answer sets on a review field that the reviewer actually accepted.
 * Extraction's proposals start unaccepted; a grouping the reviewer made
 * themselves is accepted by construction (see `groupColumns`).
 */
function publishableAnswerSets(field: ReviewField): AnswerSet[] {
  return (field.answerSets ?? []).filter((s) => answerSetAccepted(field.id, s.key));
}

export function reviewedToFields(fields: ReviewField[]): FormField[] {
  return fields.map((f) => ({
    id: f.id,
    type: f.type,
    label: f.label,
    required: f.required ?? isChecklistTable(f),
    source: 'imported',
    confidence: f.confidence,
    ...(f.description ? { description: f.description } : {}),
    ...(f.options ? { options: f.options } : {}),
    ...(f.selectionType ? { selectionType: f.selectionType } : {}),
    ...(f.columns ? { columns: f.columns } : {}),
    // This whitelist is the publish boundary: a property missing here is
    // silently dropped even though review displayed it correctly.
    //
    // Only ACCEPTED groupings cross it. R6 says a proposal is never silently
    // applied, and the inspector tells the reviewer as much ("Not applied
    // yet") — publishing an unreviewed proposal anyway would both break the
    // requirement and contradict what the reviewer was shown. A grouping
    // changes the completeness rule for every filler from "any cell filled"
    // to "exactly one option per set", so an AI guess nobody looked at must
    // not silently make a second answer unrecordable.
    ...(publishableAnswerSets(f).length > 0 ? { answerSets: publishableAnswerSets(f) } : {}),
    ...(f.visibleWhen ? { visibleWhen: f.visibleWhen } : {}),
    ...(f.fixedRows && f.fixedRows.length > 0 ? { fixedRows: f.fixedRows } : {}),
    ...(f.sourcePosition ? { sourcePosition: f.sourcePosition } : {}),
    // Only CONFIRMED geometry crosses, for the same reason only accepted
    // answer sets do (R8). An unconfirmed proposal that published would draw
    // marks onto a competency record against a grid no human ever looked at —
    // and because absent geometry degrades to a data-only export, refusing to
    // publish it is visible and correctable rather than silently wrong.
    ...(publishableGeometry(f) ? { geometry: publishableGeometry(f)! } : {}),
  }));
}

/** A field's geometry, but only once the reviewer has confirmed it. */
function publishableGeometry(field: ReviewField): FieldGeometry | undefined {
  if (!geometryConfirmed(field.id)) return undefined;
  const segment = geometryProposals.get(field.id);
  return segment ? { segments: [segment] } : undefined;
}
