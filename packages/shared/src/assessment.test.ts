/**
 * The manifest is what tells every downstream surface which fields belong to
 * which part — fill scopes to it, export assembles from it, progress reports
 * against it. A manifest that validates but points at the wrong version would
 * export a silently-blank part on an evidence document, so these fix the
 * rejection rules as tightly as the ordering ones (U1, R1/R2/R4).
 */
import { describe, expect, it } from 'vitest';
import type { FormField } from './form-field.js';
import {
  type AssessmentPart,
  type AssessmentToolManifest,
  type AttemptFact,
  type PartOutcome,
  caseProgress,
  fieldsInPart,
  isCaseCompetent,
  orderedParts,
  requiredParts,
  totalLoggedHours,
  validateAnswerKeys,
  validateManifest,
} from './assessment.js';

const header = (id: string): FormField => ({
  id,
  type: 'section_header',
  label: id,
  required: false,
  source: 'imported',
});

const question = (id: string, extra: Partial<FormField> = {}): FormField => ({
  id,
  type: 'checkbox_group',
  label: id,
  required: true,
  source: 'imported',
  options: ['a', 'b', 'c'],
  ...extra,
});

const part = (over: Partial<AssessmentPart> & Pick<AssessmentPart, 'key' | 'ordinal'>): AssessmentPart => ({
  label: `Part ${over.ordinal}`,
  kind: 'practical',
  pathways: ['experienced', 'new', 'rpl'],
  startFieldId: `h${over.ordinal}`,
  ...over,
});

const fields = [header('h1'), header('h2'), header('h3')];

describe('orderedParts', () => {
  it('returns parts in printed order regardless of authoring order', () => {
    const manifest: AssessmentToolManifest = {
      parts: [part({ key: 'c', ordinal: 3 }), part({ key: 'a', ordinal: 1 }), part({ key: 'b', ordinal: 2 })],
    };

    expect(orderedParts(manifest).map((p) => p.key)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the manifest it was given', () => {
    const manifest: AssessmentToolManifest = {
      parts: [part({ key: 'c', ordinal: 3 }), part({ key: 'a', ordinal: 1 })],
    };

    orderedParts(manifest);

    expect(manifest.parts.map((p) => p.key)).toEqual(['c', 'a']);
  });
});

describe('requiredParts', () => {
  const manifest: AssessmentToolManifest = {
    parts: [
      part({ key: 'theory', ordinal: 1, kind: 'theory' }),
      part({ key: 'prac-1', ordinal: 2 }),
      part({ key: 'log-1', ordinal: 3, kind: 'logbook', minimumHours: 20, pathways: ['new'] }),
      part({ key: 'prac-2', ordinal: 4, pathways: ['new'] }),
    ],
  };

  it('gives an experienced candidate only the parts declared for that pathway', () => {
    expect(requiredParts(manifest, 'experienced').map((p) => p.key)).toEqual(['theory', 'prac-1']);
  });

  it('gives a new candidate every part', () => {
    expect(requiredParts(manifest, 'new').map((p) => p.key)).toEqual([
      'theory',
      'prac-1',
      'log-1',
      'prac-2',
    ]);
  });

  it('waives the logged-hours parts on the RPL pathway', () => {
    const keys = requiredParts(manifest, 'rpl').map((p) => p.key);

    expect(keys).toEqual(['theory', 'prac-1']);
    expect(keys).not.toContain('log-1');
  });
});

describe('validateManifest', () => {
  it('accepts a well-formed manifest', () => {
    const manifest: AssessmentToolManifest = {
      parts: [part({ key: 'a', ordinal: 1 }), part({ key: 'b', ordinal: 2 })],
    };

    expect(validateManifest(manifest, fields)).toEqual([]);
  });

  it('rejects a start field that is not in this version', () => {
    const manifest: AssessmentToolManifest = {
      parts: [part({ key: 'a', ordinal: 1, startFieldId: 'gone' })],
    };

    const problems = validateManifest(manifest, fields);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('gone');
  });

  it('accepts a start field that is not a section header', () => {
    // Extraction emits input fields, not printed headings — anchoring to a
    // question or a table is the normal case, not a degraded one.
    const manifest: AssessmentToolManifest = {
      parts: [part({ key: 'a', ordinal: 1, startFieldId: 'q1' })],
    };

    expect(validateManifest(manifest, [...fields, question('q1')])).toEqual([]);
  });

  it('rejects a mandatory field id that is not in this version', () => {
    const manifest: AssessmentToolManifest = {
      parts: [part({ key: 'a', ordinal: 1, mandatoryFieldIds: ['ghost'] })],
    };

    expect(validateManifest(manifest, fields).some((p) => p.includes('ghost'))).toBe(true);
  });

  it('reports every problem rather than stopping at the first', () => {
    const manifest: AssessmentToolManifest = {
      parts: [
        part({ key: 'dup', ordinal: 1 }),
        part({ key: 'dup', ordinal: 1, startFieldId: 'missing' }),
      ],
    };

    // Duplicate key, duplicate ordinal, and an unresolvable start field.
    expect(validateManifest(manifest, fields).length).toBeGreaterThanOrEqual(3);
  });

  it('rejects a logbook part with no positive hours minimum', () => {
    const manifest: AssessmentToolManifest = {
      parts: [part({ key: 'log', ordinal: 1, kind: 'logbook' })],
    };

    expect(validateManifest(manifest, fields).some((p) => p.includes('minimumHours'))).toBe(true);
  });

  it('rejects a part belonging to no pathway', () => {
    const manifest: AssessmentToolManifest = {
      parts: [part({ key: 'orphan', ordinal: 1, pathways: [] })],
    };

    expect(validateManifest(manifest, fields).some((p) => p.includes('no pathway'))).toBe(true);
  });

  it('rejects an empty manifest', () => {
    expect(validateManifest({ parts: [] }, fields)).toHaveLength(1);
  });
});

describe('validateAnswerKeys', () => {
  it('accepts a field with neither a key nor a target', () => {
    expect(validateAnswerKeys([question('q1')])).toEqual([]);
  });

  it('accepts a keyed field that targets a real outcome field', () => {
    const outcome = { id: 'o1', type: 'check_cross', label: 'o1', required: false, source: 'imported' } as FormField;
    const q = question('q1', { answerKey: ['a'], outcomeTarget: { fieldId: 'o1' } });

    expect(validateAnswerKeys([q, outcome])).toEqual([]);
  });

  it('rejects an answer key with no outcome target', () => {
    const q = question('q1', { answerKey: ['a'] });

    const problems = validateAnswerKeys([q]);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no outcome target');
  });

  it('rejects an outcome target that is not in this version', () => {
    const q = question('q1', { answerKey: ['a'], outcomeTarget: { fieldId: 'nope' } });

    expect(validateAnswerKeys([q]).some((p) => p.includes('nope'))).toBe(true);
  });

  it('rejects a keyed option the question does not offer', () => {
    const outcome = { id: 'o1', type: 'check_cross', label: 'o1', required: false, source: 'imported' } as FormField;
    const q = question('q1', { answerKey: ['a', 'z'], outcomeTarget: { fieldId: 'o1' } });

    expect(validateAnswerKeys([q, outcome]).some((p) => p.includes('"z"'))).toBe(true);
  });

  it('rejects an empty answer key', () => {
    const outcome = { id: 'o1', type: 'check_cross', label: 'o1', required: false, source: 'imported' } as FormField;
    const q = question('q1', { answerKey: [], outcomeTarget: { fieldId: 'o1' } });

    expect(validateAnswerKeys([q, outcome]).some((p) => p.includes('empty answer key'))).toBe(true);
  });
});

/**
 * Progress is DERIVED, never stored. These pin the two rules that make it
 * trustworthy: a part that has ever passed stays passed (the evidence document
 * renders that attempt), and a part stays locked until every earlier required
 * part has passed — which is what stops a final demonstration happening before
 * the hours it depends on are logged (U6/U7, R19/R20).
 */
describe('caseProgress', () => {
  const manifest: AssessmentToolManifest = {
    parts: [
      part({ key: 'p1', ordinal: 1, kind: 'theory' }),
      part({ key: 'p2', ordinal: 2 }),
      part({ key: 'p3', ordinal: 3, kind: 'logbook', minimumHours: 20, pathways: ['new'] }),
      part({ key: 'p4', ordinal: 4, pathways: ['new'] }),
    ],
  };

  const at = (partKey: string, attemptNumber: number, outcome: PartOutcome | null): AttemptFact => ({
    partKey,
    attemptNumber,
    outcome,
  });

  it('opens the first part and locks the rest when nothing has happened', () => {
    const p = caseProgress(manifest, 'new', []);

    expect(p.map((x) => x.state)).toEqual(['open', 'locked', 'locked', 'locked']);
  });

  it('unlocks the next part only once the previous one passes', () => {
    const p = caseProgress(manifest, 'new', [at('p1', 1, 'satisfactory')]);

    expect(p.map((x) => x.state)).toEqual(['satisfactory', 'open', 'locked', 'locked']);
  });

  it('keeps a failed part actionable rather than locking it', () => {
    const p = caseProgress(manifest, 'new', [at('p1', 1, 'not_satisfactory')]);

    expect(p[0]?.state).toBe('not_satisfactory');
    expect(p[1]?.state).toBe('locked');
  });

  it('treats a part as satisfactory once any attempt passed, and counts them all', () => {
    const p = caseProgress(manifest, 'new', [
      at('p1', 1, 'not_satisfactory'),
      at('p1', 2, 'satisfactory'),
    ]);

    expect(p[0]?.state).toBe('satisfactory');
    expect(p[0]?.attempts).toBe(2);
    expect(p[0]?.latestOutcome).toBe('satisfactory');
  });

  it('does not lock a later part because an earlier one was retried', () => {
    const p = caseProgress(manifest, 'new', [
      at('p1', 1, 'not_satisfactory'),
      at('p1', 2, 'satisfactory'),
      at('p2', 1, 'satisfactory'),
    ]);

    expect(p[2]?.state).toBe('open');
  });

  it('reports an unresolved attempt as open, not satisfied', () => {
    const p = caseProgress(manifest, 'new', [at('p1', 1, null)]);

    expect(p[0]?.state).toBe('open');
    expect(p[0]?.latestOutcome).toBeNull();
    expect(p[1]?.state).toBe('locked');
  });

  it('only considers the parts the pathway requires', () => {
    const p = caseProgress(manifest, 'experienced', [at('p1', 1, 'satisfactory')]);

    expect(p.map((x) => x.part.key)).toEqual(['p1', 'p2']);
  });
});

describe('isCaseCompetent', () => {
  const manifest: AssessmentToolManifest = {
    parts: [part({ key: 'p1', ordinal: 1 }), part({ key: 'p2', ordinal: 2 })],
  };

  it('is competent only when every required part has passed', () => {
    const all = caseProgress(manifest, 'experienced', [
      { partKey: 'p1', attemptNumber: 1, outcome: 'satisfactory' },
      { partKey: 'p2', attemptNumber: 1, outcome: 'satisfactory' },
    ]);
    expect(isCaseCompetent(all)).toBe(true);
  });

  it('is not competent while any part is outstanding', () => {
    const some = caseProgress(manifest, 'experienced', [
      { partKey: 'p1', attemptNumber: 1, outcome: 'satisfactory' },
    ]);
    expect(isCaseCompetent(some)).toBe(false);
  });

  it('is not competent for an empty progress list', () => {
    expect(isCaseCompetent([])).toBe(false);
  });
});

describe('totalLoggedHours', () => {
  it('sums the duration column', () => {
    expect(totalLoggedHours([{ d: 4 }, { d: 3.5 }], 'd')).toBe(7.5);
  });

  it('parses numeric strings', () => {
    expect(totalLoggedHours([{ d: '4' }, { d: '2.25' }], 'd')).toBe(6.25);
  });

  it('ignores blank, malformed and negative cells rather than throwing', () => {
    expect(totalLoggedHours([{ d: 4 }, { d: '' }, { d: 'half a shift' }, { d: -2 }], 'd')).toBe(4);
  });

  it('returns 0 for no rows', () => {
    expect(totalLoggedHours([], 'd')).toBe(0);
  });
});

/**
 * Part ranges are computed from the manifest's own ordering, not from document
 * furniture — which is what lets a template with no section headers still have
 * well-defined parts. The failure this pins is the dangerous one: a stale
 * anchor must yield an EMPTY part, never the whole remainder of the document.
 */
describe('fieldsInPart', () => {
  const docFields: FormField[] = [
    question('q1'),
    question('q2'),
    header('h-mid'),
    question('q3'),
    question('q4'),
    question('q5'),
  ];

  const manifest: AssessmentToolManifest = {
    parts: [
      part({ key: 'one', ordinal: 1, startFieldId: 'q1' }),
      part({ key: 'two', ordinal: 2, startFieldId: 'q3' }),
    ],
  };

  it('runs from the start field, inclusive, to the next part start', () => {
    expect(fieldsInPart(docFields, manifest, 'one').map((f) => f.id)).toEqual(['q1', 'q2', 'h-mid']);
  });

  it('runs the last part to the end of the document', () => {
    expect(fieldsInPart(docFields, manifest, 'two').map((f) => f.id)).toEqual(['q3', 'q4', 'q5']);
  });

  it('anchors on any field type, not just a header', () => {
    expect(fieldsInPart(docFields, manifest, 'one')[0]?.type).toBe('checkbox_group');
  });

  it('returns nothing for an unknown part key', () => {
    expect(fieldsInPart(docFields, manifest, 'nope')).toEqual([]);
  });

  it('returns nothing — not the rest of the document — when the anchor is stale', () => {
    const stale: AssessmentToolManifest = {
      parts: [part({ key: 'ghost', ordinal: 1, startFieldId: 'deleted' })],
    };

    expect(fieldsInPart(docFields, stale, 'ghost')).toEqual([]);
  });

  it('does not let a broken neighbour truncate a part', () => {
    const mixed: AssessmentToolManifest = {
      parts: [
        part({ key: 'one', ordinal: 1, startFieldId: 'q1' }),
        part({ key: 'broken', ordinal: 2, startFieldId: 'deleted' }),
        part({ key: 'three', ordinal: 3, startFieldId: 'q4' }),
      ],
    };

    // 'broken' cannot bound 'one', so 'one' runs to the next anchor that resolves.
    expect(fieldsInPart(docFields, mixed, 'one').map((f) => f.id)).toEqual([
      'q1',
      'q2',
      'h-mid',
      'q3',
    ]);
  });

  it('respects document order over authoring order', () => {
    const reversed: AssessmentToolManifest = {
      parts: [
        part({ key: 'two', ordinal: 2, startFieldId: 'q3' }),
        part({ key: 'one', ordinal: 1, startFieldId: 'q1' }),
      ],
    };

    expect(fieldsInPart(docFields, reversed, 'one').map((f) => f.id)).toEqual(['q1', 'q2', 'h-mid']);
  });
});
