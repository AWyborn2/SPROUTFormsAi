/**
 * Publishing a built assessment tool.
 *
 * This is what replaces `author-track-dozer-tool.mjs`, and the tests are mostly
 * about the two things it does differently:
 *
 *   · outcome links come from the PRINTED REFERENCE both fields carry, not from
 *     document order — the script's own comment concedes that guess;
 *   · everything is validated BEFORE anything is written, because a tool that
 *     fails validation after its version published leaves a live form with no
 *     tool attached, which is worse than either end of the operation.
 */
import { describe, expect, it } from 'vitest';
import type { AssessmentToolManifest, DraftAnswerKey, FormField } from '@formai/shared';
import { checkPublish, publishSummary, resolvePublishFields } from './builder-publish.js';

function field(over: Partial<FormField> & { id: string }): FormField {
  return { label: over.id, type: 'text', required: false, source: 'imported', ...over };
}

function question(id: string, ref?: string): FormField {
  return field({ id, type: 'radio', options: ['a', 'b'], ...(ref ? { questionRef: ref } : {}) });
}

function outcome(id: string, ref?: string): FormField {
  return field({ id, type: 'check_cross', ...(ref ? { questionRef: ref } : {}) });
}

const KEY = (fieldId: string, answerKey = ['a']): DraftAnswerKey => ({
  fieldId,
  answerKey,
  source: 'manual',
});

function manifestWith(over: Partial<AssessmentToolManifest['parts'][number]> = {}): AssessmentToolManifest {
  return {
    parts: [
      {
        key: 'p1',
        ordinal: 1,
        label: 'Part 1',
        kind: 'theory',
        pathways: ['new'],
        startFieldId: 'q1',
        ...over,
      },
    ],
  };
}

describe('resolvePublishFields', () => {
  it('links a question to its outcome box BY THE PRINTED REFERENCE', () => {
    /*
      Not by adjacency. The authoring script infers the pairing from document
      order and its own comment concedes the guess; order is only right by
      accident on a document whose outcome cells are not printed in the same run
      as their questions. `questionRef` is what the extraction reads off the
      page — and only reaches a field at all because of the normalizeField fix.
    */
    const { fields } = resolvePublishFields(
      [question('q1', 'BBM Q3'), outcome('o1', 'BBM Q3')],
      [KEY('q1')],
    );

    expect(fields[0]!.answerKey).toEqual(['a']);
    expect(fields[0]!.outcomeTarget).toEqual({ fieldId: 'o1' });
  });

  it('leaves a key off a question with nowhere to write its mark', () => {
    // validateAnswerKeys rejects a key with no outcome target, and it is right
    // to: a mark that computes and never reaches the page reads on an evidence
    // document as a question nobody answered.
    const { fields, unlinked } = resolvePublishFields([question('q1')], [KEY('q1')]);

    expect(fields[0]!.answerKey).toBeUndefined();
    expect(unlinked).toEqual(['q1']);
  });

  it('does not overwrite an outcome target that was authored explicitly', () => {
    const { fields } = resolvePublishFields(
      [
        { ...question('q1', 'Q1'), outcomeTarget: { fieldId: 'chosen' } },
        outcome('o1', 'Q1'),
      ],
      [KEY('q1')],
    );
    expect(fields[0]!.outcomeTarget).toEqual({ fieldId: 'chosen' });
  });

  it('leaves an unkeyed question alone entirely', () => {
    const source = [question('q1', 'Q1'), outcome('o1', 'Q1')];
    const { fields } = resolvePublishFields(source, []);
    expect(fields[0]).toBe(source[0]);
  });

  it('ignores an empty key rather than writing one', () => {
    // markTheory treats absent and empty identically; writing an empty key
    // would make validateAnswerKeys reject a question nobody keyed.
    const { fields } = resolvePublishFields(
      [question('q1', 'Q1'), outcome('o1', 'Q1')],
      [KEY('q1', [])],
    );
    expect(fields[0]!.answerKey).toBeUndefined();
  });
});

describe('checkPublish', () => {
  const LINKED = [question('q1', 'Q1'), outcome('o1', 'Q1')];

  it('passes a tool whose parts, keys and links all resolve', () => {
    const check = checkPublish(LINKED, [KEY('q1')], manifestWith({ mandatoryFieldIds: ['q1'] }));
    expect(check.problems).toEqual([]);
  });

  it('refuses a tool with no parts, and says where parts come from', () => {
    const check = checkPublish(LINKED, [KEY('q1')], null);
    expect(check.problems[0]).toContain('declares no parts');
    expect(check.problems[0]).toContain('Units & gating');
  });

  it('names a keyed question with no outcome box, by its LABEL', () => {
    // A field id means nothing to the person who has to fix it.
    const check = checkPublish(
      [field({ id: 'q1', type: 'radio', options: ['a'], label: 'What is the minimum clearance?' })],
      [KEY('q1')],
      manifestWith(),
    );
    expect(check.problems.some((p) => p.includes('What is the minimum clearance?'))).toBe(true);
    expect(check.unlinked).toEqual(['q1']);
  });

  it('surfaces the SHARED validators’ own problems', () => {
    /*
      The same validateManifest and validateAnswerKeys the server runs, so the
      builder cannot pass a tool the API will refuse, nor refuse one it would
      accept. A mandatory question with no answer key is the validator's own
      message, not a reworded copy.
    */
    const check = checkPublish(LINKED, [], manifestWith({ mandatoryFieldIds: ['q1'] }));
    expect(check.problems.some((p) => p.includes('no answer key'))).toBe(true);
  });

  it('returns EVERY problem, not the first', () => {
    // An author who fixes one and is handed the next has to re-run the gate
    // once per mistake — which is what the script's all-or-nothing refusal
    // feels like from the outside.
    const check = checkPublish(
      [question('q1'), question('q2')],
      [KEY('q1'), KEY('q2')],
      manifestWith({ pathways: [] }),
    );
    expect(check.problems.length).toBeGreaterThan(1);
  });

  it('hands back the RESOLVED fields, so the caller writes what was validated', () => {
    // Validating one field list and saving another is how a gate passes and the
    // stored record still fails.
    const check = checkPublish(LINKED, [KEY('q1')], manifestWith());
    expect(check.fields[0]!.answerKey).toEqual(['a']);
    expect(check.fields[0]!.outcomeTarget).toEqual({ fieldId: 'o1' });
  });
});

describe('publishSummary', () => {
  it('counts parts, keys, verifications and placed boxes', () => {
    const summary = publishSummary(
      [
        {
          ...question('q1'),
          geometry: {
            segments: [
              { page: 0, x: 1, y: 1, width: 1, height: 1, pageWidth: 595, pageHeight: 842 },
              { page: 1, x: 1, y: 1, width: 1, height: 1, pageWidth: 595, pageHeight: 842 },
            ],
          },
        },
      ],
      [KEY('q1'), { ...KEY('q2'), verifiedBy: 'Ash', verifiedAt: '2026-08-05T00:00:00Z' }],
      manifestWith(),
    );

    expect(summary).toEqual({
      parts: 1,
      questionsKeyed: 2,
      questionsVerified: 1,
      boxesPlaced: 2,
    });
  });

  it('reports verified separately from keyed', () => {
    // An unverified key still marks — the distinction is the attestation, not
    // the behaviour — so collapsing them would hide work nobody has checked.
    const summary = publishSummary([], [KEY('q1')], null);
    expect(summary.questionsKeyed).toBe(1);
    expect(summary.questionsVerified).toBe(0);
  });
});

/**
 * THE STRUCTURE EDITOR DID NOT REACH THE PUBLISHED FORM.
 *
 * Step 2 is the only place in the product where somebody sees the whole shape
 * of the form and moves it — and publish wrote the draft's flat field list,
 * which is extraction order. Every reorder was visible in the preview beside
 * the editor and absent from the thing a candidate filled in.
 */
describe('checkPublish — the author’s arrangement is the published order', () => {
  const f = (id: string): FormField => ({
    id,
    type: 'text',
    label: id,
    required: false,
    source: 'imported',
  });

  const FLAT = [f('a'), f('b'), f('c')];

  const section = (key: string, ids: string[]) => ({
    key,
    label: key,
    cols: 1 as const,
    fields: ids.map((id) => ({ id })),
  });

  const manifestWith = () => ({
    parts: [
      {
        key: 's2',
        ordinal: 1,
        label: 's2',
        kind: 'theory' as const,
        pathways: ['new' as const],
        startFieldId: 'c',
      },
    ],
  });

  it('PUBLISHES IN THE ARRANGED ORDER, NOT EXTRACTION ORDER', () => {
    // Sections reversed and a field moved: c, then b and a.
    const structure = [section('s2', ['c']), section('s1', ['b', 'a'])];

    const check = checkPublish(FLAT, [], manifestWith(), structure);

    expect(check.fields.map((x) => x.id)).toEqual(['s2_header', 'c', 's1_header', 'b', 'a']);
  });

  it('keeps the flat list when no arrangement is supplied', () => {
    // Every existing caller and test.
    const check = checkPublish(FLAT, [], manifestWith());

    expect(check.fields.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('REFUSES A FIELD THE ARRANGEMENT NEVER PLACED, rather than dropping it', () => {
    /*
      Publishing the arrangement silently deletes anything in no section. Step 2
      already warns those "would not be published"; this is the half that makes
      the warning true without making it destructive — a field that vanishes is
      one nobody will fill in and nobody will notice is missing.
    */
    const structure = [section('s2', ['c'])];

    const check = checkPublish(FLAT, [], manifestWith(), structure);

    expect(check.problems.some((p) => p.includes('sits in no section'))).toBe(true);
    expect(check.problems.filter((p) => p.includes('sits in no section'))).toHaveLength(2);
  });
});

/**
 * THE PRINTED-REFERENCE ROUTE CANNOT FIRE IN THIS BUILDER.
 *
 * `linkOutcomeTargets` pairs a question with its ✓/✗ box by the `questionRef`
 * both carry — and that lives on the EXTRACTED field. `FormField` has no such
 * property and `seedFields` does not copy it, so every question is skipped and
 * the automatic route resolved nothing at all. A thirty-question paper failed
 * publish thirty times over, and the only way through was thirty hand-picks
 * from a list of thirty near-identical box names.
 */
describe('resolvePublishFields — the outcome box a question’s mark lands in', () => {
  const q = (id: string, over: Partial<FormField> = {}): FormField => ({
    id,
    type: 'radio',
    label: id,
    required: false,
    source: 'imported',
    options: ['a', 'b'],
    ...over,
  });
  const cell = (id: string): FormField => ({
    id,
    type: 'check_cross',
    label: id,
    required: false,
    source: 'imported',
  });
  const keyed = (fieldId: string): DraftAnswerKey => ({
    fieldId,
    answerKey: ['a'],
    source: 'manual',
  });

  it('FALLS BACK TO THE BOX PRINTED IMMEDIATELY AFTER THE QUESTION', () => {
    const { fields, inferred, unlinked } = resolvePublishFields(
      [q('q1'), cell('q1-out'), q('q2'), cell('q2-out')],
      [keyed('q1'), keyed('q2')],
    );

    expect(fields[0]!.outcomeTarget).toEqual({ fieldId: 'q1-out' });
    expect(fields[2]!.outcomeTarget).toEqual({ fieldId: 'q2-out' });
    expect(inferred).toEqual(['q1', 'q2']);
    expect(unlinked).toEqual([]);
  });

  it('REPORTS THE INFERENCE RATHER THAN MAKING IT SILENTLY', () => {
    /*
      Adjacency shifts. One question whose box the extraction missed re-pairs
      every question after it, and the result still looks like a complete
      mapping — so the count is what gives an author something to spot-check.
    */
    const { inferred } = resolvePublishFields([q('q1'), cell('q1-out')], [keyed('q1')]);

    expect(inferred).toEqual(['q1']);
  });

  it('AN EXPLICIT CHOICE STILL WINS OUTRIGHT', () => {
    // The picker exists because adjacency is wrong on some papers. A fallback
    // that overrode a person's decision would make the picker pointless.
    const { fields, inferred } = resolvePublishFields(
      [q('q1', { outcomeTarget: { fieldId: 'chosen' } }), cell('q1-out'), cell('chosen')],
      [keyed('q1')],
    );

    expect(fields[0]!.outcomeTarget).toEqual({ fieldId: 'chosen' });
    expect(inferred).toEqual([]);
  });

  it('NEVER SCANS PAST THE NEXT FIELD', () => {
    /*
      Only the immediately-next field is considered. Scanning forward is what
      would let a question whose own cell is missing reach across and claim the
      NEXT question's cell — putting one candidate's mark against another
      question, with nothing to notice it.
    */
    const { fields, unlinked, inferred } = resolvePublishFields(
      [q('q1'), q('q2'), cell('q2-out')],
      [keyed('q1')],
    );

    expect(fields[0]!.outcomeTarget).toBeUndefined();
    expect(unlinked).toEqual(['q1']);
    expect(inferred).toEqual([]);
  });

  it('will not land a mark in a box the exporter would not draw in', () => {
    // A text box passes `validateAnswerKeys` and then prints nothing.
    const notes: FormField = { id: 'notes', type: 'text', label: 'Notes', required: false, source: 'imported' };

    const { unlinked, inferred } = resolvePublishFields([q('q1'), notes], [keyed('q1')]);

    expect(unlinked).toEqual(['q1']);
    expect(inferred).toEqual([]);
  });

  it('leaves an unkeyed question alone — no key, no mark, no target', () => {
    const { fields, inferred } = resolvePublishFields([q('q1'), cell('q1-out')], []);

    expect(fields[0]!.outcomeTarget).toBeUndefined();
    expect(inferred).toEqual([]);
  });
});
