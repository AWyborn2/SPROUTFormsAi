/**
 * Which attempt speaks for a part is the whole job of this module, so both
 * directions are pinned: a part that failed then passed exports the PASSING
 * values, and a part that only ever failed exports NOTHING rather than its
 * failed answers. Getting that backwards would put a candidate's failed
 * demonstration on the document that certifies them.
 *
 * Covers AE3 (retry overwrites on the page, not in the trail) and AE5 (excluded
 * content still prints, unmarked).
 */
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import type { AssessmentToolManifest, FormField, PageBox } from '@formai/shared';
import { assembleCaseValues, CaseExportError, exportCasePdf, type CaseAttemptRecord } from './case-export.js';
import { makeTwoPageFlatPdf } from './test-pdfs.js';

const header = (id: string, visibleWhen?: FormField['visibleWhen']): FormField => ({
  id,
  type: 'section_header',
  label: id,
  required: false,
  source: 'imported',
  ...(visibleWhen ? { visibleWhen } : {}),
});

const MANIFEST: AssessmentToolManifest = {
  locationStreamFieldId: 'stream',
  parts: [
    { key: 'p1', ordinal: 1, label: 'Theory', kind: 'theory', pathways: ['experienced', 'new'], startFieldId: 'h1' },
    { key: 'p2', ordinal: 2, label: 'Prac 1', kind: 'practical', pathways: ['experienced', 'new'], startFieldId: 'h2' },
    {
      key: 'p3',
      ordinal: 3,
      label: 'Log',
      kind: 'logbook',
      pathways: ['new'],
      startFieldId: 'h3',
      minimumHours: 20,
      durationColumnKey: 'duration',
    },
    { key: 'p4', ordinal: 4, label: 'Prac 2', kind: 'practical', pathways: ['new'], startFieldId: 'h4' },
  ],
};

const logTable: FormField = {
  id: 'log-table',
  type: 'repeating_group',
  label: 'Log',
  required: false,
  source: 'imported',
  columns: [
    { key: 'task', label: 'Task', type: 'text' },
    { key: 'duration', label: 'Duration', type: 'number' },
  ],
};

/*
  `stream` is here because MANIFEST names it as locationStreamFieldId and the
  field did not exist. The fixture had always been invalid; nothing checked.
  validateManifest now validates that pointer like every other one, which is
  what surfaced it — exactly the latent break the retrofit was for.
*/
const streamField: FormField = {
  id: 'stream',
  type: 'radio',
  label: 'Location stream',
  required: false,
  source: 'imported',
  options: ['mining', 'raw-materials'],
};

const FIELDS: FormField[] = [
  header('h1'),
  header('h2'),
  header('h3'),
  logTable,
  header('h4'),
  streamField,
];

const attempt = (
  partKey: string,
  attemptNumber: number,
  outcome: CaseAttemptRecord['outcome'],
  values: CaseAttemptRecord['values'],
): CaseAttemptRecord => ({ partKey, attemptNumber, outcome, values });

describe('assembleCaseValues', () => {
  it('exports the passing attempt when a part failed and was retried', () => {
    const out = assembleCaseValues({
      manifest: MANIFEST,
      pathway: 'new',
      attempts: [
        attempt('p1', 1, 'satisfactory', { a: 'yes' }),
        attempt('p2', 1, 'satisfactory', { b: 'yes' }),
        attempt('p3', 1, 'satisfactory', { c: 'yes' }),
        attempt('p4', 1, 'not_satisfactory', { d: 'FAILED VALUE' }),
        attempt('p4', 2, 'satisfactory', { d: 'PASSED VALUE' }),
      ],
    });

    expect(out.values.d).toBe('PASSED VALUE');
    expect(out.rendered).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(out.blank).toEqual([]);
  });

  it('exports nothing for a part whose attempts all failed', () => {
    const out = assembleCaseValues({
      manifest: MANIFEST,
      pathway: 'new',
      attempts: [
        attempt('p1', 1, 'satisfactory', { a: 'yes' }),
        attempt('p4', 1, 'not_satisfactory', { d: 'FAILED VALUE' }),
        attempt('p4', 2, 'not_satisfactory', { d: 'FAILED AGAIN' }),
      ],
    });

    expect(out.values.d).toBeUndefined();
    expect(out.blank).toContain('p4');
    expect(out.rendered).toEqual(['p1']);
  });

  it('ignores an attempt that is still open', () => {
    const out = assembleCaseValues({
      manifest: MANIFEST,
      pathway: 'new',
      attempts: [attempt('p1', 1, null, { a: 'IN PROGRESS' })],
    });

    expect(out.values.a).toBeUndefined();
    expect(out.blank).toContain('p1');
  });

  it('leaves the parts an experienced pathway excludes blank', () => {
    const out = assembleCaseValues({
      manifest: MANIFEST,
      pathway: 'experienced',
      attempts: [
        attempt('p1', 1, 'satisfactory', { a: 'yes' }),
        attempt('p2', 1, 'satisfactory', { b: 'yes' }),
        // Present on the case but outside the pathway — must not be consulted.
        attempt('p4', 1, 'satisfactory', { d: 'SHOULD NOT APPEAR' }),
      ],
    });

    expect(out.rendered).toEqual(['p1', 'p2']);
    expect(out.values.d).toBeUndefined();
  });

  it('seeds the location stream from the case, overriding a stale answer', () => {
    const out = assembleCaseValues({
      manifest: MANIFEST,
      pathway: 'experienced',
      locationStream: 'raw_materials',
      attempts: [
        attempt('p1', 1, 'satisfactory', { stream: 'mining' }),
        attempt('p2', 1, 'satisfactory', {}),
      ],
    });

    expect(out.values.stream).toBe('raw_materials');
  });

  it('leaves the stream untouched when the tool declares no stream field', () => {
    const out = assembleCaseValues({
      manifest: { parts: MANIFEST.parts },
      pathway: 'experienced',
      locationStream: 'mining',
      attempts: [attempt('p1', 1, 'satisfactory', {}), attempt('p2', 1, 'satisfactory', {})],
    });

    expect(out.values.stream).toBeUndefined();
  });

  it('raises rather than exporting when an attempt names a part the manifest lacks', () => {
    expect(() =>
      assembleCaseValues({
        manifest: MANIFEST,
        pathway: 'new',
        attempts: [attempt('p9', 1, 'satisfactory', { x: 1 })],
      }),
    ).toThrow(CaseExportError);
  });

  it('keeps logbook rows intact for the renderer to paginate', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ duration: 1, task: `entry ${i}` }));
    const out = assembleCaseValues({
      manifest: MANIFEST,
      pathway: 'new',
      attempts: [attempt('p3', 1, 'satisfactory', { entries: rows })],
    });

    expect(out.values.entries).toHaveLength(40);
  });

  describe('multi-stage logbook row routing', () => {
    const routed = (): AssessmentToolManifest => ({
      ...MANIFEST,
      parts: MANIFEST.parts.map((p) =>
        p.key === 'p3'
          ? {
              ...p,
              logbookRouting: {
                sourceFieldId: 'log-table',
                columnKey: 'task',
                routes: [
                  { value: 'Topsoil', fieldId: 'tgt-topsoil' },
                  { value: 'Gravel', fieldId: 'tgt-gravel' },
                  { value: 'Stockpile', fieldId: 'tgt-stockpile' },
                ],
              },
            }
          : p,
      ),
    });
    const rows = [
      { __key: 'r1', task: 'Topsoil', duration: 4 },
      { __key: 'r2', task: 'Gravel', duration: 6 },
      { __key: 'r3', task: 'Topsoil', duration: 2 },
    ];

    it('partitions the one filled table into each task’s printed table', () => {
      const out = assembleCaseValues({
        manifest: routed(),
        pathway: 'new',
        attempts: [
          attempt('p1', 1, 'satisfactory', { a: 'yes' }),
          attempt('p2', 1, 'satisfactory', { b: 'yes' }),
          attempt('p3', 1, 'satisfactory', { 'log-table': rows }),
          attempt('p4', 1, 'satisfactory', { d: 'yes' }),
        ],
      });

      expect(out.values['tgt-topsoil']).toEqual([rows[0], rows[2]]);
      expect(out.values['tgt-gravel']).toEqual([rows[1]]);
      // A routed task with no matching rows gets an empty list, never left holding
      // a stale value from a prior export.
      expect(out.values['tgt-stockpile']).toEqual([]);
      // The source table keeps the whole log — the candidate's record is intact.
      expect(out.values['log-table']).toEqual(rows);
    });

    it('does nothing when the source part did not render (no attempt)', () => {
      const out = assembleCaseValues({
        manifest: routed(),
        pathway: 'new',
        attempts: [attempt('p1', 1, 'satisfactory', { a: 'yes' })],
      });

      // No source rows to route, so no target field is invented.
      expect(out.values['tgt-topsoil']).toBeUndefined();
    });
  });
});

describe('exportCasePdf', () => {
  const box = (page: number): PageBox => ({
    page,
    x: 40,
    y: 700,
    width: 200,
    height: 14,
    pageWidth: 612,
    pageHeight: 792,
  });

  /** Fields with real geometry so the renderer actually draws. */
  const drawable: FormField[] = [
    header('h1'),
    { id: 'a', type: 'text', label: 'A', required: false, source: 'imported', geometry: { segments: [box(0)] } },
    header('h2'),
    { id: 'b', type: 'text', label: 'B', required: false, source: 'imported', geometry: { segments: [box(1)] } },
    header('h3'),
    logTable,
    header('h4'),
    // Named by MANIFEST.locationStreamFieldId, which is now validated like
    // every other pointer. See the note on `streamField` above.
    streamField,
  ];

  it('preserves the source document’s page count', async () => {
    const original = await makeTwoPageFlatPdf();

    const out = await exportCasePdf({
      originalPdf: original,
      fields: drawable,
      manifest: MANIFEST,
      pathway: 'experienced',
      attempts: [attempt('p1', 1, 'satisfactory', { a: 'ANSWER A' }), attempt('p2', 1, 'satisfactory', { b: 'ANSWER B' })],
    });

    const before = await PDFDocument.load(original);
    const after = await PDFDocument.load(out);
    expect(after.getPageCount()).toBe(before.getPageCount());
    expect(after.getPageCount()).toBe(2);
  });

  it('raises when the manifest does not match the version being exported', async () => {
    const original = await makeTwoPageFlatPdf();

    await expect(
      exportCasePdf({
        originalPdf: original,
        fields: [header('h1')], // h2/h3/h4 missing from this version
        manifest: MANIFEST,
        pathway: 'new',
        attempts: [],
      }),
    ).rejects.toThrow(CaseExportError);
  });

  it('reports every manifest problem rather than only the first', async () => {
    const original = await makeTwoPageFlatPdf();

    try {
      await exportCasePdf({
        originalPdf: original,
        fields: [header('h1')],
        manifest: MANIFEST,
        pathway: 'new',
        attempts: [],
      });
      throw new Error('should have raised');
    } catch (err) {
      expect(err).toBeInstanceOf(CaseExportError);
      expect((err as CaseExportError).problems.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('produces a document for a case with no passing attempts at all', async () => {
    const original = await makeTwoPageFlatPdf();

    const out = await exportCasePdf({
      originalPdf: original,
      fields: drawable,
      manifest: MANIFEST,
      pathway: 'experienced',
      attempts: [attempt('p1', 1, 'not_satisfactory', { a: 'FAILED' })],
    });

    // Still a valid, complete document — just an unmarked one. A blank booklet
    // is the honest representation of an assessment nobody has passed yet.
    const after = await PDFDocument.load(out);
    expect(after.getPageCount()).toBe(2);
  });
});
