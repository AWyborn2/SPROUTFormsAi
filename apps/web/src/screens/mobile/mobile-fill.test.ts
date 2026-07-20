/**
 * Mobile fill helpers — the published-form picker filter and the answered-input
 * progress numerator. (The generic input/required helpers moved to
 * `lib/validation.ts`; their tests live in `lib/validation.test.ts`.)
 */
import { describe, expect, it } from 'vitest';
import type { FormField } from '@formai/shared';
import type { FormSummary } from '../../lib/data/types.js';
import { answeredCount, publishedForms } from './mobile-fill.js';

function summary(overrides: Partial<FormSummary>): FormSummary {
  return {
    id: 'f1',
    name: 'Form',
    dept: 'Ops',
    icon: 'file-text',
    status: 'published',
    sourceType: 'built_from_scratch',
    version: 'v1',
    submissions: 0,
    updated: 'Just now',
    ...overrides,
  };
}

const header: FormField = { id: 's1', type: 'section_header', label: 'Section', required: false, source: 'built' };
const name: FormField = { id: 'name', type: 'text', label: 'Name', required: true, source: 'built' };
const notes: FormField = { id: 'notes', type: 'textarea', label: 'Notes', required: false, source: 'built' };
const consent: FormField = { id: 'consent', type: 'boolean_yes_no', label: 'Consent', required: true, source: 'built' };

describe('publishedForms', () => {
  it('keeps only published templates', () => {
    const forms = [
      summary({ id: 'a', status: 'published' }),
      summary({ id: 'b', status: 'draft' }),
      summary({ id: 'c', status: 'archived' }),
    ];
    expect(publishedForms(forms).map((f) => f.id)).toEqual(['a']);
  });

  it('is empty when nothing is published', () => {
    expect(publishedForms([summary({ status: 'draft' })])).toEqual([]);
  });
});

describe('answeredCount', () => {
  it('counts answered input fields and ignores headers', () => {
    expect(answeredCount([header, name, notes, consent], { name: 'Priya', consent: false })).toBe(2);
    expect(answeredCount([header, name, notes, consent], {})).toBe(0);
  });
});
