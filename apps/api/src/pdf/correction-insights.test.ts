import { describe, expect, it } from 'vitest';
import {
  aggregateCorrectionRows,
  candidateRules,
  suggestionFor,
  type CorrectionRow,
} from './correction-insights.js';

function row(over: Partial<CorrectionRow> & { corrections: unknown }): CorrectionRow {
  return { documentType: 'assessment', correctionCount: 1, fieldCount: 10, captureId: null, ...over };
}

describe('aggregateCorrectionRows', () => {
  it('computes the rate per type and clusters shapes with sample captures', () => {
    const rows: CorrectionRow[] = [
      row({
        correctionCount: 2,
        captureId: 'cap-1',
        corrections: {
          corrections: [
            { kind: 'retype', fieldId: 'ai_1', from: 'radio', to: 'textarea' },
            { kind: 'deleted', fieldId: 'ai_5', wasType: 'radio', wasLabel: 'c) x' },
          ],
        },
      }),
      row({
        correctionCount: 1,
        captureId: 'cap-2',
        corrections: { corrections: [{ kind: 'retype', fieldId: 'ai_2', from: 'radio', to: 'textarea' }] },
      }),
    ];

    const { metrics, shapes } = aggregateCorrectionRows(rows);
    expect(metrics).toEqual([{ documentType: 'assessment', corrections: 3, fields: 20, rate: 0.15 }]);

    const retype = shapes.find((s) => s.shape === 'retype:radio→textarea');
    expect(retype?.count).toBe(2);
    expect(retype?.sampleCaptureIds.sort()).toEqual(['cap-1', 'cap-2']);
    expect(shapes.find((s) => s.shape === 'deleted:orphan-option')?.count).toBe(1);
  });

  it('buckets a null documentType as "unspecified" and tolerates an empty payload', () => {
    const { metrics, shapes } = aggregateCorrectionRows([
      row({ documentType: null, corrections: { corrections: [] } }),
    ]);
    expect(metrics[0]?.documentType).toBe('unspecified');
    expect(shapes).toEqual([]);
  });
});

describe('suggestionFor', () => {
  it('maps a known failure-mode shape to its rule', () => {
    expect(suggestionFor('deleted:orphan-option')).toContain('rule 19');
    expect(suggestionFor('retype:radio→textarea')).toContain('rule 18');
    expect(suggestionFor('selection-type:multiple→single')).toContain('rule 1');
  });

  it('gives an unknown shape a generic review prompt', () => {
    expect(suggestionFor('label-rewritten')).toMatch(/review/i);
  });
});

describe('candidateRules', () => {
  const shapes = [
    { documentType: 'assessment', shape: 'retype:radio→textarea', count: 5, sampleCaptureIds: ['cap-1'] },
    { documentType: 'assessment', shape: 'label-rewritten', count: 1, sampleCaptureIds: [] },
  ];

  it('keeps only shapes at or above the threshold and attaches a suggestion', () => {
    const candidates = candidateRules(shapes, 3);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ shape: 'retype:radio→textarea', count: 5 });
    expect(candidates[0]!.suggestion).toContain('rule 18');
  });

  it('returns nothing when no shape recurs enough', () => {
    expect(candidateRules(shapes, 10)).toEqual([]);
  });
});
