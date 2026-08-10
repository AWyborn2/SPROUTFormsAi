/**
 * The builder-draft query keys must NOT nest, and that is easy to "tidy" away.
 *
 * Nesting a detail under its list is the normal convention and it is wrong
 * here. `invalidateQueries` matches by PREFIX, autosave invalidates the draft
 * LIST on every write, and the builder keeps a single-draft query mounted the
 * whole time it is open. With the detail keyed `['builderDrafts', id]` that
 * query is a prefix match, so the builder refetches its own draft every two
 * seconds while the author works — a whole extraction plus every field and
 * every answer key, megabytes at a time, to fetch a value the builder already
 * holds a newer version of in React state.
 *
 * `staleTime: Infinity` does not save it: an explicit invalidation overrides
 * staleness by design.
 *
 * This is pinned as a test because the fix looks like an inconsistency. Anyone
 * lining the keys up with the rest of the file would reintroduce it, and the
 * symptom — a builder that feels slow on a big paper — points nowhere near the
 * cause.
 */
import { describe, expect, it } from 'vitest';
import { keys } from './hooks.js';

/** React Query's own prefix rule, as `invalidateQueries` applies it. */
const prefixMatches = (filter: readonly unknown[], key: readonly unknown[]) =>
  filter.every((part, i) => Object.is(part, key[i]));

describe('builder draft query keys', () => {
  it('does not invalidate a mounted draft when the list is invalidated', () => {
    expect(prefixMatches(keys.builderDrafts, keys.builderDraft('draft-1'))).toBe(false);
  });

  it('still gives each draft its own key', () => {
    expect(keys.builderDraft('a')).not.toEqual(keys.builderDraft('b'));
  });

  it('is stable for one id, so the query is not remounted per render', () => {
    expect(keys.builderDraft('a')).toEqual(keys.builderDraft('a'));
  });

  it('proves the prefix rule this test relies on is real', () => {
    // Guards the guard: if `prefixMatches` were wrong, the first test would
    // pass for the wrong reason and the regression would be invisible again.
    expect(prefixMatches(['builderDrafts'], ['builderDrafts', 'draft-1'])).toBe(true);
  });
});
