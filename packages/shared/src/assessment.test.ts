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
  CASE_STATES,
  caseProgress,
  convertDurationValue,
  durationUnitLong,
  durationUnitShort,
  fieldsInPart,
  fieldsInSection,
  isCaseCompetent,
  isTerminalCaseState,
  moreCoachingRequired,
  nextStepAfter,
  type NextStepPart,
  orderedParts,
  pathwayFromHistory,
  requiredParts,
  resolveLocationParts,
  theoryRetryOf,
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

describe('resolveLocationParts', () => {
  // Three theory sections; the location rule picks which apply where (U9).
  const ALL = ['t1', 't2', 't3'];
  const MINING = 'loc-mining';
  const RAW = 'loc-raw';
  const OFFICE = 'loc-office';

  it('requires exactly the parts a Location selects', () => {
    const rule = { [MINING]: ['t1', 't2'], [RAW]: ['t2', 't3'] };

    expect(resolveLocationParts(ALL, rule, [MINING])).toEqual(['t1', 't2']);
    expect(resolveLocationParts(ALL, rule, [RAW])).toEqual(['t2', 't3']);
  });

  it('requires every part at a Location the rule does not mention (R75)', () => {
    const rule = { [MINING]: ['t1'] };

    expect(resolveLocationParts(ALL, rule, [OFFICE])).toEqual(ALL);
  });

  it('requires every part at every Location when there is no rule at all (R75)', () => {
    expect(resolveLocationParts(ALL, {}, [MINING])).toEqual(ALL);
  });

  it('requires every part at a Location added after the tool was written (R75)', () => {
    // OFFICE postdates a rule that only ever mentioned MINING — same absence.
    const rule = { [MINING]: ['t1', 't2'] };

    expect(resolveLocationParts(ALL, rule, [OFFICE])).toEqual(ALL);
  });

  it('takes the union across Locations whose rules differ (R80)', () => {
    const rule = { [MINING]: ['t1', 't2'], [RAW]: ['t2', 't3'] };

    expect(resolveLocationParts(ALL, rule, [MINING, RAW])).toEqual(['t1', 't2', 't3']);
  });

  it('returns one set for a person at several Locations, not one per site (R81)', () => {
    const rule = { [MINING]: ['t1', 't2'], [RAW]: ['t1', 't2'] };

    // The two overlap entirely — the union is that set once, never doubled.
    expect(resolveLocationParts(ALL, rule, [MINING, RAW])).toEqual(['t1', 't2']);
  });

  it('widens to every part if any held Location has no rule', () => {
    // MINING narrows, OFFICE does not — the union with "everything" is everything.
    const rule = { [MINING]: ['t1'] };

    expect(resolveLocationParts(ALL, rule, [MINING, OFFICE])).toEqual(ALL);
  });

  it('requires every part for a person placed at no Location', () => {
    const rule = { [MINING]: ['t1'] };

    expect(resolveLocationParts(ALL, rule, [])).toEqual(ALL);
  });

  it('returns the union in document order, not the order Locations were listed', () => {
    const rule = { [MINING]: ['t3'], [RAW]: ['t1'] };

    expect(resolveLocationParts(ALL, rule, [MINING, RAW])).toEqual(['t1', 't3']);
  });

  it('drops a listed key the manifest no longer declares', () => {
    const rule = { [MINING]: ['t1', 'gone'] };

    expect(resolveLocationParts(ALL, rule, [MINING])).toEqual(['t1']);
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

  /*
    A MUST-PASS QUESTION THAT CANNOT BE MARKED IS A LIE.

    `markTheory` skips any field without an answerKey, and `validateAnswerKeys`
    only inspects fields that HAVE one — so an unkeyed question passed every
    check while contributing nothing to the outcome it was declared to gate.
    The theory paper's matching questions are exactly this: extracted as
    free-response text, sitting in the must-pass section, silently unmarked,
    with the part free to reach 100% without them.
  */
  it('rejects a mandatory question with no answer key', () => {
    const manifest: AssessmentToolManifest = {
      parts: [part({ key: 'a', ordinal: 1, mandatoryFieldIds: ['q-match'] })],
    };

    const problems = validateManifest(manifest, [...fields, question('q-match')]);

    expect(problems.some((p) => p.includes('q-match') && p.includes('answer key'))).toBe(true);
  });

  it('rejects a mandatory question whose answer key is empty', () => {
    // An empty key marks nothing, exactly like a missing one — `markTheory`
    // tests `length === 0` on the same line as the absent case.
    const manifest: AssessmentToolManifest = {
      parts: [part({ key: 'a', ordinal: 1, mandatoryFieldIds: ['q-empty'] })],
    };

    const problems = validateManifest(manifest, [...fields, question('q-empty', { answerKey: [] })]);

    expect(problems.some((p) => p.includes('q-empty'))).toBe(true);
  });

  it('accepts a mandatory question that carries a key', () => {
    const keyed = question('q-keyed', { answerKey: ['a'], outcomeTarget: { fieldId: 'oc-1' } });
    const manifest: AssessmentToolManifest = {
      parts: [part({ key: 'a', ordinal: 1, mandatoryFieldIds: ['q-keyed'] })],
    };

    expect(validateManifest(manifest, [...fields, keyed])).toEqual([]);
  });

  it('says nothing about an unkeyed question OUTSIDE the mandatory set', () => {
    /*
      The rule is about the must-pass set, not about answer keys in general. A
      question the assessor marks by hand is a real shape — it simply does not
      gate the outcome, which is exactly what leaving it out of
      `mandatoryFieldIds` says.
    */
    const manifest: AssessmentToolManifest = { parts: [part({ key: 'a', ordinal: 1 })] };

    expect(validateManifest(manifest, [...fields, question('q-free')])).toEqual([]);
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

  describe('logbook per-task minimums', () => {
    const LOG_COLUMNS: FormField['columns'] = [
      { key: 'task', label: 'Task', type: 'dropdown', options: ['Topsoil', 'Gravel'] },
      { key: 'duration', label: 'Duration', type: 'number' },
    ];
    const table = (columns = LOG_COLUMNS): FormField => ({
      id: 'log-table',
      type: 'repeating_group',
      label: 'Log',
      required: false,
      source: 'imported',
      columns,
    });
    /** A valid logbook part except for whatever the test puts in taskMinimums. */
    function check(
      taskMinimums: NonNullable<AssessmentPart['taskMinimums']>,
      columns = LOG_COLUMNS,
    ): string[] {
      const manifest: AssessmentToolManifest = {
        parts: [
          part({
            key: 'log',
            ordinal: 1,
            kind: 'logbook',
            minimumHours: 50,
            durationColumnKey: 'duration',
            pathways: ['new'],
            taskMinimums,
          }),
        ],
      };
      return validateManifest(manifest, [header('h1'), table(columns)]);
    }

    it('accepts targets that name real options with positive hours', () => {
      expect(
        check({
          columnKey: 'task',
          targets: [
            { value: 'Topsoil', minimumHours: 10 },
            { value: 'Gravel', minimumHours: 10 },
          ],
        }),
      ).toEqual([]);
    });

    it('rejects a task column that is not in the table', () => {
      const problems = check({ columnKey: 'ghost', targets: [{ value: 'Topsoil', minimumHours: 10 }] });
      expect(problems.some((p) => p.includes('task column "ghost"') && p.includes('not a column'))).toBe(true);
    });

    it('rejects a task column with no options to choose from', () => {
      const columns: FormField['columns'] = [
        { key: 'task', label: 'Task', type: 'text' },
        { key: 'duration', label: 'Duration', type: 'number' },
      ];
      const problems = check({ columnKey: 'task', targets: [{ value: 'Topsoil', minimumHours: 10 }] }, columns);
      expect(problems.some((p) => p.includes('has no options'))).toBe(true);
    });

    it('rejects a target value the dropdown never offers', () => {
      const problems = check({ columnKey: 'task', targets: [{ value: 'Stockpile', minimumHours: 10 }] });
      expect(problems.some((p) => p.includes('task target "Stockpile"') && p.includes('not one of'))).toBe(true);
    });

    it('rejects a non-positive per-task minimum', () => {
      const problems = check({ columnKey: 'task', targets: [{ value: 'Topsoil', minimumHours: 0 }] });
      expect(problems.some((p) => p.includes('task "Topsoil"') && p.includes('positive minimumHours'))).toBe(true);
    });

    it('rejects the same task listed twice', () => {
      const problems = check({
        columnKey: 'task',
        targets: [
          { value: 'Topsoil', minimumHours: 10 },
          { value: 'Topsoil', minimumHours: 5 },
        ],
      });
      expect(problems.some((p) => p.includes('"Topsoil"') && p.includes('more than once'))).toBe(true);
    });

    it('rejects task minimums declared with no targets at all', () => {
      const problems = check({ columnKey: 'task', targets: [] });
      expect(problems.some((p) => p.includes('no targets'))).toBe(true);
    });
  });

  describe('logbook row routing', () => {
    const table = (id: string, columns?: FormField['columns']): FormField => ({
      id,
      type: 'repeating_group',
      label: id,
      required: false,
      source: 'imported',
      ...(columns ? { columns } : {}),
    });
    const SRC_COLUMNS: FormField['columns'] = [
      { key: 'task', label: 'Task', type: 'dropdown', options: ['Topsoil', 'Gravel'] },
      { key: 'duration', label: 'Duration', type: 'number' },
    ];
    // h1 anchors the part; src is the first table (so durationColumnKey resolves),
    // then two print-only target tables.
    const routingFields = (): FormField[] => [
      header('h1'),
      table('src', SRC_COLUMNS),
      table('tgt-topsoil'),
      table('tgt-gravel'),
    ];
    function check(
      routing: NonNullable<AssessmentPart['logbookRouting']>,
      fields = routingFields(),
    ): string[] {
      const manifest: AssessmentToolManifest = {
        parts: [
          part({
            key: 'log',
            ordinal: 1,
            kind: 'logbook',
            minimumHours: 50,
            durationColumnKey: 'duration',
            pathways: ['new'],
            logbookRouting: routing,
          }),
        ],
      };
      return validateManifest(manifest, fields);
    }

    it('accepts routes to real tables on real option values', () => {
      expect(
        check({
          sourceFieldId: 'src',
          columnKey: 'task',
          routes: [
            { value: 'Topsoil', fieldId: 'tgt-topsoil' },
            { value: 'Gravel', fieldId: 'tgt-gravel' },
          ],
        }),
      ).toEqual([]);
    });

    it('rejects a source that is not a table', () => {
      const problems = check({
        sourceFieldId: 'h1',
        columnKey: 'task',
        routes: [{ value: 'Topsoil', fieldId: 'tgt-topsoil' }],
      });
      expect(problems.some((p) => p.includes('routing source') && p.includes('not a table'))).toBe(true);
    });

    it('rejects a routing column not on the source', () => {
      const problems = check({
        sourceFieldId: 'src',
        columnKey: 'ghost',
        routes: [{ value: 'Topsoil', fieldId: 'tgt-topsoil' }],
      });
      expect(problems.some((p) => p.includes('routing column "ghost"'))).toBe(true);
    });

    it('rejects a task value the column never offers', () => {
      const problems = check({
        sourceFieldId: 'src',
        columnKey: 'task',
        routes: [{ value: 'Stockpile', fieldId: 'tgt-topsoil' }],
      });
      expect(problems.some((p) => p.includes('routes task "Stockpile"'))).toBe(true);
    });

    it('rejects a target that is not a table', () => {
      const problems = check({
        sourceFieldId: 'src',
        columnKey: 'task',
        routes: [{ value: 'Topsoil', fieldId: 'h1' }],
      });
      expect(problems.some((p) => p.includes('to "h1"') && p.includes('not a table'))).toBe(true);
    });

    it('rejects routing a task onto the source table itself', () => {
      const problems = check({
        sourceFieldId: 'src',
        columnKey: 'task',
        routes: [{ value: 'Topsoil', fieldId: 'src' }],
      });
      expect(problems.some((p) => p.includes('onto its own source table'))).toBe(true);
    });

    it('rejects two tasks routed to the same table — one would overwrite the other', () => {
      const problems = check({
        sourceFieldId: 'src',
        columnKey: 'task',
        routes: [
          { value: 'Topsoil', fieldId: 'tgt-topsoil' },
          { value: 'Gravel', fieldId: 'tgt-topsoil' },
        ],
      });
      expect(problems.some((p) => p.includes('same table'))).toBe(true);
    });

    it('rejects the same task value routed twice', () => {
      const problems = check({
        sourceFieldId: 'src',
        columnKey: 'task',
        routes: [
          { value: 'Topsoil', fieldId: 'tgt-topsoil' },
          { value: 'Topsoil', fieldId: 'tgt-gravel' },
        ],
      });
      expect(problems.some((p) => p.includes('routes task "Topsoil" more than once'))).toBe(true);
    });
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

  it('FLAGS A MODEL ANSWER ON AN OPTIONS-BEARING FIELD — choice questions take keys, not prose', () => {
    /*
      The author-confusion case: a marking guide beside a question the machine
      already marks (or should be keyed to mark) would never be read, and its
      presence says the author reached for the wrong instrument.
    */
    const q = question('q1', { modelAnswer: 'radio channel 2, then wait for clearance' });

    expect(validateAnswerKeys([q]).some((p) => p.includes('model answer'))).toBe(true);
  });

  it('accepts a written question with a model answer and no target — a guide alone is legitimate', () => {
    const written = question('q1', { type: 'textarea', options: undefined, modelAnswer: 'the expected prose' });

    expect(validateAnswerKeys([written])).toEqual([]);
  });

  it('accepts a written question with a model answer AND an outcome target — the assessor’s tick has a home', () => {
    const outcome = { id: 'o1', type: 'check_cross', label: 'o1', required: false, source: 'imported' } as FormField;
    const written = question('q1', {
      type: 'text',
      options: undefined,
      modelAnswer: 'the expected prose',
      outcomeTarget: { fieldId: 'o1' },
    });

    // No answerKey, so the key-implies-target chain never engages: an unkeyed
    // target is the assessor's box, not a marking misconfiguration.
    expect(validateAnswerKeys([written, outcome])).toEqual([]);
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

  /**
   * An authored workflow's `requires` REPLACES the document-order rule for the
   * sections that declare it. The shape pinned here is the real one: a
   * declaration prints on the cover page (document-first) but is signed after
   * the theory it vouches for — so the dependency points FORWARD in document
   * order, which no sequential sweep can express.
   */
  describe('with authored requires', () => {
    const declThenTheory: AssessmentToolManifest = {
      parts: [
        part({ key: 'decl', ordinal: 1 }),
        part({ key: 'theory', ordinal: 2, kind: 'theory' }),
      ],
      workflow: {
        roles: ['candidate', 'assessor'],
        sections: [
          { key: 's_theory', ordinal: 1, label: 'Theory', partKey: 'theory', access: { candidate: 'fill' }, requires: [] },
          { key: 's_decl', ordinal: 2, label: 'Declaration', partKey: 'decl', access: { candidate: 'fill' }, requires: ['s_theory'] },
        ],
      },
    };

    it('opens a part with an empty requires straight away, wherever it prints', () => {
      const p = caseProgress(declThenTheory, 'experienced', []);

      // Sequential order would open the declaration (printed first) and lock
      // the theory behind it — exactly backwards for how the work happens.
      expect(p.map((x) => [x.part.key, x.state])).toEqual([
        ['decl', 'locked'],
        ['theory', 'open'],
      ]);
    });

    it('unlocks a dependent part the moment its requirement passes', () => {
      const p = caseProgress(declThenTheory, 'experienced', [at('theory', 1, 'satisfactory')]);

      expect(p.find((x) => x.part.key === 'decl')?.state).toBe('open');
    });

    it('keeps the sequential rule for sections that declare nothing', () => {
      const mixed: AssessmentToolManifest = {
        ...declThenTheory,
        workflow: {
          roles: ['candidate'],
          sections: [
            { key: 's_decl', ordinal: 1, label: 'Declaration', partKey: 'decl', access: { candidate: 'fill' } },
            { key: 's_theory', ordinal: 2, label: 'Theory', partKey: 'theory', access: { candidate: 'fill' } },
          ],
        },
      };
      const p = caseProgress(mixed, 'experienced', []);

      expect(p.map((x) => x.state)).toEqual(['open', 'locked']);
    });

    it('waives a dependency on a section with no part, and on a part the pathway does not include', () => {
      const waived: AssessmentToolManifest = {
        parts: [
          part({ key: 'log', ordinal: 1, kind: 'logbook', minimumHours: 10, pathways: ['new'] }),
          part({ key: 'final', ordinal: 2 }),
        ],
        workflow: {
          roles: ['candidate'],
          sections: [
            { key: 's_cover', ordinal: 1, label: 'Cover', fieldIds: ['x'], access: { candidate: 'view' } },
            { key: 's_log', ordinal: 2, label: 'Logbook', partKey: 'log', access: { candidate: 'fill' }, requires: [] },
            { key: 's_final', ordinal: 3, label: 'Final', partKey: 'final', access: { candidate: 'fill' }, requires: ['s_cover', 's_log'] },
          ],
        },
      };

      // RPL waives the logbook, so the dependency on it must waive too — a
      // gate nobody can ever satisfy is a deadlock, not a safety rule.
      const p = caseProgress(waived, 'rpl', []);
      expect(p.map((x) => [x.part.key, x.state])).toEqual([['final', 'open']]);

      // On the pathway that includes the logbook, the gate bites.
      const gated = caseProgress(waived, 'new', []);
      expect(gated.find((x) => x.part.key === 'final')?.state).toBe('locked');
    });
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

/**
 * The front page prints TWO boxes — "more coaching required: Yes" and "No" —
 * and exactly one is ticked. Both are positive statements, so neither can be
 * expressed as the absence of the other: a blank pair has to go on meaning
 * "nobody finished this form".
 *
 * The rule reads each part's FINAL state, by explicit decision of the training
 * authority. A part failed once and passed on the retry counts as satisfactory,
 * because coaching happened and worked; the attempt history keeps the failure
 * for anyone who needs the journey.
 */
describe('moreCoachingRequired', () => {
  const manifest: AssessmentToolManifest = {
    parts: [part({ key: 'p1', ordinal: 1 }), part({ key: 'p2', ordinal: 2 })],
  };

  it('answers No when every part ended satisfactory', () => {
    const p = caseProgress(manifest, 'experienced', [
      { partKey: 'p1', attemptNumber: 1, outcome: 'satisfactory' },
      { partKey: 'p2', attemptNumber: 1, outcome: 'satisfactory' },
    ]);
    expect(moreCoachingRequired(p)).toBe(false);
  });

  it('answers No when a part failed and then passed on retry', () => {
    // The decision separating "final state" from "any failure ever". If this
    // flips, every candidate who ever needed a second go is marked as needing
    // more coaching on a record that simultaneously says they are competent.
    const p = caseProgress(manifest, 'experienced', [
      { partKey: 'p1', attemptNumber: 1, outcome: 'not_satisfactory' },
      { partKey: 'p1', attemptNumber: 2, outcome: 'satisfactory' },
      { partKey: 'p2', attemptNumber: 1, outcome: 'satisfactory' },
    ]);
    expect(moreCoachingRequired(p)).toBe(false);
  });

  it('answers Yes while a part stands unsatisfactory', () => {
    const p = caseProgress(manifest, 'experienced', [
      { partKey: 'p1', attemptNumber: 1, outcome: 'satisfactory' },
      { partKey: 'p2', attemptNumber: 1, outcome: 'not_satisfactory' },
    ]);
    expect(moreCoachingRequired(p)).toBe(true);
  });

  it('ticks NEITHER box while a part is simply unattempted', () => {
    // An unfinished form is not a coaching finding. Ticking either box here
    // would print a conclusion nobody reached.
    const p = caseProgress(manifest, 'experienced', [
      { partKey: 'p1', attemptNumber: 1, outcome: 'satisfactory' },
    ]);
    expect(moreCoachingRequired(p)).toBeNull();
  });

  it('ticks neither box on a case with no progress at all', () => {
    expect(moreCoachingRequired([])).toBeNull();
  });

  it('never disagrees with isCaseCompetent about a competent case', () => {
    // A signed-off case is competent by definition, so its answer is always No.
    // If these two diverge the front page contradicts its own verdict.
    const p = caseProgress(manifest, 'experienced', [
      { partKey: 'p1', attemptNumber: 1, outcome: 'not_satisfactory' },
      { partKey: 'p1', attemptNumber: 2, outcome: 'satisfactory' },
      { partKey: 'p2', attemptNumber: 1, outcome: 'satisfactory' },
    ]);
    expect(isCaseCompetent(p)).toBe(true);
    expect(moreCoachingRequired(p)).toBe(false);
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

  it('does not adopt a prerequisite box a cover section prints between two parts', () => {
    // A cover section (here "Prerequisites") placed AFTER a part rather than at
    // the document head has no anchor of its own, so this part's [anchor, next
    // anchor) range runs straight through it. The prerequisite box is answered
    // from the register, never by the part — it must not be sliced in, or a
    // required box no candidate can fill jams the declaration's hand-in gate.
    const withPrereq: FormField[] = [
      question('sig'), // the declaration part's only real field
      question('prereq'), // the cover "Prerequisites" section's licence box
      question('q3'), // the next part starts here
    ];
    const manifestWithPrereq: AssessmentToolManifest = {
      parts: [
        part({ key: 'decl', ordinal: 1, startFieldId: 'sig' }),
        part({ key: 'next', ordinal: 2, startFieldId: 'q3' }),
      ],
      prerequisiteChecks: [{ fieldId: 'prereq', competencyIds: ['licence-c'] }],
    };

    expect(fieldsInPart(withPrereq, manifestWithPrereq, 'decl').map((f) => f.id)).toEqual(['sig']);
    // The next part is unaffected — the box sat before its anchor either way.
    expect(fieldsInPart(withPrereq, manifestWithPrereq, 'next').map((f) => f.id)).toEqual(['q3']);
  });
});

describe('duration units', () => {
  it('labels default to hours when the unit is omitted', () => {
    expect(durationUnitShort(undefined)).toBe('hrs');
    expect(durationUnitLong(undefined)).toBe('hours');
    expect(durationUnitShort('hours')).toBe('hrs');
    expect(durationUnitLong('minutes')).toBe('minutes');
  });

  it('converts a figure between units, rounded, meaning preserved', () => {
    expect(convertDurationValue(0.25, 'hours', 'minutes')).toBe(15);
    expect(convertDurationValue(15, 'minutes', 'hours')).toBe(0.25);
    expect(convertDurationValue(0.1, 'hours', 'minutes')).toBe(6);
    // Same unit is a no-op; non-finite passes through untouched.
    expect(convertDurationValue(3, 'hours', 'hours')).toBe(3);
    expect(convertDurationValue(Number.NaN, 'hours', 'minutes')).toBeNaN();
  });
});

describe('fieldsInSection', () => {
  const table = (id: string): FormField => ({
    id,
    type: 'repeating_group',
    label: id,
    required: false,
    source: 'imported',
    columns: [
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'duration', label: 'Duration', type: 'text' },
    ],
  });

  it('excludes a section_header anchor and runs to the next header', () => {
    const docFields = [header('h1'), question('q1'), question('q2'), header('h2'), question('q3')];
    expect(fieldsInSection(docFields, 'h1').map((f) => f.id)).toEqual(['q1', 'q2']);
  });

  it('INCLUDES a non-header anchor — a header-less grouped section keeps its own table', () => {
    /*
      A section an author built by grouping has no printed heading, so its part
      anchors on the table itself. Skipping the anchor left the table out of its
      own section — the column picker offered a neighbour's fields and the
      validator called the declared duration column missing. The table must be
      the first repeating group the slice yields.
    */
    const docFields = [table('log'), question('after'), header('next'), question('q')];
    const section = fieldsInSection(docFields, 'log');
    expect(section.map((f) => f.id)).toEqual(['log', 'after']);
    expect(section.find((f) => f.type === 'repeating_group')?.id).toBe('log');
  });

  it('a non-header anchor still stops at the next header', () => {
    const docFields = [question('only'), header('next'), question('q')];
    expect(fieldsInSection(docFields, 'only').map((f) => f.id)).toEqual(['only']);
  });

  it('returns nothing for an unknown anchor rather than the whole document', () => {
    expect(fieldsInSection([header('h1'), question('q1')], 'ghost')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The verdict pair
 * ------------------------------------------------------------------ */

/**
 * Both printed shapes are real, and the validator has to accept both.
 *
 * A form may print two boxes — "☐ Satisfactory ☐ Not Satisfactory" — which is
 * two fields. Or it may print ONE ✓/✗ cell whose tick means satisfactory and
 * whose cross means not, which extraction reads as a single `check_cross` field
 * that both halves name. Claiming each half separately would reject the second
 * shape as a self-collision — the exact layout the paper this was built for
 * uses.
 */
describe('validateManifest — the part verdict pair', () => {
  const verdictFields = [...fields, question('v'), question('v2'), question('act')];

  it('ACCEPTS ONE ✓/✗ CELL CARRYING BOTH HALVES', () => {
    const manifest: AssessmentToolManifest = {
      parts: [
        part({
          key: 'a',
          ordinal: 1,
          outcomeSatisfactory: { fieldId: 'v', value: true },
          outcomeNotSatisfactory: { fieldId: 'v', value: false },
        }),
      ],
    };

    expect(validateManifest(manifest, verdictFields)).toEqual([]);
  });

  it('accepts two separate boxes', () => {
    const manifest: AssessmentToolManifest = {
      parts: [
        part({
          key: 'a',
          ordinal: 1,
          outcomeSatisfactory: { fieldId: 'v', value: true },
          outcomeNotSatisfactory: { fieldId: 'v2', value: true },
        }),
      ],
    };

    expect(validateManifest(manifest, verdictFields)).toEqual([]);
  });

  it('REJECTS A SHARED CELL CARRYING THE SAME VALUE TWICE', () => {
    /*
      The failure sharing a cell can hide. A pass and a fail would print
      identically, so an auditor reading the record could not tell which
      happened and neither could anyone re-deriving it.
    */
    const manifest: AssessmentToolManifest = {
      parts: [
        part({
          key: 'a',
          ordinal: 1,
          outcomeSatisfactory: { fieldId: 'v', value: true },
          outcomeNotSatisfactory: { fieldId: 'v', value: true },
        }),
      ],
    };

    const problems = validateManifest(manifest, verdictFields);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('same value for both outcomes');
  });

  it('REJECTS TWO PARTS CLAIMING ONE VERDICT BOX', () => {
    // The last resolved part's verdict would overwrite the first's, so a passed
    // part and a failed one would print the same mark with nothing to notice it.
    const manifest: AssessmentToolManifest = {
      parts: [
        part({ key: 'a', ordinal: 1, outcomeSatisfactory: { fieldId: 'v', value: true } }),
        part({ key: 'b', ordinal: 2, outcomeSatisfactory: { fieldId: 'v', value: true } }),
      ],
    };

    const problems = validateManifest(manifest, verdictFields);

    expect(problems.some((p) => p.includes('claimed by both'))).toBe(true);
  });

  it('rejects a verdict box that is not in this version', () => {
    const manifest: AssessmentToolManifest = {
      parts: [part({ key: 'a', ordinal: 1, outcomeSatisfactory: { fieldId: 'gone', value: true } })],
    };

    const problems = validateManifest(manifest, verdictFields);

    expect(problems.some((p) => p.includes('gone'))).toBe(true);
  });

  it('rejects a further-action box that is not in this version', () => {
    const manifest: AssessmentToolManifest = {
      parts: [part({ key: 'a', ordinal: 1, furtherActionFieldId: 'gone' })],
    };

    expect(validateManifest(manifest, verdictFields).some((p) => p.includes('gone'))).toBe(true);
  });

  it('rejects an overall not-satisfactory box that is not in this version', () => {
    const manifest: AssessmentToolManifest = {
      parts: [part({ key: 'a', ordinal: 1 })],
      signOff: { overallNotSatisfactory: { fieldId: 'gone', value: true } },
    };

    expect(validateManifest(manifest, verdictFields).some((p) => p.includes('gone'))).toBe(true);
  });
});

describe('isTerminalCaseState', () => {
  /*
    Terminal decides two things at once: whether the single state writer stamps
    `closedAt`, and whether a sweep over live work picks the case up. A state
    added to the enum without being classified here is therefore treated as IN
    FLIGHT by omission — which is how `invalidated` (a case abandoned when its
    candidate left) would have been re-created as live work by a Role's
    requirements changing, for somebody who is gone.
  */
  it('classifies every case state, so none is in flight by omission', () => {
    expect(CASE_STATES.filter(isTerminalCaseState)).toEqual([
      'competent',
      'closed',
      'invalidated',
    ]);
    expect(CASE_STATES.filter((s) => !isTerminalCaseState(s))).toEqual([
      'open',
      'awaiting_sign_off',
    ]);
  });

  it('treats an invalidated case as finished, not as one still being worked', () => {
    // Nobody will work it again. Only its OUTCOME differs from a case that
    // finished, and the state value is what carries that distinction (R71–R74).
    expect(isTerminalCaseState('invalidated')).toBe(true);
    expect(isTerminalCaseState('awaiting_sign_off')).toBe(false);
  });
});

/**
 * The completion checklist ticks itself — derived from the parts' final
 * states, positional like every fixed-row value, and only ever writing TRUE
 * into a satisfied part's own cell. Un-ticked means "not completed", never
 * "failed": a false here would print a finding nobody made.
 */
describe('completionTickRows', () => {
  const marks = [
    { partKey: 'p1', fieldId: 'methods', rowIndex: 0, columnKey: 'done' },
    { partKey: 'p2', fieldId: 'methods', rowIndex: 3, columnKey: 'done' },
  ];
  const progressOf = (states: Record<string, 'satisfactory' | 'open' | 'not_satisfactory'>) =>
    Object.entries(states).map(([key, state]) => ({
      part: part({ key, ordinal: 1 }),
      state: state as never,
      attempts: 1,
      latestOutcome: null,
    }));

  it('ticks a satisfied part’s row and pads the gap with empty rows', async () => {
    const { completionTickRows } = await import('./assessment.js');
    const rows = completionTickRows(marks, progressOf({ p1: 'open', p2: 'satisfactory' }));

    // Row 3 must sit at INDEX 3 — the exporter consumes rows positionally, so
    // a tick that slid up through the gap would print on the wrong method.
    expect(rows).toEqual([{}, {}, {}, { done: true }]);
  });

  it('leaves a failed or unstarted part’s row untouched', async () => {
    const { completionTickRows } = await import('./assessment.js');
    const rows = completionTickRows(marks, progressOf({ p1: 'not_satisfactory', p2: 'open' }));

    expect(rows).toEqual([]);
  });

  it('merges over what is stored without erasing it', async () => {
    const { completionTickRows } = await import('./assessment.js');
    const rows = completionTickRows(
      marks,
      progressOf({ p1: 'satisfactory', p2: 'open' }),
      [{ label: 'Theory', note: 'kept' }],
    );

    expect(rows).toEqual([{ label: 'Theory', note: 'kept', done: true }]);
  });

  /*
    A ROW MAPPED TO SEVERAL PARTS — the Track Dozer's "Theory" method covers
    General plus one of two location-specific papers. "Any passed" would tick
    after General alone; "all passed" would never tick, because no candidate
    sits both locations' papers. The rule: every mapped part THE CASE REQUIRES
    must pass, and parts outside the case's set do not count.
  */
  describe('a row mapped to several parts', () => {
    const theoryRow = [
      { partKey: 'general', fieldId: 'methods', rowIndex: 0, columnKey: 'done' },
      { partKey: 'bbm', fieldId: 'methods', rowIndex: 0, columnKey: 'done' },
      { partKey: 'raw', fieldId: 'methods', rowIndex: 0, columnKey: 'done' },
    ];
    const bbmCase = new Set(['general', 'bbm']);

    it('waits for every applicable part, not just the first', async () => {
      const { completionTickRows } = await import('./assessment.js');
      const rows = completionTickRows(
        theoryRow,
        progressOf({ general: 'satisfactory', bbm: 'open' }),
        undefined,
        bbmCase,
      );

      expect(rows).toEqual([]);
    });

    it('ticks once every applicable part has passed — the other location never blocks', async () => {
      const { completionTickRows } = await import('./assessment.js');
      const rows = completionTickRows(
        theoryRow,
        // `raw` is absent from progress entirely — a BBM case never sits it.
        progressOf({ general: 'satisfactory', bbm: 'satisfactory' }),
        undefined,
        bbmCase,
      );

      expect(rows).toEqual([{ done: true }]);
    });

    it('demands every mapped part when no applicable set is given', async () => {
      const { completionTickRows } = await import('./assessment.js');
      const rows = completionTickRows(
        theoryRow,
        progressOf({ general: 'satisfactory', bbm: 'satisfactory' }),
      );

      // `raw` never passed and nothing said it does not apply, so no tick —
      // silence is the safe failure on a completion record.
      expect(rows).toEqual([]);
    });

    it('leaves a row alone when none of its mapped parts apply to this case', async () => {
      const { completionTickRows } = await import('./assessment.js');
      const rows = completionTickRows(
        theoryRow,
        progressOf({ general: 'satisfactory' }),
        [{ label: 'Theory' }],
        new Set(['other']),
      );

      expect(rows).toEqual([{ label: 'Theory' }]);
    });

    it('judges single-mark rows exactly as before under an applicable set', async () => {
      const { completionTickRows } = await import('./assessment.js');
      const rows = completionTickRows(
        marks,
        progressOf({ p1: 'satisfactory', p2: 'satisfactory' }),
        undefined,
        new Set(['p1']),
      );

      // p1's row ticks; p2's row is not this case's to tick, even satisfied.
      expect(rows).toEqual([{ done: true }]);
    });
  });
});

/**
 * The one derivation a multi-part row is judged against: what THIS case
 * requires — the pathway's parts, narrowed by the tool's per-Location rule.
 */
describe('casePartKeys', () => {
  const manifest = {
    parts: [
      part({ key: 'general', ordinal: 1, pathways: ['new', 'experienced'] }),
      part({ key: 'bbm', ordinal: 2, pathways: ['new', 'experienced'] }),
      part({ key: 'raw', ordinal: 3, pathways: ['new', 'experienced'] }),
      part({ key: 'logbook', ordinal: 4, pathways: ['new'] }),
    ],
  };
  const rule = {
    'loc-bbm': ['general', 'bbm', 'logbook'],
    'loc-raw': ['general', 'raw', 'logbook'],
  };

  it('narrows by pathway AND the location rule together', async () => {
    const { casePartKeys } = await import('./assessment.js');

    expect(casePartKeys(manifest, 'new', rule, 'loc-bbm')).toEqual(
      new Set(['general', 'bbm', 'logbook']),
    );
    // Experienced drops the logbook by pathway; the rule drops the other paper.
    expect(casePartKeys(manifest, 'experienced', rule, 'loc-raw')).toEqual(
      new Set(['general', 'raw']),
    );
  });

  it('requires everything when the case names no Location, or the rule does not list it', async () => {
    const { casePartKeys } = await import('./assessment.js');

    expect(casePartKeys(manifest, 'new', rule, null)).toEqual(
      new Set(['general', 'bbm', 'raw', 'logbook']),
    );
    // An unlisted Location requires every part — the safe direction (R75).
    expect(casePartKeys(manifest, 'new', rule, 'loc-elsewhere')).toEqual(
      new Set(['general', 'bbm', 'raw', 'logbook']),
    );
    expect(casePartKeys(manifest, 'new', undefined, 'loc-bbm')).toEqual(
      new Set(['general', 'bbm', 'raw', 'logbook']),
    );
  });
});

describe('validatePartCompletionMarks', () => {
  const manifest = { parts: [part({ key: 'p1', ordinal: 1 })] };
  const table: FormField = {
    id: 'methods',
    type: 'repeating_group',
    label: 'Assessment Methods',
    required: false,
    source: 'imported',
    fixedRows: ['1. Theory', '2. Practical'],
    columns: [
      { key: 'method', label: 'Method', type: 'text' },
      { key: 'done', label: 'Done', type: 'checkbox' },
    ],
  };

  it('accepts a mark that names a real part, row and column', async () => {
    const { validatePartCompletionMarks } = await import('./assessment.js');
    expect(
      validatePartCompletionMarks(
        [{ partKey: 'p1', fieldId: 'methods', rowIndex: 1, columnKey: 'done' }],
        manifest,
        [table],
      ),
    ).toEqual([]);
  });

  it('refuses an unknown part, a missing field, a wrong type, an out-of-range row and a wrong column', async () => {
    const { validatePartCompletionMarks } = await import('./assessment.js');
    const scalar: FormField = { id: 'plain', type: 'text', label: 'x', required: false, source: 'imported' };

    expect(
      validatePartCompletionMarks(
        [
          { partKey: 'ghost', fieldId: 'methods', rowIndex: 0, columnKey: 'done' },
          { partKey: 'p1', fieldId: 'nope', rowIndex: 0, columnKey: 'done' },
          { partKey: 'p1', fieldId: 'plain', rowIndex: 0, columnKey: 'done' },
          { partKey: 'p1', fieldId: 'methods', rowIndex: 9, columnKey: 'done' },
          { partKey: 'p1', fieldId: 'methods', rowIndex: 0, columnKey: 'ghost' },
        ],
        manifest,
        [table, scalar],
      ),
    ).toHaveLength(5);
  });
});

describe('validatePathwayMarks', () => {
  const box: FormField = {
    id: 'pathway-new',
    type: 'check_cross',
    label: 'New / inexperienced',
    required: false,
    source: 'imported',
  };

  it('accepts a mark on a real field, and an empty or absent map', async () => {
    const { validatePathwayMarks } = await import('./assessment.js');
    expect(validatePathwayMarks({ new: { fieldId: 'pathway-new', value: true } }, [box])).toEqual([]);
    expect(validatePathwayMarks({}, [box])).toEqual([]);
    expect(validatePathwayMarks(undefined, [box])).toEqual([]);
  });

  it('refuses a ghost field, naming the pathway that carries it', async () => {
    const { validatePathwayMarks } = await import('./assessment.js');
    const problems = validatePathwayMarks({ experienced: { fieldId: 'nope', value: true } }, [box]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('experienced');
    expect(problems[0]).toContain('nope');
  });

  it('refuses a cell address on anything but a table, and a column the table lacks', async () => {
    const { validatePathwayMarks } = await import('./assessment.js');
    const table: FormField = {
      id: 'grid',
      type: 'repeating_group',
      label: 'Grid',
      required: false,
      source: 'imported',
      fixedRows: ['a'],
      columns: [{ key: 'tick', label: 'Tick', type: 'checkbox' }],
    };

    expect(
      validatePathwayMarks(
        { new: { fieldId: 'pathway-new', rowKey: 'r', columnKey: 'tick', value: true } },
        [box, table],
      ),
    ).toHaveLength(1);
    expect(
      validatePathwayMarks(
        { new: { fieldId: 'grid', rowKey: 'r', columnKey: 'ghost', value: true } },
        [box, table],
      ),
    ).toHaveLength(1);
    expect(
      validatePathwayMarks(
        { new: { fieldId: 'grid', rowKey: 'r', columnKey: 'tick', value: true } },
        [box, table],
      ),
    ).toEqual([]);
  });
});

describe('validateSignOffMarks', () => {
  const name: FormField = { id: 'sign-name', type: 'text', label: 'Assessor', required: false, source: 'imported' };
  const yes: FormField = { id: 'overall-yes', type: 'check_cross', label: 'Competent', required: false, source: 'imported' };

  it('accepts pointers and marks that resolve, and an absent block', async () => {
    const { validateSignOffMarks } = await import('./assessment.js');
    expect(
      validateSignOffMarks(
        {
          assessorNameFieldId: 'sign-name',
          overallSatisfactory: { fieldId: 'overall-yes', value: true },
        },
        [name, yes],
      ),
    ).toEqual([]);
    expect(validateSignOffMarks(undefined, [name, yes])).toEqual([]);
  });

  it('names every ghost — a pointer and a mark alike', async () => {
    const { validateSignOffMarks } = await import('./assessment.js');
    const problems = validateSignOffMarks(
      {
        signedDateFieldId: 'gone-date',
        overallNotSatisfactory: { fieldId: 'gone-no', value: true },
      },
      [name, yes],
    );
    expect(problems).toHaveLength(2);
    expect(problems.join(' ')).toContain('gone-date');
    expect(problems.join(' ')).toContain('gone-no');
  });
});

describe('nextStepAfter', () => {
  const part = (over: Partial<NextStepPart> & { key: string }): NextStepPart => ({
    label: over.key,
    state: 'open',
    candidateFills: false,
    staffFills: false,
    ...over,
  });

  // A typical flow: declaration (candidate) → theory (candidate) → practical
  // (assessor) → sign-off note (candidate).
  const flow: NextStepPart[] = [
    part({ key: 'decl', label: 'Candidate declaration', state: 'satisfactory', candidateFills: true }),
    part({ key: 'theory', label: 'Theory', state: 'open', candidateFills: true }),
    part({ key: 'prac', label: 'Practical demonstration', state: 'locked', staffFills: true }),
  ];

  it('offers a Continue to the next part the candidate may fill', () => {
    // After the declaration, theory is the candidate's and open.
    expect(nextStepAfter(flow, 'decl', true)).toEqual({
      kind: 'continue',
      partKey: 'theory',
      label: 'Theory',
    });
  });

  it('tells the candidate when the next part is the assessor’s', () => {
    // After theory, the practical is the assessor's (and still locked).
    expect(nextStepAfter(flow, 'theory', true)).toEqual({
      kind: 'awaiting_other',
      label: 'Practical demonstration',
      filledBy: 'your assessor',
    });
  });

  it('never offers a Continue for a locked part, even one the viewer fills', () => {
    const locked: NextStepPart[] = [
      part({ key: 'a', state: 'satisfactory', candidateFills: true }),
      part({ key: 'b', state: 'locked', candidateFills: true }),
    ];
    // The candidate fills 'b', but its dependencies are unmet — waiting, not go.
    expect(nextStepAfter(locked, 'a', true)).toMatchObject({ kind: 'awaiting_other' });
  });

  it('skips parts already satisfactory to the next unfinished one', () => {
    const parts: NextStepPart[] = [
      part({ key: 'a', state: 'satisfactory', candidateFills: true }),
      part({ key: 'b', state: 'satisfactory', candidateFills: true }),
      part({ key: 'c', label: 'Logbook', state: 'open', candidateFills: true }),
    ];
    expect(nextStepAfter(parts, 'a', true)).toEqual({ kind: 'continue', partKey: 'c', label: 'Logbook' });
  });

  it('is done when every later part is satisfactory', () => {
    const parts: NextStepPart[] = [
      part({ key: 'a', state: 'satisfactory', candidateFills: true }),
      part({ key: 'b', state: 'satisfactory', staffFills: true }),
    ];
    expect(nextStepAfter(parts, 'a', true)).toEqual({ kind: 'done' });
    // The very last part has nothing after it either.
    expect(nextStepAfter(parts, 'b', true)).toEqual({ kind: 'done' });
  });

  it('reads from the staff viewpoint too', () => {
    // Same flow, but the assessor just finished the practical: theory ahead is
    // the candidate's, so it reads as awaiting the candidate.
    const parts: NextStepPart[] = [
      part({ key: 'prac', state: 'satisfactory', staffFills: true }),
      part({ key: 'log', label: 'Logbook', state: 'open', candidateFills: true }),
    ];
    expect(nextStepAfter(parts, 'prac', false)).toEqual({
      kind: 'awaiting_other',
      label: 'Logbook',
      filledBy: 'the candidate',
    });
  });
});

describe('pathwayFromHistory', () => {
  it('suggests experienced when the candidate already holds a competency this tool awards', () => {
    expect(pathwayFromHistory(['c-dozer'], ['c-dozer', 'c-first-aid'])).toBe('experienced');
  });

  it('suggests new when they hold none of the awarded competencies', () => {
    expect(pathwayFromHistory(['c-dozer'], ['c-first-aid'])).toBe('new');
  });

  it('suggests new when the candidate holds nothing at all', () => {
    expect(pathwayFromHistory(['c-dozer'], [])).toBe('new');
  });

  it('counts a held competency even when the tool awards several', () => {
    expect(pathwayFromHistory(['c-a', 'c-b'], ['c-b'])).toBe('experienced');
  });

  it('never suggests rpl — that is a deliberate assessor choice, not inferable', () => {
    // Whatever the history, the suggestion is only ever new or experienced.
    for (const held of [[], ['c-dozer'], ['c-a', 'c-b']]) {
      expect(pathwayFromHistory(['c-dozer'], held)).not.toBe('rpl');
    }
  });

  it('accepts a Set as well as an array of held ids', () => {
    expect(pathwayFromHistory(['c-dozer'], new Set(['c-dozer']))).toBe('experienced');
  });

  it('suggests new for a tool that awards nothing — no competency to have held', () => {
    expect(pathwayFromHistory([], ['c-dozer'])).toBe('new');
  });
});

describe('theoryRetryOf', () => {
  it('uses an explicit mode when the tool names one', () => {
    expect(theoryRetryOf({ theoryRetry: 'off' })).toBe('off');
    expect(theoryRetryOf({ theoryRetry: 'immediate' })).toBe('immediate');
    expect(theoryRetryOf({ theoryRetry: 'end' })).toBe('end');
  });

  it('reads a legacy allowRetry=true as immediate (its old on-the-spot retry)', () => {
    expect(theoryRetryOf({ theoryAllowRetry: true })).toBe('immediate');
  });

  it('reads a legacy allowRetry=false as end — the re-take on failure it still had', () => {
    expect(theoryRetryOf({ theoryAllowRetry: false })).toBe('end');
  });

  it('defaults a tool that names nothing to end, so behaviour is unchanged', () => {
    expect(theoryRetryOf({})).toBe('end');
  });

  it('prefers the explicit mode over the legacy boolean', () => {
    expect(theoryRetryOf({ theoryRetry: 'off', theoryAllowRetry: true })).toBe('off');
  });
});

/**
 * `caseProgress` narrowed to what THIS case requires — the Location rule,
 * finally enforced: an excluded part is not listed, never blocks the
 * sequence, and the case completes without it.
 */
describe('caseProgress — applicable part keys', () => {
  const manifest = {
    parts: [
      part({ key: 'general', ordinal: 1, pathways: ['new'] }),
      part({ key: 'raw-theory', ordinal: 2, pathways: ['new'] }),
      part({ key: 'practical', ordinal: 3, pathways: ['new'] }),
    ],
  };
  const passed = (key: string) => ({ partKey: key, attemptNumber: 1, outcome: 'satisfactory' as const });

  it('drops an excluded part from the list and from the sequential gate', async () => {
    const { caseProgress } = await import('./assessment.js');
    const progress = caseProgress(manifest, 'new', [passed('general')], new Set(['general', 'practical']));

    expect(progress.map((p) => p.part.key)).toEqual(['general', 'practical']);
    // raw-theory untouched does not lock the practical — general passing opens it.
    expect(progress.find((p) => p.part.key === 'practical')?.state).toBe('open');
  });

  it('completes the case without the excluded part', async () => {
    const { caseProgress, isCaseCompetent } = await import('./assessment.js');
    const progress = caseProgress(
      manifest,
      'new',
      [passed('general'), passed('practical')],
      new Set(['general', 'practical']),
    );

    expect(isCaseCompetent(progress)).toBe(true);
  });

  it('changes nothing when no set is given — every pathway part still counts', async () => {
    const { caseProgress, isCaseCompetent } = await import('./assessment.js');
    const progress = caseProgress(manifest, 'new', [passed('general'), passed('practical')]);

    expect(progress.map((p) => p.part.key)).toEqual(['general', 'raw-theory', 'practical']);
    expect(isCaseCompetent(progress)).toBe(false);
  });
});
