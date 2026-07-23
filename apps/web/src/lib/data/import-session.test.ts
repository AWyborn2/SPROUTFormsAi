/**
 * Import session extraction lifecycle — startExtraction drives
 * POST /pdf/upload → POST /pdf/extract with status transitions
 * idle → uploading → extracting → ready | error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import {
  acceptAnswerSet,
  addFixedRowItem,
  answerSetAccepted,
  adjustGeometryBand,
  adjustGeometryBoundary,
  confirmField,
  distributeGroups,
  confirmGeometry,
  fileToBase64,
  reviewStatus,
  geometryConfirmed,
  geometryProposal,
  getImportSession,
  lowestUnresolvedField,
  proposeGeometry,
  rejectGeometry,
  removeFixedRowItem,
  renameFixedRowItem,
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

    expect(postMock).toHaveBeenNthCalledWith(1, '/pdf/upload', { pdfBase64: 'JVBERi0=' });
    expect(postMock).toHaveBeenNthCalledWith(2, '/pdf/extract', {
      assetId: 'asset-123',
      fileName: 'site-safety-audit.pdf',
    });
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
    expect(getImportSession().error).toBe(
      'This PDF is too large to import — the limit is 25 MB.',
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
    expect(postMock).toHaveBeenLastCalledWith('/pdf/extract', {
      assetId: 'asset-456',
      fileName: 'site-safety-audit.pdf',
    });
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
    return { id: 'f1', label: 'Operational requirements', type: 'repeating_group', confidence: 0.9 };
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
    expect(distributeGroups(six, 3, 'down-columns')).toEqual([[0, 1], [2, 3], [4, 5]]);
  });

  it('across-rows deals by stride', () => {
    expect(distributeGroups(six, 3, 'across-rows')).toEqual([[0, 3], [1, 4], [2, 5]]);
  });

  it('down-columns puts an uneven remainder in the earlier groups, losing nothing', () => {
    const got = distributeGroups([0, 1, 2, 3, 4, 5, 6], 3, 'down-columns');
    expect(got).toEqual([[0, 1, 2], [3, 4], [5, 6]]);
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
      'Engine oil level', 'Engine coolant level', 'Power steering fluid level',
      'Steering', 'Locking pins on Tray', 'Collision Avoidance System',
      'Tyre Condition/Wheel nuts', 'Park brake', 'Foot brake',
      'Seat belts', '2-way radio', 'Horn',
      'Brake & indicator lights', 'Headlights', 'Flashing light',
      'Flag (if required)', 'Fire extinguisher', 'Reverse Alarm',
    ],
  };

  /** The same block if a run instead read it row-major (across-then-down). */
  const CATEGORY_A_ROWMAJOR: ExtractedField = {
    ...CATEGORY_A,
    fixedRows: [
      'Engine oil level', 'Tyre Condition/Wheel nuts', 'Brake & indicator lights',
      'Engine coolant level', 'Park brake', 'Headlights',
      'Power steering fluid level', 'Foot brake', 'Flashing light',
      'Steering', 'Seat belts', 'Flag (if required)',
      'Locking pins on Tray', '2-way radio', 'Fire extinguisher',
      'Collision Avoidance System', 'Horn', 'Reverse Alarm',
    ],
  };

  const LEFT_COLUMN = [
    'Engine oil level', 'Engine coolant level', 'Power steering fluid level',
    'Steering', 'Locking pins on Tray', 'Collision Avoidance System',
  ];
  const MIDDLE_COLUMN = [
    'Tyre Condition/Wheel nuts', 'Park brake', 'Foot brake',
    'Seat belts', '2-way radio', 'Horn',
  ];
  const RIGHT_COLUMN = [
    'Brake & indicator lights', 'Headlights', 'Flashing light',
    'Flag (if required)', 'Fire extinguisher', 'Reverse Alarm',
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
    expect(after.map((f) => f.fixedRows)).toEqual([['a', 'b', 'c'], ['d', 'e'], ['f', 'g']]);
    expect(after.flatMap((f) => f.fixedRows ?? [])).toHaveLength(7);
  });

  it('loses no item under across-rows either (remainder to earlier groups)', async () => {
    await seedSession([{ ...CATEGORY_A, fixedRows: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }]);

    splitTableGroups('catA', 3, 'across-rows');

    const after = tables();
    expect(after.map((f) => f.fixedRows)).toEqual([['a', 'd', 'g'], ['b', 'e'], ['c', 'f']]);
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
          page: 0, x: 40, y: 180, width: 520, height: 130,
          pageWidth: 595.32, pageHeight: 419.52,
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
