/**
 * The front page, and the per-part boxes that live on attempt COLUMNS.
 *
 * `assessorName` and `signedAt` are columns on the attempt row, not entries in
 * `attempt.values`, so the printed "Name of Assessor" and date boxes exported
 * blank on every case ever produced. The certification block carries the
 * opposite risk: it must NOT print until a person has actually signed.
 *
 * The rule all of these serve: a field the manifest does not name writes
 * nothing. On a competency record silence is the safe failure — a confident
 * mark in the wrong box asserts that somebody was assessed as safe on something
 * nobody checked.
 */
import { describe, expect, it } from 'vitest';
import type { AssessmentToolManifest, FormField, PageBox } from '@formai/shared';
import { assembleCaseValues, CaseExportError, exportCasePdf, type CaseAttemptRecord } from './case-export.js';
import { makeTwoPageFlatPdf } from './test-pdfs.js';

const header = (id: string): FormField => ({
  id,
  type: 'section_header',
  label: id,
  required: false,
  source: 'imported',
});

const BASE: AssessmentToolManifest = {
  parts: [
    { key: 'p1', ordinal: 1, label: 'Theory', kind: 'theory', pathways: ['experienced', 'new'], startFieldId: 'h1' },
    { key: 'p2', ordinal: 2, label: 'Prac 1', kind: 'practical', pathways: ['experienced', 'new'], startFieldId: 'h2' },
    { key: 'p3', ordinal: 3, label: 'Prac 2', kind: 'practical', pathways: ['new'], startFieldId: 'h3' },
  ],
};

/** BASE plus every front-page pointer, so absence can be tested against it. */
const WITH_MARKS: AssessmentToolManifest = {
  ...BASE,
  parts: BASE.parts.map((p) =>
    p.key === 'p2' ? { ...p, assessorNameFieldId: 'p2-assessor', signedDateFieldId: 'p2-date' } : p,
  ),
  signOff: {
    assessorNameFieldId: 'sign-name',
    assessorSignatureFieldId: 'sign-sig',
    signedDateFieldId: 'sign-date',
    overallSatisfactory: { fieldId: 'overall-yes', value: true },
    moreCoachingRequiredYes: { fieldId: 'coach-yes', value: true },
    moreCoachingRequiredNo: { fieldId: 'coach-no', value: true },
  },
};

const SIG = 'data:image/png;base64,iVBORw0KGgo=';
const SIGNED = { at: new Date(2026, 6, 31), name: 'A. Assessor', signature: SIG };

const passed = (partKey: string, over: Partial<CaseAttemptRecord> = {}): CaseAttemptRecord => ({
  partKey,
  attemptNumber: 1,
  outcome: 'satisfactory',
  values: {},
  ...over,
});

const bothParts = [passed('p1'), passed('p2', { assessorName: 'M. Marker', signedAt: new Date(2026, 6, 30) })];

describe('assembleCaseValues — per-part name and date', () => {
  it('writes them from the attempt columns', () => {
    const { values } = assembleCaseValues({
      manifest: WITH_MARKS,
      pathway: 'experienced',
      attempts: bothParts,
    });

    expect(values['p2-assessor']).toBe('M. Marker');
    expect(values['p2-date']).toBe('30/07/2026');
  });

  it('writes no name when the attempt recorded none', () => {
    // '' against a real date would say a nameless person marked it. Blank says
    // nobody recorded it, which is true.
    const { values } = assembleCaseValues({
      manifest: WITH_MARKS,
      pathway: 'experienced',
      attempts: [passed('p1'), passed('p2', { assessorName: '', signedAt: new Date(2026, 6, 30) })],
    });

    expect(values['p2-assessor']).toBeUndefined();
  });
});

describe('assembleCaseValues — the certification block', () => {
  it('prints nothing of it until someone has signed', () => {
    // A mid-programme export must look exactly as it does today.
    const { values } = assembleCaseValues({
      manifest: WITH_MARKS,
      pathway: 'experienced',
      attempts: bothParts,
    });

    for (const id of ['sign-name', 'sign-sig', 'sign-date', 'overall-yes']) {
      expect(values[id]).toBeUndefined();
    }
  });

  it('writes the name, signature and its own date once signed', () => {
    const { values } = assembleCaseValues({
      manifest: WITH_MARKS,
      pathway: 'experienced',
      attempts: bothParts,
      signOff: SIGNED,
      resolved: true,
    });

    expect(values['sign-name']).toBe('A. Assessor');
    expect(values['sign-sig']).toBe(SIG);
    expect(values['sign-date']).toBe('31/07/2026');
    expect(values['overall-yes']).toBe(true);
  });

  it('writes nothing at all when the manifest names no front page', () => {
    // The degradation rule. A tool declaring none of this exports its cover
    // page exactly as it does today.
    const { values } = assembleCaseValues({
      manifest: BASE,
      pathway: 'experienced',
      attempts: bothParts,
      signOff: SIGNED,
      resolved: true,
    });

    for (const id of ['sign-name', 'sign-sig', 'coach-no', 'overall-yes', 'p2-assessor']) {
      expect(values[id]).toBeUndefined();
    }
  });
});

describe('assembleCaseValues — the coaching pair', () => {
  it('ticks the No box, not the Yes box, on a competent case', () => {
    const { values } = assembleCaseValues({
      manifest: WITH_MARKS,
      pathway: 'experienced',
      attempts: bothParts,
      signOff: SIGNED,
      resolved: true,
    });

    expect(values['coach-no']).toBe(true);
    expect(values['coach-yes']).toBeUndefined();
  });

  it('ticks the Yes box on a resolved case with a part still unsatisfactory', () => {
    // The only way Yes is reachable: sign-off demands every part passed, so a
    // signed case always answers No.
    const { values } = assembleCaseValues({
      manifest: WITH_MARKS,
      pathway: 'experienced',
      attempts: [passed('p1'), { ...passed('p2'), outcome: 'not_satisfactory' }],
      resolved: true,
    });

    expect(values['coach-yes']).toBe(true);
    expect(values['coach-no']).toBeUndefined();
  });

  it('answers No when a part failed once and passed on the retry', () => {
    const { values } = assembleCaseValues({
      manifest: WITH_MARKS,
      pathway: 'experienced',
      attempts: [
        passed('p1'),
        { ...passed('p2'), attemptNumber: 1, outcome: 'not_satisfactory' },
        { ...passed('p2'), attemptNumber: 2 },
      ],
      resolved: true,
    });

    expect(values['coach-no']).toBe(true);
    expect(values['coach-yes']).toBeUndefined();
  });

  it('ticks NEITHER box while the case is still open', () => {
    const { values } = assembleCaseValues({
      manifest: WITH_MARKS,
      pathway: 'experienced',
      attempts: [passed('p1')],
    });

    expect(values['coach-yes']).toBeUndefined();
    expect(values['coach-no']).toBeUndefined();
  });
});

describe('assembleCaseValues — the method checklist', () => {
  it('ticks only for a part that actually rendered', () => {
    const withChecklist: AssessmentToolManifest = {
      ...WITH_MARKS,
      parts: WITH_MARKS.parts.map((p) =>
        p.key === 'p1'
          ? { ...p, checklistMark: { fieldId: 'method-written', value: true } }
          : p.key === 'p2'
            ? { ...p, checklistMark: { fieldId: 'method-observed', value: true } }
            : p,
      ),
    };

    const { values } = assembleCaseValues({
      manifest: withChecklist,
      pathway: 'experienced',
      attempts: [passed('p1'), { ...passed('p2'), outcome: 'not_satisfactory' }],
    });

    expect(values['method-written']).toBe(true);
    // p2 never passed, so that method was never demonstrated.
    expect(values['method-observed']).toBeUndefined();
  });

  it('addresses one table cell without disturbing the rest', () => {
    const withCell: AssessmentToolManifest = {
      ...WITH_MARKS,
      parts: WITH_MARKS.parts.map((p) =>
        p.key === 'p1'
          ? { ...p, checklistMark: { fieldId: 'methods', rowKey: 'r1', columnKey: 'used', value: true } }
          : p,
      ),
    };

    const { values } = assembleCaseValues({
      manifest: withCell,
      pathway: 'experienced',
      attempts: [
        passed('p1', {
          values: { methods: [{ _key: 'r1', name: 'Written' }, { _key: 'r2', name: 'Observed' }] },
        }),
        passed('p2'),
      ],
    });

    const table = values['methods'] as { _key: string; name?: string; used?: unknown }[];
    expect(table.find((r) => r._key === 'r1')?.used).toBe(true);
    expect(table.find((r) => r._key === 'r1')?.name).toBe('Written');
    expect(table.find((r) => r._key === 'r2')?.used).toBeUndefined();
  });

  it('refuses a cell value that is not a primitive rather than stamping an object', () => {
    const bad: AssessmentToolManifest = {
      ...WITH_MARKS,
      parts: WITH_MARKS.parts.map((p) =>
        p.key === 'p1'
          ? { ...p, checklistMark: { fieldId: 'methods', rowKey: 'r1', columnKey: 'used', value: ['a', 'b'] } }
          : p,
      ),
    };

    const { values } = assembleCaseValues({
      manifest: bad,
      pathway: 'experienced',
      attempts: [passed('p1'), passed('p2')],
    });

    // Blank, never "[object Object]" in a cell of a competency record.
    expect(values['methods']).toBeUndefined();
  });
});

describe('exportCasePdf — a signed case cannot have a blank required part', () => {
  const box = (page: number): PageBox => ({
    page,
    x: 40,
    y: 60,
    width: 120,
    height: 16,
    pageWidth: 600,
    pageHeight: 800,
  });

  const drawable: FormField[] = [
    { ...header('h1'), type: 'text', geometry: { segments: [box(0)] } },
    { ...header('h2'), type: 'text', geometry: { segments: [box(1)] } },
    { ...header('h3'), type: 'text', geometry: { segments: [box(1)] } },
  ];

  it('refuses, rather than signing over an empty part', async () => {
    /*
      Sign-off refuses unless every required part passed, so reaching this state
      means the manifest or the pathway moved underneath an already-certified
      case. The alternative to refusing is an assessor's signature printed over
      a document whose required parts are empty.
    */
    await expect(
      exportCasePdf({
        originalPdf: await makeTwoPageFlatPdf(),
        fields: drawable,
        manifest: BASE,
        pathway: 'new',
        attempts: [passed('p1')],
        signOff: SIGNED,
        resolved: true,
      }),
    ).rejects.toThrow(CaseExportError);
  });

  it('still exports an unsigned case with blank parts, as it always did', async () => {
    // A mid-programme export is legitimate and common; only the signed
    // contradiction is refused.
    const out = await exportCasePdf({
      originalPdf: await makeTwoPageFlatPdf(),
      fields: drawable,
      manifest: BASE,
      pathway: 'new',
      attempts: [passed('p1')],
    });

    expect(out.byteLength).toBeGreaterThan(0);
  });
});

/**
 * Who the certificate is FOR.
 *
 * The cover page's identity boxes belong to no part — `fieldsInPart` slices
 * from part 1's anchor onward, so they fall outside every part's range and the
 * fill route never serves them. Nobody can type into them, and nothing else
 * wrote them, so the exported document carried the assessor's name, the date
 * and the verdict for NOBODY. An auditor holding it could not tell who had been
 * assessed.
 */
describe('assembleCaseValues — the candidate', () => {
  const NAMED: AssessmentToolManifest = { ...BASE, candidateNameFieldId: 'cover-name' };

  it('seeds the candidate name onto the cover page', () => {
    const { values } = assembleCaseValues({
      manifest: NAMED,
      pathway: 'experienced',
      attempts: [passed('p1'), passed('p2')],
      candidateName: 'Dale Rivers',
    });

    expect(values['cover-name']).toBe('Dale Rivers');
  });

  it('writes nothing when the manifest does not name the box', () => {
    // Same degradation as every other pointer: unnamed means blank, never a
    // guess at which field the name belongs in.
    const { values } = assembleCaseValues({
      manifest: BASE,
      pathway: 'experienced',
      attempts: [passed('p1'), passed('p2')],
      candidateName: 'Dale Rivers',
    });

    expect(values['cover-name']).toBeUndefined();
  });

  it('leaves the box blank rather than printing an empty string', () => {
    // The user row can be gone. A blank box is a visible gap; a box containing
    // '' looks like a name that was recorded as nothing.
    const { values } = assembleCaseValues({
      manifest: NAMED,
      pathway: 'experienced',
      attempts: [passed('p1'), passed('p2')],
      candidateName: '',
    });

    expect(values['cover-name']).toBeUndefined();
  });

  it('names the candidate even on a case nobody has signed', () => {
    // Identity is not part of the certification block — a mid-programme export
    // still has to say who it is about.
    const { values } = assembleCaseValues({
      manifest: NAMED,
      pathway: 'experienced',
      attempts: [passed('p1')],
      candidateName: 'Dale Rivers',
    });

    expect(values['cover-name']).toBe('Dale Rivers');
  });
});
