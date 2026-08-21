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
import {
  checkPublish,
  extractionQuestionRefs,
  publishSummary,
  resolvePublishFields,
} from './builder-publish.js';

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

describe('resolvePublishFields — refs carried beside the fields', () => {
  /*
    `questionRef` lives on the EXTRACTED field, never on `FormField` — the
    fixtures above smuggle it on through a spread, which is precisely what the
    builder's real fields cannot do. These tests use bare fields plus the refs
    map `extractionQuestionRefs` builds, i.e. the shape production actually has.
  */
  it('links by the printed reference from the refs map, not adjacency', () => {
    // The outcome box is NOT adjacent — a notes field sits between — so an
    // adjacency guess cannot explain a resolved link.
    const { fields, inferred, unlinked } = resolvePublishFields(
      [question('q1'), field({ id: 'notes' }), outcome('o1')],
      [KEY('q1')],
      new Map([
        ['q1', 'BBM Q3'],
        ['o1', 'BBM Q3'],
      ]),
    );

    expect(fields[0]!.outcomeTarget).toEqual({ fieldId: 'o1' });
    expect(inferred).toEqual([]);
    expect(unlinked).toEqual([]);
  });

  it('never writes the ref onto the published field', () => {
    const { fields } = resolvePublishFields(
      [question('q1'), outcome('o1')],
      [KEY('q1')],
      new Map([
        ['q1', 'Q1'],
        ['o1', 'Q1'],
      ]),
    );
    expect('questionRef' in fields[0]!).toBe(false);
  });

  it('an explicitly authored target still wins over a ref link', () => {
    const { fields } = resolvePublishFields(
      [{ ...question('q1'), outcomeTarget: { fieldId: 'chosen' } }, outcome('o1')],
      [KEY('q1')],
      new Map([
        ['q1', 'Q1'],
        ['o1', 'Q1'],
      ]),
    );
    expect(fields[0]!.outcomeTarget).toEqual({ fieldId: 'chosen' });
  });

  it('a field the extraction missed carries no ref and falls to adjacency, reported', () => {
    // The author-added box is immediately next, so adjacency finds it — and
    // says so, because the map has no entry to link by.
    const { fields, inferred } = resolvePublishFields(
      [question('q1'), outcome('added-by-author')],
      [KEY('q1')],
      new Map(),
    );
    expect(fields[0]!.outcomeTarget).toEqual({ fieldId: 'added-by-author' });
    expect(inferred).toEqual(['q1']);
  });
});

describe('checkPublish — refs reach the link tier', () => {
  it('a keyed question with a non-adjacent referenced box passes without a guess', () => {
    const bare = [question('q1'), field({ id: 'gap' }), outcome('o1')];
    const check = checkPublish(
      bare,
      [KEY('q1')],
      manifestWith({ mandatoryFieldIds: ['q1'] }),
      undefined,
      undefined,
      new Map([
        ['q1', 'Q1'],
        ['o1', 'Q1'],
      ]),
    );
    expect(check.unlinked).toEqual([]);
    expect(check.inferred).toEqual([]);
  });
});

describe('extractionQuestionRefs', () => {
  it('keys every ref-carrying extracted field by id, skipping the rest', () => {
    const refs = extractionQuestionRefs({
      fields: [
        { id: 'q1', label: 'Q', type: 'radio', confidence: 1, questionRef: 'Q1' },
        { id: 'notes', label: 'Notes', type: 'text', confidence: 1 },
        { id: 'o1', label: 'Outcome', type: 'check_cross', confidence: 1, questionRef: 'Q1' },
      ],
    });
    expect(refs).toEqual(
      new Map([
        ['q1', 'Q1'],
        ['o1', 'Q1'],
      ]),
    );
  });

  it('a revision draft has no extraction and gets an empty map', () => {
    expect(extractionQuestionRefs(null).size).toBe(0);
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

/**
 * WRITTEN questions at publish — a model key publishes prose, not a key.
 *
 * The draft row is `answerKey: []` + `modelAnswer`; publish writes the prose
 * onto the field and resolves its outcome target through the SAME tiers a
 * keyed question uses, because the target means the same thing on both kinds:
 * the box the mark lands in. The difference is who writes the mark — which is
 * why a targetless model answer still publishes (the guide is legitimate on
 * its own) where a targetless key is refused.
 */
describe('resolvePublishFields — written questions with model answers', () => {
  const written = (id: string): FormField =>
    field({ id, type: 'textarea', label: `Explain ${id}` });
  const MODEL = (fieldId: string, modelAnswer = 'The expected prose'): DraftAnswerKey => ({
    fieldId,
    answerKey: [],
    modelAnswer,
    source: 'manual',
  });

  it('WRITES THE MODEL ANSWER onto the field, with the adjacent box as target', () => {
    const { fields, inferred, unlinked } = resolvePublishFields(
      [written('w1'), outcome('w1-out')],
      [MODEL('w1')],
    );

    expect(fields[0]!.modelAnswer).toBe('The expected prose');
    expect(fields[0]!.answerKey).toBeUndefined();
    expect(fields[0]!.outcomeTarget).toEqual({ fieldId: 'w1-out' });
    expect(inferred).toEqual(['w1']);
    expect(unlinked).toEqual([]);
  });

  it('an explicit target on the written question still wins outright', () => {
    const { fields, inferred } = resolvePublishFields(
      [
        { ...written('w1'), outcomeTarget: { fieldId: 'chosen' } },
        outcome('w1-out'),
        outcome('chosen'),
      ],
      [MODEL('w1')],
    );

    expect(fields[0]!.outcomeTarget).toEqual({ fieldId: 'chosen' });
    expect(inferred).toEqual([]);
  });

  it('publishes a TARGETLESS model answer rather than refusing it', () => {
    // validateAnswerKeys accepts a written question with a guide and no
    // target — the guide is a marking aid on its own — so publish must not
    // report it "unlinked" the way a computed mark with nowhere to land is.
    const { fields, unlinked, inferred } = resolvePublishFields([written('w1')], [MODEL('w1')]);

    expect(fields[0]!.modelAnswer).toBe('The expected prose');
    expect(fields[0]!.outcomeTarget).toBeUndefined();
    expect(unlinked).toEqual([]);
    expect(inferred).toEqual([]);
  });

  it('a written question with NO model answer is left alone entirely', () => {
    // Opt-in: an unguided written question is furniture, and publish must
    // not touch it — same identity guarantee the unkeyed test above pins.
    const source = [written('w1'), outcome('w1-out')];
    const { fields, unlinked, inferred } = resolvePublishFields(source, []);

    expect(fields[0]).toBe(source[0]);
    expect(unlinked).toEqual([]);
    expect(inferred).toEqual([]);
  });

  it('REGRESSION: a choice-only draft publishes byte-identical with the model path present', () => {
    // The exact fixture of the adjacency test above, asserted deeply — the
    // written branch must be invisible to a draft with no written keys.
    const src = [question('q1'), outcome('o1'), question('q2', 'Q2'), outcome('o2', 'Q2')];
    const { fields, unlinked, inferred } = resolvePublishFields(src, [KEY('q1'), KEY('q2', ['b'])]);

    expect(fields).toEqual([
      { ...src[0], answerKey: ['a'], outcomeTarget: { fieldId: 'o1' } },
      src[1],
      { ...src[2], answerKey: ['b'], outcomeTarget: { fieldId: 'o2' } },
      src[3],
    ]);
    expect(unlinked).toEqual([]);
    expect(inferred).toEqual(['q1']);
    // Untouched fields keep their identity, not just their shape.
    expect(fields[1]).toBe(src[1]);
  });

  it('publishSummary reports written guides separately, and omits the count when none exist', () => {
    const mixed = publishSummary([], [KEY('q1'), MODEL('w1')], null);
    expect(mixed.questionsKeyed).toBe(1);
    expect(mixed.writtenGuided).toBe(1);

    // Absent, not zero: a choice-only draft's summary is byte-identical to
    // what it was before written questions existed.
    const choiceOnly = publishSummary([], [KEY('q1')], null);
    expect('writtenGuided' in choiceOnly).toBe(false);
  });

  it('publishSummary counts a verified model answer in questionsVerified', () => {
    const summary = publishSummary(
      [],
      [{ ...MODEL('w1'), verifiedBy: 'Ash', verifiedAt: '2026-08-20T00:00:00Z' }],
      null,
    );
    expect(summary.questionsVerified).toBe(1);
    expect(summary.questionsKeyed).toBe(0);
  });
});

describe('resolvePublishFields — the draft key rows are the single source of truth', () => {
  /*
    A revision seeds its fields VERBATIM from the published version, so each
    keyed/guided field carries its own copy of `answerKey`/`modelAnswer` — and
    `keysFromFields` mints a draft row for every one of them. Clearing the key
    or the guide in the builder deletes only the ROW; the fix strips the
    fields' own copies first and re-applies from rows, so a cleared row means
    a cleared field instead of the builder showing "unguided" while the old
    answer republishes underneath.
  */
  const seededChoice = field({
    id: 'q1',
    type: 'radio',
    options: ['a', 'b'],
    answerKey: ['a'],
    outcomeTarget: { fieldId: 'o1' },
  });
  const seededWritten = field({
    id: 'w1',
    type: 'textarea',
    modelAnswer: 'the old guide',
    outcomeTarget: { fieldId: 'w1-out' },
  });
  const seededFields = [seededChoice, outcome('o1'), seededWritten, outcome('w1-out')];

  it('CLEARED ROWS CLEAR THE FIELDS — key and guide both gone from the publish', () => {
    const { fields } = resolvePublishFields(seededFields, []);

    const q1 = fields.find((f) => f.id === 'q1')!;
    const w1 = fields.find((f) => f.id === 'w1')!;
    expect('answerKey' in q1).toBe(false);
    expect('modelAnswer' in w1).toBe(false);
    // The placements are NOT the rows' to clear: an outcomeTarget is an
    // authored fact about where a mark lands, kept even while unkeyed.
    expect(q1.outcomeTarget).toEqual({ fieldId: 'o1' });
    expect(w1.outcomeTarget).toEqual({ fieldId: 'w1-out' });
  });

  it('an UNTOUCHED revision draft publishes byte-identically to its seed', () => {
    // Exactly the rows `keysFromFields` seeds for these fields.
    const rows: DraftAnswerKey[] = [
      { fieldId: 'q1', answerKey: ['a'], source: 'manual' },
      { fieldId: 'w1', answerKey: [], modelAnswer: 'the old guide', source: 'manual' },
    ];

    const { fields } = resolvePublishFields(seededFields, rows);

    expect(fields.find((f) => f.id === 'q1')).toEqual(seededChoice);
    expect(fields.find((f) => f.id === 'w1')).toEqual(seededWritten);
  });

  it('clearing ONLY the guide half of a seeded row does not resurrect the field’s copy', () => {
    // The author kept the choice key but removed the written guide from a
    // field that (from hand-edited data) carried both: the surviving row
    // speaks for the key alone.
    const both = field({
      id: 'q1',
      type: 'radio',
      options: ['a', 'b'],
      answerKey: ['a'],
      modelAnswer: 'stale prose',
      outcomeTarget: { fieldId: 'o1' },
    });

    const { fields } = resolvePublishFields(
      [both, outcome('o1')],
      [{ fieldId: 'q1', answerKey: ['a'], source: 'manual' }],
    );

    const q1 = fields.find((f) => f.id === 'q1')!;
    expect(q1.answerKey).toEqual(['a']);
    expect('modelAnswer' in q1).toBe(false);
  });

  it('REGRESSION: a from-scratch draft publishes deep-equal to before — its fields never carried the copies', () => {
    const { fields } = resolvePublishFields(
      [question('q1'), outcome('o1'), field({ id: 'w1', type: 'textarea' }), outcome('w1-out')],
      [KEY('q1'), { fieldId: 'w1', answerKey: [], modelAnswer: 'guide', source: 'manual' }],
    );

    expect(fields).toEqual([
      { ...question('q1'), answerKey: ['a'], outcomeTarget: { fieldId: 'o1' } },
      outcome('o1'),
      { ...field({ id: 'w1', type: 'textarea' }), modelAnswer: 'guide', outcomeTarget: { fieldId: 'w1-out' } },
      outcome('w1-out'),
    ]);
  });
});

describe('carried geometry at publish (AE2)', () => {
  it('names every carried-but-unconfirmed field, and none when the stash is empty', async () => {
    const { checkPublish } = await import('./builder-publish.js');
    const fields = [
      { id: 'q1', type: 'text', label: 'Pre-start checks', required: false, source: 'imported' },
      { id: 'q2', type: 'text', label: 'Shutdown procedure', required: false, source: 'imported' },
    ] as never[];
    const stash = {
      q1: { segments: [{ page: 0, x: 1, y: 1, width: 2, height: 2, pageWidth: 595, pageHeight: 842 }] },
      q2: { segments: [{ page: 3, x: 1, y: 1, width: 2, height: 2, pageWidth: 595, pageHeight: 842 }] },
    };

    const withStash = checkPublish(fields, [], null, undefined, stash);
    expect(withStash.carried.sort()).toEqual(['Pre-start checks', 'Shutdown procedure']);

    const withoutStash = checkPublish(fields, [], null);
    expect(withoutStash.carried).toEqual([]);
  });
});

/**
 * A revision must not clobber the summary wiring an author configured in the
 * workflow editor with a fresh label-guess — and must not carry a pointer
 * whose box no longer exists into a republish that validation would refuse.
 */
describe('composeRevisionManifest — the summary wiring survives a revision', () => {
  const methods: FormField = field({
    id: 'methods',
    type: 'repeating_group',
    fixedRows: ['1. Theory'],
    columns: [
      { key: 'method', label: 'Method', type: 'text' },
      { key: 'done', label: 'Done', type: 'checkbox' },
    ],
  });
  const box = (id: string): FormField => field({ id, type: 'check_cross' });

  const seeded: AssessmentToolManifest = {
    ...manifestWith(),
    partCompletionMarks: [{ partKey: 'p1', fieldId: 'methods', rowIndex: 0, columnKey: 'done' }],
    signOff: {
      assessorNameFieldId: 'sign-name',
      overallSatisfactory: { fieldId: 'author-yes', value: true },
      overallNotSatisfactory: { fieldId: 'author-no', value: true },
    },
    pathwayMarks: { new: { fieldId: 'pathway-new', value: true } },
  };
  const derived: AssessmentToolManifest = {
    ...manifestWith(),
    partCompletionMarks: [{ partKey: 'p1', fieldId: 'methods', rowIndex: 0, columnKey: 'method' }],
    signOff: {
      overallSatisfactory: { fieldId: 'guess-yes', value: true },
      overallNotSatisfactory: { fieldId: 'guess-no', value: true },
    },
  };

  it('keeps the seeded wiring wherever it still resolves', async () => {
    const { composeRevisionManifest } = await import('./builder-publish.js');
    const fields = [
      question('q1'),
      methods,
      box('author-yes'),
      box('author-no'),
      box('pathway-new'),
      field({ id: 'sign-name' }),
    ];

    const merged = composeRevisionManifest(seeded, derived, fields);

    expect(merged.partCompletionMarks).toEqual(seeded.partCompletionMarks);
    expect(merged.signOff?.overallSatisfactory?.fieldId).toBe('author-yes');
    expect(merged.signOff?.overallNotSatisfactory?.fieldId).toBe('author-no');
    expect(merged.signOff?.assessorNameFieldId).toBe('sign-name');
    expect(merged.pathwayMarks).toEqual(seeded.pathwayMarks);
  });

  it('falls back per key where a seeded box vanished, and drops a dead pathway mark', async () => {
    const { composeRevisionManifest } = await import('./builder-publish.js');
    // author-no and pathway-new no longer exist; author-yes survives.
    const fields = [question('q1'), methods, box('author-yes'), box('guess-no')];

    const merged = composeRevisionManifest(seeded, derived, fields);

    // One renamed box costs one pointer, never the whole block.
    expect(merged.signOff?.overallSatisfactory?.fieldId).toBe('author-yes');
    expect(merged.signOff?.overallNotSatisfactory?.fieldId).toBe('guess-no');
    // A dead pathway mark is dropped rather than blocking the republish.
    expect(merged.pathwayMarks).toBeUndefined();
  });

  it('uses the derivation when no seeded completion mark resolves', async () => {
    const { composeRevisionManifest } = await import('./builder-publish.js');
    // The methods table is gone entirely — nothing seeded can resolve.
    const fields = [question('q1'), box('author-yes')];

    const merged = composeRevisionManifest(seeded, derived, fields);

    expect(merged.partCompletionMarks).toEqual(derived.partCompletionMarks);
  });

  it('keeps the plain overlay when no fields are given — every existing caller unchanged', async () => {
    const { composeRevisionManifest } = await import('./builder-publish.js');
    const merged = composeRevisionManifest(seeded, derived);

    // Derived wins where both exist, exactly as before.
    expect(merged.signOff?.overallSatisfactory?.fieldId).toBe('guess-yes');
    expect(merged.partCompletionMarks).toEqual(derived.partCompletionMarks);
    // And a key the derivation never writes rides through from the seed.
    expect(merged.pathwayMarks).toEqual(seeded.pathwayMarks);
  });
});
