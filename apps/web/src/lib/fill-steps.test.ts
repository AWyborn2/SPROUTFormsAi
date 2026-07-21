import { describe, expect, it } from 'vitest';
import type { FormField } from '@formai/shared';
import {
  buildSteps,
  canAdvance,
  isEmptyValue,
  progressAt,
  stepFieldIds,
  stepIndexForField,
  totalScreens,
  unansweredRequired,
} from './fill-steps.js';

function field(patch: Partial<FormField> & { id: string }): FormField {
  return {
    type: 'text',
    label: 'Field',
    required: false,
    source: 'built',
    ...patch,
  } as FormField;
}

const HEADER = (id: string, label: string) =>
  field({ id, label, type: 'section_header' as FormField['type'] });

describe('buildSteps', () => {
  it('splits on section headers and uses them as titles', () => {
    const steps = buildSteps([
      HEADER('h1', 'Your details'),
      field({ id: 'a' }),
      field({ id: 'b' }),
      HEADER('h2', 'Company'),
      field({ id: 'c' }),
    ]);
    expect(steps).toHaveLength(2);
    expect(steps[0]?.title).toBe('Your details');
    expect(stepFieldIds(steps[0])).toEqual(['a', 'b']);
    expect(steps[1]?.title).toBe('Company');
    expect(stepFieldIds(steps[1])).toEqual(['c']);
  });

  it('opens with an untitled step for fields before any header', () => {
    const steps = buildSteps([field({ id: 'a' }), HEADER('h1', 'Later'), field({ id: 'b' })]);
    expect(steps[0]?.title).toBeNull();
    expect(stepFieldIds(steps[0])).toEqual(['a']);
  });

  it('does not emit empty screens for consecutive or trailing headers', () => {
    const steps = buildSteps([
      HEADER('h1', 'One'),
      HEADER('h2', 'Two'),
      field({ id: 'a' }),
      HEADER('h3', 'Trailing'),
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.title).toBe('Two');
  });

  /**
   * A field dropped here is a question the respondent is never asked and a
   * value the org never receives — a silent data-loss bug, so it gets an
   * explicit guard rather than relying on the grouping tests above.
   */
  it('places every non-header field in exactly one step', () => {
    const fields = [
      field({ id: 'a' }),
      HEADER('h1', 'S'),
      field({ id: 'b' }),
      field({ id: 'c' }),
      HEADER('h2', 'T'),
      field({ id: 'd' }),
    ];
    const placed = buildSteps(fields).flatMap(stepFieldIds);
    expect(placed.sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(new Set(placed).size).toBe(placed.length);
  });

  it('returns no steps for an empty or header-only form', () => {
    expect(buildSteps([])).toEqual([]);
    expect(buildSteps([HEADER('h1', 'Only')])).toEqual([]);
  });
});

describe('progressAt', () => {
  const steps = buildSteps([field({ id: 'a' }), HEADER('h', 'S'), field({ id: 'b' })]);

  it('counts the review screen in the total', () => {
    expect(totalScreens(steps)).toBe(3); // 2 question steps + review
  });

  /**
   * Reaching 100% before the respondent has pressed Submit reads as "already
   * done" and is a real source of abandoned submissions.
   */
  it('only reaches 1 on the review screen', () => {
    expect(progressAt(0, steps)).toBe(0);
    expect(progressAt(1, steps)).toBeCloseTo(0.5);
    expect(progressAt(2, steps)).toBe(1);
  });

  it('clamps out-of-range indices', () => {
    expect(progressAt(-5, steps)).toBe(0);
    expect(progressAt(99, steps)).toBe(1);
  });

  it('reports complete for a form with no steps', () => {
    expect(progressAt(0, [])).toBe(1);
  });
});

describe('unansweredRequired / canAdvance', () => {
  const steps = buildSteps([
    field({ id: 'name', required: true }),
    field({ id: 'note' }),
  ]);

  /** Covers AE6. */
  it('blocks advancing past an empty required field', () => {
    expect(unansweredRequired(steps[0], {})).toEqual(['name']);
    expect(canAdvance(steps, 0, {})).toBe(false);
  });

  it('allows advancing once the required field is answered', () => {
    expect(canAdvance(steps, 0, { name: 'Ash' })).toBe(true);
  });

  it('ignores optional fields', () => {
    expect(unansweredRequired(steps[0], { name: 'Ash' })).toEqual([]);
  });

  /**
   * A space is not an answer. Accepting it produces a submission the org has
   * to chase, which is worse than a moment of friction here.
   */
  it('treats whitespace and empty collections as unanswered', () => {
    expect(canAdvance(steps, 0, { name: '   ' })).toBe(false);
    expect(canAdvance(steps, 0, { name: [] })).toBe(false);
  });

  it('accepts falsy-but-real answers', () => {
    expect(isEmptyValue(0)).toBe(false);
    expect(isEmptyValue(false)).toBe(false);
  });

  it('advances freely past a step index that does not exist', () => {
    expect(canAdvance(steps, 99, {})).toBe(true);
  });
});

describe('stepIndexForField', () => {
  const steps = buildSteps([field({ id: 'a' }), HEADER('h', 'S'), field({ id: 'b' })]);

  /**
   * A submit-time validation failure has to send the respondent back to the
   * screen that owns the field, not strand them on the review page with an
   * error whose cause is off-screen.
   */
  it('locates the step owning a field', () => {
    expect(stepIndexForField(steps, 'a')).toBe(0);
    expect(stepIndexForField(steps, 'b')).toBe(1);
  });

  it('returns -1 for an unknown field', () => {
    expect(stepIndexForField(steps, 'nope')).toBe(-1);
  });
});
