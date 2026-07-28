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
  orderedParts,
  requiredParts,
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

  it('rejects a start field that is not a section header in this version', () => {
    const manifest: AssessmentToolManifest = {
      parts: [part({ key: 'a', ordinal: 1, startFieldId: 'gone' })],
    };

    const problems = validateManifest(manifest, fields);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('gone');
  });

  it('rejects a start field that exists but is not a header', () => {
    const manifest: AssessmentToolManifest = {
      parts: [part({ key: 'a', ordinal: 1, startFieldId: 'q1' })],
    };

    expect(validateManifest(manifest, [...fields, question('q1')])).toHaveLength(1);
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
