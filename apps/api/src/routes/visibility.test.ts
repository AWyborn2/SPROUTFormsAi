/**
 * Visibility predicates (U10). Like the answer-set resolvers, these live in
 * `packages/shared`, which has no test runner of its own — so the sibling
 * arrangement in `answer-set.test.ts` applies here too.
 *
 * The theme throughout: FAIL OPEN. A condition that cannot be evaluated
 * honestly resolves to VISIBLE. This is compliance paperwork; a section that
 * silently vanishes is far worse than one that shows when it shouldn't.
 */
import { describe, expect, it } from 'vitest';
import { isFieldVisible, visibleFields } from '@formai/shared';
import type { FormField, VisibilityCondition } from '@formai/shared';

function f(
  id: string,
  overrides: Partial<FormField> = {},
): FormField {
  return {
    id,
    type: 'text',
    label: id,
    required: false,
    source: 'built',
    ...overrides,
  };
}

const header = (id: string, visibleWhen?: VisibilityCondition): FormField =>
  f(id, { type: 'section_header', ...(visibleWhen ? { visibleWhen } : {}) });

const when = (fieldId: string, value: string, op: 'equals' | 'notEquals' = 'equals'): VisibilityCondition => ({
  fieldId,
  op,
  value,
});

describe('isFieldVisible', () => {
  it('shows a field that carries no condition', () => {
    const fields = [f('a')];
    expect(isFieldVisible(fields[0]!, fields, {})).toBe(true);
  });

  it('shows a field whose equals condition matches the source answer', () => {
    const fields = [f('src'), f('dep', { visibleWhen: when('src', 'yes') })];
    expect(isFieldVisible(fields[1]!, fields, { src: 'yes' })).toBe(true);
  });

  it('hides a field whose equals condition does not match', () => {
    const fields = [f('src'), f('dep', { visibleWhen: when('src', 'yes') })];
    expect(isFieldVisible(fields[1]!, fields, { src: 'no' })).toBe(false);
  });

  it('hides a field conditioned on a value when the source is unanswered', () => {
    const fields = [f('src'), f('dep', { visibleWhen: when('src', 'yes') })];
    expect(isFieldVisible(fields[1]!, fields, {})).toBe(false);
  });

  it('fails open when the condition names a field id the form does not have', () => {
    const fields = [f('dep', { visibleWhen: when('ghost', 'yes') })];
    expect(isFieldVisible(fields[0]!, fields, {})).toBe(true);
  });

  it('fails open when the source is a repeating group — no row state to read', () => {
    const fields = [f('tbl', { type: 'repeating_group' }), f('dep', { visibleWhen: when('tbl', 'yes') })];
    expect(isFieldVisible(fields[1]!, fields, { tbl: 'no' })).toBe(true);
  });

  it('fails open rather than cascading when the source field is itself hidden', () => {
    const fields = [
      f('root'),
      f('src', { visibleWhen: when('root', 'yes') }),
      f('dep', { visibleWhen: when('src', 'yes') }),
    ];
    // `root` is unanswered, so `src` is hidden. `dep`'s own condition would
    // also fail — but an unevaluatable source means VISIBLE, not hidden.
    expect(isFieldVisible(fields[1]!, fields, {})).toBe(false);
    expect(isFieldVisible(fields[2]!, fields, {})).toBe(true);
  });

  it('treats notEquals as the inverse of equals for an answered source', () => {
    const fields = [f('src'), f('eq', { visibleWhen: when('src', 'yes') }), f('ne', { visibleWhen: when('src', 'yes', 'notEquals') })];
    for (const answer of ['yes', 'no']) {
      expect(isFieldVisible(fields[2]!, fields, { src: answer })).toBe(
        !isFieldVisible(fields[1]!, fields, { src: answer }),
      );
    }
  });
});

describe('visibleFields', () => {
  it('preserves authored field order', () => {
    const fields = [f('a'), f('b'), f('c'), f('d')];
    expect(visibleFields(fields, {}).map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a hidden section header hides every field up to the next header and none after it', () => {
    const fields = [
      f('src'),
      header('h1', when('src', 'yes')),
      f('a'),
      f('b'),
      header('h2'),
      f('c'),
    ];
    expect(visibleFields(fields, { src: 'no' }).map((x) => x.id)).toEqual(['src', 'h2', 'c']);
    expect(visibleFields(fields, { src: 'yes' }).map((x) => x.id)).toEqual([
      'src',
      'h1',
      'a',
      'b',
      'h2',
      'c',
    ]);
  });

  it('a hidden section header at the end of the form hides every remaining field', () => {
    const fields = [f('src'), f('a'), header('h1', when('src', 'yes')), f('b'), f('c')];
    expect(visibleFields(fields, { src: 'no' }).map((x) => x.id)).toEqual(['src', 'a']);
  });

  it('keeps a field inside a hidden section hidden regardless of its own condition', () => {
    const fields = [
      f('src'),
      f('other'),
      header('h1', when('src', 'yes')),
      // This field's own condition passes — section scope still wins.
      f('a', { visibleWhen: when('other', 'ok') }),
    ];
    expect(visibleFields(fields, { src: 'no', other: 'ok' }).map((x) => x.id)).toEqual(['src', 'other']);
  });

  it('gives two consecutive headers an empty section rather than swallowing the following section', () => {
    const fields = [
      f('src'),
      header('h1', when('src', 'yes')),
      header('h2'),
      f('a'),
    ];
    // h1's section contains nothing; h2 opens a fresh, unconditioned section.
    expect(visibleFields(fields, { src: 'no' }).map((x) => x.id)).toEqual(['src', 'h2', 'a']);
  });

  it('still applies a field\'s own condition inside a visible section', () => {
    const fields = [f('src'), header('h1'), f('a', { visibleWhen: when('src', 'yes') })];
    expect(visibleFields(fields, { src: 'no' }).map((x) => x.id)).toEqual(['src', 'h1']);
  });
});
