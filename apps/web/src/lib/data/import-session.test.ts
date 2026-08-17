/**
 * Import session extraction lifecycle — startExtraction drives
 * POST /pdf/upload → POST /pdf/extract with status transitions
 * idle → uploading → extracting → ready | error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtractedField, ExtractionResult } from '@formai/shared';

// The real ApiError class is kept (error mapping relies on instanceof);
// only the request methods are mocked.
vi.mock('./api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api-client.js')>();
  return {
    ...actual,
    apiClient: {
      ...actual.apiClient,
      post: vi.fn(),
    },
  };
});

// Guard: the fixture path must never be consulted by this module again.
vi.mock('./store.js', () => ({
  store: {
    importDraft: () => {
      throw new Error('fixture path (store.importDraft) must not be used by import-session');
    },
  },
}));

import { resolveGeometry } from '@formai/shared';
import type { PageBox } from '@formai/shared';
import { apiClient, ApiError } from './api-client.js';
import type { ImportDraftStore } from './import-draft-store.js';
import { memoryDraftStore } from './import-draft-store.js';
import {
  acceptAnswerSet,
  addFixedRowItem,
  answerSetAccepted,
  captureImportCorrections,
  sendImportCorrections,
  deleteField,
  adjustGeometryBand,
  adjustGeometryBoundary,
  changeFieldType,
  confirmField,
  distributeGroups,
  allGeometryPlacements,
  confirmGeometry,
  fileToBase64,
  reviewStatus,
  geometryConfirmed,
  geometryProposal,
  getImportSession,
  IMPORT_REQUEST_TIMEOUT_MS,
  lowestUnresolvedField,
  optionSlotId,
  proposeGeometry,
  rejectGeometry,
  removeFixedRowItem,
  renameFixedRowItem,
  AUTOSAVE_DEBOUNCE_MS,
  captureImportSnapshot,
  copyPlacementToField,
  placementSourcesFor,
  clearSavedImport,
  flushImportAutosave,
  loadSavedImport,
  setImportDraftStore,
  restoreImportSnapshot,
  resetImportSession,
  retryExtraction,
  reviewedToFields,
  setFieldRequired,
  splitTableGroups,
  startExtraction,
  undoFieldEdit,
  type ReviewField,
} from './import-session.js';

const postMock = vi.mocked(apiClient.post);

const EXTRACTION: ExtractionResult = {
  sourceType: 'pdf_import',
  path: 'acroform',
  fileName: 'site-safety-audit.pdf',
  pageCount: 3,
  fields: [
    { id: 'f1', label: 'Auditor name', type: 'text', confidence: 0.98 },
    { id: 'f2', label: 'Signature', type: 'text', confidence: 0.4 },
  ],
  designNotes: ['Signature block detected as plain text'],
};

function makeFile(name = 'site-safety-audit.pdf'): File {
  return new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], name, {
    type: 'application/pdf',
  });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  postMock.mockReset();
  resetImportSession();
});

describe('fileToBase64', () => {
  it('encodes the file bytes as base64', async () => {
    expect(await fileToBase64(makeFile())).toBe('JVBERi0='); // "%PDF-"
  });
});

describe('startExtraction', () => {
  it('walks idle → uploading → extracting → ready and exposes the real extraction', async () => {
    expect(getImportSession().status).toBe('idle');

    const upload = deferred<{ assetId: string }>();
    const extract = deferred<ExtractionResult>();
    postMock.mockImplementationOnce(() => upload.promise as Promise<never>);
    postMock.mockImplementationOnce(() => extract.promise as Promise<never>);

    const done = startExtraction(makeFile());
    await vi.waitFor(() => expect(getImportSession().status).toBe('uploading'));

    upload.resolve({ assetId: 'asset-123' });
    await vi.waitFor(() => expect(getImportSession().status).toBe('extracting'));
    expect(getImportSession().assetId).toBe('asset-123');

    extract.resolve(EXTRACTION);
    await done;

    const session = getImportSession();
    expect(session.status).toBe('ready');
    expect(session.fileName).toBe('site-safety-audit.pdf');
    expect(session.pageCount).toBe(3);
    expect(session.designNotes).toEqual(EXTRACTION.designNotes);
    expect(session.fields.map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(session.extraction).toEqual(EXTRACTION);
    expect(session.error).toBeNull();

    expect(postMock).toHaveBeenNthCalledWith(
      1,
      '/pdf/upload',
      { pdfBase64: 'JVBERi0=' },
      { timeoutMs: IMPORT_REQUEST_TIMEOUT_MS },
    );
    expect(postMock).toHaveBeenNthCalledWith(
      2,
      '/pdf/extract',
      { assetId: 'asset-123', fileName: 'site-safety-audit.pdf', documentType: 'generic' },
      { timeoutMs: IMPORT_REQUEST_TIMEOUT_MS },
    );
  });

  it('maps a 422 extraction_unavailable on extract to the AI-unavailable message, keeping the file name', async () => {
    postMock.mockResolvedValueOnce({ assetId: 'asset-123' });
    postMock.mockRejectedValueOnce(
      new ApiError(422, { error: 'extraction_unavailable: no ANTHROPIC_API_KEY configured' }),
    );

    await startExtraction(makeFile());

    const session = getImportSession();
    expect(session.status).toBe('error');
    expect(session.error).toBe(
      "This PDF needs AI extraction, which isn't configured on the server yet.",
    );
    expect(session.fileName).toBe('site-safety-audit.pdf');
  });

  it('maps a 503 on upload to the storage-unavailable message', async () => {
    postMock.mockRejectedValueOnce(new ApiError(503, { error: 'storage_unavailable' }));

    await startExtraction(makeFile());

    const session = getImportSession();
    expect(session.status).toBe('error');
    expect(session.error).toBe("File storage isn't available right now — try again shortly.");
    expect(session.fileName).toBe('site-safety-audit.pdf');
  });

  it('maps a 413 to the file-too-large message', async () => {
    postMock.mockRejectedValueOnce(new ApiError(413, undefined));

    await startExtraction(makeFile());

    expect(getImportSession().status).toBe('error');
    expect(getImportSession().error).toBe('This PDF is too large to import — the limit is 25 MB.');
  });

  it('maps a 401 to the session-expired message rather than the generic one', async () => {
    postMock.mockRejectedValueOnce(new ApiError(401, { error: 'unauthenticated' }));

    await startExtraction(makeFile());

    const session = getImportSession();
    expect(session.status).toBe('error');
    expect(session.error).toBe('Your session has expired — sign in again, then retry the import.');
    expect(session.fileName).toBe('site-safety-audit.pdf');
  });

  it('maps a client-side timeout abort to the timeout message', async () => {
    // The api-client aborts a slow request as ApiError(0, { error: 'request_timeout' }).
    postMock.mockRejectedValueOnce(new ApiError(0, { error: 'request_timeout' }));

    await startExtraction(makeFile());

    expect(getImportSession().status).toBe('error');
    expect(getImportSession().error).toBe(
      'The import timed out. Very large PDFs can take a while — please try again.',
    );
  });

  it('maps any other failure to a generic message', async () => {
    postMock.mockRejectedValueOnce(new TypeError('network down'));

    await startExtraction(makeFile());

    expect(getImportSession().status).toBe('error');
    expect(getImportSession().error).toBe(
      'Something went wrong importing this PDF. Please try again.',
    );
  });
});

describe('retryExtraction', () => {
  it('re-runs the pipeline with the held file bytes after an error', async () => {
    postMock.mockRejectedValueOnce(new ApiError(503, { error: 'storage_unavailable' }));
    await startExtraction(makeFile());
    expect(getImportSession().status).toBe('error');

    postMock.mockResolvedValueOnce({ assetId: 'asset-456' });
    postMock.mockResolvedValueOnce(EXTRACTION);
    await retryExtraction();

    const session = getImportSession();
    expect(session.status).toBe('ready');
    expect(session.assetId).toBe('asset-456');
    expect(session.fields).toHaveLength(2);
    expect(postMock).toHaveBeenLastCalledWith(
      '/pdf/extract',
      // Retry replays the type the original run chose, not a fresh default.
      { assetId: 'asset-456', fileName: 'site-safety-audit.pdf', documentType: 'generic' },
      { timeoutMs: IMPORT_REQUEST_TIMEOUT_MS },
    );
  });

  it('is a no-op when nothing was ever started', async () => {
    await retryExtraction();
    expect(getImportSession().status).toBe('idle');
    expect(postMock).not.toHaveBeenCalled();
  });
});

// --- Review UX pure logic (U5) ---------------------------------------------

function reviewField(overrides: Partial<ReviewField> & { id: string }): ReviewField {
  return { label: overrides.id, type: 'text', confidence: 0.9, ...overrides };
}

const CHECKLIST: ExtractedField = {
  id: 'chk',
  label: 'Category A checks',
  type: 'repeating_group',
  confidence: 0.8,
  columns: [
    { key: 'item', label: 'Item', type: 'text' },
    { key: 'ok', label: 'OK', type: 'checkbox' },
    { key: 'na', label: 'NA', type: 'checkbox' },
  ],
  fixedRows: ['Engine oil level', 'Park brake', 'Tyres'],
};

/** A minimal valid footprint, used where the geometry's shape is not the point. */
const SPLIT_SEGMENT: PageBox = {
  page: 0,
  x: 40,
  y: 180,
  width: 520,
  height: 130,
  pageWidth: 595.32,
  pageHeight: 419.52,
  columnBands: [
    { key: 'ok', start: 504.5, end: 532.9 },
    { key: 'na', start: 532.9, end: 561.2 },
  ],
  rowBands: [{ key: 'r0', start: 290, end: 306 }],
};

/** Seed the session store with the given extracted fields via the real pipeline. */
async function seedSession(fields: ExtractedField[]): Promise<void> {
  postMock.mockResolvedValueOnce({ assetId: 'asset-seed' });
  postMock.mockResolvedValueOnce({ ...EXTRACTION, fields });
  await startExtraction(makeFile());
  expect(getImportSession().status).toBe('ready');
}

describe('lowestUnresolvedField', () => {
  it('returns the lowest-confidence field among unresolved fields only (KTD8)', () => {
    const fields: ReviewField[] = [
      reviewField({ id: 'a', confidence: 0.4, resolved: true }),
      reviewField({ id: 'b', confidence: 0.7 }),
      reviewField({ id: 'c', confidence: 0.9 }),
    ];
    expect(lowestUnresolvedField(fields)?.id).toBe('b');
  });

  it('is null when every field is resolved (stat hidden)', () => {
    const fields: ReviewField[] = [
      reviewField({ id: 'a', confidence: 0.4, resolved: true }),
      reviewField({ id: 'b', confidence: 0.99, resolved: true }),
    ];
    expect(lowestUnresolvedField(fields)).toBeNull();
  });

  it('is null for an empty field list', () => {
    expect(lowestUnresolvedField([])).toBeNull();
  });
});

describe('reviewedToFields — required + fixedRows (R4/AE5)', () => {
  it('defaults an untouched fixed-row checklist to required: true and passes fixedRows through', () => {
    const out = reviewedToFields([{ ...CHECKLIST }])[0]!;
    expect(out.required).toBe(true);
    expect(out.fixedRows).toEqual(['Engine oil level', 'Park brake', 'Tyres']);
  });

  it('carries a reviewer untoggle through (required: false wins over the checklist default)', () => {
    const out = reviewedToFields([{ ...CHECKLIST, required: false }])[0]!;
    expect(out.required).toBe(false);
  });

  it('defaults a non-checklist field to required: false and a toggle to true', () => {
    const fields = reviewedToFields([
      reviewField({ id: 'a' }),
      reviewField({ id: 'b', required: true }),
    ]);
    expect(fields[0]!.required).toBe(false);
    expect(fields[1]!.required).toBe(true);
  });

  it('omits fixedRows for open row-entry tables', () => {
    const out = reviewedToFields([{ ...CHECKLIST, fixedRows: undefined }])[0]!;
    expect(out.required).toBe(false); // no fixedRows → not a checklist → plain default
    expect('fixedRows' in out).toBe(false);
  });
});

describe('review actions — required toggle + fixed-row item editing', () => {
  it('setFieldRequired writes into the reviewed field state', async () => {
    await seedSession([{ ...CHECKLIST }]);

    setFieldRequired('chk', false);
    expect(getImportSession().fields[0]!.required).toBe(false);

    setFieldRequired('chk', true);
    expect(getImportSession().fields[0]!.required).toBe(true);
  });

  it('renameFixedRowItem renames one label order-stably', async () => {
    await seedSession([{ ...CHECKLIST }]);

    renameFixedRowItem('chk', 1, 'Park brake operation');
    expect(getImportSession().fields[0]!.fixedRows).toEqual([
      'Engine oil level',
      'Park brake operation',
      'Tyres',
    ]);
  });

  it('renameFixedRowItem ignores out-of-range indices', async () => {
    await seedSession([{ ...CHECKLIST }]);

    renameFixedRowItem('chk', 3, 'nope');
    renameFixedRowItem('chk', -1, 'nope');
    expect(getImportSession().fields[0]!.fixedRows).toEqual(CHECKLIST.fixedRows);
  });

  it('addFixedRowItem appends after the existing items', async () => {
    await seedSession([{ ...CHECKLIST }]);

    addFixedRowItem('chk', 'Horn');
    expect(getImportSession().fields[0]!.fixedRows).toEqual([
      'Engine oil level',
      'Park brake',
      'Tyres',
      'Horn',
    ]);
  });

  it('removeFixedRowItem removes one item keeping the rest in order', async () => {
    await seedSession([{ ...CHECKLIST }]);

    removeFixedRowItem('chk', 0);
    expect(getImportSession().fields[0]!.fixedRows).toEqual(['Park brake', 'Tyres']);
  });

  it('removing the last item normalizes fixedRows to undefined (never an empty array)', async () => {
    await seedSession([{ ...CHECKLIST, fixedRows: ['Only item'] }]);

    removeFixedRowItem('chk', 0);
    expect(getImportSession().fields[0]!.fixedRows).toBeUndefined();
  });
});

describe('confirmField — a plain "looks right" on a flagged field (R1/R3/AE1/AE3)', () => {
  it('marks a low-confidence repeating table resolved and reads it as ok, type unchanged', async () => {
    await seedSession([{ ...CHECKLIST, confidence: 0.4 }]);
    const before = getImportSession().fields[0]!;
    expect(reviewStatus(before)).toBe('low');

    confirmField('chk');

    const after = getImportSession().fields[0]!;
    expect(after.resolved).toBe(true);
    expect(reviewStatus(after)).toBe('ok');
    // Confirm is not a correction — the type is left exactly as extracted.
    expect(after.type).toBe('repeating_group');
  });

  it('drops the field out of the needs-review count', async () => {
    await seedSession([{ ...CHECKLIST, confidence: 0.4 }]);
    const needReview = () =>
      getImportSession().fields.filter((f) => reviewStatus(f) !== 'ok').length;
    expect(needReview()).toBe(1);

    confirmField('chk');

    expect(needReview()).toBe(0);
  });

  it('publishes the field identically — resolving is metadata-only (AE3)', async () => {
    await seedSession([{ ...CHECKLIST, confidence: 0.4 }]);
    const beforePublish = reviewedToFields(getImportSession().fields)[0]!;

    confirmField('chk');

    const afterPublish = reviewedToFields(getImportSession().fields)[0]!;
    expect(afterPublish).toEqual(beforePublish);
    expect('resolved' in afterPublish).toBe(false);
    expect('note' in afterPublish).toBe(false);
  });

  it('is idempotent — confirming an already-resolved field leaves it resolved', async () => {
    await seedSession([{ ...CHECKLIST, confidence: 0.4 }]);

    confirmField('chk');
    confirmField('chk');

    const field = getImportSession().fields[0]!;
    expect(field.resolved).toBe(true);
    expect(reviewStatus(field)).toBe('ok');
  });
});

describe('field-editor backing (U2) — extraction metadata survives edits', () => {
  it('keeps confidence and note when a reducer edit changes the field', async () => {
    await seedSession([{ ...CHECKLIST, confidence: 0.42, note: 'Low-confidence table' }]);

    setFieldRequired('chk', false);

    const field = getImportSession().fields[0]!;
    expect(field.confidence).toBe(0.42);
    expect(field.note).toBe('Low-confidence table');
    expect(field.required).toBe(false);
  });

  it('does NOT publish an extractor proposal the reviewer never accepted', () => {
    // R6: a proposal is never silently applied. A grouping changes the
    // completeness rule for every filler from "any cell filled" to "exactly
    // one option per set", so an AI guess nobody looked at must not make a
    // second answer unrecordable on a live compliance form.
    return seedSession([
      { ...CHECKLIST, answerSets: [{ key: 'verdict', columnKeys: ['ok', 'na'] }] },
    ]).then(() => {
      // Review still shows it, so the reviewer can see and accept it.
      expect(getImportSession().fields[0]!.answerSets).toEqual([
        { key: 'verdict', columnKeys: ['ok', 'na'] },
      ]);
      // Publish drops it.
      expect(reviewedToFields(getImportSession().fields)[0]!.answerSets).toBeUndefined();
    });
  });

  it('publishes a grouping once the reviewer accepts it', async () => {
    await seedSession([
      { ...CHECKLIST, answerSets: [{ key: 'verdict', columnKeys: ['ok', 'na'] }] },
    ]);

    acceptAnswerSet('chk', 'verdict');

    expect(reviewedToFields(getImportSession().fields)[0]!.answerSets).toEqual([
      { key: 'verdict', columnKeys: ['ok', 'na'] },
    ]);
  });

  it('resolves the checklist required default at seed time, matching what publish would produce', async () => {
    await seedSession([{ ...CHECKLIST }]);

    // The reviewer sees the same value that ships, rather than a blank that
    // silently becomes `true` at publish.
    expect(getImportSession().fields[0]!.required).toBe(true);
    expect(reviewedToFields(getImportSession().fields)[0]!.required).toBe(true);
  });

  it('drops metadata for a field that is no longer in the editor', async () => {
    await seedSession([{ ...CHECKLIST, note: 'Confirm this table' }]);

    expect(getImportSession().fields).toHaveLength(1);
    resetImportSession();
    expect(getImportSession().fields).toHaveLength(0);
  });

  it('leaves an untouched extraction publishing exactly what it extracted', async () => {
    const source: ExtractedField = { ...CHECKLIST };
    await seedSession([source]);

    const published = reviewedToFields(getImportSession().fields)[0]!;
    expect(published.id).toBe(source.id);
    expect(published.label).toBe(source.label);
    expect(published.type).toBe(source.type);
    expect(published.columns).toEqual(source.columns);
    expect(published.fixedRows).toEqual(source.fixedRows);
    expect(published.source).toBe('imported');
    // Extraction-only metadata never reaches the published field.
    expect('note' in published).toBe(false);
    expect('resolved' in published).toBe(false);
  });
});

describe('resetImportSession', () => {
  it('returns to idle with zero fields and no fixture data', async () => {
    postMock.mockResolvedValueOnce({ assetId: 'asset-123' });
    postMock.mockResolvedValueOnce(EXTRACTION);
    await startExtraction(makeFile());
    expect(getImportSession().status).toBe('ready');

    resetImportSession();

    const session = getImportSession();
    expect(session.status).toBe('idle');
    expect(session.fields).toEqual([]);
    expect(session.fileName).toBe('');
    expect(session.pageCount).toBe(0);
    expect(session.designNotes).toEqual([]);
    expect(session.assetId).toBeNull();
    expect(session.extraction).toBeNull();
    expect(session.error).toBeNull();
  });
});

describe('geometry review (U4, R8)', () => {
  const SEGMENT: PageBox = {
    page: 6,
    x: 37.5,
    y: 570,
    width: 520,
    height: 80,
    pageWidth: 595,
    pageHeight: 842,
    columnBands: [
      { key: 'tick', start: 496, end: 511.7 },
      { key: 'cross', start: 511.7, end: 531.9 },
      { key: 'na', start: 531.9, end: 556.7 },
    ],
    rowBands: [
      { key: 'r0', start: 620, end: 640 },
      { key: 'r1', start: 600, end: 620 },
    ],
  };

  function reviewField(): ReviewField {
    return {
      id: 'f1',
      label: 'Operational requirements',
      type: 'repeating_group',
      confidence: 0.9,
    };
  }

  it('does not publish a proposal the reviewer never confirmed', () => {
    // The heart of R8. Derivation refuses rather than guess, but a proposal it
    // IS willing to make can still be wrong in ways only a human on the page
    // catches — so unconfirmed geometry must not merely rank lower, it must
    // not exist downstream.
    proposeGeometry('f1', SEGMENT);

    expect(reviewedToFields([reviewField()])[0]?.geometry).toBeUndefined();
  });

  it('publishes geometry once confirmed', () => {
    proposeGeometry('f1', SEGMENT);
    confirmGeometry('f1');

    const published = reviewedToFields([reviewField()])[0];

    expect(published?.geometry?.segments).toHaveLength(1);
    expect(published?.geometry?.segments[0]?.page).toBe(6);
  });

  it('publishes geometry the shipped validator accepts', () => {
    proposeGeometry('f1', SEGMENT);
    confirmGeometry('f1');

    const published = reviewedToFields([reviewField()])[0]!;

    expect(resolveGeometry(published, 18).dropped).toEqual([]);
  });

  it('rejecting returns the field to no geometry', () => {
    proposeGeometry('f1', SEGMENT);
    confirmGeometry('f1');
    rejectGeometry('f1');

    expect(geometryProposal('f1')).toBeUndefined();
    expect(reviewedToFields([reviewField()])[0]?.geometry).toBeUndefined();
  });

  it('a fresh proposal does not inherit the previous confirmation', () => {
    proposeGeometry('f1', SEGMENT);
    confirmGeometry('f1');

    proposeGeometry('f1', { ...SEGMENT, page: 7 });

    expect(geometryConfirmed('f1')).toBe(false);
  });

  it('adjusting a band edge un-confirms the field', () => {
    proposeGeometry('f1', SEGMENT);
    confirmGeometry('f1');

    adjustGeometryBand('f1', 'column', 'na', 'end', 560);

    expect(geometryConfirmed('f1')).toBe(false);
    expect(geometryProposal('f1')?.columnBands?.find((b) => b.key === 'na')?.end).toBe(560);
  });

  it('grows the segment box to contain a band dragged past its edge', () => {
    // 560 sits beyond the box's right edge of 557.5. Bands outside the box are
    // rejected by the shared validator, so without growing the box the control
    // would silently do nothing — the edit is legitimate, the box was small.
    proposeGeometry('f1', SEGMENT);

    adjustGeometryBand('f1', 'column', 'na', 'end', 560);

    const grown = geometryProposal('f1')!;
    expect(grown.x + grown.width).toBeGreaterThanOrEqual(560);
    expect(resolveGeometry({ geometry: { segments: [grown] } }).dropped).toEqual([]);
  });

  it('never grows the box beyond the page', () => {
    proposeGeometry('f1', SEGMENT);

    adjustGeometryBand('f1', 'column', 'na', 'end', 900);

    // 900 exceeds the 595pt page, so the edit is refused outright rather than
    // producing a box that runs off the paper.
    expect(geometryProposal('f1')?.columnBands?.find((b) => b.key === 'na')?.end).toBe(556.7);
  });

  it('refuses an adjustment that would overlap a neighbouring band', () => {
    // Dragging an edge past its neighbour is the common mis-drag. Storing it
    // would make the whole grid vanish at publish with no reason shown.
    proposeGeometry('f1', SEGMENT);

    adjustGeometryBand('f1', 'column', 'tick', 'end', 540);

    expect(geometryProposal('f1')?.columnBands?.find((b) => b.key === 'tick')?.end).toBe(511.7);
  });

  it('refuses an inverted adjustment', () => {
    proposeGeometry('f1', SEGMENT);

    adjustGeometryBand('f1', 'column', 'cross', 'end', 400);

    expect(geometryProposal('f1')?.columnBands?.find((b) => b.key === 'cross')?.end).toBe(531.9);
  });

  it('adjusts a row band as well as a column band', () => {
    proposeGeometry('f1', SEGMENT);

    adjustGeometryBand('f1', 'row', 'r1', 'start', 595);

    expect(geometryProposal('f1')?.rowBands?.find((b) => b.key === 'r1')?.start).toBe(595);
  });

  it('moves both bands sharing an interior boundary, leaving no gap', () => {
    proposeGeometry('f1', SEGMENT);
    confirmGeometry('f1');

    adjustGeometryBoundary('f1', 'column', 'tick', 'cross', 505);

    // centresToBands makes bands contiguous. Moving one side alone tears a gap
    // a tick can land in and resolve to no column at all.
    const bands = geometryProposal('f1')!.columnBands!;
    expect(bands.find((b) => b.key === 'tick')!.end).toBe(505);
    expect(bands.find((b) => b.key === 'cross')!.start).toBe(505);
    expect(geometryConfirmed('f1')).toBe(false);
  });

  it('refuses a boundary drag past either neighbour rather than inverting a band', () => {
    proposeGeometry('f1', SEGMENT);
    const before = geometryProposal('f1')!;

    adjustGeometryBoundary('f1', 'column', 'tick', 'cross', 490); // left of tick.start
    adjustGeometryBoundary('f1', 'column', 'tick', 'cross', 540); // right of cross.end

    expect(geometryProposal('f1')).toEqual(before);
  });

  it('publishes a boundary-adjusted grid the shipped validator accepts', () => {
    proposeGeometry('f1', SEGMENT);
    adjustGeometryBoundary('f1', 'column', 'cross', 'na', 528);
    confirmGeometry('f1');

    const published = reviewedToFields([reviewField()])[0]!;
    expect(resolveGeometry(published, 18).dropped).toEqual([]);
  });

  it('ignores a boundary between bands that do not exist', () => {
    proposeGeometry('f1', SEGMENT);
    const before = geometryProposal('f1')!;

    adjustGeometryBoundary('f1', 'column', 'tick', 'nope', 505);

    expect(geometryProposal('f1')).toEqual(before);
  });

  it('confirming a field with no proposal does nothing', () => {
    confirmGeometry('nope');

    expect(geometryConfirmed('nope')).toBe(false);
  });

  it('resetImportSession clears proposals and confirmations', () => {
    proposeGeometry('f1', SEGMENT);
    confirmGeometry('f1');

    resetImportSession();

    expect(geometryProposal('f1')).toBeUndefined();
    expect(geometryConfirmed('f1')).toBe(false);
  });

  it('leaves a field with no proposal publishing exactly as before', () => {
    expect(reviewedToFields([reviewField()])[0]?.geometry).toBeUndefined();
  });
});

describe('columnGroups hint (U1 → review, U3 pre-fill)', () => {
  const HINTED: ExtractedField = {
    id: 'catA',
    label: "Category 'A' faults",
    type: 'repeating_group',
    confidence: 0.62,
    columns: [
      { key: 'item', label: 'Item', type: 'text' },
      { key: 'ok', label: 'OK', type: 'checkbox' },
      { key: 'na', label: 'NA', type: 'checkbox' },
    ],
    fixedRows: ['a', 'b', 'c', 'd', 'e', 'f'],
    columnGroups: 3,
  };

  it('surfaces the extraction hint on the review field so the split control can pre-fill', async () => {
    await seedSession([HINTED]);
    expect(getImportSession().fields[0]?.columnGroups).toBe(3);
  });

  it('never lets the hint cross the publish boundary', async () => {
    await seedSession([HINTED]);
    const published = reviewedToFields(getImportSession().fields)[0]!;
    expect('columnGroups' in published).toBe(false);
  });

  it('clears the hint on a fresh extraction', async () => {
    await seedSession([HINTED]);
    await seedSession([{ ...HINTED, columnGroups: undefined }]);
    expect(getImportSession().fields[0]?.columnGroups).toBeUndefined();
  });
});

describe('distributeGroups (U9/split reading modes)', () => {
  const six = [0, 1, 2, 3, 4, 5];

  it('down-columns deals contiguous blocks', () => {
    expect(distributeGroups(six, 3, 'down-columns')).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
    ]);
  });

  it('across-rows deals by stride', () => {
    expect(distributeGroups(six, 3, 'across-rows')).toEqual([
      [0, 3],
      [1, 4],
      [2, 5],
    ]);
  });

  it('down-columns puts an uneven remainder in the earlier groups, losing nothing', () => {
    const got = distributeGroups([0, 1, 2, 3, 4, 5, 6], 3, 'down-columns');
    expect(got).toEqual([
      [0, 1, 2],
      [3, 4],
      [5, 6],
    ]);
    expect(got.flat()).toHaveLength(7);
  });

  it('across-rows also loses nothing on an uneven count', () => {
    expect(distributeGroups([0, 1, 2, 3, 4, 5, 6], 3, 'across-rows').flat()).toHaveLength(7);
  });
});

describe('splitting a table into its printed groups (U9, R18)', () => {
  /**
   * ADMN-FRM-111's Category A block as the live extraction actually flattened
   * it on the smoke: 6 printed rows x 3 side-by-side groups, read COLUMN-MAJOR
   * (down the left column, then the middle, then the right). This is the order
   * U1 now pins in the extraction prompt, so the default `down-columns` split
   * reproduces the three printed columns without the reviewer touching a mode.
   */
  const CATEGORY_A: ExtractedField = {
    id: 'catA',
    label: "Category 'A' faults",
    type: 'repeating_group',
    confidence: 0.62,
    columns: [
      { key: 'item', label: 'Item', type: 'text' },
      { key: 'ok', label: 'OK', type: 'checkbox' },
      { key: 'na', label: 'NA', type: 'checkbox' },
    ],
    answerSets: [{ key: 'as1', columnKeys: ['ok', 'na'] }],
    fixedRows: [
      'Engine oil level',
      'Engine coolant level',
      'Power steering fluid level',
      'Steering',
      'Locking pins on Tray',
      'Collision Avoidance System',
      'Tyre Condition/Wheel nuts',
      'Park brake',
      'Foot brake',
      'Seat belts',
      '2-way radio',
      'Horn',
      'Brake & indicator lights',
      'Headlights',
      'Flashing light',
      'Flag (if required)',
      'Fire extinguisher',
      'Reverse Alarm',
    ],
  };

  /** The same block if a run instead read it row-major (across-then-down). */
  const CATEGORY_A_ROWMAJOR: ExtractedField = {
    ...CATEGORY_A,
    fixedRows: [
      'Engine oil level',
      'Tyre Condition/Wheel nuts',
      'Brake & indicator lights',
      'Engine coolant level',
      'Park brake',
      'Headlights',
      'Power steering fluid level',
      'Foot brake',
      'Flashing light',
      'Steering',
      'Seat belts',
      'Flag (if required)',
      'Locking pins on Tray',
      '2-way radio',
      'Fire extinguisher',
      'Collision Avoidance System',
      'Horn',
      'Reverse Alarm',
    ],
  };

  const LEFT_COLUMN = [
    'Engine oil level',
    'Engine coolant level',
    'Power steering fluid level',
    'Steering',
    'Locking pins on Tray',
    'Collision Avoidance System',
  ];
  const MIDDLE_COLUMN = [
    'Tyre Condition/Wheel nuts',
    'Park brake',
    'Foot brake',
    'Seat belts',
    '2-way radio',
    'Horn',
  ];
  const RIGHT_COLUMN = [
    'Brake & indicator lights',
    'Headlights',
    'Flashing light',
    'Flag (if required)',
    'Fire extinguisher',
    'Reverse Alarm',
  ];

  const tables = () => getImportSession().fields.filter((f) => f.type === 'repeating_group');

  it('turns one 18-item table into three tables of six', async () => {
    await seedSession([CATEGORY_A]);

    splitTableGroups('catA', 3);

    const after = tables();
    expect(after).toHaveLength(3);
    expect(after.map((f) => f.fixedRows?.length)).toEqual([6, 6, 6]);
  });

  it('down-columns (default) yields the printed columns for a column-major extraction', async () => {
    await seedSession([CATEGORY_A]);

    splitTableGroups('catA', 3);

    const [left, middle, right] = tables();
    expect(left?.fixedRows).toEqual(LEFT_COLUMN);
    expect(middle?.fixedRows).toEqual(MIDDLE_COLUMN);
    expect(right?.fixedRows).toEqual(RIGHT_COLUMN);
  });

  it('across-rows recovers the printed columns for a row-major extraction', async () => {
    await seedSession([CATEGORY_A_ROWMAJOR]);

    splitTableGroups('catA', 3, 'across-rows');

    const [left, middle, right] = tables();
    expect(left?.fixedRows).toEqual(LEFT_COLUMN);
    expect(middle?.fixedRows).toEqual(MIDDLE_COLUMN);
    expect(right?.fixedRows).toEqual(RIGHT_COLUMN);
  });

  it('down-columns on a row-major extraction scrambles — the reason the toggle exists', async () => {
    await seedSession([CATEGORY_A_ROWMAJOR]);

    splitTableGroups('catA', 3); // wrong mode for this order

    // Group 1 becomes the first two printed rows, not a printed column — which
    // is exactly the smoke defect the down-columns default fixes for a
    // column-major run and the toggle fixes for a row-major one.
    expect(tables()[0]?.fixedRows).not.toEqual(LEFT_COLUMN);
  });

  it('gives every group the source table columns and answer sets', async () => {
    await seedSession([CATEGORY_A]);

    splitTableGroups('catA', 3);

    for (const group of tables()) {
      expect(group.columns).toEqual(CATEGORY_A.columns);
      expect(group.answerSets).toEqual(CATEGORY_A.answerSets);
    }
  });

  it('carries an accepted grouping onto every group', async () => {
    await seedSession([CATEGORY_A]);
    acceptAnswerSet('catA', 'as1');

    splitTableGroups('catA', 3);

    // The groups carry the source's columns and the source's sets, making
    // exactly the claim the reviewer already judged — re-asking three times
    // would be noise rather than safety.
    for (const group of tables()) expect(answerSetAccepted(group.id, 'as1')).toBe(true);
  });

  it('does not carry an UNaccepted grouping', async () => {
    await seedSession([CATEGORY_A]);

    splitTableGroups('catA', 3);

    for (const group of tables()) expect(answerSetAccepted(group.id, 'as1')).toBe(false);
  });

  it('restores an accepted grouping and a confirmed grid on undo', async () => {
    await seedSession([CATEGORY_A]);
    acceptAnswerSet('catA', 'as1');
    proposeGeometry('catA', SPLIT_SEGMENT);
    confirmGeometry('catA');

    splitTableGroups('catA', 3);
    undoFieldEdit();

    // Acceptance and geometry live in id-keyed stores the editor's undo
    // snapshot never captures. Deleting the source's entries on split would
    // make undo restore the table with its answer set silently unaccepted —
    // publishing a table whose one-answer-per-row rule the reviewer had
    // explicitly approved, without it.
    expect(answerSetAccepted('catA', 'as1')).toBe(true);
    expect(geometryConfirmed('catA')).toBe(true);
    expect(reviewedToFields(getImportSession().fields)[0]?.geometry?.segments).toHaveLength(1);
  });

  it('loses no item when the count does not divide evenly (down-columns, remainder to earlier groups)', async () => {
    await seedSession([{ ...CATEGORY_A, fixedRows: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }]);

    splitTableGroups('catA', 3);

    const after = tables();
    expect(after.map((f) => f.fixedRows)).toEqual([
      ['a', 'b', 'c'],
      ['d', 'e'],
      ['f', 'g'],
    ]);
    expect(after.flatMap((f) => f.fixedRows ?? [])).toHaveLength(7);
  });

  it('loses no item under across-rows either (remainder to earlier groups)', async () => {
    await seedSession([{ ...CATEGORY_A, fixedRows: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }]);

    splitTableGroups('catA', 3, 'across-rows');

    const after = tables();
    expect(after.map((f) => f.fixedRows)).toEqual([
      ['a', 'd', 'g'],
      ['b', 'e'],
      ['c', 'f'],
    ]);
    expect(after.flatMap((f) => f.fixedRows ?? [])).toHaveLength(7);
  });

  it('treats a split into one group as a no-op', async () => {
    await seedSession([CATEGORY_A]);

    splitTableGroups('catA', 1);

    expect(tables()).toHaveLength(1);
    expect(tables()[0]?.id).toBe('catA');
  });

  it('refuses more groups than there are items rather than making an empty table', async () => {
    await seedSession([{ ...CATEGORY_A, fixedRows: ['a', 'b'] }]);

    splitTableGroups('catA', 3);

    expect(tables()).toHaveLength(1);
  });

  it('refuses a table with no captured items — there is nothing to distribute', async () => {
    await seedSession([{ ...CATEGORY_A, fixedRows: undefined }]);

    splitTableGroups('catA', 3);

    expect(tables()).toHaveLength(1);
  });

  it('undoes the whole split in one step', async () => {
    await seedSession([CATEGORY_A]);

    splitTableGroups('catA', 3);
    expect(tables()).toHaveLength(3);

    undoFieldEdit();

    expect(tables()).toHaveLength(1);
    expect(tables()[0]?.fixedRows).toEqual(CATEGORY_A.fixedRows);
  });

  it('leaves every group awaiting its own confirmation', async () => {
    await seedSession([{ ...CATEGORY_A, note: 'Confirm this table' }]);
    expect(getImportSession().fields[0]?.note).toBe('Confirm this table');

    splitTableGroups('catA', 3);

    // Fresh ids inherit no extraction metadata, which is the behaviour wanted:
    // a judgement made about the merged block is not a judgement about a group.
    for (const group of tables()) {
      expect(group.resolved).toBeUndefined();
      expect(group.note).toBeUndefined();
    }
  });

  it('drops the merged block position so groups do not export onto one spot', async () => {
    await seedSession([
      {
        ...CATEGORY_A,
        sourcePosition: {
          page: 0,
          x: 40,
          y: 180,
          width: 520,
          height: 130,
          pageWidth: 595.32,
          pageHeight: 419.52,
        },
      },
    ]);

    splitTableGroups('catA', 3);

    for (const published of reviewedToFields(getImportSession().fields)) {
      expect(published.sourcePosition).toBeUndefined();
    }
  });

  it('does not carry the source table geometry onto the groups (R8)', async () => {
    await seedSession([CATEGORY_A]);
    proposeGeometry('catA', SPLIT_SEGMENT);
    confirmGeometry('catA');

    splitTableGroups('catA', 3);

    // Geometry is positional: a grid confirmed over all 18 items describes none
    // of the three groups. Each group must be placed and confirmed on its own.
    for (const group of tables()) {
      expect(geometryProposal(group.id)).toBeUndefined();
      expect(geometryConfirmed(group.id)).toBe(false);
    }
    expect(reviewedToFields(getImportSession().fields).some((f) => f.geometry)).toBe(false);
  });

  describe('printed-group ordinal (U1, R2)', () => {
    it('stamps ordinals 0,1,2 on the three groups in printed order', async () => {
      await seedSession([CATEGORY_A]);

      splitTableGroups('catA', 3);

      // The ordinal is what lets grid derivation pick the correspondingly-placed
      // table instead of colliding on a structural tie.
      expect(tables().map((g) => g.groupOrdinal)).toEqual([
        { index: 0, count: 3 },
        { index: 1, count: 3 },
        { index: 2, count: 3 },
      ]);
    });

    it('surfaces on the review field but never crosses the publish boundary', async () => {
      await seedSession([CATEGORY_A]);

      splitTableGroups('catA', 3);

      expect(tables()[0]?.groupOrdinal).toEqual({ index: 0, count: 3 });
      // Review-only, exactly like columnGroups: the publish whitelist drops it.
      for (const published of reviewedToFields(getImportSession().fields)) {
        expect('groupOrdinal' in published).toBe(false);
      }
    });

    it('clears on a fresh extraction (lives in reviewMeta)', async () => {
      await seedSession([CATEGORY_A]);
      splitTableGroups('catA', 3);

      await seedSession([CATEGORY_A]);

      expect(getImportSession().fields.every((f) => f.groupOrdinal === undefined)).toBe(true);
    });
  });
});

describe('checkbox-group per-option geometry (publish boundary)', () => {
  const optionBox = (optionKey: string): PageBox => ({
    page: 0,
    x: optionKey === 'D' ? 200 : 260,
    y: 500,
    width: 14,
    height: 14,
    pageWidth: 600,
    pageHeight: 800,
  });

  const shift = (): ReviewField => ({
    id: 'shift',
    label: 'Shift',
    type: 'checkbox_group',
    confidence: 0.9,
    options: ['D', 'N'],
    selectionType: 'single',
  });

  it('publishes only the option boxes the reviewer confirmed, each stamped with its optionKey', () => {
    proposeGeometry(optionSlotId('shift', 'D'), optionBox('D'));
    confirmGeometry(optionSlotId('shift', 'D'));
    // N is drawn but NOT confirmed — it must not cross the publish boundary (R8).
    proposeGeometry(optionSlotId('shift', 'N'), optionBox('N'));

    const published = reviewedToFields([shift()])[0]!;

    expect(published.geometry?.segments).toHaveLength(1);
    expect(published.geometry?.segments[0]?.optionKey).toBe('D');
  });

  it('publishes a box per confirmed option once both are confirmed', () => {
    for (const opt of ['D', 'N']) {
      proposeGeometry(optionSlotId('shift', opt), optionBox(opt));
      confirmGeometry(optionSlotId('shift', opt));
    }

    const segments = reviewedToFields([shift()])[0]!.geometry?.segments ?? [];

    expect(segments.map((s) => s.optionKey).sort()).toEqual(['D', 'N']);
  });

  it('leaves the field data-only when no option box is confirmed', () => {
    proposeGeometry(optionSlotId('shift', 'D'), optionBox('D')); // drawn, not confirmed

    expect(reviewedToFields([shift()])[0]?.geometry).toBeUndefined();
  });

  it('option slots never collide with a plain field-level box', () => {
    // A scalar/table box is stored under the bare field id; an option under a
    // composite slot. The two must be independent stores.
    expect(optionSlotId('shift', 'D')).not.toBe('shift');
  });
});

describe('per-option geometry applies to radio and dropdown, not only checkbox_group', () => {
  const optBox = (): PageBox => ({
    page: 0,
    x: 200,
    y: 500,
    width: 14,
    height: 14,
    pageWidth: 600,
    pageHeight: 800,
  });

  const choice = (type: ReviewField['type']): ReviewField => ({
    id: 'shift',
    label: 'Shift',
    type,
    confidence: 0.9,
    options: ['Day', 'Night'],
  });

  for (const type of ['radio', 'dropdown'] as const) {
    it(`publishes a confirmed option box for a ${type}, stamped with its optionKey`, () => {
      proposeGeometry(optionSlotId('shift', 'Day'), optBox());
      confirmGeometry(optionSlotId('shift', 'Day'));

      const published = reviewedToFields([choice(type)])[0]!;

      expect(published.geometry?.segments).toHaveLength(1);
      expect(published.geometry?.segments[0]?.optionKey).toBe('Day');
    });
  }
});

describe('a printSelectedValue choice field publishes a single value box, not per-option', () => {
  const box = (): PageBox => ({
    page: 0,
    x: 200,
    y: 500,
    width: 120,
    height: 16,
    pageWidth: 600,
    pageHeight: 800,
  });

  const dropdown = (): ReviewField => ({
    id: 'shift',
    label: 'Shift',
    type: 'dropdown',
    confidence: 0.9,
    options: ['Day', 'Night'],
    printSelectedValue: true,
  });

  it('publishes the confirmed single box (no optionKey) and carries the flag', () => {
    // Drawn under the FIELD id, like a scalar — not an option slot.
    proposeGeometry('shift', box());
    confirmGeometry('shift');

    const published = reviewedToFields([dropdown()])[0]!;

    expect(published.printSelectedValue).toBe(true);
    expect(published.geometry?.segments).toHaveLength(1);
    expect(published.geometry?.segments[0]?.optionKey).toBeUndefined();
  });

  it('ignores any per-option boxes while in printSelectedValue mode', () => {
    // A stray option box from a previous mode must not leak into publish.
    proposeGeometry(optionSlotId('shift', 'Day'), box());
    confirmGeometry(optionSlotId('shift', 'Day'));

    expect(reviewedToFields([dropdown()])[0]?.geometry).toBeUndefined();
  });
});

/**
 * The document type selects which extraction profile the server applies, so it
 * has to survive the whole pipeline — including a retry, which must re-run the
 * same reading rather than silently falling back to generic.
 */
describe('document type', () => {
  it('sends the chosen type to the extractor', async () => {
    postMock.mockResolvedValueOnce({ assetId: 'asset-123' });
    postMock.mockResolvedValueOnce({ fields: [], designNotes: [] });

    await startExtraction(makeFile(), 'assessment');

    expect(postMock).toHaveBeenNthCalledWith(
      2,
      '/pdf/extract',
      expect.objectContaining({ documentType: 'assessment' }),
      { timeoutMs: IMPORT_REQUEST_TIMEOUT_MS },
    );
  });

  it('replays the same type on retry', async () => {
    postMock.mockResolvedValueOnce({ assetId: 'asset-123' });
    postMock.mockRejectedValueOnce(new Error('boom'));
    await startExtraction(makeFile(), 'assessment');

    postMock.mockResolvedValueOnce({ assetId: 'asset-456' });
    postMock.mockResolvedValueOnce({ fields: [], designNotes: [] });
    await retryExtraction();

    expect(postMock).toHaveBeenLastCalledWith(
      '/pdf/extract',
      expect.objectContaining({ documentType: 'assessment' }),
      { timeoutMs: IMPORT_REQUEST_TIMEOUT_MS },
    );
  });

  it('defaults to generic when no type is chosen', async () => {
    postMock.mockResolvedValueOnce({ assetId: 'asset-123' });
    postMock.mockResolvedValueOnce({ fields: [], designNotes: [] });

    await startExtraction(makeFile());

    expect(postMock).toHaveBeenNthCalledWith(
      2,
      '/pdf/extract',
      expect.objectContaining({ documentType: 'generic' }),
      { timeoutMs: IMPORT_REQUEST_TIMEOUT_MS },
    );
  });
});

/**
 * `allGeometryPlacements` — what the page overlay draws.
 *
 * Reported from a real mapping session: with only the selected field's box on
 * the page, every placement vanished as soon as the reviewer moved to the next
 * field, so there was no way to see which of a hundred-odd boxes were done
 * short of clicking every field in turn.
 */
describe('allGeometryPlacements', () => {
  const box = (page = 0): PageBox => ({
    page,
    x: 100,
    y: 200,
    width: 12,
    height: 12,
    pageWidth: 595,
    pageHeight: 842,
  });

  beforeEach(() => resetImportSession());

  it('is empty before anything is placed', () => {
    expect(allGeometryPlacements()).toEqual([]);
  });

  it('reports every slot, not just the last one touched', () => {
    proposeGeometry('ai_1', box());
    proposeGeometry('ai_2', box(3));

    expect(allGeometryPlacements().map((p) => p.slot).sort()).toEqual(['ai_1', 'ai_2']);
  });

  it('distinguishes confirmed placements from unconfirmed ones', () => {
    proposeGeometry('ai_1', box());
    proposeGeometry('ai_2', box());
    confirmGeometry('ai_1');

    const byslot = new Map(allGeometryPlacements().map((p) => [p.slot, p.confirmed]));
    // "Placed" and "checked by a human" are different states, and the overlay
    // draws them differently — so the distinction has to survive this call.
    expect(byslot.get('ai_1')).toBe(true);
    expect(byslot.get('ai_2')).toBe(false);
  });

  it('carries each box’s own page, so a placement draws where it belongs', () => {
    proposeGeometry('ai_1', box(7));

    expect(allGeometryPlacements()[0]!.box.page).toBe(7);
  });

  it('drops a placement that was discarded', () => {
    proposeGeometry('ai_1', box());
    confirmGeometry('ai_1');
    rejectGeometry('ai_1');

    expect(allGeometryPlacements()).toEqual([]);
  });
});

/**
 * Question-to-outcome links crossing the publish boundary.
 *
 * `reviewedToFields` is a WHITELIST — a property missing from it is dropped even
 * though review displayed it correctly — so a link that resolves perfectly and
 * then fails to publish is the likely failure here, not a bad pairing.
 *
 * Resolved over the REVIEWED list rather than carried from extraction, because
 * the reviewer reorders and deletes: a target resolved against the raw
 * extraction can outlive the cell it names.
 */
describe('reviewedToFields — outcome targets', () => {
  const q = (id: string, ref?: string): ReviewField => ({
    id,
    label: `Question ${id}`,
    type: 'radio',
    confidence: 1,
    options: ['True', 'False'],
    ...(ref ? { questionRef: ref } : {}),
  });

  const cell = (id: string, ref?: string): ReviewField => ({
    id,
    label: `${ref ?? id} Outcome`,
    type: 'check_cross',
    confidence: 1,
    ...(ref ? { questionRef: ref } : {}),
  });

  it('publishes the resolved outcomeTarget on the question', () => {
    const out = reviewedToFields([q('ai_29', 'Q1'), cell('ai_30', 'Q1')]);

    expect(out[0]!.outcomeTarget).toEqual({ fieldId: 'ai_30' });
  });

  it('never puts a target on the outcome cell itself', () => {
    const out = reviewedToFields([q('ai_29', 'Q1'), cell('ai_30', 'Q1')]);

    expect(out[1]!.outcomeTarget).toBeUndefined();
  });

  it('drops the link when the reviewer deleted the outcome cell', () => {
    // The reason this resolves at publish time. Against the raw extraction the
    // target would still name ai_30, and the exporter would write a verdict into
    // a field the document no longer has.
    const out = reviewedToFields([q('ai_29', 'Q1')]);

    expect(out[0]!.outcomeTarget).toBeUndefined();
  });

  it('follows the reviewer’s reordering rather than the extracted order', () => {
    // Two questions and two cells, interleaved differently from extraction.
    const out = reviewedToFields([
      q('ai_31', 'Q2'),
      cell('ai_32', 'Q2'),
      q('ai_29', 'Q1'),
      cell('ai_30', 'Q1'),
    ]);

    expect(out.find((f) => f.id === 'ai_31')!.outcomeTarget).toEqual({ fieldId: 'ai_32' });
    expect(out.find((f) => f.id === 'ai_29')!.outcomeTarget).toEqual({ fieldId: 'ai_30' });
  });

  it('publishes no target when extraction supplied no references', () => {
    const out = reviewedToFields([q('ai_29'), cell('ai_30')]);

    expect(out[0]!.outcomeTarget).toBeUndefined();
  });

  it('keeps the printed reference on a reviewed field, so there is something to pair', async () => {
    // The reference is not a `FormField` property and the editor holds
    // `FormField`s, so it has to travel as review metadata or it is gone the
    // moment an extraction is seeded. It was gone: every real import resolved
    // zero links while the hand-built fixtures above stayed green, because they
    // never went through the store.
    await seedSession([
      {
        id: 'ai_29',
        label: 'Q1 Ripping is a method of loosening rock',
        type: 'radio',
        confidence: 1,
        options: ['True', 'False'],
        questionRef: 'Q1',
      },
      { id: 'ai_30', label: 'Q1 Outcome', type: 'check_cross', confidence: 1, questionRef: 'Q1' },
    ]);

    const { fields } = getImportSession();
    expect(fields.map((f) => f.questionRef)).toEqual(['Q1', 'Q1']);
    expect(reviewedToFields(fields)[0]!.outcomeTarget).toEqual({ fieldId: 'ai_30' });
  });

  it('never publishes the printed reference itself, only the resolved target', () => {
    // The reference describes the source page, not the published field — the
    // link it resolved into is what downstream consumers act on.
    const out = reviewedToFields([q('ai_29', 'Q1'), cell('ai_30', 'Q1')]);

    expect(out.every((f) => !('questionRef' in f))).toBe(true);
  });
});

/*
  SAVING AND RESUMING A HALF-MAPPED IMPORT.

  Every correction and every placement lived in module variables, so a refresh
  threw away hours of work on an eighteen-page document. `captureImportSnapshot`
  and `restoreImportSnapshot` are the whole basis of both saving modes — the
  local autosave and the named server draft serialise exactly this, and differ
  only in where they put it. So what these pin is not "does it save" but "does
  the reviewer come back to the same document they left":

    · a placement that was UNCONFIRMED must not return confirmed (R8 — an
      unconfirmed grid must not cross the publish boundary, and a restore that
      silently promoted one would draw marks on a competency record against a
      grid nobody looked at)
    · an accepted answer set must not return unaccepted, and vice versa (R6)
    · restoring REPLACES; it never merges two sessions' placements
*/
describe('snapshot and restore', () => {
  async function readySession() {
    postMock.mockResolvedValueOnce({ assetId: 'asset-abc' });
    postMock.mockResolvedValueOnce(EXTRACTION);
    await startExtraction(makeFile());
  }

  const box = (x: number, page = 0): PageBox => ({
    page,
    x,
    y: 500,
    width: 14,
    height: 14,
    pageWidth: 600,
    pageHeight: 800,
  });

  it('has nothing to save before the extraction lands', () => {
    // A session mid-upload has no fields and no asset. Writing one would mean
    // later offering to "restore" a document the reviewer has never seen.
    expect(captureImportSnapshot()).toBeNull();
  });

  it('brings back the document, the corrections and the placements', async () => {
    await readySession();
    changeFieldType('f2', 'signature');
    confirmField('f2');
    proposeGeometry('f1', box(100));
    confirmGeometry('f1');

    const snapshot = captureImportSnapshot()!;
    expect(snapshot).not.toBeNull();

    resetImportSession();
    expect(getImportSession().fields).toEqual([]);
    expect(geometryProposal('f1')).toBeUndefined();

    expect(restoreImportSnapshot(snapshot)).toBe(true);

    const session = getImportSession();
    expect(session.status).toBe('ready');
    expect(session.fileName).toBe('site-safety-audit.pdf');
    expect(session.pageCount).toBe(3);
    expect(session.assetId).toBe('asset-abc');
    expect(session.designNotes).toEqual(EXTRACTION.designNotes);
    expect(session.fields.map((f) => f.id)).toEqual(['f1', 'f2']);
    // The correction, not the extraction's original guess.
    expect(session.fields.find((f) => f.id === 'f2')?.type).toBe('signature');
    expect(session.fields.find((f) => f.id === 'f2')?.resolved).toBe(true);
    expect(geometryProposal('f1')).toEqual(box(100));
    expect(geometryConfirmed('f1')).toBe(true);
  });

  it('does NOT return an unconfirmed placement as confirmed', async () => {
    /*
      The one that would be dangerous. A drawn-but-unconfirmed box is a proposal
      no human has checked against the printed page; only confirmed geometry
      crosses the publish boundary. A restore that promoted it would put marks
      on a competency record against a grid nobody ever looked at.
    */
    await readySession();
    proposeGeometry('f1', box(100));
    confirmGeometry('f1');
    proposeGeometry('f2', box(200)); // drawn only

    const snapshot = captureImportSnapshot()!;
    resetImportSession();
    restoreImportSnapshot(snapshot);

    expect(geometryConfirmed('f1')).toBe(true);
    expect(geometryProposal('f2')).toEqual(box(200));
    expect(geometryConfirmed('f2')).toBe(false);
  });

  it('keeps per-option placements apart', async () => {
    // Choice fields store one box per option under a composite slot. A restore
    // that flattened them would land every option's mark in one box.
    await readySession();
    proposeGeometry(optionSlotId('f1', 'D'), box(200));
    confirmGeometry(optionSlotId('f1', 'D'));
    proposeGeometry(optionSlotId('f1', 'N'), box(260));

    const snapshot = captureImportSnapshot()!;
    resetImportSession();
    restoreImportSnapshot(snapshot);

    expect(geometryProposal(optionSlotId('f1', 'D'))).toEqual(box(200));
    expect(geometryProposal(optionSlotId('f1', 'N'))).toEqual(box(260));
    expect(geometryConfirmed(optionSlotId('f1', 'D'))).toBe(true);
    expect(geometryConfirmed(optionSlotId('f1', 'N'))).toBe(false);
    expect(allGeometryPlacements()).toHaveLength(2);
  });

  it('replaces the live session rather than merging into it', async () => {
    // Merging would have to decide what happens when a restored placement and a
    // live one disagree about the same slot, and no answer to that is one a
    // reviewer could predict.
    await readySession();
    proposeGeometry('f1', box(100));
    const snapshot = captureImportSnapshot()!;

    proposeGeometry('f2', box(400));
    expect(allGeometryPlacements()).toHaveLength(2);

    restoreImportSnapshot(snapshot);

    expect(allGeometryPlacements().map((p) => p.slot)).toEqual(['f1']);
  });

  it('refuses a snapshot from a version it does not understand', async () => {
    // Discarded, never migrated: the document is still on the server and
    // re-extracting costs a minute, where guessing at a half-understood older
    // shape could restore geometry onto the wrong fields.
    await readySession();
    proposeGeometry('f1', box(100));
    const snapshot = { ...captureImportSnapshot()!, version: 99 };

    resetImportSession();
    expect(restoreImportSnapshot(snapshot)).toBe(false);
    expect(getImportSession().fields).toEqual([]);
  });

  it('comes back ready, not carrying the failure of a run that is over', async () => {
    await readySession();
    const snapshot = captureImportSnapshot()!;
    resetImportSession();

    // A failed run leaves the session in error; restoring must not preserve a
    // spinner or an alert belonging to a pipeline that is no longer running.
    postMock.mockRejectedValueOnce(new ApiError(500, 'server_error'));
    await startExtraction(makeFile());
    expect(getImportSession().status).toBe('error');

    restoreImportSnapshot(snapshot);

    expect(getImportSession().status).toBe('ready');
    expect(getImportSession().error).toBeNull();
  });
});

/*
  THE AUTOSAVE.

  Its whole job is that an interruption costs nothing, which makes the failure
  modes worth naming: a save path that a future mutation forgets to trigger, and
  a reset that wipes the very work the wizard is about to offer back. Both are
  pinned below.
*/
describe('local autosave', () => {
  let store: ImportDraftStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = memoryDraftStore();
    setImportDraftStore(store);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function readySession() {
    postMock.mockResolvedValueOnce({ assetId: 'asset-abc' });
    postMock.mockResolvedValueOnce(EXTRACTION);
    await startExtraction(makeFile());
  }

  const box = (x: number): PageBox => ({
    page: 0,
    x,
    y: 500,
    width: 14,
    height: 14,
    pageWidth: 600,
    pageHeight: 800,
  });

  it('writes after the reviewer stops, not on every change', async () => {
    // A band drag fires per pixel. Saving per change would push hundreds of
    // serialisations of a whole extraction through storage during one drag.
    await readySession();
    proposeGeometry('f1', box(100));

    expect(await store.load('asset:asset-abc')).toBeNull();

    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 10);

    const saved = await store.load('asset:asset-abc');
    expect(saved?.placements.map((p) => p.slot)).toEqual(['f1']);
  });

  it('saves after a geometry change AND after a field edit', async () => {
    /*
      The two mutation paths reach the store through different internals — one
      through `emit`, one through `dispatchEdit` — and a save hung off only one
      of them would lose the other's work silently. That is the exact failure
      this feature exists to prevent, so both are asserted rather than assumed.
    */
    await readySession();

    proposeGeometry('f1', box(100));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 10);
    expect((await store.load('asset:asset-abc'))?.placements).toHaveLength(1);

    changeFieldType('f2', 'signature');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 10);
    const saved = await store.load('asset:asset-abc');
    expect(saved?.fields.find((f) => f.id === 'f2')?.type).toBe('signature');
  });

  it('writes immediately when flushed, for a closing tab', async () => {
    await readySession();
    proposeGeometry('f1', box(100));

    flushImportAutosave();

    expect((await store.load('asset:asset-abc'))?.placements).toHaveLength(1);
  });

  it('survives a reset, because entering the wizard resets', async () => {
    /*
      Step 1 calls resetImportSession. If reset cleared storage, walking back
      into the import wizard would destroy the saved work at precisely the
      moment it is about to be offered back — the feature deleting its own
      reason for existing.
    */
    await readySession();
    proposeGeometry('f1', box(100));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 10);

    resetImportSession();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 10);

    expect(await loadSavedImport('asset-abc')).not.toBeNull();
  });

  it('drops the autosave once the work has a permanent home', async () => {
    await readySession();
    proposeGeometry('f1', box(100));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 10);

    await clearSavedImport('asset-abc');

    expect(await loadSavedImport('asset-abc')).toBeNull();
  });

  it('keeps one document’s work separate from another’s', async () => {
    // Keyed by asset, so starting a different upload cannot collide with, or
    // silently inherit, the placements of the one before it.
    await readySession();
    proposeGeometry('f1', box(100));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 10);

    expect(await loadSavedImport('asset-abc')).not.toBeNull();
    expect(await loadSavedImport('asset-other')).toBeNull();
  });

  it('offers nothing back when the extraction never landed', async () => {
    postMock.mockRejectedValueOnce(new ApiError(500, 'server_error'));
    await startExtraction(makeFile());
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 10);

    expect(await loadSavedImport('asset-abc')).toBeNull();
  });
});

/*
  REUSING A PLACEMENT ON A PART THAT PRINTS THE SAME THING.

  Parts 2, 4 and 6 of an assessment are one checklist printed three times, so
  placing each by hand means measuring the same rows and columns three times for
  no more accuracy than the first.

  `placement-clone.test.ts` pins WHEN a copy is allowed. These pin what the copy
  does to the store, and the one that matters most is that it lands
  UNCONFIRMED — the shape is reused, the human judgement is not.
*/
describe('copying a placement between fields', () => {
  const EXTRACTION_PAIR: ExtractionResult = {
    ...EXTRACTION,
    fields: [
      { id: 'p2', label: 'Part 2 checklist', type: 'checkbox_group', confidence: 0.9, options: ['yes', 'no'] },
      { id: 'p4', label: 'Part 4 checklist', type: 'checkbox_group', confidence: 0.9, options: ['yes', 'no'] },
      { id: 'other', label: 'Comments', type: 'text', confidence: 0.9 },
    ],
  };

  async function readyPair() {
    postMock.mockResolvedValueOnce({ assetId: 'asset-abc' });
    postMock.mockResolvedValueOnce(EXTRACTION_PAIR);
    await startExtraction(makeFile());
  }

  const box = (x: number, page = 2): PageBox => ({
    page,
    x,
    y: 500,
    width: 14,
    height: 14,
    pageWidth: 600,
    pageHeight: 800,
  });

  it('carries every option box across, onto the target page', async () => {
    await readyPair();
    proposeGeometry(optionSlotId('p2', 'yes'), box(200));
    proposeGeometry(optionSlotId('p2', 'no'), box(260));
    confirmGeometry(optionSlotId('p2', 'yes'));
    confirmGeometry(optionSlotId('p2', 'no'));

    const result = copyPlacementToField('p2', 'p4', 7);

    expect(result).toEqual({ ok: true, copied: 2 });
    expect(geometryProposal(optionSlotId('p4', 'yes'))?.x).toBe(200);
    expect(geometryProposal(optionSlotId('p4', 'no'))?.x).toBe(260);
    // The target's page, not the source's.
    expect(geometryProposal(optionSlotId('p4', 'yes'))?.page).toBe(7);
    expect(geometryProposal(optionSlotId('p2', 'yes'))?.page).toBe(2);
  });

  it('lands UNCONFIRMED even when the source was confirmed', async () => {
    /*
      The one that would be dangerous. Only confirmed geometry publishes, so a
      copy that inherited confirmation would put marks on a competency record
      against a grid nobody had looked at on THAT page — which is the whole
      thing the confirm step exists to prevent, defeated by the convenience
      feature.
    */
    await readyPair();
    proposeGeometry(optionSlotId('p2', 'yes'), box(200));
    confirmGeometry(optionSlotId('p2', 'yes'));

    copyPlacementToField('p2', 'p4', 7);

    expect(geometryConfirmed(optionSlotId('p2', 'yes'))).toBe(true);
    expect(geometryProposal(optionSlotId('p4', 'yes'))).toBeDefined();
    expect(geometryConfirmed(optionSlotId('p4', 'yes'))).toBe(false);
  });

  it('un-confirms a target that had already been confirmed', async () => {
    // Replacing a confirmed grid with a different one must not leave the old
    // confirmation attached to the new shape.
    await readyPair();
    proposeGeometry(optionSlotId('p2', 'yes'), box(200));
    proposeGeometry(optionSlotId('p4', 'yes'), box(999));
    confirmGeometry(optionSlotId('p4', 'yes'));

    copyPlacementToField('p2', 'p4', 7);

    expect(geometryProposal(optionSlotId('p4', 'yes'))?.x).toBe(200);
    expect(geometryConfirmed(optionSlotId('p4', 'yes'))).toBe(false);
  });

  it('refuses across fields that are not the same shape', async () => {
    await readyPair();
    proposeGeometry(optionSlotId('p2', 'yes'), box(200));

    const result = copyPlacementToField('p2', 'other', 7);

    expect(result.ok).toBe(false);
    expect(geometryProposal('other')).toBeUndefined();
  });

  it('refuses when the source has no placement to give', async () => {
    await readyPair();

    const result = copyPlacementToField('p2', 'p4', 7);

    expect(result).toEqual({ ok: false, reason: 'That field has no placement to copy yet.' });
  });

  it('offers only fields that have something placed', async () => {
    await readyPair();
    proposeGeometry(optionSlotId('p2', 'yes'), box(200));

    const sources = placementSourcesFor('p4');

    expect(sources.map((s) => s.field.id)).toEqual(['p2']);
    expect(sources[0]?.refusal).toBeNull();
  });

  it('names the mismatch rather than hiding an incompatible source', async () => {
    // "No sources available" on a page of visibly similar tables reads as a
    // broken feature; the reason is usually a real difference in the document.
    await readyPair();
    proposeGeometry('other', box(200));

    const sources = placementSourcesFor('p4');

    expect(sources.map((s) => s.field.id)).toEqual(['other']);
    expect(sources[0]?.refusal).toContain('different kinds');
  });

  it('is saved by the autosave like any other change', async () => {
    // The copy mutates the store directly rather than going through
    // proposeGeometry, so it has its own path to the save.
    vi.useFakeTimers();
    const store = memoryDraftStore();
    setImportDraftStore(store);
    try {
      await readyPair();
      proposeGeometry(optionSlotId('p2', 'yes'), box(200));
      copyPlacementToField('p2', 'p4', 7);

      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 10);

      const saved = await store.load('asset:asset-abc');
      expect(saved?.placements.map((p) => p.slot)).toContain(optionSlotId('p4', 'yes'));
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The correction diff (Phase D). captureImportCorrections reads the raw
 * extraction against the reviewer's edited fields; sendImportCorrections POSTs
 * it at publish, fire-and-forget.
 */
describe('captureImportCorrections / sendImportCorrections', () => {
  const AI_EXTRACTION: ExtractionResult = {
    sourceType: 'pdf_import',
    path: 'ai',
    fileName: 'dozer.pdf',
    pageCount: 18,
    captureId: 'cap-1',
    fields: [
      { id: 'ai_1', label: 'Q1', type: 'radio', confidence: 0.9, options: ['a', 'b'] },
      { id: 'ai_2', label: 'Site', type: 'text', confidence: 0.9 },
    ],
    designNotes: [],
  };

  /** Drive a session to `ready` seeded from the given extraction. */
  async function seedReady(extraction: ExtractionResult) {
    postMock.mockResolvedValueOnce({ assetId: 'asset-1' });
    postMock.mockResolvedValueOnce(extraction);
    await startExtraction(makeFile());
    expect(getImportSession().status).toBe('ready');
  }

  it('returns null before an extraction has landed', () => {
    expect(captureImportCorrections()).toBeNull();
  });

  it('carries the context and reports no corrections for an untouched review', async () => {
    await seedReady(AI_EXTRACTION);
    const corrections = captureImportCorrections();
    expect(corrections).toMatchObject({
      captureId: 'cap-1',
      documentType: 'generic',
      path: 'ai',
      pageCount: 18,
    });
    expect(corrections?.corrections).toEqual([]);
  });

  it('records a retype and a deletion the reviewer made', async () => {
    await seedReady(AI_EXTRACTION);
    changeFieldType('ai_1', 'textarea');
    deleteField('ai_2');

    const corrections = captureImportCorrections()!.corrections;
    expect(corrections).toContainEqual(
      expect.objectContaining({ fieldId: 'ai_1', kind: 'retype', from: 'radio', to: 'textarea' }),
    );
    expect(corrections).toContainEqual(
      expect.objectContaining({ fieldId: 'ai_2', kind: 'deleted', wasType: 'text' }),
    );
  });

  it('POSTs the diff to /pdf/corrections with the field count and refs', async () => {
    await seedReady(AI_EXTRACTION);
    deleteField('ai_2');
    postMock.mockClear();
    postMock.mockResolvedValueOnce({ id: 'corr-1' });

    sendImportCorrections({ assetId: 'asset-1', formId: 'form-9' });

    expect(postMock).toHaveBeenCalledTimes(1);
    const [path, body] = postMock.mock.calls[0]!;
    expect(path).toBe('/pdf/corrections');
    expect(body).toMatchObject({
      fieldCount: 2,
      assetId: 'asset-1',
      formId: 'form-9',
      corrections: expect.objectContaining({ captureId: 'cap-1', path: 'ai' }),
    });
  });

  it('swallows a POST rejection so a publish can never fail on it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seedReady(AI_EXTRACTION);
    postMock.mockClear();
    postMock.mockRejectedValueOnce(new Error('boom'));

    expect(() => sendImportCorrections({ assetId: 'asset-1' })).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });

  it('does not POST for an abandoned session (no committed publish, no signal)', async () => {
    await seedReady(AI_EXTRACTION);
    resetImportSession();
    postMock.mockClear();

    sendImportCorrections({ assetId: 'asset-1' });
    expect(postMock).not.toHaveBeenCalled();
  });
});
