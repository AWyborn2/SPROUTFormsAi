/**
 * Condition sources that live outside the list being rendered.
 *
 * `visibleFields` normally receives a whole form, so a condition's source is
 * always somewhere in the list. It also gets called on SLICES — filling one
 * part of a multi-part assessment, where the section conditions point at a
 * question on the cover page that the slice does not contain. Without the
 * source those conditions dangle and fall open, so the gating silently never
 * applies and the candidate is shown every location's questions.
 */
import { describe, expect, it } from 'vitest';
import { visibleFields } from './visibility.js';
import type { FormField } from './form-field.js';

const streamQuestion: FormField = {
  id: 'stream',
  type: 'dropdown',
  label: 'Location',
  required: false,
  source: 'imported',
  options: ['Mining', 'Raw Materials'],
};

const header = (id: string, label: string, stream: string): FormField => ({
  id,
  type: 'section_header',
  label,
  required: false,
  source: 'imported',
  visibleWhen: { fieldId: 'stream', op: 'equals', value: stream },
});

const text = (id: string): FormField => ({
  id,
  type: 'text',
  label: id,
  required: false,
  source: 'imported',
});

/** A part whose two location sections are gated on a question it lacks. */
const slice: FormField[] = [
  header('h-mining', 'Mining', 'Mining'),
  text('q-mining'),
  header('h-raw', 'Raw', 'Raw Materials'),
  text('q-raw'),
];

const ids = (extra: FormField[] = []) =>
  visibleFields(slice, { stream: 'Mining' }, extra).map((f) => f.id);

describe('visibleFields with external sources', () => {
  it('gates on a source that is not in the rendered list', () => {
    expect(ids([streamQuestion])).toContain('q-mining');
    expect(ids([streamQuestion])).not.toContain('q-raw');
  });

  it('never renders the external source itself', () => {
    // It is a lookup, not content. Rendering it would ask the candidate a
    // question that was already answered on their behalf.
    expect(ids([streamQuestion])).not.toContain('stream');
  });

  it('judges the external source outside every section scope', () => {
    // Regression guard on ORDER. Concatenated onto the END of the list, the
    // source inherits whatever section happens to be last — here the Raw
    // section, which is hidden. The source would then read as hidden itself,
    // the no-cascade rule would fail every dependent OPEN, and both location
    // sets would render. It has to sit ahead of the first header, where it
    // belongs to no section at all — which is the truth about it.
    expect(ids([streamQuestion])).not.toContain('q-raw');
  });

  it('falls open when no external source is supplied', () => {
    // The documented direction to fail in: showing extra questions is visible
    // to everyone, while hiding them silently is not.
    expect(ids()).toEqual(expect.arrayContaining(['q-mining', 'q-raw']));
  });

  it('leaves a whole-form call unchanged', () => {
    // The common case passes no extra sources at all, and must be untouched.
    const wholeForm = [streamQuestion, ...slice];

    expect(visibleFields(wholeForm, { stream: 'Mining' }).map((f) => f.id)).toEqual([
      'stream',
      'h-mining',
      'q-mining',
    ]);
  });
});
