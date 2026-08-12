/**
 * Deriving the part manifest.
 *
 * `author-track-dozer-tool.mjs` is the reference implementation, and the tests
 * here are mostly about the places this deliberately does NOT copy it: it reads
 * a part's kind off its heading text, which works on exactly one document, and
 * it renumbers nothing because it never reorders. The two properties worth
 * pinning hardest:
 *
 *   · a part's KIND comes from what the section contains, not what it is called;
 *   · reordering changes PROCESS order and never touches `ordinal`, because an
 *     attempt records a part key and the ordinal is what says which printed
 *     pages that key means.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETUP_ANSWERS,
  validateManifest,
  type DraftAnswerKey,
  type FormField,
  type SetupAnswers,
  type StructureSection,
} from '@formai/shared';
import {
  buildManifest,
  derivePartsFromStructure,
  findDurationColumn,
  inferKind,
  logbookColumnsFor,
  movePart,
  proposeCoverPointers,
  proposePartMarks,
  proposeProfilePrefill,
  proposeSignOff,
  setPathways,
  updatePart,
} from './builder-manifest.js';

function field(over: Partial<FormField> & { id: string }): FormField {
  return { label: over.id, type: 'text', required: false, source: 'imported', ...over };
}

function question(id: string): FormField {
  return field({ id, type: 'radio', options: ['a', 'b'] });
}

function section(key: string, label: string, ids: string[], over: Partial<StructureSection> = {}): StructureSection {
  return { key, label, cols: 1, fields: ids.map((id) => ({ id })), ...over };
}

const SETUP: SetupAnswers = { ...DEFAULT_SETUP_ANSWERS, pathways: ['new', 'experienced'] };

function derive(
  structure: StructureSection[],
  fields: FormField[],
  keys: DraftAnswerKey[] = [],
  excluded = new Set<string>(),
) {
  return derivePartsFromStructure({ structure, fields, setup: SETUP, keys, excluded });
}

describe('inferKind', () => {
  it('reads a logbook from an OPEN repeating group', () => {
    // Rows the filler adds over weeks. The script reads this off the heading
    // text ("DIRECT OBSERVATION LOG"), which fails on the next customer's paper.
    expect(inferKind([field({ id: 't', type: 'repeating_group' })])).toBe('logbook');
  });

  it('reads a practical from a FIXED-ROW checklist', () => {
    expect(
      inferKind([field({ id: 't', type: 'repeating_group', fixedRows: ['Sound the horn'] })]),
    ).toBe('practical');
  });

  it('reads theory from questions', () => {
    expect(inferKind([question('q1'), question('q2')])).toBe('theory');
  });

  it('calls a checklist with a stray question PRACTICAL, not theory', () => {
    /*
      A practical part often carries a question or two beside its checklist.
      Calling that part theory would put it on the auto-marked path and let it
      reach satisfactory without an assessor watching the demonstration.
    */
    expect(
      inferKind([field({ id: 't', type: 'repeating_group', fixedRows: ['Sound the horn'] }), question('q1')]),
    ).toBe('practical');
  });

  it('prefers logbook when a section carries both table shapes', () => {
    expect(
      inferKind([
        field({ id: 'fixed', type: 'repeating_group', fixedRows: ['x'] }),
        field({ id: 'open', type: 'repeating_group' }),
      ]),
    ).toBe('logbook');
  });
});

describe('findDurationColumn', () => {
  it('prefers the key the extraction profile asks for', () => {
    // Rule 6 instructs the model to key this column "duration" whatever its
    // printed label, so the declared key is the reliable handle.
    const table = field({
      id: 't',
      type: 'repeating_group',
      columns: [
        { key: 'hours', label: 'Hours worked', type: 'text' as const },
        { key: 'duration', label: 'Time on machine', type: 'text' as const },
      ],
    });
    expect(findDurationColumn(table)).toBe('duration');
  });

  it('falls back to the column’s label', () => {
    const table = field({
      id: 't',
      type: 'repeating_group',
      columns: [{ key: 'c2', label: 'Hours', type: 'text' as const }],
    });
    expect(findDurationColumn(table)).toBe('c2');
  });

  it('returns undefined rather than guessing a column', () => {
    // Totalling a column that does not exist reports zero hours against a
    // safety minimum. Undefined makes validateManifest name it instead.
    const table = field({
      id: 't',
      type: 'repeating_group',
      columns: [{ key: 'task', label: 'Task', type: 'text' as const }],
    });
    expect(findDurationColumn(table)).toBeUndefined();
    expect(findDurationColumn(undefined)).toBeUndefined();
  });
});

describe('derivePartsFromStructure', () => {
  it('numbers parts in printed order and skips the cover', () => {
    /*
      COVER SECTIONS ARE NOT PARTS. `fieldsInPart` slices from a part's anchor
      onward, so cover fields fall in no part's range by design — the manifest
      addresses them directly. Emitting a cover part gives those fields two
      owners.
    */
    const parts = derive(
      [
        section('cover', 'Candidate declaration', ['name'], { cover: true }),
        section('theory', 'Part 1 — Theory', ['q1']),
        section('prac', 'Part 2 — Practical', ['tbl']),
      ],
      [
        field({ id: 'name' }),
        question('q1'),
        field({ id: 'tbl', type: 'repeating_group', fixedRows: ['Sound the horn'] }),
      ],
    );

    expect(parts.map((p) => [p.key, p.ordinal, p.kind])).toEqual([
      ['theory', 1, 'theory'],
      ['prac', 2, 'practical'],
    ]);
  });

  it('anchors a part to its heading where the section has one', () => {
    /*
      `fieldsInSection` slices from AFTER the anchor, and both validateManifest
      and the column picker use it to find a logbook's table. Anchoring a
      logbook part at its own table puts the table outside its own slice: the
      validator then reports "has no repeating table in its section" about a
      part whose table is the field it points at.
    */
    const parts = derive(
      [section('p1', 'Part 1', ['h', 'q1'], { headerFieldId: 'h' })],
      [field({ id: 'h', type: 'section_header' }), question('q1')],
    );
    expect(parts[0]!.startFieldId).toBe('h');
  });

  it('falls back to the first fillable field when there is no heading', () => {
    // Requiring a section_header anchor made a real 18-page import
    // unanchorable, with none of its part boundaries resolvable.
    const parts = derive([section('p1', 'Part 1', ['q1'])], [question('q1')]);
    expect(parts[0]!.startFieldId).toBe('q1');
  });

  it('keeps a logbook’s table inside its own slice, so the column resolves', () => {
    const fields = [
      field({ id: 'h', type: 'section_header' }),
      field({
        id: 'tbl',
        type: 'repeating_group',
        columns: [{ key: 'duration', label: 'Hours', type: 'text' as const }],
      }),
    ];
    const parts = derive([section('log', 'Part 3', ['h', 'tbl'], { headerFieldId: 'h' })], fields);

    expect(parts[0]!.durationColumnKey).toBe('duration');
    expect(logbookColumnsFor(parts[0]!, fields)).toEqual([{ key: 'duration', label: 'Hours' }]);
  });

  it('skips a section the author has emptied', () => {
    // A part with no start field is not a part; declaring one produces a
    // manifest the validator rejects for a reason the author cannot see.
    const parts = derive([section('empty', 'Part 1', []), section('p2', 'Part 2', ['q1'])], [question('q1')]);
    expect(parts.map((p) => p.key)).toEqual(['p2']);
    expect(parts[0]!.ordinal).toBe(1);
  });

  it('proposes only KEYED questions as mandatory', () => {
    /*
      validateManifest hard-errors on a mandatory question with no answer key,
      because marking skips it and the part could reach 100% with the question
      never assessed. Proposing only keyed ones makes the default manifest valid
      on arrival.
    */
    const parts = derive(
      [section('p1', 'Part 1', ['q1', 'q2'])],
      [question('q1'), question('q2')],
      [{ fieldId: 'q1', answerKey: ['a'], source: 'manual' }],
    );
    expect(parts[0]!.mandatoryFieldIds).toEqual(['q1']);
  });

  it('never proposes an excluded question as mandatory', () => {
    const parts = derive(
      [section('p1', 'Part 1', ['q1', 'q2'])],
      [question('q1'), question('q2')],
      [
        { fieldId: 'q1', answerKey: ['a'], source: 'manual' },
        { fieldId: 'q2', answerKey: ['b'], source: 'manual' },
      ],
      new Set(['q2']),
    );
    expect(parts[0]!.mandatoryFieldIds).toEqual(['q1']);
  });

  it('gives a practical part no mandatory set at all', () => {
    // A practical's criteria are ticked by an assessor, not auto-marked, so a
    // mandatory set there names fields markTheory never looks at.
    const parts = derive(
      [section('p1', 'Part 1', ['tbl', 'q1'])],
      [field({ id: 'tbl', type: 'repeating_group', fixedRows: ['x'] }), question('q1')],
      [{ fieldId: 'q1', answerKey: ['a'], source: 'manual' }],
    );
    expect(parts[0]!.kind).toBe('practical');
    expect(parts[0]!.mandatoryFieldIds).toBeUndefined();
  });

  it('declares a logbook’s duration column when the table names one', () => {
    const parts = derive(
      [section('log', 'Part 3 — Log', ['tbl'])],
      [
        field({
          id: 'tbl',
          type: 'repeating_group',
          columns: [
            { key: 'task', label: 'Task', type: 'text' as const },
            { key: 'duration', label: 'Hours', type: 'text' as const },
          ],
        }),
      ],
    );
    expect(parts[0]!.kind).toBe('logbook');
    expect(parts[0]!.durationColumnKey).toBe('duration');
  });

  it('leaves the duration column undeclared when there is none to find', () => {
    // The validator then says so by name, which is what gets it fixed.
    const parts = derive(
      [section('log', 'Part 3 — Log', ['tbl'])],
      [field({ id: 'tbl', type: 'repeating_group', columns: [{ key: 'task', label: 'Task', type: 'text' as const }] })],
    );
    expect(parts[0]!.durationColumnKey).toBeUndefined();
  });

  it('starts every part in every pathway the tool offers', () => {
    // A part belonging to no pathway is a hard validator problem, so the
    // default has to be non-empty and the author narrows it.
    const parts = derive([section('p1', 'Part 1', ['q1'])], [question('q1')]);
    expect(parts[0]!.pathways).toEqual(['new', 'experienced']);
  });
});

describe('movePart', () => {
  const PARTS = derive(
    [section('a', 'A', ['q1']), section('b', 'B', ['q2']), section('c', 'C', ['q3'])],
    [question('q1'), question('q2'), question('q3')],
  );

  it('changes process order and LEAVES ORDINALS ALONE', () => {
    /*
      R14. An attempt records a part KEY, and the ordinal is what says which
      printed pages that key means. Renumbering on a reorder would re-point
      every stored attempt at a different part of the document.
    */
    const moved = movePart(PARTS, 'c', -1);

    expect(moved.map((p) => p.key)).toEqual(['a', 'c', 'b']);
    expect(moved.map((p) => p.ordinal)).toEqual([1, 3, 2]);
    // The ordinal each key carries is unchanged from where it started.
    for (const part of moved) {
      expect(part.ordinal).toBe(PARTS.find((p) => p.key === part.key)!.ordinal);
    }
  });

  it('returns the SAME array when the move would fall off either end', () => {
    // Idempotent by reference, as every other builder operation is — a held
    // arrow key produces one change and then no-ops.
    expect(movePart(PARTS, 'a', -1)).toBe(PARTS);
    expect(movePart(PARTS, 'c', 1)).toBe(PARTS);
    expect(movePart(PARTS, 'nope', 1)).toBe(PARTS);
  });
});

describe('setPathways and updatePart', () => {
  const PARTS = derive([section('a', 'A', ['q1'])], [question('q1')]);

  it('narrows a part to the routes that require it', () => {
    expect(setPathways(PARTS, 'a', ['new'])[0]!.pathways).toEqual(['new']);
  });

  it('patches kind and hours without touching the key or ordinal', () => {
    const patched = updatePart(PARTS, 'a', { kind: 'logbook', minimumHours: 20 });
    expect(patched[0]!.kind).toBe('logbook');
    expect(patched[0]!.minimumHours).toBe(20);
    expect(patched[0]!.key).toBe('a');
    expect(patched[0]!.ordinal).toBe(1);
  });
});

describe('buildManifest', () => {
  it('drops the builder’s own bookkeeping from the stored record', () => {
    const parts = derive([section('a', 'A', ['q1'])], [question('q1')]);
    const manifest = buildManifest(parts, []);
    expect(manifest.parts[0]).not.toHaveProperty('sectionKey');
  });

  it('proposes the candidate-name box from the cover section', () => {
    // Missing it exports a certificate with a blank name on it.
    const manifest = buildManifest([], [
      { id: 'n', label: 'Candidate Name', type: 'text' as const, coverSection: 'candidate_declaration' as const },
    ]);
    expect(manifest.candidateNameFieldId).toBe('n');
  });

  it('proposes nothing when no cover field looks like a name box', () => {
    const manifest = buildManifest([], [
      { id: 'c', label: 'Company', type: 'text' as const, coverSection: 'candidate_declaration' as const },
    ]);
    expect(manifest.candidateNameFieldId).toBeUndefined();
  });

  it('never takes a name box from outside the cover page', () => {
    // coverSection is bounded to the document's FIRST page by rule 8; a
    // per-part sign-off prints the same words and carries none.
    const manifest = buildManifest([], [
      { id: 'n', label: 'Candidate Name', type: 'text' as const },
    ]);
    expect(manifest.candidateNameFieldId).toBeUndefined();
  });
});

describe('the derived manifest passes the real validator', () => {
  it('validates clean for a theory part with keyed questions', () => {
    // The point of proposing only keyed questions as mandatory: the default is
    // valid on arrival rather than presenting the author with problems they
    // did not cause.
    const fields = [
      { ...question('q1'), answerKey: ['a'], outcomeTarget: { fieldId: 'o1' } },
      field({ id: 'o1', type: 'check_cross' }),
    ];
    const parts = derive(
      [section('p1', 'Part 1', ['q1', 'o1'])],
      fields,
      [{ fieldId: 'q1', answerKey: ['a'], source: 'manual' }],
    );

    expect(validateManifest(buildManifest(parts, []), fields)).toEqual([]);
  });

  it('surfaces the validator’s own words for a logbook with no duration column (AE8-shaped)', () => {
    const fields = [field({ id: 'tbl', type: 'repeating_group', columns: [{ key: 'task', label: 'Task', type: 'text' as const }] })];
    const parts = derive([section('log', 'Part 3', ['tbl'])], fields);

    const problems = validateManifest(buildManifest(parts, []), fields);

    expect(problems.some((p) => p.includes('durationColumnKey'))).toBe(true);
    expect(problems.some((p) => p.includes('minimumHours'))).toBe(true);
  });

  it('surfaces the mandatory-without-a-key problem when an author adds one', () => {
    // The failure AE8 names: a must-pass question marking skips entirely.
    const fields = [question('q1')];
    const parts = updatePart(derive([section('p1', 'Part 1', ['q1'])], fields), 'p1', {
      mandatoryFieldIds: ['q1'],
    });

    const problems = validateManifest(buildManifest(parts, []), fields);
    expect(problems.some((p) => p.includes('no answer key'))).toBe(true);
  });
});

describe('logbookColumnsFor', () => {
  it('offers the same columns the validator checks against', () => {
    // The list an author picks from and the list validateManifest checks have
    // to come from one slice, or the pick can fail validation.
    const fields = [
      field({ id: 'tbl', type: 'repeating_group', columns: [{ key: 'duration', label: 'Hours', type: 'text' as const }] }),
    ];
    expect(logbookColumnsFor({ startFieldId: 'tbl' }, fields)).toEqual([]);

    const withLead = [field({ id: 'lead' }), ...fields];
    // The picker offers key + label only; the column's own type is not the
    // author's choice here.
    expect(logbookColumnsFor({ startFieldId: 'lead' }, withLead)).toEqual([
      { key: 'duration', label: 'Hours' },
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * Automatic marking: the printed boxes the verdict is written into
 * ------------------------------------------------------------------ */

/**
 * Nothing in this builder has ever written `signOff` or a part's verdict boxes.
 * They existed in the model and were populated only by the authoring SCRIPT
 * this builder replaces — so every tool built here exported its certification
 * block blank, invisibly, because an empty `signOff` is perfectly valid.
 */
describe('proposeProfilePrefill', () => {
  const text = (id: string, label: string) => ({ id, label, type: 'text' as const });

  it('maps the cover identity boxes by their printed labels', () => {
    // The real cover page, verbatim. These three are the fields the whole
    // "candidate details fill themselves" flow turns on.
    expect(
      proposeProfilePrefill([
        text('name', "Candidate's Name"),
        text('company', "Candidate's Company Name"),
        text('swipe', 'Employee Swipe card Number'),
      ]),
    ).toEqual({ name: 'candidate_name', company: 'company_name', swipe: 'swipe_card' });
  });

  it('never maps the assessor’s name as the candidate’s', () => {
    /*
      "Name of Assessor [Print]" contains "name" too. Mapping the CANDIDATE'S
      name into it would print the person being assessed as the person
      certifying them — the one wrong box an auditor reads first.
    */
    const map = proposeProfilePrefill([text('assessor', 'Name of Assessor [Print]')]);

    expect(map).toBeUndefined();
  });

  it('refuses an ambiguous label rather than picking one', () => {
    expect(
      proposeProfilePrefill([
        text('a', "Candidate's Name"),
        text('b', "Candidate's Name (print)"),
      ]),
    ).toBeUndefined();
  });

  it('maps only text fields — the validator would refuse anything else', () => {
    const map = proposeProfilePrefill([
      { id: 'tick', label: "Candidate's Name", type: 'check_cross' as const },
    ]);

    expect(map).toBeUndefined();
  });
});

describe('proposeSignOff', () => {
  const cover = (over: Partial<Parameters<typeof proposeSignOff>[0][number]> & { id: string; label: string }) => ({
    type: 'check_cross' as const,
    ...over,
  });

  it('proposes the whole certification block from the printed labels', () => {
    const signOff = proposeSignOff([
      cover({ id: 'coach', label: 'More coaching and/or training required?' }),
      cover({ id: 'result', label: 'Assessment Result' }),
      cover({ id: 'name', label: 'Name of Assessor [Print]', type: 'text' }),
      cover({ id: 'sig', label: 'Assessor Signature', type: 'signature' }),
      cover({ id: 'date', label: 'Date', type: 'date' }),
    ]);

    expect(signOff?.assessorNameFieldId).toBe('name');
    expect(signOff?.assessorSignatureFieldId).toBe('sig');
    expect(signOff?.signedDateFieldId).toBe('date');
    expect(signOff?.overallSatisfactory).toEqual({ fieldId: 'result', value: true });
    expect(signOff?.overallNotSatisfactory).toEqual({ fieldId: 'result', value: false });
  });

  it('MAPS "YES, COACHING REQUIRED" TO THE NOT-SATISFACTORY HALF', () => {
    /*
      The one pair whose polarity is inverted. "More coaching required: Yes" is
      the FAILING answer, so a scheme that lined the two pairs up positionally
      would tick "no coaching needed" on every failed assessment.
    */
    const signOff = proposeSignOff([
      cover({ id: 'coach', label: 'More coaching and/or training required?' }),
    ]);

    expect(signOff?.moreCoachingRequiredYes).toEqual({ fieldId: 'coach', value: false });
    expect(signOff?.moreCoachingRequiredNo).toEqual({ fieldId: 'coach', value: true });
  });

  it('REFUSES WHEN TWO FIELDS COULD BE THE SAME BOX', () => {
    /*
      This paper reprints its certification block after every part. The
      authoring script searched the whole document, matched seven of each box,
      and refused all seven — correctly — but then shipped an empty `signOff`
      in silence, so a signed competent case exported a certificate with nobody's
      name on it. Refusing is right; the caller scopes the slice so it does not
      have to.
    */
    const signOff = proposeSignOff([
      cover({ id: 'a', label: 'Assessment Result' }),
      cover({ id: 'b', label: 'Assessment Result' }),
    ]);

    expect(signOff?.overallSatisfactory).toBeUndefined();
  });

  it('refuses a box whose type cannot carry a verdict', () => {
    // A text box would take a boolean and render the word "true".
    const signOff = proposeSignOff([
      cover({ id: 'result', label: 'Assessment Result', type: 'text' }),
    ]);

    expect(signOff?.overallSatisfactory).toBeUndefined();
  });

  it('reads a choice field’s own printed options rather than their order', () => {
    // "Candidate Competent" and "Candidate not yet Competent" are printed words;
    // taking the first option would be a coin toss on the most consequential
    // cell of the document.
    const signOff = proposeSignOff([
      cover({
        id: 'result',
        label: 'Assessment Result',
        type: 'radio',
        options: ['Candidate not yet Competent', 'Candidate Competent'],
      }),
    ]);

    expect(signOff?.overallSatisfactory).toEqual({ fieldId: 'result', value: 'Candidate Competent' });
    expect(signOff?.overallNotSatisfactory).toEqual({
      fieldId: 'result',
      value: 'Candidate not yet Competent',
    });
  });

  it('proposes nothing at all for a cover with no recognisable boxes', () => {
    expect(proposeSignOff([cover({ id: 'x', label: 'Company' })])).toBeUndefined();
  });
});

describe('proposePartMarks', () => {
  const f = (id: string, label: string, type: 'check_cross' | 'textarea' = 'check_cross') => ({
    id,
    label,
    type,
  });

  it('proposes the verdict pair and the further-action box', () => {
    const marks = proposePartMarks([
      f('v', 'The Candidate’s responses were:'),
      f('act', 'Detail further action:', 'textarea'),
    ]);

    expect(marks.outcomeSatisfactory).toEqual({ fieldId: 'v', value: true });
    expect(marks.outcomeNotSatisfactory).toEqual({ fieldId: 'v', value: false });
    expect(marks.furtherActionFieldId).toBe('act');
  });

  it('refuses a verdict box the section prints twice', () => {
    const marks = proposePartMarks([
      f('a', 'The Candidate’s responses were:'),
      f('b', 'The Candidate’s responses were:'),
    ]);

    expect(marks.outcomeSatisfactory).toBeUndefined();
  });

  it('pairs two printed boxes — a tick in whichever box speaks', () => {
    /*
      The two-field shape: "☐ Satisfactory ☐ Not Satisfactory" as separate
      cells. `true` in the NEGATIVE box, never `false` in the positive one — a
      ✗ beside "Satisfactory" with an empty partner reads as both and neither.
    */
    const marks = proposePartMarks([
      f('yes-box', 'Satisfactory'),
      f('no-box', 'Not Satisfactory'),
    ]);

    expect(marks.outcomeSatisfactory).toEqual({ fieldId: 'yes-box', value: true });
    expect(marks.outcomeNotSatisfactory).toEqual({ fieldId: 'no-box', value: true });
  });

  it('pairs the sentence-labelled two-field shape, curly apostrophe and all', () => {
    // Extraction reads the paper's own punctuation; a straight-quote-only
    // pattern silently missed every real "Candidate's".
    const marks = proposePartMarks([
      f('yes-box', 'The Candidate’s responses were: Satisfactory'),
      f('no-box', 'The Candidate’s responses were: Not Satisfactory'),
    ]);

    expect(marks.outcomeSatisfactory).toEqual({ fieldId: 'yes-box', value: true });
    expect(marks.outcomeNotSatisfactory).toEqual({ fieldId: 'no-box', value: true });
  });

  it('refuses two boxes where neither is the negative', () => {
    // Two positives is the ambiguity the exactly-one rule exists for.
    const marks = proposePartMarks([
      f('a', 'Satisfactory'),
      f('b', 'Satisfactory'),
    ]);

    expect(marks.outcomeSatisfactory).toBeUndefined();
  });

  it('refuses a two-field pair whose boxes cannot carry a mark', () => {
    const marks = proposePartMarks([
      f('yes-box', 'Satisfactory', 'textarea'),
      f('no-box', 'Not Satisfactory'),
    ]);

    expect(marks.outcomeSatisfactory).toBeUndefined();
  });

  it('proposes nothing for a section that prints neither', () => {
    expect(proposePartMarks([f('q', 'Manoeuvres the dozer safely')])).toEqual({});
  });
});

/**
 * Mapping the printed methods checklist to the parts whose completion it
 * records. The fixtures are the real paper's own hazards: a heading typo
 * ("OBSERVATON") that defeats word matching, and a declaration part sharing
 * its number with the part it declares for.
 */
describe('proposePartCompletionMarks', () => {
  const methodsTable = {
    id: 'methods',
    label: 'Assessment Methods used (check all that apply)',
    type: 'repeating_group' as const,
    fixedRows: [
      '1. Theory',
      '2. Practical Demonstration',
      '3. Direct Observation Log',
      '4. Minimal Supervision Practical Assessment',
    ],
    columns: [
      { key: 'method', label: 'Method', type: 'text' as const },
      { key: 'used', label: 'Used', type: 'checkbox' as const },
    ],
  };
  const PARTS = [
    { key: 'p1', label: 'PART 1 - THEORY' },
    { key: 'p2', label: 'PART 2 - PRACTICAL DEMONSTRATION' },
    { key: 'p2d', label: 'PART 2 Assessor Assessment Declaration' },
    { key: 'p3', label: 'PART 3 - DIRECT OBSERVATON LOG' },
  ];

  it('maps each part to its numbered row, typo and declaration collision included', async () => {
    const { proposePartCompletionMarks } = await import('./builder-manifest.js');
    const marks = proposePartCompletionMarks(PARTS, [methodsTable]);

    expect(marks).toEqual([
      { partKey: 'p1', fieldId: 'methods', rowIndex: 0, columnKey: 'used' },
      { partKey: 'p2', fieldId: 'methods', rowIndex: 1, columnKey: 'used' },
      { partKey: 'p3', fieldId: 'methods', rowIndex: 2, columnKey: 'used' },
    ]);
    // The declaration part shares number 2 and no words with the row — it
    // must not steal or duplicate the practical's tick.
    expect(marks.some((m) => m.partKey === 'p2d')).toBe(false);
  });

  it('proposes nothing from a table matching fewer than two parts', async () => {
    const { proposePartCompletionMarks } = await import('./builder-manifest.js');

    expect(
      proposePartCompletionMarks([PARTS[0]!], [methodsTable]),
    ).toEqual([]);
  });

  it('proposes nothing from a multi-answer-column table', async () => {
    const { proposePartCompletionMarks } = await import('./builder-manifest.js');
    const twoColumns = {
      ...methodsTable,
      columns: [
        ...methodsTable.columns,
        { key: 'na', label: 'N/A', type: 'checkbox' as const },
      ],
    };

    expect(proposePartCompletionMarks(PARTS, [twoColumns])).toEqual([]);
  });

  it('reaches the built manifest', async () => {
    const { buildManifest, derivePartsFromStructure } = await import('./builder-manifest.js');
    void derivePartsFromStructure;
    const manifest = buildManifest([], [methodsTable]);
    // No parts derived → nothing to map; the property stays absent rather
    // than empty, like every other unproposed pointer.
    expect(manifest.partCompletionMarks).toBeUndefined();
  });
});
