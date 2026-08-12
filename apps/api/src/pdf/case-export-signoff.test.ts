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
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { AssessmentToolManifest, FormField, PageBox } from '@formai/shared';
import {
  assembleCaseValues,
  CaseExportError,
  exportCasePdf,
  withDerivedMarks,
  type CaseAttemptRecord,
} from './case-export.js';
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
    overallNotSatisfactory: { fieldId: 'overall-no', value: true },
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

/**
 * The Assessment Result pair — and the asymmetry between its halves.
 *
 * `overallSatisfactory` is the CERTIFICATION and waits for a signature: a
 * competency claim on a record nobody signed is the one thing this export must
 * never manufacture. "Not yet competent" certifies nothing — it is the absence
 * of a claim — and a failed case very often ends with no sign-off at all, so
 * gating it the same way would leave the box permanently blank on exactly the
 * records that need it.
 */
describe('assembleCaseValues — Candidate not yet Competent', () => {
  const failed = (partKey: string): CaseAttemptRecord => ({
    partKey,
    attemptNumber: 1,
    outcome: 'not_satisfactory',
    values: {},
  });

  it('TICKS IT ON A RESOLVED CASE THAT NOBODY SIGNED', () => {
    const { values } = assembleCaseValues({
      manifest: WITH_MARKS,
      pathway: 'experienced',
      attempts: [passed('p1'), failed('p2')],
      resolved: true,
    });

    expect(values['overall-no']).toBe(true);
    expect(values['overall-yes']).toBeUndefined();
  });

  it('LEAVES IT BLANK ON A CASE STILL IN PROGRESS', () => {
    // An unfinished form is not a finding of "not yet competent" any more than
    // it is a finding of "no coaching required".
    const { values } = assembleCaseValues({
      manifest: WITH_MARKS,
      pathway: 'experienced',
      attempts: [passed('p1')],
    });

    expect(values['overall-no']).toBeUndefined();
  });

  it('does not tick it on a competent case', () => {
    const { values } = assembleCaseValues({
      manifest: WITH_MARKS,
      pathway: 'experienced',
      attempts: bothParts,
      signOff: SIGNED,
      resolved: true,
    });

    expect(values['overall-no']).toBeUndefined();
    expect(values['overall-yes']).toBe(true);
  });

  it('writes nothing when the manifest does not name the box', () => {
    const { values } = assembleCaseValues({
      manifest: BASE,
      pathway: 'experienced',
      attempts: [passed('p1'), failed('p2')],
      resolved: true,
    });

    expect(values['overall-no']).toBeUndefined();
  });
});

/**
 * The completion checklist ticks itself — on an OPEN case as much as a
 * resolved one, because a mid-programme export is exactly where "what has
 * this candidate finished so far" gets asked. Positional rows: a tick must
 * sit at its own printed index, never slide up through a gap.
 */
describe('assembleCaseValues — part completion ticks', () => {
  const TICKING: AssessmentToolManifest = {
    ...BASE,
    partCompletionMarks: [
      { partKey: 'p1', fieldId: 'methods', rowIndex: 0, columnKey: 'used' },
      { partKey: 'p2', fieldId: 'methods', rowIndex: 1, columnKey: 'used' },
      { partKey: 'p3', fieldId: 'methods', rowIndex: 2, columnKey: 'used' },
    ],
  };

  it('ticks exactly the satisfied parts, at their own row indexes', () => {
    const { values } = assembleCaseValues({
      manifest: TICKING,
      pathway: 'new',
      attempts: [passed('p1'), { partKey: 'p2', attemptNumber: 1, outcome: 'not_satisfactory', values: {} }],
    });

    // p1 done, p2 failed, p3 untouched: one tick, in row 0 only. The failed
    // and unstarted rows stay empty objects — never false, which would print
    // a finding nobody made.
    expect(values['methods']).toEqual([{ used: true }]);
  });

  it('keeps ticks at their printed positions when an earlier part is not done', () => {
    const { values } = assembleCaseValues({
      manifest: TICKING,
      pathway: 'new',
      attempts: [passed('p2')],
    });

    // p2 satisfied while p1 is untouched — its tick sits at index 1 behind an
    // empty row, so the exporter's positional bands mark the right method.
    expect(values['methods']).toEqual([{}, { used: true }]);
  });

  it('writes nothing when no mapped part is satisfied', () => {
    const { values } = assembleCaseValues({
      manifest: TICKING,
      pathway: 'new',
      attempts: [],
    });

    expect(values['methods']).toBeUndefined();
  });
});

/**
 * The maps the ROUTE resolves — identity prefill and prerequisite verdicts —
 * and the seam that used to drop them. `exportCasePdf` re-listed every
 * assemble field by hand and the list drifted: both maps were computed on
 * every export and never reached the page.
 */
describe('assembleCaseValues — identity prefill and prerequisite verdicts', () => {
  it('merges both maps over the attempts', () => {
    const { values } = assembleCaseValues({
      manifest: BASE,
      pathway: 'experienced',
      attempts: [passed('p1'), passed('p2')],
      prefillValues: { 'cover-company': 'Charles Hull Contracting', 'cover-swipe': 'SC-0431' },
      prerequisiteValues: { 'prereq-licence': true, 'prereq-lapsed': false },
    });

    expect(values['cover-company']).toBe('Charles Hull Contracting');
    expect(values['cover-swipe']).toBe('SC-0431');
    // Both verdicts are recorded findings: ✓ held, ✗ lapsed. Only absent is
    // silent.
    expect(values['prereq-licence']).toBe(true);
    expect(values['prereq-lapsed']).toBe(false);
  });

  it('prefill wins over whatever an attempt stored for the same box', () => {
    // The cover belongs to no part, so nothing legitimate writes it — a stray
    // attempt value there is exactly what the case-sourced identity corrects.
    const { values } = assembleCaseValues({
      manifest: BASE,
      pathway: 'experienced',
      attempts: [passed('p1', { values: { 'cover-company': 'typed over' } })],
      prefillValues: { 'cover-company': 'Charles Hull Contracting' },
    });

    expect(values['cover-company']).toBe('Charles Hull Contracting');
  });
});

describe('exportCasePdf — the resolved maps survive the seam', () => {
  const seamBox = (page: number, y: number): PageBox => ({
    page,
    x: 40,
    y,
    width: 160,
    height: 16,
    pageWidth: 600,
    pageHeight: 800,
  });

  it('draws the prefilled identity onto the rendered page', async () => {
    const fields: FormField[] = [
      { ...header('h1'), type: 'text', geometry: { segments: [seamBox(0, 700)] } },
      { ...header('h2'), type: 'text', geometry: { segments: [seamBox(0, 660)] } },
      { ...header('h3'), type: 'text', geometry: { segments: [seamBox(0, 620)] } },
      {
        id: 'cover-company',
        type: 'text',
        label: "Candidate's Company Name",
        required: false,
        source: 'imported',
        geometry: { segments: [seamBox(0, 580)] },
      },
    ];

    const out = await exportCasePdf({
      originalPdf: await makeTwoPageFlatPdf(),
      fields,
      manifest: BASE,
      pathway: 'experienced',
      attempts: [passed('p1'), passed('p2')],
      prefillValues: { 'cover-company': 'Charles Hull Contracting' },
    });

    // The output's content streams are Flate-compressed; inflate each and
    // grep the drawn glyphs — presence here is what the dropped seam lost.
    const raw = Buffer.from(out);
    const hay = raw.toString('latin1');
    let drawn = '';
    const streamRe = /stream\r?\n/g;
    let m: RegExpExecArray | null;
    while ((m = streamRe.exec(hay)) !== null) {
      const start = m.index + m[0].length;
      const end = hay.indexOf('endstream', start);
      if (end < 0) continue;
      try {
        drawn += inflateSync(raw.subarray(start, end)).toString('latin1');
      } catch {
        drawn += hay.slice(start, end);
      }
    }
    // pdf-lib writes text operands as hex strings; decode them before looking.
    const decoded = drawn.replace(/<([0-9A-Fa-f]+)>/g, (_s, hex: string) =>
      Buffer.from(hex, 'hex').toString('latin1'),
    );
    expect(decoded).toContain('Charles Hull Contracting');
  });
});

/**
 * Marks an attempt never stored still print.
 *
 * The marking writes each question's ✓/✗ (and the part's verdict pair) into
 * the attempt's values at marking time — but only since it existed. An attempt
 * marked before then, or before the manifest declared its verdict boxes,
 * stores the answers alone and the printed outcome column exports blank.
 */
describe('withDerivedMarks', () => {
  const question = (id: string): FormField => ({
    id,
    type: 'checkbox_group',
    label: id,
    required: false,
    source: 'imported',
    options: ['a', 'b'],
    answerKey: ['a'],
    outcomeTarget: { fieldId: `${id}-out` },
  });
  const cell = (id: string): FormField => ({
    id,
    type: 'check_cross',
    label: id,
    required: false,
    source: 'imported',
  });

  const versionFields: FormField[] = [
    header('h1'),
    question('q1'),
    cell('q1-out'),
    question('q2'),
    cell('q2-out'),
    header('h2'),
    { ...cell('prac'), label: 'Manoeuvres safely' },
    header('h3'),
  ];

  const VERDICT: AssessmentToolManifest = {
    ...BASE,
    parts: BASE.parts.map((p) =>
      p.key === 'p1'
        ? {
            ...p,
            outcomeSatisfactory: { fieldId: 'p1-verdict-yes', value: true },
            outcomeNotSatisfactory: { fieldId: 'p1-verdict-no', value: true },
          }
        : p,
    ),
  };

  it('fills the ✓/✗ an old attempt never stored, from its own answers', () => {
    const healed = withDerivedMarks(
      passed('p1', { values: { q1: ['a'], q2: ['b'] } }),
      versionFields,
      BASE,
    );

    expect(healed.values['q1-out']).toBe(true);
    expect(healed.values['q2-out']).toBe(false);
    // The answers themselves are untouched.
    expect(healed.values['q1']).toEqual(['a']);
  });

  it('writes the verdict pair the manifest has since declared', () => {
    const healed = withDerivedMarks(
      passed('p1', { values: { q1: ['a'], q2: ['a'] } }),
      versionFields,
      VERDICT,
    );

    expect(healed.values['p1-verdict-yes']).toBe(true);
    expect(healed.values['p1-verdict-no']).toBeUndefined();
  });

  it('never overwrites a mark the attempt already stored', () => {
    // Stored wins even where re-derivation disagrees: the record stands.
    const healed = withDerivedMarks(
      passed('p1', { values: { q1: ['a'], q2: ['b'], 'q2-out': true } }),
      versionFields,
      BASE,
    );

    expect(healed.values['q2-out']).toBe(true);
  });

  it('leaves a judged part alone — its marks belong to the person', () => {
    const attempt = passed('p2', { values: { prac: true } });

    expect(withDerivedMarks(attempt, versionFields, BASE)).toBe(attempt);
  });

  it('leaves a failed attempt alone — it never prints', () => {
    const attempt: CaseAttemptRecord = {
      partKey: 'p1',
      attemptNumber: 1,
      outcome: 'not_satisfactory',
      values: { q1: ['b'] },
    };

    expect(withDerivedMarks(attempt, versionFields, BASE)).toBe(attempt);
  });
});
