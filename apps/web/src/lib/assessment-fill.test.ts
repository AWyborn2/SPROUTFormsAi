/**
 * R6 — Part 1 presents the General question set plus exactly one
 * location-specific set.
 *
 * These assert the composition that actually decides what a candidate sees:
 * `partVisibility` supplies the stream as an ANSWER plus the question it
 * answers, and the ordinary visibility rules do the rest. Testing the pair
 * together is the point — either half alone passes while the combination shows
 * the wrong questions, in whichever direction the missing half happens to fail.
 */
import { describe, expect, it } from 'vitest';
import { visibleFields, type FormField } from '@formai/shared';
import { partVisibility } from './assessment-fill.js';

const STREAM_FIELD = 'stream-q';

const section = (id: string, stream?: string): FormField => ({
  id,
  type: 'section_header',
  label: id,
  required: false,
  source: 'imported',
  ...(stream ? { visibleWhen: { fieldId: STREAM_FIELD, op: 'equals' as const, value: stream } } : {}),
});

const question = (id: string): FormField => ({
  id,
  type: 'text',
  label: id,
  required: false,
  source: 'imported',
});

/**
 * The stream question. Deliberately NOT part of the slice below — on the real
 * paper tool it sits on the cover checklist, so the part a candidate fills does
 * not contain the question its own sections are gated on.
 */
const STREAM_QUESTION: FormField = {
  id: STREAM_FIELD,
  type: 'dropdown',
  label: 'Location',
  required: false,
  source: 'imported',
  options: ['Mining', 'Raw Materials'],
};

const PART_ONE: FormField[] = [
  section('general'),
  question('q-general'),
  section('mining', 'Mining'),
  question('q-mining'),
  section('raw', 'Raw Materials'),
  question('q-raw'),
];

function renderedIds(
  stream: string | null,
  overrides: Partial<Omit<Parameters<typeof partVisibility>[1], 'locationStream'>> = {},
) {
  const { answers, sources } = partVisibility(
    {},
    {
      locationStream: stream,
      locationStreamFieldId: STREAM_FIELD,
      streamField: STREAM_QUESTION,
      ...overrides,
    },
  );
  return visibleFields(PART_ONE, answers, sources).map((f) => f.id);
}

describe('location streams', () => {
  it('shows the General set plus exactly the case’s own location set', () => {
    const ids = renderedIds('Mining');

    expect(ids).toContain('q-general');
    expect(ids).toContain('q-mining');
    // The other site's questions are not this candidate's assessment.
    expect(ids).not.toContain('q-raw');
  });

  it('gates the other direction on the other stream', () => {
    const ids = renderedIds('Raw Materials');

    expect(ids).toContain('q-raw');
    expect(ids).not.toContain('q-mining');
  });

  it('renders every set when the case has no stream, rather than none', () => {
    // Fail-open. Hiding content nobody chose to hide would silently shorten the
    // assessment, and neither candidate nor assessor would see it happen.
    expect(renderedIds(null)).toEqual(expect.arrayContaining(['q-general', 'q-mining', 'q-raw']));
  });

  it('renders every set when the tool declares no stream question', () => {
    // A stream recorded against a tool that cannot use it must not blank the
    // location sections — same rule, different missing half.
    expect(renderedIds('Mining', { locationStreamFieldId: null })).toEqual(
      expect.arrayContaining(['q-general', 'q-mining', 'q-raw']),
    );
  });

  it('renders every set when the stream question itself never arrives', () => {
    // The condition then dangles rather than resolving false. This is the case
    // that inverts if answer and source are decided separately.
    expect(renderedIds('Mining', { streamField: null })).toEqual(
      expect.arrayContaining(['q-general', 'q-mining', 'q-raw']),
    );
  });

  it('ignores a source field that answers some other question', () => {
    const wrongField: FormField = { ...STREAM_QUESTION, id: 'something-else' };

    // Gating on an answer nobody supplied would hide both location sets.
    expect(renderedIds('Mining', { streamField: wrongField })).toEqual(
      expect.arrayContaining(['q-general', 'q-mining', 'q-raw']),
    );
  });
});

describe('seeding precedence', () => {
  it('lets the case stream win over a stale saved answer', () => {
    // The case record is what the candidate was enrolled against; a draft that
    // disagrees would otherwise show them a different assessment.
    const { answers } = partVisibility(
      { [STREAM_FIELD]: 'Raw Materials' },
      {
        locationStream: 'Mining',
        locationStreamFieldId: STREAM_FIELD,
        streamField: STREAM_QUESTION,
      },
    );

    expect(answers[STREAM_FIELD]).toBe('Mining');
  });

  it('leaves other saved answers untouched', () => {
    const { answers } = partVisibility(
      { 'q-general': 'already typed' },
      {
        locationStream: 'Mining',
        locationStreamFieldId: STREAM_FIELD,
        streamField: STREAM_QUESTION,
      },
    );

    expect(answers['q-general']).toBe('already typed');
  });
});
