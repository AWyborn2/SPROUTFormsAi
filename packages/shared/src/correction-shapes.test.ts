import { describe, expect, it } from 'vitest';
import type { Correction } from './extraction-corrections.js';
import { isBareLetteredOption, shapeOf, tallyShapes } from './correction-shapes.js';

describe('isBareLetteredOption', () => {
  it('matches a lettered/numbered/roman option marker with little text after', () => {
    for (const label of ['c) All of these', 'b.', 'a) True', 'iv) None', '12) N/A', 'd)']) {
      expect(isBareLetteredOption(label)).toBe(true);
    }
  });

  it('does not match a real question stem, even one that opens with a letter', () => {
    for (const label of [
      'What action would you take if you found a Category A fault on the machine?',
      'Site name',
      'Assessor signature',
      'a) then describe every step of the full isolation and lock-out procedure here',
    ]) {
      expect(isBareLetteredOption(label)).toBe(false);
    }
  });
});

describe('shapeOf — content-free keys', () => {
  const base = { fieldId: 'ai_1' };

  it('keys a retype by its type transition', () => {
    expect(shapeOf({ ...base, kind: 'retype', from: 'radio', to: 'textarea' })).toBe(
      'retype:radio→textarea',
    );
  });

  it('keys a selection-type change by from→to, naming an absent side "none"', () => {
    expect(
      shapeOf({ ...base, kind: 'selection-type-changed', from: 'multiple', to: 'single' }),
    ).toBe('selection-type:multiple→single');
    expect(shapeOf({ ...base, kind: 'selection-type-changed', to: 'single' })).toBe(
      'selection-type:none→single',
    );
  });

  it('keys options edits by direction, distinguishing cleared and added', () => {
    expect(shapeOf({ ...base, kind: 'options-edited', from: ['a', 'b'], to: [] })).toBe(
      'options-edited:cleared',
    );
    expect(shapeOf({ ...base, kind: 'options-edited', from: [], to: ['a'] })).toBe(
      'options-edited:added',
    );
    expect(shapeOf({ ...base, kind: 'options-edited', from: ['a', 'b'], to: ['a'] })).toBe(
      'options-edited:removed',
    );
  });

  it('keys a split by its group count', () => {
    expect(shapeOf({ ...base, kind: 'split', into: 3 })).toBe('split:into-3');
  });

  it('keys an orphan-option deletion apart from an ordinary deletion — the rule-19 signal', () => {
    expect(
      shapeOf({ ...base, kind: 'deleted', wasType: 'radio', wasLabel: 'c) All of these' }),
    ).toBe('deleted:orphan-option');
    expect(
      shapeOf({ ...base, kind: 'deleted', wasType: 'text', wasLabel: 'Assessor signature' }),
    ).toBe('deleted:text');
  });

  it('keys an addition and a question-ref edit content-free', () => {
    expect(shapeOf({ ...base, kind: 'added', addedType: 'signature', label: 'Sign here', afterFieldId: 'ai_1' })).toBe(
      'added:signature',
    );
    expect(shapeOf({ ...base, kind: 'question-ref-edited', from: 'Verbal Q1', to: 'p.8 Q1' })).toBe(
      'question-ref-edited:set→set',
    );
  });

  it('gives two corrections that differ only in field text the SAME shape', () => {
    const a: Correction = { fieldId: 'ai_1', kind: 'retype', from: 'radio', to: 'textarea' };
    const b: Correction = { fieldId: 'ai_9', kind: 'retype', from: 'radio', to: 'textarea' };
    expect(shapeOf(a)).toBe(shapeOf(b));
  });

  it('never leaks field text into the key', () => {
    const key = shapeOf({
      ...base,
      kind: 'deleted',
      wasType: 'radio',
      wasLabel: 'c) Boddington Bauxite Mine secret',
    });
    expect(key).not.toContain('Boddington');
    expect(key).not.toContain('secret');
  });
});

describe('tallyShapes', () => {
  it('counts each shape across a batch', () => {
    const corrections: Correction[] = [
      { fieldId: 'ai_1', kind: 'retype', from: 'radio', to: 'textarea' },
      { fieldId: 'ai_2', kind: 'retype', from: 'radio', to: 'textarea' },
      { fieldId: 'ai_3', kind: 'deleted', wasType: 'radio', wasLabel: 'd)' },
    ];
    const tally = tallyShapes(corrections);
    expect(tally.get('retype:radio→textarea')).toBe(2);
    expect(tally.get('deleted:orphan-option')).toBe(1);
  });
});
