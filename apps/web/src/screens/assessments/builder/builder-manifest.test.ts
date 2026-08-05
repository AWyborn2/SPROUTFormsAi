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
      { id: 'n', label: 'Candidate Name', coverSection: 'candidate_declaration' as const },
    ]);
    expect(manifest.candidateNameFieldId).toBe('n');
  });

  it('proposes nothing when no cover field looks like a name box', () => {
    const manifest = buildManifest([], [
      { id: 'c', label: 'Company', coverSection: 'candidate_declaration' as const },
    ]);
    expect(manifest.candidateNameFieldId).toBeUndefined();
  });

  it('never takes a name box from outside the cover page', () => {
    // coverSection is bounded to the document's FIRST page by rule 8; a
    // per-part sign-off prints the same words and carries none.
    const manifest = buildManifest([], [
      { id: 'n', label: 'Candidate Name' },
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
