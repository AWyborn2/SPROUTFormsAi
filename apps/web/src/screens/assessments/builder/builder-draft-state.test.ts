/**
 * The builder draft's round-trip: live state → row → live state.
 *
 * THE BUG. `useBuilderDraftState` held everything in `useState` and took a
 * `draftId` it ignored. A refresh, a crash, a closed tab or a redeploy
 * discarded the extraction, the corrected field types, the arranged structure,
 * every answer key, every matching pair and every unit edit — hours of work,
 * silently, with no route back: the form library's draft row leads to the FORM
 * builder and the placement screen, neither of which knows what an answer key
 * is.
 *
 * Everything underneath was already built — the table, its migration, four
 * routes, and a resume list on the upload step that rendered nothing because
 * the store fetched `/builder-drafts` while the router is mounted at
 * `/assessment-tool-drafts`.
 *
 * These tests exist because a round-trip is exactly the kind of code that
 * silently drops one field, and one dropped field here is an author's
 * afternoon. Every property is asserted individually rather than by a single
 * deep-equal, so a failure names what was lost.
 */
import { describe, expect, it } from 'vitest';
import type { DraftAnswerKey, ExtractionResult, FormField } from '@formai/shared';
import {
  draftName,
  emptySnapshot,
  fromDraftState,
  isSaveable,
  toDraftState,
  type BuilderSnapshot,
} from './builder-draft-state.js';

const field = (id: string, extra: Partial<FormField> = {}): FormField => ({
  id,
  type: 'text',
  label: id,
  required: false,
  source: 'imported',
  ...extra,
});

const extraction = {
  fileName: 'Mine Site SME Theory.pdf',
  pageCount: 6,
  fields: [],
} as unknown as ExtractionResult;

/** A draft mid-build: document read, fields edited, keys entered, parts tweaked. */
const populated = (): BuilderSnapshot => ({
  ...emptySnapshot(),
  fileName: 'Mine Site SME Theory.pdf',
  extraction,
  fields: [field('q1', { type: 'check_cross' }), field('q2')],
  structure: [
    { key: 's1', label: 'Candidate Declaration', cols: 1, fields: [{ id: 'q1' }] },
  ] as BuilderSnapshot['structure'],
  groupCount: 4,
  excluded: new Set(['q2']),
  keys: [{ fieldId: 'q1', answerKey: ['yes'], source: 'manual' }] as DraftAnswerKey[],
  partOverrides: { p1: { label: 'Theory' } },
  partOrder: ['p1', 'p2'],
  assetId: 'asset-1',
  formId: '11111111-1111-4111-8111-111111111111',
  versionId: '22222222-2222-4222-8222-222222222222',
});

describe('round trip', () => {
  const back = fromDraftState(toDraftState(populated()));
  const original = populated();

  it('keeps the extraction', () => {
    expect(back.extraction).toEqual(original.extraction);
  });

  it('keeps the fields, with their corrected types', () => {
    expect(back.fields).toEqual(original.fields);
  });

  it('keeps the structure', () => {
    expect(back.structure).toEqual(original.structure);
  });

  it('keeps the answer keys', () => {
    // The most expensive thing in the draft to re-enter, and the reason the
    // state is stored server-side rather than in localStorage.
    expect(back.keys).toEqual(original.keys);
  });

  it('keeps the excluded set as a Set, not an empty object', () => {
    /*
      `JSON.stringify(new Set(['q2']))` is `{}` — silently. Serialised naively,
      every excluded question comes back INCLUDED, and the author finds out at
      publish. `excludedFieldIds` is why this is an array on the wire.
    */
    expect(back.excluded).toBeInstanceOf(Set);
    expect([...back.excluded]).toEqual(['q2']);
  });

  it('keeps the unit edits', () => {
    expect(back.partOverrides).toEqual(original.partOverrides);
    expect(back.partOrder).toEqual(original.partOrder);
  });

  it('keeps the group counter', () => {
    // Resuming at 1 lets the next grouped section reuse a key the structure is
    // already using, and two sections with one key is a structure whose fields
    // belong to whichever the map read last.
    expect(back.groupCount).toBe(4);
  });

  it('keeps the asset, form and version ids', () => {
    expect(back.assetId).toBe(original.assetId);
    expect(back.formId).toBe(original.formId);
    expect(back.versionId).toBe(original.versionId);
  });

  it('keeps the setup answers', () => {
    expect(back.setup).toEqual(original.setup);
  });

  it('keeps the file name', () => {
    expect(back.fileName).toBe(original.fileName);
  });

  it('survives a JSON encode/decode, which is what the column does', () => {
    // The in-memory round trip can pass while the real one fails: jsonb goes
    // through JSON, and a Set or a Date would not survive it.
    const viaJson = fromDraftState(JSON.parse(JSON.stringify(toDraftState(populated()))));

    expect([...viaJson.excluded]).toEqual(['q2']);
    expect(viaJson.keys).toEqual(original.keys);
    expect(viaJson.groupCount).toBe(4);
  });
});

describe('fromDraftState on states it did not write', () => {
  /*
    The column is written by whichever build of the client last saved it, and
    the route stores it opaque on purpose so the builder can add state without
    a migration. A draft saved by yesterday's build must open in today's, and a
    corrupt one must open EMPTY rather than throwing on a screen with no error
    state — a builder that white-screens has lost the draft just as completely.
  */
  it('opens empty on null', () => {
    expect(fromDraftState(null)).toEqual(emptySnapshot());
  });

  it('opens empty on a non-object', () => {
    expect(fromDraftState('nonsense')).toEqual(emptySnapshot());
    expect(fromDraftState(42)).toEqual(emptySnapshot());
  });

  it('fills in every field a older state omitted', () => {
    const partial = fromDraftState({ fields: [field('q1')] });

    expect(partial.fields).toHaveLength(1);
    expect(partial.keys).toEqual([]);
    expect(partial.excluded).toBeInstanceOf(Set);
    expect(partial.groupCount).toBe(1);
    expect(partial.setup).toEqual(emptySnapshot().setup);
  });

  it('refuses a truthy non-object extraction', () => {
    // `statsFor` reads `.fields` and `.pageCount` off this the moment the
    // builder renders. A string here throws before anything can catch it.
    expect(fromDraftState({ extraction: 'yes' }).extraction).toBeNull();
  });

  it('refuses arrays where objects belong and vice versa', () => {
    const odd = fromDraftState({ fields: 'q1', keys: {}, excludedFieldIds: 'q2', partOrder: 7 });

    expect(odd.fields).toEqual([]);
    expect(odd.keys).toEqual([]);
    expect([...odd.excluded]).toEqual([]);
    expect(odd.partOrder).toEqual([]);
  });

  it('refuses a nonsense group counter rather than trusting it', () => {
    expect(fromDraftState({ groupCount: 0 }).groupCount).toBe(1);
    expect(fromDraftState({ groupCount: -3 }).groupCount).toBe(1);
    expect(fromDraftState({ groupCount: 'four' }).groupCount).toBe(1);
  });

  it('merges a partial setup over the defaults', () => {
    // An older build's setup is missing whatever has been added since; taking
    // it wholesale would leave those undefined on a screen that reads them.
    const merged = fromDraftState({ setup: { pathways: [] } });

    expect(merged.setup.pathways).toEqual([]);
    expect(merged.setup.thresholdBehaviour).toBe(emptySnapshot().setup.thresholdBehaviour);
  });
});

describe('isSaveable', () => {
  it('refuses a builder that has read nothing', () => {
    // Saving here writes a named row with an empty state, which then appears in
    // "Pick up where you left off" offering to resume nothing.
    expect(isSaveable(emptySnapshot())).toBe(false);
  });

  it('accepts as soon as the PDF is uploaded', () => {
    /*
      The ASSET is the test, not the extraction. The upload lands first and the
      document is the one thing never re-derived, so a draft holding it can
      always be resumed into something — and an extraction that fails after a
      successful upload is exactly when an author most wants the file kept.
    */
    expect(isSaveable({ ...emptySnapshot(), assetId: 'asset-1' })).toBe(true);
  });
});

describe('draftName', () => {
  it('uses the document’s title without its extension', () => {
    // The upsert key is (org, name), so this is also what makes autosave
    // overwrite one row rather than lay down a new one every two seconds.
    expect(draftName(populated())).toBe('Mine Site SME Theory');
  });

  it('falls back rather than saving under an empty name', () => {
    // The route rejects a blank name with a 400, which would make every
    // autosave fail silently for a draft whose file name never arrived.
    expect(draftName(emptySnapshot())).toBe('Untitled assessment');
    expect(draftName({ ...emptySnapshot(), fileName: '   ' })).toBe('Untitled assessment');
  });

  it('is stable across a round trip, so autosave keeps hitting one row', () => {
    expect(draftName(fromDraftState(toDraftState(populated())))).toBe(draftName(populated()));
  });
});
